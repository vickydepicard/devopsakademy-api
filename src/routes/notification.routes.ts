// src/routes/notification.routes.ts
import { Router, Response } from "express";
import { query } from "../config/database";
import { authenticate, authorizeRoles, AuthenticatedRequest } from "../middleware/auth";
import { addSseClient, createNotification } from "../services/notification.service";
import { sendAdminAlertEmail } from "../services/mail.service";
import { tr } from "../utils/lang";

const router = Router();
router.use(authenticate);

const parseData = (row: any) => {
  if (row.data && typeof row.data === "string") {
    try { row.data = JSON.parse(row.data); } catch { row.data = null; }
  }
  return { ...row, data: row.data ?? null, id: Number(row.id), is_read: Number(row.is_read) };
};

// GET /api/notifications?limit=50&unread=1
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    const rows: any[] = await query(
      `SELECT *
       FROM notifications
       WHERE user_id = ? ${unreadOnly ? "AND is_read = 0" : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}`,
      [req.user!.id]
    );
    const [{ count }]: any = await query(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
      [req.user!.id]
    );
    res.json({ success: true, data: { notifications: rows.map(parseData), unread_count: Number(count) } });
  } catch (err) {
    console.error("GET /notifications:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// GET /api/notifications/unread-count
router.get("/unread-count", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [{ count }]: any = await query(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
      [req.user!.id]
    );
    res.json({ success: true, data: { unread_count: Number(count) } });
  } catch (err) {
    console.error("GET /notifications/unread-count:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// GET /api/notifications/stream — flux temps réel (SSE).
// Le client utilise fetch() avec le header Authorization (EventSource ne le permet pas).
router.get("/stream", (req: AuthenticatedRequest, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx : pas de buffering
  });
  res.write("retry: 5000\n\n");

  const remove = addSseClient(req.user!.id, res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    remove();
  });
});

// PATCH /api/notifications/read-all  (déclaré avant /:id)
router.patch("/read-all", async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [req.user!.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /notifications/read-all:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// PATCH /api/notifications/:id/read
router.patch("/:id/read", async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", [Number(req.params.id), req.user!.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /notifications/:id/read:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// DELETE /api/notifications/:id
router.delete("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query("DELETE FROM notifications WHERE id = ? AND user_id = ?", [Number(req.params.id), req.user!.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /notifications/:id:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// POST /api/notifications/test  (admin) — vérifie la chaîne complète : cloche + email SMTP
router.post("/test", authorizeRoles(["admin"]), async (req: AuthenticatedRequest, res: Response) => {
  const to = (req.body?.email as string) || process.env.ADMIN_EMAIL || req.user!.email;
  try {
    await createNotification(req.user!.id, {
      type: "system", title: "Test de notification", message: "Si vous voyez ceci, la cloche fonctionne.", link: "/admin/notifications",
    });
    if (!to) return res.status(400).json({ success: false, message: tr(req, "Aucune adresse (ADMIN_EMAIL manquant)", "No address (ADMIN_EMAIL missing)") });
    await sendAdminAlertEmail(to, "Test de notification", "Si vous recevez cet email, les alertes admin fonctionnent.", "/admin/notifications");
    res.json({ success: true, message: tr(req, `Notification créée et email envoyé à ${to}`, `Notification created and email sent to ${to}`) });
  } catch (err: any) {
    console.error("POST /notifications/test:", err);
    res.status(500).json({ success: false, message: tr(req, "Échec envoi email", "Email sending failed"), error: err.message });
  }
});

// POST /api/notifications  (admin/instructeur → notifier un utilisateur ; utilisé par AdminSubmissionReview)
router.post("/", authorizeRoles(["admin", "instructor"]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { user_id, title, message, type, link } = req.body;
    if (!user_id || !title)
      return res.status(400).json({ success: false, message: tr(req, "user_id et title requis", "user_id and title required") });
    await createNotification(Number(user_id), { type: type || "info", title, message, link });
    res.status(201).json({ success: true });
  } catch (err) {
    console.error("POST /notifications:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

export default router;
