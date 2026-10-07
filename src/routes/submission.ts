// Soumissions de devoirs — tables projects / project_submissions / submission_files.
// Montée sur /api/submissions (app.ts). Les routes admin équivalentes sont dans routes/admin.ts.
import { Router } from "express";
import { authenticate, authorizeRoles } from "../middleware/auth";
import {
  createSubmission, mySubmissionsForCourse, listForReview, reviewSubmission,
} from "../controllers/submissionController";

const router = Router();
router.use(authenticate);

// Étudiant
router.post("/", authorizeRoles(["student"]), createSubmission);
router.get("/course/:id", mySubmissionsForCourse);

// Correcteurs : admin, ou instructeur du cours (contrôle d'accès dans le contrôleur)
const correctors = authorizeRoles(["admin", "superadmin", "instructor"]);
router.get("/review", correctors, listForReview);
router.patch("/:id/review", correctors, reviewSubmission);

export default router;
