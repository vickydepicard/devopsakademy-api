import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { uploadProof } from "../controllers/subscriptionController";

const router = Router();
router.post("/upload-proof", authenticate, uploadProof);

export default router;
