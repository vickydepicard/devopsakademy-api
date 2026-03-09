// src/controllers/userController.ts
import { Request, Response } from 'express';
import { query } from '../config/database';
import { AuthenticatedRequest } from '../middleware/auth';

// ─────────────────────────────────────────────
// GET /api/users  (admin)
// ─────────────────────────────────────────────
export const getUsers = async (req: Request, res: Response) => {
  try {
    const users = await query(`
      SELECT id, email, first_name, last_name, role, is_active, created_at, last_login
      FROM users 
      ORDER BY created_at DESC
    `);
    res.json({ success: true, data: users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de la récupération des utilisateurs' });
  }
};

// ─────────────────────────────────────────────
// GET /api/users/:id  (admin)
// ─────────────────────────────────────────────
export const getUserById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const users: any[] = await query(`
      SELECT
        u.id, u.email, u.first_name, u.last_name, u.role,
        u.is_active, u.created_at, u.last_login,
        up.bio, up.job_title, up.company, up.skills,
        up.years_experience,
        up.github_url, up.linkedin_url, up.twitter_url, up.website_url,
        up.avatar_url, up.country, up.city, up.timezone
      FROM users u 
      LEFT JOIN user_profiles up ON u.id = up.user_id 
      WHERE u.id = ?
    `, [id]);

    if (!users.length)
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });

    const user = users[0];
    delete user.password_hash;
    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: "Erreur lors de la récupération de l'utilisateur" });
  }
};

// ─────────────────────────────────────────────
// PUT /api/users/:id  (admin)
// ─────────────────────────────────────────────
export const updateUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, role, is_active } = req.body;

    const existing: any[] = await query('SELECT id FROM users WHERE id = ?', [id]);
    if (!existing.length)
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });

    await query(
      'UPDATE users SET first_name = ?, last_name = ?, role = ?, is_active = ?, updated_at = NOW() WHERE id = ?',
      [first_name, last_name, role, is_active, id]
    );
    res.json({ success: true, message: 'Utilisateur mis à jour avec succès' });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ success: false, message: "Erreur lors de la mise à jour de l'utilisateur" });
  }
};

// ─────────────────────────────────────────────
// DELETE /api/users/:id  (admin)
// ─────────────────────────────────────────────
export const deleteUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing: any[] = await query('SELECT id FROM users WHERE id = ?', [id]);
    if (!existing.length)
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });

    await query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: 'Utilisateur supprimé avec succès' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, message: "Erreur lors de la suppression de l'utilisateur" });
  }
};

// ─────────────────────────────────────────────
// GET /api/users/:id/progress  (admin ou soi-même)
// ─────────────────────────────────────────────
export const getUserProgress = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const authReq = req as AuthenticatedRequest;

    if (!authReq.user)
      return res.status(401).json({ success: false, message: 'Non authentifié' });

    if (parseInt(id) !== authReq.user.id && authReq.user.role !== 'admin')
      return res.status(403).json({ success: false, message: 'Accès non autorisé' });

    const progress = await query(`
      SELECT
        c.id                                                                          AS course_id,
        c.title                                                                       AS course_title,
        COUNT(l.id)                                                                   AS total_lessons,
        SUM(CASE WHEN lp.completed = 1 THEN 1 ELSE 0 END)                            AS completed_lessons,
        ROUND(
          (SUM(CASE WHEN lp.completed = 1 THEN 1 ELSE 0 END) * 100.0) / NULLIF(COUNT(l.id), 0),
          2
        )                                                                             AS completion_percentage,
        MAX(lp.updated_at)                                                            AS last_activity
      FROM course_enrollments ce
      JOIN courses c         ON ce.course_id  = c.id
      LEFT JOIN modules m    ON m.course_id   = c.id
      LEFT JOIN lessons l    ON l.module_id   = m.id
      LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ce.user_id
      WHERE ce.user_id = ?
      GROUP BY c.id, c.title
      ORDER BY last_activity DESC
    `, [id]);

    res.json({ success: true, data: progress });
  } catch (error) {
    console.error('Get user progress error:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de la récupération de la progression' });
  }
};

// ─────────────────────────────────────────────
// GET /api/profile  (utilisateur connecté)
// Colonnes exactes de user_profiles :
//   bio, job_title, company, skills, years_experience,
//   github_url, linkedin_url, twitter_url, website_url,
//   avatar_url, country, city, timezone,
//   leaderboard_visible, leaderboard_pseudonym, notification_prefs
// ─────────────────────────────────────────────
export const getProfile = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.user?.id)
      return res.status(401).json({ success: false, message: 'Non authentifié' });

    const users: any[] = await query(`
      SELECT
        u.id, u.email, u.first_name, u.last_name, u.role,
        u.is_active, u.email_verified, u.last_login,
        u.created_at, u.updated_at,
        up.bio, up.job_title, up.company, up.skills,
        up.years_experience,
        up.github_url, up.linkedin_url, up.twitter_url, up.website_url,
        up.avatar_url, up.country, up.city, up.timezone,
        up.leaderboard_visible, up.leaderboard_pseudonym,
        up.notification_prefs
      FROM users u
      LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE u.id = ?
    `, [authReq.user.id]);

    if (!users.length)
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });

    const user = users[0];
    delete user.password_hash;

    // Parser les champs JSON
    if (user.skills && typeof user.skills === 'string') {
      try { user.skills = JSON.parse(user.skills); } catch { user.skills = []; }
    }
    if (user.notification_prefs && typeof user.notification_prefs === 'string') {
      try { user.notification_prefs = JSON.parse(user.notification_prefs); } catch { user.notification_prefs = {}; }
    }

    res.json({
      success: true,
      data: { ...user, id: Number(user.id) },
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de la récupération du profil' });
  }
};

// ─────────────────────────────────────────────
// PUT /api/profile  (utilisateur connecté)
// ─────────────────────────────────────────────
export const updateProfile = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.user?.id)
      return res.status(401).json({ success: false, message: 'Non authentifié' });

    const userId = authReq.user.id;
    const {
      first_name, last_name,
      bio, job_title, company, skills, years_experience,
      github_url, linkedin_url, twitter_url, website_url,
      avatar_url, country, city, timezone,
      leaderboard_visible, leaderboard_pseudonym, notification_prefs,
    } = req.body;

    // Mettre à jour users
    await query(
      'UPDATE users SET first_name = ?, last_name = ?, updated_at = NOW() WHERE id = ?',
      [first_name, last_name, userId]
    );

    const skillsJson = skills
      ? (Array.isArray(skills) ? JSON.stringify(skills) : skills)
      : null;

    const notifJson = notification_prefs
      ? (typeof notification_prefs === 'object' ? JSON.stringify(notification_prefs) : notification_prefs)
      : null;

    const profileExists: any[] = await query(
      'SELECT user_id FROM user_profiles WHERE user_id = ?',
      [userId]
    );

    if (profileExists.length) {
      await query(
        `UPDATE user_profiles SET
           bio = ?, job_title = ?, company = ?, skills = ?,
           years_experience = ?,
           github_url = ?, linkedin_url = ?, twitter_url = ?, website_url = ?,
           avatar_url = ?, country = ?, city = ?, timezone = ?,
           leaderboard_visible = ?, leaderboard_pseudonym = ?,
           notification_prefs = ?,
           updated_at = NOW()
         WHERE user_id = ?`,
        [
          bio, job_title, company, skillsJson,
          years_experience ?? null,
          github_url, linkedin_url, twitter_url, website_url,
          avatar_url, country, city, timezone,
          leaderboard_visible ?? 1, leaderboard_pseudonym,
          notifJson,
          userId,
        ]
      );
    } else {
      await query(
        `INSERT INTO user_profiles
           (user_id, bio, job_title, company, skills, years_experience,
            github_url, linkedin_url, twitter_url, website_url,
            avatar_url, country, city, timezone,
            leaderboard_visible, leaderboard_pseudonym, notification_prefs,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          userId, bio, job_title, company, skillsJson, years_experience ?? null,
          github_url, linkedin_url, twitter_url, website_url,
          avatar_url, country, city, timezone,
          leaderboard_visible ?? 1, leaderboard_pseudonym, notifJson,
        ]
      );
    }

    // Retourner le profil mis à jour
    const updated: any[] = await query(`
      SELECT
        u.id, u.email, u.first_name, u.last_name, u.role,
        up.bio, up.job_title, up.company, up.skills,
        up.years_experience,
        up.github_url, up.linkedin_url, up.twitter_url, up.website_url,
        up.avatar_url, up.country, up.city, up.timezone,
        up.leaderboard_visible, up.leaderboard_pseudonym,
        up.notification_prefs
      FROM users u
      LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE u.id = ?
    `, [userId]);

    const result = updated[0];
    if (result.skills && typeof result.skills === 'string') {
      try { result.skills = JSON.parse(result.skills); } catch { result.skills = []; }
    }
    if (result.notification_prefs && typeof result.notification_prefs === 'string') {
      try { result.notification_prefs = JSON.parse(result.notification_prefs); } catch { result.notification_prefs = {}; }
    }

    res.json({
      success: true,
      message: 'Profil mis à jour avec succès',
      data: { ...result, id: Number(result.id) },
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour du profil' });
  }
};

export default {
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  getUserProgress,
  getProfile,
  updateProfile,
};