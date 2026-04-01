// src/routes/instructor-courses.routes.ts
// Cours filtrés par instructeur connecté

import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { requireInstructorOrAdmin } from "../middleware/permissions";
import courseController from "../controllers/courseController";

const router = Router();

// GET /stats → statistiques de l'instructeur
router.get("/stats", authenticate, requireInstructorOrAdmin, courseController.getInstructorStats);

// GET → uniquement les cours de l'instructeur connecté (WHERE instructor_id = user.id)
router.get("/",    authenticate, requireInstructorOrAdmin, courseController.getInstructorCourses);

// POST → créer un cours (instructor_id = user.id automatiquement)
router.post("/",   authenticate, requireInstructorOrAdmin, courseController.createCourse);

// GET/PATCH/DELETE par id (vérifie ownership dans le controller)
router.get("/:id",    authenticate, requireInstructorOrAdmin, courseController.getCourseById);
router.patch("/:id",  authenticate, requireInstructorOrAdmin, courseController.updateCourse);
router.delete("/:id", authenticate, requireInstructorOrAdmin, courseController.deleteCourse);

export default router;