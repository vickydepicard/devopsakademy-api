// src/routes/co-instructor.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { requireInstructorOrAdmin } from "../middleware/permissions";
import {
  getCourseCoInstructors,
  addCoInstructor,
  updateCoInstructorCommission,
  removeCoInstructor,
  respondToInvitation,
  getMyInvitations,
} from "../controllers/coInstructorController";

const router = Router();

// ── Invitations de l'instructeur connecté ──
router.get("/invitations",                              authenticate, requireInstructorOrAdmin, getMyInvitations);
router.patch("/invitations/:coInstructorId/respond",   authenticate, requireInstructorOrAdmin, respondToInvitation);

// ── Co-instructeurs d'un cours (propriétaire ou admin) ──
router.get("/:courseId/co-instructors",                authenticate, getCourseCoInstructors);
router.post("/:courseId/co-instructors",               authenticate, requireInstructorOrAdmin, addCoInstructor);
router.patch("/:courseId/co-instructors/:coInstructorId", authenticate, requireInstructorOrAdmin, updateCoInstructorCommission);
router.delete("/:courseId/co-instructors/:coInstructorId", authenticate, removeCoInstructor);

export default router;