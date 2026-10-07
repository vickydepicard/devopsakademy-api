// src/utils/courseAccess.ts
// Règles d'accès d'un instructeur à un cours :
//  - propriétaire (courses.instructor_id)  → tout (publier, supprimer, inviter)
//  - intervenant assigné par l'admin        → enseigner (étudiants, devoirs) ; contenu seulement si autorisé
//  - admin / superadmin                    → tout
import { query } from "../config/database";

export interface CourseAccess {
  exists: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isCoInstructor: boolean;
  canView: boolean;    // enseigner : voir le cours, les étudiants, corriger les devoirs
  canEdit: boolean;    // contenu : modules, leçons, quiz (auteur, admin, intervenant autorisé)
  canManage: boolean;  // auteur/admin : soumettre le cours, gérer les réglages
}

const NONE: CourseAccess = {
  exists: false, isOwner: false, isAdmin: false, isCoInstructor: false, canView: false, canEdit: false, canManage: false,
};

export const isAdminRole = (role?: string) => role === "admin" || role === "superadmin";

export async function getCourseAccess(
  user: { id: number; role: string },
  courseId: number
): Promise<CourseAccess> {
  const [course]: any = await query("SELECT id, instructor_id FROM courses WHERE id = ?", [courseId]);
  if (!course) return NONE;

  const isAdmin = isAdminRole(user.role);
  const isOwner = Number(course.instructor_id) === Number(user.id);
  let isCoInstructor = false;
  let coCanEdit = false;

  if (!isAdmin && !isOwner) {
    const [row]: any = await query(
      "SELECT id, can_edit_content FROM course_instructors WHERE course_id = ? AND instructor_id = ? AND status = 'accepted'",
      [courseId, user.id]
    );
    isCoInstructor = !!row;
    coCanEdit = !!row && Number(row.can_edit_content) === 1;
  }

  return {
    exists: true,
    isOwner,
    isAdmin,
    isCoInstructor,
    canView: isAdmin || isOwner || isCoInstructor,
    canEdit: isAdmin || isOwner || coCanEdit,
    canManage: isAdmin || isOwner,
  };
}

// ── Résolution cours ← module / leçon / quiz / question / ressource ─────────
export const courseIdOfModule = async (moduleId: number): Promise<number | null> => {
  const [r]: any = await query("SELECT course_id FROM modules WHERE id = ?", [moduleId]);
  return r ? Number(r.course_id) : null;
};

export const courseIdOfLesson = async (lessonId: number): Promise<number | null> => {
  const [r]: any = await query(
    "SELECT m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = ?",
    [lessonId]
  );
  return r ? Number(r.course_id) : null;
};

export const courseIdOfQuiz = async (quizId: number): Promise<number | null> => {
  const [r]: any = await query(
    `SELECT m.course_id FROM quizzes q
       JOIN lessons l ON l.id = q.lesson_id
       JOIN modules m ON m.id = l.module_id
      WHERE q.id = ?`,
    [quizId]
  );
  return r ? Number(r.course_id) : null;
};

export const courseIdOfQuestion = async (questionId: number): Promise<number | null> => {
  const [r]: any = await query(
    `SELECT m.course_id FROM quiz_questions qq
       JOIN quizzes q ON q.id = qq.quiz_id
       JOIN lessons l ON l.id = q.lesson_id
       JOIN modules m ON m.id = l.module_id
      WHERE qq.id = ?`,
    [questionId]
  );
  return r ? Number(r.course_id) : null;
};

export const courseIdOfResource = async (resourceId: number): Promise<number | null> => {
  const [r]: any = await query(
    `SELECT m.course_id FROM lesson_resources lr
       JOIN lessons l ON l.id = lr.lesson_id
       JOIN modules m ON m.id = l.module_id
      WHERE lr.id = ?`,
    [resourceId]
  );
  return r ? Number(r.course_id) : null;
};

export const courseIdOfSubmission = async (submissionId: number): Promise<number | null> => {
  const [r]: any = await query("SELECT course_id FROM project_submissions WHERE id = ?", [submissionId]);
  return r ? Number(r.course_id) : null;
};
