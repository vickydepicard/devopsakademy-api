// src/routes/enrollmentRoutes.ts
import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { enroll, submitPayment, getMyEnrollments, getEnrollmentStatus } from '../controllers/enrollmentController'

const router = Router()

router.use(authenticate)

// GET  /api/enrollments/me                      → mes inscriptions
router.get('/me', getMyEnrollments)

// GET  /api/enrollments/status/:courseId        → statut pour un cours
router.get('/status/:courseId', getEnrollmentStatus)

// POST /api/enrollments                         → s'inscrire
router.post('/', enroll)

// POST /api/enrollments/:enrollmentId/payment   → soumettre preuve paiement
router.post('/:enrollmentId/payment', submitPayment)

export default router