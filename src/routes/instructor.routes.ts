// src/routes/instructor.routes.ts
import { Router } from "express";
import { authenticate, authorizeRoles, authenticateAllowInactive } from "../middleware/auth";
import { requireAuth } from "../middleware/permissions";
import {
  submitInstructorApplication,
  getAllInstructorApplications,
  approveInstructorApplication,
  rejectInstructorApplication,
  markApplicationUnderReview,
} from "../controllers/instructorController";
import {
  getMyApplicationFull, getApplicationDetail, getInterviewRoom,
  addAdminComment, deleteAdminComment, updateApplicationSettings, saveEvaluation,
  addCandidateComment, completeMyApplication, reopenApplication, uploadMyCv, downloadMyCv, downloadApplicationCv, requestInformation, cancelInformationRequest, createInterviews, updateInterview, respondToInterview,
} from "../controllers/applicationReviewController";

const router = Router();

// ── Étudiant : soumettre / voir sa candidature ──
router.post("/",
  authenticateAllowInactive, // Accepte les comptes non encore activés
  submitInstructorApplication
);

router.get("/my",
  authenticate,
  getMyApplicationFull
);

// Échanges côté candidat
router.post("/my/comments", authenticate, addCandidateComment);
router.patch("/my/complete", authenticate, completeMyApplication);
router.post("/my/cv", authenticate, uploadMyCv);
router.get("/my/cv", authenticate, downloadMyCv);
router.post("/my/interviews/:iid/respond", authenticate, respondToInterview);

// Salle d'entretien : publique, protégée par le code aléatoire du lien
router.get("/interview-room/:code", getInterviewRoom);

// ── Admin : gérer toutes les candidatures ──
const adminOnly = [authenticate, authorizeRoles(["admin", "superadmin"])];

router.get("/",
  authenticate,
  authorizeRoles(["admin", "superadmin"]),
  getAllInstructorApplications
);

router.get("/:id", ...adminOnly, getApplicationDetail);

// Commentaires, évaluation, entretiens
router.post("/:id/comments", ...adminOnly, addAdminComment);
router.delete("/:id/comments/:cid", ...adminOnly, deleteAdminComment);
router.patch("/:id/settings", ...adminOnly, updateApplicationSettings);
router.get("/:id/cv", ...adminOnly, downloadApplicationCv);
router.patch("/:id/reopen", ...adminOnly, reopenApplication);
router.post("/:id/request-info", ...adminOnly, requestInformation);
router.delete("/:id/request-info", ...adminOnly, cancelInformationRequest);
router.put("/:id/evaluation", ...adminOnly, saveEvaluation);
router.post("/:id/interviews", ...adminOnly, createInterviews);
router.patch("/:id/interviews/:iid", ...adminOnly, updateInterview);

router.patch("/:id/approve",
  authenticate,
  authorizeRoles(["admin", "superadmin"]),
  approveInstructorApplication
);

router.patch("/:id/review",
  authenticate,
  authorizeRoles(["admin", "superadmin"]),
  markApplicationUnderReview
);

router.patch("/:id/reject",
  authenticate,
  authorizeRoles(["admin", "superadmin"]),
  rejectInstructorApplication
);

export default router;