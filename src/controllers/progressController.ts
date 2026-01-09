import { Request, Response } from 'express';
import { query } from '../config/database';

export const getUserProgress = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;

    const progress = await query(`
      SELECT 
        c.id as course_id,
        c.title as course_title,
        COUNT(l.id) as total_lessons,
        SUM(CASE WHEN lp.completed THEN 1 ELSE 0 END) as completed_lessons,
        ROUND((SUM(CASE WHEN lp.completed THEN 1 ELSE 0 END) / COUNT(l.id)) * 100, 2) as completion_percentage,
        MAX(lp.updated_at) as last_activity
      FROM course_enrollments ce
      JOIN courses c ON ce.course_id = c.id
      LEFT JOIN modules m ON m.course_id = c.id
      LEFT JOIN lessons l ON l.module_id = m.id
      LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ce.user_id
      WHERE ce.user_id = ?
      GROUP BY c.id, c.title
      ORDER BY last_activity DESC
    `, [userId]);

    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('Get user progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la progression'
    });
  }
};

export const getCourseProgress = async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;
    const userId = (req as any).user.id;

    const progress = await query(`
      SELECT 
        m.id as module_id,
        m.title as module_title,
        COUNT(l.id) as total_lessons,
        SUM(CASE WHEN lp.completed THEN 1 ELSE 0 END) as completed_lessons,
        ROUND((SUM(CASE WHEN lp.completed THEN 1 ELSE 0 END) / COUNT(l.id)) * 100, 2) as completion_percentage
      FROM modules m
      LEFT JOIN lessons l ON m.id = l.module_id
      LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ?
      WHERE m.course_id = ?
      GROUP BY m.id, m.title
      ORDER BY m.order_index
    `, [userId, courseId]);

    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('Get course progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la progression du cours'
    });
  }
};

export const markLessonCompleted = async (req: Request, res: Response) => {
  try {
    const { lessonId } = req.params;
    const userId = (req as any).user.id;
    const { completed = true } = req.body;

    // Vérifier que la leçon existe
    const [lesson] = await query(
      'SELECT id FROM lessons WHERE id = ?',
      [lessonId]
    );

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: 'Leçon non trouvée'
      });
    }

    // Vérifier si la progression existe déjà
    const [existingProgress] = await query(`
      SELECT id FROM lesson_progress WHERE user_id = ? AND lesson_id = ?
    `, [userId, lessonId]);

    if (existingProgress) {
      // Mettre à jour la progression existante
      await query(`
        UPDATE lesson_progress 
        SET completed = ?, completed_at = ?, updated_at = NOW()
        WHERE user_id = ? AND lesson_id = ?
      `, [completed, completed ? new Date() : null, userId, lessonId]);
    } else {
      // Créer une nouvelle entrée de progression
      await query(`
        INSERT INTO lesson_progress (user_id, lesson_id, course_id, completed, completed_at)
        SELECT ?, ?, m.course_id, ?, ?
        FROM lessons l
        JOIN modules m ON l.module_id = m.id
        WHERE l.id = ?
      `, [userId, lessonId, completed, completed ? new Date() : null, lessonId]);
    }

    res.json({
      success: true,
      message: completed ? 'Leçon marquée comme terminée' : 'Leçon marquée comme non terminée'
    });
  } catch (error) {
    console.error('Mark lesson completed error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la progression'
    });
  }
};

export const getLessonStatus = async (req: Request, res: Response) => {
  try {
    const { lessonId } = req.params;
    const userId = (req as any).user.id;

    const [progress] = await query(`
      SELECT lp.*, l.title as lesson_title
      FROM lesson_progress lp
      JOIN lessons l ON lp.lesson_id = l.id
      WHERE lp.user_id = ? AND lp.lesson_id = ?
    `, [userId, lessonId]);

    res.json({
      success: true,
      data: progress || { completed: false }
    });
  } catch (error) {
    console.error('Get lesson status error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du statut de la leçon'
    });
  }
};