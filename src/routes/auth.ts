// src/routes/auth.ts — DevOpsAkademy
// VERSION AVEC ROUTES DE DEBUG (temporaire)

import express from 'express';
import crypto from 'crypto';
import {
  register,
  login,
  logout,
  getCurrentUser,
  refreshToken,
  getDashboard,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
} from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { requireAuth } from '../middleware/permissions';
import { query } from '../config/database';

const router = express.Router();

// ── ROUTES PUBLIQUES ─────────────────────────────────────────
router.post('/register',           register);
router.post('/login',              login);
router.post('/refresh-token',      refreshToken);
router.post('/forgot-password',    forgotPassword);
router.post('/reset-password',     resetPassword);
router.get ('/verify-email/:token', verifyEmail);
router.post('/resend-verification', resendVerification);

// ── ROUTES PROTÉGÉES ─────────────────────────────────────────
router.post('/logout', authenticate, logout);
router.get ('/me',     authenticate, getCurrentUser);
router.get ('/dashboard', requireAuth, getDashboard);

// ════════════════════════════════════════════════════════════
// 🔧 ROUTES DE DEBUG TEMPORAIRES — SUPPRIMER EN PRODUCTION
// ════════════════════════════════════════════════════════════

// GET /api/auth/debug-token/:token
// Ouvre dans le navigateur après avoir copié le token depuis l'URL de l'email
// Ex: http://localhost:5000/api/auth/debug-token/abc123...
router.get('/debug-token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Chercher par token hash exact
    const byHash = await query(
      `SELECT id, email, is_active, email_verified,
              verification_token IS NOT NULL AS has_token,
              LEFT(verification_token, 10) AS token_prefix,
              verification_token_expires,
              created_at
       FROM users WHERE verification_token = ? LIMIT 1`,
      [tokenHash]
    );

    // 5 derniers comptes
    const recent = await query(
      `SELECT id, email, is_active, email_verified,
              verification_token IS NOT NULL AS has_token,
              created_at
       FROM users ORDER BY created_at DESC LIMIT 5`
    );

    res.json({
      debug: true,
      token_length: token.length,
      token_start: token.substring(0, 20),
      hash_start:  tokenHash.substring(0, 20),
      found_by_hash: byHash,
      recent_users: recent,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/debug-activate
// Body: { "email": "utilisateur@exemple.com" }
// Active manuellement un compte bloqué
router.post('/debug-activate', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email requis dans le body' });

    await query(
      `UPDATE users
       SET is_active = TRUE, email_verified = TRUE, updated_at = NOW()
       WHERE email = ?`,
      [email]
    );

    const users = await query(
      'SELECT id, email, is_active, email_verified FROM users WHERE email = ?',
      [email]
    ) as any[];

    res.json({
      success: true,
      message: 'Compte activé manuellement',
      user: users[0] || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;