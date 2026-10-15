// src/controllers/applicationReviewController.ts
// Suivi d'une candidature instructeur : commentaires (internes / visibles candidat),
// évaluation, entretiens (visio plateforme, lien externe ou téléphone) et rappels.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { tr, getUserLang, Lang } from "../utils/lang";
import { createNotification, notifyAdmins } from "../services/notification.service";
import {
  sendInterviewProposedEmail, sendInterviewConfirmedEmail, sendInterviewCancelledEmail,
  sendInterviewReminderEmail, sendApplicationCommentEmail, sendInformationRequestEmail, InterviewMailInfo,
} from "../services/mail.service";

// ══════════════════════════════════════════════════════
// TABLES
// ══════════════════════════════════════════════════════
let ready: Promise<void> | null = null;
export const ensureApplicationReviewTables = (): Promise<void> => {
  if (!ready) {
    ready = (async () => {
      const alters = [
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS candidate_can_reply TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS evaluation LONGTEXT NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS requested_fields LONGTEXT NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS proposed_course_category VARCHAR(150) NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS proposed_course_level VARCHAR(20) NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS cv_file VARCHAR(120) NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS cv_original_name VARCHAR(255) NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS certifications LONGTEXT NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS video_url VARCHAR(500) NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS weekly_hours TINYINT UNSIGNED NULL",
        "ALTER TABLE instructor_applications ADD COLUMN IF NOT EXISTS charter_accepted TINYINT(1) NOT NULL DEFAULT 0",
      ];
      for (const sql of alters) await query(sql);

      await query(`
        CREATE TABLE IF NOT EXISTS instructor_application_comments (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          application_id INT UNSIGNED NOT NULL,
          author_id INT UNSIGNED NOT NULL,
          author_role ENUM('admin','candidate') NOT NULL DEFAULT 'admin',
          visibility ENUM('internal','candidate') NOT NULL DEFAULT 'internal',
          body TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_app (application_id, created_at),
          CONSTRAINT fk_iac_app FOREIGN KEY (application_id) REFERENCES instructor_applications(id) ON DELETE CASCADE
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS instructor_interviews (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          application_id INT UNSIGNED NOT NULL,
          organizer_id INT UNSIGNED NOT NULL,
          scheduled_at DATETIME NOT NULL,
          duration_min SMALLINT UNSIGNED NOT NULL DEFAULT 30,
          mode ENUM('platform','external','phone') NOT NULL DEFAULT 'platform',
          room_code VARCHAR(40) NULL UNIQUE,
          external_url VARCHAR(500) NULL,
          status ENUM('proposed','confirmed','done','cancelled','declined') NOT NULL DEFAULT 'proposed',
          message TEXT NULL,
          candidate_note TEXT NULL,
          notes TEXT NULL,
          reminder_24h_sent TINYINT(1) NOT NULL DEFAULT 0,
          reminder_1h_sent TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_app (application_id),
          INDEX idx_sched (status, scheduled_at),
          CONSTRAINT fk_ii_app FOREIGN KEY (application_id) REFERENCES instructor_applications(id) ON DELETE CASCADE
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
};

// ══════════════════════════════════════════════════════
// OUTILS
// ══════════════════════════════════════════════════════
const plain = <T = any>(v: any): T =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)));

const frontendUrl = (path: string) =>
  `${(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "")}${path}`;

const jitsiDomain = () => (process.env.JITSI_DOMAIN || "meet.jit.si").replace(/^https?:\/\//, "").replace(/\/+$/, "");

const isHttpUrl = (v: unknown): boolean => {
  try { return ["http:", "https:"].includes(new URL(String(v)).protocol); } catch { return false; }
};

const joinUrlOf = (iv: any): string | null => {
  if (iv.mode === "platform" && iv.room_code) return frontendUrl(`/interview/${iv.room_code}`);
  if (iv.mode === "external" && iv.external_url) return iv.external_url;
  return null;
};

const mailInfo = (iv: any): InterviewMailInfo => ({
  scheduledAt: iv.scheduled_at,
  durationMin: Number(iv.duration_min),
  mode: iv.mode,
  joinUrl: joinUrlOf(iv),
  message: iv.message,
});

/** Interview exposé au client (avec lien de partage calculé). Le code de salle n'est donné qu'à qui doit le voir. */
const publicInterview = (iv: any) => ({
  id: Number(iv.id),
  application_id: Number(iv.application_id),
  scheduled_at: iv.scheduled_at,
  duration_min: Number(iv.duration_min),
  mode: iv.mode,
  status: iv.status,
  message: iv.message ?? null,
  candidate_note: iv.candidate_note ?? null,
  join_url: iv.status === "confirmed" ? joinUrlOf(iv) : null,
});

const parseJson = (v: any, fallback: any = null) => {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

const loadApp = async (id: any) => {
  const [app]: any = await query(
    `SELECT ia.id, ia.user_id, ia.status, ia.candidate_can_reply, u.first_name, u.last_name, u.email
       FROM instructor_applications ia JOIN users u ON u.id = ia.user_id WHERE ia.id = ?`,
    [id]
  );
  return app || null;
};

const err = (req: any, res: Response, code: number, fr: string, en: string) =>
  res.status(code).json({ success: false, message: tr(req, fr, en) });

const fail = (req: any, res: Response, name: string, e: unknown) => {
  console.error(`${name}:`, e);
  return err(req, res, 500, "Erreur serveur", "Server error");
};

// ══════════════════════════════════════════════════════
// GET /:id  (admin) — dossier complet
// ══════════════════════════════════════════════════════
export const getApplicationDetail = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const [app]: any = await query(
      `SELECT ia.*, u.first_name, u.last_name, u.email, u.created_at AS user_since
         FROM instructor_applications ia JOIN users u ON u.id = ia.user_id WHERE ia.id = ?`,
      [req.params.id]
    );
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");

    const comments = await query(
      `SELECT c.id, c.author_id, c.author_role, c.visibility, c.body, c.created_at,
              u.first_name, u.last_name
         FROM instructor_application_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.application_id = ? ORDER BY c.created_at ASC, c.id ASC`,
      [app.id]
    );
    const interviews: any[] = await query(
      `SELECT * FROM instructor_interviews WHERE application_id = ? ORDER BY scheduled_at DESC, id DESC`,
      [app.id]
    );

    return res.json({
      success: true,
      data: plain({
        ...app,
        has_cv_file: !!app.cv_file,
        cv_file: undefined,
        expertise_areas: parseJson(app.expertise_areas, []),
        certifications: parseJson(app.certifications, []),
        evaluation: parseJson(app.evaluation, null),
        requested_fields: parseJson(app.requested_fields, []),
        candidate_can_reply: !!Number(app.candidate_can_reply),
        comments,
        interviews: interviews.map((iv) => ({
          ...publicInterview(iv),
          notes: iv.notes ?? null,
          external_url: iv.external_url ?? null,
          room_code: iv.room_code ?? null,
          share_url: joinUrlOf(iv),
        })),
      }),
    });
  } catch (e) { return fail(req, res, "getApplicationDetail", e); }
};

// ══════════════════════════════════════════════════════
// GET /my  (candidat) — sa candidature + échanges visibles + entretiens
// ══════════════════════════════════════════════════════
export const getMyApplicationFull = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const userId = req.user?.id;
    if (!userId) return err(req, res, 401, "Non authentifié", "Not authenticated");

    const [app]: any = await query(
      `SELECT id, status, motivation, experience, linkedin_url, portfolio_url, cv_url, years_experience,
              expertise_areas, certifications, video_url, weekly_hours, proposed_course_description,
              sample_course_topic, proposed_course_category, proposed_course_level, cv_file, cv_original_name,
              review_note, submitted_at, reviewed_at, candidate_can_reply, requested_fields
         FROM instructor_applications WHERE user_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1`,
      [userId]
    );
    if (!app) return res.json({ success: true, data: null });

    const comments = await query(
      `SELECT c.id, c.author_role, c.body, c.created_at, u.first_name
         FROM instructor_application_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.application_id = ? AND c.visibility = 'candidate' ORDER BY c.created_at ASC, c.id ASC`,
      [app.id]
    );
    const interviews: any[] = await query(
      `SELECT * FROM instructor_interviews WHERE application_id = ? AND status <> 'cancelled' ORDER BY scheduled_at ASC`,
      [app.id]
    );
    const canReply = !!Number(app.candidate_can_reply) && ["pending", "under_review"].includes(app.status);

    return res.json({
      success: true,
      data: plain({
        ...app,
        has_cv_file: !!app.cv_file,
        cv_file: undefined,
        expertise_areas: parseJson(app.expertise_areas, []),
        certifications: parseJson(app.certifications, []),
        requested_fields: ["pending", "under_review"].includes(app.status) ? parseJson(app.requested_fields, []) : [],
        candidate_can_reply: canReply,
        comments,
        interviews: interviews.map(publicInterview),
      }),
    });
  } catch (e) { return fail(req, res, "getMyApplicationFull", e); }
};

// ══════════════════════════════════════════════════════
// COMMENTAIRES
// ══════════════════════════════════════════════════════
// POST /:id/comments (admin)  { body, visibility: 'internal' | 'candidate' }
export const addAdminComment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const body = String(req.body?.body ?? "").trim();
    const visibility = req.body?.visibility === "candidate" ? "candidate" : "internal";
    if (!body || body.length > 5000) return err(req, res, 400, "Commentaire vide ou trop long (max 5000)", "Comment is empty or too long (max 5000)");

    const app = await loadApp(req.params.id);
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");

    const result: any = await query(
      "INSERT INTO instructor_application_comments (application_id, author_id, author_role, visibility, body) VALUES (?, ?, 'admin', ?, ?)",
      [app.id, req.user!.id, visibility, body]
    );

    if (visibility === "candidate") {
      const lang = await getUserLang(app.user_id);
      const canReply = !!Number(app.candidate_can_reply) && ["pending", "under_review"].includes(app.status);
      sendApplicationCommentEmail(app.email, app.first_name, body, canReply, lang)
        .catch((e) => console.warn("Email commentaire candidature:", e.message));
      createNotification(Number(app.user_id), {
        type: "info",
        title: lang === "en" ? "New message about your application" : "Nouveau message sur votre candidature",
        message: body.slice(0, 200),
        link: "/become-instructor",
      }).catch(() => {});
    }
    return res.status(201).json({ success: true, data: { id: Number(result.insertId) } });
  } catch (e) { return fail(req, res, "addAdminComment", e); }
};

// DELETE /:id/comments/:cid (admin) — uniquement ses propres commentaires
export const deleteAdminComment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const result: any = await query(
      "DELETE FROM instructor_application_comments WHERE id = ? AND application_id = ? AND author_role = 'admin' AND author_id = ?",
      [req.params.cid, req.params.id, req.user!.id]
    );
    if (!Number(result?.affectedRows)) return err(req, res, 404, "Commentaire introuvable", "Comment not found");
    return res.json({ success: true });
  } catch (e) { return fail(req, res, "deleteAdminComment", e); }
};

// PATCH /:id/settings (admin) { candidate_can_reply }
export const updateApplicationSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const value = req.body?.candidate_can_reply ? 1 : 0;
    const app = await loadApp(req.params.id);
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");
    await query("UPDATE instructor_applications SET candidate_can_reply = ? WHERE id = ?", [value, app.id]);

    if (value && !Number(app.candidate_can_reply)) {
      const lang = await getUserLang(app.user_id);
      createNotification(Number(app.user_id), {
        type: "info",
        title: lang === "en" ? "You can now reply to the team" : "Vous pouvez désormais répondre à l'équipe",
        message: lang === "en" ? "The team opened the discussion on your application." : "L'équipe a ouvert l'échange sur votre candidature.",
        link: "/become-instructor",
      }).catch(() => {});
    }
    return res.json({ success: true, data: { candidate_can_reply: !!value } });
  } catch (e) { return fail(req, res, "updateApplicationSettings", e); }
};

// POST /my/comments (candidat) { body } — seulement si l'admin a autorisé les réponses
export const addCandidateComment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const userId = req.user!.id;
    const body = String(req.body?.body ?? "").trim();
    if (!body || body.length > 2000) return err(req, res, 400, "Message vide ou trop long (max 2000)", "Message is empty or too long (max 2000)");

    const [app]: any = await query(
      `SELECT ia.id, ia.status, ia.candidate_can_reply, u.first_name, u.last_name
         FROM instructor_applications ia JOIN users u ON u.id = ia.user_id
        WHERE ia.user_id = ? ORDER BY ia.submitted_at DESC, ia.id DESC LIMIT 1`,
      [userId]
    );
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");
    if (!Number(app.candidate_can_reply) || !["pending", "under_review"].includes(app.status))
      return err(req, res, 403, "Les réponses ne sont pas ouvertes pour cette candidature", "Replies are not enabled for this application");

    // Anti-flood : 20 messages / 24 h
    const [{ n }]: any = await query(
      "SELECT COUNT(*) AS n FROM instructor_application_comments WHERE application_id = ? AND author_role = 'candidate' AND created_at > NOW() - INTERVAL 1 DAY",
      [app.id]
    );
    if (Number(n) >= 20) return err(req, res, 429, "Trop de messages, réessayez plus tard", "Too many messages, try again later");

    const result: any = await query(
      "INSERT INTO instructor_application_comments (application_id, author_id, author_role, visibility, body) VALUES (?, ?, 'candidate', 'candidate', ?)",
      [app.id, userId, body]
    );
    void notifyAdmins({
      type: "instructor_application",
      title: `Réponse du candidat — ${app.first_name} ${app.last_name}`,
      message: body.slice(0, 300),
      link: "/admin/instructor-applications",
      data: { application_id: Number(app.id) },
    });
    return res.status(201).json({ success: true, data: { id: Number(result.insertId) } });
  } catch (e) { return fail(req, res, "addCandidateComment", e); }
};

// ══════════════════════════════════════════════════════
// COMPLÉMENT D'INFORMATION (l'admin demande des champs précis, le candidat les complète)
// ══════════════════════════════════════════════════════
const FIELD_LABELS: Record<string, [string, string]> = {
  motivation: ["Motivation", "Motivation"],
  experience: ["Parcours professionnel", "Professional background"],
  years_experience: ["Années d'expérience", "Years of experience"],
  expertise_areas: ["Domaines d'expertise", "Areas of expertise"],
  linkedin_url: ["Profil LinkedIn", "LinkedIn profile"],
  portfolio_url: ["Portfolio / GitHub", "Portfolio / GitHub"],
  cv_url: ["CV", "CV"],
  certifications: ["Certifications", "Certifications"],
  video_url: ["Vidéo de présentation", "Introduction video"],
  weekly_hours: ["Heures disponibles par semaine", "Weekly availability (hours)"],
  sample_course_topic: ["Titre du cours proposé", "Proposed course title"],
  proposed_course_description: ["Description du cours proposé", "Proposed course description"],
  proposed_course_category: ["Catégorie du cours", "Course category"],
  proposed_course_level: ["Niveau du cours", "Course level"],
};
const FIELD_KEYS = Object.keys(FIELD_LABELS);
const LIST_FIELDS = ["expertise_areas", "certifications"];

// POST /:id/request-info (admin) { fields: string[], message? }
export const requestInformation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const fields: string[] = [...new Set<string>((Array.isArray(req.body?.fields) ? req.body.fields : []).map(String))]
      .filter((f) => FIELD_KEYS.includes(f));
    if (!fields.length) return err(req, res, 400, "Sélectionnez au moins un champ à compléter", "Select at least one field to complete");
    const message = String(req.body?.message ?? "").trim().slice(0, 2000) || null;

    const app = await loadApp(req.params.id);
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");
    if (!["pending", "under_review"].includes(app.status))
      return err(req, res, 409, "Cette candidature est déjà clôturée", "This application is already closed");

    await query("UPDATE instructor_applications SET requested_fields = ? WHERE id = ?", [JSON.stringify(fields), app.id]);

    const lang = await getUserLang(app.user_id);
    const labels = fields.map((f) => FIELD_LABELS[f][lang === "en" ? 1 : 0]);
    // trace dans le fil de discussion (visible du candidat)
    await query(
      "INSERT INTO instructor_application_comments (application_id, author_id, author_role, visibility, body) VALUES (?, ?, 'admin', 'candidate', ?)",
      [app.id, req.user!.id,
       `${lang === "en" ? "Information requested" : "Complément demandé"} : ${labels.join(", ")}${message ? `\n${message}` : ""}`]
    );
    sendInformationRequestEmail(app.email, app.first_name, labels, message, lang)
      .catch((e) => console.warn("Email complément:", e.message));
    createNotification(Number(app.user_id), {
      type: "info",
      title: lang === "en" ? "Please complete your application" : "Merci de compléter votre dossier",
      message: labels.join(", "),
      link: "/become-instructor",
    }).catch(() => {});

    return res.json({ success: true, data: { requested_fields: fields } });
  } catch (e) { return fail(req, res, "requestInformation", e); }
};

// DELETE /:id/request-info (admin) — annuler la demande en cours
export const cancelInformationRequest = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    await query("UPDATE instructor_applications SET requested_fields = NULL WHERE id = ?", [req.params.id]);
    return res.json({ success: true });
  } catch (e) { return fail(req, res, "cancelInformationRequest", e); }
};

// PATCH /my/complete (candidat) { <champ>: valeur } — uniquement les champs demandés
export const completeMyApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const userId = req.user!.id;
    const [app]: any = await query(
      `SELECT ia.id, ia.status, ia.requested_fields, u.first_name, u.last_name
         FROM instructor_applications ia JOIN users u ON u.id = ia.user_id
        WHERE ia.user_id = ? ORDER BY ia.submitted_at DESC, ia.id DESC LIMIT 1`,
      [userId]
    );
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");
    if (!["pending", "under_review"].includes(app.status))
      return err(req, res, 409, "Cette candidature est déjà clôturée", "This application is already closed");

    const requested: string[] = parseJson(app.requested_fields, []);
    const body = req.body || {};
    const sent = Object.keys(body).filter((k) => requested.includes(k));
    if (!sent.length) return err(req, res, 400, "Aucun champ demandé à compléter", "No requested field to complete");

    const urlOk = (v: any, host?: string) => {
      try {
        const u = new URL(String(v));
        return ["http:", "https:"].includes(u.protocol) && (!host || u.hostname.toLowerCase().endsWith(host));
      } catch { return false; }
    };
    const errors: Record<string, string> = {};
    const values: Record<string, any> = {};
    for (const k of sent) {
      const raw = body[k];
      if (LIST_FIELDS.includes(k)) {
        const list = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;\n]/)).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 20);
        if (!list.length) errors[k] = tr(req, "Champ requis", "Required field");
        else values[k] = JSON.stringify(list);
        continue;
      }
      const s = String(raw ?? "").trim();
      if (!s) { errors[k] = tr(req, "Champ requis", "Required field"); continue; }
      if (k === "motivation" && s.length < 50) errors[k] = tr(req, "Minimum 50 caractères", "Minimum 50 characters");
      else if (k === "experience" && s.length < 30) errors[k] = tr(req, "Minimum 30 caractères", "Minimum 30 characters");
      else if (k === "sample_course_topic" && s.length < 5) errors[k] = tr(req, "Minimum 5 caractères", "Minimum 5 characters");
      else if (k === "years_experience") {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 0 || n > 60) errors[k] = tr(req, "Nombre entier invalide", "Invalid whole number");
        else values[k] = n;
      } else if (k === "weekly_hours") {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 1 || n > 80) errors[k] = tr(req, "Entre 1 et 80", "Between 1 and 80");
        else values[k] = n;
      } else if (k === "proposed_course_level") {
        if (!["beginner", "intermediate", "advanced"].includes(s)) errors[k] = tr(req, "Niveau invalide", "Invalid level");
        else values[k] = s;
      } else if (k === "proposed_course_category") {
        values[k] = s.slice(0, 150);
      } else if (k === "linkedin_url") {
        if (!urlOk(s, "linkedin.com")) errors[k] = tr(req, "URL LinkedIn invalide", "Invalid LinkedIn URL");
        else values[k] = s;
      } else if (["portfolio_url", "cv_url", "video_url"].includes(k)) {
        if (!urlOk(s)) errors[k] = tr(req, "URL invalide", "Invalid URL");
        else values[k] = s;
      } else values[k] = s.slice(0, k === "proposed_course_description" ? 5000 : 5000);
    }
    if (Object.keys(errors).length)
      return res.status(400).json({ success: false, message: tr(req, "Certains champs sont invalides", "Some fields are invalid"), errors });

    const cols = Object.keys(values);   // déjà filtré sur FIELD_KEYS via `requested`
    const safeCols = cols.filter((c) => FIELD_KEYS.includes(c));
    const remaining = requested.filter((f) => !safeCols.includes(f));
    await query(
      `UPDATE instructor_applications SET ${safeCols.map((c) => `${c} = ?`).join(", ")}, requested_fields = ? WHERE id = ?`,
      [...safeCols.map((c) => values[c]), remaining.length ? JSON.stringify(remaining) : null, app.id]
    );

    const labels = safeCols.map((c) => FIELD_LABELS[c][0]);
    await query(
      "INSERT INTO instructor_application_comments (application_id, author_id, author_role, visibility, body) VALUES (?, ?, 'candidate', 'internal', ?)",
      [app.id, userId, `✅ Dossier complété par le candidat : ${labels.join(", ")}${remaining.length ? ` (reste ${remaining.length} champ(s) demandé(s))` : ""}`]
    );
    void notifyAdmins({
      type: "instructor_application",
      title: `Dossier complété — ${app.first_name} ${app.last_name}`,
      message: labels.join(", "),
      link: "/admin/instructor-applications",
      data: { application_id: Number(app.id) },
    });
    return res.json({ success: true, data: { remaining } });
  } catch (e) { return fail(req, res, "completeMyApplication", e); }
};

// ══════════════════════════════════════════════════════
// CV (fichier privé : jamais servi par /uploads, accessible au candidat et aux admins)
// ══════════════════════════════════════════════════════
const CV_DIR = path.join(process.cwd(), "private", "instructor-cv");
const CV_MIME = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i;
const cvUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => { fs.mkdirSync(CV_DIR, { recursive: true }); cb(null, CV_DIR); },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 6);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => (CV_MIME.test(f.mimetype) ? cb(null, true) : cb(new Error("UNSUPPORTED"))),
}).single("file");

// signature réelle du fichier (le type MIME envoyé par le navigateur ne suffit pas)
const looksLikeCv = (file: string): boolean => {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return buf.subarray(0, 4).toString() === "%PDF"                      // PDF
      || (buf[0] === 0x50 && buf[1] === 0x4b)                            // DOCX (zip)
      || (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11);        // DOC
  } catch { return false; }
};

const removeCvFile = (name?: string | null) => {
  if (!name) return;
  fs.promises.unlink(path.join(CV_DIR, path.basename(name))).catch(() => {});
};

// POST /my/cv (candidat) — multipart, champ « file »
export const uploadMyCv = (req: AuthenticatedRequest, res: Response) => {
  cvUpload(req as any, res as any, async (uploadErr: any) => {
    try {
      await ensureApplicationReviewTables();
      const file = (req as any).file as Express.Multer.File | undefined;
      if (uploadErr) {
        const big = uploadErr.code === "LIMIT_FILE_SIZE";
        return err(req, res, big ? 413 : 400,
          big ? "CV trop volumineux (max 5 Mo)" : "Format non pris en charge (PDF, DOC ou DOCX)",
          big ? "CV too large (max 5 MB)" : "Unsupported format (PDF, DOC or DOCX)");
      }
      if (!file) return err(req, res, 400, "Aucun fichier reçu", "No file received");
      if (!looksLikeCv(file.path)) { removeCvFile(file.filename); return err(req, res, 400, "Fichier invalide", "Invalid file"); }

      const [app]: any = await query(
        `SELECT ia.id, ia.status, ia.cv_file, ia.requested_fields, u.first_name, u.last_name
           FROM instructor_applications ia JOIN users u ON u.id = ia.user_id
          WHERE ia.user_id = ? ORDER BY ia.submitted_at DESC, ia.id DESC LIMIT 1`,
        [req.user!.id]
      );
      if (!app) { removeCvFile(file.filename); return err(req, res, 404, "Candidature introuvable", "Application not found"); }
      if (!["pending", "under_review"].includes(app.status)) { removeCvFile(file.filename); return err(req, res, 409, "Cette candidature est déjà clôturée", "This application is already closed"); }

      const original = path.basename(file.originalname).slice(0, 200);
      const remaining = parseJson(app.requested_fields, []).filter((f: string) => f !== "cv_url");
      await query(
        "UPDATE instructor_applications SET cv_file = ?, cv_original_name = ?, requested_fields = ? WHERE id = ?",
        [file.filename, original, remaining.length ? JSON.stringify(remaining) : null, app.id]
      );
      removeCvFile(app.cv_file);   // remplace l'ancien CV

      void notifyAdmins({
        type: "instructor_application",
        title: `CV déposé — ${app.first_name} ${app.last_name}`,
        message: original,
        link: "/admin/instructor-applications",
        data: { application_id: Number(app.id) },
      });
      return res.json({ success: true, data: { cv_original_name: original } });
    } catch (e) { return fail(req, res, "uploadMyCv", e); }
  });
};

const sendCv = async (req: AuthenticatedRequest, res: Response, where: string, param: any) => {
  const [row]: any = await query(`SELECT cv_file, cv_original_name FROM instructor_applications WHERE ${where}`, [param]);
  if (!row?.cv_file) return err(req, res, 404, "Aucun CV déposé", "No CV uploaded");
  const full = path.join(CV_DIR, path.basename(row.cv_file));
  if (!fs.existsSync(full)) return err(req, res, 404, "Fichier introuvable", "File not found");
  return res.download(full, row.cv_original_name || "cv");
};

// GET /my/cv (candidat)
export const downloadMyCv = async (req: AuthenticatedRequest, res: Response) => {
  try { await sendCv(req, res, "user_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1", req.user!.id); }
  catch (e) { fail(req, res, "downloadMyCv", e); }
};
// GET /:id/cv (admin)
export const downloadApplicationCv = async (req: AuthenticatedRequest, res: Response) => {
  try { await sendCv(req, res, "id = ?", req.params.id); }
  catch (e) { fail(req, res, "downloadApplicationCv", e); }
};

// PATCH /:id/reopen (admin) — remettre une candidature acceptée / rejetée en révision
// Le rôle de l'utilisateur n'est pas modifié ; seule l'approbation ou le refus le fait.
export const reopenApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const [app]: any = await query(
      "SELECT id, user_id, status, review_note FROM instructor_applications WHERE id = ?",
      [req.params.id]
    );
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");
    if (!["accepted", "rejected"].includes(app.status))
      return err(req, res, 409, "Seule une candidature clôturée peut être rouverte", "Only a closed application can be reopened");

    // garder la trace de la décision précédente avant de vider le motif
    const trace = `🔄 Candidature remise en révision (décision précédente : ${app.status === "accepted" ? "acceptée" : "rejetée"}${app.review_note ? ` — motif : ${app.review_note}` : ""})`;
    await query(
      "INSERT INTO instructor_application_comments (application_id, author_id, author_role, visibility, body) VALUES (?, ?, 'admin', 'internal', ?)",
      [app.id, req.user!.id, trace]
    );
    await query(
      "UPDATE instructor_applications SET status = 'under_review', reviewed_by = ?, reviewed_at = NULL, review_note = NULL WHERE id = ?",
      [req.user!.id, app.id]
    );
    return res.json({ success: true, data: { status: "under_review" } });
  } catch (e) { return fail(req, res, "reopenApplication", e); }
};

// ══════════════════════════════════════════════════════
// ÉVALUATION
// ══════════════════════════════════════════════════════
// PUT /:id/evaluation (admin) { technical, pedagogy, motivation: 1..5|null, recommendation: yes|maybe|no|null }
export const saveEvaluation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const rating = (v: any) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
    };
    const technical = rating(req.body?.technical);
    const pedagogy = rating(req.body?.pedagogy);
    const motivation = rating(req.body?.motivation);
    if ([technical, pedagogy, motivation].includes(undefined as any))
      return err(req, res, 400, "Les notes doivent être comprises entre 1 et 5", "Ratings must be between 1 and 5");
    const rec = ["yes", "maybe", "no"].includes(req.body?.recommendation) ? req.body.recommendation : null;

    const app = await loadApp(req.params.id);
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");

    const evaluation = { technical, pedagogy, motivation, recommendation: rec, evaluated_by: req.user!.id, evaluated_at: new Date().toISOString() };
    await query("UPDATE instructor_applications SET evaluation = ? WHERE id = ?", [JSON.stringify(evaluation), app.id]);
    return res.json({ success: true, data: evaluation });
  } catch (e) { return fail(req, res, "saveEvaluation", e); }
};

// ══════════════════════════════════════════════════════
// ENTRETIENS
// ══════════════════════════════════════════════════════
const newRoomCode = () => crypto.randomBytes(12).toString("hex");

// POST /:id/interviews (admin)
// { slots: [ISO,...], duration_min, mode, external_url, message, confirmed }
export const createInterviews = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const app = await loadApp(req.params.id);
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");
    if (["accepted", "rejected"].includes(app.status))
      return err(req, res, 409, "Cette candidature est déjà clôturée", "This application is already closed");

    const mode = ["platform", "external", "phone"].includes(req.body?.mode) ? req.body.mode : "platform";
    const duration = Math.min(180, Math.max(15, Number(req.body?.duration_min) || 30));
    const externalUrl = String(req.body?.external_url ?? "").trim();
    if (mode === "external" && !isHttpUrl(externalUrl))
      return err(req, res, 400, "Lien de visio externe invalide", "Invalid external meeting link");
    const message = String(req.body?.message ?? "").trim().slice(0, 2000) || null;
    const confirmed = !!req.body?.confirmed;

    const rawSlots: unknown[] = Array.isArray(req.body?.slots) ? req.body.slots : [];
    const now = Date.now();
    const slots = rawSlots.slice(0, 5).map((s) => new Date(String(s)));
    if (!slots.length || slots.some((d) => isNaN(d.getTime()) || d.getTime() < now - 60_000 || d.getTime() > now + 366 * 86400_000))
      return err(req, res, 400, "Créneau invalide (doit être dans le futur)", "Invalid slot (must be in the future)");
    if (confirmed && slots.length !== 1)
      return err(req, res, 400, "Un entretien confirmé n'a qu'un seul créneau", "A confirmed interview has a single slot");

    const created: any[] = [];
    for (const d of slots) {
      const status = confirmed ? "confirmed" : "proposed";
      const within24h = d.getTime() - now <= 24 * 3600_000;
      const result: any = await query(
        `INSERT INTO instructor_interviews
           (application_id, organizer_id, scheduled_at, duration_min, mode, room_code, external_url, status, message, reminder_24h_sent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [app.id, req.user!.id, d, duration, mode, mode === "platform" ? newRoomCode() : null,
         mode === "external" ? externalUrl : null, status, message, confirmed && within24h ? 1 : 0]
      );
      const [row]: any = await query("SELECT * FROM instructor_interviews WHERE id = ?", [Number(result.insertId)]);
      created.push(row);
    }

    if (app.status === "pending")
      await query("UPDATE instructor_applications SET status = 'under_review', reviewed_by = ? WHERE id = ?", [req.user!.id, app.id]);

    const lang = await getUserLang(app.user_id);
    if (confirmed) {
      sendInterviewConfirmedEmail(app.email, app.first_name, `iv-${created[0].id}`, mailInfo(created[0]), lang)
        .catch((e) => console.warn("Email entretien confirmé:", e.message));
    } else {
      sendInterviewProposedEmail(app.email, app.first_name, slots,
        { durationMin: duration, mode, joinUrl: null, message }, lang)
        .catch((e) => console.warn("Email entretien proposé:", e.message));
    }
    createNotification(Number(app.user_id), {
      type: "info",
      title: confirmed
        ? (lang === "en" ? "Interview confirmed" : "Entretien confirmé")
        : (lang === "en" ? "An interview is proposed" : "Un entretien vous est proposé"),
      message: lang === "en" ? "Check the details on your application page." : "Consultez les détails sur la page de votre candidature.",
      link: "/become-instructor",
    }).catch(() => {});

    return res.status(201).json({ success: true, data: plain(created.map(publicInterview)) });
  } catch (e) { return fail(req, res, "createInterviews", e); }
};

// PATCH /:id/interviews/:iid (admin)
// { action: 'confirm' | 'cancel' | 'done' | 'reschedule', notes?, scheduled_at? }
export const updateInterview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const app = await loadApp(req.params.id);
    if (!app) return err(req, res, 404, "Candidature introuvable", "Application not found");
    const [iv]: any = await query("SELECT * FROM instructor_interviews WHERE id = ? AND application_id = ?", [req.params.iid, app.id]);
    if (!iv) return err(req, res, 404, "Entretien introuvable", "Interview not found");

    const action = String(req.body?.action ?? "");
    const lang: Lang = await getUserLang(app.user_id);

    if (action === "cancel") {
      if (["cancelled", "done"].includes(iv.status)) return err(req, res, 409, "Entretien déjà terminé ou annulé", "Interview already finished or cancelled");
      await query("UPDATE instructor_interviews SET status = 'cancelled' WHERE id = ?", [iv.id]);
      if (iv.status === "confirmed") {
        sendInterviewCancelledEmail(app.email, app.first_name, `iv-${iv.id}`, mailInfo(iv), lang)
          .catch((e) => console.warn("Email entretien annulé:", e.message));
      }
    } else if (action === "confirm") {
      if (iv.status !== "proposed") return err(req, res, 409, "Seul un créneau proposé peut être confirmé", "Only a proposed slot can be confirmed");
      const within24h = new Date(iv.scheduled_at).getTime() - Date.now() <= 24 * 3600_000;
      await query("UPDATE instructor_interviews SET status = 'confirmed', reminder_24h_sent = ? WHERE id = ?", [within24h ? 1 : 0, iv.id]);
      await query("UPDATE instructor_interviews SET status = 'cancelled' WHERE application_id = ? AND status = 'proposed' AND id <> ?", [app.id, iv.id]);
      sendInterviewConfirmedEmail(app.email, app.first_name, `iv-${iv.id}`, mailInfo({ ...iv, status: "confirmed" }), lang)
        .catch((e) => console.warn("Email entretien confirmé:", e.message));
    } else if (action === "done") {
      const notes = String(req.body?.notes ?? "").trim().slice(0, 5000);
      await query("UPDATE instructor_interviews SET status = 'done', notes = ? WHERE id = ?", [notes || null, iv.id]);
      if (notes) {
        await query(
          "INSERT INTO instructor_application_comments (application_id, author_id, author_role, visibility, body) VALUES (?, ?, 'admin', 'internal', ?)",
          [app.id, req.user!.id, `📝 Compte-rendu d'entretien\n${notes}`]
        );
      }
    } else if (action === "reschedule") {
      const d = new Date(String(req.body?.scheduled_at ?? ""));
      if (isNaN(d.getTime()) || d.getTime() < Date.now() - 60_000) return err(req, res, 400, "Créneau invalide", "Invalid slot");
      if (!["proposed", "confirmed"].includes(iv.status)) return err(req, res, 409, "Entretien non modifiable", "Interview cannot be changed");
      const within24h = d.getTime() - Date.now() <= 24 * 3600_000;
      await query(
        "UPDATE instructor_interviews SET scheduled_at = ?, reminder_24h_sent = ?, reminder_1h_sent = 0 WHERE id = ?",
        [d, iv.status === "confirmed" && within24h ? 1 : 0, iv.id]
      );
      const updated = { ...iv, scheduled_at: d };
      if (iv.status === "confirmed") {
        sendInterviewConfirmedEmail(app.email, app.first_name, `iv-${iv.id}`, mailInfo(updated), lang)
          .catch((e) => console.warn("Email entretien reprogrammé:", e.message));
      } else {
        sendInterviewProposedEmail(app.email, app.first_name, [d],
          { durationMin: Number(iv.duration_min), mode: iv.mode, message: iv.message }, lang)
          .catch((e) => console.warn("Email entretien proposé:", e.message));
      }
    } else {
      return err(req, res, 400, "Action inconnue", "Unknown action");
    }

    const [fresh]: any = await query("SELECT * FROM instructor_interviews WHERE id = ?", [iv.id]);
    return res.json({ success: true, data: plain(publicInterview(fresh)) });
  } catch (e) { return fail(req, res, "updateInterview", e); }
};

// POST /my/interviews/:iid/respond (candidat) { action: 'accept' | 'decline', note? }
export const respondToInterview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const userId = req.user!.id;
    const action = String(req.body?.action ?? "");
    const note = String(req.body?.note ?? "").trim().slice(0, 1000) || null;
    if (!["accept", "decline"].includes(action)) return err(req, res, 400, "Action inconnue", "Unknown action");

    const [iv]: any = await query(
      `SELECT iv.*, ia.user_id, u.first_name, u.last_name, u.email
         FROM instructor_interviews iv
         JOIN instructor_applications ia ON ia.id = iv.application_id
         JOIN users u ON u.id = ia.user_id
        WHERE iv.id = ? AND ia.user_id = ?`,
      [req.params.iid, userId]
    );
    if (!iv) return err(req, res, 404, "Entretien introuvable", "Interview not found");
    if (iv.status !== "proposed") return err(req, res, 409, "Ce créneau n'est plus ouvert à réponse", "This slot is no longer open for a reply");
    if (new Date(iv.scheduled_at).getTime() < Date.now())
      return err(req, res, 409, "Ce créneau est passé", "This slot is in the past");

    const name = `${iv.first_name} ${iv.last_name}`.trim();
    if (action === "accept") {
      const within24h = new Date(iv.scheduled_at).getTime() - Date.now() <= 24 * 3600_000;
      await query("UPDATE instructor_interviews SET status = 'confirmed', candidate_note = ?, reminder_24h_sent = ? WHERE id = ?", [note, within24h ? 1 : 0, iv.id]);
      await query("UPDATE instructor_interviews SET status = 'cancelled' WHERE application_id = ? AND status = 'proposed' AND id <> ?", [iv.application_id, iv.id]);
      const lang = await getUserLang(userId);
      sendInterviewConfirmedEmail(iv.email, iv.first_name, `iv-${iv.id}`, mailInfo({ ...iv, status: "confirmed" }), lang)
        .catch((e) => console.warn("Email entretien confirmé:", e.message));
      void notifyAdmins({
        type: "instructor_application",
        title: `Créneau accepté — ${name}`,
        message: `${name} a accepté l'entretien du ${new Date(iv.scheduled_at).toISOString()}.`,
        link: "/admin/instructor-applications",
        data: { application_id: Number(iv.application_id) },
      });
    } else {
      await query("UPDATE instructor_interviews SET status = 'declined', candidate_note = ? WHERE id = ?", [note, iv.id]);
      void notifyAdmins({
        type: "instructor_application",
        title: `Créneau refusé — ${name}`,
        message: note ? `Message du candidat : ${note}` : `${name} ne peut pas honorer ce créneau.`,
        link: "/admin/instructor-applications",
        data: { application_id: Number(iv.application_id) },
      });
    }
    return res.json({ success: true });
  } catch (e) { return fail(req, res, "respondToInterview", e); }
};

// ══════════════════════════════════════════════════════
// SALLE (publique, protégée par le code aléatoire du lien)
// GET /interview-room/:code
// ══════════════════════════════════════════════════════
const OPENS_BEFORE_MS = 30 * 60_000;
const CLOSES_AFTER_MS = 3 * 3600_000;

export const getInterviewRoom = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureApplicationReviewTables();
    const code = String(req.params.code ?? "");
    if (!/^[a-f0-9]{24}$/.test(code)) return err(req, res, 404, "Salle introuvable", "Room not found");
    const [iv]: any = await query(
      `SELECT iv.*, u.first_name FROM instructor_interviews iv
         JOIN instructor_applications ia ON ia.id = iv.application_id
         JOIN users u ON u.id = ia.user_id
        WHERE iv.room_code = ? AND iv.mode = 'platform'`,
      [code]
    );
    if (!iv) return err(req, res, 404, "Salle introuvable", "Room not found");

    const start = new Date(iv.scheduled_at).getTime();
    const end = start + Number(iv.duration_min) * 60_000;
    const now = Date.now();
    let state: "waiting" | "open" | "ended" | "cancelled" | "unconfirmed";
    if (iv.status === "cancelled" || iv.status === "declined") state = "cancelled";
    else if (iv.status === "proposed") state = "unconfirmed";
    else if (iv.status === "done" || now > Math.max(end, start) + CLOSES_AFTER_MS) state = "ended";
    else if (now < start - OPENS_BEFORE_MS) state = "waiting";
    else state = "open";

    return res.json({
      success: true,
      data: {
        state,
        scheduled_at: iv.scheduled_at,
        duration_min: Number(iv.duration_min),
        candidate_first_name: iv.first_name,
        opens_at: new Date(start - OPENS_BEFORE_MS).toISOString(),
        // le nom de salle n'est divulgué que quand elle est ouverte
        room: state === "open" ? `DevOpsAkademy-${code}` : null,
        jitsi_domain: jitsiDomain(),
      },
    });
  } catch (e) { return fail(req, res, "getInterviewRoom", e); }
};

// ══════════════════════════════════════════════════════
// RAPPELS (24 h et 1 h avant)
// ══════════════════════════════════════════════════════
const runReminders = async () => {
  try {
    await ensureApplicationReviewTables();
    for (const [flag, hours, sqlWindow] of [
      ["reminder_24h_sent", 24, "iv.scheduled_at <= NOW() + INTERVAL 24 HOUR AND iv.scheduled_at > NOW() + INTERVAL 1 HOUR"],
      ["reminder_1h_sent", 1, "iv.scheduled_at <= NOW() + INTERVAL 1 HOUR AND iv.scheduled_at > NOW()"],
    ] as const) {
      const due: any[] = await query(
        `SELECT iv.*, ia.user_id, u.first_name, u.email
           FROM instructor_interviews iv
           JOIN instructor_applications ia ON ia.id = iv.application_id
           JOIN users u ON u.id = ia.user_id
          WHERE iv.status = 'confirmed' AND iv.${flag} = 0 AND ${sqlWindow}`
      );
      for (const iv of due) {
        // marquer d'abord : un échec d'envoi ne doit pas provoquer de boucle de rappels
        await query(`UPDATE instructor_interviews SET ${flag} = 1 WHERE id = ?`, [iv.id]);
        const lang = await getUserLang(iv.user_id);
        sendInterviewReminderEmail(iv.email, iv.first_name, mailInfo(iv), hours, lang)
          .catch((e) => console.warn("Email rappel entretien:", e.message));
        const when = new Date(iv.scheduled_at).toISOString();
        createNotification(Number(iv.user_id), {
          type: "info",
          title: lang === "en" ? "Interview reminder" : "Rappel d'entretien",
          message: when,
          link: "/become-instructor",
        }).catch(() => {});
        createNotification(Number(iv.organizer_id), {
          type: "info",
          title: `Rappel entretien — ${iv.first_name}`,
          message: when,
          link: "/admin/instructor-applications",
        }).catch(() => {});
      }
    }
  } catch (e: any) {
    console.warn("Rappels entretiens:", e?.message || e);
  }
};

export const startInterviewReminders = (): void => {
  setInterval(runReminders, 5 * 60_000).unref?.();
  setTimeout(runReminders, 30_000).unref?.();
};
