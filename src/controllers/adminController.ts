import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";

/* ============================================================
 *                    🧩 UTILITAIRES
 * ============================================================ */
const toNumber = (v: any) => (typeof v === "bigint" ? Number(v) : v);

/**
 * Convertit recursivement tous les BigInt en Number.
 * Necessaire car MariaDB retourne COUNT() / BIGINT en BigInt JS
 * incompatible avec JSON.stringify (Express res.json).
 */
const sanitizeBigInt = (data: any): any => {
  if (Array.isArray(data)) return data.map(sanitizeBigInt);
  if (data !== null && typeof data === "object") {
    const out: any = {};
    for (const k of Object.keys(data)) {
      out[k] = typeof data[k] === "bigint"
        ? Number(data[k])
        : sanitizeBigInt(data[k]);
    }
    return out;
  }
  return typeof data === "bigint" ? Number(data) : data;
};

/* ============================================================
 *                    👥 UTILISATEURS
 * ============================================================ */
export const getAllUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await query(`
      SELECT id, first_name, last_name, email, role, created_at
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
    await query("UPDATE users SET is_active = 1 WHERE id = ?", [req.params.userId]);
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
      `INSERT INTO users (first_name, last_name, email, password_hash, role, is_active, email_verified)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
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
      `UPDATE users SET first_name=?, last_name=?, role=?, is_active=? WHERE id=?`,
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
       SET first_name=?, last_name=?, email=?, role=?, is_active=?, updated_at=NOW()
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
      SELECT c.*,
             u.first_name, u.last_name,
             CONCAT(u.first_name, ' ', u.last_name) AS instructor_name,
             cat.name AS category_name
      FROM courses c
      LEFT JOIN users u ON c.instructor_id = u.id
      LEFT JOIN course_categories cat ON c.category_id = cat.id
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, data: sanitizeBigInt(courses) });
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
      title, slug, description, short_description,
      instructor_id, category_id, price, original_price, duration_hours,
      level, language, thumbnail_url, video_preview_url,
      is_published, is_featured, is_free, requirements, learning_outcomes,
      requires_approval, is_subscription_included, is_forum_enabled,
      sequential_mode, instructor_commission_rate,
    } = req.body;

    if (!instructor_id) {
      return res.status(400).json({ success: false, message: "instructor_id est requis" });
    }

    // ✅ requirements et learning_outcomes — éviter le double-encodage
    const toJsonField = (val: any): string | null => {
      if (!val) return null;
      if (Array.isArray(val)) {
        // Tableaux simples de strings → encoder une seule fois
        return JSON.stringify(val.filter((v: any) => typeof v === "string" && v.trim()));
      }
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (!trimmed) return null;
        // Si c'est déjà du JSON valide (commence par [ ou {), le valider d'abord
        if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(trimmed);
            // S'assurer que le contenu est un tableau de strings simples
            if (Array.isArray(parsed)) {
              const flattened = flattenStringArray(parsed);
              return JSON.stringify(flattened);
            }
            return trimmed; // Déjà valide
          } catch {
            // Pas du JSON → traiter comme texte brut
          }
        }
        // Texte brut avec sauts de ligne
        return JSON.stringify(trimmed.split("\n").filter((s: string) => s.trim()));
      }
      return null;
    };

    // Aplatir un tableau potentiellement imbriqué de strings
    const flattenStringArray = (arr: any[]): string[] => {
      const result: string[] = [];
      for (const item of arr) {
        if (typeof item === "string") {
          if (item.startsWith("[") || item.startsWith("{")) {
            try { result.push(...flattenStringArray(JSON.parse(item))); continue; } catch {}
          }
          result.push(item);
        } else if (Array.isArray(item)) {
          result.push(...flattenStringArray(item));
        }
      }
      return result;
    };

    const reqJson = toJsonField(requirements);
    const loJson  = toJsonField(learning_outcomes);

    const autoSlug = (title || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

    await query(
      `UPDATE courses
       SET title=?, slug=?, description=?, short_description=?,
           instructor_id=?, category_id=?, price=?, original_price=?,
           duration_hours=?, level=?, language=?, thumbnail_url=?,
           video_preview_url=?, is_published=?, is_featured=?, is_free=?,
           requirements=?, learning_outcomes=?, requires_approval=?,
           is_subscription_included=?, is_forum_enabled=?, sequential_mode=?,
           instructor_commission_rate=?, updated_at=NOW()
       WHERE id=?`,
      [
        title || null,
        slug || autoSlug || null,
        description || null,
        short_description || null,
        instructor_id,
        category_id || null,
        Number(price) || 0,
        original_price ? Number(original_price) : null,
        duration_hours ? Number(duration_hours) : null,
        level || "beginner",
        language || "fr",
        thumbnail_url || null,
        video_preview_url || null,
        is_published ? 1 : 0,
        is_featured ? 1 : 0,
        is_free ? 1 : 0,
        reqJson,
        loJson,
        requires_approval ? 1 : 0,
        is_subscription_included ? 1 : 0,
        is_forum_enabled !== false ? 1 : 0,
        sequential_mode ? 1 : 0,
        instructor_commission_rate ? Number(instructor_commission_rate) : null,
        id,
      ]
    );

    res.json({ success: true, message: "✅ Cours mis à jour avec succès" });
  } catch (err) {
    console.error("💥 updateCourseAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur mise à jour: " + (err as any)?.message });
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
       FROM modules m
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
      data: sanitizeBigInt({ ...course, modules, students }),
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
    res.json({ success: true, data: sanitizeBigInt(lessons) });
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
       FROM modules m
       LEFT JOIN lessons l ON l.module_id = m.id
       WHERE m.course_id = ?
       GROUP BY m.id
       ORDER BY m.order_index ASC`,
      [courseId]
    );
    res.json({ success: true, data: sanitizeBigInt(modules) });
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
      `INSERT INTO modules (course_id, title, description, order_index, created_at)
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
      `UPDATE modules SET title=?, description=?, order_index=?, updated_at=NOW() WHERE id=?`,
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
    await query("DELETE FROM modules WHERE id=?", [req.params.id]);
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
    // ✅ Uniquement les colonnes qui existent dans la table users
    const instructors = await query(`
      SELECT id, first_name, last_name, email, role, is_active, created_at
      FROM users
      WHERE role IN ('instructor', 'admin')
        AND is_active = 1
      ORDER BY role ASC, first_name ASC
    `);
    res.json({ success: true, data: sanitizeBigInt(instructors) });
  } catch (err) {
    console.error("💥 getAllInstructors error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const createInstructor = async (req: Request, res: Response) => {
  try {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password)
      return res.status(400).json({ success: false, message: "Champs requis manquants" });

    // ✅ Utiliser password_hash (vrai nom de colonne dans users)
    const bcrypt = require("bcryptjs");
    const hash = await bcrypt.hash(password, 10);

    await query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role, is_active, email_verified, created_at)
       VALUES (?, ?, ?, ?, 'instructor', 1, 1, NOW())`,
      [first_name, last_name, email, hash]
    );

    res.json({ success: true, message: "✅ Instructeur créé avec succès" });
  } catch (err) {
    console.error("💥 createInstructor error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const updateInstructor = async (req: Request, res: Response) => {
  try {
    const { first_name, last_name, is_active } = req.body;
    await query(
      `UPDATE users SET first_name=?, last_name=?, is_active=?, updated_at=NOW()
       WHERE id=? AND role IN ('instructor','admin')`,
      [first_name, last_name, is_active ? 1 : 0, req.params.id]
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
      SELECT id, first_name, last_name, email, role, is_active, created_at
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
      `SELECT id, first_name, last_name, email, role, created_at
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

/* ============================================================
 *           ✏️  UPDATE / DELETE LEÇON (admin)
 * ============================================================ */
export const updateLesson = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, content_type, content_url, article_content, duration_minutes, order_index, is_published, is_preview } = req.body;
    await query(
      `UPDATE lessons SET
         title=?, content_type=?, content_url=?, article_content=?,
         duration_minutes=?, order_index=?, is_published=?, is_preview=?,
         updated_at=NOW()
       WHERE id=?`,
      [
        title, content_type || "video", content_url || null,
        article_content || null, duration_minutes || 0,
        order_index || 0, is_published ? 1 : 0, is_preview ? 1 : 0, id
      ]
    );
    res.json({ success: true, message: "✅ Leçon mise à jour" });
  } catch (err) {
    console.error("💥 updateLesson error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const deleteLesson = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await query("DELETE FROM lesson_progress WHERE lesson_id = ?", [id]);
    await query("DELETE FROM lesson_resources WHERE lesson_id = ?", [id]);
    await query("DELETE FROM lessons WHERE id = ?", [id]);
    res.json({ success: true, message: "🗑️ Leçon supprimée" });
  } catch (err) {
    console.error("💥 deleteLesson error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *    📎 RESSOURCES DE LEÇONS (GET + UPDATE + DELETE)
 * ============================================================ */
export const getLessonResources = async (req: Request, res: Response) => {
  try {
    const { lessonId } = req.params;
    const resources = await query(
      `SELECT * FROM lesson_resources WHERE lesson_id = ? ORDER BY order_index ASC, created_at ASC`,
      [lessonId]
    );
    res.json({ success: true, data: resources });
  } catch (err) {
    console.error("💥 getLessonResources error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const updateLessonResource = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, file_url, file_type, file_size, order_index } = req.body;
    await query(
      `UPDATE lesson_resources SET title=?, file_url=?, file_type=?, file_size=?, order_index=? WHERE id=?`,
      [title, file_url, file_type || null, file_size || null, order_index || 0, id]
    );
    res.json({ success: true, message: "✅ Ressource mise à jour" });
  } catch (err) {
    console.error("💥 updateLessonResource error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const deleteLessonResource = async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM lesson_resources WHERE id=?", [req.params.id]);
    res.json({ success: true, message: "🗑️ Ressource supprimée" });
  } catch (err) {
    console.error("💥 deleteLessonResource error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *    🔄 UPDATE MODULE — champs complets (is_published inclus)
 * ============================================================ */
export const updateModuleFull = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, order_index, is_published } = req.body;
    await query(
      `UPDATE modules SET title=?, description=?, order_index=?, is_published=?, updated_at=NOW() WHERE id=?`,
      [title, description || "", order_index || 0, is_published ? 1 : 0, id]
    );
    res.json({ success: true, message: "✅ Module mis à jour" });
  } catch (err) {
    console.error("💥 updateModuleFull error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *    📚 CREER LEÇON — champs complets avec slug auto
 * ============================================================ */
export const createLessonFull = async (req: Request, res: Response) => {
  try {
    const {
      module_id, title, content_type, content_url, article_content,
      duration_minutes, order_index, is_published, is_preview,
      requires_completion, is_downloadable
    } = req.body;

    if (!module_id || !title)
      return res.status(400).json({ success: false, message: "module_id et title requis" });

    // Auto-générer un slug unique
    const slug = title
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) + "-" + Date.now();

    await query(
      `INSERT INTO lessons
         (module_id, title, slug, content_type, content_url, article_content,
          duration_minutes, order_index, is_published, is_preview,
          requires_completion, is_downloadable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        module_id, title, slug,
        content_type || "video", content_url || null, article_content || null,
        duration_minutes || 0, order_index || 0,
        is_published !== false ? 1 : 0,
        is_preview ? 1 : 0,
        requires_completion !== false ? 1 : 0,
        is_downloadable ? 1 : 0,
      ]
    );
    res.json({ success: true, message: "✅ Leçon créée" });
  } catch (err) {
    console.error("💥 createLessonFull error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *    ✏️ UPDATE LEÇON — champs complets
 * ============================================================ */
export const updateLessonFull = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      title, content_type, content_url, article_content,
      duration_minutes, order_index, is_published, is_preview,
      requires_completion, is_downloadable
    } = req.body;
    await query(
      `UPDATE lessons SET
         title=?, content_type=?, content_url=?, article_content=?,
         duration_minutes=?, order_index=?, is_published=?, is_preview=?,
         requires_completion=?, is_downloadable=?, updated_at=NOW()
       WHERE id=?`,
      [
        title, content_type || "video", content_url || null, article_content || null,
        duration_minutes || 0, order_index || 0,
        is_published !== false ? 1 : 0,
        is_preview ? 1 : 0,
        requires_completion !== false ? 1 : 0,
        is_downloadable ? 1 : 0,
        id
      ]
    );
    res.json({ success: true, message: "✅ Leçon mise à jour" });
  } catch (err) {
    console.error("💥 updateLessonFull error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/* ============================================================
 *   📤 UPLOAD FICHIERS (Multer — vidéos, PDFs, ressources)
 * ============================================================ */
import multer from "multer";
import path from "path";
import fs from "fs";

const createUploadDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

// Storage vidéos leçons
const videoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = "uploads/lessons/videos";
    createUploadDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext)
      .toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40);
    cb(null, `${name}-${Date.now()}${ext}`);
  },
});

// Storage ressources (PDFs, slides, ZIP…)
const resourceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = "uploads/lessons/resources";
    createUploadDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext)
      .toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40);
    cb(null, `${name}-${Date.now()}${ext}`);
  },
});

// Storage thumbnails cours
const thumbStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = "uploads/courses/thumbnails";
    createUploadDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    cb(null, `thumb-${Date.now()}${ext}`);
  },
});

export const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 Go
  fileFilter: (_req, file, cb) => {
    const ok = /^video\//i.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error("Seuls les fichiers vidéo sont acceptés"));
  },
});

export const uploadResource = multer({
  storage: resourceStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 Mo
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/zip","application/x-zip-compressed",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain","text/markdown",
      "application/json",
      "image/jpeg","image/png","image/gif","image/webp","image/svg+xml",
    ];
    const ok = allowed.includes(file.mimetype) || /^video\//.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error(`Type non supporté: ${file.mimetype}`));
  },
});

export const uploadThumb = multer({
  storage: thumbStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo
  fileFilter: (_req, file, cb) => {
    const ok = /^image\//i.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error("Image requise"));
  },
});

/* ─── Uploader une vidéo pour une leçon ─── */
export const uploadLessonVideo = async (req: Request, res: Response) => {
  try {
    const { lessonId } = req.params;
    if (!req.file) return res.status(400).json({ success:false, message:"Aucun fichier reçu" });

    const baseUrl   = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    const fileUrl   = `${baseUrl}/uploads/lessons/videos/${req.file.filename}`;
    const fileSize  = req.file.size;

    // Mettre à jour content_url de la leçon
    await query(
      `UPDATE lessons SET content_url=?, content_type='video', updated_at=NOW() WHERE id=?`,
      [fileUrl, lessonId]
    );

    res.json({
      success: true,
      message: "✅ Vidéo uploadée et associée à la leçon",
      data: {
        file_url:      fileUrl,
        filename:      req.file.filename,
        original_name: req.file.originalname,
        size_bytes:    fileSize,
        size_mb:       (fileSize / 1024 / 1024).toFixed(2),
      },
    });
  } catch (err) {
    console.error("💥 uploadLessonVideo error:", err);
    res.status(500).json({ success:false, message:"Erreur serveur" });
  }
};

/* ─── Uploader un fichier comme ressource de leçon ─── */
export const uploadLessonResource = async (req: Request, res: Response) => {
  try {
    const { lessonId } = req.params;
    if (!req.file) return res.status(400).json({ success:false, message:"Aucun fichier reçu" });

    const baseUrl  = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    const fileUrl  = `${baseUrl}/uploads/lessons/resources/${req.file.filename}`;
    const fileSize = req.file.size;
    const fileType = path.extname(req.file.originalname).slice(1).toLowerCase();
    const title    = (req.body.title || req.file.originalname).slice(0, 255);

    await query(
      `INSERT INTO lesson_resources (lesson_id, title, file_url, file_type, file_size, order_index, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NOW())`,
      [lessonId, title, fileUrl, fileType, fileSize]
    );

    res.json({
      success: true,
      message: "✅ Ressource ajoutée",
      data: { file_url:fileUrl, file_type:fileType, size_mb:(fileSize/1024/1024).toFixed(2) },
    });
  } catch (err) {
    console.error("💥 uploadLessonResource error:", err);
    res.status(500).json({ success:false, message:"Erreur serveur" });
  }
};

/* ─── Uploader une miniature de cours ─── */
export const uploadCourseThumbnail = async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;
    if (!req.file) return res.status(400).json({ success:false, message:"Aucune image reçue" });

    const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    const fileUrl = `${baseUrl}/uploads/courses/thumbnails/${req.file.filename}`;

    await query(`UPDATE courses SET thumbnail_url=?, updated_at=NOW() WHERE id=?`, [fileUrl, courseId]);

    res.json({ success:true, message:"✅ Miniature mise à jour", data:{ file_url:fileUrl } });
  } catch (err) {
    console.error("💥 uploadCourseThumbnail error:", err);
    res.status(500).json({ success:false, message:"Erreur serveur" });
  }
};

/* ─── Publier / Dépublier un MODULE ─── */
export const toggleModulePublish = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { is_published } = req.body;

    // 1. Mettre à jour le module
    await query(`UPDATE modules SET is_published=?, updated_at=NOW() WHERE id=?`, [is_published ? 1 : 0, id]);

    // 2. Récupérer le course_id du module
    const [mod]: any[] = await query(`SELECT course_id FROM modules WHERE id=?`, [id]);
    if (mod) {
      // 3. Recalculer la progression de tous les étudiants inscrits
      const enrollments: any[] = await query(
        `SELECT DISTINCT user_id FROM course_enrollments WHERE course_id=?`, [mod.course_id]
      );
      for (const { user_id } of enrollments) {
        const [prog]: any = await query(`
          SELECT ROUND(
            COUNT(DISTINCT CASE WHEN lp.is_completed = 1 THEN lp.lesson_id END) * 100.0
            / NULLIF(COUNT(DISTINCT l.id), 0), 2) AS pct
          FROM lessons l
          JOIN modules m ON l.module_id = m.id
          LEFT JOIN lesson_progress lp ON l.id = lp.lesson_id AND lp.user_id = ? AND lp.course_id = ?
          WHERE m.course_id = ? AND l.is_published = 1 AND m.is_published = 1
        `, [user_id, mod.course_id, mod.course_id]);
        await query(
          `UPDATE course_enrollments SET completion_percentage=? WHERE user_id=? AND course_id=?`,
          [prog?.pct || 0, user_id, mod.course_id]
        );
      }
    }

    res.json({ success: true, message: is_published ? "✅ Module publié" : "📦 Module dépublié" });
  } catch (err) {
    console.error("💥 toggleModulePublish error:", err);
    res.status(500).json({ success:false, message:"Erreur serveur" });
  }
};

/* ─── Publier / Dépublier une LEÇON ─── */
export const toggleLessonPublish = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { is_published } = req.body;

    // 1. Mettre à jour la leçon
    await query(`UPDATE lessons SET is_published=?, updated_at=NOW() WHERE id=?`, [is_published ? 1 : 0, id]);

    // 2. Récupérer le course_id via le module
    const [les]: any[] = await query(`
      SELECT m.course_id FROM lessons l JOIN modules m ON l.module_id=m.id WHERE l.id=?
    `, [id]);
    if (les) {
      // 3. Recalculer la progression de tous les étudiants
      const enrollments: any[] = await query(
        `SELECT DISTINCT user_id FROM course_enrollments WHERE course_id=?`, [les.course_id]
      );
      for (const { user_id } of enrollments) {
        const [prog]: any = await query(`
          SELECT ROUND(
            COUNT(DISTINCT CASE WHEN lp.is_completed = 1 THEN lp.lesson_id END) * 100.0
            / NULLIF(COUNT(DISTINCT l.id), 0), 2) AS pct
          FROM lessons l
          JOIN modules m ON l.module_id = m.id
          LEFT JOIN lesson_progress lp ON l.id = lp.lesson_id AND lp.user_id = ? AND lp.course_id = ?
          WHERE m.course_id = ? AND l.is_published = 1 AND m.is_published = 1
        `, [user_id, les.course_id, les.course_id]);
        await query(
          `UPDATE course_enrollments SET completion_percentage=? WHERE user_id=? AND course_id=?`,
          [prog?.pct || 0, user_id, les.course_id]
        );
      }
    }

    res.json({ success: true, message: is_published ? "✅ Leçon publiée" : "📦 Leçon dépubliée" });
  } catch (err) {
    console.error("💥 toggleLessonPublish error:", err);
    res.status(500).json({ success:false, message:"Erreur serveur" });
  }
};

/* ─── Supprimer un fichier uploadé du disque ─── */
export const deleteUploadedFile = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [resource] = await query(`SELECT * FROM lesson_resources WHERE id=?`, [id]);
    if (!resource) return res.status(404).json({ success:false, message:"Ressource introuvable" });

    // Supprimer le fichier local si c'est un upload local
    const fileUrl: string = resource.file_url || "";
    if (fileUrl.includes("/uploads/")) {
      const localPath = fileUrl.replace(/^https?:\/\/[^\/]+/, "");
      if (fs.existsSync("." + localPath)) fs.unlinkSync("." + localPath);
    }

    await query(`DELETE FROM lesson_resources WHERE id=?`, [id]);
    res.json({ success:true, message:"🗑️ Ressource supprimée" });
  } catch (err) {
    console.error("💥 deleteUploadedFile error:", err);
    res.status(500).json({ success:false, message:"Erreur serveur" });
  }
};