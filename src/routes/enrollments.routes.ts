import express from "express";
import multer from "multer";
import {
  enrollInCourse,
  unenrollFromCourse,
  getUserEnrollments,
  checkEnrollment,
  getCourseStudents,
  validateEnrollment,
  adminDeleteEnrollment,
  adminApproveEnrollment,
  getAllEnrollments,
  getEnrollmentDetails,  // ✅ Ajouté ici
  uploadPaymentProof,   // ✅ Ajouté ici
  validatePayment       // ✅ Ajouté ici
} from "../controllers/enrollmentController";
import { authenticate, authorizeRoles } from "../middleware/auth";
const upload = multer({ dest: "uploads/payments/" });


const router = express.Router();


/**
 * @openapi
 * /api/enrollments:
 *   get:
 *     tags:
 *       - Enrollments
 *     summary: Récupérer les inscriptions de l'utilisateur
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des inscriptions
 *       401:
 *         description: Non autorisé
 */

router.post("/", authenticate, authorizeRoles(["student"]), enrollInCourse);
router.delete("/:courseId", authenticate, authorizeRoles(["student"]), unenrollFromCourse);
router.get("/me", authenticate, getUserEnrollments);
router.get("/:courseId/check", authenticate, checkEnrollment);
router.get("/:courseId/students", authenticate, authorizeRoles(["instructor", "admin"]), getCourseStudents);
router.patch("/:courseId/students/:userId/validate", authenticate, authorizeRoles(["admin"]), validateEnrollment);
router.delete("/:courseId/students/:userId", authenticate, authorizeRoles(["admin"]), adminDeleteEnrollment);


// 🔹 Admin : valider une inscription
router.patch(
  "/:userId/:courseId/approve",
  authenticate,
  authorizeRoles(["admin"]),
  adminApproveEnrollment
);

// 🔹 Instructeur/Admin : voir étudiants inscrits à un cours
router.get(
  "/:courseId/students",
  authenticate,
  authorizeRoles(["instructor", "admin"]),
  getCourseStudents
);

// 🔹 Admin : voir toutes les inscriptions
router.get(
  "/",
  authenticate,
  authorizeRoles(["admin"]),
  getAllEnrollments
);


router.post(
  "/:courseId/upload-proof",
  authenticate,
  authorizeRoles(["student"]),
  upload.single("payment_proof"),
  uploadPaymentProof
);

router.patch(
  "/:userId/:courseId/validate-payment",
  authenticate,
  authorizeRoles(["admin"]),
  validatePayment
);

router.patch(
  "/:userId/:courseId/approve",
  authenticate,
  authorizeRoles(["admin"]),
  adminApproveEnrollment
);

// 🔹 Étudiant : voir les détails de son cours inscrit
router.get(
  "/:courseId/details",
  authenticate,
  authorizeRoles(["student"]),
  getEnrollmentDetails
);
export default router;
