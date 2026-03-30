// src/controllers/authController.ts
import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendEmail, sendWelcomeEmail, sendPasswordResetEmail } from '../services/mail.service';
import { query } from "../config/database";

import { AuthenticatedRequest } from "../middleware/auth";

// token_hash = SHA-256 du JWT brut (varchar 64 en BDD)
const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";

const signAccessToken = (payload: object) => {
  return jwt.sign(payload, process.env.JWT_SECRET as string, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
};

const signRefreshToken = (payload: object) => {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET as string, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
};

// ---------------- REGISTER ----------------
export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, first_name, last_name, role = "student" } = req.body;

    const errors: string[] = [];
    if (!email || !email.includes("@")) errors.push("Email invalide");
    if (!password || password.length < 8)
      errors.push("Le mot de passe doit contenir au moins 8 caractères");
    if (!first_name || first_name.length < 2)
      errors.push("Le prénom doit contenir au moins 2 caractères");
    if (!last_name || last_name.length < 2)
      errors.push("Le nom doit contenir au moins 2 caractères");
    if (!["student", "instructor", "admin"].includes(role))
      errors.push("Le rôle doit être student, instructor ou admin");

    if (errors.length > 0)
      return res
        .status(400)
        .json({ success: false, message: "Erreur de validation", errors });

    const existingUsers = await query("SELECT id FROM users WHERE email = ?", [email]);
    if (existingUsers.length > 0)
      return res
        .status(400)
        .json({ success: false, message: "Un utilisateur avec cet email existe déjà" });

    const passwordHash = await bcrypt.hash(password, 12);

    // ✅ Compte désactivé par défaut → activé après vérification email
    const verifToken     = crypto.randomBytes(32).toString("hex");
    const verifTokenHash = crypto.createHash("sha256").update(verifToken).digest("hex");
    const verifExpires   = new Date(Date.now() + 24 * 3600 * 1000); // 24h

    const insertResult: any = await query(
      `INSERT INTO users
         (email, password_hash, first_name, last_name, role,
          is_active, email_verified, verification_token, verification_token_expires)
       VALUES (?, ?, ?, ?, ?, FALSE, FALSE, ?, ?)`,
      [email, passwordHash, first_name, last_name, role, verifTokenHash,
       verifExpires.toISOString().slice(0, 19).replace("T", " ")]
    );

    const userId = Number(insertResult.insertId);

    // Créer le profil utilisateur (non bloquant)
    await query(
      "INSERT IGNORE INTO user_profiles (user_id, created_at, updated_at) VALUES (?, NOW(), NOW())",
      [userId]
    ).catch((e: any) => console.warn("⚠️ user_profiles insert (non bloquant):", e.message));

    /* =====================================================
       📧 ENVOI EMAIL DE BIENVENUE (NON BLOQUANT)
    ===================================================== */
    // ✅ Email de vérification (NON BLOQUANT)
    try {
      const verifyUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/verify-email/${verifToken}`;
      await sendEmail({
        to: email,
        subject: "Activez votre compte DevOpsAkademy 🚀",
        html: `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;background:#f4f3fb;padding:20px;">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(45,40,127,0.1);">
  <div style="background:linear-gradient(135deg,#2d287f,#5653e1);padding:28px 32px;text-align:center;">
    <p style="margin:0;color:#facc15;font-size:20px;font-weight:900;">DevOps Akademy</p>
  </div>
  <div style="padding:32px;">
    <h2 style="color:#2d287f;margin:0 0 12px;">Bonjour ${first_name} 👋</h2>
    <p style="color:#555;font-size:15px;">Votre compte a été créé avec succès.<br/>Cliquez sur le bouton ci-dessous pour activer votre compte :</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${verifyUrl}"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        ✅ Activer mon compte
      </a>
    </div>
    <p style="color:#888;font-size:13px;text-align:center;">Ce lien expire dans <strong>24 heures</strong>.<br/>Si vous n'avez pas créé ce compte, ignorez cet email.</p>
  </div>
</div>
</body></html>`,
      });
    } catch (mailError: any) {
      console.error("MAIL REGISTER ERROR:", mailError?.message || mailError);
      // ❗ Email échoué → compte créé mais email non envoyé
      return res.status(201).json({
        success: true,
        message: "Compte créé. L'email de vérification n'a pas pu être envoyé, cliquez sur 'Renvoyer'.",
        email_sent: false,
        data: {
          user: { id: userId, email, first_name, last_name, role },
          email_verification_required: true,
        },
      });
    }

    res.status(201).json({
      success: true,
      message: "Compte créé avec succès ! Vérifiez votre email pour activer votre compte.",
      email_sent: true,
      data: {
        user: { id: userId, email, first_name, last_name, role },
        email_verification_required: true,
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur interne du serveur",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};

// ---------------- LOGIN ----------------
export const login = async (req: Request, res: Response) => {
  try {
    // ✅ CORRECTION : le frontend envoie "password", pas "password_hash"
    const { email, password } = req.body;

    if (!email || !email.includes("@"))
      return res.status(400).json({ success: false, message: "Email invalide" });

    // ✅ CORRECTION : vérifier "password" (pas "password_hash")
    if (!password)
      return res.status(400).json({ success: false, message: "Mot de passe requis" });

    const users: any[] = await query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0)
      return res
        .status(401)
        .json({ success: false, message: "Email ou mot de passe incorrect" });

    const user = users[0];

    if (!user.is_active) {
      if (!user.email_verified) {
        return res.status(403).json({
          success: false,
          message: "Email non vérifié. Consultez votre boîte email pour activer votre compte.",
          email_not_verified: true,
          email: user.email,
        });
      }
      return res.status(403).json({ success: false, message: "Compte désactivé. Contactez l\'administration." });
    }

    // ✅ CORRECTION : bcrypt.compare(password_en_clair, hash_en_bdd)
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword)
      return res
        .status(401)
        .json({ success: false, message: "Email ou mot de passe incorrect" });

    await query("UPDATE users SET last_login = NOW() WHERE id = ?", [user.id]);

    const payload = { id: Number(user.id), role: user.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await query(
      "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))",
      [user.id, hashToken(refreshToken)]
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 3600 * 1000,
    });

    const userData = {
      id: Number(user.id),
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      is_active: user.is_active,
      email_verified: user.email_verified,
      last_login: user.last_login,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };

    res.json({
      success: true,
      message: "Connexion réussie",
      data: { user: userData, accessToken, refreshToken },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur interne du serveur",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};

// ---------------- REFRESH TOKEN ----------------
export const refreshToken = async (req: Request, res: Response) => {
  try {
    const tokenFromCookie = req.cookies?.refreshToken;
    const tokenFromBody = req.body?.refresh_token;
    const providedToken = tokenFromCookie || tokenFromBody;

    if (!providedToken) {
      return res
        .status(400)
        .json({ success: false, message: "Refresh token requis" });
    }

    const rows: any[] = await query("SELECT * FROM refresh_tokens WHERE token_hash = ?", [
      hashToken(providedToken),
    ]);
    if (rows.length === 0) {
      return res
        .status(403)
        .json({ success: false, message: "Refresh token invalide" });
    }

    jwt.verify(
      providedToken,
      process.env.JWT_REFRESH_SECRET as string,
      async (err: any, decoded: any) => {
        if (err) {
          await query("DELETE FROM refresh_tokens WHERE token_hash = ?", [hashToken(providedToken)]);
          return res
            .status(403)
            .json({ success: false, message: "Refresh token invalide ou expiré" });
        }

        const userId = Number(decoded.id);
        const [dbUser]: any = await query(
          "SELECT id, is_active, role FROM users WHERE id = ?",
          [userId]
        );
        if (!dbUser) {
          await query("DELETE FROM refresh_tokens WHERE token_hash = ?", [hashToken(providedToken)]);
          return res
            .status(404)
            .json({ success: false, message: "Utilisateur introuvable" });
        }
        if (!dbUser.is_active) {
          await query("DELETE FROM refresh_tokens WHERE token_hash = ?", [hashToken(providedToken)]);
          return res
            .status(403)
            .json({ success: false, message: "Compte utilisateur désactivé" });
        }

        await query("DELETE FROM refresh_tokens WHERE token_hash = ?", [hashToken(providedToken)]);

        const newPayload = { id: userId, role: dbUser.role };
        const newAccessToken = signAccessToken(newPayload);
        const newRefreshToken = signRefreshToken(newPayload);

        await query(
          "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))",
          [userId, hashToken(newRefreshToken)]
        );

        res.cookie("refreshToken", newRefreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 7 * 24 * 3600 * 1000,
        });

        return res.json({ success: true, data: { accessToken: newAccessToken } });
      }
    );
  } catch (error) {
    console.error("Refresh token error:", error);
    res
      .status(500)
      .json({ success: false, message: "Erreur lors du rafraîchissement du token" });
  }
};

// ---------------- LOGOUT ----------------
export const logout = async (req: Request, res: Response) => {
  try {
    const tokenFromCookie = req.cookies?.refreshToken;
    const tokenFromBody = req.body?.refresh_token;
    const providedToken = tokenFromCookie || tokenFromBody;

    if (providedToken) {
      await query("DELETE FROM refresh_tokens WHERE token_hash = ?", [hashToken(providedToken)]);
    }

    res.clearCookie("refreshToken", { httpOnly: true, sameSite: "lax" });
    res.json({ success: true, message: "Déconnecté avec succès" });
  } catch (error) {
    console.error("Logout error:", error);
    res
      .status(500)
      .json({ success: false, message: "Erreur lors de la déconnexion" });
  }
};

// ---------------- GET CURRENT USER ----------------
export const getCurrentUser = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId)
      return res
        .status(401)
        .json({ success: false, message: "Utilisateur non authentifié" });

    const [userProfile]: any = await query(
      `SELECT 
        u.id, u.email, u.first_name, u.last_name, u.role, 
        u.is_active, u.email_verified, u.last_login, u.created_at, u.updated_at,
        up.bio, up.job_title, up.company, up.skills, 
        up.github_url, up.linkedin_url, up.avatar_url, up.country, up.timezone
      FROM users u 
      LEFT JOIN user_profiles up ON u.id = up.user_id 
      WHERE u.id = ?`,
      [userId]
    );

    if (!userProfile)
      return res
        .status(404)
        .json({ success: false, message: "Utilisateur non trouvé" });

    delete userProfile.password_hash;

    res.json({ success: true, data: { ...userProfile, id: Number(userProfile.id) } });
  } catch (error) {
    console.error("Get current user error:", error);
    res.status(500).json({
      success: false,
      message: "Erreur interne du serveur",
      error:
        process.env.NODE_ENV === "development"
          ? (error as Error).message
          : undefined,
    });
  }
};

// ---------------- DASHBOARD ----------------
export const getDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Utilisateur non authentifié",
      });
    }

    const [userData]: any = await query(
      `SELECT 
        (SELECT COUNT(*) FROM course_enrollments WHERE user_id = ?) as enrolled_courses,
        (SELECT COUNT(*) FROM lesson_progress WHERE user_id = ? AND completed = 1) as completed_lessons,
        (SELECT COUNT(DISTINCT course_id) FROM course_enrollments WHERE user_id = ? AND status = 'completed') as completed_courses`,
      [userId, userId, userId]
    );

    const recentCourses: any[] = await query(
      `SELECT c.id, c.title, c.slug, c.thumbnail_url, c.level, c.duration_hours,
              e.enrolled_at, e.status, e.progress_percent
       FROM course_enrollments e
       JOIN courses c ON e.course_id = c.id
       WHERE e.user_id = ?
       ORDER BY e.enrolled_at DESC
       LIMIT 5`,
      [userId]
    );

    res.json({
      success: true,
      data: {
        user: req.user,
        stats: {
          enrolledCourses: userData?.enrolled_courses || 0,
          completedLessons: userData?.completed_lessons || 0,
          completedCourses: userData?.completed_courses || 0,
        },
        recentCourses: recentCourses || [],
        quickActions: [
          { label: "Continuer mon apprentissage", action: "/api/courses/my-courses" },
          { label: "Explorer les cours", action: "/api/courses" },
          { label: "Voir mon profil", action: "/api/profile" },
        ],
      },
    });
  } catch (error) {
    console.error("Erreur dashboard:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération du dashboard",
    });
  }
};


// ═══════════════════════════════════════════════════════
// GET /api/auth/verify-email/:token
// Active le compte après clic sur le lien email
// ═══════════════════════════════════════════════════════
export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ success: false, message: "Token manquant" });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [user]: any = await query(
      `SELECT id, first_name, email, email_verified, verification_token_expires
       FROM users
       WHERE verification_token = ? AND is_active = FALSE
       LIMIT 1`,
      [tokenHash]
    );

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Lien invalide ou déjà utilisé.",
      });
    }

    // Vérifier expiration (24h)
    if (user.verification_token_expires && new Date(user.verification_token_expires) < new Date()) {
      return res.status(400).json({
        success: false,
        message: "Ce lien a expiré. Demandez un nouveau lien de vérification.",
      });
    }

    // Activer le compte
    await query(
      `UPDATE users
       SET is_active = TRUE, email_verified = TRUE,
           verification_token = NULL, verification_token_expires = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [user.id]
    );

    // Email de bienvenue après activation
    await sendWelcomeEmail(user.email, user.first_name)
      .catch(e => console.warn("Email bienvenue:", e.message));

    return res.json({
      success: true,
      message: "Compte activé avec succès ! Vous pouvez maintenant vous connecter.",
    });
  } catch (error) {
    console.error("verifyEmail error:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═══════════════════════════════════════════════════════
// POST /api/auth/resend-verification
// Renvoie l'email de vérification
// ═══════════════════════════════════════════════════════
export const resendVerification = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email requis" });
    }

    const OK = { success: true, message: "Si un compte non vérifié existe, un email a été envoyé." };

    const [user]: any = await query(
      "SELECT id, first_name, email, is_active, email_verified FROM users WHERE email = ? LIMIT 1",
      [email.toLowerCase().trim()]
    );

    if (!user || user.email_verified || user.is_active) {
      return res.json(OK); // Ne pas révéler
    }

    // Nouveau token
    const newToken     = crypto.randomBytes(32).toString("hex");
    const newTokenHash = crypto.createHash("sha256").update(newToken).digest("hex");
    const newExpires   = new Date(Date.now() + 24 * 3600 * 1000);

    await query(
      `UPDATE users SET verification_token = ?, verification_token_expires = ? WHERE id = ?`,
      [newTokenHash, newExpires.toISOString().slice(0, 19).replace("T", " "), user.id]
    );

const verifyUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/verify-email/${newToken}`;

await sendEmail({
  to: user.email,
  subject: "Activez votre compte DevOpsAkademy",
  html: `<p>Bonjour <strong>${user.first_name}</strong>,</p>
         <p>
           <a href="${verifyUrl}" 
              style="background:#2d287f;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">
              ✅ Activer mon compte
           </a>
         </p>
         <p style="color:#888;font-size:12px;">Expire dans 24h.</p>`,
}).catch(e => console.warn("Resend verification:", e.message));

    return res.json(OK);
  } catch (error) {
    console.error("resendVerification error:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═══════════════════════════════════════════════════════
// POST /api/auth/forgot-password
// Envoie un lien de réinitialisation par email (30 min)
// ═══════════════════════════════════════════════════════
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@")) {
      return res.status(400).json({ success: false, message: "Email invalide" });
    }

    // Réponse générique → ne révèle pas si l'email existe
    const OK = { success: true, message: "Si un compte existe, un email a été envoyé." };

    const [user]: any = await query(
      "SELECT id, first_name, email, is_active FROM users WHERE email = ? LIMIT 1",
      [email.toLowerCase().trim()]
    );
    if (!user || !user.is_active) return res.json(OK);

    // Supprimer les anciens tokens non utilisés
    await query(
      "DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL",
      [user.id]
    );

    // Générer token sécurisé
    const rawToken  = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    // Stocker en BDD (expire 30 min)
    await query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))`,
      [user.id, tokenHash]
    );

    // Envoyer l'email
    await sendPasswordResetEmail(user.email, user.first_name, rawToken)
      .catch(e => console.warn("⚠️ Email reset (non bloquant):", e.message));

    return res.json(OK);
  } catch (error) {
    console.error("forgotPassword error:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ═══════════════════════════════════════════════════════
// POST /api/auth/reset-password
// Valide le token et change le mot de passe
// ═══════════════════════════════════════════════════════
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, message: "Token et mot de passe requis" });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Minimum 8 caractères requis" });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Vérifier le token (non utilisé + non expiré)
    const [row]: any = await query(
      `SELECT pr.id, pr.user_id, u.email, u.first_name
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash = ?
         AND pr.used_at IS NULL
         AND pr.expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );

    if (!row) {
      return res.status(400).json({
        success: false,
        message: "Lien invalide ou expiré. Refaites une demande.",
      });
    }

    // Mettre à jour le mot de passe
    const newHash = await bcrypt.hash(password, 12);
    await query(
      "UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?",
      [newHash, row.user_id]
    );

    // Invalider le token
    await query("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [row.id]);

    // Invalider toutes les sessions actives
    await query("DELETE FROM refresh_tokens WHERE user_id = ?", [row.user_id]).catch(() => {});

    // Email de confirmation
    await sendEmail({
      to: row.email,
      subject: "Mot de passe modifié — DevOpsAkademy",
      html: `<p>Bonjour <strong>${row.first_name}</strong>,</p>
             <p>Votre mot de passe a été modifié avec succès.</p>
             <p>Si ce n'est pas vous, contactez-nous à support@devopsakademy.com</p>
             <p>— L'équipe DevOpsAkademy</p>`,
    }).catch(e => console.warn("Email confirm reset:", e.message));

    return res.json({ success: true, message: "Mot de passe mis à jour." });
  } catch (error) {
    console.error("resetPassword error:", error);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ============================================================
// PATCH authController.ts — Corrections flux Auth
// Applique ces changements dans src/controllers/authController.ts
// ============================================================

// ─────────────────────────────────────────────────────────────
// CORRECTIF 1 — register()
// Problème : l'API retourne accessToken même si le compte n'est
//            pas encore activé → frontend le stocke et croit
//            l'utilisateur connecté alors qu'il ne l'est pas.
// Correction : NE PLUS retourner accessToken dans register().
//              Ajouter email_verification_required:true pour que
//              le frontend sache qu'il faut attendre la vérif.
//              Ajouter email_sent:true|false pour signaler si
//              Brevo a bien envoyé l'email.
// ─────────────────────────────────────────────────────────────

// REMPLACER tout le bloc try/catch de register() par :


// ─────────────────────────────────────────────────────────────
// CORRECTIF 3 — login()
// Problème : le message "Email non vérifié" est retourné mais
//            le frontend l'affiche comme une erreur générique.
// La réponse retourne déjà email_not_verified:true — c'est bon.
// Le vrai fix est dans le frontend (voir Login.jsx patch).
// Mais on améliore ici le message et on ajoute can_resend:true.
// ─────────────────────────────────────────────────────────────

// Dans login(), remplacer le bloc is_active par :
/*
    if (!user.is_active) {
      if (!user.email_verified) {
        return res.status(403).json({
          success: false,
          message: "Votre email n'est pas encore vérifié. Consultez votre boîte email ou cliquez sur « Renvoyer l'email ».",
          email_not_verified: true,
          can_resend: true,          // ✅ AJOUT — flag explicite
          email: user.email,
        });
      }
      return res.status(403).json({
        success: false,
        message: "Compte désactivé. Contactez l'administration.",
      });
    }
*/

// ─────────────────────────────────────────────────────────────
// HELPER — Template email de vérification (extraire dans mail.service.ts)
// ─────────────────────────────────────────────────────────────

function buildVerificationEmail(firstName: string, verifyUrl: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f4f3fb;padding:20px;">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(45,40,127,0.1);">
  <div style="background:linear-gradient(135deg,#2d287f,#5653e1);padding:28px 32px;text-align:center;">
    <p style="margin:0;color:#facc15;font-size:20px;font-weight:900;">DevOps Akademy</p>
  </div>
  <div style="padding:32px;">
    <h2 style="color:#2d287f;margin:0 0 12px;">Bonjour ${firstName} 👋</h2>
    <p style="color:#555;font-size:15px;">Votre compte a été créé avec succès.<br/>
    Cliquez sur le bouton ci-dessous pour activer votre compte :</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${verifyUrl}"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        ✅ Activer mon compte
      </a>
    </div>
    <p style="color:#888;font-size:13px;text-align:center;">
      Ce lien expire dans <strong>24 heures</strong>.<br/>
      Si vous n'avez pas créé ce compte, ignorez cet email.
    </p>
  </div>
</div>
</body>
</html>`;
}

// ✅ Export par défaut
export default {
  register,
  login,
  logout,
  refreshToken,
  getCurrentUser,
  getDashboard,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
};