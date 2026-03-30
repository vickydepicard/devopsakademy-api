// src/routes/instructor.routes.ts
import { Router } from "express";
import { requireAuth, authorizeRoles } from "../middleware/permissions";

import {
  submitInstructorApplication,
  getMyInstructorApplication,
  getAllInstructorApplications,
  approveInstructorApplication,
  rejectInstructorApplication,
  getInstructorApplicationById,
} from "../controllers/instructorController";

const router = Router();

// ================= STUDENT / INSTRUCTOR =================

// Soumettre une candidature
router.post(
  "/",
  requireAuth,
  authorizeRoles("student", "instructor"),
  submitInstructorApplication
);

// Voir sa candidature
router.get(
  "/my",
  requireAuth,
  getMyInstructorApplication
);

// ================= ADMIN =================

// Liste toutes les candidatures
router.get(
  "/",
  requireAuth,
  authorizeRoles("admin", "superadmin"),
  getAllInstructorApplications
);

// Détail d'une candidature
router.get(
  "/:id",
  requireAuth,
  authorizeRoles("admin", "superadmin"),
  getInstructorApplicationById
);

// Approuver
router.patch(
  "/:id/approve",
  requireAuth,
  authorizeRoles("admin", "superadmin"),
  approveInstructorApplication
);

// Rejeter
router.patch(
  "/:id/reject",
  requireAuth,
  authorizeRoles("admin", "superadmin"),
  rejectInstructorApplication
);

export default router;