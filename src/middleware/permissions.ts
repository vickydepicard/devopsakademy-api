import { getCourseAccess } from "../utils/courseAccess";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { query } from "../config/database";
import { AuthenticatedRequest } from "./auth";
import { tr } from "../utils/lang";

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
      message: tr(req, "Accès non autorisé. Veuillez vous connecter.", "Unauthorized access. Please log in."),
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
      return res.status(401).json({ success: false, message: tr(req, "Utilisateur introuvable.", "User not found.") });
    }
    if (!userRow.is_active) {
      return res.status(403).json({ success: false, message: tr(req, "Compte désactivé.", "Account disabled.") });
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
      message: tr(req, "Token invalide ou expiré.", "Invalid or expired token."),
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
    // Compatibilité :id ET :courseId selon la route
    const courseId = req.params.id ?? req.params.courseId;
    const userId   = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: tr(req, "Veuillez vous connecter.", "Please log in."),
        redirectTo: "/api/auth/login",
      });
    }

    if (!courseId) {
      return res.status(400).json({
        success: false,
        message: tr(req, "ID du cours manquant.", "Missing course ID."),
      });
    }

    // Mode enseignant : admin, auteur et intervenants du cours ouvrent le cours sans inscription
    // (aucune progression n'est enregistrée pour eux).
    if (req.user?.role === "admin" || req.user?.role === "superadmin" || req.user?.role === "instructor") {
      const access = await getCourseAccess({ id: userId, role: req.user.role }, Number(courseId));
      if (access.canView) { (req as any).teacherMode = true; return next(); }
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
        message: tr(req, "Vous devez être inscrit à ce cours pour y accéder.", "You must be enrolled in this course to access it."),
        redirectTo: `/courses/${courseId}`,
      });
    }

    // Cours gratuit OU payment_status=verified → accès même si is_approved=0 (bug historique)
    const isAccessGranted = enrollment.is_approved === 1
      || enrollment.payment_status === 'verified'
      || enrollment.payment_status === 'free';

    if (!isAccessGranted) {
      return res.status(403).json({
        success: false,
        message: tr(req, "Votre inscription est en attente de validation.", "Your enrollment is awaiting approval."),
        redirectTo: `/courses/${courseId}`,
        enrollment_status: enrollment.payment_status,
      });
    }

    next();
  } catch (error) {
    console.error("requireEnrollment error:", error);
    return res.status(500).json({
      success: false,
      message: tr(req, "Erreur lors de la vérification de l'inscription.", "Error while checking the enrollment."),
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
    return res.status(401).json({ success: false, message: tr(req, "Veuillez vous connecter.", "Please log in.") });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: tr(req, "Accès réservé aux administrateurs.", "Access reserved for administrators.") });
  }
  next();
};

// ================= INSTRUCTEUR OU ADMIN =================
export const requireInstructorOrAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: tr(req, "Veuillez vous connecter.", "Please log in.") });
  }

  // Admin → accès total
  if (req.user.role === "admin" || req.user.role === "superadmin") {
    return next();
  }

  // Instructeur → vérifier candidature acceptée
  if (req.user.role === "instructor") {
    try {
      const [app]: any = await query(
        "SELECT status FROM instructor_applications WHERE user_id = ? AND status = 'accepted' LIMIT 1",
        [req.user.id]
      );
      if (app) return next();
      return res.status(403).json({
        success: false,
        message: tr(req, "Votre candidature instructeur n'a pas encore été validée.", "Your instructor application has not been approved yet."),
        code: "APPLICATION_NOT_APPROVED",
      });
    } catch (error) {
      // Fail-closed : en cas d'erreur base de données on refuse, on ne laisse jamais passer.
      console.error("requireInstructorOrAdmin:", (error as Error)?.message);
      return res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
    }
  }

  return res.status(403).json({
    success: false,
    message: tr(req, "Accès réservé aux instructeurs ou administrateurs.", "Access reserved for instructors or administrators."),
  });
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