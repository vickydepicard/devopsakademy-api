import { Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";

/**
 * =============================
 * 1️⃣ Inscription à un cours
 * =============================
 */
export const enrollInCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user)
      return res.status(401).json({ success: false, message: "Authentification requise" });
    if (req.user.role !== "student")
      return res.status(403).json({ success: false, message: "Seuls les étudiants peuvent s'inscrire" });

    const { courseId } = req.body;
    if (!courseId)
      return res.status(400).json({ success: false, message: "courseId requis" });

    // Vérifier que le cours existe
    const [course]: any = await query(
      "SELECT id, is_published, requires_approval FROM courses WHERE id = ?",
      [courseId]
    );

    if (!course)
      return res.status(404).json({ success: false, message: "Cours introuvable" });
    if (!course.is_published)
      return res.status(403).json({ success: false, message: "Cours non publié" });

    // Vérifie si déjà inscrit
    const [exists]: any = await query(
      "SELECT id, is_approved FROM course_enrollments WHERE user_id = ? AND course_id = ?",
      [req.user.id, courseId]
    );

    if (exists) {
      return res.status(200).json({
        success: true,
        message: "Déjà inscrit à ce cours",
        alreadyEnrolled: true,
        is_approved: !!exists.is_approved,
      });
    }

    // Enregistrer l’inscription
    const isApproved = 0;

    await query(
      `INSERT INTO course_enrollments (user_id, course_id, enrolled_at, completion_percentage, is_approved)
       VALUES (?, ?, NOW(), 0, ?)`,
      [req.user.id, courseId, isApproved]
    );

    return res.status(201).json({
      success: true,
      message: isApproved
        ? "Inscription réussie ✅"
        : "Inscription enregistrée — en attente de validation par l’administrateur ⏳",
      alreadyEnrolled: false,
      is_approved: !!isApproved,
    });
  } catch (err) {
    console.error("Enroll error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 * 2️⃣ Désinscription
 * =============================
 */
export const unenrollFromCourse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user)
      return res.status(401).json({ success: false, message: "Authentification requise" });
    if (req.user.role !== "student")
      return res.status(403).json({ success: false, message: "Seuls les étudiants peuvent se désinscrire" });

    const { courseId } = req.params;

    const result = await query(
      "DELETE FROM course_enrollments WHERE user_id = ? AND course_id = ?",
      [req.user.id, courseId]
    );

    return res.json({
      success: true,
      message: "Désinscription réussie",
      affectedRows: result.affectedRows,
    });
  } catch (err) {
    console.error("Unenroll error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 * 3️⃣ Mes cours inscrits
 * =============================
 */
export const getUserEnrollments = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user)
      return res.status(401).json({ success: false, message: "Authentification requise" });

    const result = await query(
      `SELECT c.id, c.title, c.thumbnail_url, c.level, c.language,
              ce.enrolled_at, ce.completion_percentage, ce.is_favorite, ce.is_approved
       FROM course_enrollments ce
       JOIN courses c ON ce.course_id = c.id
       WHERE ce.user_id = ?
       ORDER BY ce.enrolled_at DESC`,
      [req.user.id]
    );

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("Get enrollments error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 * 4️⃣ Vérifier inscription
 * =============================
 */
export const checkEnrollment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user)
      return res.status(401).json({ success: false, message: "Authentification requise" });

    const { courseId } = req.params;
    const [row]: any = await query(
      "SELECT id, is_approved FROM course_enrollments WHERE course_id = ? AND user_id = ?",
      [courseId, req.user.id]
    );

    return res.json({ success: true, enrolled: !!row, is_approved: !!row?.is_approved });
  } catch (err) {
    console.error("Check enrollment error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 * 5️⃣ Étudiants d’un cours (instructor/admin)
 * =============================
 */
export const getCourseStudents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;

    if (!req.user)
      return res.status(401).json({ success: false, message: "Authentification requise" });

    if (req.user.role === "instructor") {
      const [course]: any = await query(
        "SELECT id FROM courses WHERE id = ? AND instructor_id = ?",
        [courseId, req.user.id]
      );
      if (!course) {
        return res.status(403).json({ success: false, message: "Ce n’est pas votre cours" });
      }
    }

    const students = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email,
              ce.enrolled_at, ce.is_approved
       FROM course_enrollments ce
       JOIN users u ON ce.user_id = u.id
       WHERE ce.course_id = ?`,
      [courseId]
    );

    return res.json({ success: true, data: students });
  } catch (err) {
    console.error("Get course students error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 * 6️⃣ Validation d’un étudiant (admin)
 * =============================
 */
export const validateEnrollment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || req.user.role !== "admin")
      return res.status(403).json({ success: false, message: "Accès réservé à l’admin" });

    const { courseId, userId } = req.params;

    await query(
      "UPDATE course_enrollments SET is_approved = 1 WHERE course_id = ? AND user_id = ?",
      [courseId, userId]
    );

    return res.json({ success: true, message: "Inscription validée ✅" });
  } catch (err) {
    console.error("Validate enrollment error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 * 7️⃣ Suppression (admin)
 * =============================
 */
export const adminDeleteEnrollment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || req.user.role !== "admin")
      return res.status(403).json({ success: false, message: "Accès réservé à l’admin" });

    const { courseId, userId } = req.params;

    await query("DELETE FROM course_enrollments WHERE course_id = ? AND user_id = ?", [
      courseId,
      userId,
    ]);

    return res.json({ success: true, message: "Inscription supprimée par admin" });
  } catch (err) {
    console.error("Admin delete enrollment error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};


/**
 * =============================
 *   Validation admin inscription
 * =============================
 */
export const adminApproveEnrollment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId, courseId } = req.params;

    const result = await query(
      `UPDATE course_enrollments 
       SET is_approved = 1, approved_at = NOW()
       WHERE user_id = ? AND course_id = ?`,
      [userId, courseId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Inscription non trouvée." });
    }

    res.json({ success: true, message: "✅ Inscription validée avec succès." });
  } catch (err) {
    console.error("Admin approve error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur." });
  }
};

export const getAllEnrollments = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || req.user.role !== "admin")
      return res.status(403).json({ success: false, message: "Accès réservé à l'admin" });

    const result = await query(`
      SELECT 
        ce.id,
        u.id AS user_id, u.first_name, u.last_name, u.email,
        c.id AS course_id, c.title AS course_title,
        ce.enrolled_at, ce.is_approved, ce.completion_percentage
      FROM course_enrollments ce
      JOIN users u ON ce.user_id = u.id
      JOIN courses c ON ce.course_id = c.id
      ORDER BY ce.enrolled_at DESC
    `);

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("❌ getAllEnrollments error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

/**
 * =============================
 *   9. Liste complète (admin)
 * =============================
 */
export const getAllEnrollmentsAdmin = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || req.user.role !== "admin")
      return res.status(403).json({ success: false, message: "Accès réservé à l’administrateur" });

    const data = await query(`
      SELECT ce.user_id, ce.course_id, ce.is_approved, 
             u.first_name, u.last_name, u.email, 
             c.title AS course_title
      FROM course_enrollments ce
      JOIN users u ON ce.user_id = u.id
      JOIN courses c ON ce.course_id = c.id
      ORDER BY ce.enrolled_at DESC
    `);

    res.json({ success: true, data });
  } catch (err) {
    console.error("getAllEnrollmentsAdmin error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export const uploadPaymentProof = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentification requise." });
    }

    const { courseId } = req.params;
    const userId = req.user.id;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, message: "Aucun fichier uploadé." });
    }

    const proofUrl = `/uploads/payments/${file.filename}`;

    await query(
      "UPDATE course_enrollments SET payment_proof_url=?, payment_status='pending' WHERE user_id=? AND course_id=?",
      [proofUrl, userId, courseId]
    );

    return res.status(200).json({
      success: true,
      message: "Preuve de paiement envoyée avec succès.",
      proofUrl,
    });
  } catch (err) {
    console.error("Erreur upload preuve:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur." });
  }
};



export const validatePayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Accès réservé à l’administrateur." });
    }

    const { userId, courseId } = req.params;
    const { action } = req.body; // "approve" ou "reject"

    const newStatus = action === "approve" ? "verified" : "rejected";
    const approved = action === "approve" ? 1 : 0;

    await query(
      "UPDATE course_enrollments SET payment_status=?, is_approved=? WHERE user_id=? AND course_id=?",
      [newStatus, approved, userId, courseId]
    );

    return res.status(200).json({
      success: true,
      message: `Paiement ${action === "approve" ? "validé" : "rejeté"} avec succès.`,
    });
  } catch (err) {
    console.error("Erreur validation paiement:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur." });
  }
};


/**
 * ===========================================
 * 🔹 Détails complets d’un cours inscrit (Étudiant)
 * ===========================================
 */
export const getEnrollmentDetails = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;

    if (!req.user)
      return res.status(401).json({ success: false, message: "Authentification requise" });

    // Vérifie si l’utilisateur est bien inscrit à ce cours
    const [enrollment]: any = await query(
      `SELECT ce.id, ce.is_approved, ce.payment_status, ce.payment_proof_url,
              c.id AS course_id, c.title, c.description, c.level, c.language
       FROM course_enrollments ce
       JOIN courses c ON ce.course_id = c.id
       WHERE ce.user_id = ? AND ce.course_id = ?`,
      [req.user.id, courseId]
    );

    if (!enrollment)
      return res.status(404).json({ success: false, message: "Inscription introuvable pour ce cours." });

    // Récupère les modules et leçons associées
    const modules: any = await query(
      `SELECT id, title, description
       FROM modules
       WHERE course_id = ?
       ORDER BY id ASC`,
      [courseId]
    );

    // Pour chaque module → récupérer les leçons
    for (const mod of modules) {
      const lessons = await query(
        `SELECT id, title, content, duration
         FROM lessons
         WHERE module_id = ?
         ORDER BY id ASC`,
        [mod.id]
      );
      mod.lessons = lessons;
    }

    // Structure de réponse complète
    const data = {
      id: enrollment.course_id,
      title: enrollment.title,
      description: enrollment.description,
      level: enrollment.level,
      language: enrollment.language,
      is_approved: !!enrollment.is_approved,
      payment_status: enrollment.payment_status,
      payment_proof_url: enrollment.payment_proof_url,
      modules,
    };

    return res.json({ success: true, data });
  } catch (err) {
    console.error("❌ getEnrollmentDetails error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur." });
  }
};

