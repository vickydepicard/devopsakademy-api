import express from 'express';
import { 
  register, 
  login, 
  logout, 
  getCurrentUser, 
  refreshToken,
  getDashboard  // ⬅️ IMPORT AJOUTÉ
} from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { requireAuth } from '../middleware/permissions'; // ⬅️ IMPORT AJOUTÉ

const router = express.Router();

// ================= ROUTES PUBLIQUES =================
router.post('/register', register);

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Connexion utilisateur
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Connexion réussie
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         description: Identifiants invalides
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/login', login);

router.post('/refresh-token', refreshToken);

// ================= ROUTES PROTÉGÉES =================
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, getCurrentUser);

// ✅ NOUVEAU : DASHBOARD (CONNECTÉ SEULEMENT)
router.get('/dashboard', requireAuth, getDashboard);

export default router;