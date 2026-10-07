// src/services/notification.service.ts
// Notifications in-app (table `notifications`) + push temps réel (SSE) + email aux admins
import { Response } from "express";
import { query } from "../config/database";
import { sendAdminAlertEmail } from "./mail.service";

export type NotificationType =
  | "info" | "success" | "warning"
  | "new_user" | "new_contact" | "payment_proof" | "new_enrollment"
  | "instructor_application" | "bootcamp_registration" | "new_review"
  | "system";

export interface NotificationInput {
  type?: NotificationType | string;
  title: string;
  message?: string;
  link?: string;                 // route frontend, ex: /admin/enrollments
  data?: Record<string, unknown>;
}

// ══════════════════════════════════════
// TABLE
// ══════════════════════════════════════
export const ensureNotificationsTable = async (): Promise<void> => {
  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      type VARCHAR(50) NOT NULL DEFAULT 'info',
      title VARCHAR(255) NOT NULL,
      message TEXT,
      link VARCHAR(255) NULL,
      data JSON NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_read (user_id, is_read),
      INDEX idx_user_created (user_id, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
};

// ══════════════════════════════════════
// SSE : connexions ouvertes par utilisateur
// ══════════════════════════════════════
const clients = new Map<number, Set<Response>>();

export const addSseClient = (userId: number, res: Response): (() => void) => {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(res);
  return () => {
    const set = clients.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) clients.delete(userId);
  };
};

const pushToUser = (userId: number, payload: unknown) => {
  const set = clients.get(userId);
  if (!set) return;
  const frame = `event: notification\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch { /* connexion morte, nettoyée au close */ }
  }
};

// ══════════════════════════════════════
// CRÉATION
// ══════════════════════════════════════
// La colonne `data` n'existe pas dans toutes les bases (le dump d'origine ne la contient pas) :
// on la détecte une fois, sans quoi chaque insertion échouait silencieusement.
let hasDataColumn: boolean | null = null;
const detectDataColumn = async (): Promise<boolean> => {
  if (hasDataColumn !== null) return hasDataColumn;
  try {
    const rows: any[] = await query("SHOW COLUMNS FROM notifications LIKE 'data'");
    hasDataColumn = rows.length > 0;
  } catch {
    hasDataColumn = false;
  }
  return hasDataColumn;
};

export const createNotification = async (
  userId: number,
  { type = "info", title, message, link, data }: NotificationInput
): Promise<void> => {
  const withData = await detectDataColumn();
  const result: any = withData
    ? await query(
        `INSERT INTO notifications (user_id, type, title, message, link, data) VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, type, title.slice(0, 255), message ?? "", link ?? null, data ? JSON.stringify(data) : null]
      )
    : await query(
        `INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)`,
        [userId, type, title.slice(0, 255), message ?? "", link ?? null]
      );
  pushToUser(userId, {
    id: Number(result.insertId), user_id: userId, type, title,
    message: message ?? "", link: link ?? null, data: data ?? null,
    is_read: 0, created_at: new Date().toISOString(),
  });
};

// Destinataires email : ADMIN_EMAIL (liste séparée par virgules) s'il est défini ;
// sinon repli sur les emails des comptes admin actifs.
const getAdminEmails = (admins: { email: string }[]): string[] => {
  const fromEnv = (process.env.ADMIN_EMAIL || "").split(",").map(e => e.trim()).filter(Boolean);
  return fromEnv.length ? [...new Set(fromEnv)] : [...new Set(admins.map(a => a.email))];
};

/**
 * Notifie TOUS les administrateurs : cloche in-app + push temps réel + email.
 * Ne lève jamais d'exception → à appeler sans bloquer le flux métier.
 * `emailReplyTo` : permet à l'admin de répondre directement à l'expéditeur (ex: contact).
 */
export const notifyAdmins = async (
  input: NotificationInput,
  opts: { email?: boolean; emailReplyTo?: string } = {}
): Promise<void> => {
  try {
    const admins: any[] = await query(
      "SELECT id, email FROM users WHERE role = 'admin' AND is_active = 1"
    );

    await Promise.all(
      admins.map(a =>
        createNotification(Number(a.id), input).catch(e =>
          console.warn(`Notification admin #${a.id}:`, e.message)
        )
      )
    );

    const emailEnabled = opts.email !== false && process.env.ADMIN_NOTIFY_EMAIL !== "false";
    const recipients = getAdminEmails(admins);
    if (emailEnabled && recipients.length) {
      await sendAdminAlertEmail(
        recipients, input.title, input.message || "", input.link, opts.emailReplyTo
      ).catch(e => console.warn("Email admin non envoyé:", e.message));
    }
  } catch (err: any) {
    console.warn("notifyAdmins:", err?.message || err);
  }
};
