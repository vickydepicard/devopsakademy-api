import { Router, Response } from 'express';
import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../config/database';
import { AuthenticatedRequest } from '../middleware/auth'; // IMPORTANT: Importer depuis auth.ts
import { authorizeRoles } from '../middleware/auth'; // Pour adminAuth

// Créer adminAuth à partir de authorizeRoles
const adminAuth = authorizeRoles(['admin']);

// Interface pour les fichiers de soumission
interface SubmissionFile {
  submission_id: number;
  filename: string;
  original_filename: string;
  file_path: string;
  file_size: number;
  file_type: string;
}

const router = Router();

// Configuration multer avec typage
const storage = multer.diskStorage({
  destination: (req: AuthenticatedRequest, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
    const userId = req.user?.id || 'unknown';
    const uploadDir = `uploads/submissions/${userId}`;
    
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req: AuthenticatedRequest, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req: AuthenticatedRequest, file: Express.Multer.File, cb: FileFilterCallback) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'image/jpeg',
      'image/png',
      'text/plain',
      'application/json',
      'application/x-yaml'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format de fichier non supporté'));
    }
  }
});

// Routes étudiant
router.post('/', upload.array('files'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, description, course_id } = req.body;
    
    // Vérifier que l'utilisateur est connecté
    if (!req.user?.id) {
      return res.status(401).json({ 
        success: false, 
        message: 'Non authentifié' 
      });
    }
    
    // Vérifier que l'utilisateur est inscrit au cours
    const enrollment = await query(
      'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND is_approved = true',
      [req.user.id, course_id]
    );
    
    if (!enrollment || (Array.isArray(enrollment) && enrollment.length === 0)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Vous devez être inscrit et validé dans ce cours pour soumettre des travaux' 
      });
    }
    
    // Compter les tentatives précédentes
    const attempts = await query(
      'SELECT COUNT(*) FROM submissions WHERE user_id = $1 AND course_id = $2 AND title = $3',
      [req.user.id, course_id, title]
    );
    
    const attemptCount = Array.isArray(attempts) && attempts[0]?.count 
      ? parseInt(attempts[0].count) + 1 
      : 1;
    
    // Créer la soumission
    const submissionResult = await query(
      `INSERT INTO submissions 
       (title, description, course_id, user_id, attempt) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [title, description, course_id, req.user.id, attemptCount]
    );
    
    const submission = Array.isArray(submissionResult) && submissionResult[0] 
      ? submissionResult[0] 
      : null;
    
    if (!submission) {
      throw new Error('Erreur lors de la création de la soumission');
    }
    
    // Enregistrer les fichiers
    const files = (req.files as Express.Multer.File[]).map((file: Express.Multer.File) => ({
      submission_id: submission.id,
      filename: file.filename,
      original_filename: file.originalname,
      file_path: file.path,
      file_size: file.size,
      file_type: file.mimetype
    }));
    
    for (const file of files) {
      await query(
        `INSERT INTO submission_files 
         (submission_id, filename, original_filename, file_path, file_size, file_type) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [file.submission_id, file.filename, file.original_filename, file.file_path, file.file_size, file.file_type]
      );
    }
    
    // Notification pour l'étudiant
    await query(
      `INSERT INTO notifications 
       (user_id, title, message, type) 
       VALUES ($1, $2, $3, $4)`,
      [
        req.user.id,
        '📤 Soumission envoyée',
        'Votre travail a été soumis avec succès. L\'administrateur le validera sous peu.',
        'info'
      ]
    );
    
    // Notification pour tous les admins
    const admins = await query('SELECT id FROM users WHERE role = $1', ['admin']);
    
    if (Array.isArray(admins)) {
      for (const admin of admins) {
        await query(
          `INSERT INTO notifications 
           (user_id, title, message, type) 
           VALUES ($1, $2, $3, $4)`,
          [
            admin.id,
            '📝 Nouvelle soumission à examiner',
            `Nouveau travail soumis par ${req.user.first_name || 'Utilisateur'} ${req.user.last_name || ''} pour le cours #${course_id}`,
            'warning'
          ]
        );
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Soumission envoyée avec succès',
      data: {
        ...submission,
        files: files.map((f: SubmissionFile) => ({
          name: f.original_filename,
          url: `/api/submissions/files/${f.filename}`,
          size: f.file_size
        }))
      }
    });
    
  } catch (error: unknown) {
    console.error('Erreur soumission:', error);
    const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
    res.status(500).json({ success: false, message: errorMessage });
  }
});

// Routes admin - avec adminAuth
router.get('/admin', adminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status, course_id, search } = req.query;
    
    let queryText = `
      SELECT s.*, 
        u.first_name || ' ' || u.last_name as user_name,
        u.email as user_email,
        c.title as course_title,
        COALESCE(
          json_agg(
            json_build_object(
              'name', sf.original_filename,
              'url', CONCAT('/api/submissions/files/', sf.filename),
              'size', sf.file_size
            )
          ) FILTER (WHERE sf.id IS NOT NULL), '[]'
        ) as files
      FROM submissions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN courses c ON s.course_id = c.id
      LEFT JOIN submission_files sf ON s.id = sf.submission_id
    `;
    
    const whereClauses = [];
    const params: any[] = [];
    let paramIndex = 1;
    
    if (status && status !== 'all') {
      whereClauses.push(`s.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    
    if (course_id) {
      whereClauses.push(`s.course_id = $${paramIndex}`);
      params.push(course_id);
      paramIndex++;
    }
    
    if (search) {
      whereClauses.push(`
        (s.title ILIKE $${paramIndex} OR 
         u.first_name ILIKE $${paramIndex} OR 
         u.last_name ILIKE $${paramIndex} OR 
         c.title ILIKE $${paramIndex})
      `);
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    if (whereClauses.length > 0) {
      queryText += ' WHERE ' + whereClauses.join(' AND ');
    }
    
    queryText += ' GROUP BY s.id, u.id, c.id ORDER BY s.created_at DESC';
    
    const result = await query(queryText, params);
    
    res.json({ 
      success: true, 
      data: result 
    });
    
  } catch (error: unknown) {
    console.error('Erreur récupération soumissions:', error);
    const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
    res.status(500).json({ success: false, message: errorMessage });
  }
});

router.patch('/admin/:id/review', adminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status, feedback, grade } = req.body;
    
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Non authentifié' });
    }
    
    const submissionResult = await query(
      `UPDATE submissions 
       SET status = $1, feedback = $2, grade = $3, reviewed_by = $4, reviewed_at = NOW() 
       WHERE id = $5 
       RETURNING *`,
      [status, feedback, grade, req.user.id, id]
    );
    
    const submission = Array.isArray(submissionResult) && submissionResult[0] 
      ? submissionResult[0] 
      : null;
    
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Soumission non trouvée' });
    }
    
    // Notification à l'étudiant
    const notificationTitle = status === 'approved' 
      ? '🎉 Votre soumission a été validée !' 
      : '📝 Retour sur votre soumission';
    
    const notificationMessage = status === 'approved'
      ? 'Félicitations ! Votre travail a été approuvé par l\'administrateur.'
      : `Votre soumission nécessite des corrections. Feedback: ${feedback || 'Aucun feedback fourni'}`;
    
    await query(
      `INSERT INTO notifications 
       (user_id, title, message, type, data) 
       VALUES ($1, $2, $3, $4, $5)`,
      [
        submission.user_id,
        notificationTitle,
        notificationMessage,
        status === 'approved' ? 'success' : 'warning',
        JSON.stringify({ submission_id: parseInt(id), course_id: submission.course_id })
      ]
    );
    
    // Mettre à jour la progression du cours si validé
    if (status === 'approved') {
      await query(
        `UPDATE user_progress 
         SET submissions_completed = submissions_completed + 1,
             last_activity = NOW()
         WHERE user_id = $1 AND course_id = $2`,
        [submission.user_id, submission.course_id]
      );
    }
    
    res.json({ 
      success: true, 
      message: 'Soumission mise à jour avec succès',
      data: submission
    });
    
  } catch (error: unknown) {
    console.error('Erreur revue soumission:', error);
    const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
    res.status(500).json({ success: false, message: errorMessage });
  }
});

// Route pour télécharger les fichiers
router.get('/files/:filename', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;
    
    const fileResult = await query(
      'SELECT * FROM submission_files WHERE filename = $1',
      [filename]
    );
    
    const file = Array.isArray(fileResult) && fileResult[0] 
      ? fileResult[0] 
      : null;
    
    if (!file) {
      return res.status(404).json({ success: false, message: 'Fichier non trouvé' });
    }
    
    // Vérifier les permissions
    const isOwnerResult = await query(
      'SELECT 1 FROM submissions WHERE id = $1 AND user_id = $2',
      [file.submission_id, req.user?.id]
    );
    
    const isOwner = Array.isArray(isOwnerResult) && isOwnerResult.length > 0;
    const isAdmin = req.user?.role === 'admin';
    
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Accès non autorisé' });
    }
    
    const filePath = path.join(__dirname, '../', file.file_path);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Fichier non trouvé sur le serveur' });
    }
    
    res.download(filePath, file.original_filename);
    
  } catch (error: unknown) {
    console.error('Erreur téléchargement fichier:', error);
    const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
    res.status(500).json({ success: false, message: errorMessage });
  }
});

export default router;