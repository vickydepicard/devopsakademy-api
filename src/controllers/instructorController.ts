// src/controllers/instructorController.ts
import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { sendEmail, sendWelcomeEmail } from "../services/mail.service";

// ══════════════════════════════════════════════════════
// POST /api/instructor-applications
// Soumettre une candidature instructeur
// ══════════════════════════════════════════════════════
export const submitInstructorApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Non authentifié" });

    const {
      motivation, experience, expertise_areas, years_experience,
      linkedin_url, portfolio_url, cv_url, certifications, video_url, weekly_hours,
      // Accepte les deux noms de champ (compatibilité frontend)
      proposed_course_title: _pct,
      sample_course_topic: _sct,
      proposed_course_description,
    } = req.body;
    const proposed_course_title = (_pct || _sct || "").trim();

    // Validation
    const errors: Record<string, string> = {};
    if (!motivation || motivation.trim().length < 30)
      errors.motivation = "La motivation doit contenir au moins 30 caractères";
    if (!experience || experience.trim().length < 20)
      errors.experience = "L'expérience doit contenir au moins 20 caractères";
    if (!proposed_course_title || proposed_course_title.length < 3)
      errors.proposed_course_title = "Le titre du cours est requis (minimum 3 caractères)";
    if (!years_experience || isNaN(Number(years_experience)) || Number(years_experience) < 1)
      errors.years_experience = "Les années d'expérience sont requises";
    // linkedin_url : aucune validation stricte

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        success: false,
        message: "Certains champs sont invalides",
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
          message: "Vous avez déjà une candidature en cours d'examen. Attendez la décision avant de soumettre à nouveau.",
          existing_status: existing.status,
        });
      }
      if (existing.status === "accepted") {
        return res.status(409).json({
          success: false,
          message: "Votre candidature a déjà été acceptée. Vous êtes déjà instructeur !",
        });
      }
      // Si rejeté → permettre une nouvelle candidature
    }

    // Insérer la candidature
    const result: any = await query(
      `INSERT INTO instructor_applications
         (user_id, motivation, experience, linkedin_url, cv_url,
          sample_course_topic, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [
        userId,
        motivation.trim(),
        experience.trim(),
        linkedin_url?.trim() || null,
        cv_url?.trim() || null,
        proposed_course_title?.trim() || null,
      ]
    );

    // Email de confirmation au candidat
    const [user]: any = await query(
      "SELECT first_name, email FROM users WHERE id = ?", [userId]
    );
    if (user) {
      await sendEmail({
        to: user.email,
        subject: "Candidature instructeur reçue — DevOpsAkademy",
        html: `<p>Bonjour <strong>${user.first_name}</strong>,</p>
               <p>Nous avons bien reçu votre candidature pour devenir instructeur sur <strong>DevOpsAkademy</strong>.</p>
               <p>Notre équipe l'examinera sous <strong>3 à 5 jours ouvrés</strong>. Vous recevrez une réponse par email.</p>
               <p>Merci pour votre intérêt !</p>
               <p>— L'équipe DevOpsAkademy</p>`,
      }).catch(e => console.warn("Email candidature:", e.message));

      // Email admin - récapitulatif complet
      const adminTo = process.env.ADMIN_EMAIL || process.env.MAIL_FROM_EMAIL || "devopseduque@gmail.com";
      const expertiseStr = Array.isArray(expertise_areas) ? expertise_areas.join(", ") : (expertise_areas || "—");
      await sendEmail({
        to: adminTo,
        subject: `🆕 Nouvelle candidature instructeur — ${user.first_name}`,
        html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f3fb;padding:16px;">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(45,40,127,0.1);">
  <div style="background:linear-gradient(135deg,#2d287f,#5653e1);padding:20px 28px;text-align:center;">
    <p style="margin:0;color:#facc15;font-size:20px;font-weight:900;">DevOps Akademy</p>
  </div>
  <div style="padding:24px 28px;">
    <h2 style="color:#2d287f;margin:0 0 14px;">Candidature — ${user.first_name} (${user.email})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px;">
      <tr style="background:#f8f7ff;"><td style="padding:7px 10px;font-weight:700;color:#555;width:38%;">Expérience</td><td style="padding:7px 10px;">${years_experience} an(s)</td></tr>
      <tr><td style="padding:7px 10px;font-weight:700;color:#555;border-top:1px solid #eee;">Domaines</td><td style="padding:7px 10px;border-top:1px solid #eee;">${expertiseStr}</td></tr>
      <tr style="background:#f8f7ff;"><td style="padding:7px 10px;font-weight:700;color:#555;border-top:1px solid #eee;">Certifications</td><td style="padding:7px 10px;border-top:1px solid #eee;">${certifications || "—"}</td></tr>
      <tr><td style="padding:7px 10px;font-weight:700;color:#555;border-top:1px solid #eee;">Cours proposé</td><td style="padding:7px 10px;border-top:1px solid #eee;"><strong>${proposed_course_title || "—"}</strong></td></tr>
      <tr style="background:#f8f7ff;"><td style="padding:7px 10px;font-weight:700;color:#555;border-top:1px solid #eee;">Heures/sem</td><td style="padding:7px 10px;border-top:1px solid #eee;">${weekly_hours || "—"}h</td></tr>
      <tr><td style="padding:7px 10px;font-weight:700;color:#555;border-top:1px solid #eee;">LinkedIn</td><td style="padding:7px 10px;border-top:1px solid #eee;">${linkedin_url ? `<a href="${linkedin_url}" style="color:#5653e1;">${linkedin_url}</a>` : "—"}</td></tr>
      <tr style="background:#f8f7ff;"><td style="padding:7px 10px;font-weight:700;color:#555;border-top:1px solid #eee;">Vidéo</td><td style="padding:7px 10px;border-top:1px solid #eee;">${video_url ? `<a href="${video_url}" style="color:#5653e1;">Voir</a>` : "—"}</td></tr>
    </table>
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:10px;">
      <p style="margin:0 0 4px;font-weight:700;color:#92400e;font-size:12px;">Motivation :</p>
      <p style="margin:0;color:#78350f;font-size:12px;line-height:1.6;">${motivation ? motivation.substring(0,350) : "—"}</p>
    </div>
    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px;margin-bottom:18px;">
      <p style="margin:0 0 4px;font-weight:700;color:#0284c7;font-size:12px;">Parcours :</p>
      <p style="margin:0;color:#0369a1;font-size:12px;line-height:1.6;">${experience ? experience.substring(0,350) : "—"}</p>
    </div>
    <div style="text-align:center;">
      <a href="${process.env.FRONTEND_URL}/admin/instructor-applications" style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;padding:11px 24px;border-radius:10px;font-weight:700;font-size:13px;display:inline-block;">Examiner la candidature →</a>
    </div>
  </div>
</div></body></html>`,
      }).catch(e => console.warn("Email admin:", e.message));
    }

    return res.status(201).json({
      success: true,
      message: "Candidature soumise avec succès ! Nous vous répondrons sous 3 à 5 jours ouvrés.",
      data: { id: Number(result.insertId) },
    });
  } catch (error) {
    console.error("submitInstructorApplication:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur lors de la soumission" });
  }
};

// ══════════════════════════════════════════════════════
// GET /api/instructor-applications/my
// Voir sa propre candidature
// ══════════════════════════════════════════════════════
export const getMyInstructorApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Non authentifié" });

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
    return res.status(500).json({ success: false, message: "Erreur serveur" });
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

    return res.json({
      success: true,
      data: apps,
      pagination: { total: Number(countRow?.total || 0), page: Number(page), limit: Number(limit) },
    });
  } catch (error) {
    console.error("getAllInstructorApplications:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
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
    if (!app) return res.status(404).json({ success: false, message: "Candidature introuvable" });
    return res.json({ success: true, data: app });
  } catch (error) {
    console.error("getInstructorApplicationById:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
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
    if (!app) return res.status(404).json({ success: false, message: "Candidature introuvable" });
    if (app.status === "accepted")
      return res.status(409).json({ success: false, message: "Cette candidature est déjà approuvée" });

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
    await sendEmail({
      to: app.email,
      subject: "🎉 Candidature acceptée — Vous êtes maintenant instructeur !",
      html: `<p>Bonjour <strong>${app.first_name}</strong>,</p>
             <p>Félicitations ! Votre candidature pour devenir instructeur sur <strong>DevOpsAkademy</strong> a été <strong>acceptée</strong>.</p>
             <p>Votre compte a été mis à jour. Reconnectez-vous pour accéder à votre espace instructeur.</p>
             ${note ? `<p><strong>Message de l'équipe :</strong> ${note}</p>` : ""}
             <div style="text-align:center;margin:24px 0;">
               <a href="${process.env.FRONTEND_URL}/login" style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;">
                 Accéder à mon espace instructeur →
               </a>
             </div>
             <p>Bienvenue dans l'équipe ! — DevOpsAkademy</p>`,
    }).catch(e => console.warn("Email approve instructor:", e.message));

    return res.json({
      success: true,
      message: `Candidature de ${app.first_name} approuvée. Le rôle instructeur a été attribué.`,
    });
  } catch (error) {
    console.error("approveInstructorApplication:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
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

    if (!rejection_reason || rejection_reason.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: "Un motif de refus est requis (minimum 3 caractères)",
      });
    }

    const [app]: any = await query(
      "SELECT ia.*, u.email, u.first_name FROM instructor_applications ia JOIN users u ON u.id = ia.user_id WHERE ia.id = ?",
      [id]
    );
    if (!app) return res.status(404).json({ success: false, message: "Candidature introuvable" });
    if (app.status === "rejected")
      return res.status(409).json({ success: false, message: "Cette candidature est déjà rejetée" });

    await query(
      `UPDATE instructor_applications
       SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(),
           review_note = ?
       WHERE id = ?`,
      [adminId, rejection_reason.trim(), id]
    );

    // Email de refus
    await sendEmail({
      to: app.email,
      subject: "Candidature instructeur — Décision de notre équipe",
      html: `<p>Bonjour <strong>${app.first_name}</strong>,</p>
             <p>Après examen de votre candidature, nous ne sommes pas en mesure de vous accepter comme instructeur pour le moment.</p>
             <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;margin:16px 0;">
               <p style="margin:0;color:#991b1b;"><strong>Motif :</strong> ${rejection_reason}</p>
             </div>
             <p>Cela ne signifie pas que votre candidature est définitivement refusée. Vous pouvez soumettre une nouvelle candidature dans 3 mois avec un profil enrichi.</p>
             <p>Continuez d'apprendre sur la plateforme — nous espérons vous voir prochainement !</p>
             <p>— L'équipe DevOpsAkademy</p>`,
    }).catch(e => console.warn("Email reject instructor:", e.message));

    return res.json({
      success: true,
      message: "Candidature rejetée. Le candidat a été notifié par email.",
    });
  } catch (error) {
    console.error("rejectInstructorApplication:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};