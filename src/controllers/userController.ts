import { Request, Response } from 'express';
import { query } from '../config/database';
import bcrypt from 'bcryptjs';

export const getUsers = async (req: Request, res: Response) => {
  try {
    const users = await query(`
      SELECT id, email, first_name, last_name, role, is_active, created_at, last_login
      FROM users 
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des utilisateurs'
    });
  }
};

export const getUserById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const [user] = await query(`
      SELECT u.*, up.bio, up.job_title, up.company, up.skills, up.github_url, up.linkedin_url, up.avatar_url
      FROM users u 
      LEFT JOIN user_profiles up ON u.id = up.user_id 
      WHERE u.id = ?
    `, [id]);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Retirer le mot de passe hashé
    delete user.password_hash;

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de l\'utilisateur'
    });
  }
};

export const updateUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, role, is_active } = req.body;

    // Vérifier que l'utilisateur existe
    const [existingUser] = await query(
      'SELECT id FROM users WHERE id = ?',
      [id]
    );

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    await query(
      'UPDATE users SET first_name = ?, last_name = ?, role = ?, is_active = ?, updated_at = NOW() WHERE id = ?',
      [first_name, last_name, role, is_active, id]
    );

    res.json({
      success: true,
      message: 'Utilisateur mis à jour avec succès'
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de l\'utilisateur'
    });
  }
};

export const deleteUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Vérifier que l'utilisateur existe
    const [existingUser] = await query(
      'SELECT id FROM users WHERE id = ?',
      [id]
    );

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    await query('DELETE FROM users WHERE id = ?', [id]);

    res.json({
      success: true,
      message: 'Utilisateur supprimé avec succès'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression de l\'utilisateur'
    });
  }
};

export const getUserProgress = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.id;

    // Vérifier que l'utilisateur demande ses propres données ou est admin
    if (parseInt(id) !== userId && (req as any).user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    // CORRECTION : Vérifiez d'abord le nom exact de la colonne dans votre table lesson_progress
    const progress = await query(`
      SELECT 
        c.id as course_id,
        c.title as course_title,
        COUNT(l.id) as total_lessons,
        SUM(CASE WHEN lp.is_completed THEN 1 ELSE 0 END) as completed_lessons,  -- Changé de lp.completed à lp.is_completed
        ROUND((SUM(CASE WHEN lp.is_completed THEN 1 ELSE 0 END) / COUNT(l.id)) * 100, 2) as completion_percentage,
        MAX(lp.updated_at) as last_activity
      FROM course_enrollments ce
      JOIN courses c ON ce.course_id = c.id
      LEFT JOIN modules m ON m.course_id = c.id
      LEFT JOIN lessons l ON l.module_id = m.id
      LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ce.user_id
      WHERE ce.user_id = ?
      GROUP BY c.id, c.title
      ORDER BY last_activity DESC
    `, [id]);

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