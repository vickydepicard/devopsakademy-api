// src/controllers/adminInstructorController.ts
// Gestion des instructeurs côté administration :
// liste + statistiques, fiche détaillée, création, suspension/réactivation,
// retrait du statut (avec transfert des cours), taux de commission, versements.
import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { query, withTransaction } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { tr, langFromReq, getUserLang, setUserLang } from "../utils/lang";
import { toPlain, parseId } from "../utils/serialize";
import { createNotification } from "../services/notification.service";
import { sendInstructorAccountCreatedEmail, sendInstructorStatusEmail } from "../services/mail.service";

type Req = AuthenticatedRequest;
const num = (v: any) => (v === null || v === undefined ? 0 : Number(v) || 0);
const fail = (req: Request, res: Response, status: number, fr: string, en: string, extra: object = {}) =>
  res.status(status).json({ success: false, message: tr(req, fr, en), ...extra });
const serverError = (req: Request, res: Response, label: string, error: any) => {
  console.error(`${label}:`, error?.message || error);
  return fail(req, res, 500, "Erreur serveur", "Server error");
};

// Journal d'audit (table audit_logs) — ne bloque jamais l'action
async function audit(
  req: Req, category: "admin" | "commission" | "user", action: string, targetId: number,
  before: object | null, after: object | null
) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_role, category, action, target_type, target_id, data_before, data_after, ip_address, user_agent)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
      [
        req.user?.id ?? null, req.user?.role ?? null, category, action, targetId,
        before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
        (req.ip || "").slice(0, 45), String(req.headers["user-agent"] || "").slice(0, 500) || null,
      ]
    );
  } catch (e: any) {
    console.warn("audit_logs:", e?.message || e);
  }
}

const APP_STATUS_SQL =
  "(SELECT ia.status FROM instructor_applications ia WHERE ia.user_id = u.id ORDER BY ia.submitted_at DESC, ia.id DESC LIMIT 1)";

// Cible : un compte instructeur existant (jamais un admin, jamais soi-même pour les actions sensibles)
async function loadInstructor(id: number) {
  const [u]: any = await query(
    "SELECT id, first_name, last_name, email, role, is_active, email_verified FROM users WHERE id = ? AND role = 'instructor'",
    [id]
  );
  return u || null;
}

// ═════════════════════════════════════════════════════════════
// GET /api/admin/instructor-management
// ═════════════════════════════════════════════════════════════
export const listInstructors = async (req: Req, res: Response) => {
  try {
    const search = String(req.query.search ?? "").trim().slice(0, 100);
    const status = String(req.query.status ?? "all");
    const sortMap: Record<string, string> = {
      name: "t.first_name", courses: "t.course_count", students: "t.student_count",
      earnings: "t.total_earned", joined: "t.created_at", last_login: "t.last_login",
    };
    const sort = sortMap[String(req.query.sort)] || "t.created_at";
    const dir = String(req.query.dir) === "asc" ? "ASC" : "DESC";
    const page = Math.max(parseId(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseId(req.query.limit) || 20, 1), 100);

    const conditions: string[] = [];
    const params: any[] = [];
    if (search) {
      const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
      conditions.push("(t.first_name LIKE ? OR t.last_name LIKE ? OR t.email LIKE ? OR CONCAT(t.first_name, ' ', t.last_name) LIKE ?)");
      params.push(like, like, like, like);
    }
    const statusSql: Record<string, string> = {
      active: "t.is_active = 1 AND t.application_status = 'accepted'",
      pending: "t.application_status IN ('pending','under_review')",
      suspended: "t.is_active = 0 AND t.email_verified = 1",
      unverified: "t.email_verified = 0",
      no_application: "t.application_status IS NULL",
    };
    if (statusSql[status]) conditions.push(statusSql[status]);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const base = `
      SELECT u.id, u.first_name, u.last_name, u.email, u.is_active, u.email_verified, u.last_login, u.created_at,
             up.avatar_url, up.job_title, up.country,
             ${APP_STATUS_SQL} AS application_status,
             (SELECT COUNT(*) FROM courses c WHERE c.instructor_id = u.id) AS course_count,
             (SELECT COUNT(*) FROM courses c WHERE c.instructor_id = u.id AND c.is_published = 1) AS published_count,
             (SELECT COUNT(*) FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
               WHERE c.instructor_id = u.id AND ce.is_approved = 1) AS student_count,
             (SELECT COALESCE(SUM(ic.commission_amount), 0) FROM instructor_commissions ic WHERE ic.instructor_id = u.id) AS total_earned,
             (SELECT COALESCE(SUM(ic.commission_amount), 0) FROM instructor_commissions ic
               WHERE ic.instructor_id = u.id AND ic.status <> 'paid') AS unpaid
        FROM users u LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.role = 'instructor'`;

    const rows = await query(
      `SELECT * FROM (${base}) t ${where} ORDER BY ${sort} ${dir}, t.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    const [count]: any = await query(`SELECT COUNT(*) AS total FROM (${base}) t ${where}`, params);

    const [stats]: any = await query(
      `SELECT COUNT(*) AS total,
              SUM(t.is_active = 1 AND t.application_status = 'accepted') AS active,
              SUM(t.is_active = 0 AND t.email_verified = 1) AS suspended,
              SUM(t.application_status IN ('pending','under_review')) AS pending,
              SUM(t.application_status IS NULL) AS no_application,
              COALESCE(SUM(t.unpaid), 0) AS unpaid_total
         FROM (${base}) t`
    );

    return res.json({
      success: true,
      data: toPlain<any[]>(rows).map((r) => ({
        ...r,
        total_earned: num(r.total_earned),
        unpaid: num(r.unpaid),
        is_active: !!Number(r.is_active),
        email_verified: !!Number(r.email_verified),
      })),
      stats: {
        total: num(stats?.total), active: num(stats?.active), suspended: num(stats?.suspended),
        pending: num(stats?.pending), no_application: num(stats?.no_application),
        unpaid_total: num(stats?.unpaid_total), currency: "XAF",
      },
      pagination: { total: num(count?.total), page, limit },
    });
  } catch (error) {
    return serverError(req, res, "listInstructors", error);
  }
};

// ═════════════════════════════════════════════════════════════
// GET /api/admin/instructor-management/:id
// ═════════════════════════════════════════════════════════════
export const getInstructorDetail = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    const [user]: any = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.is_active, u.email_verified, u.last_login, u.created_at,
              up.avatar_url, up.job_title, up.company, up.bio, up.country, up.city, up.linkedin_url, up.github_url, up.website_url
         FROM users u LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE u.id = ? AND u.role = 'instructor'`,
      [id]
    );
    if (!user) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");

    const applications = await query(
      `SELECT ia.id, ia.status, ia.motivation, ia.experience, ia.years_experience, ia.linkedin_url, ia.portfolio_url,
              ia.sample_course_topic, ia.review_note, ia.submitted_at, ia.reviewed_at,
              rv.first_name AS reviewer_first_name, rv.last_name AS reviewer_last_name
         FROM instructor_applications ia LEFT JOIN users rv ON rv.id = ia.reviewed_by
        WHERE ia.user_id = ? ORDER BY ia.submitted_at DESC`,
      [id]
    );
    const courses = await query(
      `SELECT c.id, c.title, c.is_published, c.price, c.is_free, c.rating, c.review_count, c.instructor_commission_rate, c.created_at,
              (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.is_approved = 1) AS student_count,
              (SELECT COALESCE(SUM(ic.sale_amount), 0) FROM instructor_commissions ic WHERE ic.course_id = c.id AND ic.instructor_id = c.instructor_id) AS sales,
              (SELECT COALESCE(SUM(ic.commission_amount), 0) FROM instructor_commissions ic WHERE ic.course_id = c.id AND ic.instructor_id = c.instructor_id) AS earned
         FROM courses c WHERE c.instructor_id = ? ORDER BY c.created_at DESC`,
      [id]
    );
    const coCourses = await query(
      `SELECT c.id, c.title, ci.commission_rate, ci.status FROM course_instructors ci JOIN courses c ON c.id = ci.course_id
        WHERE ci.instructor_id = ? ORDER BY ci.invited_at DESC`,
      [id]
    );
    const [totals]: any = await query(
      `SELECT COALESCE(SUM(commission_amount), 0) AS total,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount END), 0) AS paid,
              COALESCE(SUM(CASE WHEN status <> 'paid' THEN commission_amount END), 0) AS unpaid
         FROM instructor_commissions WHERE instructor_id = ?`,
      [id]
    );
    const commissions = await query(
      `SELECT ic.id, ic.course_id, c.title AS course_title, ic.sale_amount, ic.commission_rate, ic.commission_amount,
              ic.status, ic.earned_at, ic.paid_at, ic.payout_reference
         FROM instructor_commissions ic JOIN courses c ON c.id = ic.course_id
        WHERE ic.instructor_id = ? ORDER BY ic.created_at DESC LIMIT 50`,
      [id]
    );
    const history = await query(
      `SELECT al.id, al.action, al.created_at, a.first_name, a.last_name
         FROM audit_logs al LEFT JOIN users a ON a.id = al.actor_id
        WHERE al.target_type = 'user' AND al.target_id = ? AND al.category IN ('admin','commission')
        ORDER BY al.created_at DESC LIMIT 20`,
      [id]
    );

    return res.json({
      success: true,
      data: {
        user: toPlain({ ...user, is_active: !!Number(user.is_active), email_verified: !!Number(user.email_verified) }),
        applications: toPlain(applications),
        courses: toPlain<any[]>(courses).map((c) => ({ ...c, sales: num(c.sales), earned: num(c.earned), is_published: !!Number(c.is_published) })),
        co_courses: toPlain(coCourses),
        earnings: { total: num(totals?.total), paid: num(totals?.paid), unpaid: num(totals?.unpaid), currency: "XAF" },
        commissions: toPlain(commissions),
        history: toPlain(history),
      },
    });
  } catch (error) {
    return serverError(req, res, "getInstructorDetail", error);
  }
};

// ═════════════════════════════════════════════════════════════
// POST /api/admin/instructor-management   { first_name, last_name, email }
// Aucun mot de passe n'est choisi ni transmis par l'admin : l'instructeur définit le sien via un lien (7 jours).
// ═════════════════════════════════════════════════════════════
export const createInstructorAccount = async (req: Req, res: Response) => {
  try {
    const first = String(req.body?.first_name ?? "").trim();
    const last = String(req.body?.last_name ?? "").trim();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const errors: Record<string, string> = {};
    if (first.length < 2 || first.length > 100) errors.first_name = tr(req, "Prénom invalide (2 à 100 caractères)", "Invalid first name (2 to 100 characters)");
    if (last.length < 2 || last.length > 100) errors.last_name = tr(req, "Nom invalide (2 à 100 caractères)", "Invalid last name (2 to 100 characters)");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 255) errors.email = tr(req, "Adresse email invalide", "Invalid email address");
    if (Object.keys(errors).length) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });

    const [dup]: any = await query("SELECT id FROM users WHERE email = ?", [email]);
    if (dup) return fail(req, res, 409, "Un compte existe déjà avec cet email.", "An account already exists with this email.", { errors: { email: "duplicate" } });

    const lang = langFromReq(req);
    const adminId = req.user!.id;
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

    const userId = await withTransaction(async (q) => {
      const ins: any = await q(
        `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, email_verified)
         VALUES (?, ?, ?, ?, 'instructor', 1, 1)`,
        [email, unusablePassword, first, last]
      );
      const uid = Number(ins.insertId);
      await q("INSERT IGNORE INTO user_profiles (user_id) VALUES (?)", [uid]);
      // Candidature « acceptée » créée par l'admin : sinon requireInstructorOrAdmin bloquerait ce compte.
      await q(
        `INSERT INTO instructor_applications (user_id, motivation, experience, status, reviewed_by, reviewed_at, review_note)
         VALUES (?, 'Created by an administrator', 'Created by an administrator', 'accepted', ?, NOW(), 'Account created by an administrator')`,
        [uid, adminId]
      );
      await q("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))", [uid, tokenHash]);
      return uid;
    });

    await setUserLang(userId, lang);
    let emailSent = true;
    await sendInstructorAccountCreatedEmail(email, first, rawToken, lang).catch((e: any) => {
      emailSent = false;
      console.warn("Email création instructeur:", e?.message || e);
    });
    await audit(req, "admin", "instructor.created", userId, null, { email, first_name: first, last_name: last });

    return res.status(201).json({
      success: true,
      message: emailSent
        ? tr(req, "Instructeur créé. Un email d'activation lui a été envoyé.", "Instructor created. An activation email has been sent.")
        : tr(req, "Instructeur créé, mais l'email n'a pas pu être envoyé. Demandez-lui d'utiliser « Mot de passe oublié ».", "Instructor created, but the email could not be sent. Ask them to use “Forgot password”."),
      email_sent: emailSent,
      data: { id: userId },
    });
  } catch (error) {
    return serverError(req, res, "createInstructorAccount", error);
  }
};

// ═════════════════════════════════════════════════════════════
// PATCH /api/admin/instructor-management/:id   { first_name, last_name, email }
// ═════════════════════════════════════════════════════════════
export const updateInstructorAccount = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const user = id ? await loadInstructor(id) : null;
    if (!user) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");

    const sets: string[] = [];
    const params: any[] = [];
    const errors: Record<string, string> = {};
    const b = req.body || {};
    if (b.first_name !== undefined) {
      const v = String(b.first_name).trim();
      if (v.length < 2 || v.length > 100) errors.first_name = tr(req, "Prénom invalide", "Invalid first name"); else { sets.push("first_name = ?"); params.push(v); }
    }
    if (b.last_name !== undefined) {
      const v = String(b.last_name).trim();
      if (v.length < 2 || v.length > 100) errors.last_name = tr(req, "Nom invalide", "Invalid last name"); else { sets.push("last_name = ?"); params.push(v); }
    }
    if (b.email !== undefined) {
      const v = String(b.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) errors.email = tr(req, "Adresse email invalide", "Invalid email address");
      else {
        const [dup]: any = await query("SELECT id FROM users WHERE email = ? AND id <> ?", [v, id]);
        if (dup) errors.email = tr(req, "Cet email est déjà utilisé", "This email is already in use");
        else { sets.push("email = ?"); params.push(v); }
      }
    }
    if (Object.keys(errors).length) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    if (!sets.length) return fail(req, res, 400, "Aucune modification fournie", "No changes provided");

    await query(`UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = ?`, [...params, id]);
    await audit(req, "admin", "instructor.updated", id!, { first_name: user.first_name, last_name: user.last_name, email: user.email }, b);
    return res.json({ success: true, message: tr(req, "Instructeur mis à jour", "Instructor updated") });
  } catch (error) {
    return serverError(req, res, "updateInstructorAccount", error);
  }
};

// ═════════════════════════════════════════════════════════════
// PATCH /api/admin/instructor-management/:id/status   { is_active, reason? }
// ═════════════════════════════════════════════════════════════
export const setInstructorStatus = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const user = id ? await loadInstructor(id) : null;
    if (!user) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    if (typeof req.body?.is_active !== "boolean") return fail(req, res, 400, "Valeur is_active requise", "is_active value required");
    const active = req.body.is_active as boolean;
    const reason = String(req.body?.reason ?? "").trim().slice(0, 500) || null;
    if (!active && !reason) {
      return fail(req, res, 400, "Indiquez un motif de suspension.", "Please provide a reason for the suspension.", { errors: { reason: "required" } });
    }

    await query("UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?", [active ? 1 : 0, id]);
    if (!active) await query("DELETE FROM refresh_tokens WHERE user_id = ?", [id]); // coupe les sessions ouvertes

    const lang = await getUserLang(id!);
    await sendInstructorStatusEmail(user.email, user.first_name, active ? "reactivated" : "suspended", reason, lang)
      .catch((e: any) => console.warn("Email statut instructeur:", e?.message));
    await audit(req, "admin", active ? "instructor.reactivated" : "instructor.suspended", id!, { is_active: !!user.is_active }, { is_active: active, reason });

    return res.json({
      success: true,
      message: active ? tr(req, "Instructeur réactivé", "Instructor reactivated") : tr(req, "Instructeur suspendu", "Instructor suspended"),
    });
  } catch (error) {
    return serverError(req, res, "setInstructorStatus", error);
  }
};

// ═════════════════════════════════════════════════════════════
// POST /api/admin/instructor-management/:id/revoke   { reassign_to?, reason? }
// Retire le statut instructeur. Les cours doivent être transférés (sinon les étudiants perdraient leur formateur).
// ═════════════════════════════════════════════════════════════
export const revokeInstructor = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const user = id ? await loadInstructor(id) : null;
    if (!user) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    const reason = String(req.body?.reason ?? "").trim().slice(0, 500) || null;

    const [owned]: any = await query(
      "SELECT COUNT(*) AS total, COALESCE(SUM(is_published), 0) AS published FROM courses WHERE instructor_id = ?",
      [id]
    );
    const total = num(owned?.total);
    const reassignTo = parseId(req.body?.reassign_to);

    if (total > 0 && !reassignTo) {
      return fail(req, res, 409,
        `Cet instructeur possède ${total} cours. Choisissez un instructeur auquel les transférer.`,
        `This instructor owns ${total} course(s). Choose an instructor to transfer them to.`,
        { code: "HAS_COURSES", course_count: total, published_count: num(owned?.published) });
    }
    if (reassignTo) {
      if (reassignTo === id) return fail(req, res, 400, "Choisissez un autre instructeur.", "Choose a different instructor.");
      const [target]: any = await query(
        `SELECT u.id FROM users u
          WHERE u.id = ? AND u.is_active = 1
            AND (u.role IN ('admin','superadmin')
                 OR (u.role = 'instructor' AND EXISTS (SELECT 1 FROM instructor_applications ia WHERE ia.user_id = u.id AND ia.status = 'accepted')))`,
        [reassignTo]
      );
      if (!target) return fail(req, res, 404, "Instructeur de destination introuvable", "Destination instructor not found");
    }

    await withTransaction(async (q) => {
      if (reassignTo && total > 0) {
        // le destinataire ne peut pas être à la fois propriétaire et co-instructeur d'un même cours
        await q(
          "DELETE FROM course_instructors WHERE instructor_id = ? AND course_id IN (SELECT id FROM courses WHERE instructor_id = ?)",
          [reassignTo, id]
        );
        await q("UPDATE courses SET instructor_id = ?, updated_at = NOW() WHERE instructor_id = ?", [reassignTo, id]);
      }
      await q("DELETE FROM course_instructors WHERE instructor_id = ?", [id]);
      await q("UPDATE users SET role = 'student', updated_at = NOW() WHERE id = ?", [id]);
      await q(
        `UPDATE instructor_applications SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
          WHERE user_id = ? AND status IN ('accepted','pending','under_review')`,
        [req.user!.id, reason || "Instructor status removed by an administrator", id]
      );
      await q("DELETE FROM refresh_tokens WHERE user_id = ?", [id]);
    });

    const lang = await getUserLang(id!);
    await sendInstructorStatusEmail(user.email, user.first_name, "revoked", reason, lang).catch((e: any) => console.warn("Email retrait:", e?.message));
    await audit(req, "admin", "instructor.revoked", id!, { role: "instructor", courses: total }, { role: "student", reassign_to: reassignTo, reason });

    return res.json({ success: true, message: tr(req, "Statut instructeur retiré", "Instructor status removed"), data: { transferred_courses: reassignTo ? total : 0 } });
  } catch (error) {
    return serverError(req, res, "revokeInstructor", error);
  }
};

// ═════════════════════════════════════════════════════════════
// PATCH /api/admin/instructor-management/:id/commission   { course_id, rate | null }
// ═════════════════════════════════════════════════════════════
export const setCourseCommission = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const courseId = parseId(req.body?.course_id);
    if (!id || !courseId) return fail(req, res, 400, "Cours invalide", "Invalid course");
    const [course]: any = await query("SELECT id, instructor_commission_rate FROM courses WHERE id = ? AND instructor_id = ?", [courseId, id]);
    if (!course) return fail(req, res, 404, "Cours introuvable pour cet instructeur", "Course not found for this instructor");

    const raw = req.body?.rate;
    const rate = raw === null || raw === "" ? null : Number(raw);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      return fail(req, res, 400, "Le taux doit être compris entre 0 et 100 %", "The rate must be between 0 and 100%", { errors: { rate: "invalid" } });
    }
    if (rate !== null) {
      const [co]: any = await query("SELECT COALESCE(SUM(commission_rate), 0) AS total FROM course_instructors WHERE course_id = ? AND status = 'accepted'", [courseId]);
      if (rate < num(co?.total)) {
        return fail(req, res, 409, "Le taux est inférieur à la part déjà attribuée aux co-instructeurs.", "The rate is lower than the share already granted to co-instructors.", { code: "BELOW_CO_SHARE", co_share: num(co?.total) });
      }
    }
    await query("UPDATE courses SET instructor_commission_rate = ?, updated_at = NOW() WHERE id = ?", [rate, courseId]);
    await audit(req, "commission", "instructor.commission_rate", id, { course_id: courseId, rate: course.instructor_commission_rate }, { course_id: courseId, rate });
    return res.json({ success: true, message: tr(req, "Taux de commission mis à jour", "Commission rate updated") });
  } catch (error) {
    return serverError(req, res, "setCourseCommission", error);
  }
};

// ═════════════════════════════════════════════════════════════
// POST /api/admin/instructor-management/:id/payouts   { reference, commission_ids? }
// Marque comme versées les commissions dues (toutes, ou celles listées).
// ═════════════════════════════════════════════════════════════
export const recordPayout = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const user = id ? await loadInstructor(id) : null;
    if (!user) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    const reference = String(req.body?.reference ?? "").trim();
    if (reference.length < 3 || reference.length > 150) {
      return fail(req, res, 400, "Indiquez une référence de versement (3 à 150 caractères).", "Provide a payout reference (3 to 150 characters).", { errors: { reference: "invalid" } });
    }
    const ids: number[] = Array.isArray(req.body?.commission_ids) ? req.body.commission_ids.map(parseId).filter(Boolean) : [];

    const result = await withTransaction(async (q) => {
      const filter = ids.length ? `AND id IN (${ids.map(() => "?").join(",")})` : "";
      const due: any[] = await q(
        `SELECT id, commission_amount FROM instructor_commissions WHERE instructor_id = ? AND status <> 'paid' ${filter} FOR UPDATE`,
        [id, ...ids]
      );
      if (!due.length) return { count: 0, amount: 0 };
      const amount = due.reduce((s, r) => s + Number(r.commission_amount), 0);
      await q(
        `UPDATE instructor_commissions SET status = 'paid', paid_at = NOW(), payout_reference = ?
          WHERE id IN (${due.map(() => "?").join(",")})`,
        [reference, ...due.map((r) => r.id)]
      );
      return { count: due.length, amount: Math.round(amount * 100) / 100 };
    });

    if (!result.count) return fail(req, res, 409, "Aucune commission due à verser.", "There are no commissions due.", { code: "NOTHING_DUE" });

    void (async () => {
      const lang = await getUserLang(id!);
      const en = lang === "en";
      await createNotification(id!, {
        type: "success",
        title: en ? "Payout recorded" : "Versement enregistré",
        message: en ? `A payout of ${result.amount} XAF has been recorded (ref. ${reference}).` : `Un versement de ${result.amount} XAF a été enregistré (réf. ${reference}).`,
        link: "/instructor/earnings",
      });
    })().catch(() => {});
    await audit(req, "commission", "instructor.payout", id!, null, { reference, ...result });

    return res.json({ success: true, message: tr(req, "Versement enregistré", "Payout recorded"), data: result });
  } catch (error) {
    return serverError(req, res, "recordPayout", error);
  }
};
