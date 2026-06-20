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
// ── GET /api/users/instructors — Liste publique des instructeurs ──
router.get('/instructors', async (req, res) => {
  try {
    const instructors = await query(`
      SELECT
        u.id,
        CONCAT(u.first_name, ' ', u.last_name) AS name,
        u.first_name, u.last_name, u.email,
        up.avatar_url, up.bio, up.job_title, up.company,
        up.years_experience, up.skills,
        up.github_url, up.linkedin_url, up.twitter_url, up.website_url,
        up.country, up.city,
        COUNT(DISTINCT c.id)  AS course_count,
        COUNT(DISTINCT ce.id) AS student_count,
        ROUND(AVG(c.rating), 1) AS avg_rating,
        u.created_at
      FROM users u
      LEFT JOIN user_profiles up  ON up.user_id = u.id
      LEFT JOIN courses c         ON c.instructor_id = u.id AND c.is_published = 1
      LEFT JOIN course_enrollments ce ON ce.course_id = c.id AND ce.is_approved = 1
      WHERE u.role IN ('instructor','admin') AND u.is_active = 1
      GROUP BY u.id, up.avatar_url, up.bio, up.job_title, up.company,
               up.years_experience, up.skills, up.github_url, up.linkedin_url,
               up.twitter_url, up.website_url, up.country, up.city
      ORDER BY student_count DESC, course_count DESC
    `);

    // Convertir BigInt + parser skills JSON
    const data = instructors.map((i: any) => ({
      ...i,
      course_count:  Number(i.course_count  ?? 0),
      student_count: Number(i.student_count ?? 0),
      avg_rating:    i.avg_rating ? parseFloat(i.avg_rating) : null,
      skills: (() => { try { return JSON.parse(i.skills || '[]'); } catch { return []; } })(),
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /instructors error:', err);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// ── GET /api/users/instructors/:id — Profil public d'un instructeur ──
router.get('/instructors/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [instructor] = await query(`
      SELECT
        u.id,
        CONCAT(u.first_name, ' ', u.last_name) AS name,
        u.first_name, u.last_name, u.email,
        up.avatar_url, up.bio, up.job_title, up.company,
        up.years_experience, up.skills,
        up.github_url, up.linkedin_url, up.twitter_url, up.website_url,
        up.country, up.city,
        COUNT(DISTINCT c.id)  AS course_count,
        COUNT(DISTINCT ce.id) AS student_count,
        ROUND(AVG(c.rating), 1) AS avg_rating,
        u.created_at
      FROM users u
      LEFT JOIN user_profiles up  ON up.user_id = u.id
      LEFT JOIN courses c         ON c.instructor_id = u.id AND c.is_published = 1
      LEFT JOIN course_enrollments ce ON ce.course_id = c.id AND ce.is_approved = 1
      WHERE u.id = ? AND u.is_active = 1
      GROUP BY u.id, up.avatar_url, up.bio, up.job_title, up.company,
               up.years_experience, up.skills, up.github_url, up.linkedin_url,
               up.twitter_url, up.website_url, up.country, up.city
    `, [id]);

    if (!instructor) return res.status(404).json({ success: false, message: 'Instructeur introuvable' });

    // Cours publiés de cet instructeur
    const courses = await query(`
      SELECT c.id, c.title, c.slug, c.description, c.price, c.is_free,
             c.level, c.thumbnail_url, c.rating, c.duration_hours,
             cat.name AS category_name,
             COUNT(DISTINCT ce.id) AS enrollment_count
      FROM courses c
      LEFT JOIN course_categories cat ON cat.id = c.category_id
      LEFT JOIN course_enrollments ce ON ce.course_id = c.id AND ce.is_approved = 1
      WHERE c.instructor_id = ? AND c.is_published = 1
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `, [id]);

    const data = {
      ...instructor,
      course_count:  Number(instructor.course_count  ?? 0),
      student_count: Number(instructor.student_count ?? 0),
      avg_rating:    instructor.avg_rating ? parseFloat(instructor.avg_rating) : null,
      skills: (() => { try { return JSON.parse(instructor.skills || '[]'); } catch { return []; } })(),
      courses: courses.map((c: any) => ({
        ...c,
        enrollment_count: Number(c.enrollment_count ?? 0),
        rating: c.rating ? parseFloat(c.rating) : null,
      })),
    };

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /instructors/:id error:', err);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
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