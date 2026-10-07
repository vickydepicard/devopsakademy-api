// src/routes/quiz.routes.ts — monté sur /api/quizzes
import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { getQuiz, submitQuiz } from "../controllers/quizController";

const router = Router();
router.get("/:quizId", authenticate, getQuiz);
router.post("/:quizId/submit", authenticate, submitQuiz);
export default router;
