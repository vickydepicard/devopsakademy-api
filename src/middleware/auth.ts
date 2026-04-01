// src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { query } from "../config/database";

// ✅ Étend Request pour avoir req.user
export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    role: string;
    email?: string;
    first_name?: string;
    last_name?: string;
  };
}

// ================= AUTHENTICATION =================
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers["authorization"];
  console.log("🔑 Auth header reçu:", authHeader);

  // Vérifie que le header existe et commence par "Bearer "
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ success: false, message: "No token provided" });
  }

  const token = authHeader.split(" ")[1]; // format: Bearer TOKEN
  console.log("📦 Token extrait:", token);

  try {
    // ✅ Vérification du JWT
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);
    console.log("✅ Token décodé:", decoded);

    // 🔍 Vérifier que l’utilisateur existe et est actif
    const [userRow]: any = await query(
      "SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = ?",
      [decoded.id]
    );

    if (!userRow) {
      return res
        .status(401)
        .json({ success: false, message: "Utilisateur introuvable" });
    }
    if (!userRow.is_active) {
      return res
        .status(403)
        .json({ success: false, message: "Compte désactivé" });
    }

    // ✅ Injecter user dans req
    req.user = {
      id: Number(userRow.id),
      role: userRow.role,
      email: userRow.email,
      first_name: userRow.first_name,
      last_name: userRow.last_name,
    };

    next();
  } catch (error) {
    console.error("❌ JWT verification error:", error);
    return res
      .status(403)
      .json({ success: false, message: "Invalid or expired token" });
  }
};

// ================= AUTHORIZATION =================

// ── authenticateAllowInactive ─────────────────────────────
// Valide le JWT sans vérifier is_active
// Utilisé pour la soumission de candidature instructeur
// juste après inscription (compte pas encore activé)
export const authenticateAllowInactive = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);
    const [userRow]: any = await query(
      "SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = ?",
      [decoded.id]
    );
    if (!userRow) {
      return res.status(401).json({ success: false, message: "Utilisateur introuvable" });
    }
    // ✅ On ne bloque PAS les comptes inactifs ici
    req.user = {
      id: Number(userRow.id),
      role: userRow.role,
      email: userRow.email,
      first_name: userRow.first_name,
      last_name: userRow.last_name,
    };
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Token invalide ou expiré" });
  }
};

export const authorizeRoles = (roles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    }

    if (!roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ success: false, message: "Insufficient permissions" });
    }

    next();
  };
};