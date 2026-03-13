// src/controllers/enrollmentController.ts
import { Request, Response } from 'express'
import { query } from '../config/database'
import { AuthenticatedRequest } from '../middleware/auth'

// POST /api/enrollments
export const enroll = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest
    const userId = authReq.user?.id
    if (!userId) return res.status(401).json({ success: false, message: 'Non authentifié' })

    const { course_id } = req.body
    if (!course_id) return res.status(400).json({ success: false, message: 'course_id requis' })

    const courses: any[] = await query(
      'SELECT id, title, price, is_free, requires_approval FROM courses WHERE id = ? AND is_published = 1',
      [course_id]
    )
    if (!courses.length) return res.status(404).json({ success: false, message: 'Cours introuvable' })

    const course = courses[0]
    const existing: any[] = await query(
      'SELECT id, payment_status, is_approved FROM course_enrollments WHERE user_id = ? AND course_id = ?',
      [userId, course_id]
    )
    if (existing.length)
      return res.status(409).json({ success: false, message: 'Déjà inscrit', data: existing[0] })

    const isFree = course.is_free === 1 || Number(course.price) === 0
    const paymentStatus = isFree ? 'free' : 'pending'
    const isApproved = isFree ? 1 : 0

    const result: any = await query(
      `INSERT INTO course_enrollments (user_id, course_id, enrollment_type, payment_status, is_approved, enrolled_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, course_id, isFree ? 'free' : 'individual', paymentStatus, isApproved]
    )

    return res.status(201).json({
      success: true,
      message: isFree ? 'Inscription réussie — accès immédiat' : 'Inscription créée — en attente de paiement',
      data: { enrollment_id: Number(result.insertId), payment_status: paymentStatus, is_approved: isApproved, is_free: isFree },
    })
  } catch (error) {
    console.error('enroll error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}
export const enrollInCourse = enroll

// DELETE /api/enrollments/:id
export const unenrollFromCourse = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest
    const userId = authReq.user?.id
    if (!userId) return res.status(401).json({ success: false, message: 'Non authentifié' })

    const enrollmentId = Number(req.params.id)
    const rows: any[] = await query(
      'SELECT id FROM course_enrollments WHERE id = ? AND user_id = ?',
      [enrollmentId, userId]
    )
    if (!rows.length) return res.status(404).json({ success: false, message: 'Inscription introuvable' })

    await query('DELETE FROM course_enrollments WHERE id = ?', [enrollmentId])
    return res.json({ success: true, message: 'Désinscription effectuée' })
  } catch (error) {
    console.error('unenrollFromCourse error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}

// ─────────────────────────────────────────────────────────────
// GET /api/enrollments/me
// ✅ Inclut total_lessons + completed_lessons calculés en live
// ─────────────────────────────────────────────────────────────
export const getMyEnrollments = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest
    const userId = authReq.user?.id
    if (!userId) return res.status(401).json({ success: false, message: 'Non authentifié' })

    const enrollments: any[] = await query(
      `SELECT
         ce.id,
         ce.course_id,
         ce.enrollment_type,
         ce.payment_status,
         ce.payment_proof_url,
         ce.is_approved,
         ce.approved_at,
         ce.completion_percentage,
         ce.last_accessed_at,
         ce.completed_at,
         ce.enrolled_at,
         ce.is_favorite,
         c.title,
         c.slug,
         c.thumbnail_url,
         c.level,
         c.duration_hours,
         c.price,
         c.is_free,
         cat.name AS category_name,

         -- ✅ Nombre total de leçons dans ce cours
         (
           SELECT COUNT(l.id)
           FROM lessons l
           INNER JOIN modules m ON l.module_id = m.id
           WHERE m.course_id = c.id
         ) AS total_lessons,

         -- ✅ Nombre de leçons complétées par l'étudiant
         (
           SELECT COUNT(lp.id)
           FROM lesson_progress lp
           INNER JOIN lessons l ON lp.lesson_id = l.id
           INNER JOIN modules m ON l.module_id = m.id
           WHERE m.course_id = c.id
             AND lp.user_id = ce.user_id
         ) AS completed_lessons

       FROM course_enrollments ce
       INNER JOIN courses c ON c.id = ce.course_id
       LEFT JOIN course_categories cat ON cat.id = c.category_id
       WHERE ce.user_id = ?
       ORDER BY
         ce.last_accessed_at DESC,
         ce.enrolled_at DESC`,
      [userId]
    )

    // Recalculer completion_percentage depuis les vraies leçons
    const enriched = enrollments.map(e => {
      const total     = Number(e.total_lessons)     || 0
      const completed = Number(e.completed_lessons) || 0
      const pct = total > 0
        ? Math.round((completed / total) * 100)
        : Number(e.completion_percentage) || 0
      return {
        ...e,
        total_lessons:        total,
        completed_lessons:    completed,
        completion_percentage: pct,
      }
    })

    return res.json({ success: true, data: enriched })
  } catch (error) {
    console.error('getMyEnrollments error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}
export const getUserEnrollments = getMyEnrollments

// GET /api/enrollments/status/:courseId
export const getEnrollmentStatus = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest
    const userId = authReq.user?.id
    if (!userId) return res.status(401).json({ success: false, message: 'Non authentifié' })

    const courseId = Number(req.params.courseId)
    const rows: any[] = await query(
      'SELECT id, payment_status, is_approved, completion_percentage, enrolled_at FROM course_enrollments WHERE user_id = ? AND course_id = ?',
      [userId, courseId]
    )
    return res.json({ success: true, data: rows.length ? rows[0] : null })
  } catch (error) {
    console.error('getEnrollmentStatus error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}
export const checkEnrollment      = getEnrollmentStatus
export const getEnrollmentDetails  = getEnrollmentStatus

// POST /api/enrollments/:courseId/upload-proof
export const submitPayment = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest
    const userId = authReq.user?.id
    if (!userId) return res.status(401).json({ success: false, message: 'Non authentifié' })

    const enrollmentId = Number(req.params.enrollmentId)
    const { amount, payment_method, reference, proof_url } = req.body

    if (!amount || !payment_method || !proof_url)
      return res.status(400).json({ success: false, message: 'amount, payment_method et proof_url requis' })

    const enrollments: any[] = await query(
      `SELECT ce.id, ce.course_id, ce.payment_status, c.price, c.title
       FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
       WHERE ce.id = ? AND ce.user_id = ?`,
      [enrollmentId, userId]
    )
    if (!enrollments.length) return res.status(404).json({ success: false, message: 'Inscription introuvable' })
    if (enrollments[0].payment_status === 'verified')
      return res.status(400).json({ success: false, message: 'Paiement déjà validé' })

    const existing: any[] = await query(
      'SELECT id FROM payments WHERE user_id = ? AND course_id = ? AND status != "validated"',
      [userId, enrollments[0].course_id]
    )
    if (existing.length) {
      await query(
        `UPDATE payments SET amount=?, payment_method=?, reference=?, proof_url=?, status='pending', updated_at=NOW() WHERE id=?`,
        [amount, payment_method, reference || null, proof_url, existing[0].id]
      )
    } else {
      await query(
        `INSERT INTO payments (user_id, course_id, amount, currency, payment_method, reference, proof_url, status, created_at, updated_at)
         VALUES (?, ?, ?, 'XAF', ?, ?, ?, 'pending', NOW(), NOW())`,
        [userId, enrollments[0].course_id, amount, payment_method, reference || null, proof_url]
      )
    }

    await query(
      `UPDATE course_enrollments SET payment_status='pending', payment_proof_url=?, enrolled_at=enrolled_at WHERE id=?`,
      [proof_url, enrollmentId]
    )

    return res.json({
      success: true,
      message: 'Preuve soumise — validation sous 24h',
      data: { enrollment_id: enrollmentId, payment_status: 'pending' },
    })
  } catch (error) {
    console.error('submitPayment error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}
export const uploadPaymentProof = submitPayment

// GET /api/enrollments/:courseId/students
export const getCourseStudents = async (req: Request, res: Response) => {
  try {
    const courseId = Number(req.params.courseId)
    const students: any[] = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name,
              ce.payment_status, ce.is_approved, ce.enrolled_at, ce.completion_percentage
       FROM course_enrollments ce
       JOIN users u ON u.id = ce.user_id
       WHERE ce.course_id = ?
       ORDER BY ce.enrolled_at DESC`,
      [courseId]
    )
    return res.json({ success: true, data: students })
  } catch (error) {
    console.error('getCourseStudents error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}

// GET /api/enrollments  (admin)
export const getAllEnrollments = async (req: Request, res: Response) => {
  try {
    const rows: any[] = await query(
      `SELECT ce.*, u.email, u.first_name, u.last_name, c.title AS course_title
       FROM course_enrollments ce
       JOIN users u ON u.id = ce.user_id
       JOIN courses c ON c.id = ce.course_id
       ORDER BY ce.enrolled_at DESC
       LIMIT 200`
    )
    return res.json({ success: true, data: rows })
  } catch (error) {
    console.error('getAllEnrollments error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}

// PATCH /api/enrollments/:id/validate  (admin)
export const validateEnrollment = async (req: Request, res: Response) => {
  try {
    const enrollmentId = Number(req.params.id)
    const { approved } = req.body
    await query(
      `UPDATE course_enrollments SET is_approved = ?, payment_status = ?, approved_at = NOW() WHERE id = ?`,
      [approved ? 1 : 0, approved ? 'verified' : 'rejected', enrollmentId]
    )
    return res.json({ success: true, message: approved ? 'Inscription approuvée' : 'Inscription rejetée' })
  } catch (error) {
    console.error('validateEnrollment error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}
export const validatePayment        = validateEnrollment
export const adminApproveEnrollment = validateEnrollment

// DELETE /api/enrollments/:id  (admin)
export const adminDeleteEnrollment = async (req: Request, res: Response) => {
  try {
    const enrollmentId = Number(req.params.id)
    await query('DELETE FROM course_enrollments WHERE id = ?', [enrollmentId])
    return res.json({ success: true, message: 'Inscription supprimée' })
  } catch (error) {
    console.error('adminDeleteEnrollment error:', error)
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' })
  }
}

export default {
  enroll, enrollInCourse,
  unenrollFromCourse,
  getMyEnrollments, getUserEnrollments,
  getEnrollmentStatus, checkEnrollment, getEnrollmentDetails,
  submitPayment, uploadPaymentProof,
  getCourseStudents,
  getAllEnrollments,
  validateEnrollment, validatePayment, adminApproveEnrollment,
  adminDeleteEnrollment,
}