// src/routes/translations.routes.ts — monté sur /api/admin/translations (avant le routeur admin général)
import { Router } from "express";
import { authenticate, authorizeRoles } from "../middleware/auth";
import * as t from "../controllers/translationsController";

const router = Router();
router.use(authenticate, authorizeRoles(["admin", "superadmin"]));
router.get("/status", t.getStatus);
router.get("/summary", t.getSummary);
router.get("/items", t.listItems);
router.put("/item", t.saveItem);
router.delete("/item", t.deleteItem);
router.post("/auto", t.runAuto);
export default router;
