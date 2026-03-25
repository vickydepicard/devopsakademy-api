// src/controllers/enrollmentController.ts
import { Request, Response } from 'express'
import { sendPaymentReceivedEmail } from '../services/mail.service';
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

         -- ✅ Leçons publiées uniquement (respecte dépublication modules/leçons)
         (
           SELECT COUNT(l.id)
           FROM lessons l
           INNER JOIN modules m ON l.module_id = m.id
           WHERE m.course_id = c.id
             AND l.is_published = 1
             AND m.is_published = 1
         ) AS total_lessons,

         -- ✅ Leçons complétées sur les leçons publiées seulement
         (
           SELECT COUNT(lp.id)
           FROM lesson_progress lp
           INNER JOIN lessons l ON lp.lesson_id = l.id
           INNER JOIN modules m ON l.module_id = m.id
           WHERE m.course_id = c.id
             AND lp.user_id = ce.user_id
             AND lp.is_completed = 1
             AND l.is_published = 1
             AND m.is_published = 1
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

    // Recalculer completion_percentage et synchroniser en BDD
    const enriched = await Promise.all(enrollments.map(async (e) => {
      const total     = Number(e.total_lessons)     || 0
      const completed = Number(e.completed_lessons) || 0
      const pct = total > 0
        ? Math.round((completed / total) * 100)
        : Number(e.completion_percentage) || 0

      // Synchroniser en BDD si la valeur a changé
      if (pct !== Number(e.completion_percentage)) {
        try {
          if (pct >= 100) {
            await query(
              "UPDATE course_enrollments SET completion_percentage=?, completed_at=NOW() WHERE user_id=? AND course_id=?",
              [pct, userId, e.course_id]
            );
          } else {
            await query(
              "UPDATE course_enrollments SET completion_percentage=? WHERE user_id=? AND course_id=?",
              [pct, userId, e.course_id]
            );
          }
        } catch (_) {}
      }

      return {
        ...e,
        total_lessons:         total,
        completed_lessons:     completed,
        completion_percentage: pct,
        is_completed:          pct >= 100,
      }
    }))

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

    // ✅ Accepte courseId (route /:courseId/upload-proof) OU enrollmentId
    const courseId     = Number(req.params.courseId)
    const enrollmentId = Number(req.params.enrollmentId)
    const { amount, payment_method, reference } = req.body

    // payment_method requis (amount et proof_url peuvent venir du fichier ou être calculés)
    if (!payment_method)
      return res.status(400).json({ success: false, message: 'payment_method requis' })

    // ✅ Chercher l'inscription par courseId OU enrollmentId
    const whereClause = courseId && !isNaN(courseId)
      ? 'WHERE ce.course_id = ? AND ce.user_id = ?'
      : 'WHERE ce.id = ? AND ce.user_id = ?'
    const whereParam = (courseId && !isNaN(courseId)) ? [courseId, userId] : [enrollmentId, userId]

    const enrollments: any[] = await query(
      `SELECT ce.id, ce.course_id, ce.payment_status, c.price, c.title
       FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
       ${whereClause}`,
      whereParam
    )
    if (!enrollments.length)
      return res.status(404).json({ success: false, message: 'Inscription introuvable. Inscrivez-vous dabord.' })
    if (enrollments[0].payment_status === 'verified')
      return res.status(400).json({ success: false, message: 'Paiement déjà validé' })

    const actualEnrollmentId = enrollments[0].id
    const actualAmount       = Number(amount) || Number(enrollments[0].price) || 0

    // ✅ URL preuve: fichier uploadé (multer) OU champ JSON
    const fileUploaded = (req as any).file
    const actualProofUrl = fileUploaded
      ? `/uploads/payments/${fileUploaded.filename}`
      : (req.body?.proof_url || null)

    const existing: any[] = await query(
      "SELECT id FROM payments WHERE user_id = ? AND course_id = ? AND status != 'validated'",
      [userId, enrollments[0].course_id]
    )
    if (existing.length) {
      await query(
        `UPDATE payments SET amount=?, payment_method=?, reference=?, proof_url=?, status='pending', updated_at=NOW() WHERE id=?`,
        [actualAmount, payment_method, reference || null, actualProofUrl, existing[0].id]
      )
    } else {
      await query(
        `INSERT INTO payments (user_id, course_id, amount, currency, payment_method, reference, proof_url, status, created_at, updated_at)
         VALUES (?, ?, ?, 'XAF', ?, ?, ?, 'pending', NOW(), NOW())`,
        [userId, enrollments[0].course_id, actualAmount, payment_method, reference || null, actualProofUrl]
      )
    }

    await query(
      `UPDATE course_enrollments SET payment_status='pending', payment_proof_url=? WHERE id=?`,
      [actualProofUrl, actualEnrollmentId]
    )

    // ✅ Email de confirmation de réception de la preuve
    try {
      const [userRow]: any = await query(
        'SELECT first_name, email FROM users WHERE id = ?', [userId]
      );
      const [courseRow]: any = await query(
        'SELECT title, price FROM courses WHERE id = ?', [enrollments[0].course_id]
      );
      if (userRow && courseRow) {
        await sendPaymentReceivedEmail(
          userRow.email,
          userRow.first_name,
          courseRow.title,
          Number(courseRow.price) || actualAmount
        ).catch(e => console.warn("⚠️ Email preuve non bloquant:", e.message));
      }
    } catch (emailErr) {
      console.warn("⚠️ Email non bloquant:", emailErr);
    }

    return res.json({
      success: true,
      message: 'Preuve soumise avec succès — validation sous 24h ouvrées',
      data: { enrollment_id: actualEnrollmentId, payment_status: 'pending' },
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


// PATCH /api/enrollments/:userId/:courseId/reject  (admin)
export const rejectEnrollment = async (req: any, res: any) => {
  try {
    const { userId, courseId } = req.params;
    const reason = req.body?.reason || req.body?.rejection_reason || "Paiement non conforme";
    await query(
      `UPDATE course_enrollments
       SET is_approved = 0, payment_status = 'rejected', rejection_reason = ?
       WHERE user_id = ? AND course_id = ?`,
      [reason, userId, courseId]
    );
    return res.json({ success: true, message: "Inscription rejetée" });
  } catch (err) {
    console.error("rejectEnrollment:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// GET /api/enrollments/user/:userId  (admin — inscriptions d'un étudiant)
export const getEnrollmentsByUser = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const rows: any[] = await query(
      `SELECT
         ce.id, ce.user_id, ce.course_id, ce.payment_status,
         ce.is_approved, ce.approved_at, ce.completion_percentage,
         ce.enrolled_at, ce.payment_proof_url,
         COALESCE(ce.rejection_reason, '') AS rejection_reason,
         c.title AS course_title, c.thumbnail_url, c.level AS course_level,
         c.duration_hours, cat.name AS category_name
       FROM course_enrollments ce
       JOIN courses c ON c.id = ce.course_id
       LEFT JOIN course_categories cat ON cat.id = c.category_id
       WHERE ce.user_id = ?
       ORDER BY ce.enrolled_at DESC`,
      [userId]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getEnrollmentsByUser:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// PATCH /api/admin/enrollments/:id/approve  (approve par enrollment.id)
export const approveEnrollmentById = async (req: any, res: any) => {
  try {
    const { id } = req.params;
    await query(
      `UPDATE course_enrollments
       SET is_approved = 1, payment_status = 'verified', approved_at = NOW()
       WHERE id = ?`,
      [id]
    );
    // ✅ Email de validation
    try {
      const [row]: any = await query(
        `SELECT u.first_name, u.email, c.title, c.id AS course_id
         FROM course_enrollments ce
         JOIN users u ON u.id = ce.user_id
         JOIN courses c ON c.id = ce.course_id
         WHERE ce.id = ?`, [id]
      );
      if (row) {
        const { sendPaymentApprovedEmail } = await import('../services/mail.service');
        await sendPaymentApprovedEmail(row.email, row.first_name, row.title, Number(row.course_id))
          .catch(e => console.warn("Email approve:", e.message));
      }
    } catch(e) { console.warn("Email approve:", e); }
    return res.json({ success: true, message: "Inscription approuvée" });
  } catch (err) {
    console.error("approveEnrollmentById:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// PATCH /api/admin/enrollments/:id/reject  (reject par enrollment.id)
export const rejectEnrollmentById = async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const reason = req.body?.reason || "Paiement non conforme";
    await query(
      `UPDATE course_enrollments
       SET is_approved = 0, payment_status = 'rejected', approved_at = NULL
       WHERE id = ?`,
      [id]
    );
    // ✅ Email de rejet
    try {
      const [row]: any = await query(
        `SELECT u.first_name, u.email, c.title
         FROM course_enrollments ce
         JOIN users u ON u.id = ce.user_id
         JOIN courses c ON c.id = ce.course_id
         WHERE ce.id = ?`, [id]
      );
      if (row) {
        const { sendPaymentRejectedEmail } = await import('../services/mail.service');
        await sendPaymentRejectedEmail(row.email, row.first_name, row.title)
          .catch(e => console.warn("Email reject:", e.message));
      }
    } catch(e) { console.warn("Email reject:", e); }
    return res.json({ success: true, message: "Inscription rejetée" });
  } catch (err) {
    console.error("rejectEnrollmentById:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

export default {
  enroll, enrollInCourse,
  unenrollFromCourse,
  getMyEnrollments, getUserEnrollments,
  getEnrollmentStatus, checkEnrollment, getEnrollmentDetails,
  submitPayment, uploadPaymentProof,
  getCourseStudents,
  getAllEnrollments,
  rejectEnrollment,
  getEnrollmentsByUser,
  approveEnrollmentById,
  rejectEnrollmentById,
  validateEnrollment, validatePayment, adminApproveEnrollment,
  adminDeleteEnrollment,
}