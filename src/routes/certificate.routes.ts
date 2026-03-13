// src/routes/certificate.routes.ts
import express from "express";
import {
  getMyCertificates,
  verifyCertificate,
  issueCertificate,
  getAllCertificates,
  deleteCertificate,
} from "../controllers/certificateController";
import { authenticate, authorizeRoles } from "../middleware/auth";

const router = express.Router();

// ── Étudiant ──
// GET /api/certificates/my
router.get("/my", authenticate, getMyCertificates);

// ── Public ──
// GET /api/certificates/verify/:number
router.get("/verify/:number", verifyCertificate);

// ── Admin ──
// GET    /api/certificates          (admin)
// POST   /api/certificates/issue    (admin)
// DELETE /api/certificates/:id      (admin)
router.get(
  "/",
  authenticate,
  authorizeRoles(["admin"]),
  getAllCertificates
);
router.post(
  "/issue",
  authenticate,
  authorizeRoles(["admin"]),
  issueCertificate
);
router.delete(
  "/:id",
  authenticate,
  authorizeRoles(["admin"]),
  deleteCertificate
);

export default router;