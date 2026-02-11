import { Request, Response } from 'express';
import { query } from '../config/database';
import bcrypt from 'bcryptjs';

// Interface pour typer l'utilisateur dans la requête
interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    role: string;
  };
}

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

    const users = await query(`
      SELECT u.*, up.bio, up.job_title, up.company, up.skills, up.github_url, up.linkedin_url, up.avatar_url
      FROM users u 
      LEFT JOIN user_profiles up ON u.id = up.user_id 
      WHERE u.id = ?
    `, [id]);

    const user = Array.isArray(users) && users.length > 0 ? users[0] : null;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Retirer le mot de passe hashé
    if (user.password_hash) {
      delete user.password_hash;
    }

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
    const existingUsers = await query(
      'SELECT id FROM users WHERE id = ?',
      [id]
    );

    const existingUser = Array.isArray(existingUsers) && existingUsers.length > 0 ? existingUsers[0] : null;

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
    const existingUsers = await query(
      'SELECT id FROM users WHERE id = ?',
      [id]
    );

    const existingUser = Array.isArray(existingUsers) && existingUsers.length > 0 ? existingUsers[0] : null;

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
    
    // Typer correctement la requête authentifiée
    const authReq = req as AuthenticatedRequest;
    
    if (!authReq.user) {
      return res.status(401).json({
        success: false,
        message: 'Non authentifié'
      });
    }

    // Vérifier que l'utilisateur demande ses propres données ou est admin
    if (parseInt(id) !== authReq.user.id && authReq.user.role !== 'admin') {
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
        SUM(CASE WHEN lp.is_completed = 1 THEN 1 ELSE 0 END) as completed_lessons,
        ROUND((SUM(CASE WHEN lp.is_completed = 1 THEN 1 ELSE 0 END) * 100.0) / COUNT(l.id), 2) as completion_percentage,
        MAX(lp.updated_at) as last_activity
      FROM course_enrollments ce
      JOIN courses c ON ce.course_id = c.id
      LEFT JOIN modules m ON m.course_id = c.id
      LEFT JOIN lessons l ON l.module_id = m.id
      LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ce.user_id
      WHERE ce.user_id = ?
      GROUP BY c.id, c.title
      ORDER BY last_activity DESC NULLS LAST
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

// Profil utilisateur (pour le profil route)
export const getProfile = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    
    if (!authReq.user?.id) {
      return res.status(401).json({
        success: false,
        message: 'Non authentifié'
      });
    }

    const users = await query(`
      SELECT u.*, up.bio, up.job_title, up.company, up.skills, up.github_url, up.linkedin_url, up.avatar_url
      FROM users u 
      LEFT JOIN user_profiles up ON u.id = up.user_id 
      WHERE u.id = ?
    `, [authReq.user.id]);

    const user = Array.isArray(users) && users.length > 0 ? users[0] : null;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Retirer le mot de passe hashé
    if (user.password_hash) {
      delete user.password_hash;
    }

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du profil'
    });
  }
};

export const updateProfile = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    
    if (!authReq.user?.id) {
      return res.status(401).json({
        success: false,
        message: 'Non authentifié'
      });
    }

    const { first_name, last_name, bio, job_title, company, skills, github_url, linkedin_url } = req.body;

    // Mettre à jour l'utilisateur
    await query(
      'UPDATE users SET first_name = ?, last_name = ?, updated_at = NOW() WHERE id = ?',
      [first_name, last_name, authReq.user.id]
    );

    // Vérifier si le profil existe
    const existingProfile = await query(
      'SELECT user_id FROM user_profiles WHERE user_id = ?',
      [authReq.user.id]
    );

    const profileExists = Array.isArray(existingProfile) && existingProfile.length > 0;

    if (profileExists) {
      // Mettre à jour le profil
      await query(
        `UPDATE user_profiles 
         SET bio = ?, job_title = ?, company = ?, skills = ?, github_url = ?, linkedin_url = ?, updated_at = NOW() 
         WHERE user_id = ?`,
        [bio, job_title, company, skills, github_url, linkedin_url, authReq.user.id]
      );
    } else {
      // Créer le profil
      await query(
        `INSERT INTO user_profiles 
         (user_id, bio, job_title, company, skills, github_url, linkedin_url) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [authReq.user.id, bio, job_title, company, skills, github_url, linkedin_url]
      );
    }

    res.json({
      success: true,
      message: 'Profil mis à jour avec succès'
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour du profil'
    });
  }
};

export default {
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  getUserProgress,
  getProfile,
  updateProfile
};