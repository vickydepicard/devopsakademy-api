// src/controllers/coInstructorController.ts — DevOpsAkademy
// Gestion des co-instructeurs sur un cours
// - Propriétaire du cours OU admin peut inviter / configurer
// - L'instructeur invité peut accepter ou refuser

import { Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { sendCoInstructorInviteEmail } from "../services/mail.service";
import { getUserLang } from "../utils/lang";
import { createNotification } from "../services/notification.service";
import { tr } from "../utils/lang";

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
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
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

    if (!instructor_id) return res.status(400).json({ success: false, message: tr(req, "instructor_id requis", "instructor_id required") });
    const rate = Number(commission_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ success: false, message: tr(req, "La commission doit être comprise entre 0 et 100 %", "The commission must be between 0 and 100%") });
    }

    if (!(await isOwnerOrAdmin(userId, role, courseId))) {
      return res.status(403).json({ success: false, message: tr(req, "Seul le propriétaire ou un admin peut inviter un co-instructeur", "Only the owner or an admin can invite a co-instructor") });
    }

    // Vérifier que c'est bien un instructeur actif
    const [target]: any = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role FROM users u
        WHERE u.id = ? AND u.role = 'instructor' AND u.is_active = 1
          AND EXISTS (SELECT 1 FROM instructor_applications ia WHERE ia.user_id = u.id AND ia.status = 'accepted')`,
      [instructor_id]
    );
    if (!target) return res.status(404).json({ success: false, message: tr(req, "Instructeur introuvable ou inactif", "Instructor not found or inactive") });

    // Vérifier pas déjà co-instructeur
    const [existing]: any = await query(
      "SELECT id FROM course_instructors WHERE course_id = ? AND instructor_id = ?",
      [courseId, instructor_id]
    );
    if (existing) return res.status(409).json({ success: false, message: tr(req, "Cet instructeur est déjà sur ce cours", "This instructor is already on this course") });

    // Récupérer le cours
    const [course]: any = await query(
      "SELECT title, instructor_id FROM courses WHERE id = ?", [courseId]
    );
    if (!course) return res.status(404).json({ success: false, message: tr(req, "Cours introuvable", "Course not found") });

    // Vérifier que ce n'est pas le propriétaire du cours
    if (course.instructor_id === parseInt(instructor_id)) {
      return res.status(400).json({ success: false, message: tr(req, "Le propriétaire du cours ne peut pas être co-instructeur", "The course owner cannot be a co-instructor") });
    }

    await query(
      `INSERT INTO course_instructors (course_id, instructor_id, added_by, commission_rate, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [courseId, instructor_id, userId, rate]
    );

    // Notification in-app (non bloquante)
    void createNotification(Number(target.id), {
      type: "info",
      title: `Invitation co-instructeur — ${course.title}`,
      message: `Vous êtes invité(e) à rejoindre « ${course.title} » (commission ${rate}%).`,
      link: "/instructor",
    }).catch(() => {});

    // Notifier le co-instructeur par email
    await sendCoInstructorInviteEmail(target.email, target.first_name, course.title, rate, await getUserLang(target.email))
      .catch((e: any) => console.warn("Email co-instructor:", e.message));

    return res.status(201).json({ success: true, message: tr(req, `${target.first_name} a été invité(e) comme co-instructeur.`, `${target.first_name} has been invited as a co-instructor.`) });
  } catch (error) {
    console.error("addCoInstructor:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
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
      return res.status(403).json({ success: false, message: tr(req, "Non autorisé", "Not authorized") });
    }

    const newRate = Number(commission_rate);
    if (!Number.isFinite(newRate) || newRate < 0 || newRate > 100) {
      return res.status(400).json({ success: false, message: tr(req, "La commission doit être comprise entre 0 et 100 %", "The commission must be between 0 and 100%") });
    }
    await query(
      "UPDATE course_instructors SET commission_rate = ? WHERE id = ? AND course_id = ?",
      [newRate, coInstructorId, courseId]
    );

    return res.json({ success: true, message: tr(req, "Commission mise à jour.", "Commission updated.") });
  } catch (error) {
    console.error("updateCoInstructorCommission:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
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
    if (!entry) return res.status(404).json({ success: false, message: tr(req, "Entrée introuvable", "Entry not found") });

    // Peut supprimer : admin, propriétaire du cours, ou l'instructeur lui-même
    const isSelf  = entry.instructor_id === userId;
    const isOwner = await isOwnerOrAdmin(userId, role, courseId);
    if (!isSelf && !isOwner) {
      return res.status(403).json({ success: false, message: tr(req, "Non autorisé", "Not authorized") });
    }

    await query("DELETE FROM course_instructors WHERE id = ?", [coInstructorId]);
    return res.json({ success: true, message: tr(req, "Co-instructeur retiré.", "Co-instructor removed.") });
  } catch (error) {
    console.error("removeCoInstructor:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
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
      return res.status(400).json({ success: false, message: tr(req, "action doit être 'accept' ou 'reject'", "action must be 'accept' or 'reject'") });
    }

    const [entry]: any = await query(
      "SELECT ci.*, c.title FROM course_instructors ci JOIN courses c ON c.id = ci.course_id WHERE ci.id = ? AND ci.instructor_id = ?",
      [coInstructorId, userId]
    );
    if (!entry) return res.status(404).json({ success: false, message: tr(req, "Invitation introuvable", "Invitation not found") });
    if (entry.status !== "pending") return res.status(409).json({ success: false, message: tr(req, "Invitation déjà traitée", "Invitation already processed") });

    const newStatus = action === "accept" ? "accepted" : "rejected";
    await query(
      "UPDATE course_instructors SET status = ?, responded_at = NOW() WHERE id = ?",
      [newStatus, coInstructorId]
    );

    return res.json({
      success: true,
      message: action === "accept"
        ? tr(req, `Vous avez accepté d'être co-instructeur sur "${entry.title}".`, `You accepted to be a co-instructor on "${entry.title}".`)
        : tr(req, `Vous avez décliné l'invitation sur "${entry.title}".`, `You declined the invitation to "${entry.title}".`),
    });
  } catch (error) {
    console.error("respondToInvitation:", error);
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
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
    return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};