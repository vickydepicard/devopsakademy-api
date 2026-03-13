// src/controllers/lessonProgress.controller.ts
import { Response } from "express"
import { query } from "../config/database"
import { AuthenticatedRequest } from "../middleware/auth"

export const markLessonCompleted = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user)
      return res.status(403).json({ success: false, message: "Non authentifié" })

    const { courseId, lessonId } = req.params
    const userId = req.user.id

    // Vérifier que la leçon appartient au cours
    const [lesson]: any = await query(
      `SELECT l.id FROM lessons l
       JOIN modules m ON l.module_id = m.id
       WHERE l.id = ? AND m.course_id = ?`,
      [lessonId, courseId]
    )
    if (!lesson)
      return res.status(404).json({ success: false, message: "Leçon introuvable" })

    // Insérer la progression (ignore si déjà complétée)
    await query(
      "INSERT IGNORE INTO lesson_progress (lesson_id, user_id, completed_at) VALUES (?, ?, NOW())",
      [lessonId, userId]
    )

    // Recalculer %
    const [[{ total_lessons }]]: any = await query(
      `SELECT COUNT(l.id) as total_lessons
       FROM lessons l JOIN modules m ON l.module_id = m.id
       WHERE m.course_id = ?`,
      [courseId]
    )
    const [[{ completed }]]: any = await query(
      `SELECT COUNT(lp.id) as completed
       FROM lesson_progress lp
       JOIN lessons l ON lp.lesson_id = l.id
       JOIN modules m ON l.module_id = m.id
       WHERE m.course_id = ? AND lp.user_id = ?`,
      [courseId, userId]
    )

    const completion_percentage = total_lessons > 0
      ? Math.round((completed / total_lessons) * 100) : 0
    const isComplete = completion_percentage >= 100

    // Mettre à jour l'enrollment
    await query(
      `UPDATE course_enrollments
       SET
         completion_percentage = ?,
         completed_at = IF(? >= 100 AND completed_at IS NULL, NOW(), completed_at),
         last_accessed_at = NOW()
       WHERE course_id = ? AND user_id = ?`,
      [completion_percentage, completion_percentage, courseId, userId]
    )

    // ── Générer le certificat si 100% ──
    if (isComplete) {
      // Récupérer l'enrollment_id (obligatoire dans la table certificates)
      const [enrollment]: any = await query(
        "SELECT id FROM course_enrollments WHERE course_id = ? AND user_id = ?",
        [courseId, userId]
      )

      if (enrollment) {
        const certNumber = `DA-${new Date().getFullYear()}-${String(courseId).padStart(4,"0")}-${String(userId).padStart(5,"0")}-${Math.random().toString(36).slice(2,8).toUpperCase()}`

        await query(
          `INSERT IGNORE INTO certificates (user_id, course_id, enrollment_id, certificate_number, issued_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [userId, courseId, enrollment.id, certNumber]
        )
      }
    }

    return res.json({
      success: true,
      message: isComplete ? "Cours terminé ! Certificat généré 🎉" : "Leçon complétée",
      data: {
        completion_percentage,
        course_completed: isComplete,
        completed_lessons: completed,
        total_lessons,
      }
    })
  } catch (err) {
    console.error("Mark lesson error:", err)
    return res.status(500).json({ success: false, message: "Erreur progression leçon" })
  }
}