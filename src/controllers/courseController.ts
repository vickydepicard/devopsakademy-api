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
export const createCourse = async (req: AuthenticatedRequest, res: Response) => {
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
    
    const user = req.user;
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

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
        user.id,
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

// ================= GET ALL COURSES =================
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
export const getUserCourses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user;
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

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
      [user.id]
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

// ================= GET COURSE BY ID (Version complète) =================

export const getCourseById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // Pas de req.user ici - c'est pour les visiteurs

    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    // ================== 1. Infos de base du cours (limitées) ==================
    const [course]: any = await query(
      `SELECT 
        c.id, c.title, c.description, c.short_description,
        c.thumbnail_url, c.video_preview_url, c.price, c.original_price,
        c.is_free, c.level, c.language, c.is_featured, c.is_published,
        c.rating, c.review_count, c.duration_hours, c.student_count,
        c.requirements, c.learning_outcomes,
        u.first_name, u.last_name,
        cat.name as category_name, cat.slug as category_slug,
        c.created_at, c.published_at
      FROM courses c
      LEFT JOIN users u ON c.instructor_id = u.id
      LEFT JOIN course_categories cat ON c.category_id = cat.id
      WHERE c.id = ? AND c.is_published = 1`,
      [courseId]
    );

    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: "Cours non trouvé ou non publié" 
      });
    }

    let courseData: any = convertBigInt(course);

    // ================== 2. Pas d'info d'inscription pour les visiteurs ==================
    courseData.isEnrolled = false;
    courseData.isApproved = false;
    courseData.enrollmentStatus = "not_enrolled";

    // ================== 3. Modules (titres seulement) ==================
    // Pour les visiteurs, on montre juste les titres
    const modules = await query(
      `SELECT m.id, m.title, m.order_index,
              COUNT(l.id) AS lesson_count
       FROM modules m
       LEFT JOIN lessons l ON m.id = l.module_id AND l.is_published = 1
       WHERE m.course_id = ? AND m.is_published = 1
       GROUP BY m.id
       ORDER BY m.order_index ASC
       LIMIT 2`, // Limité à 2 modules pour les visiteurs
      [courseId]
    );

    courseData.modules = convertBigInt(modules);
    courseData.completion_percentage = 0;

    // ================== 4. Cacher certaines infos ==================
    delete courseData.instructor_id;
    delete courseData.instructor_email;
    delete courseData.requires_approval;
    delete courseData.updated_at;

    // ================== 5. Message informatif ==================
    courseData.info = "Version publique - Connectez-vous pour plus de détails";

    // ================== 6. Réponse finale ==================
    res.json({ 
      success: true, 
      data: courseData 
    });
  } catch (error) {
    console.error("❌ [BACKEND ERROR getCourseById public] :", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération du cours"
    });
  }
};

// ================= GET LESSON BY ID =================
export const getLessonById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, lessonId } = req.params;
    const user = req.user || null;

    // Convertir les IDs en nombres
    const courseIdNum = Number(courseId);
    const lessonIdNum = Number(lessonId);
    
    if (isNaN(courseIdNum) || isNaN(lessonIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours ou leçon invalide" 
      });
    }

    // Vérifie si la leçon appartient bien au cours
    const [lesson]: any = await query(
      `SELECT l.id, l.module_id, l.title, l.content_type, l.content_url, 
              l.article_content, l.duration_minutes, l.order_index,
              m.course_id
       FROM lessons l
       JOIN modules m ON l.module_id = m.id
       WHERE l.id = ? AND m.course_id = ?`,
      [lessonIdNum, courseIdNum]
    );

    if (!lesson) {
      return res.status(404).json({ success: false, message: "Leçon introuvable" });
    }

    // ✅ Vérifie si l'utilisateur est inscrit au cours
    let hasAccess = false;
    if (user) {
      if (user.role === "admin") hasAccess = true;

      const [enrollment]: any = await query(
        "SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ?",
        [courseIdNum, user.id]
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
      [user?.id || 0, lessonIdNum, courseIdNum]
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

// ================= UPDATE LESSON STATUS =================
export const updateLessonStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user;
    
    if (!user || user.role !== "student") {
      return res.status(403).json({ success: false, message: "Seuls les étudiants peuvent modifier une leçon" });
    }

    const { courseId, lessonId } = req.params;
    const { status, video_progress_seconds, video_duration_seconds } = req.body;

    // Convertir les IDs en nombres
    const courseIdNum = Number(courseId);
    const lessonIdNum = Number(lessonId);
    
    if (isNaN(courseIdNum) || isNaN(lessonIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours ou leçon invalide" 
      });
    }

    // ✅ Vérif statut
    if (!["not_started", "in_progress", "completed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Statut invalide" });
    }

    // ✅ Vérif inscription
    const [enrollment]: any = await query(
      "SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ?",
      [courseIdNum, user.id]
    );
    if (!enrollment) {
      return res.status(403).json({ success: false, message: "Non inscrit à ce cours" });
    }

    // ✅ Vérif leçon
    const [lesson]: any = await query(
      "SELECT id FROM lessons WHERE id = ? AND module_id IN (SELECT id FROM modules WHERE course_id = ?)",
      [lessonIdNum, courseIdNum]
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
        user.id,
        lessonIdNum,
        courseIdNum,
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
      [user.id, courseIdNum]
    );

    // 🔥 Conversion explicite pour éviter BigInt crash
    const total = Number(stats.total || 0);
    const completed = Number(stats.completed || 0);

    const completion_percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    await query(
      "UPDATE course_enrollments SET completion_percentage = ? WHERE user_id = ? AND course_id = ?",
      [completion_percentage, user.id, courseIdNum]
    );

    // ✅ Réponse clean
    return res.json({
      success: true,
      message: `Leçon mise à jour (${status})`,
      lessonId: lessonIdNum,
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
export const updateCourse = async (req: AuthenticatedRequest, res: Response) => {
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
    
    const user = req.user;
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    const [course] = await query(
      "SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')",
      [courseId, user.id, user.role]
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
        courseId,
      ]
    );

    const [updatedCourse] = await query(
      "SELECT * FROM courses WHERE id = ?",
      [courseId]
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
export const deleteCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    const [course] = await query(
      "SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')",
      [courseId, user.id, user.role]
    );
    
    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Cours non trouvé ou accès non autorisé",
      });
    }

    await query("DELETE FROM courses WHERE id = ?", [courseId]);
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
export const getCourseStudents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    const [course] = await query(
      "SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = 'admin')",
      [courseId, user.id, user.role]
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
      [courseId]
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

// ================= GET COURSE PUBLIC =================
export const getCoursePublic = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    
    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      res.status(400).json({ success: false, message: "ID de cours invalide" });
      return;
    }

    const sql = `
      SELECT id, title, description, thumbnail_url, level, is_free, price 
      FROM courses WHERE id = ?
    `;
    const result = await query(sql, [courseId]);

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

// ================= GET COURSE PREVIEW =================
export const getCoursePreview = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    
    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      res.status(400).json({ success: false, message: "ID de cours invalide" });
      return;
    }

    const [course]: any = await query(
      `SELECT id, title, short_description, thumbnail_url, level, language, price, first_name, last_name
       FROM courses
       JOIN users ON courses.instructor_id = users.id
       WHERE courses.id = ? AND is_published = 1`,
      [courseId]
    );

    if (!course) {
      res.status(404).json({ success: false, message: "Cours introuvable" });
      return;
    }

    // Récupère 2 modules max avec leurs leçons
    const modules = await query(
      `SELECT id, title FROM modules WHERE course_id = ? LIMIT 2`,
      [courseId]
    );

    for (const m of modules as any[]) {
      (m as any).lessons = await query(
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

// ================= GET ENROLLMENT STATUS =================
export const getEnrollmentStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    const [enrollment]: any = await query(
      `SELECT ce.*, c.title as course_title, c.is_free, c.price
       FROM course_enrollments ce
       JOIN courses c ON ce.course_id = c.id
       WHERE ce.course_id = ? AND ce.user_id = ?`,
      [courseId, user.id]
    );

    if (!enrollment) {
      return res.json({
        success: true,
        data: { enrolled: false }
      });
    }

    res.json({
      success: true,
      data: {
        enrolled: true,
        ...convertBigInt(enrollment)
      }
    });
  } catch (error) {
    console.error("Get enrollment status error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération du statut d'inscription"
    });
  }
};

// ================= GET MODULES =================
export const getModules = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;
    const user = req.user || null;

    // Convertir l'ID en nombre
    const courseIdNum = Number(courseId);
    
    if (isNaN(courseIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    // Vérifier si l'utilisateur a accès au cours
    const [course]: any = await query(
      `SELECT id, instructor_id, is_published FROM courses WHERE id = ?`,
      [courseIdNum]
    );

    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: "Cours non trouvé" 
      });
    }

    // Vérifier les permissions
    const isEnrolled = user ? await isUserEnrolled(courseIdNum, user.id) : false;
    const hasAccess = 
      course.is_published ||
      (user && (user.role === "admin" || user.id === course.instructor_id)) ||
      isEnrolled;

    if (!hasAccess) {
      return res.status(403).json({ 
        success: false, 
        message: "Accès refusé" 
      });
    }

    const modules = await query(`
      SELECT m.*, 
        COUNT(l.id) as lesson_count,
        SUM(l.duration_minutes) as total_duration
      FROM modules m
      LEFT JOIN lessons l ON m.id = l.module_id AND l.is_published = 1
      WHERE m.course_id = ? AND m.is_published = 1
      GROUP BY m.id
      ORDER BY m.order_index
    `, [courseIdNum]);

    res.json({
      success: true,
      data: convertBigInt(modules)
    });
  } catch (error) {
    console.error('Get modules error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des modules'
    });
  }
};

// ================= GET MODULE BY ID =================
export const getModuleById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;
    const user = req.user || null;

    // Convertir les IDs en nombres
    const courseIdNum = Number(courseId);
    const moduleIdNum = Number(moduleId);
    
    if (isNaN(courseIdNum) || isNaN(moduleIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours ou module invalide" 
      });
    }

    // Vérifier si l'utilisateur a accès au cours
    const [course]: any = await query(
      `SELECT id, instructor_id, is_published FROM courses WHERE id = ?`,
      [courseIdNum]
    );

    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: "Cours non trouvé" 
      });
    }

    // Vérifier les permissions
    const isEnrolled = user ? await isUserEnrolled(courseIdNum, user.id) : false;
    const hasAccess = 
      course.is_published ||
      (user && (user.role === "admin" || user.id === course.instructor_id)) ||
      isEnrolled;

    if (!hasAccess) {
      return res.status(403).json({ 
        success: false, 
        message: "Accès refusé" 
      });
    }

    const [module]: any = await query(`
      SELECT m.*, c.title as course_title
      FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ?
    `, [moduleIdNum, courseIdNum]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé'
      });
    }

    // Récupérer les leçons du module
    const lessons = await query(`
      SELECT * FROM lessons 
      WHERE module_id = ? AND is_published = 1
      ORDER BY order_index
    `, [moduleIdNum]);

    res.json({
      success: true,
      data: {
        ...convertBigInt(module),
        lessons: convertBigInt(lessons)
      }
    });
  } catch (error) {
    console.error('Get module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du module'
    });
  }
};

// ================= CREATE MODULE =================
export const createModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;
    const { title, description, order_index, is_published } = req.body;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir l'ID en nombre
    const courseIdNum = Number(courseId);
    
    if (isNaN(courseIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Le titre est requis'
      });
    }

    // Vérifier que le cours existe et appartient à l'instructeur
    const [course] = await query(
      'SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = "admin")',
      [courseIdNum, user.id, user.role]
    );

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Cours non trouvé ou accès non autorisé'
      });
    }

    // Trouver le prochain order_index si non spécifié
    let orderIndex = order_index;
    if (!orderIndex) {
      const [lastModule]: any = await query(
        `SELECT MAX(order_index) as max_order FROM modules WHERE course_id = ?`,
        [courseIdNum]
      );
      orderIndex = (lastModule.max_order || 0) + 1;
    }

    const result = await query(`
      INSERT INTO modules (course_id, title, description, order_index, is_published, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
    `, [courseIdNum, title, description, orderIndex, is_published !== undefined ? is_published : 1]);

    res.status(201).json({
      success: true,
      message: 'Module créé avec succès',
      data: { id: (result as any).insertId }
    });
  } catch (error) {
    console.error('Create module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création du module'
    });
  }
};

// ================= UPDATE MODULE =================
export const updateModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;
    const { title, description, order_index, is_published } = req.body;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir les IDs en nombres
    const courseIdNum = Number(courseId);
    const moduleIdNum = Number(moduleId);
    
    if (isNaN(courseIdNum) || isNaN(moduleIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours ou module invalide" 
      });
    }

    // Vérifier que le module existe et appartient à l'instructeur
    const [module]: any = await query(`
      SELECT m.*, c.instructor_id
      FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ?
    `, [moduleIdNum, courseIdNum]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé'
      });
    }

    // Vérifier les permissions
    if (user.role !== 'admin' && user.id !== module.instructor_id) {
      return res.status(403).json({
        success: false,
        message: 'Non autorisé à modifier ce module'
      });
    }

    await query(`
      UPDATE modules 
      SET title = ?, description = ?, order_index = ?, is_published = ?, updated_at = NOW()
      WHERE id = ?
    `, [
      title || module.title,
      description !== undefined ? description : module.description,
      order_index !== undefined ? order_index : module.order_index,
      is_published !== undefined ? is_published : module.is_published,
      moduleIdNum
    ]);

    res.json({
      success: true,
      message: 'Module mis à jour avec succès'
    });
  } catch (error) {
    console.error('Update module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour du module'
    });
  }
};

// ================= DELETE MODULE =================
export const deleteModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir les IDs en nombres
    const courseIdNum = Number(courseId);
    const moduleIdNum = Number(moduleId);
    
    if (isNaN(courseIdNum) || isNaN(moduleIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours ou module invalide" 
      });
    }

    // Vérifier que le module existe et appartient à l'instructeur
    const [module]: any = await query(`
      SELECT m.*, c.instructor_id
      FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ?
    `, [moduleIdNum, courseIdNum]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé'
      });
    }

    // Vérifier les permissions
    if (user.role !== 'admin' && user.id !== module.instructor_id) {
      return res.status(403).json({
        success: false,
        message: 'Non autorisé à supprimer ce module'
      });
    }

    await query('DELETE FROM modules WHERE id = ?', [moduleIdNum]);

    // Réorganiser les order_index des modules restants
    await query(
      `UPDATE modules 
       SET order_index = order_index - 1 
       WHERE course_id = ? AND order_index > ?`,
      [courseIdNum, module.order_index]
    );

    res.json({
      success: true,
      message: 'Module supprimé avec succès'
    });
  } catch (error) {
    console.error('Delete module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression du module'
    });
  }
};

// ================= HELPER FUNCTIONS =================
async function isUserEnrolled(courseId: number, userId: number): Promise<boolean> {
  const [enrollment]: any = await query(
    `SELECT id FROM course_enrollments 
     WHERE course_id = ? AND user_id = ? AND is_approved = 1`,
    [courseId, userId]
  );
  return !!enrollment;
}

// ... imports existants ...


// ================= ENROLL COURSE (version complète) =================
export const enrollCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const { payment_proof_url } = req.body;

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    // Vérifier si le cours existe
    const [course]: any = await query(
      `SELECT id, title, price, is_free, requires_approval 
       FROM courses WHERE id = ? AND is_published = 1`,
      [courseId]
    );

    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: "Cours non trouvé ou non publié" 
      });
    }

    // Vérifier si déjà inscrit
    const [existingEnrollment]: any = await query(
      `SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ?`,
      [courseId, user.id]
    );

    if (existingEnrollment) {
      return res.status(400).json({ 
        success: false, 
        message: "Vous êtes déjà inscrit à ce cours" 
      });
    }

    // Déterminer le statut d'approbation
    let isApproved = 0;
    let paymentStatus = "pending";
    
    if (course.is_free) {
      isApproved = 1;
      paymentStatus = "verified";
    } else if (payment_proof_url) {
      // Pour les cours payants, nécessite vérification
      paymentStatus = "pending";
      isApproved = 0;
    }

    // Créer l'inscription
    await query(
      `INSERT INTO course_enrollments 
       (user_id, course_id, is_approved, payment_status, payment_proof_url, enrolled_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [user.id, courseId, isApproved, paymentStatus, payment_proof_url || null]
    );

    res.status(201).json({
      success: true,
      message: course.is_free ? 
        "Inscription réussie !" : 
        "Inscription soumise, en attente de validation",
      data: {
        course_id: courseId,
        requires_approval: !course.is_free,
        is_approved: isApproved,
        payment_status: paymentStatus
      }
    });
  } catch (error) {
    console.error("Enroll course error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de l'inscription au cours"
    });
  }
};

// ================= GET COURSE CONTENT =================
export const getCourseContent = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id: courseId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Utilisateur non authentifié",
      });
    }

    // Vérifier si l'utilisateur est inscrit au cours
    const [enrollment]: any = await query(
      `SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ? AND is_approved = 1`,
      [courseId, userId]
    );

    if (!enrollment) {
      return res.status(403).json({
        success: false,
        message: "Vous devez être inscrit à ce cours pour accéder au contenu.",
        redirectTo: `/api/courses/${courseId}`,
      });
    }

    // Récupérer le cours avec modules et leçons
    const [course]: any = await query(
      `SELECT c.*, 
        (SELECT JSON_ARRAYAGG(
          JSON_OBJECT(
            'id', m.id,
            'title', m.title,
            'description', m.description,
            'order_index', m.order_index,
            'lessons', (
              SELECT JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id', l.id,
                  'title', l.title,
                  'content_type', l.content_type,
                  'content_url', l.content_url,
                  'article_content', l.article_content,
                  'duration_minutes', l.duration_minutes,
                  'order_index', l.order_index,
                  'is_completed', COALESCE(lp.is_completed, 0),
                  'video_progress_seconds', COALESCE(lp.video_progress_seconds, 0),
                  'video_duration_seconds', COALESCE(lp.video_duration_seconds, 0)
                )
              )
              FROM lessons l
              LEFT JOIN lesson_progress lp ON l.id = lp.lesson_id AND lp.user_id = ?
              WHERE l.module_id = m.id AND l.is_published = 1
              ORDER BY l.order_index
            )
          )
        )
        FROM modules m
        WHERE m.course_id = c.id AND m.is_published = 1
        ORDER BY m.order_index) as modules
       FROM courses c
       WHERE c.id = ?`,
      [userId, courseId]
    );

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Cours non trouvé.",
      });
    }

    // Calculer la progression du cours
    const [progress]: any = await query(
      `SELECT 
        COUNT(DISTINCT l.id) as total_lessons,
        COUNT(DISTINCT CASE WHEN lp.is_completed = 1 THEN lp.lesson_id END) as completed_lessons,
        CASE 
          WHEN COUNT(DISTINCT l.id) > 0 
          THEN ROUND((COUNT(DISTINCT CASE WHEN lp.is_completed = 1 THEN lp.lesson_id END) * 100.0 / COUNT(DISTINCT l.id)), 2)
          ELSE 0
        END as progress_percentage
       FROM lessons l
       JOIN modules m ON l.module_id = m.id
       LEFT JOIN lesson_progress lp ON l.id = lp.lesson_id AND lp.user_id = ?
       WHERE m.course_id = ? AND l.is_published = 1`,
      [userId, courseId]
    );

    // Mettre à jour la progression dans l'inscription
    if (progress?.progress_percentage > 0) {
      await query(
        `UPDATE course_enrollments 
         SET completion_percentage = ?, last_accessed_at = NOW()
         WHERE user_id = ? AND course_id = ?`,
        [progress.progress_percentage, userId, courseId]
      );
    }

    res.json({
      success: true,
      data: {
        ...course,
        progress: {
          totalLessons: progress?.total_lessons || 0,
          completedLessons: progress?.completed_lessons || 0,
          percentage: progress?.progress_percentage || 0,
        },
      },
    });
  } catch (error) {
    console.error("Erreur récupération contenu cours:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération du contenu du cours.",
    });
  }
};

// ================= GET LESSON (pour étudiants inscrits) =================
export const getLesson = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, lessonId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Utilisateur non authentifié",
      });
    }

    // Vérifier l'inscription
    const [enrollment]: any = await query(
      `SELECT id FROM course_enrollments 
       WHERE course_id = ? AND user_id = ? AND is_approved = 1`,
      [courseId, userId]
    );

    if (!enrollment) {
      return res.status(403).json({
        success: false,
        message: "Vous devez être inscrit à ce cours pour accéder à la leçon.",
      });
    }

    // Vérifier que la leçon appartient au cours
    const [lesson]: any = await query(
      `SELECT l.*, m.course_id
       FROM lessons l
       JOIN modules m ON l.module_id = m.id
       WHERE l.id = ? AND m.course_id = ? AND l.is_published = 1`,
      [lessonId, courseId]
    );

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "Leçon non trouvée ou n'appartient pas à ce cours.",
      });
    }

    // Récupérer la progression de la leçon
    const [progress]: any = await query(
      `SELECT is_completed, video_progress_seconds, video_duration_seconds, status
       FROM lesson_progress 
       WHERE user_id = ? AND lesson_id = ? AND course_id = ?`,
      [userId, lessonId, courseId]
    );

    // Récupérer la leçon précédente et suivante
    const [navigation]: any = await query(
      `SELECT 
        (SELECT l2.id FROM lessons l2 
         JOIN modules m2 ON l2.module_id = m2.id 
         WHERE m2.course_id = ? AND l2.order_index < l.order_index 
         AND l2.is_published = 1
         ORDER BY l2.order_index DESC LIMIT 1) as previous_lesson_id,
        (SELECT l3.id FROM lessons l3 
         JOIN modules m3 ON l3.module_id = m3.id 
         WHERE m3.course_id = ? AND l3.order_index > l.order_index 
         AND l3.is_published = 1
         ORDER BY l3.order_index ASC LIMIT 1) as next_lesson_id
       FROM lessons l
       JOIN modules m ON l.module_id = m.id
       WHERE l.id = ? AND m.course_id = ?`,
      [courseId, courseId, lessonId, courseId]
    );

    res.json({
      success: true,
      data: {
        ...lesson,
        progress: progress || {
          is_completed: 0,
          video_progress_seconds: 0,
          video_duration_seconds: 0,
          status: 'not_started'
        },
        navigation: navigation || {},
      },
    });
  } catch (error) {
    console.error("Erreur récupération leçon:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération de la leçon.",
    });
  }
};
// ================= GET COURSE BY ID ENHANCED (pour connectés) =================
export const getCourseByIdEnhanced = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user; // Ici l'utilisateur est forcément connecté

    // Convertir l'ID en nombre
    const courseId = Number(id);
    
    if (isNaN(courseId)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    // ================== 1. Infos de base du cours ==================
    const [course]: any = await query(
      `SELECT 
        c.id, c.title, c.description, c.short_description,
        c.thumbnail_url, c.video_preview_url, c.price, c.original_price,
        c.is_free, c.level, c.language, c.is_featured, c.is_published,
        c.rating, c.review_count, c.duration_hours, c.student_count,
        c.requirements, c.learning_outcomes, c.requires_approval,
        c.instructor_id, u.first_name, u.last_name, u.email as instructor_email,
        cat.id as category_id, cat.name as category_name, cat.slug as category_slug,
        c.created_at, c.updated_at, c.published_at
      FROM courses c
      LEFT JOIN users u ON c.instructor_id = u.id
      LEFT JOIN course_categories cat ON c.category_id = cat.id
      WHERE c.id = ?`,
      [courseId]
    );

    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: "Cours non trouvé" 
      });
    }

    let courseData: any = convertBigInt(course);

    // ================== 2. Vérifie inscription et approbation ==================
    let isEnrolled = false;
    let isApproved = false;
    let completion_percentage = 0;
    let enrollmentStatus = "not_enrolled";

    // Ici user existe toujours (car requireAuth)
    if (user) {
      const [enrollment]: any = await query(
        `SELECT is_approved, completion_percentage, payment_status 
         FROM course_enrollments 
         WHERE course_id = ? AND user_id = ?`,
        [courseId, user.id]
      );

      if (enrollment) {
        isEnrolled = true;
        isApproved = enrollment.is_approved === 1;
        completion_percentage = Number(enrollment.completion_percentage || 0);
        enrollmentStatus = enrollment.payment_status;
      }
    }

    courseData.isEnrolled = isEnrolled;
    courseData.isApproved = isApproved;
    courseData.enrollmentStatus = enrollmentStatus;

    // ================== 3. Modules (prévisualisation seulement) ==================
    // Pour les connectés, on montre les titres des modules sans les leçons
    const modules = await query(
      `SELECT m.id, m.title, m.description, m.order_index,
              COUNT(l.id) AS lesson_count,
              COALESCE(SUM(l.duration_minutes), 0) AS total_duration
       FROM modules m
       LEFT JOIN lessons l ON m.id = l.module_id AND l.is_published = 1
       WHERE m.course_id = ? AND m.is_published = 1
       GROUP BY m.id
       ORDER BY m.order_index ASC
       LIMIT 3`, // Limité à 3 modules pour la prévisualisation
      [courseId]
    );

    courseData.modules = convertBigInt(modules);
    courseData.completion_percentage = completion_percentage;

    // ================== 4. Réponse finale ==================
    res.json({ 
      success: true, 
      data: courseData,
      message: "Version enrichie pour utilisateur connecté"
    });
  } catch (error) {
    console.error("❌ [BACKEND ERROR getCourseByIdEnhanced] :", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération du cours"
    });
  }
};

// ================= EXPORT PAR DÉFAUT =================


export default {
  createCourse,
  getCourses,
  getCourseById,
  getCoursePublic,
  updateCourse,
  deleteCourse,
  getCourseStudents,
  getCourseFilters,
  getPopularCourses,
  getCoursePreview,
  enrollCourse,
  getEnrollmentStatus,
  getLessonById,
  updateLessonStatus,
  getLesson,
  getCourseContent,
  getModules,
  getModuleById,
  createModule,
  updateModule,
  deleteModule,
  getUserCourses,
  getCourseByIdEnhanced
};
