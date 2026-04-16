import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import {
  enrollInCourse,
  unenrollFromCourse,
  getUserEnrollments,
  checkEnrollment,
  getEnrollmentStatus,
  getCourseStudents,
  validateEnrollment,
  adminDeleteEnrollment,
  adminApproveEnrollment,
  getAllEnrollments,
  getEnrollmentDetails,
  uploadPaymentProof,
  validatePayment,
  rejectEnrollment,
  getEnrollmentsByUser,
} from "../controllers/enrollmentController";
import { authenticate, authorizeRoles } from "../middleware/auth";

// ✅ Chemin absolu pour les uploads — fonctionne en local ET en production
const uploadsDir = path.join(process.cwd(), "uploads", "payments");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ✅ diskStorage : conserve l'extension du fichier (jpg, png, pdf...)
// Sans ça, multer sauve sans extension → le navigateur ne peut pas afficher l'image
const paymentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || ".jpg";
    const name = Date.now() + "-" + Math.round(Math.random() * 1e6) + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage: paymentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo max
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg","image/png","image/webp","image/jpg","application/pdf"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Format non supporté. Utilisez JPG, PNG, WEBP ou PDF."));
  },
});


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
router.get("/status/:courseId", authenticate, getEnrollmentStatus);  // ✅ EnrollButton
router.get("/:courseId/check",  authenticate, checkEnrollment);
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
// GET /api/enrollments/user/:userId — Toutes les inscriptions d'un étudiant (admin)
router.get(
  "/user/:userId",
  authenticate,
  authorizeRoles(["admin"]),
  getEnrollmentsByUser
);

// PATCH /api/enrollments/:userId/:courseId/reject — Rejeter une inscription
router.patch(
  "/:userId/:courseId/reject",
  authenticate,
  authorizeRoles(["admin"]),
  rejectEnrollment
);

export default router;