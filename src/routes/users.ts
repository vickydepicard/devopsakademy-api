import express from 'express';
import { 
  getUsers, 
  getUserById, 
  updateUser, 
  deleteUser, 
  getUserProgress 
} from '../controllers/userController';
import { authenticate, authorizeRoles } from '../middleware/auth';
import { query } from '../config/database';

const router = express.Router();

// ----------------------------
// Liste des instructeurs (publique, sans login)
// ----------------------------
router.get('/instructors', async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        u.id,
        u.first_name AS name,
        u.email,
        up.avatar_url,
        up.bio
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE u.role = "instructor"
    `);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ----------------------------
// Routes nécessitant authentification
// ----------------------------
router.use(authenticate);

// ----------------------------
// Profil de l’utilisateur connecté
// ----------------------------

/**
 * @openapi
 * /api/users/me:
 *   get:
 *     tags:
 *       - Users
 *     summary: Profil utilisateur connecté
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Profil utilisateur
 *       401:
 *         description: JWT manquant ou invalide
 */

router.get('/profile', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const user = await query(`
      SELECT 
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.role,
        u.is_active,
        u.email_verified,
        up.avatar_url,
        up.bio,
        up.job_title,
        up.company,
        up.skills,
        up.github_url,
        up.linkedin_url,
        up.twitter_url,
        up.country,
        up.timezone
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE u.id = ?
    `, [userId]);

    if (!user || user.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    res.json(user[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ----------------------------
// Progression d’un utilisateur
// ----------------------------
router.get('/:id/progress', getUserProgress);

// ----------------------------
// Routes admin seulement
// ----------------------------
router.get('/', authorizeRoles(['admin']), getUsers);
router.get('/:id', authorizeRoles(['admin']), getUserById);
router.put('/:id', authorizeRoles(['admin']), updateUser);
router.delete('/:id', authorizeRoles(['admin']), deleteUser);

export default router;
