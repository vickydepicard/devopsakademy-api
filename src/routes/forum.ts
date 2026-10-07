import express from 'express';
import {
  getCategories, getThreads, createThread, getThreadById, createMessage,
  deleteThread, deletePost, updateThread,
} from '../controllers/forumController';
import { authenticate, optionalAuthenticate } from '../middleware/auth';

const router = express.Router();

// Lecture publique (le visiteur peut lire, pas écrire)
router.get('/categories', getCategories);
router.get('/threads', optionalAuthenticate, getThreads);
router.get('/threads/:id', optionalAuthenticate, getThreadById);

// Écriture : connecté
router.post('/threads', authenticate, createThread);
router.post('/threads/:id/messages', authenticate, createMessage);
router.patch('/threads/:id', authenticate, updateThread);
router.delete('/threads/:id', authenticate, deleteThread);
router.delete('/posts/:id', authenticate, deletePost);

export default router;
