import express from "express";
import multer from "multer";
import {
  createContact,
  getContacts,
  getContactById,
} from "../controllers/contactController";
import {
  uploadPaymentProof,
} from "../controllers/enrollmentController"; // ✅ chemin corrigé
import { authenticate, authorizeRoles } from "../middleware/auth";

const router = express.Router();

// 🧩 Configuration du stockage de fichiers
const upload = multer({ dest: "uploads/payments/" });

// ✅ Routes publiques
router.post("/", createContact);

// ✅ Routes protégées (Admin)
router.get("/", authenticate, authorizeRoles(["admin"]), getContacts);
router.get("/:id", authenticate, authorizeRoles(["admin"]), getContactById);

// ✅ Upload preuve de paiement (étudiant)
router.post(
  "/:courseId/upload-proof",
  authenticate,
  authorizeRoles(["student"]),
  upload.single("payment_proof"),
  uploadPaymentProof
);

export default router;
