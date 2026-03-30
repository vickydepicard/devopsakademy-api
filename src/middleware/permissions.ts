import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { query } from "../config/database";
import { AuthenticatedRequest } from "./auth";

// ================= VISITEUR =================
export const allowVisitors = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  next();
};

// ================= CONNECTÉ =================
export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Accès non autorisé. Veuillez vous connecter.",
      redirectTo: "/api/auth/login",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);

    const [userRow]: any = await query(
      "SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = ?",
      [decoded.id]
    );

    if (!userRow) {
      return res.status(401).json({ success: false, message: "Utilisateur introuvable." });
    }
    if (!userRow.is_active) {
      return res.status(403).json({ success: false, message: "Compte désactivé." });
    }

    req.user = {
      id: Number(userRow.id),
      role: userRow.role,
      email: userRow.email,
      first_name: userRow.first_name,
      last_name: userRow.last_name,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Token invalide ou expiré.",
      redirectTo: "/api/auth/login",
    });
  }
};

// ================= INSCRIT À UN COURS =================
// FIX : les routes utilisent :id (ex: /courses/:id/modules)
//       et non :courseId — on résout les deux cas
export const requireEnrollment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    // ✅ Compatibilité :id ET :courseId selon la route
    const courseId = req.params.id ?? req.params.courseId;
    const userId   = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Veuillez vous connecter.",
        redirectTo: "/api/auth/login",
      });
    }

    if (!courseId) {
      return res.status(400).json({
        success: false,
        message: "ID du cours manquant.",
      });
    }

    // Admins et instructeurs du cours ont toujours accès
    if (req.user?.role === "admin") return next();

    if (req.user?.role === "instructor") {
      const [ownedCourse]: any = await query(
        "SELECT id FROM courses WHERE id = ? AND instructor_id = ?",
        [courseId, userId]
      );
      if (ownedCourse) return next();
    }

    // Vérifier l'inscription (is_approved = 1 obligatoire pour les payants,
    // les cours gratuits sont approuvés automatiquement à l'inscription)
    const [enrollment]: any = await query(
      `SELECT id, is_approved, payment_status
       FROM course_enrollments
       WHERE user_id = ? AND course_id = ?`,
      [userId, courseId]
    );

    if (!enrollment) {
      return res.status(403).json({
        success: false,
        message: "Vous devez être inscrit à ce cours pour y accéder.",
        redirectTo: `/courses/${courseId}`,
      });
    }

    if (!enrollment.is_approved) {
      return res.status(403).json({
        success: false,
        message: "Votre inscription est en attente de validation.",
        redirectTo: `/courses/${courseId}`,
        enrollment_status: enrollment.payment_status,
      });
    }

    next();
  } catch (error) {
    console.error("requireEnrollment error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la vérification de l'inscription.",
    });
  }
};

// ================= ADMIN =================
export const requireAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Veuillez vous connecter." });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Accès réservé aux administrateurs." });
  }
  next();
};

// ================= INSTRUCTEUR OU ADMIN =================
export const requireInstructorOrAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Veuillez vous connecter." });
  }
  if (req.user.role !== "instructor" && req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Accès réservé aux instructeurs ou administrateurs." });
  }
  next();
};

export const authorizeRoles = (...roles: string[]) => {
  return (req: any, res: any, next: any) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    next();
  };
};

