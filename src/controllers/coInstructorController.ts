// src/controllers/coInstructorController.ts — DevOpsAkademy
// Gestion des co-instructeurs sur un cours
// - Propriétaire du cours OU admin peut inviter / configurer
// - L'instructeur invité peut accepter ou refuser

import { Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { sendEmail } from "../services/mail.service";

const FE = () => process.env.FRONTEND_URL || "http://localhost:3000";

// ── Vérifier que l'user est propriétaire ou admin ───────────
const isOwnerOrAdmin = async (userId: number, role: string, courseId: number) => {
  if (role === "admin" || role === "superadmin") return true;
  const [course]: any = await query(
    "SELECT id FROM courses WHERE id = ? AND instructor_id = ?", [courseId, userId]
  );
  return !!course;
};

// ══════════════════════════════════════════════════════════════
// GET /api/courses/:courseId/co-instructors
// Liste les co-instructeurs d'un cours
// ══════════════════════════════════════════════════════════════
export const getCourseCoInstructors = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const courseId = parseInt(req.params.courseId || req.params.id);
    const list: any[] = await query(
      `SELECT ci.id, ci.commission_rate, ci.status, ci.invited_at, ci.responded_at,
              u.id AS instructor_id, u.first_name, u.last_name, u.email,
              up.avatar_url, up.job_title,
              ab.first_name AS added_by_first, ab.last_name AS added_by_last
       FROM course_instructors ci
       JOIN users u ON u.id = ci.instructor_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       JOIN users ab ON ab.id = ci.added_by
       WHERE ci.course_id = ?
       ORDER BY ci.created_at ASC`,
      [courseId]
    );
    return res.json({ success: true, data: list });
  } catch (error) {
    console.error("getCourseCoInstructors:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ══════════════════════════════════════════════════════════════
// POST /api/courses/:courseId/co-instructors
// Inviter un co-instructeur (propriétaire ou admin)
// Body: { instructor_id, commission_rate }
// ══════════════════════════════════════════════════════════════
export const addCoInstructor = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId    = req.user!.id;
    const role      = req.user!.role;
    const courseId  = parseInt(req.params.courseId || req.params.id);
    const { instructor_id, commission_rate = 0 } = req.body;

    if (!instructor_id) return res.status(400).json({ success: false, message: "instructor_id requis" });

    if (!(await isOwnerOrAdmin(userId, role, courseId))) {
      return res.status(403).json({ success: false, message: "Seul le propriétaire ou un admin peut inviter un co-instructeur" });
    }

    // Vérifier que c'est bien un instructeur actif
    const [target]: any = await query(
      "SELECT id, first_name, last_name, email, role FROM users WHERE id = ? AND role = 'instructor' AND is_active = 1",
      [instructor_id]
    );
    if (!target) return res.status(404).json({ success: false, message: "Instructeur introuvable ou inactif" });

    // Vérifier pas déjà co-instructeur
    const [existing]: any = await query(
      "SELECT id FROM course_instructors WHERE course_id = ? AND instructor_id = ?",
      [courseId, instructor_id]
    );
    if (existing) return res.status(409).json({ success: false, message: "Cet instructeur est déjà sur ce cours" });

    // Récupérer le cours
    const [course]: any = await query(
      "SELECT title, instructor_id FROM courses WHERE id = ?", [courseId]
    );
    if (!course) return res.status(404).json({ success: false, message: "Cours introuvable" });

    // Vérifier que ce n'est pas le propriétaire du cours
    if (course.instructor_id === parseInt(instructor_id)) {
      return res.status(400).json({ success: false, message: "Le propriétaire du cours ne peut pas être co-instructeur" });
    }

    await query(
      `INSERT INTO course_instructors (course_id, instructor_id, added_by, commission_rate, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [courseId, instructor_id, userId, parseFloat(commission_rate) || 0]
    );

    // Notifier le co-instructeur par email
    await sendEmail({
      to: target.email,
      subject: `🎓 Invitation co-instructeur — ${course.title}`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f3fb;padding:20px;">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(45,40,127,0.1);">
  <div style="background:linear-gradient(135deg,#2d287f,#5653e1);padding:24px;text-align:center;">
    <p style="margin:0;color:#facc15;font-size:20px;font-weight:900;">DevOps Akademy</p>
  </div>
  <div style="padding:28px;">
    <h2 style="color:#2d287f;margin:0 0 12px;">Bonjour ${target.first_name} 👋</h2>
    <p style="color:#555;font-size:14px;line-height:1.7;">
      Vous avez été invité(e) à devenir <strong>co-instructeur</strong> sur le cours :
    </p>
    <div style="background:#f8f7ff;border:1px solid #e0e7ff;border-radius:10px;padding:14px;margin:14px 0;">
      <p style="margin:0;font-size:15px;font-weight:700;color:#2d287f;">${course.title}</p>
      <p style="margin:4px 0 0;font-size:13px;color:#6366f1;">Commission : ${commission_rate}% sur chaque vente</p>
    </div>
    <p style="color:#555;font-size:13px;">Connectez-vous pour accepter ou refuser cette invitation.</p>
    <div style="text-align:center;margin:20px 0;">
      <a href="${FE()}/instructor" style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:13px;display:inline-block;">
        Voir l'invitation →
      </a>
    </div>
  </div>
</div></body></html>`,
    }).catch((e: any) => console.warn("Email co-instructor:", e.message));

    return res.status(201).json({ success: true, message: `${target.first_name} a été invité(e) comme co-instructeur.` });
  } catch (error) {
    console.error("addCoInstructor:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /api/courses/:courseId/co-instructors/:coInstructorId
// Modifier la commission (propriétaire ou admin)
// Body: { commission_rate }
// ══════════════════════════════════════════════════════════════
export const updateCoInstructorCommission = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId         = req.user!.id;
    const role           = req.user!.role;
    const courseId       = parseInt(req.params.courseId);
    const coInstructorId = parseInt(req.params.coInstructorId);
    const { commission_rate } = req.body;

    if (!(await isOwnerOrAdmin(userId, role, courseId))) {
      return res.status(403).json({ success: false, message: "Non autorisé" });
    }

    await query(
      "UPDATE course_instructors SET commission_rate = ? WHERE id = ? AND course_id = ?",
      [parseFloat(commission_rate) || 0, coInstructorId, courseId]
    );

    return res.json({ success: true, message: "Commission mise à jour." });
  } catch (error) {
    console.error("updateCoInstructorCommission:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ══════════════════════════════════════════════════════════════
// DELETE /api/courses/:courseId/co-instructors/:coInstructorId
// Retirer un co-instructeur (propriétaire, admin, ou lui-même)
// ══════════════════════════════════════════════════════════════
export const removeCoInstructor = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId         = req.user!.id;
    const role           = req.user!.role;
    const courseId       = parseInt(req.params.courseId);
    const coInstructorId = parseInt(req.params.coInstructorId);

    const [entry]: any = await query(
      "SELECT * FROM course_instructors WHERE id = ? AND course_id = ?",
      [coInstructorId, courseId]
    );
    if (!entry) return res.status(404).json({ success: false, message: "Entrée introuvable" });

    // Peut supprimer : admin, propriétaire du cours, ou l'instructeur lui-même
    const isSelf  = entry.instructor_id === userId;
    const isOwner = await isOwnerOrAdmin(userId, role, courseId);
    if (!isSelf && !isOwner) {
      return res.status(403).json({ success: false, message: "Non autorisé" });
    }

    await query("DELETE FROM course_instructors WHERE id = ?", [coInstructorId]);
    return res.json({ success: true, message: "Co-instructeur retiré." });
  } catch (error) {
    console.error("removeCoInstructor:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /api/instructor/invitations/:coInstructorId/respond
// L'instructeur répond à une invitation (accept/reject)
// Body: { action: 'accept' | 'reject' }
// ══════════════════════════════════════════════════════════════
export const respondToInvitation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId         = req.user!.id;
    const coInstructorId = parseInt(req.params.coInstructorId);
    const { action }     = req.body;

    if (!["accept", "reject"].includes(action)) {
      return res.status(400).json({ success: false, message: "action doit être 'accept' ou 'reject'" });
    }

    const [entry]: any = await query(
      "SELECT ci.*, c.title FROM course_instructors ci JOIN courses c ON c.id = ci.course_id WHERE ci.id = ? AND ci.instructor_id = ?",
      [coInstructorId, userId]
    );
    if (!entry) return res.status(404).json({ success: false, message: "Invitation introuvable" });
    if (entry.status !== "pending") return res.status(409).json({ success: false, message: "Invitation déjà traitée" });

    const newStatus = action === "accept" ? "accepted" : "rejected";
    await query(
      "UPDATE course_instructors SET status = ?, responded_at = NOW() WHERE id = ?",
      [newStatus, coInstructorId]
    );

    return res.json({
      success: true,
      message: action === "accept"
        ? `Vous avez accepté d'être co-instructeur sur "${entry.title}".`
        : `Vous avez décliné l'invitation sur "${entry.title}".`,
    });
  } catch (error) {
    console.error("respondToInvitation:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ══════════════════════════════════════════════════════════════
// GET /api/instructor/invitations
// Invitations en attente pour l'instructeur connecté
// ══════════════════════════════════════════════════════════════
export const getMyInvitations = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const invitations: any[] = await query(
      `SELECT ci.id, ci.commission_rate, ci.status, ci.invited_at,
              c.id AS course_id, c.title, c.thumbnail_url, c.slug,
              u.first_name AS owner_first, u.last_name AS owner_last
       FROM course_instructors ci
       JOIN courses c ON c.id = ci.course_id
       JOIN users u ON u.id = c.instructor_id
       WHERE ci.instructor_id = ?
       ORDER BY ci.invited_at DESC`,
      [userId]
    );
    return res.json({ success: true, data: invitations });
  } catch (error) {
    console.error("getMyInvitations:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};