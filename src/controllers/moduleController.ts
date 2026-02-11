import { Request, Response } from 'express';
import { query } from '../config/database';
import { AuthenticatedRequest } from '../middleware/auth';

// ✅ Helper pour convertir BigInt en Number
function convertBigInt(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return Number(obj);
  if (Array.isArray(obj)) return obj.map(convertBigInt);
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, convertBigInt(v)])
    );
  }
  return obj;
}

export const getModules = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;
    const user = req.user || null;

    // Convertir l'ID en nombre
    const courseIdNum = Number(courseId);
    
    if (isNaN(courseIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    // Vérifier si l'utilisateur a accès au cours
    const [course]: any = await query(
      `SELECT id, instructor_id, is_published FROM courses WHERE id = ?`,
      [courseIdNum]
    );

    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: "Cours non trouvé" 
      });
    }

    // Vérifier les permissions
    const isEnrolled = user ? await isUserEnrolled(courseIdNum, user.id) : false;
    const hasAccess = 
      course.is_published ||
      (user && (user.role === "admin" || user.id === course.instructor_id)) ||
      isEnrolled;

    if (!hasAccess) {
      return res.status(403).json({ 
        success: false, 
        message: "Accès refusé" 
      });
    }

    const modules = await query(`
      SELECT m.*, 
        COUNT(l.id) as lesson_count,
        SUM(l.duration_minutes) as total_duration
      FROM modules m
      LEFT JOIN lessons l ON m.id = l.module_id AND l.is_published = 1
      WHERE m.course_id = ? AND m.is_published = 1
      GROUP BY m.id
      ORDER BY m.order_index
    `, [courseIdNum]);

    res.json({
      success: true,
      data: convertBigInt(modules)
    });
  } catch (error) {
    console.error('Get modules error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des modules'
    });
  }
};

export const getModuleById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;
    const user = req.user || null;

    // Convertir les IDs en nombres
    const courseIdNum = Number(courseId);
    const moduleIdNum = Number(moduleId);
    
    if (isNaN(courseIdNum) || isNaN(moduleIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours ou module invalide" 
      });
    }

    // Vérifier si l'utilisateur a accès au cours
    const [course]: any = await query(
      `SELECT id, instructor_id, is_published FROM courses WHERE id = ?`,
      [courseIdNum]
    );

    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: "Cours non trouvé" 
      });
    }

    // Vérifier les permissions
    const isEnrolled = user ? await isUserEnrolled(courseIdNum, user.id) : false;
    const hasAccess = 
      course.is_published ||
      (user && (user.role === "admin" || user.id === course.instructor_id)) ||
      isEnrolled;

    if (!hasAccess) {
      return res.status(403).json({ 
        success: false, 
        message: "Accès refusé" 
      });
    }

    const [module]: any = await query(`
      SELECT m.*, c.title as course_title
      FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ?
    `, [moduleIdNum, courseIdNum]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé'
      });
    }

    // Récupérer les leçons du module
    const lessons = await query(`
      SELECT * FROM lessons 
      WHERE module_id = ? AND is_published = 1
      ORDER BY order_index
    `, [moduleIdNum]);

    res.json({
      success: true,
      data: {
        ...convertBigInt(module),
        lessons: convertBigInt(lessons)
      }
    });
  } catch (error) {
    console.error('Get module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du module'
    });
  }
};

export const createModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId } = req.params;
    const { title, description, order_index, is_published } = req.body;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir l'ID en nombre
    const courseIdNum = Number(courseId);
    
    if (isNaN(courseIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours invalide" 
      });
    }

    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Le titre est requis'
      });
    }

    // Vérifier que le cours existe et appartient à l'instructeur
    const [course] = await query(
      'SELECT id FROM courses WHERE id = ? AND (instructor_id = ? OR ? = "admin")',
      [courseIdNum, user.id, user.role]
    );

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Cours non trouvé ou accès non autorisé'
      });
    }

    // Trouver le prochain order_index si non spécifié
    let orderIndex = order_index;
    if (!orderIndex) {
      const [lastModule]: any = await query(
        `SELECT MAX(order_index) as max_order FROM modules WHERE course_id = ?`,
        [courseIdNum]
      );
      orderIndex = (lastModule.max_order || 0) + 1;
    }

    const result = await query(`
      INSERT INTO modules (course_id, title, description, order_index, is_published, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
    `, [courseIdNum, title, description, orderIndex, is_published !== undefined ? is_published : 1]);

    res.status(201).json({
      success: true,
      message: 'Module créé avec succès',
      data: { id: (result as any).insertId }
    });
  } catch (error) {
    console.error('Create module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création du module'
    });
  }
};

export const updateModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;
    const { title, description, order_index, is_published } = req.body;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir les IDs en nombres
    const courseIdNum = Number(courseId);
    const moduleIdNum = Number(moduleId);
    
    if (isNaN(courseIdNum) || isNaN(moduleIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours ou module invalide" 
      });
    }

    // Vérifier que le module existe et appartient à l'instructeur
    const [module]: any = await query(`
      SELECT m.*, c.instructor_id
      FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ?
    `, [moduleIdNum, courseIdNum]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé'
      });
    }

    // Vérifier les permissions
    if (user.role !== 'admin' && user.id !== module.instructor_id) {
      return res.status(403).json({
        success: false,
        message: 'Non autorisé à modifier ce module'
      });
    }

    await query(`
      UPDATE modules 
      SET title = ?, description = ?, order_index = ?, is_published = ?, updated_at = NOW()
      WHERE id = ?
    `, [
      title || module.title,
      description !== undefined ? description : module.description,
      order_index !== undefined ? order_index : module.order_index,
      is_published !== undefined ? is_published : module.is_published,
      moduleIdNum
    ]);

    res.json({
      success: true,
      message: 'Module mis à jour avec succès'
    });
  } catch (error) {
    console.error('Update module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour du module'
    });
  }
};

export const deleteModule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Non authentifié" 
      });
    }

    // Convertir les IDs en nombres
    const courseIdNum = Number(courseId);
    const moduleIdNum = Number(moduleId);
    
    if (isNaN(courseIdNum) || isNaN(moduleIdNum)) {
      return res.status(400).json({ 
        success: false, 
        message: "ID de cours ou module invalide" 
      });
    }

    // Vérifier que le module existe et appartient à l'instructeur
    const [module]: any = await query(`
      SELECT m.*, c.instructor_id
      FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ?
    `, [moduleIdNum, courseIdNum]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé'
      });
    }

    // Vérifier les permissions
    if (user.role !== 'admin' && user.id !== module.instructor_id) {
      return res.status(403).json({
        success: false,
        message: 'Non autorisé à supprimer ce module'
      });
    }

    await query('DELETE FROM modules WHERE id = ?', [moduleIdNum]);

    // Réorganiser les order_index des modules restants
    await query(
      `UPDATE modules 
       SET order_index = order_index - 1 
       WHERE course_id = ? AND order_index > ?`,
      [courseIdNum, module.order_index]
    );

    res.json({
      success: true,
      message: 'Module supprimé avec succès'
    });
  } catch (error) {
    console.error('Delete module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression du module'
    });
  }
};

// ================= HELPER FUNCTIONS =================
async function isUserEnrolled(courseId: number, userId: number): Promise<boolean> {
  const [enrollment]: any = await query(
    `SELECT id FROM course_enrollments 
     WHERE course_id = ? AND user_id = ? AND is_approved = 1`,
    [courseId, userId]
  );
  return !!enrollment;
}