// src/controllers/reviewController.ts
import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";

// ============================================================
// GET /api/courses/:courseId/reviews
// Public — liste paginée des avis publiés
// ============================================================
export const getCourseReviews = async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;
    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(20, parseInt(req.query.limit as string) || 10);
    const offset = (page - 1) * limit;

    // Stats globales
    const [stats]: any = await query(
      `SELECT
         COUNT(*)               AS total,
         ROUND(AVG(rating), 1)  AS avg_rating,
         SUM(rating = 5)        AS r5,
         SUM(rating = 4)        AS r4,
         SUM(rating = 3)        AS r3,
         SUM(rating = 2)        AS r2,
         SUM(rating = 1)        AS r1
       FROM course_reviews
       WHERE course_id = ? AND is_published = 1`,
      [courseId]
    );

    // Liste des avis
    const reviews = await query(
      `SELECT
         cr.id, cr.rating, cr.comment, cr.created_at, cr.updated_at,
         u.first_name, u.last_name, u.avatar_url
       FROM course_reviews cr
       JOIN users u ON cr.user_id = u.id
       WHERE cr.course_id = ? AND cr.is_published = 1
       ORDER BY cr.created_at DESC
       LIMIT ? OFFSET ?`,
      [courseId, limit, offset]
    );

    return res.json({
      success: true,
      data: {
        stats: {
          total:      Number(stats.total)      || 0,
          avg_rating: Number(stats.avg_rating) || 0,
          distribution: {
            5: Number(stats.r5) || 0,
            4: Number(stats.r4) || 0,
            3: Number(stats.r3) || 0,
            2: Number(stats.r2) || 0,
            1: Number(stats.r1) || 0,
          },
        },
        reviews,
        pagination: { page, limit, total: Number(stats.total) || 0 },
      },
    });
  } catch (err) {
    console.error("getCourseReviews:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ============================================================
// GET /api/courses/:courseId/my-review
// Retourne l'avis de l'utilisateur connecté sur ce cours
// ============================================================
export const getMyReview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;

    const [review]: any = await query(
      `SELECT cr.id, cr.rating, cr.comment, cr.created_at, cr.updated_at
       FROM course_reviews cr
       WHERE cr.course_id = ? AND cr.user_id = ?
       LIMIT 1`,
      [courseId, userId]
    );

    return res.json({ success: true, data: review || null });
  } catch (err) {
    console.error("getMyReview:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ============================================================
// POST /api/courses/:courseId/reviews
// Soumettre un avis (doit être inscrit + cours accessible)
// ============================================================
export const submitReview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;
    const { rating, comment } = req.body;

    // Validation
    const ratingNum = parseInt(rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ success: false, message: "Note invalide (1 à 5 requis)" });
    }

    // Vérifier que l'étudiant est inscrit
    const [enrollment]: any = await query(
      `SELECT id FROM course_enrollments WHERE user_id = ? AND course_id = ? AND is_approved = 1`,
      [userId, courseId]
    );
    if (!enrollment) {
      return res.status(403).json({
        success: false,
        message: "Vous devez être inscrit et avoir accès au cours pour laisser un avis.",
      });
    }

    // Vérifier qu'il n'a pas déjà un avis
    const [existing]: any = await query(
      `SELECT id FROM course_reviews WHERE user_id = ? AND course_id = ?`,
      [userId, courseId]
    );
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Vous avez déjà soumis un avis pour ce cours. Modifiez-le si nécessaire.",
      });
    }

    // Insérer
    const result: any = await query(
      `INSERT INTO course_reviews (user_id, course_id, enrollment_id, rating, comment, is_published)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [userId, courseId, enrollment.id, ratingNum, comment?.trim() || null]
    );

    // Le trigger BDD met à jour rating + review_count dans courses automatiquement

    return res.status(201).json({
      success: true,
      message: "Avis soumis avec succès !",
      data: { id: result.insertId, rating: ratingNum, comment: comment?.trim() || null },
    });
  } catch (err) {
    console.error("submitReview:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ============================================================
// PUT /api/courses/:courseId/reviews
// Modifier son avis existant
// ============================================================
export const updateReview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;
    const { rating, comment } = req.body;

    const ratingNum = parseInt(rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ success: false, message: "Note invalide (1 à 5 requis)" });
    }

    const [existing]: any = await query(
      `SELECT id FROM course_reviews WHERE user_id = ? AND course_id = ?`,
      [userId, courseId]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: "Aucun avis trouvé à modifier." });
    }

    await query(
      `UPDATE course_reviews SET rating = ?, comment = ?, updated_at = NOW()
       WHERE user_id = ? AND course_id = ?`,
      [ratingNum, comment?.trim() || null, userId, courseId]
    );

    // Le trigger BDD recalcule rating automatiquement

    return res.json({ success: true, message: "Avis modifié avec succès." });
  } catch (err) {
    console.error("updateReview:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};

// ============================================================
// DELETE /api/courses/:courseId/reviews
// Supprimer son avis
// ============================================================
export const deleteReview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;

    const [existing]: any = await query(
      `SELECT id FROM course_reviews WHERE user_id = ? AND course_id = ?`,
      [userId, courseId]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: "Aucun avis trouvé." });
    }

    await query(
      `DELETE FROM course_reviews WHERE user_id = ? AND course_id = ?`,
      [userId, courseId]
    );

    return res.json({ success: true, message: "Avis supprimé." });
  } catch (err) {
    console.error("deleteReview:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
};