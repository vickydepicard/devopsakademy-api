// src/controllers/authController.ts
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendEmail } from '../services/mail.service';
import { query } from "../config/database";

const ACCESS_TOKEN_EXPIRY = "15m"; // access token court
const REFRESH_TOKEN_EXPIRY = "7d"; // refresh token long

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

    const existingUsers = await query("SELECT id FROM users WHERE email = ?", [
      email,
    ]);
    if (existingUsers.length > 0)
      return res
        .status(400)
        .json({ success: false, message: "Un utilisateur avec cet email existe déjà" });

    const passwordHash = await bcrypt.hash(password, 12);

    const insertResult: any = await query(
      "INSERT INTO users (email, password_hash, first_name, last_name, role, is_active) VALUES (?, ?, ?, ?, ?, TRUE)",
      [email, passwordHash, first_name, last_name, role]
    );

    const userId = Number(insertResult.insertId);

    await query(
      "INSERT INTO user_profiles (user_id, created_at, updated_at) VALUES (?, NOW(), NOW())",
      [userId]
    );

    const accessToken = signAccessToken({ id: userId, role });
    const refreshToken = signRefreshToken({ id: userId, role });

    await query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))",
      [userId, refreshToken]
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 3600 * 1000,
    });

        /* =====================================================
       📧 ENVOI EMAIL DE BIENVENUE (NON BLOQUANT)
    ===================================================== */
    try {
      await sendEmail({
        to: email,
        subject: "Bienvenue sur DevOpsAkademy 🚀",
        html: `
          <h2>Bienvenue ${first_name} 👋</h2>
          <p>Votre compte <b>DevOpsAkademy</b> a été créé avec succès.</p>
          <p><b>Email :</b> ${email}</p>
          <p>Vous pouvez maintenant vous connecter à la plateforme.</p>
          <br/>
          <p>— L'équipe DevOpsAkademy</p>
        `,
      });
    } catch (mailError) {
      console.error("MAIL REGISTER ERROR:", mailError);
      // ❗ Ne jamais bloquer l'inscription si le mail échoue
    }

    res.status(201).json({
      success: true,
      message: "Utilisateur créé avec succès",
      data: {
        user: { id: userId, email, first_name, last_name, role },
        accessToken,
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
    const { email, password } = req.body;
    if (!email || !email.includes("@"))
      return res.status(400).json({ success: false, message: "Email invalide" });
    if (!password)
      return res.status(400).json({ success: false, message: "Mot de passe requis" });

    const users: any[] = await query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0)
      return res
        .status(401)
        .json({ success: false, message: "Email ou mot de passe incorrect" });

    const user = users[0];
    if (!user.is_active)
      return res
        .status(403)
        .json({ success: false, message: "Compte désactivé" });

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
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))",
      [user.id, refreshToken]
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
      data: { user: userData, accessToken },
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

    const rows: any[] = await query("SELECT * FROM refresh_tokens WHERE token = ?", [
      providedToken,
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
          await query("DELETE FROM refresh_tokens WHERE token = ?", [providedToken]);
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
          await query("DELETE FROM refresh_tokens WHERE token = ?", [providedToken]);
          return res
            .status(404)
            .json({ success: false, message: "Utilisateur introuvable" });
        }
        if (!dbUser.is_active) {
          await query("DELETE FROM refresh_tokens WHERE token = ?", [providedToken]);
          return res
            .status(403)
            .json({ success: false, message: "Compte utilisateur désactivé" });
        }

        await query("DELETE FROM refresh_tokens WHERE token = ?", [providedToken]);

        const newPayload = { id: userId, role: dbUser.role };
        const newAccessToken = signAccessToken(newPayload);
        const newRefreshToken = signRefreshToken(newPayload);

        await query(
          "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))",
          [userId, newRefreshToken]
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
      await query("DELETE FROM refresh_tokens WHERE token = ?", [providedToken]);
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

// ✅ Export par défaut pour éviter les erreurs d’import
export default {
  register,
  login,
  logout,
  refreshToken,
  getCurrentUser,
};

