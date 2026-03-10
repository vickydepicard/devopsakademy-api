// src/routes/profileRoutes.ts
import { Router } from "express"
import { authenticate } from "../middleware/auth"
import {
  getProfile,
  updateProfile,
  getUserProgress,
} from "../controllers/userController"

const router = Router()

// Toutes les routes profil nécessitent d'être connecté
router.use(authenticate)

// GET  /api/profile        → récupérer son profil
router.get("/", getProfile)

// PUT  /api/profile        → mettre à jour son profil
router.put("/", updateProfile)

// GET  /api/profile/progress → progression des cours
router.get("/progress", getUserProgress)

export default router