import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";

/* ============================================================
 *                    🧩 UTILITAIRES
 * ============================================================ */
const toNumber = (v: any) => (typeof v === "bigint" ? Number(v) : v);

/* ============================================================
 *                    👥 UTILISATEURS
 * ============================================================ */
export const getAllUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await query(`
      SELECT id, first_name, last_name, email, role, is_validated, created_at
      FROM users ORDER BY created_at DESC
    `);
    res.json({ success: true, data: users });
  } catch (err) {
    console.error("💥 getAllUsers error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const validateUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query("UPDATE users SET is_validated = 1 WHERE id = ?", [req.params.userId]);
    res.json({ success: true, message: "✅ Utilisateur validé" });
  } catch (err) {
    console.error("💥 validateUser error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const createUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { first_name, last_name, email, password, role } = req.body;
    if (!first_name || !last_name || !email || !password)
      return res.status(400).json({ success: false, message: "Champs requis manquants" });

    await query(
      `INSERT INTO users (first_name, last_name, email, password, role, is_validated)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [first_name, last_name, email, password, role || "student"]
    );

    res.json({ success: true, message: "✅ Utilisateur créé avec succès" });
  } catch (err) {
    console.error("💥 createUser error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const updateUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { first_name, last_name, role, is_validated } = req.body;
    await query(
      `UPDATE users SET first_name=?, last_name=?, role=?, is_validated=? WHERE id=?`,
      [first_name, last_name, role, is_validated, req.params.userId]
    );
    res.json({ success: true, message: "✅ Utilisateur mis à jour" });
  } catch (err) {
    console.error("💥 updateUser error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const deleteUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query("DELETE FROM users WHERE id = ?", [req.params.userId]);
    res.json({ success: true, message: "🗑️ Utilisateur supprimé" });
  } catch (err) {
    console.error("💥 deleteUser error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * 🔹 Changer le rôle / profil d’un utilisateur
 */
export const changeUserRole = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!["admin", "instructor", "student"].includes(role))
      return res.status(400).json({ success: false, message: "Rôle invalide" });

    await query(`UPDATE users SET role=?, updated_at=NOW() WHERE id=?`, [role, id]);

    res.json({ success: true, message: `✅ Rôle mis à jour : ${role}` });
  } catch (err) {
    console.error("💥 changeUserRole error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * 🔹 Mettre à jour le profil d’un utilisateur (nom, email, rôle, validation)
 */
export const updateUserAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, role, is_validated } = req.body;

    await query(
      `UPDATE users
       SET first_name=?, last_name=?, email=?, role=?, is_validated=?, updated_at=NOW()
       WHERE id=?`,
      [first_name, last_name, email, role, is_validated ? 1 : 0, id]
    );

    res.json({ success: true, message: "✅ Profil utilisateur mis à jour" });
  } catch (err) {
    console.error("💥 updateUserAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


/* ============================================================
 *                    🎓 COURS (BASIQUE)
 * ============================================================ */
export const getAllCourses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courses = await query(`
      SELECT c.id, c.title, c.is_published, c.created_at,
             CONCAT(u.first_name, ' ', u.last_name) AS instructor_name,
             COUNT(e.id) AS student_count
      FROM courses c
      LEFT JOIN users u ON u.id = c.instructor_id
      LEFT JOIN course_enrollments e ON e.course_id = c.id
      GROUP BY c.id, c.title, c.is_published, c.created_at, u.first_name, u.last_name
      ORDER BY c.created_at DESC
    `);
    const data = courses.map((c: any) => ({ ...c, student_count: Number(c.student_count || 0) }));
    res.json({ success: true, data });
  } catch (err) {
    console.error("💥 getAllCourses error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const createCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, description, instructor_id, is_published } = req.body;
    if (!title || !instructor_id)
      return res.status(400).json({ success: false, message: "Titre et instructeur requis" });

    await query(
      `INSERT INTO courses (title, description, instructor_id, is_published)
       VALUES (?, ?, ?, ?)`,
      [title, description || "", instructor_id, is_published ? 1 : 0]
    );

    res.json({ success: true, message: "✅ Cours créé" });
  } catch (err) {
    console.error("💥 createCourse error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const updateCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, description, is_published } = req.body;
    await query(
      `UPDATE courses SET title=?, description=?, is_published=? WHERE id=?`,
      [title, description, is_published ? 1 : 0, req.params.courseId]
    );
    res.json({ success: true, message: "✅ Cours mis à jour" });
  } catch (err) {
    console.error("💥 updateCourse error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const deleteCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query("DELETE FROM courses WHERE id = ?", [req.params.courseId]);
    res.json({ success: true, message: "🗑️ Cours supprimé" });
  } catch (err) {
    console.error("💥 deleteCourse error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *                    🧾 INSCRIPTIONS
 * ============================================================ */
export const getAllEnrollments = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const enrollments = await query(`
      SELECT e.id, e.enrolled_at, e.completion_percentage,
             CONCAT(u.first_name, ' ', u.last_name) AS student_name,
             c.title AS course_title
      FROM course_enrollments e
      JOIN users u ON u.id = e.user_id
      JOIN courses c ON c.id = e.course_id
      ORDER BY e.enrolled_at DESC
    `);
    res.json({ success: true, data: enrollments });
  } catch (err) {
    console.error("💥 getAllEnrollments error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const addEnrollment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { user_id, course_id } = req.body;
    if (!user_id || !course_id)
      return res.status(400).json({ success: false, message: "Champs requis manquants" });

    await query(
      `INSERT INTO course_enrollments (user_id, course_id, enrolled_at, completion_percentage)
       VALUES (?, ?, NOW(), 0)`,
      [user_id, course_id]
    );
    res.json({ success: true, message: "✅ Inscription ajoutée" });
  } catch (err) {
    console.error("💥 addEnrollment error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const deleteEnrollment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query("DELETE FROM course_enrollments WHERE id = ?", [req.params.enrollmentId]);
    res.json({ success: true, message: "🗑️ Inscription supprimée" });
  } catch (err) {
    console.error("💥 deleteEnrollment error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *                    📊 STATISTIQUES
 * ============================================================ */
export const getGlobalStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const usersCount = await query("SELECT COUNT(*) AS total FROM users");
    const coursesCount = await query("SELECT COUNT(*) AS total FROM courses");
    const enrollmentsCount = await query("SELECT COUNT(*) AS total FROM course_enrollments");
    const avgCompletion = await query(
      "SELECT ROUND(AVG(completion_percentage),1) AS avg_completion FROM course_enrollments"
    );

    res.json({
      success: true,
      data: {
        users: toNumber(usersCount[0]?.total) || 0,
        courses: toNumber(coursesCount[0]?.total) || 0,
        enrollments: toNumber(enrollmentsCount[0]?.total) || 0,
        avgCompletion: parseFloat(avgCompletion[0]?.avg_completion || "0"),
      },
    });
  } catch (err) {
    console.error("💥 getGlobalStats error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const getCourseStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stats = await query(`
      SELECT c.title, COUNT(e.id) AS student_count
      FROM courses c
      LEFT JOIN course_enrollments e ON c.id = e.course_id
      GROUP BY c.id ORDER BY student_count DESC
    `);
    res.json({
      success: true,
      data: stats.map((s: any) => ({ ...s, student_count: Number(s.student_count || 0) })),
    });
  } catch (err) {
    console.error("💥 getCourseStats error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *                    🧠 ADMIN AVANCÉ
 * ============================================================ */
export const getAllCoursesAdmin = async (req: Request, res: Response) => {
  try {
    const courses = await query(`
      SELECT c.*, u.first_name, u.last_name, cat.name AS category_name
      FROM courses c
      LEFT JOIN users u ON c.instructor_id = u.id
      LEFT JOIN course_categories cat ON c.category_id = cat.id
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, data: courses });
  } catch (err) {
    console.error("💥 getAllCoursesAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *                    🧠 ADMIN AVANCÉ (version corrigée)
 * ============================================================ */
export const createCourseAdmin = async (req: Request, res: Response) => {
  try {
    const {
      title,
      slug,
      description,
      short_description,
      instructor_id,
      category_id,
      price,
      original_price,
      duration_hours,
      level,
      language,
      thumbnail_url,
      video_preview_url,
      is_published,
      is_featured,
      is_free,
      requirements,
      learning_outcomes,
      requires_approval,
    } = req.body;

    if (!title || !instructor_id)
      return res
        .status(400)
        .json({ success: false, message: "Titre et instructeur sont requis." });

    await query(
      `INSERT INTO courses 
        (title, slug, description, short_description, instructor_id, category_id, 
         price, original_price, duration_hours, level, language, thumbnail_url, 
         video_preview_url, is_published, is_featured, is_free, 
         requirements, learning_outcomes, requires_approval, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        title,
        slug || title.toLowerCase().replace(/\s+/g, "-"),
        description || "",
        short_description || "",
        instructor_id,
        category_id || null,
        price || 0,
        original_price || null,
        duration_hours || null,
        level || "beginner",
        language || "fr",
        thumbnail_url || null,
        video_preview_url || null,
        is_published ? 1 : 0,
        is_featured ? 1 : 0,
        is_free ? 1 : 0,
        requirements || null,
        learning_outcomes || null,
        requires_approval ? 1 : 0,
      ]
    );

    res.json({ success: true, message: "✅ Cours créé avec succès (admin)" });
  } catch (err) {
    console.error("💥 createCourseAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur lors de la création du cours" });
  }
};

export const updateCourseAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      title,
      slug,
      description,
      short_description,
      instructor_id,
      category_id,
      price,
      original_price,
      duration_hours,
      level,
      language,
      thumbnail_url,
      video_preview_url,
      is_published,
      is_featured,
      is_free,
      requirements,
      learning_outcomes,
      requires_approval,
    } = req.body;

    await query(
      `UPDATE courses 
       SET title=?, slug=?, description=?, short_description=?, instructor_id=?, 
           category_id=?, price=?, original_price=?, duration_hours=?, level=?, 
           language=?, thumbnail_url=?, video_preview_url=?, is_published=?, 
           is_featured=?, is_free=?, requirements=?, learning_outcomes=?, 
           requires_approval=?, updated_at=NOW()
       WHERE id=?`,
      [
        title || null,
        slug || title?.toLowerCase().replace(/\s+/g, "-") || null,
        description || null,
        short_description || null,
        instructor_id || null,
        category_id || null, // ✅ évite erreur de contrainte FK
        price || 0,
        original_price || null,
        duration_hours || null,
        level || "beginner",
        language || "fr",
        thumbnail_url || null,
        video_preview_url || null,
        is_published ? 1 : 0,
        is_featured ? 1 : 0,
        is_free ? 1 : 0,
        requirements || null,
        learning_outcomes || null,
        requires_approval ? 1 : 0,
        id,
      ]
    );

    res.json({ success: true, message: "✅ Cours mis à jour avec succès (admin)" });
  } catch (err) {
    console.error("💥 updateCourseAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur lors de la mise à jour du cours" });
  }
};


export const deleteCourseAdmin = async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM courses WHERE id=?", [req.params.id]);
    res.json({ success: true, message: "🗑️ Cours supprimé (admin)" });
  } catch (err) {
    console.error("💥 deleteCourseAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const publishCourseAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { is_published } = req.body;
    await query("UPDATE courses SET is_published=?, updated_at=NOW() WHERE id=?", [
      is_published ? 1 : 0,
      id,
    ]);
    res.json({
      success: true,
      message: is_published ? "✅ Cours publié" : "🚫 Cours dépublié",
    });
  } catch (err) {
    console.error("💥 publishCourseAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const getCourseStudentsAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const students = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, ce.completion_percentage, ce.enrolled_at
       FROM course_enrollments ce
       JOIN users u ON ce.user_id = u.id
       WHERE ce.course_id = ?
       ORDER BY ce.enrolled_at DESC`,
      [id]
    );
    res.json({ success: true, data: students });
  } catch (err) {
    console.error("💥 getCourseStudentsAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 * 🔍  Détail d’un cours (Admin)
 * =============================
 */
export const getCourseByIdAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // 📘 Récupération des infos principales du cours
    const [course] = await query(
      `SELECT c.*, 
              CONCAT(u.first_name, ' ', u.last_name) AS instructor_name,
              cat.name AS category_name
       FROM courses c
       LEFT JOIN users u ON c.instructor_id = u.id
       LEFT JOIN course_categories cat ON c.category_id = cat.id
       WHERE c.id = ?`,
      [id]
    );

    if (!course)
      return res.status(404).json({ success: false, message: "Cours introuvable" });

    // 📚 Récupération des modules et leçons liés à ce cours
    const modules = await query(
      `SELECT m.id, m.title, COUNT(l.id) AS lessons_count
       FROM course_modules m
       LEFT JOIN lessons l ON l.module_id = m.id
       WHERE m.course_id = ?
       GROUP BY m.id, m.title
       ORDER BY m.created_at ASC`,
      [id]
    );

    // 🎓 Récupération des étudiants inscrits
    const students = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, ce.completion_percentage
       FROM course_enrollments ce
       JOIN users u ON u.id = ce.user_id
       WHERE ce.course_id = ?
       ORDER BY ce.enrolled_at DESC`,
      [id]
    );

    return res.json({
      success: true,
      data: {
        ...course,
        modules,
        students,
      },
    });
  } catch (err) {
    console.error("💥 getCourseByIdAdmin error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


/* ============================================================
 *                    📚 LEÇONS ET RESSOURCES
 * ============================================================ */
export const getLessonsByModule = async (req: Request, res: Response) => {
  try {
    const { moduleId } = req.params;
    const lessons = await query(
      `SELECT l.*, COUNT(r.id) AS resource_count
       FROM lessons l
       LEFT JOIN lesson_resources r ON r.lesson_id = l.id
       WHERE l.module_id = ?
       GROUP BY l.id
       ORDER BY l.order_index ASC`,
      [moduleId]
    );
    res.json({ success: true, data: lessons });
  } catch (err) {
    console.error("💥 getLessonsByModule error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const createLesson = async (req: Request, res: Response) => {
  try {
    const { module_id, title, content_type, content_url, duration_minutes, order_index } = req.body;
    if (!module_id || !title)
      return res.status(400).json({ success: false, message: "Champs requis manquants" });

    await query(
      `INSERT INTO lessons (module_id, title, content_type, content_url, duration_minutes, order_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [module_id, title, content_type || "video", content_url || "", duration_minutes || 0, order_index || 0]
    );
    res.json({ success: true, message: "✅ Leçon créée" });
  } catch (err) {
    console.error("💥 createLesson error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const addLessonResource = async (req: Request, res: Response) => {
  try {
    const { lesson_id, title, file_url, file_type, file_size } = req.body;
    await query(
      `INSERT INTO lesson_resources (lesson_id, title, file_url, file_type, file_size, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [lesson_id, title, file_url, file_type, file_size]
    );
    res.json({ success: true, message: "📎 Ressource ajoutée" });
  } catch (err) {
    console.error("💥 addLessonResource error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


/* ============================================================
 *                    🧱 MODULES DE COURS
 * ============================================================ */
export const getModulesByCourse = async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;
    const modules = await query(
      `SELECT m.*, COUNT(l.id) AS lesson_count
       FROM course_modules m
       LEFT JOIN lessons l ON l.module_id = m.id
       WHERE m.course_id = ?
       GROUP BY m.id
       ORDER BY m.order_index ASC`,
      [courseId]
    );
    res.json({ success: true, data: modules });
  } catch (err) {
    console.error("💥 getModulesByCourse error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const createModule = async (req: Request, res: Response) => {
  try {
    const { course_id, title, description, order_index } = req.body;
    if (!course_id || !title)
      return res.status(400).json({ success: false, message: "Champs requis manquants" });

    await query(
      `INSERT INTO course_modules (course_id, title, description, order_index, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [course_id, title, description || "", order_index || 0]
    );
    res.json({ success: true, message: "✅ Module ajouté" });
  } catch (err) {
    console.error("💥 createModule error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const updateModule = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, order_index } = req.body;
    await query(
      `UPDATE course_modules SET title=?, description=?, order_index=?, updated_at=NOW() WHERE id=?`,
      [title, description, order_index || 0, id]
    );
    res.json({ success: true, message: "✅ Module mis à jour" });
  } catch (err) {
    console.error("💥 updateModule error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const deleteModule = async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM course_modules WHERE id=?", [req.params.id]);
    res.json({ success: true, message: "🗑️ Module supprimé" });
  } catch (err) {
    console.error("💥 deleteModule error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};



/* ============================================================
 *                    🏷️ CATÉGORIES DE COURS
 * ============================================================ */
export const getAllCategories = async (req: Request, res: Response) => {
  try {
    const categories = await query("SELECT * FROM course_categories ORDER BY order_index ASC");
    res.json({ success: true, data: categories });
  } catch (err) {
    console.error("💥 getAllCategories error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const createCategory = async (req: Request, res: Response) => {
  try {
    const { name, slug, description, color, icon } = req.body;
    if (!name)
      return res.status(400).json({ success: false, message: "Le nom est requis" });

    await query(
      `INSERT INTO course_categories (name, slug, description, color, icon, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW())`,
      [name, slug || name.toLowerCase().replace(/\s+/g, "-"), description || "", color || "#3B82F6", icon || null]
    );

    res.json({ success: true, message: "✅ Catégorie créée" });
  } catch (err) {
    console.error("💥 createCategory error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const updateCategory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, color, icon, is_active } = req.body;

    await query(
      `UPDATE course_categories SET name=?, description=?, color=?, icon=?, is_active=?, updated_at=NOW() WHERE id=?`,
      [name, description, color, icon, is_active ? 1 : 0, id]
    );

    res.json({ success: true, message: "✅ Catégorie mise à jour" });
  } catch (err) {
    console.error("💥 updateCategory error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM course_categories WHERE id=?", [req.params.id]);
    res.json({ success: true, message: "🗑️ Catégorie supprimée" });
  } catch (err) {
    console.error("💥 deleteCategory error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


/* ============================================================
 *                    👨‍🏫 INSTRUCTEURS (ADMIN)
 * ============================================================ */
export const getAllInstructors = async (req: Request, res: Response) => {
  try {
    const instructors = await query(`
      SELECT id, first_name, last_name, email, bio, avatar_url, is_validated, created_at
      FROM users
      WHERE role = 'instructor'
      ORDER BY created_at DESC
    `);
    res.json({ success: true, data: instructors });
  } catch (err) {
    console.error("💥 getAllInstructors error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const createInstructor = async (req: Request, res: Response) => {
  try {
    const { first_name, last_name, email, password, bio, avatar_url } = req.body;
    if (!first_name || !last_name || !email || !password)
      return res.status(400).json({ success: false, message: "Champs requis manquants" });

    await query(
      `INSERT INTO users (first_name, last_name, email, password, role, bio, avatar_url, is_validated, created_at)
       VALUES (?, ?, ?, ?, 'instructor', ?, ?, 1, NOW())`,
      [first_name, last_name, email, password, bio || "", avatar_url || null]
    );

    res.json({ success: true, message: "✅ Instructeur créé avec succès" });
  } catch (err) {
    console.error("💥 createInstructor error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const updateInstructor = async (req: Request, res: Response) => {
  try {
    const { first_name, last_name, bio, avatar_url, is_validated } = req.body;
    await query(
      `UPDATE users SET first_name=?, last_name=?, bio=?, avatar_url=?, is_validated=?, updated_at=NOW() 
       WHERE id=? AND role='instructor'`,
      [first_name, last_name, bio, avatar_url, is_validated ? 1 : 0, req.params.id]
    );
    res.json({ success: true, message: "✅ Instructeur mis à jour" });
  } catch (err) {
    console.error("💥 updateInstructor error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const deleteInstructor = async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM users WHERE id=? AND role='instructor'", [req.params.id]);
    res.json({ success: true, message: "🗑️ Instructeur supprimé" });
  } catch (err) {
    console.error("💥 deleteInstructor error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


/* ============================================================
 *                    🧍 PROFIL UTILISATEUR (ADMIN)
 * ============================================================ */
export const getUserProfileAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // 🔹 Infos principales
    const [user] = await query(`
      SELECT id, first_name, last_name, email, role, bio, avatar_url, is_validated, created_at
      FROM users WHERE id = ?`, [id]);

    if (!user)
      return res.status(404).json({ success: false, message: "Utilisateur introuvable" });

    // 🔹 Cours enseignés (si instructeur)
    const teachingCourses = await query(`
      SELECT id, title, is_published, created_at
      FROM courses WHERE instructor_id = ? ORDER BY created_at DESC
    `, [id]);

    // 🔹 Cours suivis (si étudiant)
    const enrolledCourses = await query(`
      SELECT c.id, c.title, ce.completion_percentage, ce.enrolled_at
      FROM course_enrollments ce
      JOIN courses c ON c.id = ce.course_id
      WHERE ce.user_id = ? ORDER BY ce.enrolled_at DESC
    `, [id]);

    // 🔹 Statistiques de progression
    const [progressStats] = await query(`
      SELECT 
        COUNT(*) AS total_enrollments,
        ROUND(AVG(ce.completion_percentage),1) AS avg_completion
      FROM course_enrollments ce WHERE ce.user_id = ?
    `, [id]);

    return res.json({
      success: true,
      data: {
        user,
        teachingCourses,
        enrolledCourses,
        stats: progressStats || { total_enrollments: 0, avg_completion: 0 }
      }
    });
  } catch (err) {
    console.error("💥 getUserProfileAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 * 👤 Profil d’un utilisateur (Admin)
 * =============================
 */
export const getUserByIdAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Vérifie si l'utilisateur existe
    const [user] = await query(
      `SELECT id, first_name, last_name, email, role, is_validated, created_at
       FROM users WHERE id = ?`,
      [id]
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "Utilisateur introuvable" });
    }

    // 📚 Cours suivis par cet utilisateur
    const enrolledCourses = await query(
      `SELECT c.id, c.title, ce.completion_percentage
       FROM course_enrollments ce
       JOIN courses c ON c.id = ce.course_id
       WHERE ce.user_id = ?`,
      [id]
    );

    // 🎓 Cours enseignés (si instructeur)
    const taughtCourses = await query(
      `SELECT id, title, is_published
       FROM courses
       WHERE instructor_id = ?`,
      [id]
    );

    return res.json({
      success: true,
      data: {
        ...user,
        enrolled_courses: enrolledCourses,
        taught_courses: taughtCourses,
      },
    });
  } catch (err) {
    console.error("💥 getUserByIdAdmin error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};
