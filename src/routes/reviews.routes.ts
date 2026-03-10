// src/routes/reviews.routes.ts
import express from "express";
import {
  getCourseReviews,
  submitReview,
  updateReview,
  deleteReview,
  getMyReview,
} from "../controllers/reviewController";
import { authenticate } from "../middleware/auth";
import { authorizeRoles } from "../middleware/auth";

const router = express.Router();

// ✅ PUBLIC — Lire les avis d'un cours
router.get("/:courseId/reviews", getCourseReviews);

// ✅ ÉTUDIANT — Soumettre ou modifier son avis (doit être inscrit)
router.post("/:courseId/reviews", authenticate, authorizeRoles(["student", "instructor", "admin"]), submitReview);
router.put("/:courseId/reviews", authenticate, authorizeRoles(["student", "instructor", "admin"]), updateReview);
router.delete("/:courseId/reviews", authenticate, authorizeRoles(["student", "instructor", "admin"]), deleteReview);

// ✅ Mon avis sur un cours
router.get("/:courseId/my-review", authenticate, getMyReview);

export default router;