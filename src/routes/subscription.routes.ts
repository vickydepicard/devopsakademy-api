import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { listPlans, mySubscription, myHistory, subscribe, cancelSubscription } from "../controllers/subscriptionController";

const router = Router();
router.get("/plans", listPlans); // public
router.get("/my", authenticate, mySubscription);
router.get("/history", authenticate, myHistory);
router.post("/subscribe", authenticate, subscribe);
router.post("/:id/cancel", authenticate, cancelSubscription);

export default router;
