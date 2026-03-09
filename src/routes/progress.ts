import express from 'express';
import { 
  getUserProgress, 
  getCourseProgress, 
  getLessonStatus 
} from '../controllers/progressController';
import { authenticate } from '../middleware/auth';

const router = express.Router();

// Toutes les routes nécessitent une authentification
router.use(authenticate);

router.get('/', getUserProgress);
router.get('/:courseId', getCourseProgress);
router.get('/lessons/:lessonId', getLessonStatus);

export default router;