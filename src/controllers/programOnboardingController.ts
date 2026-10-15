// src/controllers/programOnboardingController.ts
// Parcours d'intégration (onboarding) et contrat / charte signée en ligne.
import { Request, Response, NextFunction } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { fail, serverError, logAudit } from "../utils/respond";
import { langFromReq } from "../utils/lang";
import { parseId } from "../utils/serialize";
import { notifyAdmins } from "../services/notification.service";
import { ensureProgramTables, notifyUser, plain, num, ACTIVE_INSTRUCTOR_SQL } from "./programSetup";

type Req = AuthenticatedRequest;

// ══════════════════════════════════════════════════════
// ONBOARDING
// ══════════════════════════════════════════════════════
export interface OnboardingTask { key: string; done: boolean; link: string }

export async function computeOnboarding(userId: number) {
  const [profile]: any = await query("SELECT bio, avatar_url FROM user_profiles WHERE user_id = ?", [userId]);
  const [agr]: any = await query("SELECT id FROM instructor_agreements WHERE is_current = 1 ORDER BY version DESC LIMIT 1");
  const [sig]: any = agr ? await query("SELECT id FROM instructor_agreement_signatures WHERE user_id = ? AND agreement_id = ?", [userId, agr.id]) : [null];
  const [payout]: any = await query("SELECT user_id FROM instructor_payout_profiles WHERE user_id = ?", [userId]);
  const [courses]: any = await query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(review_status IN ('submitted','approved')), 0) AS submitted
       FROM courses WHERE instructor_id = ?`, [userId]);
  const [app]: any = await query(
    "SELECT reviewed_at FROM instructor_applications WHERE user_id = ? AND status = 'accepted' ORDER BY reviewed_at DESC LIMIT 1", [userId]);
  const [user]: any = await query("SELECT created_at FROM users WHERE id = ?", [userId]);
  const [ob]: any = await query("SELECT reminder_count, last_reminder_at FROM instructor_onboarding WHERE user_id = ?", [userId]);

  const tasks: OnboardingTask[] = [
    { key: "profile", done: !!(profile?.avatar_url && String(profile?.bio || "").trim().length >= 30), link: "/profile" },
    { key: "agreement", done: !agr || !!sig, link: "/instructor/agreement" },
    { key: "payout", done: !!payout, link: "/instructor/earnings" },
    { key: "first_course", done: num(courses?.total) > 0, link: "/instructor/courses/new" },
    { key: "course_submitted", done: num(courses?.submitted) > 0, link: "/instructor/courses" },
  ];
  const doneCount = tasks.filter((t) => t.done).length;
  const startedAt = app?.reviewed_at || user?.created_at || null;
  const days = startedAt ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 86400_000) : 0;
  return {
    tasks,
    done: doneCount,
    total: tasks.length,
    percent: Math.round((doneCount / tasks.length) * 100),
    complete: doneCount === tasks.length,
    started_at: startedAt,
    days_since_start: days,
    reminder_count: num(ob?.reminder_count),
    last_reminder_at: ob?.last_reminder_at || null,
  };
}

// GET /onboarding/me
export const getMyOnboarding = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    return res.json({ success: true, data: plain(await computeOnboarding(req.user!.id)) });
  } catch (e) { return serverError(req, res, "getMyOnboarding", e); }
};

// GET /admin/onboarding — tous les instructeurs actifs avec leur avancement
export const adminOnboardingOverview = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.last_login FROM users u WHERE ${ACTIVE_INSTRUCTOR_SQL} ORDER BY u.created_at DESC LIMIT 300`);
    const data = [];
    for (const u of rows) {
      const ob = await computeOnboarding(Number(u.id));
      data.push({
        id: Number(u.id), first_name: u.first_name, last_name: u.last_name, email: u.email, last_login: u.last_login,
        ...ob, stalled: !ob.complete && ob.days_since_start >= 3,
      });
    }
    data.sort((a, b) => a.percent - b.percent);
    return res.json({
      success: true,
      data: plain(data),
      stats: {
        total: data.length,
        complete: data.filter((d) => d.complete).length,
        stalled: data.filter((d) => d.stalled).length,
      },
    });
  } catch (e) { return serverError(req, res, "adminOnboardingOverview", e); }
};

// GET /admin/instructors/:id/onboarding
export const adminInstructorOnboarding = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    const [sig]: any = await query(
      `SELECT s.signed_at, s.signed_name, a.version FROM instructor_agreement_signatures s
         JOIN instructor_agreements a ON a.id = s.agreement_id
        WHERE s.user_id = ? ORDER BY a.version DESC LIMIT 1`, [id]);
    return res.json({ success: true, data: plain({ ...(await computeOnboarding(id)), last_signature: sig || null }) });
  } catch (e) { return serverError(req, res, "adminInstructorOnboarding", e); }
};

async function sendReminder(userId: number, count: number, pending: string[]) {
  const labelsFr: Record<string, string> = {
    profile: "compléter votre profil (photo et biographie)", agreement: "signer la charte instructeur",
    payout: "renseigner votre moyen de paiement", first_course: "créer votre premier cours", course_submitted: "soumettre un cours à validation",
  };
  const labelsEn: Record<string, string> = {
    profile: "complete your profile (photo and bio)", agreement: "sign the instructor charter",
    payout: "add your payout method", first_course: "create your first course", course_submitted: "submit a course for review",
  };
  await notifyUser(userId, {
    type: "info",
    fr: { title: "Finalisez votre intégration d'instructeur", body: `Il vous reste à :\n${pending.map((k) => `• ${labelsFr[k]}`).join("\n")}` },
    en: { title: "Finish your instructor onboarding", body: `You still need to:\n${pending.map((k) => `• ${labelsEn[k]}`).join("\n")}` },
    link: "/instructor",
    email: { ctaFr: "Poursuivre mon intégration", ctaEn: "Continue my onboarding" },
  });
  await query(
    `INSERT INTO instructor_onboarding (user_id, reminder_count, last_reminder_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE reminder_count = VALUES(reminder_count), last_reminder_at = NOW()`,
    [userId, count]);
}

// POST /admin/instructors/:id/onboarding/remind
export const remindInstructor = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    const ob = await computeOnboarding(id);
    if (ob.complete) return fail(req, res, 409, "L'intégration est déjà terminée.", "Onboarding is already complete.");
    await sendReminder(id, ob.reminder_count + 1, ob.tasks.filter((t) => !t.done).map((t) => t.key));
    await logAudit(req, "admin", "instructor.onboarding_reminder", "user", id, null, { pending: ob.tasks.filter((t) => !t.done).map((t) => t.key) });
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "remindInstructor", e); }
};

// Relances automatiques : J+3, J+7, J+14 après l'acceptation tant que l'intégration n'est pas terminée
const THRESHOLDS = [3, 7, 14];
export async function runOnboardingReminders() {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(`SELECT u.id FROM users u WHERE ${ACTIVE_INSTRUCTOR_SQL}`);
    for (const u of rows) {
      const id = Number(u.id);
      const ob = await computeOnboarding(id);
      if (ob.complete) {
        const [flag]: any = await query("SELECT completed_notified FROM instructor_onboarding WHERE user_id = ?", [id]);
        if (!Number(flag?.completed_notified) && ob.days_since_start >= 0) {
          await query(
            `INSERT INTO instructor_onboarding (user_id, completed_notified) VALUES (?, 1)
             ON DUPLICATE KEY UPDATE completed_notified = 1`, [id]);
          const [info]: any = await query("SELECT first_name, last_name FROM users WHERE id = ?", [id]);
          // seulement si une relance avait été nécessaire (évite le bruit pour les comptes anciens)
          if (ob.reminder_count > 0) {
            void notifyAdmins({ type: "success", title: `Intégration terminée — ${info?.first_name} ${info?.last_name}`, message: "Toutes les étapes d'intégration sont validées.", link: "/admin/instructor-program" }, { email: false });
          }
        }
        continue;
      }
      // Relances automatiques réservées aux instructeurs récents (≤ 30 j) et espacées d'au moins 48 h :
      // les anciens comptes ne reçoivent jamais de rafale d'emails au déploiement (relance manuelle possible).
      if (ob.days_since_start > 30) continue;
      if (ob.last_reminder_at && Date.now() - new Date(ob.last_reminder_at).getTime() < 48 * 3600_000) continue;
      if (process.env.ONBOARDING_AUTO_REMINDERS === "false") continue;
      const next = THRESHOLDS[ob.reminder_count];
      if (next !== undefined && ob.days_since_start >= next) {
        await sendReminder(id, ob.reminder_count + 1, ob.tasks.filter((t) => !t.done).map((t) => t.key));
      }
    }
  } catch (e: any) {
    console.warn("Relances onboarding:", e?.message || e);
  }
}

// ══════════════════════════════════════════════════════
// CONTRAT / CHARTE
// ══════════════════════════════════════════════════════
const currentAgreement = async () => {
  const [a]: any = await query("SELECT * FROM instructor_agreements WHERE is_current = 1 ORDER BY version DESC LIMIT 1");
  return a || null;
};

// GET /agreement (instructeur)
export const getMyAgreement = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const a = await currentAgreement();
    if (!a) return res.json({ success: true, data: null });
    const [sig]: any = await query(
      "SELECT signed_at, signed_name FROM instructor_agreement_signatures WHERE user_id = ? AND agreement_id = ?", [req.user!.id, a.id]);
    const en = langFromReq(req) === "en";
    return res.json({
      success: true,
      data: plain({ id: a.id, version: a.version, title: a.title, body: en ? a.body_en : a.body_fr, published_at: a.created_at, signed: sig || null }),
    });
  } catch (e) { return serverError(req, res, "getMyAgreement", e); }
};

// POST /agreement/sign { accept: true, signed_name }
export const signAgreement = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const a = await currentAgreement();
    if (!a) return fail(req, res, 404, "Aucun contrat à signer", "No agreement to sign");
    const name = String(req.body?.signed_name ?? "").trim().slice(0, 150);
    if (!req.body?.accept) return fail(req, res, 400, "Vous devez accepter la charte.", "You must accept the charter.");
    if (name.length < 3) return fail(req, res, 400, "Saisissez votre nom complet pour signer.", "Type your full name to sign.", { errors: { signed_name: "required" } });

    const [dup]: any = await query("SELECT id FROM instructor_agreement_signatures WHERE user_id = ? AND agreement_id = ?", [req.user!.id, a.id]);
    if (dup) return fail(req, res, 409, "Vous avez déjà signé cette version.", "You have already signed this version.");

    await query(
      "INSERT INTO instructor_agreement_signatures (user_id, agreement_id, signed_name, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)",
      [req.user!.id, a.id, name, (req.ip || "").slice(0, 45), String(req.headers["user-agent"] || "").slice(0, 500) || null]);
    await logAudit(req, "admin", "instructor.agreement_signed", "user", req.user!.id, null, { agreement_id: Number(a.id), version: Number(a.version), signed_name: name });
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "signAgreement", e); }
};

// Middleware : un instructeur (non admin) doit avoir signé la version en vigueur pour soumettre un cours
export const requireSignedAgreement = async (req: Req, res: Response, next: NextFunction) => {
  try {
    if (!req.user || ["admin", "superadmin"].includes(req.user.role)) return next();
    await ensureProgramTables();
    const a = await currentAgreement();
    if (!a) return next();
    const [sig]: any = await query("SELECT id FROM instructor_agreement_signatures WHERE user_id = ? AND agreement_id = ?", [req.user.id, a.id]);
    if (sig) return next();
    return fail(req as unknown as Request, res, 409,
      "Vous devez signer la charte instructeur avant de soumettre un cours.",
      "You must sign the instructor charter before submitting a course.", { code: "AGREEMENT_REQUIRED" });
  } catch (e) { return serverError(req as unknown as Request, res, "requireSignedAgreement", e); }
};

// ── Admin ──
// GET /admin/agreements
export const adminListAgreements = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT a.id, a.version, a.title, a.is_current, a.created_at,
              (SELECT COUNT(*) FROM instructor_agreement_signatures s WHERE s.agreement_id = a.id) AS signatures
         FROM instructor_agreements a ORDER BY a.version DESC`);
    const [{ total }]: any = await query(`SELECT COUNT(*) AS total FROM users u WHERE ${ACTIVE_INSTRUCTOR_SQL}`);
    return res.json({ success: true, data: plain(rows.map((r) => ({ ...r, is_current: !!Number(r.is_current) }))), instructors_total: num(total) });
  } catch (e) { return serverError(req, res, "adminListAgreements", e); }
};

// GET /admin/agreements/:id  — texte + signataires / non-signataires
export const adminGetAgreement = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [a]: any = id ? await query("SELECT * FROM instructor_agreements WHERE id = ?", [id]) : [];
    if (!a) return fail(req, res, 404, "Contrat introuvable", "Agreement not found");
    const signed: any[] = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, s.signed_name, s.signed_at, s.ip_address
         FROM instructor_agreement_signatures s JOIN users u ON u.id = s.user_id WHERE s.agreement_id = ? ORDER BY s.signed_at DESC`, [id]);
    const pending: any[] = Number(a.is_current)
      ? await query(
          `SELECT u.id, u.first_name, u.last_name, u.email FROM users u
            WHERE ${ACTIVE_INSTRUCTOR_SQL} AND NOT EXISTS (SELECT 1 FROM instructor_agreement_signatures s WHERE s.user_id = u.id AND s.agreement_id = ?)`, [id])
      : [];
    return res.json({ success: true, data: plain({ ...a, is_current: !!Number(a.is_current), signed, pending }) });
  } catch (e) { return serverError(req, res, "adminGetAgreement", e); }
};

// POST /admin/agreements { title, body_fr, body_en, notify }
export const adminPublishAgreement = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const title = String(req.body?.title ?? "").trim().slice(0, 200);
    const bodyFr = String(req.body?.body_fr ?? "").trim();
    const bodyEn = String(req.body?.body_en ?? "").trim();
    if (title.length < 3 || bodyFr.length < 50 || bodyEn.length < 50)
      return fail(req, res, 400, "Titre et textes (FR et EN, 50 caractères min.) requis.", "Title and texts (FR and EN, 50 characters min.) are required.");
    const [{ v }]: any = await query("SELECT COALESCE(MAX(version), 0) AS v FROM instructor_agreements");
    const version = num(v) + 1;
    await query("UPDATE instructor_agreements SET is_current = 0");
    const r: any = await query(
      "INSERT INTO instructor_agreements (version, title, body_fr, body_en, is_current, created_by) VALUES (?, ?, ?, ?, 1, ?)",
      [version, title, bodyFr, bodyEn, req.user!.id]);
    await logAudit(req, "admin", "instructor.agreement_published", "user", null, null, { version, id: Number(r.insertId) });

    if (req.body?.notify) {
      const users: any[] = await query(`SELECT u.id FROM users u WHERE ${ACTIVE_INSTRUCTOR_SQL}`);
      for (const u of users) {
        void notifyUser(Number(u.id), {
          type: "warning",
          fr: { title: "Nouvelle version de la charte instructeur", body: "La charte a été mise à jour. Merci de la lire et de la signer à nouveau pour continuer à soumettre des cours." },
          en: { title: "New version of the instructor charter", body: "The charter has been updated. Please read and sign it again to keep submitting courses." },
          link: "/instructor/agreement",
          email: { ctaFr: "Lire et signer", ctaEn: "Read and sign" },
        });
      }
    }
    return res.status(201).json({ success: true, data: { id: Number(r.insertId), version } });
  } catch (e) { return serverError(req, res, "adminPublishAgreement", e); }
};
