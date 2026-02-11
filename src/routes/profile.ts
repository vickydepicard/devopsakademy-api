import { Router } from "express";
import usersController from "../controllers/userController";
import { requireAuth } from "../middleware/permissions";
import { authenticate } from "../middleware/auth";

const router = Router();

// ✅ PROFIL UTILISATEUR - CONNECTÉ SEULEMENT
router.get("/", requireAuth, usersController.getProfile);

// ✅ METTRE À JOUR LE PROFIL - CONNECTÉ SEULEMENT
router.put("/", requireAuth, usersController.updateProfile);

// ✅ PROGRESSION UTILISATEUR - CONNECTÉ SEULEMENT
router.get("/progress", requireAuth, usersController.getUserProgress);

// ✅ ROUTES EXISTANTES POUR COMPATIBILITÉ
router.get("/", authenticate, usersController.getProfile);
router.put("/", authenticate, usersController.updateProfile);

export default router;