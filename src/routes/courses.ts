import express from "express";
import {
  createCourse,
  getCourses,
  getCourseById,
  getCoursePublic,
  updateCourse,
  deleteCourse,
  getCourseStudents,
  getCourseFilters,
  updateLessonStatus,
  getLessonById,
  getPopularCourses,
  getCoursePreview
} from "../controllers/courseController";
import { authenticate, authorizeRoles } from "../middleware/auth";

const router = express.Router();

// ========================
// ✅ ROUTES PUBLIQUES
// ========================
router.get("/popular", getPopularCourses);
router.get("/filters", getCourseFilters);
router.get("/", getCourses);
router.get("/public/:id", getCoursePublic); // 👈 accessible sans login
router.get("/:id", authenticate, getCourseById); // accès complet si connecté

// ========================
// ✅ ROUTES PROTÉGÉES (ADMIN / FORMATEUR)
// ========================
router.post("/", authenticate, authorizeRoles(["instructor", "admin"]), createCourse);
router.put("/:id", authenticate, authorizeRoles(["instructor", "admin"]), updateCourse);
router.delete("/:id", authenticate, authorizeRoles(["instructor", "admin"]), deleteCourse);

// ========================
// ✅ ÉTUDIANTS PAR COURS
// ========================
router.get(
  "/:id/students",
  authenticate,
  authorizeRoles(["instructor", "admin"]),
  getCourseStudents
);

router.get("/:id/public", getCoursePreview);


// ========================
// ✅ LEÇONS (étudiant connecté)
// ========================
router.patch("/:courseId/lessons/:lessonId/status", authenticate, updateLessonStatus);
router.get("/:courseId/lessons/:lessonId", authenticate, getLessonById);

export default router;
