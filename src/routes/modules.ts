import express from "express";
import {
  getModules,
  getModuleById,
  createModule,
  updateModule,
  deleteModule,
} from "../controllers/moduleController";
import { authenticate, authorizeRoles } from "../middleware/auth";

const router = express.Router({ mergeParams: true }); // ✅ récupère :courseId

// 🔓 Accessible à tous les utilisateurs connectés
router.get("/", authenticate, getModules);
router.get("/:moduleId", authenticate, getModuleById);

// 🔒 Instructeur / Admin
router.post("/", authenticate, authorizeRoles(["instructor", "admin"]), createModule);
router.put("/:moduleId", authenticate, authorizeRoles(["instructor", "admin"]), updateModule);
router.delete("/:moduleId", authenticate, authorizeRoles(["instructor", "admin"]), deleteModule);

export default router;
