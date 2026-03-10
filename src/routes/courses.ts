import express from "express";
import courseController from "../controllers/courseController";
import {
  allowVisitors,
  requireAuth,
  requireEnrollment,
  requireInstructorOrAdmin
} from "../middleware/permissions";

const router = express.Router();

// ========================
// ✅ ROUTES PUBLIQUES (VISITEURS)
// ========================
router.get("/", allowVisitors, courseController.getCourses);
router.get("/popular", allowVisitors, courseController.getPopularCourses);
router.get("/filters", allowVisitors, courseController.getCourseFilters);
router.get("/public/:id", allowVisitors, courseController.getCoursePublic);

// ========================
// ✅ DÉTAILS DU COURS (2 VERSIONS)
// ========================
router.get("/:id", allowVisitors, courseController.getCourseById);
router.get("/:id/details", requireAuth, courseController.getCourseByIdEnhanced);

// ========================
// ✅ INSCRIPTION AU COURS (CONNECTÉ)
// ========================
router.post("/:id/enroll", requireAuth, courseController.enrollCourse);

// ========================
// ✅ CONTENU DU COURS (INSCRIT)
// ========================
router.get("/:id/learn", requireAuth, requireEnrollment, courseController.getCourseContent);

// ========================
// ✅ MODULES + LEÇONS — ROUTE AJOUTÉE
// ========================
router.get("/:id/modules", requireAuth, requireEnrollment, courseController.getCourseModules);

// ========================
// ✅ PROGRESSION — ROUTE AJOUTÉE
// ========================
router.get("/:id/progress", requireAuth, courseController.getCourseProgressForUser);

// ========================
// ✅ LEÇONS (INSCRIT)
// ========================
router.get("/:id/lessons/:lessonId", requireAuth, requireEnrollment, courseController.getLesson);
router.patch("/:id/lessons/:lessonId/status", requireAuth, requireEnrollment, courseController.updateLessonStatus);

// ✅ MARQUER LEÇON TERMINÉE — ROUTE AJOUTÉE
router.post("/:id/lessons/:lessonId/complete", requireAuth, requireEnrollment, courseController.completeLesson);

// ========================
// ✅ GESTION DES COURS (INSTRUCTEUR/ADMIN)
// ========================
router.post("/", requireAuth, requireInstructorOrAdmin, courseController.createCourse);
router.put("/:id", requireAuth, requireInstructorOrAdmin, courseController.updateCourse);
router.delete("/:id", requireAuth, requireInstructorOrAdmin, courseController.deleteCourse);
router.get("/:id/students", requireAuth, requireInstructorOrAdmin, courseController.getCourseStudents);

export default router;