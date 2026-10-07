// src/routes/instructorPortal.routes.ts — monté sur /api/instructor
// Avant : /api/instructor pointait vers le routeur ADMIN (403 pour tout instructeur).
import { Router } from "express";
import { authenticate, authorizeRoles } from "../middleware/auth";
import { requireInstructorOrAdmin } from "../middleware/permissions";
import { uploadVideo, uploadResource, uploadThumb } from "../controllers/adminController";
import * as portal from "../controllers/instructorPortalController";
import {
  getCourseCoInstructors, addCoInstructor, updateCoInstructorCommission,
  removeCoInstructor, respondToInvitation, getMyInvitations,
} from "../controllers/coInstructorController";

const router = Router();
const adminOnly = authorizeRoles(["admin", "superadmin"]);
const { guardCourse, guardModule, guardLesson, guardQuiz, guardQuestion, guardResource, guardSubmission } = portal;

router.use(authenticate, requireInstructorOrAdmin);

// ── Vue d'ensemble ──
router.get("/stats", portal.getStats);
router.get("/earnings", portal.getEarnings);
router.get("/colleagues", portal.searchColleagues);

// ── Invitations co-instructeur ──
router.get("/invitations", getMyInvitations);
router.patch("/invitations/:coInstructorId/respond", respondToInvitation);

// ── Cours ──
router.get("/courses", portal.listCourses);
router.post("/courses", portal.createCourse);
router.get("/courses/:id", guardCourse("view"), portal.getCourse);
router.patch("/courses/:id", guardCourse("edit"), portal.updateCourse);
router.post("/courses/:id/submit", guardCourse("manage"), portal.submitCourse);
router.post("/courses/:id/withdraw", guardCourse("manage"), portal.withdrawCourse);
router.delete("/courses/:id", guardCourse("manage"), portal.deleteCourse);
router.post("/courses/:id/thumbnail", guardCourse("edit"), uploadThumb.single("thumbnail"), portal.saveCourseThumbnail);

// ── Co-instructeurs d'un cours ──
router.get("/courses/:courseId/co-instructors", guardCourse("view", "courseId"), getCourseCoInstructors);
// Les intervenants sont assignés par l'administration uniquement (voir /api/admin/courses/:id/instructors)
router.post("/courses/:courseId/co-instructors", adminOnly, addCoInstructor);
router.patch("/courses/:courseId/co-instructors/:coInstructorId", adminOnly, updateCoInstructorCommission);
router.delete("/courses/:courseId/co-instructors/:coInstructorId", adminOnly, removeCoInstructor);

// ── Étudiants ──
router.get("/courses/:id/students", guardCourse("view"), portal.listCourseStudents);

// ── Modules ──
router.get("/courses/:id/modules", guardCourse("view"), portal.listModules);
router.post("/courses/:id/modules", guardCourse("edit"), portal.createModule);
router.patch("/modules/:moduleId", guardModule("edit"), portal.updateModule);
router.delete("/modules/:moduleId", guardModule("edit"), portal.deleteModule);
router.post("/modules/:moduleId/move", guardModule("edit"), portal.moveModule);

// ── Leçons ──
router.post("/modules/:moduleId/lessons", guardModule("edit"), portal.createLesson);
router.patch("/lessons/:lessonId", guardLesson("edit"), portal.updateLesson);
router.delete("/lessons/:lessonId", guardLesson("edit"), portal.deleteLesson);
router.post("/lessons/:lessonId/move", guardLesson("edit"), portal.moveLesson);
router.post("/lessons/:lessonId/upload-video", guardLesson("edit"), uploadVideo.single("video"), portal.saveLessonVideo);
router.post("/lessons/:lessonId/upload-resource", guardLesson("edit"), uploadResource.single("file"), portal.saveLessonResource);
router.get("/lessons/:lessonId/resources", guardLesson("view"), portal.listLessonResources);
router.delete("/lesson-resources/:resourceId", guardResource("edit"), portal.deleteLessonResource);

// ── Quiz ──
router.get("/courses/:id/quizzes", guardCourse("view"), portal.listQuizzes);
router.post("/courses/:id/quizzes", guardCourse("edit"), portal.createQuiz);
router.patch("/quizzes/:quizId", guardQuiz("edit"), portal.updateQuiz);
router.delete("/quizzes/:quizId", guardQuiz("edit"), portal.deleteQuiz);
router.post("/quizzes/:quizId/questions", guardQuiz("edit"), portal.createQuestion);
router.patch("/questions/:questionId", guardQuestion("edit"), portal.updateQuestion);
router.delete("/questions/:questionId", guardQuestion("edit"), portal.deleteQuestion);

// ── Devoirs ──
router.get("/submissions", portal.listSubmissions);
router.patch("/submissions/:submissionId/grade", guardSubmission("view"), portal.gradeSubmission);

export default router;
