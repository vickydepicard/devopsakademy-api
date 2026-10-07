import { Request, Response } from 'express';
import { query } from '../config/database';
import { notifyAdmins } from '../services/notification.service';
import { tr } from "../utils/lang";

const uid = (req: Request): number | null => ((req as any).user?.id ? Number((req as any).user.id) : null);
const isStaff = (req: Request) => ['admin', 'superadmin'].includes((req as any).user?.role);
const num = (v: any) => (v === undefined || v === null ? v : Number(v));
const serverError = (req: Request, res: Response, e: unknown, fr: string, en: string) => {
  console.error(fr, e);
  return res.status(500).json({ success: false, message: tr(req, fr, en) });
};

// Normalise les colonnes BigInt/Date renvoyées par le driver
const clean = (row: any) => {
  const o: any = {};
  for (const [k, v] of Object.entries(row || {})) {
    o[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return o;
};

export const getCategories = async (req: Request, res: Response) => {
  try {
    const rows = await query(`
      SELECT c.id, c.name, c.slug, c.description, c.icon, c.order_index,
             (SELECT COUNT(*) FROM forum_topics t WHERE t.category_id = c.id AND t.is_approved = 1) AS topic_count
        FROM forum_categories c
       WHERE c.is_active = 1
       ORDER BY c.order_index, c.name
    `);
    res.json({ success: true, data: rows.map(clean) });
  } catch (e) {
    serverError(req, res, e, "Erreur lors de la récupération des catégories", "Error while retrieving categories");
  }
};

export const getThreads = async (req: Request, res: Response) => {
  try {
    const q = req.query as any;
    const categoryId = q.category_id || q.category;
    const page = Math.max(1, parseInt(q.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(q.limit) || 20));
    const where: string[] = ['t.is_approved = 1'];
    const params: any[] = [];

    if (categoryId && /^\d+$/.test(String(categoryId))) { where.push('t.category_id = ?'); params.push(Number(categoryId)); }
    if (q.course && /^\d+$/.test(String(q.course)))       { where.push('t.course_id = ?');   params.push(Number(q.course)); }
    if (q.search && String(q.search).trim()) {
      where.push('(t.title LIKE ? OR t.content LIKE ?)');
      const like = `%${String(q.search).trim().slice(0, 100)}%`;
      params.push(like, like);
    }
    if (q.filter === 'unanswered') where.push('t.post_count = 0');
    if (q.filter === 'resolved')   where.push('t.is_resolved = 1');
    if (q.filter === 'mine' && uid(req)) { where.push('t.author_id = ?'); params.push(uid(req)); }

    const order = q.sort === 'popular'
      ? 't.is_pinned DESC, t.view_count DESC, t.last_post_at DESC'
      : 't.is_pinned DESC, COALESCE(t.last_post_at, t.created_at) DESC';
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const rows = await query(`
      SELECT t.id, t.title, t.content, t.category_id, t.course_id, t.is_pinned, t.is_locked, t.is_resolved,
             t.view_count, t.post_count, t.created_at, t.last_post_at,
             t.author_id AS user_id,
             u.first_name AS author_first_name, u.last_name AS author_last_name, u.role AS author_role,
             up.avatar_url AS author_avatar,
             c.name AS category_name, co.title AS course_title
        FROM forum_topics t
        LEFT JOIN users u ON u.id = t.author_id
        LEFT JOIN user_profiles up ON up.user_id = t.author_id
        LEFT JOIN forum_categories c ON c.id = t.category_id
        LEFT JOIN courses co ON co.id = t.course_id
        ${whereSql}
       ORDER BY ${order}
       LIMIT ? OFFSET ?
    `, [...params, limit, (page - 1) * limit]);

    const [cnt] = await query(`SELECT COUNT(*) AS total FROM forum_topics t ${whereSql}`, params);
    const total = Number(cnt?.total || 0);

    const data = rows.map((r: any) => {
      const o = clean(r);
      o.message_count = o.post_count;
      o.views = o.view_count;
      if (o.content) o.content = String(o.content).slice(0, 220);
      return o;
    });

    res.json({
      success: true, data, total,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    serverError(req, res, e, "Erreur lors de la récupération des discussions", "Error while retrieving discussions");
  }
};

export const createThread = async (req: Request, res: Response) => {
  try {
    const { title, content, category_id, course_id, lesson_id } = req.body || {};
    const authorId = uid(req)!;
    const cleanTitle = String(title || '').trim();
    const cleanContent = String(content || '').trim();

    if (!cleanTitle || !cleanContent) {
      return res.status(400).json({ success: false, message: tr(req, "Titre et contenu sont requis", "Title and content are required") });
    }
    if (cleanTitle.length < 5)   return res.status(400).json({ success: false, message: tr(req, "Le titre est trop court (5 caractères minimum)", "Title is too short (5 characters minimum)") });
    if (cleanTitle.length > 200) return res.status(400).json({ success: false, message: tr(req, "Le titre est trop long (200 caractères maximum)", "Title is too long (200 characters maximum)") });
    if (cleanContent.length > 10000) return res.status(400).json({ success: false, message: tr(req, "Message trop long", "Message too long") });

    let catId = Number(category_id) || 0;
    if (catId) {
      const [c] = await query('SELECT id FROM forum_categories WHERE id = ? AND is_active = 1', [catId]);
      if (!c) return res.status(400).json({ success: false, message: tr(req, "Catégorie introuvable", "Category not found") });
    } else {
      const [c] = await query('SELECT id FROM forum_categories WHERE is_active = 1 ORDER BY order_index, id LIMIT 1');
      if (!c) return res.status(400).json({ success: false, message: tr(req, "Aucune catégorie disponible", "No category available") });
      catId = Number(c.id);
    }

    const slug = cleanTitle.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 200) + "-" + Date.now();
    const result = await query(`
      INSERT INTO forum_topics (title, slug, content, author_id, category_id, course_id, lesson_id, last_post_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `, [cleanTitle, slug, cleanContent, authorId, catId, course_id ?? null, lesson_id ?? null]);

    void notifyAdmins({
      type: 'info',
      title: `Nouvelle discussion forum : ${cleanTitle.slice(0, 80)}`,
      message: cleanContent.slice(0, 300),
      link: `/forum/thread/${Number(result.insertId)}`,
      data: { topic_id: Number(result.insertId), user_id: authorId },
    }, { email: false });

    res.status(201).json({
      success: true,
      message: tr(req, "Discussion créée avec succès", "Discussion created successfully"),
      data: { id: Number(result.insertId) },
    });
  } catch (e) {
    serverError(req, res, e, "Erreur lors de la création de la discussion", "Error while creating the discussion");
  }
};

export const getThreadById = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: tr(req, "Discussion non trouvée", "Discussion not found") });

    const [thread] = await query(`
      SELECT t.*, u.first_name, u.last_name, u.role AS author_role, up.avatar_url,
             c.name AS category_name, co.title AS course_title
        FROM forum_topics t
        LEFT JOIN users u ON u.id = t.author_id
        LEFT JOIN user_profiles up ON up.user_id = t.author_id
        LEFT JOIN forum_categories c ON c.id = t.category_id
        LEFT JOIN courses co ON co.id = t.course_id
       WHERE t.id = ? AND (t.is_approved = 1 OR t.author_id = ?)
    `, [id, uid(req) ?? 0]);
    if (!thread) return res.status(404).json({ success: false, message: tr(req, "Discussion non trouvée", "Discussion not found") });

    await query('UPDATE forum_topics SET view_count = view_count + 1 WHERE id = ?', [id]);

    const posts = await query(`
      SELECT p.id, p.topic_id, p.author_id, p.parent_post_id, p.content, p.is_answer, p.is_best_answer,
             p.created_at, p.edited_at,
             u.first_name, u.last_name, u.role AS author_role, up.avatar_url
        FROM forum_posts p
        LEFT JOIN users u ON u.id = p.author_id
        LEFT JOIN user_profiles up ON up.user_id = p.author_id
       WHERE p.topic_id = ? AND p.is_approved = 1
       ORDER BY p.created_at ASC, p.id ASC
    `, [id]);

    const me = uid(req);
    const t = clean(thread);
    res.json({
      success: true,
      data: {
        ...t,
        view_count: Number(t.view_count) + 1,
        can_manage: !!me && (me === Number(t.author_id) || isStaff(req)),
        can_moderate: isStaff(req),
        posts: posts.map((p: any) => ({ ...clean(p), can_delete: !!me && (me === Number(p.author_id) || isStaff(req)) })),
      },
    });
  } catch (e) {
    serverError(req, res, e, "Erreur lors de la récupération de la discussion", "Error while retrieving the discussion");
  }
};

export const createMessage = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { parent_post_id } = req.body || {};
    const content = String(req.body?.content || '').trim();
    const authorId = uid(req)!;

    if (!content) return res.status(400).json({ success: false, message: tr(req, "Le contenu du message est requis", "The message content is required") });
    if (content.length > 10000) return res.status(400).json({ success: false, message: tr(req, "Message trop long", "Message too long") });

    const [thread] = await query('SELECT id, author_id, title, is_locked FROM forum_topics WHERE id = ?', [id]);
    if (!thread) return res.status(404).json({ success: false, message: tr(req, "Discussion non trouvée", "Discussion not found") });
    if (thread.is_locked && !isStaff(req)) {
      return res.status(403).json({ success: false, message: tr(req, "Cette discussion est verrouillée", "This discussion is locked") });
    }

    let parentId: number | null = null;
    if (parent_post_id) {
      const [pp] = await query('SELECT id FROM forum_posts WHERE id = ? AND topic_id = ?', [Number(parent_post_id), id]);
      parentId = pp ? Number(pp.id) : null;
    }

    const r = await query(
      'INSERT INTO forum_posts (content, author_id, topic_id, parent_post_id) VALUES (?, ?, ?, ?)',
      [content, authorId, id, parentId]
    );
    await query(
      'UPDATE forum_topics SET last_post_at = NOW(), last_post_id = ?, post_count = post_count + 1 WHERE id = ?',
      [Number(r.insertId), id]
    );

    // Prévenir l'auteur du sujet (in-app), sauf s'il répond lui-même
    if (Number(thread.author_id) !== authorId) {
      try {
        await query(
          "INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, 'info', ?, ?, ?)",
          [Number(thread.author_id), `Nouvelle réponse : ${String(thread.title).slice(0, 80)}`, content.slice(0, 200), `/forum/thread/${id}`]
        );
      } catch { /* schéma de notifications différent : non bloquant */ }
    }

    res.status(201).json({
      success: true,
      message: tr(req, "Message ajouté avec succès", "Message added successfully"),
      data: { id: Number(r.insertId) },
    });
  } catch (e) {
    serverError(req, res, e, "Erreur lors de l'ajout du message", "Error while adding the message");
  }
};

// DELETE /forum/threads/:id — auteur ou admin
export const deleteThread = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const [t] = await query('SELECT id, author_id FROM forum_topics WHERE id = ?', [id]);
    if (!t) return res.status(404).json({ success: false, message: tr(req, "Discussion non trouvée", "Discussion not found") });
    if (Number(t.author_id) !== uid(req) && !isStaff(req)) {
      return res.status(403).json({ success: false, message: tr(req, "Action non autorisée", "Not allowed") });
    }
    await query('DELETE FROM forum_posts WHERE topic_id = ?', [id]);
    await query('DELETE FROM forum_topics WHERE id = ?', [id]);
    res.json({ success: true, message: tr(req, "Discussion supprimée", "Discussion deleted") });
  } catch (e) {
    serverError(req, res, e, "Erreur lors de la suppression", "Error while deleting");
  }
};

// DELETE /forum/posts/:id — auteur ou admin
export const deletePost = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const [p] = await query('SELECT id, author_id, topic_id FROM forum_posts WHERE id = ?', [id]);
    if (!p) return res.status(404).json({ success: false, message: tr(req, "Message introuvable", "Message not found") });
    if (Number(p.author_id) !== uid(req) && !isStaff(req)) {
      return res.status(403).json({ success: false, message: tr(req, "Action non autorisée", "Not allowed") });
    }
    await query('UPDATE forum_posts SET parent_post_id = NULL WHERE parent_post_id = ?', [id]);
    await query('DELETE FROM forum_posts WHERE id = ?', [id]);
    await query(
      'UPDATE forum_topics SET post_count = (SELECT COUNT(*) FROM forum_posts WHERE topic_id = ?) WHERE id = ?',
      [Number(p.topic_id), Number(p.topic_id)]
    );
    res.json({ success: true, message: tr(req, "Message supprimé", "Message deleted") });
  } catch (e) {
    serverError(req, res, e, "Erreur lors de la suppression", "Error while deleting");
  }
};

// PATCH /forum/threads/:id — résolu (auteur/admin), épinglé & verrouillé (admin)
export const updateThread = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const [t] = await query('SELECT id, author_id FROM forum_topics WHERE id = ?', [id]);
    if (!t) return res.status(404).json({ success: false, message: tr(req, "Discussion non trouvée", "Discussion not found") });
    const owner = Number(t.author_id) === uid(req);
    if (!owner && !isStaff(req)) return res.status(403).json({ success: false, message: tr(req, "Action non autorisée", "Not allowed") });

    const sets: string[] = []; const vals: any[] = [];
    const b = req.body || {};
    if (b.is_resolved !== undefined) { sets.push('is_resolved = ?'); vals.push(b.is_resolved ? 1 : 0); }
    if (isStaff(req)) {
      if (b.is_pinned !== undefined) { sets.push('is_pinned = ?'); vals.push(b.is_pinned ? 1 : 0); }
      if (b.is_locked !== undefined) { sets.push('is_locked = ?'); vals.push(b.is_locked ? 1 : 0); }
    }
    if (!sets.length) return res.status(400).json({ success: false, message: tr(req, "Rien à modifier", "Nothing to update") });
    await query(`UPDATE forum_topics SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    res.json({ success: true, message: tr(req, "Discussion mise à jour", "Discussion updated") });
  } catch (e) {
    serverError(req, res, e, "Erreur lors de la mise à jour", "Error while updating");
  }
};
