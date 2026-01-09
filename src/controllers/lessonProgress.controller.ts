import { Response } from "express"
import { query } from "../config/database"
import { AuthenticatedRequest } from "../middleware/auth"

export const markLessonCompleted = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user || req.user.role !== "student")
      return res.status(403).json({ success: false, message: "Accès étudiant requis" })

    const { courseId, lessonId } = req.params

    // Vérifier que la leçon existe dans le cours
    const [lesson]: any = await query(
      "SELECT id FROM lessons WHERE id = ? AND module_id IN (SELECT id FROM modules WHERE course_id = ?)",
      [lessonId, courseId]
    )
    if (!lesson) return res.status(404).json({ success: false, message: "Leçon introuvable" })

    // Vérifier si déjà complétée
    const [progress]: any = await query(
      "SELECT id FROM lesson_progress WHERE lesson_id = ? AND user_id = ?",
      [lessonId, req.user.id]
    )
    if (!progress) {
      await query(
        "INSERT INTO lesson_progress (lesson_id, user_id, completed_at) VALUES (?, ?, NOW())",
        [lessonId, req.user.id]
      )
    }

    // Recalculer % progression du cours
    const [[{ total_lessons }]]: any = await query(
      "SELECT COUNT(l.id) as total_lessons FROM lessons l JOIN modules m ON l.module_id = m.id WHERE m.course_id = ?",
      [courseId]
    )
    const [[{ completed }]]: any = await query(
      "SELECT COUNT(lp.id) as completed FROM lesson_progress lp JOIN lessons l ON lp.lesson_id = l.id JOIN modules m ON l.module_id = m.id WHERE m.course_id = ? AND lp.user_id = ?",
      [courseId, req.user.id]
    )

    const completion_percentage = total_lessons > 0 ? Math.round((completed / total_lessons) * 100) : 0

    await query(
      "UPDATE course_enrollments SET completion_percentage = ? WHERE course_id = ? AND user_id = ?",
      [completion_percentage, courseId, req.user.id]
    )

    return res.json({ success: true, message: "Leçon complétée", completion_percentage })
  } catch (err) {
    console.error("Mark lesson error:", err)
    return res.status(500).json({ success: false, message: "Erreur progression leçon" })
  }
}
