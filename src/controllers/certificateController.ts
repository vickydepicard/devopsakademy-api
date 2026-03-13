// src/controllers/certificateController.ts
import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";

/* ── GET /api/certificates/my ── */
export const getMyCertificates = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Non authentifié" });

    const certificates: any[] = await query(
      `SELECT
         cert.id,
         cert.certificate_number,
         cert.issued_at,
         cert.pdf_url,
         cert.enrollment_id,
         c.id        AS course_id,
         c.title     AS course_title,
         c.thumbnail_url,
         c.level,
         c.duration_hours,
         u.first_name,
         u.last_name,
         u.email
       FROM certificates cert
       JOIN courses c ON c.id = cert.course_id
       JOIN users   u ON u.id = cert.user_id
       WHERE cert.user_id = ? AND cert.is_revoked = 0
       ORDER BY cert.issued_at DESC`,
      [userId]
    );

    return res.json({ success: true, data: certificates });
  } catch (error) {
    console.error("getMyCertificates error:", error);
    return res.status(500).json({ success: false, message: "Erreur interne" });
  }
};

/* ── GET /api/certificates/verify/:number ── */
export const verifyCertificate = async (req: Request, res: Response) => {
  try {
    const { number } = req.params;
    if (!number)
      return res.status(400).json({ success: false, message: "Numéro requis" });

    const [cert]: any = await query(
      `SELECT
         cert.certificate_number,
         cert.issued_at,
         cert.is_revoked,
         c.title     AS course_title,
         c.level,
         c.duration_hours,
         u.first_name,
         u.last_name
       FROM certificates cert
       JOIN courses c ON c.id = cert.course_id
       JOIN users   u ON u.id = cert.user_id
       WHERE cert.certificate_number = ?`,
      [number]
    );

    if (!cert)
      return res.status(404).json({ success: false, message: "Certificat introuvable" });

    if (cert.is_revoked)
      return res.status(410).json({ success: false, message: "Ce certificat a été révoqué" });

    return res.json({ success: true, data: cert });
  } catch (error) {
    console.error("verifyCertificate error:", error);
    return res.status(500).json({ success: false, message: "Erreur interne" });
  }
};

/* ── POST /api/certificates/issue  (admin) ── */
export const issueCertificate = async (req: Request, res: Response) => {
  try {
    const { user_id, course_id } = req.body;
    if (!user_id || !course_id)
      return res.status(400).json({ success: false, message: "user_id et course_id requis" });

    // Récupérer l'enrollment (enrollment_id obligatoire)
    const [enrollment]: any = await query(
      "SELECT id FROM course_enrollments WHERE user_id = ? AND course_id = ?",
      [user_id, course_id]
    );
    if (!enrollment)
      return res.status(404).json({ success: false, message: "Inscription introuvable" });

    const certNumber = `DA-${new Date().getFullYear()}-${String(course_id).padStart(4,"0")}-${String(user_id).padStart(5,"0")}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;

    await query(
      `INSERT INTO certificates (user_id, course_id, enrollment_id, certificate_number, issued_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE issued_at = NOW()`,
      [user_id, course_id, enrollment.id, certNumber]
    );

    // Marquer 100%
    await query(
      "UPDATE course_enrollments SET completion_percentage = 100, completed_at = IFNULL(completed_at, NOW()) WHERE user_id = ? AND course_id = ?",
      [user_id, course_id]
    );

    const [cert]: any = await query(
      `SELECT cert.*, c.title AS course_title, u.first_name, u.last_name, u.email
       FROM certificates cert
       JOIN courses c ON c.id = cert.course_id
       JOIN users u   ON u.id = cert.user_id
       WHERE cert.user_id = ? AND cert.course_id = ?`,
      [user_id, course_id]
    );

    return res.status(201).json({ success: true, message: "Certificat émis", data: cert });
  } catch (error) {
    console.error("issueCertificate error:", error);
    return res.status(500).json({ success: false, message: "Erreur interne" });
  }
};

/* ── GET /api/certificates  (admin) ── */
export const getAllCertificates = async (req: Request, res: Response) => {
  try {
    const certs: any[] = await query(
      `SELECT
         cert.id,
         cert.certificate_number,
         cert.issued_at,
         cert.is_revoked,
         c.title AS course_title,
         u.id    AS user_id,
         u.first_name,
         u.last_name,
         u.email
       FROM certificates cert
       JOIN courses c ON c.id = cert.course_id
       JOIN users   u ON u.id = cert.user_id
       ORDER BY cert.issued_at DESC`
    );
    return res.json({ success: true, data: certs });
  } catch (error) {
    console.error("getAllCertificates error:", error);
    return res.status(500).json({ success: false, message: "Erreur interne" });
  }
};

/* ── DELETE /api/certificates/:id  (admin) ── */
export const deleteCertificate = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await query("DELETE FROM certificates WHERE id = ?", [id]);
    return res.json({ success: true, message: "Certificat supprimé" });
  } catch (error) {
    console.error("deleteCertificate error:", error);
    return res.status(500).json({ success: false, message: "Erreur interne" });
  }
};

export default { getMyCertificates, verifyCertificate, issueCertificate, getAllCertificates, deleteCertificate };