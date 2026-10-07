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
import { tr } from "../utils/lang";

const router = express.Router();

// ----------------------------
// Liste des instructeurs (publique, sans login)
// ----------------------------
// ── GET /api/users/instructors — Liste publique des instructeurs ──
// Visibilité publique : instructeurs validés (candidature acceptée) + admins qui publient des cours.
// Avant : tout compte role='instructor' apparaissait, y compris les candidats non validés, et l'email était exposé.
const PUBLIC_INSTRUCTOR_SQL = `u.is_active = 1 AND (
  (u.role = 'instructor' AND EXISTS (SELECT 1 FROM instructor_applications ia WHERE ia.user_id = u.id AND ia.status = 'accepted'))
  OR (u.role IN ('admin','superadmin') AND EXISTS (SELECT 1 FROM courses pc WHERE pc.instructor_id = u.id AND pc.is_published = 1))
)`;

const PUBLIC_INSTRUCTOR_COLUMNS = `
        u.id,
        CONCAT(u.first_name, ' ', u.last_name) AS name,
        u.first_name, u.last_name,
        up.avatar_url, up.bio, up.job_title, up.company,
        up.years_experience, up.skills,
        up.github_url, up.linkedin_url, up.twitter_url, up.website_url,
        up.country, up.city,
        (SELECT COUNT(*) FROM courses c WHERE c.instructor_id = u.id AND c.is_published = 1) AS course_count,
        (SELECT COUNT(*) FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
          WHERE c.instructor_id = u.id AND c.is_published = 1 AND ce.is_approved = 1) AS student_count,
        (SELECT ROUND(AVG(NULLIF(c.rating, 0)), 1) FROM courses c WHERE c.instructor_id = u.id AND c.is_published = 1) AS avg_rating,
        u.created_at`;

router.get('/instructors', async (req, res) => {
  try {
    const instructors = await query(`
      SELECT ${PUBLIC_INSTRUCTOR_COLUMNS}
      FROM users u
      LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE ${PUBLIC_INSTRUCTOR_SQL}
      ORDER BY student_count DESC, course_count DESC, u.first_name ASC
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
      SELECT ${PUBLIC_INSTRUCTOR_COLUMNS}
      FROM users u
      LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE u.id = ? AND ${PUBLIC_INSTRUCTOR_SQL}
    `, [id]);

    if (!instructor) return res.status(404).json({ success: false, message: tr(req, "Instructeur introuvable", "Instructor not found") });

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