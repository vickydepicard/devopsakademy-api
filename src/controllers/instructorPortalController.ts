// src/controllers/instructorPortalController.ts
// Espace instructeur : cours, modules, leçons, quiz, étudiants, statistiques, gains, devoirs.
// Toutes les routes passent par un garde qui vérifie que l'utilisateur est bien
// propriétaire / co-instructeur du cours (ou admin) — jamais de simple contrôle de rôle.
import { Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import slugify from "slugify";
import { query, withTransaction } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { tr, getUserLang } from "../utils/lang";
import { toPlain, parseJson, parseId, toStringList } from "../utils/serialize";
import { publicBaseUrl, isSafeMediaUrl } from "../utils/publicUrl";
import {
  getCourseAccess, CourseAccess,
  courseIdOfModule, courseIdOfLesson, courseIdOfQuiz, courseIdOfQuestion,
  courseIdOfResource, courseIdOfSubmission,
} from "../utils/courseAccess";
import { deleteLessonsTx, deleteModulesTx, deleteCourseTx } from "../utils/cascade";
import { createNotification } from "../services/notification.service";

type Req = AuthenticatedRequest;
type Level = "view" | "edit" | "manage";

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v) || 0);
const LEVELS = ["beginner", "intermediate", "advanced"];
const CONTENT_TYPES = ["video", "article", "quiz", "exercise", "download"];
const sqlDate = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

const fail = (req: Req, res: Response, status: number, fr: string, en: string, extra: object = {}) =>
  res.status(status).json({ success: false, message: tr(req, fr, en), ...extra });

const serverError = (req: Req, res: Response, label: string, error: any) => {
  console.error(`${label}:`, error?.message || error);
  return fail(req, res, 500, "Erreur serveur", "Server error");
};

// Cours dont l'instructeur est propriétaire OU co-instructeur accepté.
const MINE =
  "(c.instructor_id = ? OR EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ? AND ci.status = 'accepted'))";

// ═════════════════════════════════════════════════════════════
// GARDES — vérifient l'accès avant tout traitement (et avant multer)
// ═════════════════════════════════════════════════════════════
const makeGuard =
  (resolve: (req: Req) => Promise<number | null>, level: Level) =>
  async (req: Req, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return fail(req, res, 401, "Veuillez vous connecter.", "Please log in.");
      const courseId = await resolve(req);
      if (!courseId) return fail(req, res, 404, "Ressource introuvable", "Resource not found");
      const access = await getCourseAccess(req.user, courseId);
      if (!access.exists) return fail(req, res, 404, "Cours introuvable", "Course not found");
      const allowed = level === "manage" ? access.canManage : level === "edit" ? access.canEdit : access.canView;
      if (!allowed) {
        if (access.canView) {
          return fail(req, res, 403,
            "Vous enseignez ce cours, mais son contenu est géré par l'administration. Contactez-la pour une modification.",
            "You teach this course, but its content is managed by the administration. Contact them to request a change.",
            { code: "READ_ONLY" });
        }
        return fail(req, res, 403, "Vous n'avez pas accès à ce cours.", "You do not have access to this course.");
      }
      (req as any).courseId = courseId;
      (req as any).courseAccess = access as CourseAccess;
      next();
    } catch (error) {
      return serverError(req, res, "guard", error);
    }
  };

export const guardCourse = (level: Level = "edit", param = "id") =>
  makeGuard(async (req) => parseId(req.params[param]), level);
export const guardModule = (level: Level = "edit") =>
  makeGuard(async (req) => { const id = parseId(req.params.moduleId); return id ? courseIdOfModule(id) : null; }, level);
export const guardLesson = (level: Level = "edit") =>
  makeGuard(async (req) => { const id = parseId(req.params.lessonId); return id ? courseIdOfLesson(id) : null; }, level);
export const guardQuiz = (level: Level = "edit") =>
  makeGuard(async (req) => { const id = parseId(req.params.quizId); return id ? courseIdOfQuiz(id) : null; }, level);
export const guardQuestion = (level: Level = "edit") =>
  makeGuard(async (req) => { const id = parseId(req.params.questionId); return id ? courseIdOfQuestion(id) : null; }, level);
export const guardResource = (level: Level = "edit") =>
  makeGuard(async (req) => { const id = parseId(req.params.resourceId); return id ? courseIdOfResource(id) : null; }, level);
export const guardSubmission = (level: Level = "edit") =>
  makeGuard(async (req) => { const id = parseId(req.params.submissionId); return id ? courseIdOfSubmission(id) : null; }, level);

const cid = (req: Req): number => (req as any).courseId;

// Un cours publié est validé par l'administration : seuls les admins suppriment sa structure.
async function structureLocked(req: Req, courseId: number): Promise<boolean> {
  if (((req as any).courseAccess as CourseAccess)?.isAdmin) return false;
  const [c]: any = await query("SELECT is_published FROM courses WHERE id = ?", [courseId]);
  return !!Number(c?.is_published);
}
const lockedMsg = (req: Req, res: Response) =>
  fail(req, res, 403,
    "Ce cours est publié : la suppression de modules, leçons ou quiz doit être demandée à l'administration.",
    "This course is published: removing modules, lessons or quizzes must be requested from the administration.",
    { code: "COURSE_LOCKED" });

// ═════════════════════════════════════════════════════════════
// COURS
// ═════════════════════════════════════════════════════════════
const serializeCourse = (row: any) => {
  const c: any = toPlain(row);
  c.requirements = parseJson(c.requirements, []);
  c.learning_outcomes = parseJson(c.learning_outcomes, []);
  c.what_you_learn = c.learning_outcomes; // alias utilisé par le formulaire
  c.tags = parseJson(c.tags, []);
  return c;
};

interface Validated { fields: Record<string, any>; errors: Record<string, string> }

async function validateCourseBody(req: Req, body: any, partial: boolean): Promise<Validated> {
  const f: Record<string, any> = {};
  const e: Record<string, string> = {};
  const has = (k: string) => body[k] !== undefined;

  if (!partial || has("title")) {
    const v = String(body.title ?? "").trim();
    if (v.length < 3 || v.length > 255) e.title = tr(req, "Le titre doit contenir entre 3 et 255 caractères", "The title must be between 3 and 255 characters");
    else f.title = v;
  }
  if (has("short_description")) {
    const v = String(body.short_description ?? "").trim();
    if (v.length > 500) e.short_description = tr(req, "500 caractères maximum", "500 characters maximum");
    else f.short_description = v || null;
  }
  if (has("description")) {
    const v = String(body.description ?? "").trim();
    if (v.length > 20000) e.description = tr(req, "Description trop longue", "Description is too long");
    else f.description = v || null;
  }
  if (has("category_id")) {
    const id = body.category_id === "" || body.category_id === null ? null : parseId(body.category_id);
    if (body.category_id && !id) e.category_id = tr(req, "Catégorie invalide", "Invalid category");
    else if (id) {
      const [cat]: any = await query("SELECT id FROM course_categories WHERE id = ?", [id]);
      if (!cat) e.category_id = tr(req, "Catégorie introuvable", "Category not found");
      else f.category_id = id;
    } else f.category_id = null;
  }
  if (has("level")) {
    if (!LEVELS.includes(body.level)) e.level = tr(req, "Niveau invalide", "Invalid level");
    else f.level = body.level;
  }
  if (has("language")) {
    const v = String(body.language ?? "").trim().toLowerCase();
    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(v)) e.language = tr(req, "Langue invalide", "Invalid language");
    else f.language = v;
  }
  const isFree = has("is_free") ? !!body.is_free : undefined;
  if (isFree !== undefined) f.is_free = isFree ? 1 : 0;
  if (isFree === true) f.price = 0;
  else if (has("price")) {
    const p = Number(body.price);
    if (!Number.isFinite(p) || p < 0 || p > 99999999) e.price = tr(req, "Prix invalide", "Invalid price");
    else f.price = Math.round(p * 100) / 100;
  }
  if (has("original_price")) {
    if (body.original_price === null || body.original_price === "") f.original_price = null;
    else {
      const p = Number(body.original_price);
      if (!Number.isFinite(p) || p < 0 || p > 99999999) e.original_price = tr(req, "Prix invalide", "Invalid price");
      else f.original_price = Math.round(p * 100) / 100;
    }
  }
  if (has("duration_hours")) {
    if (body.duration_hours === null || body.duration_hours === "") f.duration_hours = null;
    else {
      const d = Number(body.duration_hours);
      if (!Number.isFinite(d) || d < 0 || d > 10000) e.duration_hours = tr(req, "Durée invalide", "Invalid duration");
      else f.duration_hours = Math.round(d);
    }
  }
  for (const k of ["thumbnail_url", "video_preview_url"]) {
    if (has(k)) {
      const v = String(body[k] ?? "").trim();
      if (!v) f[k] = null;
      else if (v.length > 500 || !isSafeMediaUrl(v)) e[k] = tr(req, "URL invalide", "Invalid URL");
      else f[k] = v;
    }
  }
  if (has("requirements")) f.requirements = JSON.stringify(toStringList(body.requirements));
  if (has("learning_outcomes") || has("what_you_learn")) {
    f.learning_outcomes = JSON.stringify(toStringList(body.learning_outcomes ?? body.what_you_learn));
  }
  if (has("tags")) f.tags = JSON.stringify(toStringList(body.tags, 15, 40));
  return { fields: f, errors: e };
}

async function uniqueCourseSlug(title: string): Promise<string> {
  const base = slugify(title, { lower: true, strict: true }).slice(0, 200) || "course";
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [row]: any = await query("SELECT id FROM courses WHERE slug = ?", [candidate]);
    if (!row) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// GET /api/instructor/courses
export const listCourses = async (req: Req, res: Response) => {
  try {
    const uid = req.user!.id;
    const rows: any[] = await query(
      `SELECT c.id, c.title, c.slug, c.short_description, c.thumbnail_url, c.price, c.original_price, c.is_free,
              c.level, c.language, c.is_published, c.review_status, c.review_note, c.submitted_at, c.is_featured, c.rating, c.review_count, c.duration_hours,
              c.created_at, c.updated_at, c.published_at, cat.name AS category_name,
              (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.is_approved = 1) AS student_count,
              (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.is_approved = 1 AND ce.completion_percentage >= 100) AS completion_count,
              (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.id) AS module_count,
              (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = c.id) AS lesson_count,
              CASE WHEN c.instructor_id = ? THEN 'owner' ELSE 'co_instructor' END AS my_role,
              (c.instructor_id = ?) AS is_author
         FROM courses c
         LEFT JOIN course_categories cat ON cat.id = c.category_id
        WHERE ${MINE}
        ORDER BY c.updated_at DESC`,
      [uid, uid, uid, uid]
    );
    const data = toPlain<any[]>(rows).map((c) => ({ ...c, is_author: !!Number(c.is_author), enrolled_count: c.student_count, avg_rating: c.rating }));
    return res.json({ success: true, data });
  } catch (error) {
    return serverError(req, res, "listCourses", error);
  }
};

// GET /api/instructor/courses/:id
export const getCourse = async (req: Req, res: Response) => {
  try {
    const [row]: any = await query(
      `SELECT c.*, cat.name AS category_name,
              (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.id) AS module_count,
              (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = c.id) AS lesson_count
         FROM courses c LEFT JOIN course_categories cat ON cat.id = c.category_id
        WHERE c.id = ?`,
      [cid(req)]
    );
    const access: CourseAccess = (req as any).courseAccess;
    return res.json({
      success: true,
      data: { ...serializeCourse(row), my_role: access.isOwner ? "owner" : access.isAdmin ? "admin" : "co_instructor", can_manage: access.canManage, can_edit: access.canEdit },
    });
  } catch (error) {
    return serverError(req, res, "getCourse", error);
  }
};

// POST /api/instructor/courses
export const createCourse = async (req: Req, res: Response) => {
  try {
    const { fields, errors } = await validateCourseBody(req, req.body || {}, false);
    if (Object.keys(errors).length) {
      return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    }
    const slug = await uniqueCourseSlug(fields.title);
    const data: Record<string, any> = {
      level: "beginner", language: "fr", price: 0, is_free: 0,
      requirements: "[]", learning_outcomes: "[]",
      ...fields, instructor_id: req.user!.id, slug, is_published: 0,
    };
    const cols = Object.keys(data);
    const result: any = await query(
      `INSERT INTO courses (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((k) => data[k])
    );
    return res.status(201).json({
      success: true,
      message: tr(req, "Cours créé avec succès", "Course created successfully"),
      data: { id: Number(result.insertId), slug },
    });
  } catch (error) {
    return serverError(req, res, "createCourse", error);
  }
};

// PATCH /api/instructor/courses/:id   (mise à jour PARTIELLE)
export const updateCourse = async (req: Req, res: Response) => {
  try {
    const courseId = cid(req);
    const access: CourseAccess = (req as any).courseAccess;
    const body = req.body || {};
    const { fields, errors } = await validateCourseBody(req, body, true);
    if (Object.keys(errors).length) {
      return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    }

    const [cur]: any = await query("SELECT title, description, is_published, price, original_price, is_free FROM courses WHERE id = ?", [courseId]);

    if (body.is_published !== undefined || body.review_status !== undefined) {
      // La publication appartient à l'administration : l'instructeur soumet, l'admin valide.
      if (!access.isAdmin) {
        if (body.is_published !== undefined && !!body.is_published !== !!Number(cur?.is_published)) {
          return fail(req, res, 403,
            "La publication est validée par l'administration. Utilisez « Soumettre pour validation ».",
            "Publication is approved by the administration. Use “Submit for review”.",
            { code: "USE_SUBMIT" });
        }
      } else if (body.is_published !== undefined) {
        const wantPublished = !!body.is_published;
        if (wantPublished) {
          const missing = await courseMissing(courseId, fields.title ?? cur?.title, fields.description ?? cur?.description);
          if (missing.length) {
            return fail(req, res, 422,
              "Le cours est incomplet : ajoutez une description et au moins une leçon publiée avant de le publier.",
              "The course is incomplete: add a description and at least one published lesson before publishing.",
              { code: "COURSE_INCOMPLETE", missing });
          }
          fields.is_published = 1;
          fields.published_at = sqlDate(new Date());
          fields.review_status = "approved";
          fields.reviewed_by = req.user!.id;
          fields.reviewed_at = sqlDate(new Date());
        } else {
          fields.is_published = 0;
        }
      }
    }

    // Cours publié : le prix ne se change pas sans l'administration.
    if (!access.isAdmin && Number(cur?.is_published) === 1) {
      const changed =
        (fields.price !== undefined && Number(fields.price) !== Number(cur.price)) ||
        (fields.original_price !== undefined && Number(fields.original_price ?? 0) !== Number(cur.original_price ?? 0)) ||
        (fields.is_free !== undefined && Number(fields.is_free) !== Number(cur.is_free));
      if (changed) {
        return fail(req, res, 403,
          "Ce cours est publié : le prix est fixé par l'administration. Demandez-lui de le modifier.",
          "This course is published: the price is set by the administration. Ask them to change it.",
          { code: "COURSE_LOCKED" });
      }
      delete fields.price; delete fields.original_price; delete fields.is_free;
    }

    const cols = Object.keys(fields);
    if (!cols.length) return fail(req, res, 400, "Aucune modification fournie", "No changes provided");

    // published_at : on conserve la toute première date de publication
    const setSql = cols.map((k) => (k === "published_at" ? "published_at = COALESCE(published_at, ?)" : `${k} = ?`)).join(", ");
    await query(`UPDATE courses SET ${setSql}, updated_at = NOW() WHERE id = ?`, [...cols.map((k) => fields[k]), courseId]);

    const [row]: any = await query("SELECT * FROM courses WHERE id = ?", [courseId]);
    return res.json({ success: true, message: tr(req, "Cours mis à jour", "Course updated"), data: serializeCourse(row) });
  } catch (error) {
    return serverError(req, res, "updateCourse", error);
  }
};

// Éléments manquants avant publication / soumission
async function courseMissing(courseId: number, title: any, description: any): Promise<string[]> {
  const [lessons]: any = await query(
    `SELECT COUNT(*) AS n FROM lessons l JOIN modules m ON m.id = l.module_id
      WHERE m.course_id = ? AND m.is_published = 1 AND l.is_published = 1`,
    [courseId]
  );
  const missing: string[] = [];
  if (!String(title ?? "").trim()) missing.push("title");
  if (!String(description ?? "").trim()) missing.push("description");
  if (num(lessons?.n) < 1) missing.push("lessons");
  return missing;
}

// POST /api/instructor/courses/:id/submit — l'auteur soumet son cours à la validation de l'administration
export const submitCourse = async (req: Req, res: Response) => {
  try {
    const courseId = cid(req);
    const [c]: any = await query("SELECT title, description, is_published, review_status, instructor_id FROM courses WHERE id = ?", [courseId]);
    if (Number(c.is_published) === 1) return fail(req, res, 409, "Ce cours est déjà publié.", "This course is already published.", { code: "ALREADY_PUBLISHED" });
    if (c.review_status === "submitted") return fail(req, res, 409, "Ce cours est déjà en cours de validation.", "This course is already under review.", { code: "ALREADY_SUBMITTED" });
    const missing = await courseMissing(courseId, c.title, c.description);
    if (missing.length) {
      return fail(req, res, 422,
        "Le cours est incomplet : ajoutez une description et au moins une leçon avant de le soumettre.",
        "The course is incomplete: add a description and at least one lesson before submitting.",
        { code: "COURSE_INCOMPLETE", missing });
    }
    // Part des revenus souhaitée par l'instructeur : simple proposition, l'administration décide.
    let proposed: number | null = null;
    if (req.body?.proposed_rate !== undefined && req.body.proposed_rate !== null && req.body.proposed_rate !== "") {
      const n = Number(String(req.body.proposed_rate).replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return fail(req, res, 400, "La part proposée doit être comprise entre 0 et 100.", "The proposed share must be between 0 and 100.", { code: "INVALID_RATE" });
      }
      proposed = Math.round(n * 100) / 100;
    }
    await query("UPDATE courses SET review_status = 'submitted', submitted_at = NOW(), review_note = NULL, proposed_commission_rate = ?, updated_at = NOW() WHERE id = ?", [proposed, courseId]);

    // Prévenir les administrateurs (non bloquant)
    void (async () => {
      const admins: any[] = await query("SELECT id FROM users WHERE role IN ('admin','superadmin') AND is_active = 1");
      for (const a of admins) {
        const lang = await getUserLang(Number(a.id));
        const en = lang === "en";
        await createNotification(Number(a.id), {
          type: "info",
          title: en ? "Course submitted for review" : "Cours soumis à validation",
          message: en ? `“${c.title}” is waiting for your review.` : `« ${c.title} » attend votre validation.`,
          link: "/admin/course-reviews",
        });
      }
    })().catch(() => {});

    return res.json({ success: true, message: tr(req, "Cours soumis à l'administration pour validation.", "Course submitted to the administration for review."), data: { review_status: "submitted" } });
  } catch (error) {
    return serverError(req, res, "submitCourse", error);
  }
};

// POST /api/instructor/courses/:id/withdraw — retirer la soumission pour continuer à modifier
export const withdrawCourse = async (req: Req, res: Response) => {
  try {
    const courseId = cid(req);
    const result: any = await query("UPDATE courses SET review_status = 'draft', submitted_at = NULL, updated_at = NOW() WHERE id = ? AND review_status = 'submitted' AND is_published = 0", [courseId]);
    if (!Number(result?.affectedRows)) return fail(req, res, 409, "Ce cours n'est pas en attente de validation.", "This course is not awaiting review.");
    return res.json({ success: true, message: tr(req, "Soumission retirée.", "Submission withdrawn."), data: { review_status: "draft" } });
  } catch (error) {
    return serverError(req, res, "withdrawCourse", error);
  }
};

// DELETE /api/instructor/courses/:id
export const deleteCourse = async (req: Req, res: Response) => {
  try {
    const courseId = cid(req);
    const [enr]: any = await query("SELECT COUNT(*) AS n FROM course_enrollments WHERE course_id = ?", [courseId]);
    if (num(enr?.n) > 0) {
      return fail(req, res, 409,
        "Ce cours a des étudiants inscrits : il ne peut pas être supprimé. Dépubliez-le à la place.",
        "This course has enrolled students and cannot be deleted. Unpublish it instead.",
        { code: "HAS_ENROLLMENTS" });
    }
    const [com]: any = await query("SELECT COUNT(*) AS n FROM instructor_commissions WHERE course_id = ?", [courseId]);
    if (num(com?.n) > 0) {
      return fail(req, res, 409, "Ce cours a un historique de gains et ne peut pas être supprimé.", "This course has earnings history and cannot be deleted.", { code: "HAS_COMMISSIONS" });
    }
    await withTransaction((q) => deleteCourseTx(q, courseId));
    return res.json({ success: true, message: tr(req, "Cours supprimé avec succès", "Course deleted successfully") });
  } catch (error) {
    return serverError(req, res, "deleteCourse", error);
  }
};

// POST /api/instructor/courses/:id/thumbnail   (après multer)
export const saveCourseThumbnail = async (req: Req, res: Response) => {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return fail(req, res, 400, "Aucune image reçue", "No image received");
    const url = `${publicBaseUrl(req)}/uploads/courses/thumbnails/${file.filename}`;
    await query("UPDATE courses SET thumbnail_url = ?, updated_at = NOW() WHERE id = ?", [url, cid(req)]);
    return res.json({ success: true, message: tr(req, "Miniature mise à jour", "Thumbnail updated"), data: { file_url: url } });
  } catch (error) {
    return serverError(req, res, "saveCourseThumbnail", error);
  }
};

// ═════════════════════════════════════════════════════════════
// MODULES
// ═════════════════════════════════════════════════════════════
const nextOrder = async (table: "modules" | "lessons", col: "course_id" | "module_id", id: number): Promise<number> => {
  const [r]: any = await query(`SELECT COALESCE(MAX(order_index), 0) + 1 AS n FROM ${table} WHERE ${col} = ?`, [id]);
  return num(r?.n) || 1;
};

// GET /api/instructor/courses/:id/modules  (brouillons inclus)
export const listModules = async (req: Req, res: Response) => {
  try {
    const courseId = cid(req);
    const modules: any[] = toPlain(await query(
      "SELECT id, course_id, title, description, order_index, is_published FROM modules WHERE course_id = ? ORDER BY order_index ASC",
      [courseId]
    ));
    const lessons: any[] = toPlain(await query(
      `SELECT l.id, l.module_id, l.title, l.slug, l.content_type, l.content_type AS type, l.content_url, l.article_content,
              l.duration_minutes, l.order_index, l.is_published, l.is_preview, l.requires_completion, l.is_downloadable,
              (SELECT COUNT(*) FROM lesson_resources lr WHERE lr.lesson_id = l.id) AS resource_count,
              EXISTS(SELECT 1 FROM quizzes q WHERE q.lesson_id = l.id) AS has_quiz
         FROM lessons l JOIN modules m ON m.id = l.module_id
        WHERE m.course_id = ? ORDER BY l.order_index ASC`,
      [courseId]
    ));
    const byModule = new Map<number, any[]>();
    for (const l of lessons) {
      l.has_quiz = !!Number(l.has_quiz);
      (byModule.get(l.module_id) || byModule.set(l.module_id, []).get(l.module_id)!).push(l);
    }
    return res.json({ success: true, data: modules.map((m) => ({ ...m, lessons: byModule.get(m.id) || [] })) });
  } catch (error) {
    return serverError(req, res, "listModules", error);
  }
};

// POST /api/instructor/courses/:id/modules
export const createModule = async (req: Req, res: Response) => {
  try {
    const title = String(req.body?.title ?? "").trim();
    const description = String(req.body?.description ?? "").trim();
    if (title.length < 2 || title.length > 255) {
      return fail(req, res, 400, "Le titre du module doit contenir entre 2 et 255 caractères", "The module title must be between 2 and 255 characters", { errors: { title: "invalid" } });
    }
    if (description.length > 2000) return fail(req, res, 400, "Description trop longue", "Description is too long");
    const order = await nextOrder("modules", "course_id", cid(req));
    const result: any = await query(
      "INSERT INTO modules (course_id, title, description, order_index, is_published) VALUES (?, ?, ?, ?, ?)",
      [cid(req), title, description || null, order, req.body?.is_published === false ? 0 : 1]
    );
    return res.status(201).json({ success: true, message: tr(req, "Module créé", "Module created"), data: { id: Number(result.insertId), order_index: order } });
  } catch (error) {
    return serverError(req, res, "createModule", error);
  }
};

// PATCH /api/instructor/modules/:moduleId
export const updateModule = async (req: Req, res: Response) => {
  try {
    const sets: string[] = [];
    const params: any[] = [];
    const b = req.body || {};
    if (b.title !== undefined) {
      const t = String(b.title).trim();
      if (t.length < 2 || t.length > 255) return fail(req, res, 400, "Titre invalide", "Invalid title");
      sets.push("title = ?"); params.push(t);
    }
    if (b.description !== undefined) {
      const d = String(b.description ?? "").trim();
      if (d.length > 2000) return fail(req, res, 400, "Description trop longue", "Description is too long");
      sets.push("description = ?"); params.push(d || null);
    }
    if (b.is_published !== undefined) { sets.push("is_published = ?"); params.push(b.is_published ? 1 : 0); }
    if (!sets.length) return fail(req, res, 400, "Aucune modification fournie", "No changes provided");
    await query(`UPDATE modules SET ${sets.join(", ")}, updated_at = NOW() WHERE id = ?`, [...params, parseId(req.params.moduleId)]);
    return res.json({ success: true, message: tr(req, "Module mis à jour", "Module updated") });
  } catch (error) {
    return serverError(req, res, "updateModule", error);
  }
};

// DELETE /api/instructor/modules/:moduleId
export const deleteModule = async (req: Req, res: Response) => {
  try {
    if (await structureLocked(req, cid(req))) return lockedMsg(req, res);
    const moduleId = parseId(req.params.moduleId)!;
    const [prog]: any = await query(
      `SELECT COUNT(*) AS n FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id WHERE l.module_id = ?`,
      [moduleId]
    );
    if (num(prog?.n) > 0 && String(req.query.force) !== "1") {
      return fail(req, res, 409,
        "Des étudiants ont déjà suivi des leçons de ce module. Confirmez pour supprimer aussi leur progression.",
        "Students have already completed lessons in this module. Confirm to delete their progress as well.",
        { code: "HAS_PROGRESS" });
    }
    await withTransaction((q) => deleteModulesTx(q, [moduleId]));
    return res.json({ success: true, message: tr(req, "Module supprimé", "Module deleted") });
  } catch (error) {
    return serverError(req, res, "deleteModule", error);
  }
};

// Échange l'ordre avec le voisin (la base impose l'unicité de order_index).
async function moveRow(table: "modules" | "lessons", scopeCol: "course_id" | "module_id", id: number, dir: string) {
  return withTransaction(async (q) => {
    const [cur]: any = await q(`SELECT id, ${scopeCol} AS scope, order_index FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
    if (!cur) return false;
    const [nb]: any = await q(
      dir === "up"
        ? `SELECT id, order_index FROM ${table} WHERE ${scopeCol} = ? AND order_index < ? ORDER BY order_index DESC LIMIT 1`
        : `SELECT id, order_index FROM ${table} WHERE ${scopeCol} = ? AND order_index > ? ORDER BY order_index ASC LIMIT 1`,
      [cur.scope, cur.order_index]
    );
    if (!nb) return true;
    await q(`UPDATE ${table} SET order_index = -1 WHERE id = ?`, [cur.id]);
    await q(`UPDATE ${table} SET order_index = ? WHERE id = ?`, [cur.order_index, nb.id]);
    await q(`UPDATE ${table} SET order_index = ? WHERE id = ?`, [nb.order_index, cur.id]);
    return true;
  });
}

// POST /api/instructor/modules/:moduleId/move   { direction: "up" | "down" }
export const moveModule = async (req: Req, res: Response) => {
  try {
    const dir = req.body?.direction;
    if (dir !== "up" && dir !== "down") return fail(req, res, 400, "Direction invalide", "Invalid direction");
    await moveRow("modules", "course_id", parseId(req.params.moduleId)!, dir);
    return res.json({ success: true });
  } catch (error) {
    return serverError(req, res, "moveModule", error);
  }
};

// ═════════════════════════════════════════════════════════════
// LEÇONS
// ═════════════════════════════════════════════════════════════
function validateLessonBody(req: Req, body: any, partial: boolean): Validated {
  const f: Record<string, any> = {};
  const e: Record<string, string> = {};
  const has = (k: string) => body[k] !== undefined;

  if (!partial || has("title")) {
    const t = String(body.title ?? "").trim();
    if (t.length < 2 || t.length > 255) e.title = tr(req, "Le titre doit contenir entre 2 et 255 caractères", "The title must be between 2 and 255 characters");
    else f.title = t;
  }
  const type = body.content_type ?? body.type;
  if (type !== undefined) {
    if (!CONTENT_TYPES.includes(type)) e.content_type = tr(req, "Type de leçon invalide", "Invalid lesson type");
    else f.content_type = type;
  }
  if (has("content_url")) {
    const v = String(body.content_url ?? "").trim();
    if (!v) f.content_url = null;
    else if (v.length > 500 || !isSafeMediaUrl(v)) e.content_url = tr(req, "URL invalide", "Invalid URL");
    else f.content_url = v;
  }
  if (has("article_content")) f.article_content = String(body.article_content ?? "") || null;
  if (has("duration_minutes")) {
    const d = body.duration_minutes === "" || body.duration_minutes === null ? 0 : Number(body.duration_minutes);
    if (!Number.isFinite(d) || d < 0 || d > 10000) e.duration_minutes = tr(req, "Durée invalide", "Invalid duration");
    else f.duration_minutes = Math.round(d);
  }
  for (const k of ["is_published", "is_preview", "requires_completion", "is_downloadable"]) {
    if (has(k)) f[k] = body[k] ? 1 : 0;
  }
  return { fields: f, errors: e };
}

// POST /api/instructor/modules/:moduleId/lessons
export const createLesson = async (req: Req, res: Response) => {
  try {
    const moduleId = parseId(req.params.moduleId)!;
    const { fields, errors } = validateLessonBody(req, req.body || {}, false);
    if (Object.keys(errors).length) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    const order = await nextOrder("lessons", "module_id", moduleId);
    const slug = `${slugify(fields.title, { lower: true, strict: true }).slice(0, 80) || "lesson"}-${order}-${Date.now().toString(36)}`;
    const data: Record<string, any> = {
      content_type: "video", duration_minutes: 0, is_published: 1, is_preview: 0, requires_completion: 1, is_downloadable: 0,
      ...fields, module_id: moduleId, slug, order_index: order,
    };
    const cols = Object.keys(data);
    const result: any = await query(
      `INSERT INTO lessons (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((k) => data[k])
    );
    return res.status(201).json({ success: true, message: tr(req, "Leçon créée", "Lesson created"), data: { id: Number(result.insertId), order_index: order } });
  } catch (error) {
    return serverError(req, res, "createLesson", error);
  }
};

// PATCH /api/instructor/lessons/:lessonId
export const updateLesson = async (req: Req, res: Response) => {
  try {
    const { fields, errors } = validateLessonBody(req, req.body || {}, true);
    if (Object.keys(errors).length) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    const cols = Object.keys(fields);
    if (!cols.length) return fail(req, res, 400, "Aucune modification fournie", "No changes provided");
    await query(`UPDATE lessons SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = NOW() WHERE id = ?`, [...cols.map((k) => fields[k]), parseId(req.params.lessonId)]);
    return res.json({ success: true, message: tr(req, "Leçon mise à jour", "Lesson updated") });
  } catch (error) {
    return serverError(req, res, "updateLesson", error);
  }
};

// DELETE /api/instructor/lessons/:lessonId
export const deleteLesson = async (req: Req, res: Response) => {
  try {
    if (await structureLocked(req, cid(req))) return lockedMsg(req, res);
    await withTransaction((q) => deleteLessonsTx(q, [parseId(req.params.lessonId)!]));
    return res.json({ success: true, message: tr(req, "Leçon supprimée", "Lesson deleted") });
  } catch (error) {
    return serverError(req, res, "deleteLesson", error);
  }
};

// POST /api/instructor/lessons/:lessonId/move
export const moveLesson = async (req: Req, res: Response) => {
  try {
    const dir = req.body?.direction;
    if (dir !== "up" && dir !== "down") return fail(req, res, 400, "Direction invalide", "Invalid direction");
    await moveRow("lessons", "module_id", parseId(req.params.lessonId)!, dir);
    return res.json({ success: true });
  } catch (error) {
    return serverError(req, res, "moveLesson", error);
  }
};

// POST /api/instructor/lessons/:lessonId/upload-video   (après garde + multer)
export const saveLessonVideo = async (req: Req, res: Response) => {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return fail(req, res, 400, "Aucun fichier reçu", "No file received");
    const url = `${publicBaseUrl(req)}/uploads/lessons/videos/${file.filename}`;
    await query("UPDATE lessons SET content_url = ?, content_type = 'video', updated_at = NOW() WHERE id = ?", [url, parseId(req.params.lessonId)]);
    return res.json({ success: true, message: tr(req, "Vidéo envoyée et associée à la leçon", "Video uploaded and linked to the lesson"), data: { file_url: url, size_bytes: file.size } });
  } catch (error) {
    return serverError(req, res, "saveLessonVideo", error);
  }
};

// POST /api/instructor/lessons/:lessonId/upload-resource
export const saveLessonResource = async (req: Req, res: Response) => {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return fail(req, res, 400, "Aucun fichier reçu", "No file received");
    const url = `${publicBaseUrl(req)}/uploads/lessons/resources/${file.filename}`;
    const title = String(req.body?.title || file.originalname).slice(0, 255);
    const type = path.extname(file.originalname).slice(1).toLowerCase().slice(0, 50);
    const lessonId = parseId(req.params.lessonId)!;
    const order = await nextOrderResource(lessonId);
    const result: any = await query(
      "INSERT INTO lesson_resources (lesson_id, title, file_url, file_type, file_size, order_index) VALUES (?, ?, ?, ?, ?, ?)",
      [lessonId, title, url, type, file.size, order]
    );
    return res.status(201).json({ success: true, message: tr(req, "Ressource ajoutée", "Resource added"), data: { id: Number(result.insertId), file_url: url, file_type: type } });
  } catch (error) {
    return serverError(req, res, "saveLessonResource", error);
  }
};
const nextOrderResource = async (lessonId: number) => {
  const [r]: any = await query("SELECT COALESCE(MAX(order_index), 0) + 1 AS n FROM lesson_resources WHERE lesson_id = ?", [lessonId]);
  return num(r?.n) || 1;
};

// GET /api/instructor/lessons/:lessonId/resources
export const listLessonResources = async (req: Req, res: Response) => {
  try {
    const rows = await query(
      "SELECT id, lesson_id, title, file_url, file_type, file_size, download_count, order_index FROM lesson_resources WHERE lesson_id = ? ORDER BY order_index ASC",
      [parseId(req.params.lessonId)]
    );
    return res.json({ success: true, data: toPlain(rows) });
  } catch (error) {
    return serverError(req, res, "listLessonResources", error);
  }
};

// DELETE /api/instructor/lesson-resources/:resourceId
export const deleteLessonResource = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.resourceId)!;
    const [row]: any = await query("SELECT file_url FROM lesson_resources WHERE id = ?", [id]);
    await query("DELETE FROM lesson_resources WHERE id = ?", [id]);
    removeLocalUpload(row?.file_url);
    return res.json({ success: true, message: tr(req, "Ressource supprimée", "Resource deleted") });
  } catch (error) {
    return serverError(req, res, "deleteLessonResource", error);
  }
};

// Supprime le fichier physique uniquement s'il se trouve bien dans /uploads.
function removeLocalUpload(fileUrl?: string) {
  try {
    if (!fileUrl) return;
    const pathname = fileUrl.startsWith("/") ? fileUrl : new URL(fileUrl).pathname;
    if (!pathname.startsWith("/uploads/")) return;
    const root = path.resolve(process.cwd(), "uploads");
    const target = path.resolve(process.cwd(), "." + pathname);
    if (target.startsWith(root + path.sep) && fs.existsSync(target)) fs.unlinkSync(target);
  } catch { /* le fichier orphelin n'est pas critique */ }
}

// ═════════════════════════════════════════════════════════════
// QUIZ  (un quiz = une leçon ; tables quizzes / quiz_questions)
// ═════════════════════════════════════════════════════════════
const Q_DB_TYPE: Record<string, string> = { single: "multiple_choice", multiple: "multiple_select" };

const questionToClient = (q: any) => {
  const options: any[] = parseJson(q.options, []);
  const correctRaw = parseJson(q.correct_answer, null);
  const correct = (Array.isArray(correctRaw) ? correctRaw : [correctRaw]).map((x) => String(x));
  return {
    id: Number(q.id),
    quiz_id: Number(q.quiz_id),
    question_text: q.question,
    type: q.question_type === "multiple_select" ? "multiple" : "single",
    points: Number(q.points) || 1,
    explanation: q.explanation || "",
    order_index: Number(q.order_index),
    options: options.map((o) => ({ id: o.id, option_text: o.text, is_correct: correct.includes(String(o.id)) })),
  };
};

const quizToClient = (q: any, questions: any[]) => ({
  id: Number(q.id),
  lesson_id: Number(q.lesson_id),
  lesson_title: q.lesson_title,
  module_title: q.module_title,
  title: q.title,
  description: q.description || "",
  time_limit_minutes: Number(q.time_limit_minutes) || null,
  passing_score: Number(q.pass_score),
  attempts_allowed: Number(q.max_attempts),
  show_correct_answers: !!Number(q.show_correct_answers),
  randomize_questions: !!Number(q.randomize_questions),
  is_published: !!Number(q.is_published),
  questions,
  question_count: questions.length,
});

// GET /api/instructor/courses/:id/quizzes
export const listQuizzes = async (req: Req, res: Response) => {
  try {
    const courseId = cid(req);
    const quizzes: any[] = toPlain(await query(
      `SELECT q.*, l.title AS lesson_title, l.is_published, m.title AS module_title
         FROM quizzes q JOIN lessons l ON l.id = q.lesson_id JOIN modules m ON m.id = l.module_id
        WHERE m.course_id = ? ORDER BY m.order_index, l.order_index`,
      [courseId]
    ));
    const ids = quizzes.map((q) => q.id);
    const questions: any[] = ids.length
      ? toPlain(await query(`SELECT * FROM quiz_questions WHERE quiz_id IN (${ids.map(() => "?").join(",")}) ORDER BY order_index ASC`, ids))
      : [];
    const free: any[] = toPlain(await query(
      `SELECT l.id, l.title, m.title AS module_title FROM lessons l JOIN modules m ON m.id = l.module_id
        WHERE m.course_id = ? AND NOT EXISTS (SELECT 1 FROM quizzes q WHERE q.lesson_id = l.id)
        ORDER BY m.order_index, l.order_index`,
      [courseId]
    ));
    return res.json({
      success: true,
      data: quizzes.map((q) => quizToClient(q, questions.filter((x) => x.quiz_id === q.id).map(questionToClient))),
      lessons: free,
    });
  } catch (error) {
    return serverError(req, res, "listQuizzes", error);
  }
};

function validateQuizBody(req: Req, b: any, partial: boolean): Validated {
  const f: Record<string, any> = {};
  const e: Record<string, string> = {};
  const has = (k: string) => b[k] !== undefined;
  if (!partial || has("title")) {
    const t = String(b.title ?? "").trim();
    if (t.length < 2 || t.length > 255) e.title = tr(req, "Le titre doit contenir entre 2 et 255 caractères", "The title must be between 2 and 255 characters");
    else f.title = t;
  }
  if (has("description")) f.description = String(b.description ?? "").trim().slice(0, 2000) || null;
  if (has("time_limit_minutes")) {
    const v = b.time_limit_minutes === "" || b.time_limit_minutes === null ? 0 : Number(b.time_limit_minutes);
    if (!Number.isInteger(v) || v < 0 || v > 600) e.time_limit_minutes = tr(req, "Durée invalide (0 à 600 min)", "Invalid duration (0 to 600 min)");
    else f.time_limit_minutes = v;
  }
  if (has("passing_score")) {
    const v = Number(b.passing_score);
    if (!Number.isInteger(v) || v < 0 || v > 100) e.passing_score = tr(req, "Le score doit être entre 0 et 100", "The score must be between 0 and 100");
    else f.pass_score = v;
  }
  if (has("attempts_allowed")) {
    const v = Number(b.attempts_allowed);
    if (!Number.isInteger(v) || v < 0 || v > 100) e.attempts_allowed = tr(req, "Nombre de tentatives invalide", "Invalid number of attempts");
    else f.max_attempts = v;
  }
  if (has("show_correct_answers")) f.show_correct_answers = b.show_correct_answers ? 1 : 0;
  if (has("randomize_questions")) f.randomize_questions = b.randomize_questions ? 1 : 0;
  return { fields: f, errors: e };
}

// POST /api/instructor/courses/:id/quizzes
export const createQuiz = async (req: Req, res: Response) => {
  try {
    const courseId = cid(req);
    const body = req.body || {};
    const { fields, errors } = validateQuizBody(req, body, false);
    if (Object.keys(errors).length) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    const published = body.is_published ? 1 : 0;

    const quizId = await withTransaction(async (q) => {
      let lessonId = parseId(body.lesson_id);
      if (lessonId) {
        const [l]: any = await q(
          "SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = ? AND m.course_id = ?",
          [lessonId, courseId]
        );
        if (!l) throw Object.assign(new Error("lesson"), { http: 404 });
        const [dup]: any = await q("SELECT id FROM quizzes WHERE lesson_id = ?", [lessonId]);
        if (dup) throw Object.assign(new Error("dup"), { http: 409 });
        await q("UPDATE lessons SET is_published = ? WHERE id = ?", [published, lessonId]);
      } else {
        // Aucune leçon choisie : on crée une leçon « quiz » à la fin du dernier module.
        let [mod]: any = await q("SELECT id FROM modules WHERE course_id = ? ORDER BY order_index DESC LIMIT 1", [courseId]);
        if (!mod) {
          const ins: any = await q(
            "INSERT INTO modules (course_id, title, order_index, is_published) VALUES (?, ?, 1, 1)",
            [courseId, tr(req, "Évaluations", "Assessments")]
          );
          mod = { id: Number(ins.insertId) };
        }
        const [o]: any = await q("SELECT COALESCE(MAX(order_index), 0) + 1 AS n FROM lessons WHERE module_id = ?", [mod.id]);
        const order = num(o?.n) || 1;
        const slug = `${slugify(fields.title, { lower: true, strict: true }).slice(0, 80) || "quiz"}-${order}-${Date.now().toString(36)}`;
        const li: any = await q(
          `INSERT INTO lessons (module_id, title, slug, content_type, duration_minutes, order_index, is_published)
           VALUES (?, ?, ?, 'quiz', ?, ?, ?)`,
          [mod.id, fields.title, slug, fields.time_limit_minutes || 10, order, published]
        );
        lessonId = Number(li.insertId);
      }
      const data = { time_limit_minutes: 0, pass_score: 80, max_attempts: 3, ...fields, lesson_id: lessonId };
      const cols = Object.keys(data) as (keyof typeof data)[];
      const r: any = await q(
        `INSERT INTO quizzes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map((k) => data[k])
      );
      return Number(r.insertId);
    }).catch((err: any) => {
      if (err?.http) return err.http as number;
      throw err;
    });

    if (quizId === 404) return fail(req, res, 404, "Leçon introuvable dans ce cours", "Lesson not found in this course");
    if (quizId === 409) return fail(req, res, 409, "Cette leçon a déjà un quiz", "This lesson already has a quiz");
    return res.status(201).json({ success: true, message: tr(req, "Quiz créé", "Quiz created"), data: { id: quizId } });
  } catch (error) {
    return serverError(req, res, "createQuiz", error);
  }
};

// PATCH /api/instructor/quizzes/:quizId
export const updateQuiz = async (req: Req, res: Response) => {
  try {
    const quizId = parseId(req.params.quizId)!;
    const body = req.body || {};
    const { fields, errors } = validateQuizBody(req, body, true);
    if (Object.keys(errors).length) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    const cols = Object.keys(fields);
    if (cols.length) {
      await query(`UPDATE quizzes SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = NOW() WHERE id = ?`, [...cols.map((k) => fields[k]), quizId]);
    }
    if (body.is_published !== undefined) {
      await query("UPDATE lessons SET is_published = ? WHERE id = (SELECT lesson_id FROM quizzes WHERE id = ?)", [body.is_published ? 1 : 0, quizId]);
    }
    return res.json({ success: true, message: tr(req, "Quiz mis à jour", "Quiz updated") });
  } catch (error) {
    return serverError(req, res, "updateQuiz", error);
  }
};

// DELETE /api/instructor/quizzes/:quizId
export const deleteQuiz = async (req: Req, res: Response) => {
  try {
    if (await structureLocked(req, cid(req))) return lockedMsg(req, res);
    const quizId = parseId(req.params.quizId)!;
    await withTransaction(async (q) => {
      const [row]: any = await q(
        "SELECT q.lesson_id, l.content_type FROM quizzes q JOIN lessons l ON l.id = q.lesson_id WHERE q.id = ?",
        [quizId]
      );
      if (!row) return;
      // Leçon dédiée au quiz → on la supprime avec lui ; sinon on ne retire que le quiz.
      if (row.content_type === "quiz") await deleteLessonsTx(q, [Number(row.lesson_id)]);
      else {
        await q("DELETE FROM quiz_attempts WHERE quiz_id = ?", [quizId]);
        await q("DELETE FROM quiz_questions WHERE quiz_id = ?", [quizId]);
        await q("DELETE FROM quizzes WHERE id = ?", [quizId]);
      }
    });
    return res.json({ success: true, message: tr(req, "Quiz supprimé", "Quiz deleted") });
  } catch (error) {
    return serverError(req, res, "deleteQuiz", error);
  }
};

function buildQuestion(req: Req, b: any): { value?: { question: string; type: string; options: string; correct: string; points: number; explanation: string | null }; errors: Record<string, string> } {
  const e: Record<string, string> = {};
  const text = String(b.question_text ?? "").trim();
  if (text.length < 3 || text.length > 2000) e.question_text = tr(req, "La question doit contenir entre 3 et 2000 caractères", "The question must be between 3 and 2000 characters");
  const type = b.type === "multiple" ? "multiple" : "single";
  const rawOptions: any[] = Array.isArray(b.options) ? b.options : [];
  const options = rawOptions
    .map((o) => ({ text: String(o?.option_text ?? "").trim().slice(0, 500), correct: !!o?.is_correct }))
    .filter((o) => o.text);
  if (options.length < 2) e.options = tr(req, "Au moins deux réponses sont nécessaires", "At least two answers are required");
  const correctIds = options.map((o, i) => (o.correct ? i + 1 : 0)).filter(Boolean);
  if (options.length >= 2 && correctIds.length < 1) e.options = tr(req, "Sélectionnez au moins une bonne réponse", "Select at least one correct answer");
  if (type === "single" && correctIds.length > 1) e.options = tr(req, "Une seule bonne réponse est autorisée", "Only one correct answer is allowed");
  const points = Number(b.points ?? 1);
  if (!Number.isInteger(points) || points < 1 || points > 100) e.points = tr(req, "Points invalides (1 à 100)", "Invalid points (1 to 100)");
  if (Object.keys(e).length) return { errors: e };
  return {
    errors: e,
    value: {
      question: text,
      type: Q_DB_TYPE[type],
      options: JSON.stringify(options.map((o, i) => ({ id: i + 1, text: o.text }))),
      correct: JSON.stringify(type === "single" ? correctIds[0] : correctIds),
      points,
      explanation: String(b.explanation ?? "").trim().slice(0, 2000) || null,
    },
  };
}

// POST /api/instructor/quizzes/:quizId/questions
export const createQuestion = async (req: Req, res: Response) => {
  try {
    const { value, errors } = buildQuestion(req, req.body || {});
    if (!value) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    const quizId = parseId(req.params.quizId)!;
    const [o]: any = await query("SELECT COALESCE(MAX(order_index), 0) + 1 AS n FROM quiz_questions WHERE quiz_id = ?", [quizId]);
    const result: any = await query(
      `INSERT INTO quiz_questions (quiz_id, question, question_type, options, correct_answer, explanation, points, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [quizId, value.question, value.type, value.options, value.correct, value.explanation, value.points, num(o?.n) || 1]
    );
    return res.status(201).json({ success: true, message: tr(req, "Question ajoutée", "Question added"), data: { id: Number(result.insertId) } });
  } catch (error) {
    return serverError(req, res, "createQuestion", error);
  }
};

// PATCH /api/instructor/questions/:questionId
export const updateQuestion = async (req: Req, res: Response) => {
  try {
    const { value, errors } = buildQuestion(req, req.body || {});
    if (!value) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    await query(
      `UPDATE quiz_questions SET question = ?, question_type = ?, options = ?, correct_answer = ?, explanation = ?, points = ? WHERE id = ?`,
      [value.question, value.type, value.options, value.correct, value.explanation, value.points, parseId(req.params.questionId)]
    );
    return res.json({ success: true, message: tr(req, "Question mise à jour", "Question updated") });
  } catch (error) {
    return serverError(req, res, "updateQuestion", error);
  }
};

// DELETE /api/instructor/questions/:questionId
export const deleteQuestion = async (req: Req, res: Response) => {
  try {
    await query("DELETE FROM quiz_questions WHERE id = ?", [parseId(req.params.questionId)]);
    return res.json({ success: true, message: tr(req, "Question supprimée", "Question deleted") });
  } catch (error) {
    return serverError(req, res, "deleteQuestion", error);
  }
};

// ═════════════════════════════════════════════════════════════
// ÉTUDIANTS
// ═════════════════════════════════════════════════════════════
// GET /api/instructor/courses/:id/students
export const listCourseStudents = async (req: Req, res: Response) => {
  try {
    const rows = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email,
              ce.id AS enrollment_id, ce.enrolled_at, ce.completion_percentage, ce.last_accessed_at,
              ce.completed_at, ce.is_approved, ce.payment_status
         FROM course_enrollments ce JOIN users u ON u.id = ce.user_id
        WHERE ce.course_id = ? ORDER BY ce.enrolled_at DESC`,
      [cid(req)]
    );
    const data = toPlain<any[]>(rows).map((r) => ({ ...r, completion_percentage: num(r.completion_percentage), is_approved: !!r.is_approved }));
    return res.json({ success: true, data });
  } catch (error) {
    return serverError(req, res, "listCourseStudents", error);
  }
};

// ═════════════════════════════════════════════════════════════
// STATISTIQUES  (sous-requêtes séparées : plus de multiplication des gains)
// ═════════════════════════════════════════════════════════════
// GET /api/instructor/stats?period=week|month|all
export const getStats = async (req: Req, res: Response) => {
  try {
    const uid = req.user!.id;
    const period = String(req.query.period || "all");
    const days = period === "week" ? 7 : period === "month" ? 30 : 0;
    const since = days ? sqlDate(new Date(Date.now() - days * 86400000)) : null;

    const [courses]: any = await query(
      `SELECT COUNT(*) AS total_courses, COALESCE(SUM(c.is_published), 0) AS published_courses,
              COALESCE(SUM(c.rating * c.review_count) / NULLIF(SUM(c.review_count), 0), 0) AS avg_rating,
              COALESCE(SUM(c.review_count), 0) AS total_reviews
         FROM courses c WHERE ${MINE}`,
      [uid, uid]
    );
    const [students]: any = await query(
      `SELECT COUNT(DISTINCT ce.user_id) AS total_students,
              COUNT(DISTINCT CASE WHEN ? IS NOT NULL AND ce.enrolled_at >= ? THEN ce.user_id END) AS new_students,
              COALESCE(SUM(ce.completion_percentage >= 100), 0) AS total_completions
         FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
        WHERE ce.is_approved = 1 AND ${MINE}`,
      [since, since, uid, uid]
    );
    const [earn]: any = await query(
      `SELECT COALESCE(SUM(CASE WHEN ? IS NULL OR earned_at >= ? THEN commission_amount END), 0) AS total_earnings,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount END), 0) AS paid_earnings,
              COALESCE(SUM(CASE WHEN status <> 'paid' THEN commission_amount END), 0) AS pending_earnings
         FROM instructor_commissions WHERE instructor_id = ?`,
      [since, since, uid]
    );
    const byMonth: any[] = await query(
      `SELECT DATE_FORMAT(ce.enrolled_at, '%Y-%m') AS month, COUNT(*) AS enrollments
         FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
        WHERE ce.is_approved = 1 AND ${MINE}
          AND ce.enrolled_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 5 MONTH)
        GROUP BY month ORDER BY month`,
      [uid, uid]
    );

    return res.json({
      success: true,
      data: {
        total_courses: num(courses?.total_courses),
        published_courses: num(courses?.published_courses),
        avg_rating: Math.round(num(courses?.avg_rating) * 10) / 10,
        total_reviews: num(courses?.total_reviews),
        total_students: num(students?.total_students),
        new_students: num(students?.new_students),
        total_completions: num(students?.total_completions),
        total_earnings: num(earn?.total_earnings),
        paid_earnings: num(earn?.paid_earnings),
        pending_earnings: num(earn?.pending_earnings),
        currency: "XAF",
        enrollments_by_month: toPlain(byMonth),
      },
    });
  } catch (error) {
    return serverError(req, res, "getStats", error);
  }
};

// GET /api/instructor/earnings?status=&page=&limit=
export const getEarnings = async (req: Req, res: Response) => {
  try {
    const uid = req.user!.id;
    const page = Math.max(parseId(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseId(req.query.limit) || 20, 1), 100);
    const status = ["earned", "pending", "paid"].includes(String(req.query.status)) ? String(req.query.status) : null;

    const where = status ? "ic.instructor_id = ? AND ic.status = ?" : "ic.instructor_id = ?";
    const params: any[] = status ? [uid, status] : [uid];

    const rows = await query(
      `SELECT ic.id, ic.course_id, c.title AS course_title, ic.sale_amount, ic.commission_rate, ic.commission_amount,
              ic.status, ic.earned_at, ic.paid_at, ic.payout_reference, ic.created_at
         FROM instructor_commissions ic JOIN courses c ON c.id = ic.course_id
        WHERE ${where} ORDER BY ic.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    const [count]: any = await query(`SELECT COUNT(*) AS total FROM instructor_commissions ic WHERE ${where}`, params);
    const [totals]: any = await query(
      `SELECT COALESCE(SUM(commission_amount), 0) AS total,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount END), 0) AS paid,
              COALESCE(SUM(CASE WHEN status <> 'paid' THEN commission_amount END), 0) AS pending
         FROM instructor_commissions WHERE instructor_id = ?`,
      [uid]
    );
    const byCourse = await query(
      `SELECT c.id AS course_id, c.title AS course_title, COUNT(*) AS sales, SUM(ic.commission_amount) AS amount
         FROM instructor_commissions ic JOIN courses c ON c.id = ic.course_id
        WHERE ic.instructor_id = ? GROUP BY c.id, c.title ORDER BY amount DESC LIMIT 10`,
      [uid]
    );
    return res.json({
      success: true,
      data: toPlain(rows),
      totals: { total: num(totals?.total), paid: num(totals?.paid), pending: num(totals?.pending), currency: "XAF" },
      by_course: toPlain<any[]>(byCourse).map((r) => ({ ...r, amount: num(r.amount) })),
      pagination: { total: num(count?.total), page, limit },
    });
  } catch (error) {
    return serverError(req, res, "getEarnings", error);
  }
};

// ═════════════════════════════════════════════════════════════
// DEVOIRS / PROJETS  (tables projects & project_submissions)
// ═════════════════════════════════════════════════════════════
const clientSubmissionStatus = (s: string) =>
  s === "validated" ? "graded" : s === "rejected" ? "rejected" : "pending";

// GET /api/instructor/submissions
export const listSubmissions = async (req: Req, res: Response) => {
  try {
    const uid = req.user!.id;
    const rows = await query(
      `SELECT ps.id, ps.status, ps.submission_url, ps.file_url, ps.student_notes, ps.submitted_at, ps.score, ps.passed,
              ps.corrector_feedback, ps.reviewed_at, ps.sla_deadline_at, ps.attempt_number,
              p.id AS project_id, p.title AS project_title, p.pass_score,
              c.id AS course_id, c.title AS course_title,
              u.id AS user_id, u.first_name, u.last_name, u.email
         FROM project_submissions ps
         JOIN projects p ON p.id = ps.project_id
         JOIN courses c  ON c.id = ps.course_id
         JOIN users u    ON u.id = ps.user_id
        WHERE ps.status IN ('submitted','under_review','validated','rejected','sla_exceeded') AND ${MINE}
        ORDER BY (ps.status IN ('validated','rejected')) ASC, ps.submitted_at DESC
        LIMIT 500`,
      [uid, uid]
    );
    const data = toPlain<any[]>(rows).map((r) => ({
      ...r,
      raw_status: r.status,
      status: clientSubmissionStatus(r.status),
      grade: r.score,
      feedback: r.corrector_feedback,
    }));
    return res.json({ success: true, data });
  } catch (error) {
    return serverError(req, res, "listSubmissions", error);
  }
};

// PATCH /api/instructor/submissions/:submissionId/grade   { score: 0-100, feedback }
export const gradeSubmission = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.submissionId)!;
    const score = Number(req.body?.score);
    const feedback = String(req.body?.feedback ?? "").trim().slice(0, 5000);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return fail(req, res, 400, "La note doit être comprise entre 0 et 100", "The score must be between 0 and 100", { errors: { score: "invalid" } });
    }
    const [sub]: any = await query(
      `SELECT ps.id, ps.user_id, ps.course_id, p.pass_score, p.title AS project_title
         FROM project_submissions ps JOIN projects p ON p.id = ps.project_id WHERE ps.id = ?`,
      [id]
    );
    if (!sub) return fail(req, res, 404, "Soumission introuvable", "Submission not found");

    const rounded = Math.round(score);
    const passed = rounded >= Number(sub.pass_score);
    await query(
      `UPDATE project_submissions
          SET score = ?, passed = ?, status = ?, corrector_id = ?, corrector_feedback = ?, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = ?`,
      [rounded, passed ? 1 : 0, passed ? "validated" : "rejected", req.user!.id, feedback || null, id]
    );

    // Notification de l'étudiant dans sa langue (non bloquante)
    void (async () => {
      const lang = await getUserLang(Number(sub.user_id));
      const en = lang === "en";
      await createNotification(Number(sub.user_id), {
        type: passed ? "success" : "warning",
        title: en ? `Your project "${sub.project_title}" has been graded` : `Votre projet « ${sub.project_title} » a été corrigé`,
        message: en ? `Score: ${rounded}/100.` : `Note : ${rounded}/100.`,
        link: `/courses/${sub.course_id}/submissions`,
      });
    })().catch(() => {});

    return res.json({ success: true, message: tr(req, "Correction enregistrée", "Grade saved"), data: { score: rounded, passed } });
  } catch (error) {
    return serverError(req, res, "gradeSubmission", error);
  }
};

// ═════════════════════════════════════════════════════════════
// COLLÈGUES (recherche d'un instructeur validé à inviter)
// ═════════════════════════════════════════════════════════════
// GET /api/instructor/colleagues?search=
export const searchColleagues = async (req: Req, res: Response) => {
  try {
    const search = String(req.query.search ?? "").trim().slice(0, 100);
    const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
    const rows = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email
         FROM users u
        WHERE u.role = 'instructor' AND u.is_active = 1 AND u.id <> ?
          AND EXISTS (SELECT 1 FROM instructor_applications ia WHERE ia.user_id = u.id AND ia.status = 'accepted')
          AND (? = '' OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?)
        ORDER BY u.first_name ASC LIMIT 20`,
      [req.user!.id, search, like, like, like, like]
    );
    return res.json({ success: true, data: toPlain(rows) });
  } catch (error) {
    return serverError(req, res, "searchColleagues", error);
  }
};
