// src/controllers/adminCourseController.ts
// Administration des cours : file de validation (soumis → publié / refusé)
// et assignation d'instructeurs (intervenants) rémunérés au pourcentage.
// Les cours appartiennent à l'établissement ; l'instructeur est auteur ou intervenant.
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { tr, getUserLang } from "../utils/lang";
import { toPlain, parseId } from "../utils/serialize";
import { createNotification } from "../services/notification.service";
import { defaultCommissionRate } from "../services/commission.service";

type Req = AuthenticatedRequest;
const num = (v: any) => (v === null || v === undefined ? 0 : Number(v) || 0);
const sqlNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const fail = (req: Request, res: Response, status: number, fr: string, en: string, extra: object = {}) =>
  res.status(status).json({ success: false, message: tr(req, fr, en), ...extra });
const serverError = (req: Request, res: Response, label: string, error: any) => {
  console.error(`${label}:`, error?.message || error);
  return fail(req, res, 500, "Erreur serveur", "Server error");
};

// Supprime le fichier physique uniquement s'il se trouve bien dans /uploads.
function removeUploadedFile(fileUrl: string) {
  try {
    if (!fileUrl) return;
    const pathname = fileUrl.startsWith("/") ? fileUrl : new URL(fileUrl).pathname;
    if (!pathname.startsWith("/uploads/")) return;
    const root = path.resolve(process.cwd(), "uploads");
    const target = path.resolve(process.cwd(), "." + pathname);
    if (target.startsWith(root + path.sep) && fs.existsSync(target)) fs.unlinkSync(target);
  } catch { /* le fichier orphelin n'est pas critique */ }
}

async function audit(req: Req, action: string, courseId: number, after: object | null) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_role, category, action, target_type, target_id, data_after, ip_address, user_agent)
       VALUES (?, ?, 'admin', ?, 'course', ?, ?, ?, ?)`,
      [req.user?.id ?? null, req.user?.role ?? null, action, courseId, after ? JSON.stringify(after) : null,
       (req.ip || "").slice(0, 45), String(req.headers["user-agent"] || "").slice(0, 500) || null]
    );
  } catch (e: any) {
    console.warn("audit_logs:", e?.message || e);
  }
}

/** Notification dans la langue du destinataire (jamais bloquante). */
function notifyLocalized(userId: number, type: "info" | "success" | "warning", fr: [string, string], en: [string, string], link: string) {
  void (async () => {
    const lang = await getUserLang(userId);
    const [title, message] = lang === "en" ? en : fr;
    await createNotification(userId, { type, title, message, link });
  })().catch(() => {});
}

const parseRate = (raw: any): number | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : undefined;
};

// ═════════════════════════════════════════════════════════════
// GET /api/admin/course-reviews?status=submitted|approved|rejected|draft|all&search=
// ═════════════════════════════════════════════════════════════
export const listCourseReviews = async (req: Req, res: Response) => {
  try {
    const status = ["submitted", "approved", "rejected", "draft"].includes(String(req.query.status)) ? String(req.query.status) : "submitted";
    const search = String(req.query.search ?? "").trim().slice(0, 100);
    const where: string[] = status === "all" ? [] : ["c.review_status = ?"];
    const params: any[] = status === "all" ? [] : [status];
    if (search) {
      const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
      where.push("(c.title LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?)");
      params.push(like, like, like, like);
    }
    const rows = await query(
      `SELECT c.id, c.title, c.price, c.original_price, c.is_free, c.is_published, c.review_status, c.review_note,
              c.submitted_at, c.reviewed_at, c.instructor_commission_rate, c.proposed_commission_rate, c.thumbnail_url, c.level, c.language,
              u.id AS author_id, u.first_name AS author_first_name, u.last_name AS author_last_name,
              (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.id) AS module_count,
              (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = c.id) AS lesson_count,
              (SELECT COUNT(*) FROM course_instructors ci WHERE ci.course_id = c.id AND ci.status = 'accepted') AS assigned_count
         FROM courses c JOIN users u ON u.id = c.instructor_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY (c.review_status = 'submitted') DESC, COALESCE(c.submitted_at, c.updated_at) DESC
        LIMIT 200`,
      params
    );
    const counts: any[] = await query("SELECT review_status, COUNT(*) AS n FROM courses GROUP BY review_status");
    const stats: Record<string, number> = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
    counts.forEach((r) => { stats[r.review_status] = num(r.n); });
    return res.json({
      success: true,
      data: toPlain<any[]>(rows).map((r) => ({ ...r, is_published: !!Number(r.is_published), is_free: !!Number(r.is_free) })),
      stats,
      default_rate: defaultCommissionRate(),
      currency: "XAF",
    });
  } catch (error) {
    return serverError(req, res, "listCourseReviews", error);
  }
};

// ═════════════════════════════════════════════════════════════
// GET /api/admin/course-reviews/:id  — contenu à relire + équipe
// ═════════════════════════════════════════════════════════════
export const getCourseReview = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const [course]: any = id ? await query(
      `SELECT c.*, cat.name AS category_name, u.first_name AS author_first_name, u.last_name AS author_last_name, u.email AS author_email
         FROM courses c JOIN users u ON u.id = c.instructor_id LEFT JOIN course_categories cat ON cat.id = c.category_id
        WHERE c.id = ?`, [id]) : [];
    if (!course) return fail(req, res, 404, "Cours introuvable", "Course not found");
    const modules: any[] = toPlain(await query("SELECT id, title, is_published FROM modules WHERE course_id = ? ORDER BY order_index", [id]));
    const lessons: any[] = toPlain(await query(
      `SELECT l.id, l.module_id, l.title, l.content_type, l.duration_minutes, l.is_published, l.is_preview
         FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = ? ORDER BY l.order_index`, [id]));
    const team = await listTeam(id!);
    const resources: any[] = toPlain(await query(
      `SELECT r.id, r.lesson_id, r.title, r.file_url, r.file_type, r.file_size, r.download_count, r.created_at, l.title AS lesson_title
         FROM lesson_resources r JOIN lessons l ON l.id = r.lesson_id JOIN modules m ON m.id = l.module_id
        WHERE m.course_id = ? ORDER BY m.order_index, l.order_index, r.order_index, r.id`, [id]));
    const c = toPlain<any>(course);
    return res.json({
      success: true,
      data: {
        course: {
          id: c.id, title: c.title, short_description: c.short_description, description: c.description, price: c.price,
          original_price: c.original_price, is_free: !!Number(c.is_free), level: c.level, language: c.language,
          thumbnail_url: c.thumbnail_url, category_name: c.category_name, duration_hours: c.duration_hours,
          is_published: !!Number(c.is_published), review_status: c.review_status, review_note: c.review_note,
          submitted_at: c.submitted_at, instructor_commission_rate: c.instructor_commission_rate, proposed_commission_rate: c.proposed_commission_rate,
          author: { id: c.instructor_id, first_name: c.author_first_name, last_name: c.author_last_name, email: c.author_email },
        },
        modules: modules.map((m) => ({ ...m, lessons: lessons.filter((l) => l.module_id === m.id) })),
        team,
        resources,
        default_rate: defaultCommissionRate(),
      },
    });
  } catch (error) {
    return serverError(req, res, "getCourseReview", error);
  }
};

// ═════════════════════════════════════════════════════════════
// POST /api/admin/course-reviews/:id/approve   { commission_rate?, price?, original_price? }
// ═════════════════════════════════════════════════════════════
export const approveCourse = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const [course]: any = id ? await query("SELECT id, title, instructor_id, is_published, review_status FROM courses WHERE id = ?", [id]) : [];
    if (!course) return fail(req, res, 404, "Cours introuvable", "Course not found");
    if (Number(course.is_published) === 1) return fail(req, res, 409, "Ce cours est déjà publié.", "This course is already published.");

    const sets: string[] = [];
    const vals: any[] = [];
    const errors: Record<string, string> = {};

    const rate = parseRate(req.body?.commission_rate);
    if (rate === undefined && req.body?.commission_rate !== undefined) errors.commission_rate = "invalid";
    if (rate !== undefined) { sets.push("instructor_commission_rate = ?"); vals.push(rate); }

    for (const k of ["price", "original_price"] as const) {
      if (req.body?.[k] === undefined) continue;
      if (req.body[k] === null || req.body[k] === "") { if (k === "original_price") { sets.push("original_price = NULL"); } continue; }
      const p = Number(req.body[k]);
      if (!Number.isFinite(p) || p < 0 || p > 99999999) errors[k] = "invalid";
      else { sets.push(`${k} = ?`); vals.push(Math.round(p * 100) / 100); }
    }
    if (Object.keys(errors).length) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });

    // Les parts des intervenants ne doivent pas dépasser la part totale des instructeurs.
    if (rate !== undefined && rate !== null) {
      const [t]: any = await query("SELECT COALESCE(SUM(commission_rate),0) AS total FROM course_instructors WHERE course_id = ? AND status = 'accepted'", [id]);
      if (num(t?.total) > rate) {
        return fail(req, res, 400, "La part totale des instructeurs est inférieure aux parts déjà attribuées aux intervenants.", "The total instructor share is lower than the shares already given to assigned instructors.", { code: "RATE_BELOW_ASSIGNED" });
      }
    }

    await query(
      `UPDATE courses SET ${sets.length ? sets.join(", ") + "," : ""} is_published = 1, published_at = COALESCE(published_at, ?),
              review_status = 'approved', review_note = NULL, reviewed_by = ?, reviewed_at = ?, updated_at = NOW() WHERE id = ?`,
      [...vals, sqlNow(), req.user!.id, sqlNow(), id]
    );
    notifyLocalized(Number(course.instructor_id), "success",
      ["Cours publié", `« ${course.title} » a été validé et publié.`],
      ["Course published", `“${course.title}” has been approved and published.`], `/instructor/courses/${id}/modules`);
    await audit(req, "course.approved", id!, { commission_rate: rate ?? null });
    return res.json({ success: true, message: tr(req, "Cours validé et publié.", "Course approved and published.") });
  } catch (error) {
    return serverError(req, res, "approveCourse", error);
  }
};

// POST /api/admin/course-reviews/:id/reject   { reason }
export const rejectCourse = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const reason = String(req.body?.reason ?? "").trim().slice(0, 2000);
    if (reason.length < 3) return fail(req, res, 400, "Indiquez le motif du refus.", "Provide the reason for the refusal.", { errors: { reason: "required" } });
    const [course]: any = id ? await query("SELECT id, title, instructor_id FROM courses WHERE id = ?", [id]) : [];
    if (!course) return fail(req, res, 404, "Cours introuvable", "Course not found");
    await query(
      "UPDATE courses SET review_status = 'rejected', review_note = ?, is_published = 0, reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW() WHERE id = ?",
      [reason, req.user!.id, id]
    );
    notifyLocalized(Number(course.instructor_id), "warning",
      ["Cours à corriger", `« ${course.title} » n'a pas été validé : ${reason}`],
      ["Course needs changes", `“${course.title}” was not approved: ${reason}`], `/instructor/courses/${id}/edit`);
    await audit(req, "course.rejected", id!, { reason });
    return res.json({ success: true, message: tr(req, "Cours renvoyé à l'instructeur.", "Course sent back to the instructor.") });
  } catch (error) {
    return serverError(req, res, "rejectCourse", error);
  }
};

// POST /api/admin/course-reviews/:id/unpublish   { reason? }
export const unpublishCourse = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const reason = String(req.body?.reason ?? "").trim().slice(0, 2000) || null;
    const [course]: any = id ? await query("SELECT id, title, instructor_id, is_published FROM courses WHERE id = ?", [id]) : [];
    if (!course) return fail(req, res, 404, "Cours introuvable", "Course not found");
    if (!Number(course.is_published)) return fail(req, res, 409, "Ce cours n'est pas publié.", "This course is not published.");
    await query("UPDATE courses SET is_published = 0, review_status = 'draft', review_note = ?, updated_at = NOW() WHERE id = ?", [reason, id]);
    notifyLocalized(Number(course.instructor_id), "warning",
      ["Cours dépublié", `« ${course.title} » a été retiré de la vente${reason ? ` : ${reason}` : "."}`],
      ["Course unpublished", `“${course.title}” was taken offline${reason ? `: ${reason}` : "."}`], `/instructor/courses/${id}/edit`);
    await audit(req, "course.unpublished", id!, { reason });
    return res.json({ success: true, message: tr(req, "Cours dépublié.", "Course unpublished.") });
  } catch (error) {
    return serverError(req, res, "unpublishCourse", error);
  }
};

// ═════════════════════════════════════════════════════════════
// ÉQUIPE D'UN COURS : auteur + intervenants
// ═════════════════════════════════════════════════════════════
async function listTeam(courseId: number) {
  const [course]: any = await query(
    `SELECT c.instructor_id, c.instructor_commission_rate, u.first_name, u.last_name, u.email
       FROM courses c JOIN users u ON u.id = c.instructor_id WHERE c.id = ?`, [courseId]);
  const assigned: any[] = toPlain(await query(
    `SELECT ci.id, ci.instructor_id, ci.commission_rate, ci.can_edit_content, ci.status, u.first_name, u.last_name, u.email
       FROM course_instructors ci JOIN users u ON u.id = ci.instructor_id
      WHERE ci.course_id = ? AND ci.status IN ('accepted','pending') ORDER BY ci.created_at`, [courseId]));
  const pool = course?.instructor_commission_rate != null ? num(course.instructor_commission_rate) : defaultCommissionRate();
  const assignedTotal = assigned.filter((a) => a.status === "accepted").reduce((s, a) => s + num(a.commission_rate), 0);
  return {
    pool_rate: pool,
    pool_is_default: course?.instructor_commission_rate == null,
    author: course ? { id: course.instructor_id, first_name: course.first_name, last_name: course.last_name, email: course.email, rate: Math.max(Math.round((pool - assignedTotal) * 100) / 100, 0) } : null,
    assigned: assigned.map((a) => ({ ...a, can_edit_content: !!Number(a.can_edit_content) })),
  };
}

// GET /api/admin/courses/:courseId/instructors
export const getCourseTeam = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.courseId);
    const [c]: any = id ? await query("SELECT id FROM courses WHERE id = ?", [id]) : [];
    if (!c) return fail(req, res, 404, "Cours introuvable", "Course not found");
    return res.json({ success: true, data: await listTeam(id!) });
  } catch (error) {
    return serverError(req, res, "getCourseTeam", error);
  }
};

// POST /api/admin/courses/:courseId/instructors   { instructor_id, commission_rate, can_edit_content? }
export const assignInstructor = async (req: Req, res: Response) => {
  try {
    const courseId = parseId(req.params.courseId);
    const instructorId = parseId(req.body?.instructor_id);
    const rate = parseRate(req.body?.commission_rate ?? 0);
    if (!instructorId) return fail(req, res, 400, "Choisissez un instructeur.", "Choose an instructor.", { errors: { instructor_id: "required" } });
    if (rate === undefined || rate === null) return fail(req, res, 400, "Le pourcentage doit être compris entre 0 et 100.", "The percentage must be between 0 and 100.", { errors: { commission_rate: "invalid" } });

    const [course]: any = courseId ? await query("SELECT id, title, instructor_id FROM courses WHERE id = ?", [courseId]) : [];
    if (!course) return fail(req, res, 404, "Cours introuvable", "Course not found");
    if (Number(course.instructor_id) === instructorId) return fail(req, res, 400, "Cet instructeur est déjà l'auteur du cours.", "This instructor is already the author of the course.");

    const [target]: any = await query(
      `SELECT u.id, u.first_name FROM users u
        WHERE u.id = ? AND u.role = 'instructor' AND u.is_active = 1
          AND EXISTS (SELECT 1 FROM instructor_applications ia WHERE ia.user_id = u.id AND ia.status = 'accepted')`, [instructorId]);
    if (!target) return fail(req, res, 404, "Instructeur introuvable, inactif ou non validé.", "Instructor not found, inactive or not approved.");

    const [dup]: any = await query("SELECT id FROM course_instructors WHERE course_id = ? AND instructor_id = ?", [courseId, instructorId]);
    if (dup) return fail(req, res, 409, "Cet instructeur est déjà assigné à ce cours.", "This instructor is already assigned to this course.");

    const team = await listTeam(courseId!);
    const assignedTotal = team.assigned.filter((a: any) => a.status === "accepted").reduce((s: number, a: any) => s + num(a.commission_rate), 0);
    if (assignedTotal + rate > team.pool_rate) {
      return fail(req, res, 400,
        `Part trop élevée : la part totale des instructeurs est de ${team.pool_rate} %, il reste ${Math.max(team.pool_rate - assignedTotal, 0)} % à répartir (l'auteur garde le reste).`,
        `Share too high: the total instructor share is ${team.pool_rate}%, ${Math.max(team.pool_rate - assignedTotal, 0)}% remains to be split (the author keeps the rest).`,
        { code: "RATE_EXCEEDS_POOL", available: Math.max(team.pool_rate - assignedTotal, 0) });
    }

    await query(
      `INSERT INTO course_instructors (course_id, instructor_id, added_by, commission_rate, can_edit_content, status, responded_at)
       VALUES (?, ?, ?, ?, ?, 'accepted', NOW())`,
      [courseId, instructorId, req.user!.id, rate, req.body?.can_edit_content ? 1 : 0]
    );
    notifyLocalized(instructorId, "info",
      ["Nouveau cours à enseigner", `Vous avez été assigné(e) au cours « ${course.title} » (${rate} % des ventes).`],
      ["New course to teach", `You have been assigned to “${course.title}” (${rate}% of sales).`], "/instructor/courses");
    await audit(req, "course.instructor_assigned", courseId!, { instructor_id: instructorId, rate });
    return res.status(201).json({ success: true, message: tr(req, "Instructeur ajouté au cours.", "Instructor added to the course."), data: await listTeam(courseId!) });
  } catch (error) {
    return serverError(req, res, "assignInstructor", error);
  }
};

// PATCH /api/admin/courses/:courseId/instructors/:entryId   { commission_rate?, can_edit_content? }
export const updateAssignment = async (req: Req, res: Response) => {
  try {
    const courseId = parseId(req.params.courseId);
    const entryId = parseId(req.params.entryId);
    const [entry]: any = courseId && entryId ? await query("SELECT * FROM course_instructors WHERE id = ? AND course_id = ?", [entryId, courseId]) : [];
    if (!entry) return fail(req, res, 404, "Assignation introuvable", "Assignment not found");
    const sets: string[] = []; const vals: any[] = [];
    if (req.body?.commission_rate !== undefined) {
      const rate = parseRate(req.body.commission_rate);
      if (rate === undefined || rate === null) return fail(req, res, 400, "Le pourcentage doit être compris entre 0 et 100.", "The percentage must be between 0 and 100.", { errors: { commission_rate: "invalid" } });
      const team = await listTeam(courseId!);
      const others = team.assigned.filter((a: any) => a.status === "accepted" && a.id !== entryId).reduce((s: number, a: any) => s + num(a.commission_rate), 0);
      if (others + rate > team.pool_rate) {
        return fail(req, res, 400, `Part trop élevée : il reste ${Math.max(team.pool_rate - others, 0)} % à répartir.`, `Share too high: ${Math.max(team.pool_rate - others, 0)}% remains to be split.`, { code: "RATE_EXCEEDS_POOL", available: Math.max(team.pool_rate - others, 0) });
      }
      sets.push("commission_rate = ?"); vals.push(rate);
    }
    if (req.body?.can_edit_content !== undefined) { sets.push("can_edit_content = ?"); vals.push(req.body.can_edit_content ? 1 : 0); }
    if (!sets.length) return fail(req, res, 400, "Aucune modification fournie", "No changes provided");
    await query(`UPDATE course_instructors SET ${sets.join(", ")} WHERE id = ?`, [...vals, entryId]);
    await audit(req, "course.assignment_updated", courseId!, { entry_id: entryId, ...req.body });
    return res.json({ success: true, message: tr(req, "Assignation mise à jour.", "Assignment updated."), data: await listTeam(courseId!) });
  } catch (error) {
    return serverError(req, res, "updateAssignment", error);
  }
};

// DELETE /api/admin/courses/:courseId/instructors/:entryId
export const removeAssignment = async (req: Req, res: Response) => {
  try {
    const courseId = parseId(req.params.courseId);
    const entryId = parseId(req.params.entryId);
    const [entry]: any = courseId && entryId ? await query("SELECT instructor_id FROM course_instructors WHERE id = ? AND course_id = ?", [entryId, courseId]) : [];
    if (!entry) return fail(req, res, 404, "Assignation introuvable", "Assignment not found");
    await query("DELETE FROM course_instructors WHERE id = ?", [entryId]);
    await audit(req, "course.instructor_removed", courseId!, { instructor_id: entry.instructor_id });
    return res.json({ success: true, message: tr(req, "Instructeur retiré du cours.", "Instructor removed from the course."), data: await listTeam(courseId!) });
  } catch (error) {
    return serverError(req, res, "removeAssignment", error);
  }
};

// PATCH /api/admin/courses/:courseId/commission   { rate }  — part totale reversée aux instructeurs (null = défaut)
export const setCoursePool = async (req: Req, res: Response) => {
  try {
    const courseId = parseId(req.params.courseId);
    const rate = parseRate(req.body?.rate);
    if (rate === undefined) return fail(req, res, 400, "Le pourcentage doit être compris entre 0 et 100.", "The percentage must be between 0 and 100.", { errors: { rate: "invalid" } });
    const [c]: any = courseId ? await query("SELECT id FROM courses WHERE id = ?", [courseId]) : [];
    if (!c) return fail(req, res, 404, "Cours introuvable", "Course not found");
    if (rate !== null) {
      const [t]: any = await query("SELECT COALESCE(SUM(commission_rate),0) AS total FROM course_instructors WHERE course_id = ? AND status = 'accepted'", [courseId]);
      if (num(t?.total) > rate) return fail(req, res, 400, "Cette part est inférieure aux parts déjà attribuées aux intervenants.", "This share is lower than the shares already given to assigned instructors.", { code: "RATE_BELOW_ASSIGNED" });
    }
    await query("UPDATE courses SET instructor_commission_rate = ?, updated_at = NOW() WHERE id = ?", [rate, courseId]);
    await audit(req, "course.pool_rate", courseId!, { rate });
    return res.json({ success: true, message: tr(req, "Part des instructeurs mise à jour.", "Instructor share updated."), data: await listTeam(courseId!) });
  } catch (error) {
    return serverError(req, res, "setCoursePool", error);
  }
};


// ═════════════════════════════════════════════════════════════
// DELETE /api/admin/course-resources/:id   { reason? }
// L'administration retire une ressource qui ne respecte pas les règles ; l'auteur est prévenu.
// ═════════════════════════════════════════════════════════════
export const removeResource = async (req: Req, res: Response) => {
  try {
    const rid = parseId(req.params.id);
    const [r]: any = rid ? await query(
      `SELECT r.id, r.title, r.file_url, m.course_id, c.title AS course_title, c.instructor_id
         FROM lesson_resources r JOIN lessons l ON l.id = r.lesson_id JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id
        WHERE r.id = ?`, [rid]) : [];
    if (!r) return fail(req, res, 404, "Ressource introuvable", "Resource not found");
    const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
    await query("DELETE FROM lesson_resources WHERE id = ?", [rid]);
    removeUploadedFile(String(r.file_url || ""));
    const why = reason ? ` (${reason})` : "";
    notifyLocalized(Number(r.instructor_id), "warning",
      ["Ressource retirée", `La ressource « ${r.title} » du cours « ${r.course_title} » a été retirée par l'administration${why}.`],
      ["Resource removed", `The resource “${r.title}” in the course “${r.course_title}” was removed by the administration${why}.`],
      `/instructor/courses/${r.course_id}/modules`);
    await audit(req, "course.resource_removed", Number(r.course_id), { resource_id: rid, title: r.title, reason: reason || null });
    return res.json({ success: true, message: tr(req, "Ressource retirée.", "Resource removed.") });
  } catch (error) {
    return serverError(req, res, "removeResource", error);
  }
};
