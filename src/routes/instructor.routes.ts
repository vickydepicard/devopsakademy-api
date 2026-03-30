// src/routes/instructor.routes.ts
import { Router } from "express";
import { authenticate, authorizeRoles } from "../middleware/auth";
import { requireAuth } from "../middleware/permissions";
import {
  submitInstructorApplication,
  getMyInstructorApplication,
  getAllInstructorApplications,
  approveInstructorApplication,
  rejectInstructorApplication,
  getInstructorApplicationById,
} from "../controllers/instructorController";

const router = Router();

// ── Étudiant : soumettre / voir sa candidature ──
router.post("/",
  authenticate,
  authorizeRoles(["student", "instructor"]),
  submitInstructorApplication
);

router.get("/my",
  authenticate,
  getMyInstructorApplication
);

// ── Admin : gérer toutes les candidatures ──
router.get("/",
  authenticate,
  authorizeRoles(["admin", "superadmin"]),
  getAllInstructorApplications
);

router.get("/:id",
  authenticate,
  authorizeRoles(["admin", "superadmin"]),
  getInstructorApplicationById
);

router.patch("/:id/approve",
  authenticate,
  authorizeRoles(["admin", "superadmin"]),
  approveInstructorApplication
);

router.patch("/:id/reject",
  authenticate,
  authorizeRoles(["admin", "superadmin"]),
  rejectInstructorApplication
);

export default router;