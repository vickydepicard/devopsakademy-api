// src/controllers/quizController.ts
// Côté étudiant : passer un quiz. Ces routes (/api/quizzes/:id et /submit) n'existaient pas
// alors que la page QuizPage les appelait. Les bonnes réponses ne sont jamais envoyées
// avant la soumission.
import { Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { tr } from "../utils/lang";
import { toPlain, parseJson, parseId } from "../utils/serialize";
import { getCourseAccess } from "../utils/courseAccess";

type Req = AuthenticatedRequest;
const num = (v: any) => (v === null || v === undefined ? 0 : Number(v) || 0);
const fail = (req: Req, res: Response, status: number, fr: string, en: string, extra: object = {}) =>
  res.status(status).json({ success: false, message: tr(req, fr, en), ...extra });

async function loadQuizForUser(req: Req, quizId: number) {
  const [quiz]: any = await query(
    `SELECT q.*, l.is_published AS lesson_published, m.is_published AS module_published, m.course_id
       FROM quizzes q JOIN lessons l ON l.id = q.lesson_id JOIN modules m ON m.id = l.module_id
      WHERE q.id = ?`,
    [quizId]
  );
  if (!quiz) return { error: 404 as const };
  const courseId = Number(quiz.course_id);
  const access = await getCourseAccess(req.user!, courseId);
  if (access.canEdit) return { quiz: toPlain(quiz), courseId, preview: true };

  if (!Number(quiz.lesson_published) || !Number(quiz.module_published)) return { error: 404 as const };
  const [enr]: any = await query(
    "SELECT is_approved, payment_status FROM course_enrollments WHERE user_id = ? AND course_id = ?",
    [req.user!.id, courseId]
  );
  const ok = enr && (Number(enr.is_approved) === 1 || ["verified", "free"].includes(enr.payment_status));
  if (!ok) return { error: 403 as const };
  return { quiz: toPlain(quiz), courseId, preview: false };
}

// GET /api/quizzes/:quizId
export const getQuiz = async (req: Req, res: Response) => {
  try {
    const quizId = parseId(req.params.quizId);
    if (!quizId) return fail(req, res, 404, "Quiz introuvable", "Quiz not found");
    const ctx = await loadQuizForUser(req, quizId);
    if ("error" in ctx) {
      return ctx.error === 404
        ? fail(req, res, 404, "Quiz introuvable", "Quiz not found")
        : fail(req, res, 403, "Vous devez être inscrit à ce cours.", "You must be enrolled in this course.");
    }
    const { quiz, preview } = ctx;

    const [att]: any = await query(
      "SELECT COUNT(*) AS n, MAX(completed_at) AS last_at FROM quiz_attempts WHERE user_id = ? AND quiz_id = ?",
      [req.user!.id, quizId]
    );
    const used = num(att?.n);
    const maxAttempts = num(quiz.max_attempts);
    if (!preview && maxAttempts > 0 && used >= maxAttempts) {
      return fail(req, res, 403, "Vous avez utilisé toutes vos tentatives pour ce quiz.", "You have used all your attempts for this quiz.", { code: "ATTEMPTS_EXHAUSTED" });
    }
    const cooldown = num(quiz.cooldown_minutes);
    if (!preview && cooldown > 0 && att?.last_at) {
      const wait = Math.ceil((new Date(att.last_at).getTime() + cooldown * 60000 - Date.now()) / 1000);
      if (wait > 0) {
        return fail(req, res, 429, "Veuillez patienter avant une nouvelle tentative.", "Please wait before trying again.", { code: "COOLDOWN", retry_after_seconds: wait });
      }
    }

    let questions: any[] = toPlain(await query("SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY order_index ASC", [quizId]));
    if (Number(quiz.randomize_questions)) questions = questions.sort(() => Math.random() - 0.5);

    return res.json({
      success: true,
      data: {
        id: quiz.id,
        title: quiz.title,
        description: quiz.description || "",
        time_limit_minutes: num(quiz.time_limit_minutes) || null,
        passing_score: num(quiz.pass_score),
        attempts_allowed: maxAttempts,
        attempts_used: used,
        preview,
        questions: questions.map((q) => ({
          id: q.id,
          question_text: q.question,
          type: q.question_type === "multiple_select" ? "multiple" : "single",
          points: num(q.points) || 1,
          options: (parseJson<any[]>(q.options, [])).map((o) => ({ id: o.id, option_text: o.text })),
        })),
      },
    });
  } catch (error: any) {
    console.error("getQuiz:", error?.message || error);
    return fail(req, res, 500, "Erreur serveur", "Server error");
  }
};

// POST /api/quizzes/:quizId/submit   { answers: [{ question_id, selected_option_id | selected_option_ids }] }
export const submitQuiz = async (req: Req, res: Response) => {
  try {
    const quizId = parseId(req.params.quizId);
    if (!quizId) return fail(req, res, 404, "Quiz introuvable", "Quiz not found");
    const ctx = await loadQuizForUser(req, quizId);
    if ("error" in ctx) {
      return ctx.error === 404
        ? fail(req, res, 404, "Quiz introuvable", "Quiz not found")
        : fail(req, res, 403, "Vous devez être inscrit à ce cours.", "You must be enrolled in this course.");
    }
    const { quiz, courseId, preview } = ctx;
    const userId = req.user!.id;

    const [att]: any = await query("SELECT COUNT(*) AS n FROM quiz_attempts WHERE user_id = ? AND quiz_id = ?", [userId, quizId]);
    const used = num(att?.n);
    const maxAttempts = num(quiz.max_attempts);
    if (!preview && maxAttempts > 0 && used >= maxAttempts) {
      return fail(req, res, 403, "Vous avez utilisé toutes vos tentatives pour ce quiz.", "You have used all your attempts for this quiz.", { code: "ATTEMPTS_EXHAUSTED" });
    }

    const questions: any[] = toPlain(await query("SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY order_index ASC", [quizId]));
    if (!questions.length) return fail(req, res, 409, "Ce quiz ne contient aucune question.", "This quiz has no questions.");

    const given = new Map<number, string[]>();
    for (const a of Array.isArray(req.body?.answers) ? req.body.answers : []) {
      const qid = parseId(a?.question_id);
      if (!qid) continue;
      const raw = a.selected_option_ids ?? (a.selected_option_id !== undefined ? [a.selected_option_id] : []);
      given.set(qid, (Array.isArray(raw) ? raw : [raw]).map((x: any) => String(x)));
    }

    let earned = 0, total = 0, correctCount = 0;
    const results: any[] = [];
    for (const q of questions) {
      const points = num(q.points) || 1;
      total += points;
      const correctRaw = parseJson<any>(q.correct_answer, []);
      const correct = (Array.isArray(correctRaw) ? correctRaw : [correctRaw]).map((x: any) => String(x)).sort();
      const answer = (given.get(Number(q.id)) || []).sort();
      const isCorrect = answer.length > 0 && answer.length === correct.length && answer.every((v, i) => v === correct[i]);
      if (isCorrect) { earned += points; correctCount += 1; }
      results.push({ question_id: q.id, correct: isCorrect, correct_option_ids: correct.map(Number), explanation: q.explanation || null });
    }
    const score = total > 0 ? Math.round((earned / total) * 10000) / 100 : 0;
    const passed = score >= num(quiz.pass_score);

    if (!preview) {
      await query(
        `INSERT INTO quiz_attempts (user_id, quiz_id, lesson_id, course_id, attempt_number, score, total_questions, correct_answers, passed, time_spent_seconds, answers, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [userId, quizId, quiz.lesson_id, courseId, used + 1, score, questions.length, correctCount, passed ? 1 : 0,
         Math.max(0, Math.round(num(req.body?.time_spent_seconds))) || null,
         JSON.stringify(Object.fromEntries(given))]
      );
      if (passed) await markLessonCompleted(userId, Number(quiz.lesson_id), courseId, score);
    }

    return res.json({
      success: true,
      data: {
        score, passed,
        passing_score: num(quiz.pass_score),
        correct_answers: correctCount,
        total_questions: questions.length,
        points_earned: earned, points_total: total,
        attempts_used: preview ? used : used + 1,
        attempts_remaining: maxAttempts > 0 ? Math.max(maxAttempts - (preview ? used : used + 1), 0) : null,
        preview,
        results: Number(quiz.show_correct_answers) ? results : results.map((r) => ({ question_id: r.question_id, correct: r.correct })),
      },
    });
  } catch (error: any) {
    console.error("submitQuiz:", error?.message || error);
    return fail(req, res, 500, "Erreur serveur", "Server error");
  }
};

async function markLessonCompleted(userId: number, lessonId: number, courseId: number, score: number) {
  await query(
    `INSERT INTO lesson_progress
       (user_id, lesson_id, course_id, status, is_completed, completed_at, video_progress_seconds, video_duration_seconds, last_accessed_at, quiz_score)
     VALUES (?, ?, ?, 'completed', 1, NOW(), 0, 0, NOW(), ?)
     ON DUPLICATE KEY UPDATE status = 'completed', is_completed = 1, completed_at = COALESCE(completed_at, NOW()),
       last_accessed_at = NOW(), quiz_score = GREATEST(COALESCE(quiz_score, 0), VALUES(quiz_score))`,
    [userId, lessonId, courseId, score]
  );
  const [tot]: any = await query(
    `SELECT COUNT(l.id) AS total FROM lessons l JOIN modules m ON l.module_id = m.id
      WHERE m.course_id = ? AND l.is_published = 1 AND m.is_published = 1`, [courseId]);
  const [done]: any = await query(
    `SELECT COUNT(lp.id) AS done FROM lesson_progress lp JOIN lessons l ON lp.lesson_id = l.id JOIN modules m ON l.module_id = m.id
      WHERE m.course_id = ? AND lp.user_id = ? AND lp.is_completed = 1`, [courseId, userId]);
  const total = num(tot?.total);
  const pct = total > 0 ? Math.min(Math.round((num(done?.done) / total) * 100), 100) : 0;
  await query("UPDATE course_enrollments SET completion_percentage = ?, last_accessed_at = NOW() WHERE course_id = ? AND user_id = ?", [pct, courseId, userId]);
  if (pct === 100) {
    await query("UPDATE course_enrollments SET completed_at = COALESCE(completed_at, NOW()) WHERE course_id = ? AND user_id = ?", [courseId, userId]);
  }
}
