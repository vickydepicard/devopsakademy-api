import { Request, Response } from "express";
import { query } from "../config/database";
import slugify from "slugify";
import { AuthenticatedRequest } from "../middleware/auth";

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — Convertit récursivement les BigInt en Number (évite JSON.stringify crash)
// ─────────────────────────────────────────────────────────────────────────────
function convertBigInt(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return Number(obj);
  if (Array.isArray(obj)) return obj.map(convertBigInt);
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, convertBigInt(v)])
    );
  }
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — Vérifie si un utilisateur est inscrit ET approuvé à un cours
// ─────────────────────────────────────────────────────────────────────────────
async function isUserEnrolled(courseId: number, userId: number): Promise<boolean> {
  const [enrollment]: any = await query(
    `SELECT id FROM course_enrollments
     WHERE course_id = ? AND user_id = ? AND is_approved = 1`,
    [courseId, userId]
  );
  return !!enrollment;
}

// ═════════════════════════════════════════════════════════════════════════════
// CREATE COURSE
// POST /api/courses
// ═════════════════════════════════════════════════════════════════════════════
export const createCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, description, price, level, category_id, requirements, learning_outcomes, is_free } = req.body;
    const user = req.user;

    if (!user) return res.status(401).json({ success: false, message: "Non authentifié" });
    if (!title || !description) return res.status(400).json({ success: false, message: "Titre et description requis" });

    const slug = slugify(title, { lower: true, strict: true }) + "-" + Date.now();

    const result = await query(
      `INSERT INTO courses (title, description, instructor_id, price, level, category_id, requirements, learning_outcomes, slug, is_free)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title, description, user.id, price || 0, level || "beginner",
        category_id || null,
        JSON.stringify(requirements || []),
        JSON.stringify(learning_outcomes || []),
        slug, is_free || false,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Cours créé avec succès",
      data: { id: Number((result as any).insertId), slug },
    });
  } catch (error) {
    console.error("❌ createCourse:", error);
    return res.status(500).json({ success: false, message: "Erreur lors de la création du cours" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════

// ✅ Résoudre un courseId depuis un slug ou un ID numérique
async function resolveCourseId(raw: string): Promise<number | null> {
  const num = Number(raw);
  if (!isNaN(num) && Number.isInteger(num)) return num;
  // C'est un slug — chercher l'ID dans la BDD
  const [row]: any[] = await query(
    "SELECT id FROM courses WHERE slug = ? AND is_published = 1 LIMIT 1",
    [raw]
  );
  return row ? Number(row.id) : null;
}

// GET ALL COURSES (avec filtres + pagination)
// GET /api/courses
// ═════════════════════════════════════════════════════════════════════════════
export const getCourses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 10, search = null, category = null, level = null, is_free = null, language = null } = req.query;
    const user   = req.user || null;
    const offset = (Number(page) - 1) * Number(limit);

    const f = {
      search:   search   && search   !== "" ? String(search)   : null,
      category: category && category !== "" ? String(category) : null,
      level:    level    && level    !== "" ? String(level)    : null,
      is_free:  is_free  !== "" && is_free !== null ? Number(is_free) : null,
      language: language && language !== "" ? String(language) : null,
    };

    const courses = await query(
      `SELECT
         c.id, c.title, c.short_description, c.thumbnail_url, c.price, c.is_free,
         c.level, c.language, c.is_featured, c.is_published,
         c.rating, c.review_count, c.created_at,
         cat.name AS category_name,
         u.first_name, u.last_name,
         COUNT(DISTINCT ce.user_id) AS student_count
       FROM courses c
       LEFT JOIN course_categories cat ON c.category_id  = cat.id
       LEFT JOIN users u               ON c.instructor_id = u.id
       LEFT JOIN course_enrollments ce ON c.id            = ce.course_id
       WHERE c.is_published = 1
         AND (? IS NULL OR (c.title LIKE CONCAT('%',?,'%') OR c.short_description LIKE CONCAT('%',?,'%')))
         AND (? IS NULL OR cat.slug = ? OR cat.id = ?)
         AND (? IS NULL OR c.level = ?)
         AND (? IS NULL OR c.is_free = ?)
         AND (? IS NULL OR c.language = ?)
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [
        f.search, f.search, f.search,
        f.category, f.category, f.category,
        f.level, f.level,
        f.is_free, f.is_free,
        f.language, f.language,
        Number(limit), offset,
      ]
    );

    let formatted = convertBigInt(courses);

    if (user && user.role === "student") {
      const enrollments = await query(`SELECT course_id FROM course_enrollments WHERE user_id = ?`, [user.id]);
      const enrolledIds = new Set(enrollments.map((e: any) => Number(e.course_id)));
      formatted = formatted.map((c: any) => ({ ...c, isEnrolled: enrolledIds.has(c.id) }));
    }

    return res.json({ success: true, data: formatted, pagination: { page: Number(page), limit: Number(limit) } });
  } catch (error) {
    console.error("❌ getCourses:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET USER COURSES (cours auxquels l'utilisateur est inscrit)
// GET /api/courses/my
// ═════════════════════════════════════════════════════════════════════════════
export const getUserCourses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, message: "Non authentifié" });

    const courses = await query(
      `SELECT
         c.id, c.title, c.description, c.thumbnail_url, c.level, c.price,
         c.duration_hours, c.language, c.is_free, c.video_preview_url,
         u.first_name, u.last_name,
         ce.completion_percentage, ce.enrolled_at
       FROM course_enrollments ce
       JOIN courses c ON ce.course_id    = c.id
       JOIN users u   ON c.instructor_id = u.id
       WHERE ce.user_id = ?
       ORDER BY ce.enrolled_at DESC`,
      [user.id]
    );

    return res.json({ success: true, data: convertBigInt(courses) });
  } catch (error) {
    console.error("❌ getUserCourses:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE BY ID ou SLUG — Version publique (visiteurs)
// GET /api/courses/:id  — accepte un ID numérique OU un slug texte
// ═════════════════════════════════════════════════════════════════════════════
export const getCourseById = async (req: Request, res: Response) => {
  try {
    const raw = req.params.id;
    const courseId = Number(raw);
    const isSlug = isNaN(courseId) || !Number.isInteger(courseId);

    // Construire la condition WHERE selon type (id ou slug)
    const whereClause = isSlug ? "c.slug = ?" : "c.id = ?";
    const whereValue  = isSlug ? raw : courseId;

    const [course]: any = await query(
      `SELECT
         c.id, c.slug, c.title, c.description, c.short_description,
         c.thumbnail_url, c.video_preview_url, c.price, c.original_price,
         c.is_free, c.level, c.language, c.is_featured, c.is_published,
         c.rating, c.review_count, c.duration_hours, c.student_count,
         c.requirements, c.learning_outcomes,
         u.first_name, u.last_name,
         cat.name AS category_name, cat.slug AS category_slug,
         c.created_at, c.published_at
       FROM courses c
       LEFT JOIN users u               ON c.instructor_id = u.id
       LEFT JOIN course_categories cat ON c.category_id   = cat.id
       WHERE ${whereClause} AND c.is_published = 1`,
      [whereValue]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable" });

    // Aperçu des 2 premiers modules (titres + nb leçons uniquement)
    const modules = await query(
      `SELECT m.id, m.title, m.order_index, COUNT(l.id) AS lesson_count
       FROM modules m
       LEFT JOIN lessons l ON m.id = l.module_id AND l.is_published = 1
       WHERE m.course_id = ? AND m.is_published = 1
       GROUP BY m.id ORDER BY m.order_index ASC LIMIT 2`,
      [courseId]
    );

    return res.json({
      success: true,
      data: {
        ...convertBigInt(course),
        modules: convertBigInt(modules),
        isEnrolled: false, isApproved: false,
        enrollmentStatus: "not_enrolled",
        completion_percentage: 0,
        info: "Version publique — Connectez-vous pour plus de détails",
      },
    });
  } catch (error) {
    console.error("❌ getCourseById:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE BY ID ENHANCED — Version connecté (plus d'infos)
// GET /api/courses/:id/details
// ═════════════════════════════════════════════════════════════════════════════
export const getCourseByIdEnhanced = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const raw = req.params.id;
    const courseId = Number(raw);
    const user     = req.user;
    const isSlug = isNaN(courseId) || !Number.isInteger(courseId);
    const whereClause = isSlug ? "c.slug = ?" : "c.id = ?";
    const whereValue  = isSlug ? raw : courseId;

    const [course]: any = await query(
      `SELECT
         c.id, c.title, c.description, c.short_description,
         c.thumbnail_url, c.video_preview_url, c.price, c.original_price,
         c.is_free, c.level, c.language, c.is_featured, c.is_published,
         c.rating, c.review_count, c.duration_hours, c.student_count,
         c.requirements, c.learning_outcomes, c.requires_approval,
         c.instructor_id, u.first_name, u.last_name, u.email AS instructor_email,
         cat.id AS category_id, cat.name AS category_name, cat.slug AS category_slug,
         c.created_at, c.updated_at, c.published_at
       FROM courses c
       LEFT JOIN users u               ON c.instructor_id = u.id
       LEFT JOIN course_categories cat ON c.category_id   = cat.id
       ${whereClause}`,
      [whereValue]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable" });

    let isEnrolled = false, isApproved = false, completion_percentage = 0, enrollmentStatus = "not_enrolled";
    if (user) {
      const [enrollment]: any = await query(
        `SELECT is_approved, completion_percentage, payment_status
         FROM course_enrollments WHERE course_id = ? AND user_id = ?`,
        [courseId, user.id]
      );
      if (enrollment) {
        isEnrolled            = true;
        isApproved            = enrollment.is_approved === 1;
        completion_percentage = Number(enrollment.completion_percentage || 0);
        enrollmentStatus      = enrollment.payment_status;
      }
    }

    // Aperçu des 3 premiers modules
    const modules = await query(
      `SELECT m.id, m.title, m.description, m.order_index,
              COUNT(l.id) AS lesson_count,
              COALESCE(SUM(l.duration_minutes), 0) AS total_duration
       FROM modules m
       LEFT JOIN lessons l ON m.id = l.module_id AND l.is_published = 1
       WHERE m.course_id = ? AND m.is_published = 1
       GROUP BY m.id ORDER BY m.order_index ASC LIMIT 3`,
      [courseId]
    );

    return res.json({
      success: true,
      data: {
        ...convertBigInt(course),
        modules: convertBigInt(modules),
        isEnrolled, isApproved, enrollmentStatus, completion_percentage,
      },
    });
  } catch (error) {
    console.error("❌ getCourseByIdEnhanced:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE PUBLIC — Minimal (sans auth)
// GET /api/courses/public/:id
// ═════════════════════════════════════════════════════════════════════════════
export const getCoursePublic = async (req: Request, res: Response): Promise<void> => {
  try {
    const courseId = Number(req.params.id);
    if (isNaN(courseId)) { res.status(400).json({ success: false, message: "ID invalide" }); return; }

    const result = await query(
      `SELECT id, title, description, thumbnail_url, level, is_free, price FROM courses WHERE id = ?`,
      [courseId]
    );
    if (!result.length) { res.status(404).json({ success: false, message: "Cours introuvable" }); return; }

    res.json({ success: true, data: result[0] });
  } catch (error) {
    console.error("❌ getCoursePublic:", error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE PREVIEW — Aperçu public enrichi
// GET /api/courses/:id/preview
// ═════════════════════════════════════════════════════════════════════════════
export const getCoursePreview = async (req: Request, res: Response): Promise<void> => {
  try {
    const courseId = Number(req.params.id);
    if (isNaN(courseId)) { res.status(400).json({ success: false, message: "ID invalide" }); return; }

    const [course]: any = await query(
      `SELECT c.id, c.title, c.short_description, c.thumbnail_url, c.level, c.language, c.price,
              u.first_name, u.last_name
       FROM courses c JOIN users u ON c.instructor_id = u.id
       WHERE c.id = ? AND c.is_published = 1`,
      [courseId]
    );
    if (!course) { res.status(404).json({ success: false, message: "Cours introuvable" }); return; }

    const modules: any[] = await query(
      `SELECT id, title FROM modules WHERE course_id = ? AND is_published = 1 ORDER BY order_index LIMIT 2`,
      [courseId]
    );
    for (const m of modules) {
      m.lessons = await query(
        `SELECT id, title, duration_minutes FROM lessons WHERE module_id = ? AND is_published = 1 ORDER BY order_index LIMIT 2`,
        [m.id]
      );
    }

    res.json({ success: true, data: { ...course, modules } });
  } catch (error) {
    console.error("❌ getCoursePreview:", error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE CONTENT — Contenu complet pour étudiant inscrit + approuvé
// GET /api/courses/:id/learn
// ─────────────────────────────────────────────────────────────────────────────
// ✅ FIX CRITIQUE : On n'utilise plus JSON_ARRAYAGG (retourne une string en
//    MariaDB, pas un vrai tableau). On fait des requêtes séparées par module.
// ═════════════════════════════════════════════════════════════════════════════
export const getCourseContent = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId = Number(req.params.id);
    const userId   = req.user?.id;

    if (!userId) return res.status(401).json({ success: false, message: "Non authentifié" });

    // Vérifier inscription approuvée
    const [enrollment]: any = await query(
      `SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ? AND is_approved = 1`,
      [courseId, userId]
    );
    if (!enrollment) {
      return res.status(403).json({
        success: false,
        message: "Vous devez être inscrit et approuvé pour accéder à ce contenu.",
        redirectTo: `/courses/${courseId}`,
      });
    }

    // Infos du cours
    const [course]: any = await query(
      `SELECT c.id, c.title, c.description, c.short_description,
              c.thumbnail_url, c.video_preview_url,
              c.duration_hours, c.level, c.language, c.is_free, c.price
       FROM courses c WHERE c.id = ?`,
      [courseId]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable" });

    // Modules publiés triés
    const modules: any[] = await query(
      `SELECT id, title, description, order_index
       FROM modules
       WHERE course_id = ? AND is_published = 1
       ORDER BY order_index ASC`,
      [courseId]
    );

    // Pour chaque module : leçons + progression de l'étudiant
    for (const mod of modules) {
      const lessons: any[] = await query(
        `SELECT
           l.id, l.title, l.content_type, l.content_url,
           l.article_content, l.duration_minutes, l.order_index, l.is_preview,
           COALESCE(lp.is_completed,           0)             AS is_completed,
           COALESCE(lp.status,                 'not_started') AS status,
           COALESCE(lp.video_progress_seconds, 0)             AS video_progress_seconds,
           COALESCE(lp.video_duration_seconds, 0)             AS video_duration_seconds
         FROM lessons l
         LEFT JOIN lesson_progress lp
           ON  lp.lesson_id  = l.id
           AND lp.user_id    = ?
           AND lp.course_id  = ?
         WHERE l.module_id   = ?
           AND l.is_published = 1
         ORDER BY l.order_index ASC`,
        [userId, courseId, mod.id]
      );
      mod.lessons = convertBigInt(lessons);
    }

    // Progression globale
    const [progress]: any = await query(
      `SELECT
         COUNT(DISTINCT l.id) AS total_lessons,
         COUNT(DISTINCT CASE WHEN lp.is_completed = 1 THEN lp.lesson_id END) AS completed_lessons,
         CASE WHEN COUNT(DISTINCT l.id) > 0
           THEN ROUND(
             COUNT(DISTINCT CASE WHEN lp.is_completed = 1 THEN lp.lesson_id END)
             * 100.0 / COUNT(DISTINCT l.id), 2)
           ELSE 0
         END AS progress_percentage
       FROM lessons l
       JOIN modules m ON l.module_id = m.id
       LEFT JOIN lesson_progress lp
         ON  l.id         = lp.lesson_id
         AND lp.user_id   = ?
         AND lp.course_id = ?
       WHERE m.course_id    = ?
         AND l.is_published = 1`,
      [userId, courseId, courseId]
    );

    // Mise à jour de la progression dans l'inscription
    await query(
      `UPDATE course_enrollments
       SET completion_percentage = ?, last_accessed_at = NOW()
       WHERE user_id = ? AND course_id = ?`,
      [progress?.progress_percentage || 0, userId, courseId]
    );

    return res.json({
      success: true,
      data: {
        ...convertBigInt(course),
        modules,
        progress: {
          totalLessons:     Number(progress?.total_lessons      || 0),
          completedLessons: Number(progress?.completed_lessons  || 0),
          percentage:       Number(progress?.progress_percentage || 0),
        },
      },
    });
  } catch (error) {
    console.error("❌ getCourseContent:", error);
    return res.status(500).json({ success: false, message: "Erreur lors de la récupération du contenu." });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE MODULES — Modules + leçons (avec progression si connecté)
// GET /api/courses/:id/modules
// ═════════════════════════════════════════════════════════════════════════════
export const getCourseModules = async (req: Request, res: Response) => {
  try {
    const courseId = await resolveCourseId(req.params.id);
    const userId   = (req as any).user?.id || 0;
    if (!courseId) return res.status(404).json({ success: false, message: "Cours introuvable" });

    const courses: any[] = await query(`SELECT id FROM courses WHERE id = ?`, [courseId]);
    if (!courses.length) return res.status(404).json({ success: false, message: "Cours introuvable" });

    const modules: any[] = await query(
      `SELECT id, title, description, order_index
       FROM modules
       WHERE course_id = ? AND is_published = 1
       ORDER BY order_index ASC`,
      [courseId]
    );

    for (const mod of modules) {
      const lessons: any[] = await query(
        `SELECT
           l.id, l.title, l.slug, l.content_type, l.content_url,
           l.duration_minutes, l.order_index, l.is_preview, l.requires_completion,
           COALESCE(lp.is_completed, 0)           AS is_completed,
           COALESCE(lp.status,       'not_started') AS status
         FROM lessons l
         LEFT JOIN lesson_progress lp
           ON  lp.lesson_id  = l.id
           AND lp.user_id    = ?
           AND lp.course_id  = ?
         WHERE l.module_id   = ?
           AND l.is_published = 1
         ORDER BY l.order_index ASC`,
        [userId, courseId, mod.id]
      );
      mod.lessons = convertBigInt(lessons);
    }

    return res.json({ success: true, data: modules });
  } catch (error) {
    console.error("❌ getCourseModules:", error);
    return res.status(500).json({ success: false, message: "Erreur interne" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE PROGRESS — Progression détaillée par module
// GET /api/courses/:id/progress
// ═════════════════════════════════════════════════════════════════════════════
export const getCourseProgressForUser = async (req: Request, res: Response) => {
  try {
    const courseId = await resolveCourseId(req.params.id);
    const userId   = (req as any).user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Non authentifié" });
    if (!courseId) return res.status(404).json({ success: false, message: "Cours introuvable" });

    const progress: any[] = await query(
      `SELECT
         m.id                                                       AS module_id,
         m.title                                                    AS module_title,
         m.order_index,
         COUNT(l.id)                                               AS total_lessons,
         SUM(CASE WHEN lp.is_completed = 1 THEN 1 ELSE 0 END)     AS completed_lessons,
         ROUND(
           SUM(CASE WHEN lp.is_completed = 1 THEN 1 ELSE 0 END)
           / NULLIF(COUNT(l.id), 0) * 100
         , 2)                                                      AS completion_percentage,
         COALESCE(SUM(l.duration_minutes), 0)                      AS total_minutes,
         COALESCE(SUM(CASE WHEN lp.is_completed = 1 THEN l.duration_minutes ELSE 0 END), 0)
                                                                   AS completed_minutes
       FROM modules m
       LEFT JOIN lessons l
         ON  l.module_id   = m.id AND l.is_published = 1
       LEFT JOIN lesson_progress lp
         ON  lp.lesson_id  = l.id
         AND lp.user_id    = ?
         AND lp.course_id  = ?
       WHERE m.course_id = ?
       GROUP BY m.id, m.title, m.order_index
       ORDER BY m.order_index ASC`,
      [userId, courseId, courseId]
    );

    for (const mod of progress) {
      const lessons: any[] = await query(
        `SELECT
           l.id, l.title, l.duration_minutes, l.order_index, l.content_type,
           COALESCE(lp.is_completed, 0)           AS completed,
           COALESCE(lp.status,       'not_started') AS status
         FROM lessons l
         LEFT JOIN lesson_progress lp
           ON  lp.lesson_id  = l.id
           AND lp.user_id    = ?
           AND lp.course_id  = ?
         WHERE l.module_id   = ?
           AND l.is_published = 1
         ORDER BY l.order_index ASC`,
        [userId, courseId, mod.module_id]
      );
      mod.lessons = convertBigInt(lessons);
    }

    return res.json({ success: true, data: convertBigInt(progress) });
  } catch (error) {
    console.error("❌ getCourseProgressForUser:", error);
    return res.status(500).json({ success: false, message: "Erreur interne" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET LESSON — Leçon individuelle (étudiant inscrit + approuvé)
// GET /api/courses/:id/lessons/:lessonId
// ═════════════════════════════════════════════════════════════════════════════
export const getLesson = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId = Number(req.params.id);
    const lessonId = Number(req.params.lessonId);
    const userId   = req.user?.id;

    if (!userId) return res.status(401).json({ success: false, message: "Non authentifié" });

    const [enrollment]: any = await query(
      `SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ? AND is_approved = 1`,
      [courseId, userId]
    );
    if (!enrollment) return res.status(403).json({ success: false, message: "Accès refusé : non inscrit" });

    const [lesson]: any = await query(
      `SELECT l.*, m.course_id FROM lessons l
       JOIN modules m ON l.module_id = m.id
       WHERE l.id = ? AND m.course_id = ? AND l.is_published = 1`,
      [lessonId, courseId]
    );
    if (!lesson) return res.status(404).json({ success: false, message: "Leçon introuvable" });

    const [progress]: any = await query(
      `SELECT is_completed, video_progress_seconds, video_duration_seconds, status
       FROM lesson_progress WHERE user_id = ? AND lesson_id = ? AND course_id = ?`,
      [userId, lessonId, courseId]
    );

    // Navigation prev / next (basé sur order_index global du cours)
    const [navigation]: any = await query(
      `SELECT
         (SELECT l2.id FROM lessons l2 JOIN modules m2 ON l2.module_id = m2.id
          WHERE m2.course_id = ? AND l2.order_index < l.order_index AND l2.is_published = 1
          ORDER BY l2.order_index DESC LIMIT 1) AS previous_lesson_id,
         (SELECT l3.id FROM lessons l3 JOIN modules m3 ON l3.module_id = m3.id
          WHERE m3.course_id = ? AND l3.order_index > l.order_index AND l3.is_published = 1
          ORDER BY l3.order_index ASC LIMIT 1)  AS next_lesson_id
       FROM lessons l JOIN modules m ON l.module_id = m.id
       WHERE l.id = ? AND m.course_id = ?`,
      [courseId, courseId, lessonId, courseId]
    );

    return res.json({
      success: true,
      data: {
        ...convertBigInt(lesson),
        progress: progress || {
          is_completed: 0, video_progress_seconds: 0,
          video_duration_seconds: 0, status: "not_started",
        },
        navigation: navigation || {},
      },
    });
  } catch (error) {
    console.error("❌ getLesson:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET LESSON BY ID — Alias (ancienne route avec courseId dans params)
// ═════════════════════════════════════════════════════════════════════════════
export const getLessonById = async (req: AuthenticatedRequest, res: Response) => {
  req.params.id = req.params.courseId;
  return getLesson(req, res);
};

// ═════════════════════════════════════════════════════════════════════════════
// UPDATE LESSON STATUS — Mise à jour progression d'une leçon
// PATCH /api/courses/:id/lessons/:lessonId/status
// ═════════════════════════════════════════════════════════════════════════════
export const updateLessonStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId = Number(req.params.id);
    const lessonId = Number(req.params.lessonId);
    const user     = req.user;
    const { status, video_progress_seconds, video_duration_seconds } = req.body;

    if (!user) return res.status(401).json({ success: false, message: "Non authentifié" });
    if (!["not_started", "in_progress", "completed"].includes(status))
      return res.status(400).json({ success: false, message: "Statut invalide" });

    const [enrollment]: any = await query(
      `SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ?`, [courseId, user.id]
    );
    if (!enrollment) return res.status(403).json({ success: false, message: "Non inscrit à ce cours" });

    const [lesson]: any = await query(
      `SELECT id FROM lessons WHERE id = ? AND module_id IN (SELECT id FROM modules WHERE course_id = ?)`,
      [lessonId, courseId]
    );
    if (!lesson) return res.status(404).json({ success: false, message: "Leçon introuvable" });

    await query(
      `INSERT INTO lesson_progress
         (user_id, lesson_id, course_id, status, is_completed, completed_at,
          video_progress_seconds, video_duration_seconds, last_accessed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         status                 = VALUES(status),
         is_completed           = VALUES(is_completed),
         completed_at           = VALUES(completed_at),
         video_progress_seconds = VALUES(video_progress_seconds),
         video_duration_seconds = VALUES(video_duration_seconds),
         last_accessed_at       = NOW(),
         updated_at             = NOW()`,
      [
        user.id, lessonId, courseId, status,
        status === "completed" ? 1 : 0,
        status === "completed" ? new Date() : null,
        video_progress_seconds || 0,
        video_duration_seconds || 0,
      ]
    );

    // Recalcul progression globale
    const [stats]: any = await query(
      `SELECT COUNT(l.id) AS total,
              SUM(CASE WHEN lp.is_completed = 1 THEN 1 ELSE 0 END) AS completed
       FROM lessons l
       LEFT JOIN lesson_progress lp
         ON lp.lesson_id = l.id AND lp.user_id = ? AND lp.course_id = ?
       WHERE l.module_id IN (SELECT id FROM modules WHERE course_id = ?)
         AND l.is_published = 1`,
      [user.id, courseId, courseId]
    );

    const pct = Number(stats?.total || 0) > 0
      ? Math.round((Number(stats.completed || 0) / Number(stats.total)) * 100)
      : 0;

    await query(
      `UPDATE course_enrollments SET completion_percentage = ? WHERE user_id = ? AND course_id = ?`,
      [pct, user.id, courseId]
    );

    return res.json({ success: true, message: `Leçon mise à jour (${status})`, lessonId, status, newProgress: pct });
  } catch (error) {
    console.error("❌ updateLessonStatus:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// COMPLETE LESSON — Marquer une leçon comme terminée
// POST /api/courses/:id/lessons/:lessonId/complete
// ═════════════════════════════════════════════════════════════════════════════
export const completeLesson = async (req: Request, res: Response) => {
  try {
    const courseId = Number(req.params.id);
    const lessonId = Number(req.params.lessonId);
    const userId   = (req as any).user?.id;

    if (!userId) return res.status(401).json({ success: false, message: "Non authentifié" });

    const lessons: any[] = await query(
      `SELECT l.id FROM lessons l JOIN modules m ON l.module_id = m.id
       WHERE l.id = ? AND m.course_id = ? AND l.is_published = 1`,
      [lessonId, courseId]
    );
    if (!lessons.length) return res.status(404).json({ success: false, message: "Leçon introuvable" });

    // Upsert avec tous les champs NOT NULL
    await query(
      `INSERT INTO lesson_progress
         (user_id, lesson_id, course_id, status, is_completed, completed_at,
          video_progress_seconds, video_duration_seconds, last_accessed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', 1, NOW(), 0, 0, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         status           = 'completed',
         is_completed     = 1,
         completed_at     = COALESCE(completed_at, NOW()),
         last_accessed_at = NOW(),
         updated_at       = NOW()`,
      [userId, lessonId, courseId]
    );

    // Recalcul progression globale
    const [totRow]: any = await query(
      `SELECT COUNT(l.id) AS total FROM lessons l JOIN modules m ON l.module_id = m.id
       WHERE m.course_id = ? AND l.is_published = 1`,
      [courseId]
    );
    const [doneRow]: any = await query(
      `SELECT COUNT(lp.id) AS done FROM lesson_progress lp
       JOIN lessons l ON lp.lesson_id = l.id
       JOIN modules m ON l.module_id  = m.id
       WHERE m.course_id = ? AND lp.user_id = ? AND lp.is_completed = 1`,
      [courseId, userId]
    );

    const total = Number(totRow?.total || 0);
    const done  = Number(doneRow?.done  || 0);
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

    await query(
      `UPDATE course_enrollments SET completion_percentage = ?, last_accessed_at = NOW()
       WHERE course_id = ? AND user_id = ?`,
      [pct, courseId, userId]
    );

    if (pct === 100) {
      await query(
        `UPDATE course_enrollments SET completed_at = COALESCE(completed_at, NOW())
         WHERE course_id = ? AND user_id = ?`,
        [courseId, userId]
      );
    }

    return res.json({
      success: true,
      message: "Leçon marquée comme terminée",
      completion_percentage: pct,
      course_completed: pct === 100,
    });
  } catch (error) {
    console.error("❌ completeLesson:", error);
    return res.status(500).json({ success: false, message: "Erreur interne" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ENROLL COURSE — Inscription à un cours
// POST /api/courses/:id/enroll
// ═════════════════════════════════════════════════════════════════════════════
export const enrollCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId          = Number(req.params.id);
    const user              = req.user;
    const { payment_proof_url } = req.body;

    if (!user)           return res.status(401).json({ success: false, message: "Non authentifié" });
    if (isNaN(courseId)) return res.status(400).json({ success: false, message: "ID invalide" });

    const [course]: any = await query(
      `SELECT id, title, price, is_free, requires_approval FROM courses WHERE id = ? AND is_published = 1`,
      [courseId]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable" });

    const [existing]: any = await query(
      `SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ?`, [courseId, user.id]
    );
    if (existing) return res.status(400).json({ success: false, message: "Déjà inscrit à ce cours" });

    const isApproved    = course.is_free ? 1 : 0;
    const paymentStatus = course.is_free ? "verified" : "pending";

    await query(
      `INSERT INTO course_enrollments (user_id, course_id, is_approved, payment_status, payment_proof_url, enrolled_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [user.id, courseId, isApproved, paymentStatus, payment_proof_url || null]
    );

    return res.status(201).json({
      success: true,
      message: course.is_free ? "Inscription réussie !" : "Inscription soumise, en attente de validation",
      data: { course_id: courseId, requires_approval: !course.is_free, is_approved: isApproved, payment_status: paymentStatus },
    });
  } catch (error) {
    console.error("❌ enrollCourse:", error);
    return res.status(500).json({ success: false, message: "Erreur lors de l'inscription" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET ENROLLMENT STATUS
// GET /api/courses/:id/enrollment-status
// ═════════════════════════════════════════════════════════════════════════════
export const getEnrollmentStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId = Number(req.params.id);
    const user     = req.user;

    if (!user)           return res.status(401).json({ success: false, message: "Non authentifié" });
    if (isNaN(courseId)) return res.status(400).json({ success: false, message: "ID invalide" });

    const [enrollment]: any = await query(
      `SELECT ce.*, c.title AS course_title, c.is_free, c.price
       FROM course_enrollments ce JOIN courses c ON ce.course_id = c.id
       WHERE ce.course_id = ? AND ce.user_id = ?`,
      [courseId, user.id]
    );

    if (!enrollment) return res.json({ success: true, data: { enrolled: false } });
    return res.json({ success: true, data: { enrolled: true, ...convertBigInt(enrollment) } });
  } catch (error) {
    console.error("❌ getEnrollmentStatus:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET POPULAR COURSES
// GET /api/courses/popular
// ═════════════════════════════════════════════════════════════════════════════
export const getPopularCourses = async (req: Request, res: Response) => {
  try {
    const courses = await query(
      `SELECT
         c.id, c.title, c.short_description, c.thumbnail_url, c.price, c.is_free,
         c.level, c.language, c.is_featured, c.rating, c.review_count,
         cat.name AS category_name, u.first_name, u.last_name,
         COUNT(DISTINCT ce.user_id) AS student_count
       FROM courses c
       LEFT JOIN course_categories cat ON c.category_id  = cat.id
       LEFT JOIN users u               ON c.instructor_id = u.id
       LEFT JOIN course_enrollments ce ON c.id            = ce.course_id
       WHERE c.is_published = 1
       GROUP BY c.id
       ORDER BY c.rating DESC, student_count DESC, c.created_at DESC
       LIMIT 6`
    );
    return res.json({ success: true, data: convertBigInt(courses) });
  } catch (error) {
    console.error("❌ getPopularCourses:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE FILTERS
// GET /api/courses/filters
// ═════════════════════════════════════════════════════════════════════════════
export const getCourseFilters = async (req: Request, res: Response) => {
  try {
    const [categories, levels, languages] = await Promise.all([
      query(`SELECT id, name, slug FROM course_categories ORDER BY name ASC`),
      query(`SELECT DISTINCT level FROM courses WHERE level IS NOT NULL ORDER BY level ASC`),
      query(`SELECT DISTINCT language FROM courses WHERE language IS NOT NULL ORDER BY language ASC`),
    ]);

    return res.json({
      success: true,
      data: {
        categories: convertBigInt(categories),
        levels:     convertBigInt(levels).map((l: any) => l.level),
        languages:  convertBigInt(languages).map((l: any) => l.language),
        freePaid:   [{ value: 1, label: "Gratuit" }, { value: 0, label: "Payant" }],
      },
    });
  } catch (error) {
    console.error("❌ getCourseFilters:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET COURSE STUDENTS
// GET /api/courses/:id/students
// ═════════════════════════════════════════════════════════════════════════════
export const getCourseStudents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId = Number(req.params.id);
    const user     = req.user;

    if (!user)           return res.status(401).json({ success: false, message: "Non authentifié" });
    if (isNaN(courseId)) return res.status(400).json({ success: false, message: "ID invalide" });

    const [course] = await query(
      `SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')`,
      [courseId, user.id, user.role]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable ou accès refusé" });

    const students = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role,
              ce.enrolled_at, ce.completion_percentage, ce.last_accessed_at
       FROM course_enrollments ce JOIN users u ON ce.user_id = u.id
       WHERE ce.course_id = ? ORDER BY ce.enrolled_at DESC`,
      [courseId]
    );
    return res.json({ success: true, data: convertBigInt(students) });
  } catch (error) {
    console.error("❌ getCourseStudents:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// UPDATE COURSE
// PUT /api/courses/:id
// ═════════════════════════════════════════════════════════════════════════════
export const updateCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId = Number(req.params.id);
    const user     = req.user;
    const { title, description, price, level, category_id, is_published, requirements, learning_outcomes, is_free } = req.body;

    if (!user)           return res.status(401).json({ success: false, message: "Non authentifié" });
    if (isNaN(courseId)) return res.status(400).json({ success: false, message: "ID invalide" });

    const [course] = await query(
      `SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')`,
      [courseId, user.id, user.role]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable ou accès refusé" });

    await query(
      `UPDATE courses
       SET title=?, description=?, price=?, level=?, category_id=?,
           is_published=?, requirements=?, learning_outcomes=?, is_free=?, updated_at=NOW()
       WHERE id=?`,
      [title, description, price, level, category_id, is_published,
       JSON.stringify(requirements || []), JSON.stringify(learning_outcomes || []),
       is_free || false, courseId]
    );

    const [updated] = await query(`SELECT * FROM courses WHERE id = ?`, [courseId]);
    return res.json({ success: true, message: "Cours mis à jour", data: convertBigInt(updated) });
  } catch (error) {
    console.error("❌ updateCourse:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// DELETE COURSE
// DELETE /api/courses/:id
// ═════════════════════════════════════════════════════════════════════════════
export const deleteCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId = Number(req.params.id);
    const user     = req.user;

    if (!user)           return res.status(401).json({ success: false, message: "Non authentifié" });
    if (isNaN(courseId)) return res.status(400).json({ success: false, message: "ID invalide" });

    const [course] = await query(
      `SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')`,
      [courseId, user.id, user.role]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable ou accès refusé" });

    await query(`DELETE FROM courses WHERE id = ?`, [courseId]);
    return res.json({ success: true, message: "Cours supprimé avec succès" });
  } catch (error) {
    console.error("❌ deleteCourse:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET MODULES — Alias (ancienne route avec courseId dans params)
// ═════════════════════════════════════════════════════════════════════════════
export const getModules = async (req: AuthenticatedRequest, res: Response) => {
  req.params.id = req.params.courseId;
  return getCourseModules(req, res);
};

// ═════════════════════════════════════════════════════════════════════════════
// GET MODULE BY ID
// ═════════════════════════════════════════════════════════════════════════════
export const getModuleById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseIdNum = Number(req.params.courseId);
    const moduleIdNum = Number(req.params.moduleId);
    const user        = req.user || null;

    const [course]: any = await query(
      `SELECT id, is_published, instructor_id FROM courses WHERE id = ?`, [courseIdNum]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable" });

    const enrolled  = user ? await isUserEnrolled(courseIdNum, user.id) : false;
    const hasAccess = course.is_published || (user && (user.role === "admin" || user.id === course.instructor_id)) || enrolled;
    if (!hasAccess) return res.status(403).json({ success: false, message: "Accès refusé" });

    const [module]: any = await query(
      `SELECT m.*, c.title AS course_title FROM modules m JOIN courses c ON m.course_id = c.id
       WHERE m.id = ? AND m.course_id = ?`,
      [moduleIdNum, courseIdNum]
    );
    if (!module) return res.status(404).json({ success: false, message: "Module introuvable" });

    const lessons = await query(
      `SELECT * FROM lessons WHERE module_id = ? AND is_published = 1 ORDER BY order_index`, [moduleIdNum]
    );
    return res.json({ success: true, data: { ...convertBigInt(module), lessons: convertBigInt(lessons) } });
  } catch (error) {
    console.error("❌ getModuleById:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// CREATE MODULE
// ═════════════════════════════════════════════════════════════════════════════
export const createModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseIdNum = Number(req.params.courseId);
    const { title, description, order_index, is_published } = req.body;
    const user = req.user;

    if (!user)  return res.status(401).json({ success: false, message: "Non authentifié" });
    if (!title) return res.status(400).json({ success: false, message: "Titre requis" });

    const [course] = await query(
      `SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')`,
      [courseIdNum, user.id, user.role]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable ou accès refusé" });

    let orderIndex = order_index;
    if (!orderIndex) {
      const [last]: any = await query(
        `SELECT MAX(order_index) AS max_order FROM modules WHERE course_id = ?`, [courseIdNum]
      );
      orderIndex = (last?.max_order || 0) + 1;
    }

    const result = await query(
      `INSERT INTO modules (course_id, title, description, order_index, is_published, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [courseIdNum, title, description, orderIndex, is_published !== undefined ? is_published : 1]
    );
    return res.status(201).json({ success: true, message: "Module créé", data: { id: (result as any).insertId } });
  } catch (error) {
    console.error("❌ createModule:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// UPDATE MODULE
// ═════════════════════════════════════════════════════════════════════════════
export const updateModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseIdNum = Number(req.params.courseId);
    const moduleIdNum = Number(req.params.moduleId);
    const { title, description, order_index, is_published } = req.body;
    const user = req.user;

    if (!user) return res.status(401).json({ success: false, message: "Non authentifié" });

    const [module]: any = await query(
      `SELECT m.*, c.instructor_id FROM modules m JOIN courses c ON m.course_id = c.id
       WHERE m.id = ? AND m.course_id = ?`,
      [moduleIdNum, courseIdNum]
    );
    if (!module) return res.status(404).json({ success: false, message: "Module introuvable" });
    if (user.role !== "admin" && user.id !== module.instructor_id)
      return res.status(403).json({ success: false, message: "Non autorisé" });

    await query(
      `UPDATE modules SET title=?, description=?, order_index=?, is_published=?, updated_at=NOW() WHERE id=?`,
      [title || module.title, description ?? module.description,
       order_index ?? module.order_index, is_published ?? module.is_published, moduleIdNum]
    );
    return res.json({ success: true, message: "Module mis à jour" });
  } catch (error) {
    console.error("❌ updateModule:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// DELETE MODULE
// ═════════════════════════════════════════════════════════════════════════════
export const deleteModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseIdNum = Number(req.params.courseId);
    const moduleIdNum = Number(req.params.moduleId);
    const user        = req.user;

    if (!user) return res.status(401).json({ success: false, message: "Non authentifié" });

    const [module]: any = await query(
      `SELECT m.*, c.instructor_id FROM modules m JOIN courses c ON m.course_id = c.id
       WHERE m.id = ? AND m.course_id = ?`,
      [moduleIdNum, courseIdNum]
    );
    if (!module) return res.status(404).json({ success: false, message: "Module introuvable" });
    if (user.role !== "admin" && user.id !== module.instructor_id)
      return res.status(403).json({ success: false, message: "Non autorisé" });

    await query(`DELETE FROM modules WHERE id = ?`, [moduleIdNum]);
    await query(
      `UPDATE modules SET order_index = order_index - 1 WHERE course_id = ? AND order_index > ?`,
      [courseIdNum, module.order_index]
    );
    return res.json({ success: true, message: "Module supprimé" });
  } catch (error) {
    console.error("❌ deleteModule:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// EXPORT PAR DÉFAUT
// ═════════════════════════════════════════════════════════════════════════════
export default {
  // ── Cours ────────────────────────────────────
  createCourse,
  getCourses,
  getCourseById,
  getCourseByIdEnhanced,
  getCoursePublic,
  getCoursePreview,
  getCourseFilters,
  getPopularCourses,
  updateCourse,
  deleteCourse,
  getCourseStudents,
  getUserCourses,
  // ── Inscription ──────────────────────────────
  enrollCourse,
  getEnrollmentStatus,
  // ── Contenu & progression ────────────────────
  getCourseContent,
  getCourseModules,
  getCourseProgressForUser,
  // ── Leçons ───────────────────────────────────
  getLesson,
  getLessonById,
  updateLessonStatus,
  completeLesson,
  // ── Modules CRUD (instructeur/admin) ─────────
  getModules,
  getModuleById,
  createModule,
  updateModule,
  deleteModule,
};