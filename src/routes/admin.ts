import express from "express";
import { authorizeRoles, authenticate } from "../middleware/auth";
import {
  // 👥 Utilisateurs
  getAllUsers,
  validateUser,
  createUser,
  updateUser,
  deleteUser,

  // 📚 Cours
  getAllCourses,
  createCourse,
  updateCourse,
  deleteCourse,

  // 🧩 Inscriptions
  getAllEnrollments,
  addEnrollment,
  deleteEnrollment,

  // 📊 Statistiques
  getGlobalStats,
  getCourseStats,

  // ⚙️ Gestion avancée des cours (admin complet)
  getAllCoursesAdmin,
  getCourseByIdAdmin,
  createCourseAdmin,
  updateCourseAdmin,
  deleteCourseAdmin,
  publishCourseAdmin,
  getCourseStudentsAdmin,
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getModulesByCourse,
  createModule,
  updateModule,
  deleteModule,
  getLessonsByModule,
  createLesson,
  addLessonResource,
  updateLesson,
  deleteLesson,
  getAllInstructors,
  createInstructor,
  updateInstructor,
  deleteInstructor,
  getUserProfileAdmin,
  getUserByIdAdmin
} from "../controllers/adminController";

const router = express.Router();

// Auth obligatoire + rôle admin
/**
 * @openapi
 * /api/admin/dashboard:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Accès dashboard admin
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *       403:
 *         description: Accès refusé
 */

router.use(authenticate, authorizeRoles(["admin"]));

/**
 * =============================
 * 👥 UTILISATEURS
 * =============================
 */
router.get("/users", getAllUsers);
router.post("/users", createUser);
router.put("/users/:userId", updateUser);
router.delete("/users/:userId", deleteUser);
router.patch("/users/:userId/validate", validateUser);
router.get("/users/:id", getUserByIdAdmin); 

/**
 * =============================
 * 📚 COURS
 * =============================
 */
router.get("/courses", getAllCoursesAdmin);
router.post("/courses", createCourseAdmin);
router.patch("/courses/:id", updateCourseAdmin);
router.put("/courses/:courseId", updateCourseAdmin);
router.delete("/courses/:id", deleteCourseAdmin);
router.delete("/courses/:courseId", deleteCourseAdmin);
router.get("/courses/:id", getCourseByIdAdmin);
router.patch("/courses/:id/publish", publishCourseAdmin);

/**
 * =============================
 * 🧩 INSCRIPTIONS
 * =============================
 */
router.get("/enrollments", getAllEnrollments);
router.post("/enrollments", addEnrollment);
router.delete("/enrollments/:enrollmentId", deleteEnrollment);

/**
 * =============================
 * 📊 STATISTIQUES
 * =============================
 */
router.get("/stats", getGlobalStats);
router.get("/stats/courses", getCourseStats);

/**
 * =============================
 * ⚙️ ADMIN AVANCÉ (FULL CRUD)
 * =============================
 */
router.get("/admin-courses", getAllCoursesAdmin);
router.get("/admin-courses/:id", getCourseByIdAdmin);
router.post("/admin-courses", createCourseAdmin);
router.patch("/admin-courses/:id", updateCourseAdmin);
router.delete("/admin-courses/:id", deleteCourseAdmin);
router.patch("/admin-courses/:id/publish", publishCourseAdmin);
router.get("/admin-courses/:id/students", getCourseStudentsAdmin);


// Catégories
router.get("/categories", getAllCategories);
router.post("/categories", createCategory);
router.patch("/categories/:id", updateCategory);
router.delete("/categories/:id", deleteCategory);

// Modules
router.get("/courses/:courseId/modules", getModulesByCourse);
router.post("/modules", createModule);
router.patch("/modules/:id", updateModule);
router.delete("/modules/:id", deleteModule);

// Leçons
router.get("/modules/:moduleId/lessons", getLessonsByModule);
router.post("/lessons", createLesson);
router.patch("/lessons/:id", updateLesson);
router.delete("/lessons/:id", deleteLesson);
router.post("/lessons/resources", addLessonResource);

router.get("/instructors", getAllInstructors);
router.post("/instructors", createInstructor);
router.put("/instructors/:id", updateInstructor);
router.delete("/instructors/:id", deleteInstructor);

router.get("/users/:id/profile", getUserProfileAdmin);

export default router;