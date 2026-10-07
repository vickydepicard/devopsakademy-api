// src/utils/cascade.ts
// La base n'a pas de clés étrangères ON DELETE CASCADE sur cours/modules/leçons :
// supprimer une ligne laisserait des orphelins (progression, quiz, ressources…).
// Ces fonctions suppriment tout, dans une transaction.
import { TxQuery } from "../config/database";

const placeholders = (n: number) => Array(n).fill("?").join(",");

export async function deleteLessonsTx(q: TxQuery, lessonIds: number[]): Promise<void> {
  if (!lessonIds.length) return;
  const ph = placeholders(lessonIds.length);
  const quizzes: any[] = await q(`SELECT id FROM quizzes WHERE lesson_id IN (${ph})`, lessonIds);
  const quizIds = quizzes.map((r) => Number(r.id));
  if (quizIds.length) {
    const qph = placeholders(quizIds.length);
    await q(`DELETE FROM quiz_attempts  WHERE quiz_id IN (${qph})`, quizIds);
    await q(`DELETE FROM quiz_questions WHERE quiz_id IN (${qph})`, quizIds);
    await q(`DELETE FROM quizzes        WHERE id      IN (${qph})`, quizIds);
  }
  await q(`DELETE FROM lesson_resources WHERE lesson_id IN (${ph})`, lessonIds);
  await q(`DELETE FROM lesson_progress  WHERE lesson_id IN (${ph})`, lessonIds);
  await q(`UPDATE projects SET lesson_id = NULL WHERE lesson_id IN (${ph})`, lessonIds);
  await q(`DELETE FROM lessons WHERE id IN (${ph})`, lessonIds);
}

export async function deleteModulesTx(q: TxQuery, moduleIds: number[]): Promise<void> {
  if (!moduleIds.length) return;
  const ph = placeholders(moduleIds.length);
  const lessons: any[] = await q(`SELECT id FROM lessons WHERE module_id IN (${ph})`, moduleIds);
  await deleteLessonsTx(q, lessons.map((r) => Number(r.id)));
  await q(`DELETE FROM modules WHERE id IN (${ph})`, moduleIds);
}

export async function deleteCourseTx(q: TxQuery, courseId: number): Promise<void> {
  const modules: any[] = await q("SELECT id FROM modules WHERE course_id = ?", [courseId]);
  await deleteModulesTx(q, modules.map((r) => Number(r.id)));
  await q("DELETE FROM course_reviews     WHERE course_id = ?", [courseId]);
  await q("DELETE FROM course_instructors WHERE course_id = ?", [courseId]);
  await q("DELETE FROM courses            WHERE id        = ?", [courseId]);
}
