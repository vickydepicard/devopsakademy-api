// src/controllers/instructorController.ts
import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { sendInstructorApplicationReceivedEmail, sendInstructorApplicationAcceptedEmail, sendInstructorApplicationRejectedEmail } from "../services/mail.service";
import { getUserLang, langFromReq } from "../utils/lang";
import { notifyAdmins } from "../services/notification.service";
import { tr } from "../utils/lang";

// ══════════════════════════════════════════════════════
// POST /api/instructor-applications
// Soumettre une candidature instructeur
// ══════════════════════════════════════════════════════
export const submitInstructorApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: tr(req, "Non authentifié", "Not authenticated") });

    const {
      motivation, experience, expertise_areas, years_experience,
      linkedin_url, portfolio_url, cv_url,
      proposed_course_title, proposed_course_description,
    } = req.body;

    // Validation (messages dans la langue de l'utilisateur)
    const errors: Record<string, string> = {};
    const motivationText = String(motivation ?? "").trim();
    const experienceText = String(experience ?? "").trim();
    const courseTitle = String(proposed_course_title ?? "").trim();
    const yearsNum = Number(years_experience);
    if (motivationText.length < 50)
      errors.motivation = tr(req, "La motivation doit contenir au moins 50 caractères", "Your motivation must contain at least 50 characters");
    if (experienceText.length < 30)
      errors.experience = tr(req, "L'expérience doit contenir au moins 30 caractères", "Your experience must contain at least 30 characters");
    if (courseTitle.length < 5)
      errors.proposed_course_title = tr(req, "Le titre du cours proposé est requis (min 5 caractères)", "The proposed course title is required (min 5 characters)");
    if (years_experience === undefined || years_experience === "" || !Number.isInteger(yearsNum) || yearsNum < 0 || yearsNum > 60)
      errors.years_experience = tr(req, "Les années d'expérience doivent être un nombre entier valide", "Years of experience must be a valid whole number");
    const urlOk = (v: any, host?: string) => {
      try {
        const u = new URL(String(v));
        return ["http:", "https:"].includes(u.protocol) && (!host || u.hostname.toLowerCase().endsWith(host));
      } catch { return false; }
    };
    if (linkedin_url && !urlOk(linkedin_url, "linkedin.com"))
      errors.linkedin_url = tr(req, "URL LinkedIn invalide (doit contenir linkedin.com)", "Invalid LinkedIn URL (must contain linkedin.com)");
    if (portfolio_url && !urlOk(portfolio_url))
      errors.portfolio_url = tr(req, "URL du portfolio invalide", "Invalid portfolio URL");
    if (cv_url && !urlOk(cv_url))
      errors.cv_url = tr(req, "URL du CV invalide", "Invalid CV URL");
    const areas: string[] = Array.isArray(expertise_areas)
      ? expertise_areas.map((a: any) => String(a).trim()).filter(Boolean).slice(0, 20)
      : [];

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        success: false,
        message: tr(req, "Certains champs sont invalides", "Some fields are invalid"),
        errors,
      });
    }

    // Vérifier si une candidature existe déjà
    const [existing]: any = await query(
      "SELECT id, status FROM instructor_applications WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 1",
      [userId]
    );

    if (existing) {
      if (existing.status === "pending" || existing.status === "under_review") {
        return res.status(409).json({
          success: false,
          message: tr(req, "Vous avez déjà une candidature en cours d'examen. Attendez la décision avant de soumettre à nouveau.", "You already have an application under review. Please wait for the decision before submitting again."),
          existing_status: existing.status,
        });
      }
      if (existing.status === "accepted") {
        return res.status(409).json({
          success: false,
          message: tr(req, "Votre candidature a déjà été acceptée. Vous êtes déjà instructeur !", "Your application has already been accepted. You are already an instructor!"),
        });
      }
      // Si rejeté → permettre une nouvelle candidature
    }

    // Insérer la candidature (toutes les colonnes renseignées par le formulaire)
    const result: any = await query(
      `INSERT INTO instructor_applications
         (user_id, motivation, experience, years_experience, expertise_areas, linkedin_url, portfolio_url, cv_url,
          sample_course_topic, proposed_course_description, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [
        userId,
        motivationText,
        experienceText,
        yearsNum,
        areas.length ? JSON.stringify(areas) : null,
        String(linkedin_url || "").trim() || null,
        String(portfolio_url || "").trim() || null,
        String(cv_url || "").trim() || null,
        courseTitle,
        String(proposed_course_description || "").trim().slice(0, 5000) || null,
      ]
    );

    // Email de confirmation au candidat
    const [user]: any = await query(
      "SELECT first_name, email FROM users WHERE id = ?", [userId]
    );
    if (user) {
      await sendInstructorApplicationReceivedEmail(user.email, user.first_name, await getUserLang(userId, langFromReq(req)))
        .catch(e => console.warn("Email candidature:", e.message));

      // Notification aux admins (in-app + temps réel + email)
      void notifyAdmins({
        type: "instructor_application",
        title: `Nouvelle candidature instructeur — ${user.first_name}`,
        message: `${user.first_name} (${user.email}) souhaite devenir instructeur.
Cours proposé : ${courseTitle || "Non spécifié"}`,
        link: "/admin/instructor-applications",
        data: { application_id: Number(result.insertId), user_id: userId },
      });
    }

    return res.status(201).json({
      success: true,
      message: tr(req, "Candidature soumise avec succès ! Nous vous répondrons sous 3 à 5 jours ouvrés.", "Application submitted successfully! We will reply within 3 to 5 business days."),
      data: { id: Number(result.insertId) },
    });
  } catch (error) {
    console.error("submitInstructorApplication:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur lors de la soumission", "Server error during submission") });
  }
};

// ══════════════════════════════════════════════════════
// GET /api/instructor-applications/my
// Voir sa propre candidature
// ══════════════════════════════════════════════════════
export const getMyInstructorApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: tr(req, "Non authentifié", "Not authenticated") });

    const [app]: any = await query(
      `SELECT id, status, motivation, experience, linkedin_url, cv_url,
              sample_course_topic, review_note, submitted_at, reviewed_at
       FROM instructor_applications
       WHERE user_id = ?
       ORDER BY submitted_at DESC LIMIT 1`,
      [userId]
    );

    return res.json({ success: true, data: app || null });
  } catch (error) {
    console.error("getMyInstructorApplication:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};

// ══════════════════════════════════════════════════════
// GET /api/instructor-applications (admin)
// ══════════════════════════════════════════════════════
export const getAllInstructorApplications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = "";
    const params: any[] = [];
    if (status && status !== "all") {
      where = "WHERE ia.status = ?";
      params.push(status);
    }

    const apps: any[] = await query(
      `SELECT ia.id, ia.status, ia.motivation, ia.experience, ia.linkedin_url,
              ia.sample_course_topic, ia.review_note, ia.submitted_at, ia.reviewed_at,
              u.id AS user_id, u.first_name, u.last_name, u.email, u.created_at AS user_since
       FROM instructor_applications ia
       JOIN users u ON u.id = ia.user_id
       ${where}
       ORDER BY
         CASE ia.status
           WHEN 'pending' THEN 1
           WHEN 'under_review' THEN 2
           WHEN 'accepted' THEN 3
           WHEN 'rejected' THEN 4
         END,
         ia.submitted_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [countRow]: any = await query(
      `SELECT COUNT(*) AS total FROM instructor_applications ia ${where}`,
      params
    );

    // Stats par statut pour les compteurs du dashboard
    const statRows: any[] = await query(
      `SELECT status, COUNT(*) AS cnt FROM instructor_applications GROUP BY status`
    );
    const stats: Record<string, number> = {};
    statRows.forEach((r: any) => { stats[r.status] = Number(r.cnt); });

    return res.json({
      success: true,
      data: apps,
      stats,
      pagination: { total: Number(countRow?.total || 0), page: Number(page), limit: Number(limit) },
    });
  } catch (error) {
    console.error("getAllInstructorApplications:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};

// ══════════════════════════════════════════════════════
// GET /api/instructor-applications/:id (admin)
// ══════════════════════════════════════════════════════
export const getInstructorApplicationById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const [app]: any = await query(
      `SELECT ia.*, u.first_name, u.last_name, u.email, u.created_at AS user_since
       FROM instructor_applications ia
       JOIN users u ON u.id = ia.user_id
       WHERE ia.id = ?`,
      [id]
    );
    if (!app) return res.status(404).json({ success: false, message: tr(req, "Candidature introuvable", "Application not found") });
    return res.json({ success: true, data: app });
  } catch (error) {
    console.error("getInstructorApplicationById:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};

// ══════════════════════════════════════════════════════
// PATCH /api/instructor-applications/:id/approve (admin)
// Approuver → changer le rôle en instructor
// ══════════════════════════════════════════════════════
export const approveInstructorApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.id;
    const { note } = req.body;

    const [app]: any = await query(
      "SELECT ia.*, u.email, u.first_name FROM instructor_applications ia JOIN users u ON u.id = ia.user_id WHERE ia.id = ?",
      [id]
    );
    if (!app) return res.status(404).json({ success: false, message: tr(req, "Candidature introuvable", "Application not found") });
    if (app.status === "accepted")
      return res.status(409).json({ success: false, message: tr(req, "Cette candidature est déjà approuvée", "This application has already been approved") });

    // Mettre à jour la candidature
    await query(
      `UPDATE instructor_applications
       SET status = 'accepted', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
       WHERE id = ?`,
      [adminId, note || null, id]
    );

    // Promouvoir l'utilisateur en instructeur
    await query(
      "UPDATE users SET role = 'instructor', updated_at = NOW() WHERE id = ?",
      [app.user_id]
    );

    // Email de validation
    await sendInstructorApplicationAcceptedEmail(app.email, app.first_name, note, await getUserLang(app.user_id))
      .catch(e => console.warn("Email approve instructor:", e.message));

    return res.json({
      success: true,
      message: tr(req, `Candidature de ${app.first_name} approuvée. Le rôle instructeur a été attribué.`, `${app.first_name}'s application approved. The instructor role has been granted.`),
    });
  } catch (error) {
    console.error("approveInstructorApplication:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};

// ══════════════════════════════════════════════════════
// PATCH /api/instructor-applications/:id/reject (admin)
// ══════════════════════════════════════════════════════
export const rejectInstructorApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.id;
    const { rejection_reason, note } = req.body;

    if (!rejection_reason || rejection_reason.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: tr(req, "Un motif de refus est requis (minimum 10 caractères)", "A reason for rejection is required (minimum 10 characters)"),
      });
    }

    const [app]: any = await query(
      "SELECT ia.*, u.email, u.first_name FROM instructor_applications ia JOIN users u ON u.id = ia.user_id WHERE ia.id = ?",
      [id]
    );
    if (!app) return res.status(404).json({ success: false, message: tr(req, "Candidature introuvable", "Application not found") });
    if (app.status === "rejected")
      return res.status(409).json({ success: false, message: tr(req, "Cette candidature est déjà rejetée", "This application has already been rejected") });

    await query(
      `UPDATE instructor_applications
       SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(),
           review_note = ?
       WHERE id = ?`,
      [adminId, rejection_reason.trim(), id]
    );

    // Une candidature précédemment acceptée qui est rejetée retire aussi le rôle (sinon l'accès reste ouvert).
    if (app.status === "accepted") {
      await query("UPDATE users SET role = 'student', updated_at = NOW() WHERE id = ? AND role = 'instructor'", [app.user_id]);
    }

    // Email de refus
    await sendInstructorApplicationRejectedEmail(app.email, app.first_name, rejection_reason, await getUserLang(app.user_id))
      .catch(e => console.warn("Email reject instructor:", e.message));

    return res.json({
      success: true,
      message: tr(req, "Candidature rejetée. Le candidat a été notifié par email.", "Application rejected. The applicant has been notified by email."),
    });
  } catch (error) {
    console.error("rejectInstructorApplication:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};

// ══════════════════════════════════════════════════════
// PATCH /api/instructor-applications/:id/review (admin)
// Passer une candidature « en cours d'examen »
// (le frontend appelait cette route, elle n'existait pas)
// ══════════════════════════════════════════════════════
export const markApplicationUnderReview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const [app]: any = await query("SELECT id, status FROM instructor_applications WHERE id = ?", [id]);
    if (!app) return res.status(404).json({ success: false, message: tr(req, "Candidature introuvable", "Application not found") });
    if (app.status !== "pending") {
      return res.status(409).json({ success: false, message: tr(req, "Seule une candidature en attente peut être mise en révision", "Only a pending application can be set under review") });
    }
    await query(
      "UPDATE instructor_applications SET status = 'under_review', reviewed_by = ?, updated_at = NOW() WHERE id = ?",
      [req.user?.id, id]
    );
    return res.json({ success: true, message: tr(req, "Candidature mise en révision", "Application set under review") });
  } catch (error) {
    console.error("markApplicationUnderReview:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};
