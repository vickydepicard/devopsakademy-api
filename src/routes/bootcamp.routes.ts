// src/routes/bootcamp.routes.ts
import express from "express";
import multer  from "multer";
import path    from "path";
import fs      from "fs";
import { authenticate, authorizeRoles, optionalAuthenticate } from "../middleware/auth";
import { query } from "../config/database";
import { notifyAdmins, createNotification } from "../services/notification.service";
import { getCourseAccess, isAdminRole } from "../utils/courseAccess";
import { getUserLang } from "../utils/lang";
import { tr } from "../utils/lang";

const router = express.Router();

// ── Droits ─────────────────────────────────────────────────────
// Les bootcamps sont administrés par l'admin (création, planification, affectation, suppression).
// L'instructeur désigné — ou l'équipe du cours rattaché — peut seulement lancer et arrêter le live.
const adminOnly = authorizeRoles(["admin", "superadmin"]);

async function canHost(user: { id: number; role: string }, bootcampId: number): Promise<"none" | "missing" | "ok"> {
  const [b]: any = await query("SELECT instructor_id, course_id FROM bootcamps WHERE id = ?", [bootcampId]);
  if (!b) return "missing";
  if (isAdminRole(user.role)) return "ok";
  if (Number(b.instructor_id) === Number(user.id)) return "ok";
  if (b.course_id) {
    const access = await getCourseAccess(user, Number(b.course_id));
    if (access.canView) return "ok";
  }
  return "none";
}

const hostGuard = async (req: any, res: any, next: any) => {
  try {
    const id = Number(req.params.id);
    const r = Number.isInteger(id) && id > 0 ? await canHost(req.user, id) : "missing";
    if (r === "missing") return res.status(404).json({ success: false, message: tr(req, "Bootcamp introuvable", "Bootcamp not found") });
    if (r === "none") return res.status(403).json({ success: false, message: tr(req, "Ce bootcamp ne vous est pas attribué.", "This bootcamp is not assigned to you.") });
    next();
  } catch {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};

async function notifyHost(instructorId: number, bootcampTitle: string, whenIso: string) {
  try {
    const en = (await getUserLang(instructorId)) === "en";
    const when = new Date(whenIso).toLocaleString(en ? "en-GB" : "fr-FR", { dateStyle: "medium", timeStyle: "short" });
    await createNotification(instructorId, {
      type: "info",
      title: en ? "Bootcamp assigned to you" : "Bootcamp qui vous est attribué",
      message: en ? `“${bootcampTitle}” — ${when}.` : `« ${bootcampTitle} » — ${when}.`,
      link: "/instructor/bootcamps",
    });
  } catch { /* notification non bloquante */ }
}

// ── Helpers ────────────────────────────────────────────────────
const toNum = (v: any) => typeof v === "bigint" ? Number(v) : Number(v ?? 0);

const sanitize = (data: any): any => {
  if (data instanceof Date) return data;
  if (Array.isArray(data)) return data.map(sanitize);
  if (data && typeof data === "object") {
    const out: any = {};
    for (const k of Object.keys(data)) {
      out[k] = typeof data[k] === "bigint" ? Number(data[k]) : sanitize(data[k]);
    }
    return out;
  }
  return data;
};

// ── Multer pour thumbnails bootcamp ───────────────────────────
const thumbDir = path.join(process.cwd(), "uploads", "bootcamps");
if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

const thumbStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, thumbDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const uploadThumb = multer({ storage: thumbStorage, limits: { fileSize: 5 * 1024 * 1024 } });


// Le statut suit l'horaire : un direct jamais arrêté ou une séance passée passent automatiquement à « terminé ».
async function syncBootcampStatuses() {
  try {
    await query(`UPDATE bootcamps SET status = 'ended'
                  WHERE (status = 'scheduled' AND DATE_ADD(scheduled_at, INTERVAL duration_minutes MINUTE) < NOW())
                     OR (status = 'live'      AND DATE_ADD(scheduled_at, INTERVAL duration_minutes + 180 MINUTE) < NOW())`);
  } catch (e) { console.error("syncBootcampStatuses:", e); }
}

// ══════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/bootcamps — liste publique (scheduled + live + ended)
router.get("/", optionalAuthenticate as any, async (req: any, res) => {
  try {
    await syncBootcampStatuses();
    const { status, limit = 20, page = 1 } = req.query as any;
    const offset = (Number(page) - 1) * Number(limit);
    const userId = req.user?.id || null;

    let where = "WHERE b.status != 'draft'";
    const params: any[] = [];

    if (status) { where += " AND b.status = ?"; params.push(status); }

    const rows = await query(`
      SELECT
        b.id, b.slug, b.title, b.description, b.thumbnail_url,
        b.scheduled_at, b.duration_minutes, b.status,
        b.is_free, b.price, b.max_participants,
        (SELECT COUNT(*) FROM bootcamp_registrations br WHERE br.bootcamp_id = b.id AND br.status = 'confirmed') AS registered_count,
        b.stream_url, b.replay_url,
        b.views_count, b.level, b.tags, b.language,
        CONCAT(u.first_name,' ',u.last_name) AS instructor_name,
        u.id AS instructor_id,
        up.avatar_url AS instructor_avatar,
        up.job_title  AS instructor_title
      FROM bootcamps b
      JOIN users u ON u.id = b.instructor_id
      LEFT JOIN user_profiles up ON up.user_id = u.id
      ${where}
      ORDER BY
        CASE b.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
        b.scheduled_at ASC
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset]);

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM bootcamps b ${where}`, params
    ) as any[];

    // Pour chaque bootcamp, vérifier si l'user connecté est inscrit
    let registeredIds = new Set<number>();
    if (userId) {
      const regs: any[] = await query(
        `SELECT bootcamp_id FROM bootcamp_registrations WHERE user_id = ?`,
        [userId]
      );
      regs.forEach((r: any) => registeredIds.add(Number(r.bootcamp_id)));
    }

    res.json({
      success: true,
      data: sanitize(rows).map((r: any) => ({
        ...r,
        tags: (() => { try { return JSON.parse(r.tags || "[]"); } catch { return []; } })(),
        is_registered: registeredIds.has(Number(r.id)),
      })),
      pagination: { total: toNum(total), page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error("GET /bootcamps error:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// GET /api/bootcamps/:id — détail public
router.get("/:id", optionalAuthenticate as any, async (req: any, res) => {
  try {
    await syncBootcampStatuses();
    const { id } = req.params;
    const key = isNaN(Number(id)) ? "b.slug" : "b.id";

    const [boot] = await query(`
      SELECT
        b.*,
        CONCAT(u.first_name,' ',u.last_name) AS instructor_name,
        u.id AS instructor_id,
        up.avatar_url AS instructor_avatar,
        up.job_title  AS instructor_title,
        up.bio        AS instructor_bio
      FROM bootcamps b
      JOIN users u ON u.id = b.instructor_id
      LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE ${key} = ? AND b.status != 'draft'
    `, [id]) as any[];

    if (!boot) return res.status(404).json({ success: false, message: tr(req, "Bootcamp introuvable", "Bootcamp not found") });

    const data = sanitize(boot);
    data.tags = (() => { try { return JSON.parse(data.tags || "[]"); } catch { return []; } })();
    const [cnt] = await query("SELECT COUNT(*) AS c FROM bootcamp_registrations WHERE bootcamp_id = ? AND status = 'confirmed'", [boot.id]) as any[];
    data.registered_count = toNum(cnt?.c);
    data.is_registered = false;
    if (req.user?.id) {
      const [reg] = await query("SELECT id FROM bootcamp_registrations WHERE bootcamp_id = ? AND user_id = ? AND status = 'confirmed'", [boot.id, req.user.id]) as any[];
      data.is_registered = !!reg;
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error("GET /bootcamps/:id error:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// ══════════════════════════════════════════════════════════════
// AUTH ROUTES (utilisateurs connectés)
// ══════════════════════════════════════════════════════════════

// GET /api/bootcamps/:id/can-host — l'utilisateur peut-il animer ce live ?
router.get("/:id/can-host", authenticate, async (req: any, res) => {
  try {
    const id = Number(req.params.id);
    const r = Number.isInteger(id) && id > 0 ? await canHost(req.user, id) : "missing";
    res.json({ success: true, can_host: r === "ok" });
  } catch {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// POST /api/bootcamps/:id/register — S'inscrire à un bootcamp
router.post("/:id/register", authenticate, async (req: any, res) => {
  try {
    await syncBootcampStatuses();
    const userId = req.user.id;
    const { id }  = req.params;

    const [boot] = await query(
      "SELECT * FROM bootcamps WHERE id = ? AND status IN ('scheduled','live')", [id]
    ) as any[];

    if (!boot) return res.status(404).json({ success: false, message: tr(req, "Bootcamp introuvable ou terminé", "Bootcamp not found or ended") });

    // Vérifier inscription existante
    const [existing] = await query(
      "SELECT id FROM bootcamp_registrations WHERE bootcamp_id = ? AND user_id = ?",
      [id, userId]
    ) as any[];
    if (existing) return res.status(409).json({ success: false, message: tr(req, "Déjà inscrit", "Already enrolled") });

    // Vérifier places disponibles
    if (boot.max_participants) {
      const [{ count }] = await query(
        "SELECT COUNT(*) AS count FROM bootcamp_registrations WHERE bootcamp_id = ? AND status = 'confirmed'",
        [id]
      ) as any[];
      if (toNum(count) >= boot.max_participants) {
        return res.status(400).json({ success: false, message: tr(req, "Complet — plus de places disponibles", "Full — no more seats available") });
      }
    }

    const paymentStatus = boot.is_free ? "free" : "pending";

    await query(
      "INSERT INTO bootcamp_registrations (bootcamp_id, user_id, payment_status, amount_paid) VALUES (?,?,?,?)",
      [id, userId, paymentStatus, boot.is_free ? 0 : boot.price]
    );

    // Incrémenter le compteur
    await query("UPDATE bootcamps SET registered_count = (SELECT COUNT(*) FROM bootcamp_registrations WHERE bootcamp_id = ? AND status = 'confirmed') WHERE id = ?", [id, id]);

    // Notifier les admins (non bloquant)
    void notifyAdmins({
      type: "bootcamp_registration",
      title: `Inscription bootcamp : ${boot.title || "#" + id}`,
      message: `${req.user.first_name || ""} ${req.user.last_name || ""} (${req.user.email || "—"}) s'est inscrit(e)${boot.is_free ? " (gratuit)." : " — paiement en attente."}`,
      link: "/admin/bootcamps",
      data: { bootcamp_id: Number(id), user_id: userId },
    });

    res.json({ success: true, message: boot.is_free ? "Inscrit avec succès !" : "Inscription enregistrée — en attente de paiement" });
  } catch (err) {
    console.error("POST /register error:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// GET /api/bootcamps/:id/messages — Récupérer le chat
router.get("/:id/messages", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { since } = req.query as any; // polling: messages après un timestamp

    let sql = `
      SELECT bm.id, bm.message, bm.is_pinned, bm.created_at,
             u.id AS user_id,
             CONCAT(u.first_name,' ',u.last_name) AS user_name,
             u.role, up.avatar_url
      FROM bootcamp_messages bm
      JOIN users u ON u.id = bm.user_id
      LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE bm.bootcamp_id = ? AND bm.is_deleted = 0
    `;
    const params: any[] = [id];

    if (since) { sql += " AND bm.created_at > ?"; params.push(since); }
    sql += " ORDER BY bm.created_at ASC LIMIT 100";

    const messages = await query(sql, params);
    res.json({ success: true, data: sanitize(messages) });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// POST /api/bootcamps/:id/messages — Envoyer un message
router.post("/:id/messages", authenticate, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const { id }  = req.params;
    const { message } = req.body;

    if (!message?.trim()) return res.status(400).json({ success: false, message: tr(req, "Message vide", "Empty message") });
    if (message.length > 500) return res.status(400).json({ success: false, message: tr(req, "Message trop long (max 500 caractères)", "Message too long (max 500 characters)") });

    // Vérifier que le bootcamp est en live
    const [boot] = await query(
      "SELECT id, status FROM bootcamps WHERE id = ?", [id]
    ) as any[];
    if (!boot) return res.status(404).json({ success: false, message: tr(req, "Bootcamp introuvable", "Bootcamp not found") });

    const result: any = await query(
      "INSERT INTO bootcamp_messages (bootcamp_id, user_id, message) VALUES (?,?,?)",
      [id, userId, message.trim()]
    );

    res.json({
      success: true,
      data: {
        id: toNum(result.insertId),
        message: message.trim(),
        user_id: userId,
        user_name: `${req.user.first_name} ${req.user.last_name}`,
        role: req.user.role,
        created_at: new Date().toISOString(),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// ══════════════════════════════════════════════════════════════
// ADMIN / INSTRUCTOR ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/bootcamps/admin/all — liste complète avec brouillons
router.get("/admin/all", authenticate, authorizeRoles(["admin","superadmin","instructor"]), async (req: any, res) => {
  try {
    const isAdmin = isAdminRole(req.user.role);
    const where   = isAdmin ? "WHERE 1=1"
      : `WHERE (b.instructor_id = ?
               OR b.course_id IN (SELECT course_id FROM course_instructors WHERE instructor_id = ? AND status = 'accepted')
               OR b.course_id IN (SELECT id FROM courses WHERE instructor_id = ?))`;
    const params  = isAdmin ? [] : [req.user.id, req.user.id, req.user.id];

    const rows = await query(`
      SELECT b.*,
             CONCAT(u.first_name,' ',u.last_name) AS instructor_name,
             c.title AS course_title,
             COUNT(DISTINCT br.id) AS reg_count
      FROM bootcamps b
      JOIN users u ON u.id = b.instructor_id
      LEFT JOIN courses c ON c.id = b.course_id
      LEFT JOIN bootcamp_registrations br ON br.bootcamp_id = b.id AND br.status = 'confirmed'
      ${where}
      GROUP BY b.id
      ORDER BY b.scheduled_at DESC
    `, params);

    res.json({ success: true, data: sanitize(rows) });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// POST /api/bootcamps/admin — Créer un bootcamp
router.post("/admin", authenticate, adminOnly,
  uploadThumb.single("thumbnail"), async (req: any, res) => {
  try {
    const {
      title, description, scheduled_at, duration_minutes = 120,
      is_free = 0, price = 0, max_participants,
      level = "beginner", language = "fr", tags = "[]",
      stream_url, instructor_id, course_id, repeat_weeks = 1,
    } = req.body;

    if (!title || !scheduled_at) {
      return res.status(400).json({ success: false, message: tr(req, "Titre et date requis", "Title and date required") });
    }
    // Date saisie par l'admin (heure locale, sans fuseau) : on la conserve telle quelle en base.
    const norm = String(scheduled_at).trim().replace(" ", "T");
    const start = new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(norm) ? norm : norm + "Z");
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ success: false, message: tr(req, "Date invalide", "Invalid date") });
    }

    // Animateur : l'instructeur désigné par l'admin (par défaut, l'admin lui-même).
    let hostId = req.user.id;
    if (instructor_id) {
      const [h]: any = await query("SELECT id FROM users WHERE id = ? AND role IN ('instructor','admin','superadmin') AND is_active = 1", [Number(instructor_id)]);
      if (!h) return res.status(400).json({ success: false, message: tr(req, "Animateur introuvable ou inactif", "Host not found or inactive") });
      hostId = Number(h.id);
    }
    let courseId: number | null = null;
    if (course_id) {
      const [c]: any = await query("SELECT id FROM courses WHERE id = ?", [Number(course_id)]);
      if (!c) return res.status(400).json({ success: false, message: tr(req, "Cours introuvable", "Course not found") });
      courseId = Number(c.id);
    }

    const times = Math.min(Math.max(parseInt(String(repeat_weeks), 10) || 1, 1), 26);
    const duration = Math.max(Number(duration_minutes) || 120, 15);

    // Un animateur ne peut pas avoir deux bootcamps qui se chevauchent.
    for (let i = 0; i < times; i++) {
      const s0 = new Date(start.getTime() + i * 7 * 86400000).toISOString().slice(0, 19).replace("T", " ");
      const e0 = new Date(start.getTime() + i * 7 * 86400000 + duration * 60000).toISOString().slice(0, 19).replace("T", " ");
      const [clash]: any = await query(
        `SELECT id, title FROM bootcamps
          WHERE instructor_id = ? AND status IN ('scheduled','live')
            AND scheduled_at < ? AND DATE_ADD(scheduled_at, INTERVAL duration_minutes MINUTE) > ? LIMIT 1`,
        [hostId, e0, s0]);
      if (clash) {
        return res.status(409).json({
          success: false, code: "HOST_BUSY",
          message: tr(req, `L'animateur a déjà « ${clash.title} » sur ce créneau.`, `The host already has “${clash.title}” in this time slot.`),
        });
      }
    }

    let thumbnail_url = null;
    if (req.file) {
      thumbnail_url = `/uploads/bootcamps/${req.file.filename}`;
    }

    const baseSlug = title.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const created: { id: number; slug: string; scheduled_at: string }[] = [];
    for (let i = 0; i < times; i++) {
      const when = new Date(start.getTime() + i * 7 * 86400000);
      const whenSql = when.toISOString().slice(0, 19).replace("T", " ");
      const slug = `${baseSlug}-${Date.now()}${i ? "-" + (i + 1) : ""}`;
      const result: any = await query(`
        INSERT INTO bootcamps
          (instructor_id, course_id, slug, title, description, thumbnail_url, stream_url,
           scheduled_at, duration_minutes, status, is_free, price,
           max_participants, level, language, tags)
        VALUES (?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,?,?,?)
      `, [
        hostId, courseId, slug, title, description || null, thumbnail_url, stream_url || null,
        whenSql, duration,
        Number(is_free), Number(price),
        max_participants ? Number(max_participants) : null,
        level, language, tags,
      ]);
      created.push({ id: toNum(result.insertId), slug, scheduled_at: whenSql });
    }
    if (hostId !== req.user.id) await notifyHost(hostId, title, start.toISOString());

    res.json({ success: true, data: { id: created[0].id, slug: created[0].slug, created }, message: tr(req, times > 1 ? `${times} bootcamps programmés` : "Bootcamp créé", times > 1 ? `${times} bootcamps scheduled` : "Bootcamp created") });
  } catch (err) {
    console.error("POST /admin error:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// PATCH /api/bootcamps/admin/:id — Modifier
router.patch("/admin/:id", authenticate, adminOnly, async (req: any, res) => {
  try {
    const { id } = req.params;
    const allowed = ["title","description","scheduled_at","duration_minutes","status",
                     "is_free","price","max_participants","level","stream_url","replay_url",
                     "thumbnail_url","is_private","instructor_id","course_id"];
    const updates: string[] = [];
    const values:  any[]    = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(req.body[key]);
      }
    }
    if (!updates.length) return res.status(400).json({ success: false, message: tr(req, "Rien à modifier", "Nothing to update") });

    const [before]: any = await query("SELECT instructor_id, title, scheduled_at FROM bootcamps WHERE id = ?", [id]);
    if (!before) return res.status(404).json({ success: false, message: tr(req, "Bootcamp introuvable", "Bootcamp not found") });
    if (req.body.instructor_id) {
      const [h]: any = await query("SELECT id FROM users WHERE id = ? AND role IN ('instructor','admin','superadmin') AND is_active = 1", [Number(req.body.instructor_id)]);
      if (!h) return res.status(400).json({ success: false, message: tr(req, "Animateur introuvable ou inactif", "Host not found or inactive") });
    }
    if (req.body.course_id === "" || req.body.course_id === null) {
      const i = updates.indexOf("course_id = ?"); if (i >= 0) values[i] = null;
    } else if (req.body.course_id) {
      const [c]: any = await query("SELECT id FROM courses WHERE id = ?", [Number(req.body.course_id)]);
      if (!c) return res.status(400).json({ success: false, message: tr(req, "Cours introuvable", "Course not found") });
    }

    values.push(id);
    await query(`UPDATE bootcamps SET ${updates.join(", ")} WHERE id = ?`, values);
    if (req.body.instructor_id && Number(req.body.instructor_id) !== Number(before.instructor_id) && Number(req.body.instructor_id) !== req.user.id) {
      await notifyHost(Number(req.body.instructor_id), req.body.title || before.title, req.body.scheduled_at || before.scheduled_at);
    }

    res.json({ success: true, message: tr(req, "Bootcamp mis à jour", "Bootcamp updated") });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// PATCH /api/bootcamps/admin/:id/status — Changer statut (draft→scheduled→live→ended)
router.patch("/admin/:id/status", authenticate, adminOnly, async (req, res) => {
  try {
    const { id }     = req.params;
    const { status } = req.body;
    const valid = ["draft","scheduled","live","ended","cancelled"];
    if (!valid.includes(status)) return res.status(400).json({ success: false, message: tr(req, "Statut invalide", "Invalid status") });

    await query("UPDATE bootcamps SET status = ? WHERE id = ?", [status, id]);
    res.json({ success: true, message: tr(req, `Statut → ${status}`, `Status → ${status}`) });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// DELETE /api/bootcamps/admin/:id — Supprimer
router.delete("/admin/:id", authenticate, adminOnly, async (req, res) => {
  try {
    await query("DELETE FROM bootcamps WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: tr(req, "Bootcamp supprimé", "Bootcamp deleted") });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// DELETE /api/bootcamps/admin/messages/:msgId — Supprimer un message (modération)
router.delete("/admin/messages/:msgId", authenticate, authorizeRoles(["admin","superadmin","instructor"]), async (req: any, res) => {
  try {
    const [m]: any = await query("SELECT bootcamp_id FROM bootcamp_messages WHERE id = ?", [req.params.msgId]);
    if (!m) return res.status(404).json({ success: false, message: tr(req, "Message introuvable", "Message not found") });
    if ((await canHost(req.user, Number(m.bootcamp_id))) !== "ok") return res.status(403).json({ success: false, message: tr(req, "Accès refusé", "Access denied") });
    await query("UPDATE bootcamp_messages SET is_deleted = 1 WHERE id = ?", [req.params.msgId]);
    res.json({ success: true, message: tr(req, "Message supprimé", "Message deleted") });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// ══════════════════════════════════════════════════════════════
// WebRTC SIGNALING ROUTES
// ══════════════════════════════════════════════════════════════

// POST /api/bootcamps/:id/stream/start — L'instructeur démarre le stream WebRTC
router.post("/:id/stream/start", authenticate, authorizeRoles(["admin","superadmin","instructor"]), hostGuard, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { peer_id, stream_type = "webrtc" } = req.body;

    if (!peer_id) return res.status(400).json({ success: false, message: tr(req, "peer_id requis", "peer_id required") });

    await query(
      "UPDATE bootcamps SET peer_id = ?, stream_type = ?, status = 'live' WHERE id = ?",
      [peer_id, stream_type, id]
    );

    res.json({ success: true, message: tr(req, "Stream démarré", "Stream started"), peer_id });
  } catch (err) {
    console.error("stream/start error:", err);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// POST /api/bootcamps/:id/stream/stop — L'instructeur arrête le stream
router.post("/:id/stream/stop", authenticate, authorizeRoles(["admin","superadmin","instructor"]), hostGuard, async (req: any, res) => {
  try {
    const { id } = req.params;
    await query(
      "UPDATE bootcamps SET peer_id = NULL, stream_type = 'none', status = 'ended' WHERE id = ?",
      [id]
    );
    res.json({ success: true, message: tr(req, "Stream arrêté", "Stream stopped") });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// GET /api/bootcamps/:id/stream/info — Spectateurs récupèrent le peer_id pour se connecter
router.get("/:id/stream/info", authenticate, async (req: any, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const [boot] = await query(
      "SELECT id, title, peer_id, stream_type, stream_url, replay_url, status, is_free, viewer_access FROM bootcamps WHERE id = ?",
      [id]
    ) as any[];

    if (!boot) return res.status(404).json({ success: false, message: tr(req, "Bootcamp introuvable", "Bootcamp not found") });

    // Vérifier accès si privé
    if (boot.viewer_access === "registered") {
      const [reg] = await query(
        "SELECT id FROM bootcamp_registrations WHERE bootcamp_id = ? AND user_id = ? AND status = 'confirmed'",
        [id, userId]
      ) as any[];
      const isInstructor = req.user.role === "admin" || req.user.role === "instructor";
      if (!reg && !isInstructor) {
        return res.status(403).json({
          success: false,
          message: tr(req, "Accès réservé aux inscrits", "Access reserved for registered learners"),
          requiresRegistration: true
        });
      }
    }

    res.json({
      success: true,
      data: {
        peer_id:     boot.peer_id,
        stream_type: boot.stream_type,
        stream_url:  boot.stream_url,
        replay_url:  boot.replay_url,
        status:      boot.status,
        is_live:     boot.status === "live" && !!boot.peer_id,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// GET /api/bootcamps/:id/stream/viewers — Nombre de spectateurs (polling)
router.get("/:id/stream/viewers", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    // Incrémenter views_count à chaque appel de polling actif
    await query("UPDATE bootcamps SET views_count = views_count + 1 WHERE id = ? AND status = 'live'", [id]);
    const [boot] = await query("SELECT views_count FROM bootcamps WHERE id = ?", [id]) as any[];
    res.json({ success: true, viewers: toNum(boot?.views_count) });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});

// PATCH /api/bootcamps/:id/access — Changer accès public/privé
router.patch("/:id/access", authenticate, authorizeRoles(["admin","superadmin","instructor"]), hostGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { viewer_access } = req.body;
    if (!["public","registered"].includes(viewer_access)) {
      return res.status(400).json({ success: false, message: tr(req, "Valeur invalide (public ou registered)", "Invalid value (public or registered)") });
    }
    await query("UPDATE bootcamps SET viewer_access = ? WHERE id = ?", [viewer_access, id]);
    res.json({ success: true, message: tr(req, `Accès → ${viewer_access}`, `Access → ${viewer_access}`) });
  } catch (err) {
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
});



// ══════════════════════════════════════════════════════════════
// WEBRTC — peer_id management
// ══════════════════════════════════════════════════════════════

// POST /api/bootcamps/admin/:id/peer — Enregistrer le peer_id de l'instructeur
router.post("/admin/:id/peer", authenticate, authorizeRoles(["admin","superadmin","instructor"]), hostGuard, async (req, res) => {
  try {
    const { peer_id, stream_type, access_mode } = req.body;
    if (!peer_id) return res.status(400).json({ success:false, message:tr(req, "peer_id requis", "peer_id required") });

    await query(
      "UPDATE bootcamps SET peer_id=?, stream_type=?, access_mode=?, status='live' WHERE id=?",
      [peer_id, stream_type || "webrtc", access_mode || "public", req.params.id]
    );
    res.json({ success:true, message:tr(req, "Stream démarré", "Stream started") });
  } catch (err) {
    res.status(500).json({ success:false, message:tr(req, "Erreur serveur", "Server error") });
  }
});

// DELETE /api/bootcamps/admin/:id/peer — Arrêter le stream WebRTC
router.delete("/admin/:id/peer", authenticate, authorizeRoles(["admin","superadmin","instructor"]), hostGuard, async (req, res) => {
  try {
    await query(
      "UPDATE bootcamps SET peer_id=NULL, stream_type='none', status='ended' WHERE id=?",
      [req.params.id]
    );
    res.json({ success:true, message:tr(req, "Stream arrêté", "Stream stopped") });
  } catch (err) {
    res.status(500).json({ success:false, message:tr(req, "Erreur serveur", "Server error") });
  }
});

// GET /api/bootcamps/:id/peer — Récupérer peer_id + access_mode (public ou pour inscrits)
router.get("/:id/peer", async (req: any, res) => {
  try {
    const [boot] = await query(
      "SELECT id, peer_id, stream_type, access_mode, status, is_free, price FROM bootcamps WHERE id=?",
      [req.params.id]
    ) as any[];

    if (!boot) return res.status(404).json({ success:false });

    // Si accès privé, vérifier que l'utilisateur est inscrit
    if (boot.access_mode === "registered" && req.user) {
      const [reg] = await query(
        "SELECT id FROM bootcamp_registrations WHERE bootcamp_id=? AND user_id=? AND status='confirmed'",
        [boot.id, req.user.id]
      ) as any[];
      if (!reg) {
        return res.json({ success:true, data: { ...boot, peer_id:null, reason:"not_registered" } });
      }
    }

    res.json({ success:true, data: boot });
  } catch (err) {
    res.status(500).json({ success:false, message:tr(req, "Erreur serveur", "Server error") });
  }
});


// ── Cache mémoire viewers (typage TypeScript explicite) ────
const viewerCache: Record<string, Record<string, { peer_id: string; ts: number }>> = {};

// ── Viewers : enregistrer/supprimer peer_id étudiant ──────
router.post("/:id/viewer-peer", authenticate, async (req: any, res) => {
  try {
    const { peer_id } = req.body;
    const bootcampId  = req.params.id;
    const userId      = String(req.user.id);
    if (!peer_id) return res.status(400).json({ success: false });

    if (!viewerCache[bootcampId]) viewerCache[bootcampId] = {};
    viewerCache[bootcampId][userId] = { peer_id, ts: Date.now() };

    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

// GET /api/bootcamps/:id/viewer-peers — Instructeur récupère la liste des viewers
router.get("/:id/viewer-peers", authenticate, async (req: any, res) => {
  try {
    const bootcampId = req.params.id;
    if (!viewerCache[bootcampId]) return res.json({ success: true, data: [] });

    // Nettoyer les viewers inactifs (> 30s sans heartbeat)
    const now = Date.now();
    const viewers = Object.entries(viewerCache[bootcampId])
      .filter(([, v]) => now - v.ts < 30000)
      .map(([userId, v]) => ({ userId, peer_id: v.peer_id }));

    res.json({ success: true, data: viewers });
  } catch { res.status(500).json({ success: false }); }
});

// DELETE /api/bootcamps/:id/viewer-peer — Viewer quitte
router.delete("/:id/viewer-peer", authenticate, async (req: any, res) => {
  try {
    const userId = String(req.user.id);
    if (viewerCache[req.params.id]) {
      delete viewerCache[req.params.id][userId];
    }
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

export default router;