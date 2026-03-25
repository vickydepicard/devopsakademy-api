import express from "express";
import { authorizeRoles, authenticate } from "../middleware/auth";
import {
  // 👥 Utilisateurs
  getAllUsers, validateUser, createUser, updateUser, deleteUser,
  getUserByIdAdmin, getUserProfileAdmin,

  // 📚 Cours
  getAllCoursesAdmin, getCourseByIdAdmin, createCourseAdmin,
  updateCourseAdmin, deleteCourseAdmin, publishCourseAdmin,
  getCourseStudentsAdmin,

  // 🧩 Inscriptions
  getAllEnrollments, addEnrollment, deleteEnrollment,

  // 📊 Statistiques
  getGlobalStats, getCourseStats,

  // 🏷️ Catégories
  getAllCategories, createCategory, updateCategory, deleteCategory,

  // 📦 Modules
  getModulesByCourse, createModule, updateModule, deleteModule,
  updateModuleFull, toggleModulePublish,

  // 📖 Leçons
  getLessonsByModule, createLesson, createLessonFull,
  updateLesson, updateLessonFull, deleteLesson, toggleLessonPublish,

  // 📎 Ressources
  addLessonResource, getLessonResources,
  updateLessonResource, deleteLessonResource, deleteUploadedFile,

  // 📤 Uploads
  uploadLessonVideo, uploadLessonResource as uploadLessonResourceFile,
  uploadCourseThumbnail, uploadVideo, uploadResource, uploadThumb,

  // 👨‍🏫 Instructeurs
  getAllInstructors, createInstructor, updateInstructor, deleteInstructor,
} from "../controllers/adminController";
import {
  approveEnrollmentById,
  rejectEnrollmentById,
  getEnrollmentsByUser,
} from "../controllers/enrollmentController";

const router = express.Router();
router.use(authenticate, authorizeRoles(["admin"]));

/* ─── UTILISATEURS ─── */
router.get("/users", getAllUsers);
router.post("/users", createUser);
router.put("/users/:userId", updateUser);
router.delete("/users/:userId", deleteUser);
router.patch("/users/:userId/validate", validateUser);
router.get("/users/:id/profile", getUserProfileAdmin);
router.get("/users/:id", getUserByIdAdmin);

/* ─── COURS ─────────────────────────────────────────────────
   ⚠️  Routes spécifiques AVANT /:id générique (sinon conflit Express)
──────────────────────────────────────────────────────────── */
router.get("/courses",     getAllCoursesAdmin);
router.post("/courses",    createCourseAdmin);

// Sous-routes spécifiques EN PREMIER
router.get   ("/courses/:courseId/modules",   getModulesByCourse);
router.get   ("/courses/:id/students",        getCourseStudentsAdmin);
router.patch ("/courses/:id/publish",         publishCourseAdmin);
router.post  ("/courses/:courseId/thumbnail", uploadThumb.single("thumbnail"), uploadCourseThumbnail);

// /:id générique EN DERNIER
router.get   ("/courses/:id",   getCourseByIdAdmin);
router.patch ("/courses/:id",   updateCourseAdmin);
router.delete("/courses/:id",   deleteCourseAdmin);

/* ─── MODULES ─── */
router.post  ("/modules",              createModule);
router.patch ("/modules/:id",          updateModuleFull);
router.patch ("/modules/:id/publish",  toggleModulePublish);   // ← NOUVEAU
router.delete("/modules/:id",          deleteModule);

/* ─── LEÇONS ─── */
// ⚠️  /lessons/resources AVANT /lessons/:id
router.post("/lessons/resources",            addLessonResource);
router.get ("/modules/:moduleId/lessons",    getLessonsByModule);
router.post("/lessons",                      createLessonFull);
router.patch("/lessons/:id",                 updateLessonFull);
router.patch("/lessons/:id/publish",         toggleLessonPublish);  // ← NOUVEAU
router.delete("/lessons/:id",                deleteLesson);

/* ─── UPLOADS FICHIERS ─────────────────────────────────────
   POST multipart/form-data — champ "video" ou "file"
──────────────────────────────────────────────────────────── */
// Uploader une vidéo directement depuis l'ordi → associée à la leçon
router.post("/lessons/:lessonId/upload-video",    uploadVideo.single("video"),    uploadLessonVideo);
// Uploader un fichier comme ressource de leçon (PDF, ZIP, PPTX…)
router.post("/lessons/:lessonId/upload-resource", uploadResource.single("file"),  uploadLessonResourceFile);

/* ─── RESSOURCES ─── */
router.get   ("/lessons/:lessonId/resources", getLessonResources);
router.patch ("/lesson-resources/:id",        updateLessonResource);
router.delete("/lesson-resources/:id",        deleteUploadedFile);   // ← supprime aussi le fichier disque

/* ─── CATÉGORIES ─── */
router.get   ("/categories",       getAllCategories);
router.post  ("/categories",       createCategory);
router.patch ("/categories/:id",   updateCategory);
router.delete("/categories/:id",   deleteCategory);

/* ─── INSTRUCTEURS ─── */
router.get   ("/instructors",        getAllInstructors);
router.post  ("/instructors",        createInstructor);
router.put   ("/instructors/:id",    updateInstructor);
router.delete("/instructors/:id",    deleteInstructor);

/* ─── INSCRIPTIONS ─── */
router.get   ("/enrollments",                       getAllEnrollments);
router.post  ("/enrollments",                       addEnrollment);
router.get   ("/enrollments/user/:userId",          getEnrollmentsByUser);
router.delete("/enrollments/:enrollmentId",         deleteEnrollment);
// ✅ Approuver/Rejeter par enrollment.id
router.patch ("/enrollments/:id/approve",           approveEnrollmentById);
router.patch ("/enrollments/:id/reject",            rejectEnrollmentById);
// ✅ Inscriptions d'un étudiant spécifique

/* ─── STATISTIQUES ─── */
router.get("/stats",         getGlobalStats);
router.get("/stats/courses", getCourseStats);

export default router;