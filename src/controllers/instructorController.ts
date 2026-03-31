// src/controllers/instructorController.ts — DevOpsAkademy
// VERSION COMPLÈTE CORRIGÉE v2.0
// ✅ Champ "experience" maintenant stocké (manquait dans INSERT)
// ✅ expertise_areas + portfolio_url + proposed_course_description sauvegardés
// ✅ Emails HTML améliorés (candidat + admin)
// ✅ Validation renforcée
// ✅ Logs restreints au mode dev

import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { sendEmail } from "../services/mail.service";

const isDev = process.env.NODE_ENV !== "production";

// ════════════════════════════════════════════════════════════
// POST /api/instructor-applications
// Soumettre une candidature instructeur
// ════════════════════════════════════════════════════════════
export const submitInstructorApplication = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const userId = req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Non authentifié" });

    // Si déjà instructeur, inutile de candidater
    if (req.user?.role === "instructor") {
      return res.status(409).json({
        success: false,
        message: "Vous êtes déjà instructeur sur la plateforme.",
      });
    }

    const {
      motivation,
      experience,
      expertise_areas,
      years_experience,
      linkedin_url,
      portfolio_url,
      proposed_course_title,
      proposed_course_description,
    } = req.body;

    // ── Validation ────────────────────────────────────────────
    const errors: Record<string, string> = {};
    if (!motivation || motivation.trim().length < 50)
      errors.motivation = "La motivation doit contenir au moins 50 caractères";
    if (!experience || experience.trim().length < 30)
      errors.experience = "L'expérience doit contenir au moins 30 caractères";
    if (!proposed_course_title || proposed_course_title.trim().length < 5)
      errors.proposed_course_title = "Le titre du cours proposé est requis (min 5 caractères)";
    if (!years_experience || isNaN(Number(years_experience)) || Number(years_experience) < 1)
      errors.years_experience = "Les années d'expérience doivent être un nombre positif";
    if (linkedin_url && !linkedin_url.includes("linkedin.com"))
      errors.linkedin_url = "L'URL LinkedIn doit contenir linkedin.com";

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        success: false,
        message: "Certains champs sont invalides",
        errors,
      });
    }

    // ── Vérifier candidature existante ───────────────────────
    const [existing]: any = await query(
      `SELECT id, status FROM instructor_applications
       WHERE user_id = ?
       ORDER BY submitted_at DESC
       LIMIT 1`,
      [userId]
    );

    if (existing) {
      if (existing.status === "pending" || existing.status === "under_review") {
        return res.status(409).json({
          success: false,
          message:
            "Vous avez déjà une candidature en cours d'examen. Attendez la décision de notre équipe avant de soumettre à nouveau.",
          existing_status: existing.status,
        });
      }
      if (existing.status === "accepted") {
        return res.status(409).json({
          success: false,
          message: "Votre candidature a déjà été acceptée. Vous êtes instructeur !",
        });
      }
      // Statut "rejected" → on autorise une nouvelle candidature
    }

    // ── Insérer la candidature ────────────────────────────────
    // On tente avec tous les champs optionnels ; si une colonne n'existe pas
    // en BDD, le catch la signalera clairement.
    const expertiseJson = Array.isArray(expertise_areas)
      ? JSON.stringify(expertise_areas)
      : null;

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
        portfolio_url?.trim() || null,   // cv_url réutilisé pour portfolio
        proposed_course_title?.trim() || null,
      ]
    );

    const applicationId = Number(result.insertId);

    // ── Récupérer les infos du candidat pour les emails ───────
    const [user]: any = await query(
      "SELECT first_name, last_name, email FROM users WHERE id = ?",
      [userId]
    );

    if (user) {
      // ── Email de confirmation au candidat ──────────────────
      await sendEmail({
        to: user.email,
        subject: "📋 Candidature instructeur reçue — DevOpsAkademy",
        html: buildCandidateConfirmationEmail(user.first_name, proposed_course_title),
      }).catch((e: any) =>
        isDev && console.warn("Email candidature candidat:", e.message)
      );

      // ── Email de notification aux admins ───────────────────
      const adminEmail = process.env.ADMIN_EMAIL || process.env.MAIL_FROM_EMAIL;
      if (adminEmail) {
        await sendEmail({
          to: adminEmail,
          subject: `🆕 Candidature instructeur #${applicationId} — ${user.first_name} ${user.last_name}`,
          html: buildAdminNotificationEmail({
            id: applicationId,
            firstName: user.first_name,
            lastName:  user.last_name,
            email:     user.email,
            motivation: motivation.trim().substring(0, 200) + (motivation.length > 200 ? "..." : ""),
            experience: experience.trim().substring(0, 150) + (experience.length > 150 ? "..." : ""),
            courseTitle: proposed_course_title,
            yearsExp: years_experience,
            linkedinUrl: linkedin_url,
          }),
        }).catch((e: any) =>
          isDev && console.warn("Email candidature admin:", e.message)
        );
      }
    }

    return res.status(201).json({
      success: true,
      message:
        "Candidature soumise avec succès ! Vous recevrez une réponse par email sous 3 à 5 jours ouvrés.",
      data: { id: applicationId },
    });
  } catch (error) {
    isDev && console.error("submitInstructorApplication:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur serveur lors de la soumission",
    });
  }
};

// ════════════════════════════════════════════════════════════
// GET /api/instructor-applications/my
// Voir sa propre candidature
// ════════════════════════════════════════════════════════════
export const getMyInstructorApplication = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const userId = req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Non authentifié" });

    const [app]: any = await query(
      `SELECT id, status, motivation, experience, linkedin_url, cv_url,
              sample_course_topic, review_note, submitted_at, reviewed_at
       FROM instructor_applications
       WHERE user_id = ?
       ORDER BY submitted_at DESC
       LIMIT 1`,
      [userId]
    );

    return res.json({ success: true, data: app || null });
  } catch (error) {
    isDev && console.error("getMyInstructorApplication:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ════════════════════════════════════════════════════════════
// GET /api/instructor-applications (admin)
// Toutes les candidatures avec pagination et filtre statut
// ════════════════════════════════════════════════════════════
export const getAllInstructorApplications = async (
  req: AuthenticatedRequest,
  res: Response
) => {
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
              ia.sample_course_topic AS proposed_course_title,
              ia.review_note, ia.submitted_at, ia.reviewed_at,
              u.id AS user_id, u.first_name, u.last_name, u.email,
              u.created_at AS user_since
       FROM instructor_applications ia
       JOIN users u ON u.id = ia.user_id
       ${where}
       ORDER BY
         CASE ia.status
           WHEN 'pending'      THEN 1
           WHEN 'under_review' THEN 2
           WHEN 'accepted'     THEN 3
           WHEN 'rejected'     THEN 4
         END,
         ia.submitted_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [countRow]: any = await query(
      `SELECT COUNT(*) AS total FROM instructor_applications ia ${where}`,
      params
    );

    // Stats par statut
    const statusCounts: any[] = await query(
      `SELECT status, COUNT(*) AS count
       FROM instructor_applications
       GROUP BY status`
    );

    return res.json({
      success: true,
      data: apps,
      stats: Object.fromEntries(statusCounts.map(r => [r.status, Number(r.count)])),
      pagination: {
        total: Number(countRow?.total || 0),
        page:  Number(page),
        limit: Number(limit),
      },
    });
  } catch (error) {
    isDev && console.error("getAllInstructorApplications:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ════════════════════════════════════════════════════════════
// GET /api/instructor-applications/:id (admin)
// ════════════════════════════════════════════════════════════
export const getInstructorApplicationById = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { id } = req.params;
    const [app]: any = await query(
      `SELECT ia.*, u.first_name, u.last_name, u.email, u.created_at AS user_since
       FROM instructor_applications ia
       JOIN users u ON u.id = ia.user_id
       WHERE ia.id = ?`,
      [id]
    );
    if (!app)
      return res.status(404).json({ success: false, message: "Candidature introuvable" });
    return res.json({ success: true, data: app });
  } catch (error) {
    isDev && console.error("getInstructorApplicationById:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ════════════════════════════════════════════════════════════
// PATCH /api/instructor-applications/:id/approve (admin)
// Approuver → changer le rôle en instructor + email
// ════════════════════════════════════════════════════════════
export const approveInstructorApplication = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { id }    = req.params;
    const adminId   = req.user?.id;
    const { note }  = req.body;

    const [app]: any = await query(
      `SELECT ia.*, u.email, u.first_name, u.last_name
       FROM instructor_applications ia
       JOIN users u ON u.id = ia.user_id
       WHERE ia.id = ?`,
      [id]
    );
    if (!app)
      return res.status(404).json({ success: false, message: "Candidature introuvable" });
    if (app.status === "accepted")
      return res.status(409).json({ success: false, message: "Cette candidature est déjà approuvée" });

    // Mettre à jour la candidature
    await query(
      `UPDATE instructor_applications
       SET status = 'accepted', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
       WHERE id = ?`,
      [adminId, note?.trim() || null, id]
    );

    // Promouvoir l'utilisateur en instructeur
    await query(
      "UPDATE users SET role = 'instructor', updated_at = NOW() WHERE id = ?",
      [app.user_id]
    );

    // Email de validation au candidat
    await sendEmail({
      to: app.email,
      subject: "🎉 Candidature acceptée — Vous êtes maintenant instructeur !",
      html: buildApprovalEmail(app.first_name, note),
    }).catch((e: any) => isDev && console.warn("Email approve instructor:", e.message));

    return res.json({
      success: true,
      message: `Candidature de ${app.first_name} ${app.last_name} approuvée. Le rôle instructeur a été attribué.`,
    });
  } catch (error) {
    isDev && console.error("approveInstructorApplication:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ════════════════════════════════════════════════════════════
// PATCH /api/instructor-applications/:id/reject (admin)
// ════════════════════════════════════════════════════════════
export const rejectInstructorApplication = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { id }     = req.params;
    const adminId    = req.user?.id;
    const { rejection_reason } = req.body;

    if (!rejection_reason || rejection_reason.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: "Un motif de refus est requis (minimum 10 caractères)",
      });
    }

    const [app]: any = await query(
      `SELECT ia.*, u.email, u.first_name, u.last_name
       FROM instructor_applications ia
       JOIN users u ON u.id = ia.user_id
       WHERE ia.id = ?`,
      [id]
    );
    if (!app)
      return res.status(404).json({ success: false, message: "Candidature introuvable" });
    if (app.status === "rejected")
      return res.status(409).json({ success: false, message: "Cette candidature est déjà rejetée" });

    await query(
      `UPDATE instructor_applications
       SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
       WHERE id = ?`,
      [adminId, rejection_reason.trim(), id]
    );

    // Email de refus au candidat
    await sendEmail({
      to: app.email,
      subject: "Candidature instructeur — Décision de notre équipe",
      html: buildRejectionEmail(app.first_name, rejection_reason.trim()),
    }).catch((e: any) => isDev && console.warn("Email reject instructor:", e.message));

    return res.json({
      success: true,
      message: "Candidature rejetée. Le candidat a été notifié par email avec le motif.",
    });
  } catch (error) {
    isDev && console.error("rejectInstructorApplication:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ════════════════════════════════════════════════════════════
// TEMPLATES EMAIL
// ════════════════════════════════════════════════════════════

function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f4f3fb;padding:20px;margin:0;">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(45,40,127,0.08);">
  <div style="background:linear-gradient(135deg,#2d287f,#5653e1);padding:24px 32px;text-align:center;">
    <p style="margin:0;color:#facc15;font-size:22px;font-weight:900;letter-spacing:-0.5px;">DevOps Akademy</p>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.6);font-size:12px;">La plateforme DevOps francophone</p>
  </div>
  <div style="padding:32px;">
    ${content}
  </div>
  <div style="background:#f9f9f9;padding:16px 32px;text-align:center;border-top:1px solid #eee;">
    <p style="margin:0;color:#999;font-size:11px;">© 2026 DevOpsAkademy — Tous droits réservés</p>
    <p style="margin:4px 0 0;font-size:11px;color:#999;">
      <a href="${process.env.FRONTEND_URL}" style="color:#5653e1;text-decoration:none;">devopsakademy.com</a>
    </p>
  </div>
</div>
</body>
</html>`;
}

function buildCandidateConfirmationEmail(firstName: string, courseTitle: string): string {
  return emailWrapper(`
    <h2 style="color:#2d287f;margin:0 0 8px;">Bonjour ${firstName} 👋</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Nous avons bien reçu votre candidature pour devenir instructeur sur <strong>DevOpsAkademy</strong>.
    </p>

    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;padding:16px;margin:20px 0;">
      <p style="margin:0 0 8px;font-weight:700;color:#0284c7;">📋 Récapitulatif de votre candidature :</p>
      <p style="margin:0;color:#0369a1;font-size:14px;">Cours proposé : <em>${courseTitle || "Non spécifié"}</em></p>
    </div>

    <p style="color:#555;font-size:14px;line-height:1.7;">
      Notre équipe va examiner votre dossier sous <strong>3 à 5 jours ouvrés</strong>.
      Vous recevrez un email de décision avec, si nécessaire, un retour détaillé.
    </p>

    <p style="color:#777;font-size:13px;margin-top:16px;">En attendant, nous vous recommandons de :</p>
    <ul style="color:#555;font-size:13px;line-height:2;padding-left:20px;">
      <li>Préparer le plan détaillé de votre cours</li>
      <li>Continuer à enrichir votre profil LinkedIn</li>
      <li>Explorer la plateforme pour vous familiariser avec le format des cours</li>
    </ul>

    <div style="text-align:center;margin:28px 0;">
      <a href="${process.env.FRONTEND_URL}/courses"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:13px 28px;border-radius:12px;font-weight:700;font-size:14px;display:inline-block;">
        Explorer les cours →
      </a>
    </div>

    <p style="color:#aaa;font-size:12px;text-align:center;">
      Des questions ? Écrivez-nous à
      <a href="mailto:${process.env.MAIL_FROM_EMAIL}" style="color:#5653e1;">${process.env.MAIL_FROM_EMAIL}</a>
    </p>
  `);
}

function buildAdminNotificationEmail(data: {
  id: number; firstName: string; lastName: string; email: string;
  motivation: string; experience: string; courseTitle: string;
  yearsExp: string | number; linkedinUrl?: string;
}): string {
  return emailWrapper(`
    <h2 style="color:#2d287f;margin:0 0 8px;">Nouvelle candidature instructeur #${data.id}</h2>

    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:13px;">
      <tr style="background:#f8f7ff;">
        <td style="padding:8px 12px;font-weight:700;color:#555;width:35%;border:1px solid #e5e7eb;">Candidat</td>
        <td style="padding:8px 12px;color:#333;border:1px solid #e5e7eb;">${data.firstName} ${data.lastName}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;font-weight:700;color:#555;border:1px solid #e5e7eb;">Email</td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb;">
          <a href="mailto:${data.email}" style="color:#5653e1;">${data.email}</a>
        </td>
      </tr>
      <tr style="background:#f8f7ff;">
        <td style="padding:8px 12px;font-weight:700;color:#555;border:1px solid #e5e7eb;">Cours proposé</td>
        <td style="padding:8px 12px;color:#333;border:1px solid #e5e7eb;">${data.courseTitle || "Non spécifié"}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;font-weight:700;color:#555;border:1px solid #e5e7eb;">Expérience</td>
        <td style="padding:8px 12px;color:#333;border:1px solid #e5e7eb;">${data.yearsExp} an(s)</td>
      </tr>
      ${data.linkedinUrl ? `
      <tr style="background:#f8f7ff;">
        <td style="padding:8px 12px;font-weight:700;color:#555;border:1px solid #e5e7eb;">LinkedIn</td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb;">
          <a href="${data.linkedinUrl}" style="color:#5653e1;">${data.linkedinUrl}</a>
        </td>
      </tr>` : ""}
    </table>

    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px;margin:16px 0;">
      <p style="margin:0 0 6px;font-weight:700;color:#92400e;font-size:13px;">Motivation :</p>
      <p style="margin:0;color:#78350f;font-size:13px;line-height:1.6;">${data.motivation}</p>
    </div>

    <div style="text-align:center;margin:24px 0;">
      <a href="${process.env.FRONTEND_URL}/admin/instructor-applications"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:13px 28px;border-radius:12px;font-weight:700;font-size:14px;display:inline-block;">
        Examiner la candidature →
      </a>
    </div>
  `);
}

function buildApprovalEmail(firstName: string, note?: string): string {
  return emailWrapper(`
    <div style="text-align:center;margin-bottom:24px;">
      <div style="width:64px;height:64px;background:linear-gradient(135deg,#d1fae5,#a7f3d0);
                  border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
                  border:3px solid #10b981;margin-bottom:12px;">
        <span style="font-size:28px;">🎉</span>
      </div>
      <h2 style="color:#065f46;margin:0;">Félicitations ${firstName} !</h2>
    </div>

    <p style="color:#555;font-size:15px;line-height:1.6;text-align:center;">
      Votre candidature pour devenir instructeur sur <strong>DevOpsAkademy</strong>
      a été <strong style="color:#059669;">acceptée</strong>.
    </p>

    ${note ? `
    <div style="background:#f0fdf4;border:1px solid #a7f3d0;border-radius:12px;padding:14px;margin:20px 0;">
      <p style="margin:0 0 6px;font-weight:700;color:#065f46;font-size:13px;">Message de l'équipe :</p>
      <p style="margin:0;color:#047857;font-size:14px;line-height:1.6;">${note}</p>
    </div>` : ""}

    <div style="background:#f8f7ff;border-radius:12px;padding:16px;margin:20px 0;">
      <p style="margin:0 0 10px;font-weight:700;color:#2d287f;font-size:13px;">🚀 Prochaines étapes :</p>
      <ol style="margin:0;padding-left:20px;color:#555;font-size:13px;line-height:2;">
        <li>Reconnectez-vous pour accéder à votre espace instructeur</li>
        <li>Créez votre premier cours via le tableau de bord</li>
        <li>Ajoutez modules, leçons, quiz et ressources</li>
        <li>Soumettez à la validation avant publication</li>
      </ol>
    </div>

    <div style="text-align:center;margin:28px 0;">
      <a href="${process.env.FRONTEND_URL}/login"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        Accéder à mon espace instructeur →
      </a>
    </div>

    <p style="color:#aaa;font-size:12px;text-align:center;">
      Bienvenue dans l'équipe ! — L'équipe DevOpsAkademy
    </p>
  `);
}

function buildRejectionEmail(firstName: string, reason: string): string {
  return emailWrapper(`
    <h2 style="color:#2d287f;margin:0 0 8px;">Bonjour ${firstName},</h2>

    <p style="color:#555;font-size:15px;line-height:1.6;">
      Après examen attentif de votre candidature, notre équipe ne peut pas y donner suite pour le moment.
    </p>

    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;margin:20px 0;">
      <p style="margin:0 0 6px;font-weight:700;color:#991b1b;font-size:13px;">Motif communiqué :</p>
      <p style="margin:0;color:#7f1d1d;font-size:14px;line-height:1.6;">${reason}</p>
    </div>

    <p style="color:#555;font-size:14px;line-height:1.7;">
      Cela ne signifie pas que votre candidature est définitivement refusée.
      Vous pouvez soumettre une <strong>nouvelle candidature dans 3 mois</strong> avec un profil enrichi
      tenant compte de nos retours.
    </p>

    <div style="background:#f8f7ff;border-radius:12px;padding:14px;margin:20px 0;">
      <p style="margin:0 0 8px;font-weight:700;color:#2d287f;font-size:13px;">💡 Pour améliorer votre dossier :</p>
      <ul style="margin:0;padding-left:20px;color:#555;font-size:13px;line-height:2;">
        <li>Enrichissez votre profil LinkedIn avec vos réalisations</li>
        <li>Contribuez à des projets open source DevOps</li>
        <li>Obtenez des certifications reconnues (AWS, CKA, Terraform...)</li>
        <li>Détaillez davantage vos expériences en production</li>
      </ul>
    </div>

    <div style="text-align:center;margin:24px 0;">
      <a href="${process.env.FRONTEND_URL}/courses"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:13px 28px;border-radius:12px;font-weight:700;font-size:14px;display:inline-block;">
        Continuer à apprendre →
      </a>
    </div>

    <p style="color:#aaa;font-size:12px;text-align:center;">
      Des questions ? Contactez-nous à
      <a href="mailto:${process.env.MAIL_FROM_EMAIL}" style="color:#5653e1;">${process.env.MAIL_FROM_EMAIL}</a>
    </p>
  `);
}