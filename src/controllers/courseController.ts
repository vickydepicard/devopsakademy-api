import { Request, Response } from "express";
import { query } from "../config/database";
import slugify from "slugify";
import { AuthenticatedRequest } from "../middleware/auth"; 

// ✅ Helper pour convertir BigInt en Number
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

// ================= CREATE COURSE =================
export const createCourse = async (req: Request, res: Response) => {
  try {
    const {
      title,
      description,
      price,
      level,
      category_id,
      requirements,
      learning_outcomes,
      is_free,
    } = req.body;
    const instructorId = (req as any).user.id;

    if (!title || !description) {
      return res
        .status(400)
        .json({ success: false, message: "Titre et description sont requis" });
    }

    // ✅ Slug unique
    const slug =
      slugify(title, { lower: true, strict: true }) + "-" + Date.now();

    const result = await query(
      `
      INSERT INTO courses 
        (title, description, instructor_id, price, level, category_id, requirements, learning_outcomes, slug, is_free)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        title,
        description,
        instructorId,
        price || 0,
        level || "beginner",
        category_id || null,
        JSON.stringify(requirements || []),
        JSON.stringify(learning_outcomes || []),
        slug,
        is_free || false,
      ]
    );

    const insertId = Number((result as any).insertId);

    res.status(201).json({
      success: true,
      message: "Cours créé avec succès",
      data: { id: insertId, slug },
    });
  } catch (error) {
    console.error("Create course error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la création du cours",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};

/* ================= GET ALL COURSES =================
export const getCourses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const user = req.user || null; // ✅ récupère utilisateur connecté
    const offset = (Number(page) - 1) * Number(limit);

    // Récupère les cours
    const courses = await query(
      `SELECT c.*, u.first_name, u.last_name, COUNT(ce.user_id) AS total_students
       FROM courses c
       LEFT JOIN users u ON c.instructor_id = u.id
       LEFT JOIN course_enrollments ce ON c.id = ce.course_id
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [Number(limit), offset]
    );

    let formattedCourses = convertBigInt(courses);

    // ✅ Ajoute "isEnrolled" si l’utilisateur est connecté
    if (user) {
      const enrollments = await query(
        `SELECT course_id FROM course_enrollments WHERE user_id = ?`,
        [user.id]
      );
      const enrolledIds = new Set(enrollments.map((e: any) => Number(e.course_id)));

      formattedCourses = formattedCourses.map((c: any) => ({
        ...c,
        isEnrolled: enrolledIds.has(c.id),
      }));
    }

    res.json({
      success: true,
      data: formattedCourses,
      pagination: { page: Number(page), limit: Number(limit) }
    });
  } catch (err) {
    console.error("❌ [BACKEND ERROR getCourses] :", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};*/

// ================= GET ALL COURSES (Avec filtres + dynamique) =================
export const getCourses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = null,
      category = null,
      level = null,
      is_free = null,
      language = null,
    } = req.query;

    const user = req.user || null;
    const offset = (Number(page) - 1) * Number(limit);

    // ✅ Nettoyage des filtres
    const safeFilters = {
      search: search && search !== "" ? String(search) : null,
      category: category && category !== "" ? String(category) : null,
      level: level && level !== "" ? String(level) : null,
      is_free: is_free !== "" && is_free !== null ? Number(is_free) : null,
      language: language && language !== "" ? String(language) : null,
    };

    console.log("🎯 Filtres appliqués :", safeFilters);
    console.log("📡 Pagination:", { page, limit, offset });

    const courses = await query(
      `
      SELECT 
        c.id, c.title, c.short_description, c.thumbnail_url, c.price, c.is_free,
        c.level, c.language, c.is_featured, c.is_published,
        c.rating, c.review_count, c.created_at,
        cat.name AS category_name,
        u.first_name, u.last_name,
        COUNT(DISTINCT ce.user_id) AS student_count
      FROM courses c
      LEFT JOIN course_categories cat ON c.category_id = cat.id
      LEFT JOIN users u ON c.instructor_id = u.id
      LEFT JOIN course_enrollments ce ON c.id = ce.course_id
      WHERE c.is_published = 1
        AND (? IS NULL OR (c.title LIKE CONCAT('%', ?, '%') OR c.short_description LIKE CONCAT('%', ?, '%')))
        AND (? IS NULL OR cat.slug = ? OR cat.id = ?)
        AND (? IS NULL OR c.level = ?)
        AND (? IS NULL OR c.is_free = ?)
        AND (? IS NULL OR c.language = ?)
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [
        safeFilters.search, safeFilters.search, safeFilters.search, // recherche
        safeFilters.category, safeFilters.category, safeFilters.category, // catégorie
        safeFilters.level, safeFilters.level, // niveau
        safeFilters.is_free, safeFilters.is_free, // gratuit/payant
        safeFilters.language, safeFilters.language, // langue
        Number(limit), offset,
      ]
    );

    let formattedCourses = convertBigInt(courses);

    // ✅ Ajoute isEnrolled si connecté et student
    if (user && user.role === "student") {
      const enrollments = await query(
        `SELECT course_id FROM course_enrollments WHERE user_id = ?`,
        [user.id]
      );
      const enrolledIds = new Set(enrollments.map((e: any) => Number(e.course_id)));

      formattedCourses = formattedCourses.map((c: any) => ({
        ...c,
        isEnrolled: enrolledIds.has(c.id),
      }));
    }

    console.log("✅ Résultat trouvé :", formattedCourses.length, "cours");

    res.json({
      success: true,
      data: formattedCourses,
      pagination: { page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error("❌ [BACKEND ERROR getCourses] :", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


// ================= GET USER COURSES =================
export const getUserCourses = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;

    const courses = await query(
      `
      SELECT 
        c.id, c.title, c.description, c.thumbnail_url, c.level, c.price,
        c.duration_hours, c.language, c.is_free, c.video_preview_url,
        u.first_name, u.last_name,
        ce.completion_percentage, ce.enrolled_at
      FROM course_enrollments ce
      JOIN courses c ON ce.course_id = c.id
      JOIN users u ON c.instructor_id = u.id
      WHERE ce.user_id = ?
      ORDER BY ce.enrolled_at DESC
      `,
      [userId]
    );

    res.json({ success: true, data: convertBigInt(courses) });
  } catch (error) {
    console.error("Get user courses error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération des cours utilisateur",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};

/* ================= GET COURSE BY ID =================
export const getCourseById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user || null;

    const [course] = await query(
      `
      SELECT 
        c.id, c.title, c.description, c.instructor_id, c.price, c.level,
        c.category_id, c.thumbnail_url, c.video_preview_url, c.is_published,
        c.is_featured, c.duration_hours, c.language, c.is_free,
        c.requirements, c.learning_outcomes,
        c.created_at, c.updated_at,
        u.first_name, u.last_name,
        cat.name as category_name,
        COUNT(DISTINCT ce.user_id) as total_students
      FROM courses c
      LEFT JOIN users u ON c.instructor_id = u.id
      LEFT JOIN course_categories cat ON c.category_id = cat.id
      LEFT JOIN course_enrollments ce ON c.id = ce.course_id
      WHERE c.id = ?
      GROUP BY c.id
      `,
      [id]
    );

    if (!course) {
      return res
        .status(404)
        .json({ success: false, message: "Cours non trouvé" });
    }

    let courseData: any = convertBigInt(course);

    // Vérifie si l’utilisateur est inscrit
    let isEnrolled = false;
    let completion = 0;
    if (user) {
      const [enrollment] = await query(
        "SELECT completion_percentage FROM course_enrollments WHERE course_id = ? AND user_id = ?",
        [id, user.id]
      );
      if (enrollment) {
        isEnrolled = true;
        completion = Number((enrollment as any).completion_percentage || 0);
      }
    }

    courseData.isEnrolled = isEnrolled;
    courseData.completion_percentage = completion;

    // ✅ Contenu visible si publié / admin / instructeur / inscrit
    if (
      course.is_published ||
      (user && (user.role === "admin" || user.id === course.instructor_id)) ||
      isEnrolled
    ) {
      const modules = await query(
        `
        SELECT m.id, m.title, m.order_index,
               COUNT(l.id) as lesson_count,
               COALESCE(SUM(l.duration_minutes), 0) as total_duration
        FROM modules m
        LEFT JOIN lessons l ON m.id = l.module_id
        WHERE m.course_id = ?
        GROUP BY m.id
        ORDER BY m.order_index
        `,
        [id]
      );

      // Inclure les leçons avec statut complété
      const fullModules = [];
      for (const mod of modules as any[]) {
        const lessons = await query(
          `
          SELECT l.id, l.title, l.duration_minutes,
                 IFNULL(cp.completed, 0) as completed
          FROM lessons l
          LEFT JOIN lesson_progress cp 
            ON cp.lesson_id = l.id AND cp.user_id = ?
          WHERE l.module_id = ?
          ORDER BY l.order_index
          `,
          [user?.id || 0, mod.id]
        );

        fullModules.push({
          ...convertBigInt(mod),
          lessons: convertBigInt(lessons),
        });
      }

      courseData.modules = fullModules;
    } else {
      courseData.modules = [];
    }

    res.json({ success: true, data: courseData });
  } catch (error) {
    console.error("Get course error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération du cours",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};*/

// ================= GET COURSE BY ID (corrigé avec lesson_progress) =================
/*export const getCourseById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user || null;

    // ================== 1. Infos de base du cours ==================
    const [course] = await query(
      `
      SELECT 
        c.id, c.title, c.description, c.short_description,
        c.thumbnail_url, c.video_preview_url, c.price, c.is_free,
        c.level, c.language, c.is_featured, c.is_published,
        c.rating, c.review_count, c.duration_hours,
        c.requirements, c.learning_outcomes,
        c.instructor_id, u.first_name, u.last_name,
        cat.name AS category_name,
        COUNT(DISTINCT ce.user_id) AS student_count,
        c.created_at, c.updated_at
      FROM courses c
      LEFT JOIN users u ON c.instructor_id = u.id
      LEFT JOIN course_categories cat ON c.category_id = cat.id
      LEFT JOIN course_enrollments ce ON c.id = ce.course_id
      WHERE c.id = ?
      GROUP BY c.id
      `,
      [id]
    );

    if (!course) {
      return res
        .status(404)
        .json({ success: false, message: "Cours non trouvé" });
    }

    let courseData: any = convertBigInt(course);

    // ================== 2. Vérifie inscription ==================
    let isEnrolled = false;
    let completion_percentage = 0;

    if (user && user.role === "student") {
      const [enrollment] = await query(
        "SELECT completion_percentage FROM course_enrollments WHERE course_id = ? AND user_id = ?",
        [id, user.id]
      );

      if (enrollment) {
        isEnrolled = true;
      }
    }

    courseData.isEnrolled = isEnrolled;

    // ================== 3. Vérifie droits d’accès ==================
    const hasAccess =
      courseData.is_published ||
      (user &&
        (user.role === "admin" || user.id === courseData.instructor_id)) ||
      isEnrolled;

    if (hasAccess) {
      // ================== 4. Récupère modules ==================
      const modules = await query(
        `
        SELECT m.id, m.title, m.description, m.order_index,
               COUNT(l.id) AS lesson_count,
               COALESCE(SUM(l.duration_minutes), 0) AS total_duration
        FROM modules m
        LEFT JOIN lessons l ON m.id = l.module_id
        WHERE m.course_id = ?
        GROUP BY m.id
        ORDER BY m.order_index
        `,
        [id]
      );

      const fullModules: any[] = [];
      let totalLessons = 0;
      let completedLessons = 0;

      for (const mod of modules as any[]) {
        const lessons = await query(
          `
          SELECT l.id, l.title, l.duration_minutes, l.order_index,
                 IFNULL(lp.is_completed, 0) AS completed
          FROM lessons l
          LEFT JOIN lesson_progress lp 
            ON lp.lesson_id = l.id AND lp.user_id = ?
          WHERE l.module_id = ?
          ORDER BY l.order_index
          `,
          [user?.id || 0, mod.id]
        );

        // Compte progression
        totalLessons += lessons.length;
        completedLessons += lessons.filter((l: any) => l.completed === 1).length;

        fullModules.push({
          ...convertBigInt(mod),
          lessons: convertBigInt(lessons),
        });
      }

      // ================== 5. Calcul progression ==================
      if (totalLessons > 0) {
        completion_percentage = Math.round(
          (completedLessons / totalLessons) * 100
        );
      }

      courseData.modules = fullModules;
    } else {
      courseData.modules = [];
    }

    courseData.completion_percentage = completion_percentage;

    // ================== 6. Réponse ==================
    res.json({ success: true, data: courseData });
  } catch (error) {
    console.error("❌ [BACKEND ERROR getCourseById] :", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération du cours",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};


/**
 * =============================
 *   GET: Détail d’une leçon
 * =============================
 */
export const getLessonById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, lessonId } = req.params;
    const user = req.user || null;

    // Vérifie si la leçon appartient bien au cours
    const [lesson]: any = await query(
      `SELECT l.id, l.module_id, l.title, l.content_type, l.content_url, 
              l.article_content, l.duration_minutes, l.order_index,
              m.course_id
       FROM lessons l
       JOIN modules m ON l.module_id = m.id
       WHERE l.id = ? AND m.course_id = ?`,
      [lessonId, courseId]
    );

    if (!lesson) {
      return res.status(404).json({ success: false, message: "Leçon introuvable" });
    }

    // ✅ Vérifie si l’utilisateur est inscrit au cours
    let hasAccess = false;
    if (user) {
      if (user.role === "admin") hasAccess = true;

      const [enrollment]: any = await query(
        "SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ?",
        [courseId, user.id]
      );
      if (enrollment) hasAccess = true;
    }

    if (!hasAccess) {
      return res.status(403).json({ success: false, message: "Accès refusé : non inscrit" });
    }

    // ✅ Récupère le statut de progression
    const [progress]: any = await query(
      `SELECT status, is_completed, video_progress_seconds, video_duration_seconds
       FROM lesson_progress
       WHERE user_id = ? AND lesson_id = ? AND course_id = ?`,
      [user?.id || 0, lessonId, courseId]
    );

    const lessonData = {
      ...lesson,
      status: progress?.status || "not_started",
      is_completed: progress?.is_completed || 0,
      video_progress_seconds: progress?.video_progress_seconds || 0,
      video_duration_seconds: progress?.video_duration_seconds || 0,
    };

    return res.json({ success: true, data: convertBigInt(lessonData) });
  } catch (err) {
    console.error("❌ getLessonById error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


/**
 * =============================
 *   PATCH: Mettre à jour une leçon (in_progress / completed / not_started)
 * =============================
 */
export const updateLessonStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || req.user.role !== "student") {
      return res.status(403).json({ success: false, message: "Seuls les étudiants peuvent modifier une leçon" });
    }

    const { courseId, lessonId } = req.params;
    const { status, video_progress_seconds, video_duration_seconds } = req.body;

    // ✅ Vérif statut
    if (!["not_started", "in_progress", "completed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Statut invalide" });
    }

    // ✅ Vérif inscription
    const [enrollment]: any = await query(
      "SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ?",
      [courseId, req.user.id]
    );
    if (!enrollment) {
      return res.status(403).json({ success: false, message: "Non inscrit à ce cours" });
    }

    // ✅ Vérif leçon
    const [lesson]: any = await query(
      "SELECT id FROM lessons WHERE id = ? AND module_id IN (SELECT id FROM modules WHERE course_id = ?)",
      [lessonId, courseId]
    );
    if (!lesson) {
      return res.status(404).json({ success: false, message: "Leçon introuvable" });
    }

    // ✅ Insert / Update progression
    await query(
      `INSERT INTO lesson_progress 
         (user_id, lesson_id, course_id, status, is_completed, completed_at, video_progress_seconds, video_duration_seconds, last_accessed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE 
         status = VALUES(status),
         is_completed = VALUES(is_completed),
         completed_at = VALUES(completed_at),
         video_progress_seconds = VALUES(video_progress_seconds),
         video_duration_seconds = VALUES(video_duration_seconds),
         last_accessed_at = NOW(),
         updated_at = NOW()`,
      [
        req.user.id,
        lessonId,
        courseId,
        status,
        status === "completed" ? 1 : 0,
        status === "completed" ? new Date() : null,
        video_progress_seconds || 0,
        video_duration_seconds || 0
      ]
    );

    // ✅ Recalcul progression globale du cours
    const [stats]: any = await query(
      `SELECT COUNT(l.id) AS total,
              SUM(CASE WHEN lp.is_completed = 1 THEN 1 ELSE 0 END) AS completed
       FROM lessons l
       LEFT JOIN lesson_progress lp 
         ON lp.lesson_id = l.id AND lp.user_id = ?
       WHERE l.module_id IN (SELECT id FROM modules WHERE course_id = ?)`,
      [req.user.id, courseId]
    );

    // 🔥 Conversion explicite pour éviter BigInt crash
    const total = Number(stats.total || 0);
    const completed = Number(stats.completed || 0);

    const completion_percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    await query(
      "UPDATE course_enrollments SET completion_percentage = ? WHERE user_id = ? AND course_id = ?",
      [completion_percentage, req.user.id, courseId]
    );

    // ✅ Réponse clean
    return res.json({
      success: true,
      message: `Leçon mise à jour (${status})`,
      lessonId: Number(lessonId),
      status,
      newProgress: completion_percentage
    });
  } catch (err) {
    console.error("❌ updateLessonStatus error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


// ================= GET COURSE FILTERS =================
export const getCourseFilters = async (req: Request, res: Response) => {
  try {
    // ✅ Catégories distinctes
    const categories = await query(
      `SELECT id, name, slug FROM course_categories ORDER BY name ASC`
    );

    // ✅ Niveaux distincts
    const levels = await query(
      `SELECT DISTINCT level FROM courses WHERE level IS NOT NULL ORDER BY level ASC`
    );

    // ✅ Langues distinctes
    const languages = await query(
      `SELECT DISTINCT language FROM courses WHERE language IS NOT NULL ORDER BY language ASC`
    );

    // ✅ Gratuit / Payant (booléen déjà en DB → 0/1)
    const freePaid = [
      { value: 1, label: "Gratuit" },
      { value: 0, label: "Payant" },
    ];

    res.json({
      success: true,
      data: {
        categories: convertBigInt(categories),
        levels: convertBigInt(levels).map((l: any) => l.level),
        languages: convertBigInt(languages).map((l: any) => l.language),
        freePaid,
      },
    });
  } catch (error) {
    console.error("❌ [BACKEND ERROR getCourseFilters] :", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération des filtres",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};

// ================= UPDATE COURSE =================
export const updateCourse = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      price,
      level,
      category_id,
      is_published,
      requirements,
      learning_outcomes,
      is_free,
    } = req.body;
    const user = req as any;

    const [course] = await query(
      "SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')",
      [id, user.user.id, user.user.role]
    );
    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Cours non trouvé ou accès non autorisé",
      });
    }

    await query(
      `
      UPDATE courses
      SET title = ?, description = ?, price = ?, level = ?, category_id = ?,
          is_published = ?, requirements = ?, learning_outcomes = ?, 
          is_free = ?, updated_at = NOW()
      WHERE id = ?
    `,
      [
        title,
        description,
        price,
        level,
        category_id,
        is_published,
        JSON.stringify(requirements || []),
        JSON.stringify(learning_outcomes || []),
        is_free || false,
        id,
      ]
    );

    const [updatedCourse] = await query(
      "SELECT * FROM courses WHERE id = ?",
      [id]
    );

    res.json({
      success: true,
      message: "Cours mis à jour avec succès",
      data: convertBigInt(updatedCourse),
    });
  } catch (error) {
    console.error("Update course error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la mise à jour du cours",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};

// ================= DELETE COURSE =================
export const deleteCourse = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = req as any;

    const [course] = await query(
      "SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')",
      [id, user.user.id, user.user.role]
    );
    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Cours non trouvé ou accès non autorisé",
      });
    }

    await query("DELETE FROM courses WHERE id = ?", [id]);
    res.json({ success: true, message: "Cours supprimé avec succès" });
  } catch (error) {
    console.error("Delete course error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la suppression du cours",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};

// ================= GET COURSE STUDENTS =================
export const getCourseStudents = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = req as any;

    const [course] = await query(
      "SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')",
      [id, user.user.id, user.user.role]
    );
    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Cours non trouvé ou accès non autorisé",
      });
    }

    const students = await query(
      `
      SELECT u.id, u.email, u.first_name, u.last_name, u.role,
             ce.enrolled_at, ce.completion_percentage, ce.last_accessed_at
      FROM course_enrollments ce
      JOIN users u ON ce.user_id = u.id
      WHERE ce.course_id = ?
      ORDER BY ce.enrolled_at DESC
    `,
      [id]
    );

    res.json({ success: true, data: convertBigInt(students) });
  } catch (error) {
    console.error("Get course students error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération des étudiants",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};


// ================= GET POPULAR COURSES =================
export const getPopularCourses = async (req: Request, res: Response) => {
  try {
    const courses = await query(
      `
      SELECT 
        c.id, c.title, c.short_description, c.thumbnail_url, c.price, c.is_free,
        c.level, c.language, c.is_featured, c.rating, c.review_count,
        cat.name AS category_name,
        u.first_name, u.last_name,
        COUNT(DISTINCT ce.user_id) AS student_count
      FROM courses c
      LEFT JOIN course_categories cat ON c.category_id = cat.id
      LEFT JOIN users u ON c.instructor_id = u.id
      LEFT JOIN course_enrollments ce ON c.id = ce.course_id
      WHERE c.is_published = 1
      GROUP BY c.id
      ORDER BY c.rating DESC, student_count DESC, c.created_at DESC
      LIMIT 6
      `
    );

    res.json({
      success: true,
      data: convertBigInt(courses),
    });
  } catch (err) {
    console.error("❌ [BACKEND ERROR getPopularCourses] :", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


// ✅ Route publique : détail partiel
export const getCoursePublic = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const sql = `
      SELECT id, title, description, thumbnail_url, level, is_free, price 
      FROM courses WHERE id = ?
    `;
    const result = await query(sql, [id]);

    if (result.length === 0) {
      res.status(404).json({ success: false, message: "Cours introuvable" });
      return;
    }

    res.status(200).json({ success: true, data: result[0] });
  } catch (error) {
    console.error("❌ Erreur getCoursePublic :", error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const getCourseById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || null;

    // 1️⃣ Récupération du cours
    const [course]: any = await query(
      `SELECT 
         c.id, c.title, c.short_description, c.long_description, c.thumbnail_url,
         c.level, c.is_published, c.price, c.is_free, 
         u.first_name, u.last_name
       FROM courses c
       JOIN users u ON c.instructor_id = u.id
       WHERE c.id = ? AND c.is_published = 1`,
      [id]
    );

    if (!course) {
      return res.status(404).json({ success: false, message: "Cours introuvable." });
    }

    // 2️⃣ Vérifier si l’utilisateur est inscrit
    let enrollment = null;
    if (userId) {
      const [result]: any = await query(
        `SELECT is_approved, payment_status, payment_proof_url 
         FROM course_enrollments 
         WHERE course_id = ? AND user_id = ?`,
        [id, userId]
      );
      enrollment = result || null;
    }

    // 3️⃣ Cas non inscrit → aperçu partiel (2 modules max)
    if (!enrollment) {
      const modules = await query(
        `SELECT id, title 
         FROM modules WHERE course_id = ? ORDER BY order_index ASC LIMIT 1`,
        [id]
      );

      for (const m of modules) {
        m.lessons = await query(
          `SELECT id, title, duration_minutes 
           FROM lessons WHERE module_id = ? ORDER BY order_index ASC LIMIT 2`,
          [m.id]
        );
      }

      return res.json({
        success: true,
        data: {
          ...course,
          modules,
          access: "public",
        },
      });
    }

    // 4️⃣ Cas inscrit mais paiement en attente
    if (enrollment.payment_status === "pending" || !enrollment.is_approved) {
      return res.json({
        success: true,
        data: {
          ...course,
          access: "pending",
          payment_status: enrollment.payment_status,
          payment_proof_url: enrollment.payment_proof_url,
        },
      });
    }

    // 5️⃣ Cas validé → accès complet
    const modules = await query(
      `SELECT id, title FROM modules WHERE course_id = ? ORDER BY order_index ASC`,
      [id]
    );

    for (const module of modules) {
      module.lessons = await query(
        `SELECT id, title, duration_minutes 
         FROM lessons WHERE module_id = ? ORDER BY order_index ASC`,
        [module.id]
      );
    }

    return res.json({
      success: true,
      data: {
        ...course,
        modules,
        access: "full",
      },
    });
  } catch (error) {
    console.error("❌ getCourseById error:", error);
    res.status(500).json({ success: false, message: "Erreur serveur." });
  }
};


export const getCoursePreview = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const [course]: any = await query(
      `SELECT id, title, short_description, thumbnail_url, level, language, price, first_name, last_name
       FROM courses
       JOIN users ON courses.instructor_id = users.id
       WHERE courses.id = ? AND is_published = 1`,
      [id]
    );

    if (!course) {
      res.status(404).json({ success: false, message: "Cours introuvable" });
      return;
    }

    // Récupère 2 modules max avec leurs leçons
    const modules = await query(
      `SELECT id, title FROM modules WHERE course_id = ? LIMIT 2`,
      [id]
    );

    for (const m of modules) {
      m.lessons = await query(
        `SELECT id, title, duration_minutes FROM lessons WHERE module_id = ? LIMIT 2`,
        [m.id]
      );
    }

    res.json({
      success: true,
      data: { ...course, modules },
    });
  } catch (error) {
    console.error("❌ getCoursePreview:", error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};



