// src/controllers/submissionController.ts
// Devoirs / projets pratiques sur les tables réelles `projects` et `project_submissions`
// (+ `submission_files` pour les pièces jointes multiples).
import { Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { query, withTransaction } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { tr, getUserLang } from "../utils/lang";
import { toPlain, parseId } from "../utils/serialize";
import { fail, serverError, logAudit } from "../utils/respond";
import { publicBaseUrl, isSafeMediaUrl } from "../utils/publicUrl";
import { getCourseAccess, isAdminRole } from "../utils/courseAccess";
import { createNotification, notifyAdmins } from "../services/notification.service";

type Req = AuthenticatedRequest;

// ── Schéma (idempotent, appliqué paresseusement) ──
let schemaReady: Promise<void> | null = null;
export const ensureSubmissionSchema = (): Promise<void> => {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query("ALTER TABLE project_submissions ADD COLUMN IF NOT EXISTS title VARCHAR(255) NULL AFTER course_id");
      await query(
        `CREATE TABLE IF NOT EXISTS submission_files (
           id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           submission_id     INT UNSIGNED NOT NULL,
           filename          VARCHAR(255) NOT NULL,
           original_filename VARCHAR(255) NOT NULL,
           file_url          VARCHAR(500) NOT NULL,
           file_size         INT UNSIGNED NOT NULL DEFAULT 0,
           file_type         VARCHAR(120) NULL,
           created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           KEY idx_submission (submission_id),
           CONSTRAINT fk_submission_files_sub FOREIGN KEY (submission_id) REFERENCES project_submissions(id) ON DELETE CASCADE
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
};

const PENDING_STATUSES = ["submitted", "under_review", "sla_exceeded"];
const VISIBLE_STATUSES = [...PENDING_STATUSES, "validated", "rejected"];
const clientStatus = (s: string) => (s === "validated" ? "approved" : s === "rejected" ? "rejected" : "pending");

const absUrl = (req: Req, v: any): string => {
  const s = String(v ?? "");
  return s.startsWith("/uploads/") ? `${publicBaseUrl(req)}${s}` : s;
};

// ── Sélection commune + mise en forme ──
const SELECT = `
  SELECT ps.id, ps.project_id, ps.user_id, ps.course_id, ps.title AS own_title, ps.status, ps.submission_url, ps.file_url,
         ps.student_notes, ps.submitted_at, ps.score, ps.passed, ps.corrector_id, ps.corrector_feedback, ps.reviewed_at,
         ps.sla_deadline_at, ps.attempt_number, ps.created_at,
         p.title AS project_title, p.pass_score,
         c.title AS course_title,
         u.first_name, u.last_name, u.email AS user_email
    FROM project_submissions ps
    JOIN projects p ON p.id = ps.project_id
    JOIN courses c  ON c.id = ps.course_id
    JOIN users u    ON u.id = ps.user_id`;

async function shapeRows(req: Req, rows: any[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const files = toPlain<any[]>(await query(
    `SELECT submission_id, original_filename, file_url, file_size, file_type FROM submission_files
      WHERE submission_id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC`, ids
  ));
  const byId = new Map<number, any[]>();
  for (const f of files) {
    if (!byId.has(f.submission_id)) byId.set(f.submission_id, []);
    byId.get(f.submission_id)!.push({ name: f.original_filename, url: absUrl(req, f.file_url), size: f.file_size, type: f.file_type });
  }
  return rows.map((r) => {
    const list = byId.get(r.id) ? [...byId.get(r.id)!] : [];
    if (!list.length && r.file_url) list.push({ name: path.basename(String(r.file_url)), url: absUrl(req, r.file_url), size: 0, type: null });
    if (r.submission_url) list.push({ name: String(r.submission_url), url: String(r.submission_url), size: 0, type: "link" });
    return {
      id: r.id,
      project_id: r.project_id,
      project_title: r.project_title,
      course_id: r.course_id,
      course_title: r.course_title,
      user_id: r.user_id,
      user_name: `${r.first_name || ""} ${r.last_name || ""}`.trim(),
      user_email: r.user_email,
      title: r.own_title || r.project_title,
      description: r.student_notes,
      status: clientStatus(r.status),
      raw_status: r.status,
      feedback: r.corrector_feedback,
      grade: r.score === null || r.score === undefined ? null : Math.round((Number(r.score) / 5) * 2) / 2, // /20
      score: r.score,
      passed: r.passed === null || r.passed === undefined ? null : Number(r.passed) === 1,
      pass_score: r.pass_score,
      attempt: r.attempt_number,
      submission_url: r.submission_url,
      files: list,
      created_at: r.created_at,
      submitted_at: r.submitted_at,
      reviewed_at: r.reviewed_at,
      sla_deadline_at: r.sla_deadline_at,
    };
  });
}

// ═══════════ Téléversement ═══════════
const ALLOWED_TYPES = [
  "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip", "application/x-zip-compressed", "image/jpeg", "image/png", "text/plain",
  "application/json", "application/x-yaml", "text/yaml", "application/yaml",
];

const uploader = multer({
  storage: multer.diskStorage({
    destination: (req: any, _file, cb) => {
      const dir = path.join(process.cwd(), "uploads", "submissions", String(req.user?.id ?? "unknown"));
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignoré */ }
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "");
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => (ALLOWED_TYPES.includes(file.mimetype) ? cb(null, true) : cb(new Error("INVALID_FILE_TYPE"))),
}).array("files", 10);

const removeFiles = (files: Express.Multer.File[]) => {
  for (const f of files) { try { fs.unlinkSync(f.path); } catch { /* déjà supprimé */ } }
};

// POST /api/submissions  (multipart : title, description, course_id, [project_id], [submission_url], files[])
export const createSubmission = (req: Req, res: Response) => {
  uploader(req as any, res as any, async (err: any) => {
    const files: Express.Multer.File[] = ((req as any).files as Express.Multer.File[]) || [];
    try {
      if (err) {
        if (err.message === "INVALID_FILE_TYPE") return fail(req, res, 400, "Format de fichier non supporté", "Unsupported file format");
        if (err.code === "LIMIT_FILE_SIZE") return fail(req, res, 413, "Fichier trop volumineux (10 Mo max)", "File too large (10 MB max)");
        if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") return fail(req, res, 400, "Trop de fichiers (10 max)", "Too many files (10 max)");
        return serverError(req, res, "createSubmission/upload", err);
      }
      await ensureSubmissionSchema();
      const uid = req.user!.id;
      const courseId = parseId(req.body?.course_id);
      const title = String(req.body?.title ?? "").trim().slice(0, 255);
      const description = String(req.body?.description ?? "").trim().slice(0, 5000);
      const url = String(req.body?.submission_url ?? "").trim();

      if (!courseId) { removeFiles(files); return fail(req, res, 400, "Cours invalide", "Invalid course"); }
      if (!title) { removeFiles(files); return fail(req, res, 400, "Le titre est obligatoire", "Title is required"); }
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) { removeFiles(files); return fail(req, res, 400, "URL de dépôt invalide", "Invalid repository URL"); }
      if (!files.length && !url) { removeFiles(files); return fail(req, res, 400, "Ajoutez au moins un fichier ou un lien", "Add at least one file or a link"); }

      const [enr]: any = await query(
        "SELECT id FROM course_enrollments WHERE user_id = ? AND course_id = ? AND is_approved = 1 LIMIT 1", [uid, courseId]
      );
      if (!enr) {
        removeFiles(files);
        return fail(req, res, 403, "Vous devez être inscrit et validé dans ce cours pour soumettre des travaux", "You must be enrolled and approved in this course to submit work");
      }

      const projectId = parseId(req.body?.project_id);
      const [project]: any = projectId
        ? await query("SELECT * FROM projects WHERE id = ? AND course_id = ? AND is_active = 1", [projectId, courseId])
        : await query("SELECT * FROM projects WHERE course_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1", [courseId]);
      if (!project) { removeFiles(files); return fail(req, res, 404, "Aucun projet à rendre pour ce cours", "No project to submit for this course"); }

      const [open]: any = await query(
        "SELECT id, status FROM project_submissions WHERE user_id = ? AND project_id = ? AND status IN ('submitted','under_review','sla_exceeded','validated') LIMIT 1",
        [uid, project.id]
      );
      if (open) {
        removeFiles(files);
        return open.status === "validated"
          ? fail(req, res, 409, "Ce projet est déjà validé", "This project is already validated")
          : fail(req, res, 409, "Une soumission est déjà en cours de correction pour ce projet", "A submission is already awaiting review for this project");
      }
      const [{ n }]: any = await query("SELECT COUNT(*) AS n FROM project_submissions WHERE user_id = ? AND project_id = ?", [uid, project.id]);
      const attempt = Math.min(Number(n) + 1, 255);

      const subId = await withTransaction(async (q) => {
        const ins: any = await q(
          `INSERT INTO project_submissions
             (project_id, user_id, course_id, title, status, submission_url, file_url, student_notes, submitted_at, sla_deadline_at, attempt_number)
           VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR), ?)`,
          [project.id, uid, courseId, title, url || null,
           files.length ? `/uploads/submissions/${uid}/${files[0].filename}` : null,
           description || null, Number(project.sla_correction_hours) || 72, attempt]
        );
        const id = Number(ins.insertId);
        for (const f of files) {
          await q(
            `INSERT INTO submission_files (submission_id, filename, original_filename, file_url, file_size, file_type) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, f.filename, Buffer.from(f.originalname, "latin1").toString("utf8").slice(0, 255), `/uploads/submissions/${uid}/${f.filename}`, f.size, f.mimetype]
          );
        }
        return id;
      });

      // Notifications (non bloquantes) : étudiant, admins, instructeur du cours
      void (async () => {
        const [course]: any = await query("SELECT instructor_id, title FROM courses WHERE id = ?", [courseId]);
        const who = `${req.user!.first_name || ""} ${req.user!.last_name || ""}`.trim() || req.user!.email || `#${uid}`;
        const en = (await getUserLang(uid)) === "en";
        await createNotification(uid, {
          type: "info",
          title: en ? "Submission received" : "Soumission envoyée",
          message: en ? `Your work "${title}" was submitted. It will be reviewed soon.` : `Votre travail « ${title} » a été soumis. Il sera corrigé prochainement.`,
          link: `/courses/${courseId}/submissions`,
        });
        await notifyAdmins({ type: "info", title: `Nouvelle soumission : ${title}`, message: `${who} — ${course?.title || `cours #${courseId}`}`, link: "/admin/submissions" }, { email: false });
        if (course?.instructor_id && Number(course.instructor_id) !== uid) {
          await createNotification(Number(course.instructor_id), {
            type: "info", title: `Nouvelle soumission : ${title}`, message: `${who} — ${course.title}`, link: "/instructor/submissions",
          });
        }
      })().catch((e) => console.warn("notif soumission:", e?.message));

      const [row] = toPlain<any[]>(await query(`${SELECT} WHERE ps.id = ?`, [subId]));
      const [data] = await shapeRows(req, [row]);
      return res.status(201).json({ success: true, message: tr(req, "Soumission envoyée avec succès", "Submission sent successfully"), data });
    } catch (e) {
      removeFiles(files);
      return serverError(req, res, "createSubmission", e);
    }
  });
};

// GET /api/submissions/course/:id  → soumissions de l'étudiant connecté pour ce cours
export const mySubmissionsForCourse = async (req: Req, res: Response) => {
  try {
    await ensureSubmissionSchema();
    const courseId = parseId(req.params.id);
    if (!courseId) return fail(req, res, 400, "Cours invalide", "Invalid course");
    const rows = toPlain<any[]>(await query(
      `${SELECT} WHERE ps.user_id = ? AND ps.course_id = ? AND ps.status NOT IN ('not_started') ORDER BY ps.created_at DESC, ps.id DESC`,
      [req.user!.id, courseId]
    ));
    return res.json({ success: true, data: await shapeRows(req, rows) });
  } catch (e) { return serverError(req, res, "mySubmissionsForCourse", e); }
};

// ═══════════ Correction (admin + instructeur du cours) ═══════════
const MINE =
  "(c.instructor_id = ? OR EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ? AND ci.status = 'accepted'))";

// GET /api/admin/submissions  |  GET /api/submissions/review   ?status=&course_id=&search=
export const listForReview = async (req: Req, res: Response) => {
  try {
    await ensureSubmissionSchema();
    const where: string[] = [`ps.status IN (${VISIBLE_STATUSES.map(() => "?").join(",")})`];
    const params: any[] = [...VISIBLE_STATUSES];

    if (!isAdminRole(req.user!.role)) { where.push(MINE); params.push(req.user!.id, req.user!.id); }

    const status = String(req.query.status || "");
    if (status === "pending") { where.push(`ps.status IN (${PENDING_STATUSES.map(() => "?").join(",")})`); params.push(...PENDING_STATUSES); }
    else if (status === "approved") where.push("ps.status = 'validated'");
    else if (status === "rejected") where.push("ps.status = 'rejected'");

    const courseId = parseId(req.query.course_id);
    if (courseId) { where.push("ps.course_id = ?"); params.push(courseId); }

    const search = String(req.query.search || "").trim();
    if (search) {
      const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
      where.push("(p.title LIKE ? OR ps.title LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR c.title LIKE ?)");
      params.push(like, like, like, like, like);
    }

    const rows = toPlain<any[]>(await query(
      `${SELECT} WHERE ${where.join(" AND ")}
        ORDER BY (ps.status IN ('validated','rejected')) ASC, COALESCE(ps.submitted_at, ps.created_at) DESC, ps.id DESC
        LIMIT 500`,
      params
    ));
    return res.json({ success: true, data: await shapeRows(req, rows) });
  } catch (e) { return serverError(req, res, "listForReview", e); }
};

// PATCH /api/admin/submissions/:id/review  |  PATCH /api/submissions/:id/review
//   { status: 'approved'|'rejected', feedback, grade? (/20) | score? (/100) }
export const reviewSubmission = async (req: Req, res: Response) => {
  try {
    await ensureSubmissionSchema();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 400, "Identifiant invalide", "Invalid id");
    const decision = String(req.body?.status ?? "");
    if (!["approved", "rejected"].includes(decision)) {
      return fail(req, res, 400, "Statut invalide (approved ou rejected)", "Invalid status (approved or rejected)");
    }
    const feedback = String(req.body?.feedback ?? "").trim().slice(0, 5000);
    if (decision === "rejected" && !feedback) {
      return fail(req, res, 400, "Un retour est obligatoire pour rejeter une soumission", "Feedback is required to reject a submission");
    }

    let score: number | null = null;
    const rawGrade = req.body?.grade;
    const rawScore = req.body?.score;
    if (rawGrade !== undefined && rawGrade !== null && rawGrade !== "") {
      const g = Number(rawGrade);
      if (!Number.isFinite(g) || g < 0 || g > 20) return fail(req, res, 400, "La note doit être comprise entre 0 et 20", "The grade must be between 0 and 20");
      score = Math.round(g * 5);
    } else if (rawScore !== undefined && rawScore !== null && rawScore !== "") {
      const s = Number(rawScore);
      if (!Number.isFinite(s) || s < 0 || s > 100) return fail(req, res, 400, "Le score doit être compris entre 0 et 100", "The score must be between 0 and 100");
      score = Math.round(s);
    }

    const [sub]: any = await query(
      `SELECT ps.id, ps.user_id, ps.course_id, ps.status, ps.score, p.title AS project_title, ps.title AS own_title
         FROM project_submissions ps JOIN projects p ON p.id = ps.project_id WHERE ps.id = ?`, [id]
    );
    if (!sub) return fail(req, res, 404, "Soumission introuvable", "Submission not found");

    const access = await getCourseAccess(req.user!, Number(sub.course_id));
    if (!access.canView) return fail(req, res, 403, "Vous n'avez pas accès à ce cours", "You do not have access to this course");
    if (!VISIBLE_STATUSES.includes(sub.status)) {
      return fail(req, res, 409, "Cette soumission n'a pas été remise", "This submission has not been handed in");
    }

    const approved = decision === "approved";
    await query(
      `UPDATE project_submissions
          SET status = ?, passed = ?, score = ?, corrector_id = ?, corrector_feedback = ?, reviewed_at = NOW()
        WHERE id = ?`,
      [approved ? "validated" : "rejected", approved ? 1 : 0, score !== null ? score : sub.score, req.user!.id, feedback || null, id]
    );
    await logAudit(req, "course", approved ? "submission.validated" : "submission.rejected", "project_submission", id,
      { status: sub.status }, { status: approved ? "validated" : "rejected", score, user_id: Number(sub.user_id) });

    void (async () => {
      const en = (await getUserLang(Number(sub.user_id))) === "en";
      const name = sub.own_title || sub.project_title;
      await createNotification(Number(sub.user_id), {
        type: approved ? "success" : "warning",
        title: approved
          ? (en ? `Your submission "${name}" was approved` : `Votre soumission « ${name} » a été validée`)
          : (en ? `Feedback on your submission "${name}"` : `Retour sur votre soumission « ${name} »`),
        message: approved
          ? (en ? "Congratulations! Your work has been approved." : "Félicitations ! Votre travail a été approuvé.")
          : (en ? `Your work needs corrections. ${feedback}` : `Votre travail nécessite des corrections. ${feedback}`),
        link: `/courses/${sub.course_id}/submissions`,
      });
    })().catch(() => {});

    const [row] = toPlain<any[]>(await query(`${SELECT} WHERE ps.id = ?`, [id]));
    const [data] = await shapeRows(req, [row]);
    return res.json({ success: true, message: tr(req, "Soumission mise à jour avec succès", "Submission updated successfully"), data });
  } catch (e) { return serverError(req, res, "reviewSubmission", e); }
};
