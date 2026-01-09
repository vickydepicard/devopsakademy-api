import express from 'express';
import { 
  getCategories, 
  getThreads, 
  createThread, 
  getThreadById, 
  createMessage 
} from '../controllers/forumController';
import { authenticate } from '../middleware/auth';

const router = express.Router();

// Routes publiques
router.get('/categories', getCategories);
router.get('/threads', getThreads);

// Routes protégées
router.use(authenticate);

router.post('/threads', createThread);
router.get('/threads/:id', getThreadById);
router.post('/threads/:id/messages', createMessage);

export default router;