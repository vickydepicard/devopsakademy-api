import { Request, Response } from 'express';
import { query } from '../config/database';

export const getCategories = async (req: Request, res: Response) => {
  try {
    const categories = await query(`
      SELECT * FROM forum_categories 
      WHERE is_active = TRUE 
      ORDER BY order_index
    `);

    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des catégories'
    });
  }
};

export const getThreads = async (req: Request, res: Response) => {
  try {
    const { category, course, page = 1, limit = 20 } = req.query;
    let whereClause = 'WHERE t.is_approved = TRUE';
    const params: any[] = [];

    if (category) {
      whereClause += ' AND t.category_id = ?';
      params.push(category);
    }

    if (course) {
      whereClause += ' AND t.course_id = ?';
      params.push(course);
    }

    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const threads = await query(`
      SELECT 
        t.*,
        u.first_name,
        u.last_name,
        c.name as category_name,
        co.title as course_title,
        (SELECT COUNT(*) FROM forum_posts WHERE thread_id = t.id) as post_count
      FROM forum_topics t
      LEFT JOIN users u ON t.author_id = u.id
      LEFT JOIN forum_categories c ON t.category_id = c.id
      LEFT JOIN courses co ON t.course_id = co.id
      ${whereClause}
      ORDER BY t.is_pinned DESC, t.last_post_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit as string), offset]);

    const [total] = await query(`
      SELECT COUNT(*) as total FROM forum_topics t ${whereClause}
    `, params);

    res.json({
      success: true,
      data: threads,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: total.total,
        pages: Math.ceil(total.total / parseInt(limit as string))
      }
    });
  } catch (error) {
    console.error('Get threads error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des discussions'
    });
  }
};

export const createThread = async (req: Request, res: Response) => {
  try {
    const { title, content, category_id, course_id, lesson_id } = req.body;
    const authorId = (req as any).user.id;

    if (!title || !content || !category_id) {
      return res.status(400).json({
        success: false,
        message: 'Titre, contenu et catégorie sont requis'
      });
    }

    const result = await query(`
      INSERT INTO forum_topics (title, content, author_id, category_id, course_id, lesson_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [title, content, authorId, category_id, course_id, lesson_id]);

    res.status(201).json({
      success: true,
      message: 'Discussion créée avec succès',
      data: { id: result.insertId }
    });
  } catch (error) {
    console.error('Create thread error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la discussion'
    });
  }
};

export const getThreadById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const [thread] = await query(`
      SELECT 
        t.*,
        u.first_name,
        u.last_name,
        c.name as category_name,
        co.title as course_title
      FROM forum_topics t
      LEFT JOIN users u ON t.author_id = u.id
      LEFT JOIN forum_categories c ON t.category_id = c.id
      LEFT JOIN courses co ON t.course_id = co.id
      WHERE t.id = ?
    `, [id]);

    if (!thread) {
      return res.status(404).json({
        success: false,
        message: 'Discussion non trouvée'
      });
    }

    // Incrémenter le compteur de vues
    await query(`
      UPDATE forum_topics SET view_count = view_count + 1 WHERE id = ?
    `, [id]);

    // Récupérer les messages
    const posts = await query(`
      SELECT 
        p.*,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM forum_posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.thread_id = ?
      ORDER BY p.created_at ASC
    `, [id]);

    res.json({
      success: true,
      data: {
        ...thread,
        posts
      }
    });
  } catch (error) {
    console.error('Get thread error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la discussion'
    });
  }
};

export const createMessage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { content, parent_post_id } = req.body;
    const authorId = (req as any).user.id;

    if (!content) {
      return res.status(400).json({
        success: false,
        message: 'Le contenu du message est requis'
      });
    }

    // Vérifier que la discussion existe
    const [thread] = await query(
      'SELECT id FROM forum_topics WHERE id = ?',
      [id]
    );

    if (!thread) {
      return res.status(404).json({
        success: false,
        message: 'Discussion non trouvée'
      });
    }

    const result = await query(`
      INSERT INTO forum_posts (content, author_id, thread_id, parent_post_id)
      VALUES (?, ?, ?, ?)
    `, [content, authorId, id, parent_post_id]);

    // Mettre à jour la date du dernier message
    await query(`
      UPDATE forum_topics 
      SET last_post_at = NOW(), post_count = post_count + 1 
      WHERE id = ?
    `, [id]);

    res.status(201).json({
      success: true,
      message: 'Message ajouté avec succès',
      data: { id: result.insertId }
    });
  } catch (error) {
    console.error('Create message error:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'ajout du message'
    });
  }
};