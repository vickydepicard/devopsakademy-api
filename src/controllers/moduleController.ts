import { Request, Response } from 'express';
import { query } from '../config/database';

export const getModules = async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;

    const modules = await query(`
      SELECT m.*, 
        COUNT(l.id) as lesson_count,
        SUM(l.duration_minutes) as total_duration
      FROM modules m
      LEFT JOIN lessons l ON m.id = l.module_id
      WHERE m.course_id = ?
      GROUP BY m.id
      ORDER BY m.order_index
    `, [courseId]);

    res.json({
      success: true,
      data: modules
    });
  } catch (error) {
    console.error('Get modules error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des modules'
    });
  }
};

export const getModuleById = async (req: Request, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;

    const [module] = await query(`
      SELECT m.*, c.title as course_title
      FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ?
    `, [moduleId, courseId]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé'
      });
    }

    // Récupérer les leçons du module
    const lessons = await query(`
      SELECT * FROM lessons 
      WHERE module_id = ? 
      ORDER BY order_index
    `, [moduleId]);

    res.json({
      success: true,
      data: {
        ...module,
        lessons
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

export const createModule = async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;
    const { title, description, order_index } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Le titre est requis'
      });
    }

    // Vérifier que le cours existe et appartient à l'instructeur
    const [course] = await query(
      'SELECT id FROM courses WHERE id = ? AND instructor_id = ?',
      [courseId, (req as any).user.id]
    );

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Cours non trouvé ou accès non autorisé'
      });
    }

    const result = await query(`
      INSERT INTO modules (course_id, title, description, order_index)
      VALUES (?, ?, ?, ?)
    `, [courseId, title, description, order_index || 0]);

    res.status(201).json({
      success: true,
      message: 'Module créé avec succès',
      data: { id: result.insertId }
    });
  } catch (error) {
    console.error('Create module error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création du module'
    });
  }
};

export const updateModule = async (req: Request, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;
    const { title, description, order_index } = req.body;

    // Vérifier que le module existe et appartient à l'instructeur
    const [module] = await query(`
      SELECT m.id FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ? AND c.instructor_id = ?
    `, [moduleId, courseId, (req as any).user.id]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé ou accès non autorisé'
      });
    }

    await query(`
      UPDATE modules 
      SET title = ?, description = ?, order_index = ?, updated_at = NOW()
      WHERE id = ?
    `, [title, description, order_index, moduleId]);

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

export const deleteModule = async (req: Request, res: Response) => {
  try {
    const { courseId, moduleId } = req.params;

    // Vérifier que le module existe et appartient à l'instructeur
    const [module] = await query(`
      SELECT m.id FROM modules m
      JOIN courses c ON m.course_id = c.id
      WHERE m.id = ? AND m.course_id = ? AND c.instructor_id = ?
    `, [moduleId, courseId, (req as any).user.id]);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: 'Module non trouvé ou accès non autorisé'
      });
    }

    await query('DELETE FROM modules WHERE id = ?', [moduleId]);

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