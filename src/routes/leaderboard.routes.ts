import { Router } from "express";
import { optionalAuth, getPublicLeaderboard } from "../controllers/leaderboardController";

const router = Router();
// Public ; si un jeton valide est fourni, la réponse contient aussi my_rank
router.get("/", optionalAuth, getPublicLeaderboard);

export default router;
