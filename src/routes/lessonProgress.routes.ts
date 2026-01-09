import { Router } from "express"
import { authenticate } from "../middleware/auth"
import { markLessonCompleted } from "../controllers/lessonProgress.controller"

const router = Router()

router.post("/:courseId/lessons/:lessonId/complete", authenticate, markLessonCompleted)

export default router
