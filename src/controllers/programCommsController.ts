// src/controllers/programCommsController.ts
// Messagerie admin ↔ instructeur, annonces, demandes de collaboration, performance,
// liste de surveillance, journal d'audit et grille de relecture des cours.
import { Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { fail, serverError, logAudit } from "../utils/respond";
import { parseId, parseJson } from "../utils/serialize";
import { defaultCommissionRate } from "../services/commission.service";
import { notifyAdmins } from "../services/notification.service";
import { ensureProgramTables, notifyUser, plain, num, ACTIVE_INSTRUCTOR_SQL } from "./programSetup";
import { computeOnboarding } from "./programOnboardingController";

type Req = AuthenticatedRequest;

const nameOf = (u: any) => `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim();

// ══════════════════════════════════════════════════════
// MESSAGERIE (un fil par instructeur)
// ══════════════════════════════════════════════════════
const cleanBody = (v: any) => String(v ?? "").trim().slice(0, 4000);

// GET /messages (instructeur) — marque les messages de l'équipe comme lus
export const getMyMessages = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = req.user!.id;
    const rows: any[] = await query(
      `SELECT m.id, m.sender_role, m.body, m.created_at, u.first_name FROM instructor_messages m
         LEFT JOIN users u ON u.id = m.sender_id WHERE m.instructor_id = ? ORDER BY m.created_at ASC, m.id ASC LIMIT 500`, [id]);
    await query("UPDATE instructor_messages SET read_at = NOW() WHERE instructor_id = ? AND sender_role = 'admin' AND read_at IS NULL", [id]);
    return res.json({ success: true, data: plain(rows) });
  } catch (e) { return serverError(req, res, "getMyMessages", e); }
};

// POST /messages (instructeur)
export const sendMyMessage = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const body = cleanBody(req.body?.body);
    if (!body) return fail(req, res, 400, "Message vide", "Empty message");
    const [{ n }]: any = await query("SELECT COUNT(*) AS n FROM instructor_messages WHERE instructor_id = ? AND sender_role = 'instructor' AND created_at > NOW() - INTERVAL 1 HOUR", [req.user!.id]);
    if (num(n) >= 30) return fail(req, res, 429, "Trop de messages, réessayez plus tard.", "Too many messages, try again later.");
    const r: any = await query("INSERT INTO instructor_messages (instructor_id, sender_id, sender_role, body) VALUES (?, ?, 'instructor', ?)", [req.user!.id, req.user!.id, body]);
    void notifyAdmins({
      type: "info", title: `Message d'instructeur — ${nameOf(req.user)}`, message: body.slice(0, 200),
      link: "/admin/instructor-program?tab=messages", data: { instructor_id: req.user!.id },
    });
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "sendMyMessage", e); }
};

// GET /admin/messages — boîte de réception : un fil par instructeur
export const adminInbox = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email,
              (SELECT m.body FROM instructor_messages m WHERE m.instructor_id = u.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
              (SELECT m.sender_role FROM instructor_messages m WHERE m.instructor_id = u.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender,
              (SELECT MAX(m.created_at) FROM instructor_messages m WHERE m.instructor_id = u.id) AS last_at,
              (SELECT COUNT(*) FROM instructor_messages m WHERE m.instructor_id = u.id AND m.sender_role = 'instructor' AND m.read_at IS NULL) AS unread
         FROM users u WHERE u.role = 'instructor' AND EXISTS (SELECT 1 FROM instructor_messages m WHERE m.instructor_id = u.id)
        ORDER BY last_at DESC LIMIT 200`);
    return res.json({ success: true, data: plain(rows.map((r) => ({ ...r, unread: num(r.unread) }))) });
  } catch (e) { return serverError(req, res, "adminInbox", e); }
};

// GET /admin/instructors/:id/messages
export const adminGetThread = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    const rows: any[] = await query(
      `SELECT m.id, m.sender_role, m.body, m.created_at, u.first_name, u.last_name FROM instructor_messages m
         LEFT JOIN users u ON u.id = m.sender_id WHERE m.instructor_id = ? ORDER BY m.created_at ASC, m.id ASC LIMIT 500`, [id]);
    await query("UPDATE instructor_messages SET read_at = NOW() WHERE instructor_id = ? AND sender_role = 'instructor' AND read_at IS NULL", [id]);
    return res.json({ success: true, data: plain(rows) });
  } catch (e) { return serverError(req, res, "adminGetThread", e); }
};

// POST /admin/instructors/:id/messages
export const adminSendMessage = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [u]: any = id ? await query("SELECT id FROM users WHERE id = ? AND role = 'instructor'", [id]) : [];
    if (!u) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    const body = cleanBody(req.body?.body);
    if (!body) return fail(req, res, 400, "Message vide", "Empty message");
    const r: any = await query("INSERT INTO instructor_messages (instructor_id, sender_id, sender_role, body) VALUES (?, ?, 'admin', ?)", [id, req.user!.id, body]);
    void notifyUser(id!, {
      type: "info",
      fr: { title: "Nouveau message de l'équipe DevOpsAkademy", body },
      en: { title: "New message from the DevOpsAkademy team", body },
      link: "/instructor/messages",
      email: { ctaFr: "Lire et répondre", ctaEn: "Read and reply" },
    });
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "adminSendMessage", e); }
};

// ══════════════════════════════════════════════════════
// ANNONCES
// ══════════════════════════════════════════════════════
// POST /admin/announcements { title, body, tier_id?, send_email }
export const adminCreateAnnouncement = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const title = String(req.body?.title ?? "").trim().slice(0, 200);
    const body = cleanBody(req.body?.body);
    if (title.length < 3 || body.length < 5) return fail(req, res, 400, "Titre et message requis.", "Title and message are required.");
    const tierId = req.body?.tier_id ? parseId(req.body.tier_id) : null;
    const sendEmail = req.body?.send_email ? 1 : 0;

    const tierFilter = tierId ? "AND EXISTS (SELECT 1 FROM instructor_tier_assignments a WHERE a.user_id = u.id AND a.tier_id = ?)" : "";
    const recipients: any[] = await query(`SELECT u.id FROM users u WHERE ${ACTIVE_INSTRUCTOR_SQL} ${tierFilter}`, tierId ? [tierId] : []);
    if (!recipients.length) return fail(req, res, 409, "Aucun instructeur actif ne correspond à ce public.", "No active instructor matches this audience.");

    const r: any = await query("INSERT INTO instructor_announcements (title, body, tier_id, send_email, created_by) VALUES (?, ?, ?, ?, ?)", [title, body, tierId, sendEmail, req.user!.id]);
    const aid = Number(r.insertId);
    for (const rc of recipients) {
      await query("INSERT IGNORE INTO instructor_announcement_reads (announcement_id, user_id) VALUES (?, ?)", [aid, rc.id]);
      void notifyUser(Number(rc.id), {
        type: "info",
        fr: { title: `Annonce : ${title}`, body },
        en: { title: `Announcement: ${title}`, body },
        link: "/instructor/messages",
        email: sendEmail ? { ctaFr: "Voir l'annonce", ctaEn: "View announcement" } : undefined,
      });
    }
    await logAudit(req, "admin", "instructor.announcement_sent", "user", null, null, { id: aid, title, recipients: recipients.length, tier_id: tierId });
    return res.status(201).json({ success: true, data: { id: aid, recipients: recipients.length } });
  } catch (e) { return serverError(req, res, "adminCreateAnnouncement", e); }
};

// GET /admin/announcements
export const adminListAnnouncements = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT a.id, a.title, a.body, a.tier_id, a.send_email, a.created_at, t.name_fr AS tier_name,
              (SELECT COUNT(*) FROM instructor_announcement_reads r WHERE r.announcement_id = a.id) AS recipients,
              (SELECT COUNT(*) FROM instructor_announcement_reads r WHERE r.announcement_id = a.id AND r.read_at IS NOT NULL) AS read_total
         FROM instructor_announcements a LEFT JOIN instructor_tiers t ON t.id = a.tier_id ORDER BY a.id DESC LIMIT 50`);
    return res.json({ success: true, data: plain(rows) });
  } catch (e) { return serverError(req, res, "adminListAnnouncements", e); }
};

// GET /announcements (instructeur)
export const getMyAnnouncements = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT a.id, a.title, a.body, a.created_at, r.read_at FROM instructor_announcement_reads r
         JOIN instructor_announcements a ON a.id = r.announcement_id WHERE r.user_id = ? ORDER BY a.id DESC LIMIT 50`, [req.user!.id]);
    return res.json({ success: true, data: plain(rows) });
  } catch (e) { return serverError(req, res, "getMyAnnouncements", e); }
};

// POST /announcements/:id/read
export const markAnnouncementRead = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    await query("UPDATE instructor_announcement_reads SET read_at = COALESCE(read_at, NOW()) WHERE announcement_id = ? AND user_id = ?", [req.params.id, req.user!.id]);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "markAnnouncementRead", e); }
};

// GET /inbox/summary (instructeur) — pastilles du menu
export const getInboxSummary = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const [m]: any = await query("SELECT COUNT(*) AS n FROM instructor_messages WHERE instructor_id = ? AND sender_role = 'admin' AND read_at IS NULL", [req.user!.id]);
    const [a]: any = await query("SELECT COUNT(*) AS n FROM instructor_announcement_reads WHERE user_id = ? AND read_at IS NULL", [req.user!.id]);
    const [c]: any = await query("SELECT COUNT(*) AS n FROM course_collab_requests WHERE applicant_id = ? AND status IN ('accepted','declined') AND decided_at > NOW() - INTERVAL 7 DAY", [req.user!.id]);
    return res.json({ success: true, data: { messages: num(m?.n), announcements: num(a?.n), collab_updates: num(c?.n) } });
  } catch (e) { return serverError(req, res, "getInboxSummary", e); }
};

// ══════════════════════════════════════════════════════
// COLLABORATIONS (co-instructeur / assistant)
// ══════════════════════════════════════════════════════
// GET /collab/courses?search=
export const collabSearchCourses = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const me = req.user!.id;
    const search = String(req.query.search ?? "").trim().slice(0, 80);
    const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
    const rows: any[] = await query(
      `SELECT c.id, c.title, cat.name AS category_name, u.first_name, u.last_name
         FROM courses c JOIN users u ON u.id = c.instructor_id LEFT JOIN course_categories cat ON cat.id = c.category_id
        WHERE c.is_published = 1 AND c.instructor_id <> ?
          AND NOT EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ? AND ci.status IN ('accepted','pending'))
          AND NOT EXISTS (SELECT 1 FROM course_collab_requests r WHERE r.course_id = c.id AND r.applicant_id = ? AND r.status = 'pending')
          ${search ? "AND c.title LIKE ?" : ""}
        ORDER BY c.title LIMIT 30`,
      search ? [me, me, me, like] : [me, me, me]);
    return res.json({ success: true, data: plain(rows) });
  } catch (e) { return serverError(req, res, "collabSearchCourses", e); }
};

// POST /collab/requests { course_id, role, message }
export const collabCreateRequest = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const me = req.user!.id;
    const courseId = parseId(req.body?.course_id);
    const role = req.body?.role === "co_instructor" ? "co_instructor" : "assistant";
    const message = String(req.body?.message ?? "").trim().slice(0, 1500);
    if (message.length < 10) return fail(req, res, 400, "Expliquez en quelques lignes ce que vous apporteriez (10 caractères min.).", "Explain briefly what you would bring (10 characters min.).", { errors: { message: "required" } });
    const [course]: any = courseId ? await query("SELECT id, title, instructor_id FROM courses WHERE id = ? AND is_published = 1", [courseId]) : [];
    if (!course) return fail(req, res, 404, "Cours introuvable", "Course not found");
    if (Number(course.instructor_id) === me) return fail(req, res, 400, "Vous êtes déjà l'auteur de ce cours.", "You are already the author of this course.");
    const [member]: any = await query("SELECT id FROM course_instructors WHERE course_id = ? AND instructor_id = ? AND status IN ('accepted','pending')", [courseId, me]);
    if (member) return fail(req, res, 409, "Vous faites déjà partie de l'équipe de ce cours.", "You are already part of this course's team.");
    const [pend]: any = await query("SELECT id FROM course_collab_requests WHERE course_id = ? AND applicant_id = ? AND status = 'pending'", [courseId, me]);
    if (pend) return fail(req, res, 409, "Vous avez déjà une demande en cours pour ce cours.", "You already have a pending request for this course.");
    const [{ n }]: any = await query("SELECT COUNT(*) AS n FROM course_collab_requests WHERE applicant_id = ? AND status = 'pending'", [me]);
    if (num(n) >= 5) return fail(req, res, 429, "Maximum 5 demandes en attente.", "Maximum 5 pending requests.");

    const r: any = await query("INSERT INTO course_collab_requests (course_id, applicant_id, role, message) VALUES (?, ?, ?, ?)", [courseId, me, role, message]);
    void notifyAdmins({
      type: "info", title: `Demande de collaboration — ${course.title}`,
      message: `${nameOf(req.user)} souhaite rejoindre ce cours (${role === "assistant" ? "assistant" : "co-instructeur"}).`,
      link: "/admin/instructor-program?tab=collab",
    });
    void notifyUser(Number(course.instructor_id), {
      type: "info",
      fr: { title: "Demande de collaboration sur votre cours", body: `${nameOf(req.user)} souhaite rejoindre « ${course.title} ». L'équipe DevOpsAkademy étudie la demande.` },
      en: { title: "Collaboration request on your course", body: `${nameOf(req.user)} would like to join “${course.title}”. The DevOpsAkademy team is reviewing the request.` },
      link: "/instructor/courses",
    });
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "collabCreateRequest", e); }
};

// GET /collab/requests (mes demandes)
export const collabMyRequests = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT r.id, r.role, r.message, r.status, r.response_note, r.created_at, r.decided_at, c.title AS course_title
         FROM course_collab_requests r JOIN courses c ON c.id = r.course_id WHERE r.applicant_id = ? ORDER BY r.id DESC LIMIT 50`, [req.user!.id]);
    return res.json({ success: true, data: plain(rows) });
  } catch (e) { return serverError(req, res, "collabMyRequests", e); }
};

// DELETE /collab/requests/:id
export const collabWithdraw = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const r: any = await query("UPDATE course_collab_requests SET status = 'withdrawn', decided_at = NOW() WHERE id = ? AND applicant_id = ? AND status = 'pending'", [req.params.id, req.user!.id]);
    if (!Number(r?.affectedRows)) return fail(req, res, 404, "Demande introuvable", "Request not found");
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "collabWithdraw", e); }
};

// GET /admin/collab?status=pending|all
export const adminCollabList = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const status = String(req.query.status ?? "pending");
    const rows: any[] = await query(
      `SELECT r.id, r.role, r.message, r.status, r.response_note, r.created_at, r.decided_at,
              c.id AS course_id, c.title AS course_title, c.instructor_commission_rate,
              a.id AS applicant_id, a.first_name AS applicant_first_name, a.last_name AS applicant_last_name, a.email AS applicant_email,
              o.first_name AS owner_first_name, o.last_name AS owner_last_name
         FROM course_collab_requests r
         JOIN courses c ON c.id = r.course_id JOIN users a ON a.id = r.applicant_id JOIN users o ON o.id = c.instructor_id
        ${status === "all" ? "" : "WHERE r.status = ?"} ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT 100`,
      status === "all" ? [] : [status]);
    return res.json({ success: true, data: plain(rows), default_rate: defaultCommissionRate() });
  } catch (e) { return serverError(req, res, "adminCollabList", e); }
};

// POST /admin/collab/:id/decide { decision: 'accept'|'decline', commission_rate?, can_edit_content?, note? }
export const adminCollabDecide = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [r]: any = id ? await query(
      `SELECT r.*, c.title, c.instructor_id, c.instructor_commission_rate FROM course_collab_requests r JOIN courses c ON c.id = r.course_id WHERE r.id = ?`, [id]) : [];
    if (!r) return fail(req, res, 404, "Demande introuvable", "Request not found");
    if (r.status !== "pending") return fail(req, res, 409, "Cette demande est déjà traitée.", "This request has already been handled.");
    const note = String(req.body?.note ?? "").trim().slice(0, 500) || null;

    if (req.body?.decision === "decline") {
      await query("UPDATE course_collab_requests SET status = 'declined', response_note = ?, decided_by = ?, decided_at = NOW() WHERE id = ?", [note, req.user!.id, id]);
      void notifyUser(Number(r.applicant_id), {
        type: "warning",
        fr: { title: "Demande de collaboration refusée", body: `Votre demande pour « ${r.title} » n'a pas été retenue.${note ? `\nMotif : ${note}` : ""}` },
        en: { title: "Collaboration request declined", body: `Your request for “${r.title}” was not accepted.${note ? `\nReason: ${note}` : ""}` },
        link: "/instructor/collaborations",
      });
      await logAudit(req, "admin", "instructor.collab_declined", "user", Number(r.applicant_id), null, { course_id: Number(r.course_id), note });
      return res.json({ success: true });
    }
    if (req.body?.decision !== "accept") return fail(req, res, 400, "Décision invalide", "Invalid decision");

    const rateRaw = req.body?.commission_rate === undefined || req.body?.commission_rate === "" ? 0 : Number(String(req.body.commission_rate).replace(",", "."));
    if (!Number.isFinite(rateRaw) || rateRaw < 0 || rateRaw > 100) return fail(req, res, 400, "Le pourcentage doit être compris entre 0 et 100.", "The percentage must be between 0 and 100.", { errors: { commission_rate: "invalid" } });
    const pool = r.instructor_commission_rate != null ? num(r.instructor_commission_rate) : defaultCommissionRate();
    const [{ s }]: any = await query("SELECT COALESCE(SUM(commission_rate), 0) AS s FROM course_instructors WHERE course_id = ? AND status = 'accepted'", [r.course_id]);
    if (num(s) + rateRaw > pool)
      return fail(req, res, 400, `Part trop élevée : il reste ${Math.max(pool - num(s), 0)} % à répartir.`, `Share too high: ${Math.max(pool - num(s), 0)}% remains to be split.`, { code: "RATE_EXCEEDS_POOL", available: Math.max(pool - num(s), 0) });
    const [dup]: any = await query("SELECT id FROM course_instructors WHERE course_id = ? AND instructor_id = ?", [r.course_id, r.applicant_id]);
    if (dup) return fail(req, res, 409, "Cet instructeur est déjà assigné à ce cours.", "This instructor is already assigned to this course.");

    await query(
      `INSERT INTO course_instructors (course_id, instructor_id, added_by, commission_rate, can_edit_content, status, responded_at)
       VALUES (?, ?, ?, ?, ?, 'accepted', NOW())`,
      [r.course_id, r.applicant_id, req.user!.id, rateRaw, req.body?.can_edit_content ? 1 : 0]);
    await query("UPDATE course_collab_requests SET status = 'accepted', response_note = ?, decided_by = ?, decided_at = NOW() WHERE id = ?", [note, req.user!.id, id]);
    void notifyUser(Number(r.applicant_id), {
      type: "success",
      fr: { title: "Demande de collaboration acceptée", body: `Vous rejoignez « ${r.title} » (${rateRaw} % des ventes).${note ? `\n${note}` : ""}` },
      en: { title: "Collaboration request accepted", body: `You are joining “${r.title}” (${rateRaw}% of sales).${note ? `\n${note}` : ""}` },
      link: "/instructor/courses",
      email: { ctaFr: "Voir mes cours", ctaEn: "View my courses" },
    });
    void notifyUser(Number(r.instructor_id), {
      type: "info",
      fr: { title: "Nouveau membre dans l'équipe de votre cours", body: `Un instructeur rejoint « ${r.title} ».` },
      en: { title: "New member on your course team", body: `An instructor is joining “${r.title}”.` },
      link: "/instructor/courses",
    });
    await logAudit(req, "admin", "instructor.collab_accepted", "user", Number(r.applicant_id), null, { course_id: Number(r.course_id), rate: rateRaw, role: r.role });
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "adminCollabDecide", e); }
};

// ══════════════════════════════════════════════════════
// PERFORMANCE & SURVEILLANCE
// ══════════════════════════════════════════════════════
// GET /admin/instructors/:id/performance
export const adminPerformance = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [u]: any = id ? await query("SELECT id, last_login, created_at FROM users WHERE id = ? AND role = 'instructor'", [id]) : [];
    if (!u) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");

    const [co]: any = await query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(is_published), 0) AS published,
              COALESCE(SUM(review_status = 'submitted'), 0) AS submitted, MAX(published_at) AS last_published_at, MAX(updated_at) AS last_activity
         FROM courses WHERE instructor_id = ?`, [id]);
    const [st]: any = await query(
      `SELECT COUNT(DISTINCT ce.user_id) AS students,
              COUNT(DISTINCT CASE WHEN ce.enrolled_at > NOW() - INTERVAL 30 DAY THEN ce.user_id END) AS new_30d,
              COALESCE(AVG(ce.completion_percentage), 0) AS avg_completion,
              COALESCE(SUM(ce.completed_at IS NOT NULL), 0) AS completed, COUNT(*) AS enrollments
         FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
        WHERE c.instructor_id = ? AND ce.is_approved = 1 AND ce.payment_status IN ('verified','free')`, [id]);
    const [rv]: any = await query(
      `SELECT COUNT(*) AS reviews, COALESCE(AVG(r.rating), 0) AS avg_rating,
              COALESCE(SUM(r.rating <= 2 AND r.created_at > NOW() - INTERVAL 90 DAY), 0) AS negative_90d
         FROM course_reviews r JOIN courses c ON c.id = r.course_id WHERE c.instructor_id = ? AND r.is_published = 1`, [id]);
    const negatives: any[] = await query(
      `SELECT r.rating, r.comment, r.created_at, c.title AS course_title FROM course_reviews r JOIN courses c ON c.id = r.course_id
        WHERE c.instructor_id = ? AND r.is_published = 1 AND r.rating <= 2 ORDER BY r.created_at DESC LIMIT 5`, [id]);
    const [rev]: any = await query(
      `SELECT COALESCE(SUM(commission_amount), 0) AS total,
              COALESCE(SUM(CASE WHEN COALESCE(earned_at, created_at) > NOW() - INTERVAL 30 DAY THEN commission_amount END), 0) AS d30,
              COALESCE(SUM(CASE WHEN COALESCE(earned_at, created_at) > NOW() - INTERVAL 90 DAY THEN commission_amount END), 0) AS d90
         FROM instructor_commissions WHERE instructor_id = ?`, [id]);
    const monthly: any[] = await query(
      `SELECT DATE_FORMAT(COALESCE(earned_at, created_at), '%Y-%m') AS month, SUM(commission_amount) AS amount
         FROM instructor_commissions WHERE instructor_id = ? AND COALESCE(earned_at, created_at) > NOW() - INTERVAL 6 MONTH
        GROUP BY month ORDER BY month`, [id]);
    const perCourse: any[] = await query(
      `SELECT c.id, c.title, c.is_published, c.review_status,
              (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.is_approved = 1 AND ce.payment_status IN ('verified','free')) AS students,
              (SELECT COALESCE(AVG(ce.completion_percentage), 0) FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.is_approved = 1) AS completion,
              (SELECT COALESCE(AVG(r.rating), 0) FROM course_reviews r WHERE r.course_id = c.id AND r.is_published = 1) AS rating,
              (SELECT COUNT(*) FROM course_reviews r WHERE r.course_id = c.id AND r.is_published = 1) AS reviews,
              (SELECT COALESCE(SUM(ic.commission_amount), 0) FROM instructor_commissions ic WHERE ic.course_id = c.id AND ic.instructor_id = c.instructor_id) AS earned
         FROM courses c WHERE c.instructor_id = ? ORDER BY students DESC, c.created_at DESC`, [id]);

    const daysSince = (d: any) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400_000) : null);
    const lastLoginDays = daysSince(u.last_login);
    const lastActivityDays = daysSince(co?.last_activity);
    const flags = {
      no_login_60d: lastLoginDays === null || lastLoginDays >= 60,
      no_activity_60d: lastActivityDays === null || lastActivityDays >= 60,
      low_rating: num(rv?.reviews) >= 3 && num(rv?.avg_rating) < 3.5,
      negative_reviews: num(rv?.negative_90d) >= 3,
      no_published_course: num(co?.published) === 0 && daysSince(u.created_at)! >= 30,
    };
    const enr = num(st?.enrollments);
    return res.json({
      success: true,
      data: plain({
        courses: { total: num(co?.total), published: num(co?.published), submitted: num(co?.submitted), last_published_at: co?.last_published_at, last_activity: co?.last_activity },
        students: { total: num(st?.students), new_30d: num(st?.new_30d), avg_completion: Math.round(num(st?.avg_completion) * 10) / 10, completion_rate: enr ? Math.round((num(st?.completed) / enr) * 1000) / 10 : 0 },
        reviews: { count: num(rv?.reviews), avg_rating: Math.round(num(rv?.avg_rating) * 100) / 100, negative_90d: num(rv?.negative_90d), recent_negative: negatives },
        revenue: { total: num(rev?.total), last_30d: num(rev?.d30), last_90d: num(rev?.d90), monthly: monthly.map((m) => ({ month: m.month, amount: num(m.amount) })), currency: "XAF" },
        per_course: perCourse.map((c) => ({ ...c, is_published: !!Number(c.is_published), students: num(c.students), completion: Math.round(num(c.completion) * 10) / 10, rating: Math.round(num(c.rating) * 100) / 100, reviews: num(c.reviews), earned: num(c.earned) })),
        last_login: u.last_login,
        flags,
        needs_attention: Object.values(flags).some(Boolean),
      }),
    });
  } catch (e) { return serverError(req, res, "adminPerformance", e); }
};

// GET /admin/watchlist — instructeurs à surveiller
export const adminWatchlist = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.last_login, u.created_at,
              (SELECT MAX(c.updated_at) FROM courses c WHERE c.instructor_id = u.id) AS last_activity,
              (SELECT COUNT(*) FROM courses c WHERE c.instructor_id = u.id AND c.is_published = 1) AS published,
              (SELECT AVG(r.rating) FROM course_reviews r JOIN courses c ON c.id = r.course_id WHERE c.instructor_id = u.id AND r.is_published = 1) AS avg_rating,
              (SELECT COUNT(*) FROM course_reviews r JOIN courses c ON c.id = r.course_id WHERE c.instructor_id = u.id AND r.is_published = 1) AS review_count,
              (SELECT COUNT(*) FROM course_reviews r JOIN courses c ON c.id = r.course_id WHERE c.instructor_id = u.id AND r.is_published = 1 AND r.rating <= 2 AND r.created_at > NOW() - INTERVAL 90 DAY) AS negative_90d
         FROM users u WHERE ${ACTIVE_INSTRUCTOR_SQL} LIMIT 300`);
    const days = (d: any) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400_000) : null);
    const brief = (r: any) => ({ id: Number(r.id), first_name: r.first_name, last_name: r.last_name, email: r.email });
    const inactive = rows.filter((r) => {
      const l = days(r.last_login), a = days(r.last_activity);
      return (l === null || l >= 60) && (a === null || a >= 60);
    }).map((r) => ({ ...brief(r), last_login: r.last_login, last_activity: r.last_activity }));
    const lowRated = rows.filter((r) => (num(r.review_count) >= 3 && num(r.avg_rating) < 3.5) || num(r.negative_90d) >= 3)
      .map((r) => ({ ...brief(r), avg_rating: Math.round(num(r.avg_rating) * 100) / 100, review_count: num(r.review_count), negative_90d: num(r.negative_90d) }));
    const noCourse = rows.filter((r) => num(r.published) === 0 && (days(r.created_at) ?? 0) >= 30).map((r) => ({ ...brief(r), joined: r.created_at }));
    const stalled: any[] = [];
    for (const r of rows) {
      const ob = await computeOnboarding(Number(r.id));
      if (!ob.complete && ob.days_since_start >= 3) stalled.push({ ...brief(r), percent: ob.percent, days: ob.days_since_start });
    }
    return res.json({ success: true, data: plain({ inactive, low_rated: lowRated, no_published_course: noCourse, stalled_onboarding: stalled }) });
  } catch (e) { return serverError(req, res, "adminWatchlist", e); }
};

// ══════════════════════════════════════════════════════
// JOURNAL D'AUDIT
// ══════════════════════════════════════════════════════
const shapeAudit = (r: any) => ({
  id: Number(r.id), action: r.action, category: r.category, created_at: r.created_at,
  actor: nameOf({ first_name: r.actor_first, last_name: r.actor_last }) || null,
  target: r.target_first ? nameOf({ first_name: r.target_first, last_name: r.target_last }) : null,
  target_id: r.target_id === null ? null : Number(r.target_id),
  details: parseJson(r.data_after, null),
});

// GET /admin/instructors/:id/audit?page=
export const adminInstructorAudit = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    const page = Math.max(parseId(req.query.page) || 1, 1), limit = 30;
    const rows: any[] = await query(
      `SELECT al.id, al.action, al.category, al.created_at, al.target_id, al.data_after,
              a.first_name AS actor_first, a.last_name AS actor_last
         FROM audit_logs al LEFT JOIN users a ON a.id = al.actor_id
        WHERE al.target_type = 'user' AND al.target_id = ? AND al.category IN ('admin','commission','user')
        ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?`, [id, limit, (page - 1) * limit]);
    const [{ n }]: any = await query("SELECT COUNT(*) AS n FROM audit_logs WHERE target_type = 'user' AND target_id = ? AND category IN ('admin','commission','user')", [id]);
    return res.json({ success: true, data: plain(rows.map(shapeAudit)), pagination: { page, limit, total: num(n) } });
  } catch (e) { return serverError(req, res, "adminInstructorAudit", e); }
};

// GET /admin/journal?search=&action=&page=  — toutes les actions « instructor.* »
export const adminJournal = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const page = Math.max(parseId(req.query.page) || 1, 1), limit = 30;
    const where: string[] = ["al.action LIKE 'instructor.%'"];
    const params: any[] = [];
    const action = String(req.query.action ?? "").trim();
    if (/^instructor\.[a-z_]+$/.test(action)) { where.push("al.action = ?"); params.push(action); }
    const search = String(req.query.search ?? "").trim().slice(0, 80);
    if (search) {
      where.push("(t.first_name LIKE ? OR t.last_name LIKE ? OR t.email LIKE ?)");
      const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
      params.push(like, like, like);
    }
    const rows: any[] = await query(
      `SELECT al.id, al.action, al.category, al.created_at, al.target_id, al.data_after,
              a.first_name AS actor_first, a.last_name AS actor_last, t.first_name AS target_first, t.last_name AS target_last
         FROM audit_logs al LEFT JOIN users a ON a.id = al.actor_id LEFT JOIN users t ON t.id = al.target_id AND al.target_type = 'user'
        WHERE ${where.join(" AND ")} ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    const [{ n }]: any = await query(
      `SELECT COUNT(*) AS n FROM audit_logs al LEFT JOIN users t ON t.id = al.target_id AND al.target_type = 'user' WHERE ${where.join(" AND ")}`, params);
    const actions: any[] = await query("SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'instructor.%' ORDER BY action");
    return res.json({ success: true, data: plain(rows.map(shapeAudit)), actions: actions.map((a) => a.action), pagination: { page, limit, total: num(n) } });
  } catch (e) { return serverError(req, res, "adminJournal", e); }
};

// ══════════════════════════════════════════════════════
// GRILLE DE RELECTURE DES COURS
// ══════════════════════════════════════════════════════
export const REVIEW_CRITERIA = ["content", "audio_video", "pedagogy", "structure", "resources"];

const cleanGrid = (grid: any) => {
  if (!Array.isArray(grid)) return [];
  const out: { key: string; score: number | null; comment: string }[] = [];
  for (const g of grid) {
    if (!g || !REVIEW_CRITERIA.includes(g.key)) continue;
    const s = g.score === null || g.score === undefined || g.score === "" ? null : Number(g.score);
    const score = s !== null && Number.isInteger(s) && s >= 1 && s <= 5 ? s : null;
    const comment = String(g.comment ?? "").trim().slice(0, 1000);
    if (score !== null || comment) out.push({ key: g.key, score, comment });
  }
  return out;
};

/** Enregistre un tour de relecture (appelé lors de la validation ou du renvoi d'un cours). Ne lève jamais. */
export async function saveReviewRound(
  reviewerId: number | undefined, courseId: number, decision: "approved" | "changes_requested", grid: any, comment: string | null
) {
  try {
    await ensureProgramTables();
    const criteria = cleanGrid(grid);
    if (decision === "approved" && !criteria.length && !comment) return;
    await query("INSERT INTO course_review_rounds (course_id, reviewer_id, decision, criteria, comment) VALUES (?, ?, ?, ?, ?)",
      [courseId, reviewerId ?? null, decision, criteria.length ? JSON.stringify(criteria) : null, comment]);
  } catch (e: any) {
    console.warn("saveReviewRound:", e?.message || e);
  }
}

export async function listReviewRounds(courseId: number) {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT r.id, r.decision, r.criteria, r.comment, r.created_at, u.first_name, u.last_name
         FROM course_review_rounds r LEFT JOIN users u ON u.id = r.reviewer_id WHERE r.course_id = ? ORDER BY r.id DESC LIMIT 30`, [courseId]);
    return plain(rows.map((r) => ({ id: r.id, decision: r.decision, criteria: parseJson(r.criteria, []), comment: r.comment, created_at: r.created_at, reviewer: nameOf(r) || null })));
  } catch { return []; }
}

// GET /courses/:id/review-history (instructeur propriétaire / co-instructeur, ou admin)
export const getCourseReviewHistory = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 404, "Cours introuvable", "Course not found");
    const admin = ["admin", "superadmin"].includes(req.user!.role);
    if (!admin) {
      const [ok]: any = await query(
        `SELECT c.id FROM courses c WHERE c.id = ? AND (c.instructor_id = ? OR EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ? AND ci.status = 'accepted'))`,
        [id, req.user!.id, req.user!.id]);
      if (!ok) return fail(req, res, 403, "Accès refusé", "Access denied");
    }
    return res.json({ success: true, data: await listReviewRounds(id) });
  } catch (e) { return serverError(req, res, "getCourseReviewHistory", e); }
};
