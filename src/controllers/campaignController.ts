// src/controllers/campaignController.ts
// Campagnes / événements du site (Octobre Rose, fêtes…) : slides sur l'accueil + thème de couleurs du site.
//  • Lecture publique : GET /api/campaigns/active
//  • Gestion admin    : /api/admin/campaigns/…  et  /api/admin/themes/…
// Tables créées au démarrage (même principe que platform_settings / notifications).
import { Request, Response } from "express";
import slugify from "slugify";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { fail, serverError, logAudit } from "../utils/respond";

type Req = AuthenticatedRequest;

// ══════════════════════════════════════════════════════════════════════
// TABLES + thèmes de départ
// ══════════════════════════════════════════════════════════════════════
const BUILTIN_THEMES = [
  // slug, nom, description, primary, primary_light, primary_dark, accent
  ["normal", "Normal (charte DevOps Akademy)", "Charte habituelle du site : violet et jaune.", "#2d287f", "#5653e1", "#1f1b5a", "#facc15"],
  ["octobre-rose", "Octobre Rose", "Bleu nuit et rose, en soutien à la lutte contre le cancer du sein.", "#14284b", "#2f4b8a", "#0c1a33", "#f26aa8"],
  ["fetes", "Fêtes de fin d'année", "Vert profond et or.", "#14532d", "#1f7a45", "#0b3a1f", "#f5c542"],
  ["rentree", "Rentrée", "Bleu pétrole et orange.", "#0b4f6c", "#0f7fa8", "#073449", "#ff9f1c"],
] as const;

let ready: Promise<void> | null = null;
export const ensureCampaignTables = (): Promise<void> => {
  if (!ready) {
    ready = (async () => {
      await query(
        `CREATE TABLE IF NOT EXISTS site_themes (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           slug VARCHAR(80) NOT NULL UNIQUE,
           name VARCHAR(120) NOT NULL,
           description VARCHAR(255) NULL,
           primary_color VARCHAR(7) NOT NULL,
           primary_light VARCHAR(7) NOT NULL,
           primary_dark  VARCHAR(7) NOT NULL,
           accent_color  VARCHAR(7) NOT NULL,
           is_builtin TINYINT(1) NOT NULL DEFAULT 0,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await query(
        `CREATE TABLE IF NOT EXISTS campaigns (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           title VARCHAR(150) NOT NULL,
           is_active TINYINT(1) NOT NULL DEFAULT 0,
           starts_at DATETIME NULL,
           ends_at DATETIME NULL,
           theme_id INT UNSIGNED NULL,
           apply_theme TINYINT(1) NOT NULL DEFAULT 1,
           priority INT NOT NULL DEFAULT 0,
           created_by INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
           INDEX idx_campaign_active (is_active, priority),
           CONSTRAINT fk_campaign_theme FOREIGN KEY (theme_id) REFERENCES site_themes(id) ON DELETE SET NULL
         ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await query(
        `CREATE TABLE IF NOT EXISTS campaign_slides (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           campaign_id INT UNSIGNED NOT NULL,
           sort_order INT NOT NULL DEFAULT 0,
           is_active TINYINT(1) NOT NULL DEFAULT 1,
           label VARCHAR(120) NULL,
           title VARCHAR(200) NULL,
           body TEXT NULL,
           image_url VARCHAR(500) NULL,
           linkedin_url VARCHAR(500) NULL,
           cta_label VARCHAR(80) NULL,
           cta_url VARCHAR(500) NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
           INDEX idx_slide_campaign (campaign_id, sort_order),
           CONSTRAINT fk_slide_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
         ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      for (const [slug, name, description, p, pl, pd, a] of BUILTIN_THEMES) {
        await query(
          `INSERT IGNORE INTO site_themes (slug, name, description, primary_color, primary_light, primary_dark, accent_color, is_builtin)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          [slug, name, description, p, pl, pd, a]
        );
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
};

// ══════════════════════════════════════════════════════════════════════
// Validation / sérialisation
// ══════════════════════════════════════════════════════════════════════
const HEX = /^#[0-9a-fA-F]{6}$/;
const toBool = (v: any, def = false) => (v === undefined || v === null ? def : v === true || v === 1 || v === "1" || v === "true");
const str = (v: any, max: number): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const iso = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
// ISO (UTC) → "YYYY-MM-DD HH:mm:ss" pour les colonnes DATETIME (le pool MariaDB travaille en UTC)
const toDb = (v: any): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error("INVALID_DATE");
  return d.toISOString().slice(0, 19).replace("T", " ");
};

/** URL d'image : http(s) ou chemin /uploads/… (jamais javascript:, data: …) */
const cleanImageUrl = (v: any): string | null => {
  const s = str(v, 500);
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || s.startsWith("/uploads/")) return s;
  throw new Error("INVALID_IMAGE");
};
/** Lien du bouton : http(s) ou chemin interne "/…" */
const cleanLink = (v: any): string | null => {
  const s = str(v, 500);
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || (s.startsWith("/") && !s.startsWith("//"))) return s;
  throw new Error("INVALID_LINK");
};
const LINKEDIN_EMBED = /^https:\/\/www\.linkedin\.com\/embed\/feed\/update\/urn:li:(share|ugcPost|activity):\d+/i;
/** Accepte le code <iframe …> complet ou l'URL d'intégration LinkedIn ; renvoie l'URL d'intégration seule. */
const cleanLinkedIn = (v: any): string | null => {
  let s = str(v, 2000);
  if (!s) return null;
  const m = s.match(/src\s*=\s*["']([^"']+)["']/i);
  if (m) s = m[1];
  s = s.replace(/&amp;/g, "&").trim();
  if (!LINKEDIN_EMBED.test(s)) throw new Error("INVALID_LINKEDIN");
  return s.split("?")[0].slice(0, 500);
};

const themeOut = (r: any) => ({
  id: Number(r.id), slug: r.slug, name: r.name, description: r.description ?? null,
  primary: r.primary_color, primary_light: r.primary_light, primary_dark: r.primary_dark, accent: r.accent_color,
  is_builtin: !!Number(r.is_builtin),
});
const slideOut = (r: any) => ({
  id: Number(r.id), campaign_id: Number(r.campaign_id), sort_order: Number(r.sort_order), is_active: !!Number(r.is_active),
  label: r.label ?? null, title: r.title ?? null, body: r.body ?? null, image_url: r.image_url ?? null,
  linkedin_url: r.linkedin_url ?? null, cta_label: r.cta_label ?? null, cta_url: r.cta_url ?? null,
});
const status = (c: any, now = Date.now()): "inactive" | "scheduled" | "ended" | "live" => {
  if (!Number(c.is_active)) return "inactive";
  const s = c.starts_at ? new Date(c.starts_at).getTime() : null;
  const e = c.ends_at ? new Date(c.ends_at).getTime() : null;
  if (s !== null && now < s) return "scheduled";
  if (e !== null && now > e) return "ended";
  return "live";
};
const campaignOut = (c: any, extra: object = {}) => ({
  id: Number(c.id), title: c.title, is_active: !!Number(c.is_active),
  starts_at: iso(c.starts_at), ends_at: iso(c.ends_at),
  theme_id: c.theme_id === null || c.theme_id === undefined ? null : Number(c.theme_id),
  apply_theme: !!Number(c.apply_theme), priority: Number(c.priority), status: status(c),
  created_at: iso(c.created_at), updated_at: iso(c.updated_at), ...extra,
});

const badInput = (req: Request, res: Response, e: any): boolean => {
  const map: Record<string, [string, string]> = {
    INVALID_DATE: ["Date invalide.", "Invalid date."],
    INVALID_IMAGE: ["Adresse d'image invalide (http(s):// ou /uploads/…).", "Invalid image address (http(s):// or /uploads/…)."],
    INVALID_LINK: ["Lien du bouton invalide (http(s):// ou chemin interne /…).", "Invalid button link (http(s):// or internal path /…)."],
    INVALID_LINKEDIN: [
      "Lien LinkedIn invalide : collez le code d'intégration (iframe) du post, depuis LinkedIn > Intégrer ce post.",
      "Invalid LinkedIn link: paste the post's embed code (iframe) from LinkedIn > Embed this post.",
    ],
  };
  const m = map[e?.message];
  if (!m) return false;
  fail(req, res, 400, m[0], m[1], { code: e.message });
  return true;
};

// ══════════════════════════════════════════════════════════════════════
// PUBLIC : campagnes actives + thème à appliquer
// ══════════════════════════════════════════════════════════════════════
// GET /api/campaigns/active
export const getActiveCampaigns = async (req: Request, res: Response) => {
  try {
    await ensureCampaignTables();
    const rows: any[] = await query(
      `SELECT c.*, t.slug AS t_slug, t.name AS t_name, t.description AS t_description, t.primary_color, t.primary_light,
              t.primary_dark, t.accent_color, t.is_builtin, t.id AS t_id
         FROM campaigns c LEFT JOIN site_themes t ON t.id = c.theme_id
        WHERE c.is_active = 1
        ORDER BY c.priority DESC, c.starts_at DESC, c.id DESC`
    );
    const live = rows.filter((c) => status(c) === "live");
    let theme: any = null;
    const themed = live.find((c) => Number(c.apply_theme) && c.t_slug);
    if (themed && themed.t_slug !== "normal") {
      theme = themeOut({ id: themed.t_id, slug: themed.t_slug, name: themed.t_name, description: themed.t_description,
        primary_color: themed.primary_color, primary_light: themed.primary_light, primary_dark: themed.primary_dark,
        accent_color: themed.accent_color, is_builtin: themed.is_builtin });
    }
    const ids = live.map((c) => Number(c.id));
    const slides: any[] = ids.length
      ? await query(`SELECT * FROM campaign_slides WHERE is_active = 1 AND campaign_id IN (${ids.map(() => "?").join(",")}) ORDER BY sort_order ASC, id ASC`, ids)
      : [];
    const campaigns = live.map((c) => ({
      id: Number(c.id), title: c.title,
      slides: slides.filter((s) => Number(s.campaign_id) === Number(c.id)).map(slideOut),
    }));
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: { theme, campaigns } });
  } catch (e) {
    // Le site public ne doit jamais tomber à cause des campagnes : réponse vide.
    console.error("getActiveCampaigns:", (e as any)?.message || e);
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: { theme: null, campaigns: [] } });
  }
};

// ══════════════════════════════════════════════════════════════════════
// ADMIN : campagnes
// ══════════════════════════════════════════════════════════════════════
const campaignBody = (req: Request) => {
  const b = req.body || {};
  const title = str(b.title, 150);
  const starts = toDb(b.starts_at);
  const ends = toDb(b.ends_at);
  return { b, title, starts, ends };
};

// GET /api/admin/campaigns
export const listCampaigns = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const rows: any[] = await query(
      `SELECT c.*, t.name AS theme_name, t.slug AS theme_slug, t.primary_color, t.accent_color,
              (SELECT COUNT(*) FROM campaign_slides s WHERE s.campaign_id = c.id) AS slide_count
         FROM campaigns c LEFT JOIN site_themes t ON t.id = c.theme_id
        ORDER BY c.is_active DESC, c.priority DESC, c.id DESC`
    );
    res.json({
      success: true,
      data: rows.map((c) => campaignOut(c, {
        slide_count: Number(c.slide_count), theme_name: c.theme_name ?? null, theme_slug: c.theme_slug ?? null,
        theme_colors: c.theme_slug ? { primary: c.primary_color, accent: c.accent_color } : null,
      })),
    });
  } catch (e) { serverError(req, res, "listCampaigns", e); }
};

// GET /api/admin/campaigns/:id
export const getCampaign = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const [c]: any[] = await query("SELECT * FROM campaigns WHERE id = ?", [req.params.id]);
    if (!c) return fail(req, res, 404, "Campagne introuvable.", "Campaign not found.");
    const slides: any[] = await query("SELECT * FROM campaign_slides WHERE campaign_id = ? ORDER BY sort_order ASC, id ASC", [c.id]);
    res.json({ success: true, data: campaignOut(c, { slides: slides.map(slideOut) }) });
  } catch (e) { serverError(req, res, "getCampaign", e); }
};

const checkThemeId = async (req: Request, res: Response, themeId: any): Promise<number | null | false> => {
  if (themeId === undefined || themeId === null || themeId === "") return null;
  const [t]: any[] = await query("SELECT id FROM site_themes WHERE id = ?", [themeId]);
  if (!t) { fail(req, res, 400, "Thème introuvable.", "Theme not found."); return false; }
  return Number(t.id);
};

// POST /api/admin/campaigns
export const createCampaign = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const { b, title, starts, ends } = campaignBody(req);
    if (!title) return fail(req, res, 400, "Le titre est obligatoire.", "Title is required.");
    if (starts && ends && ends < starts) return fail(req, res, 400, "La date de fin doit suivre la date de début.", "The end date must be after the start date.");
    const themeId = await checkThemeId(req, res, b.theme_id);
    if (themeId === false) return;
    const r: any = await query(
      `INSERT INTO campaigns (title, is_active, starts_at, ends_at, theme_id, apply_theme, priority, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, toBool(b.is_active) ? 1 : 0, starts, ends, themeId, toBool(b.apply_theme, true) ? 1 : 0, Number.isFinite(Number(b.priority)) ? Math.trunc(Number(b.priority)) : 0, req.user?.id ?? null]
    );
    const id = Number(r.insertId);
    void logAudit(req, "admin", "campaign_create", "campaign", id, null, { title });
    const [c]: any[] = await query("SELECT * FROM campaigns WHERE id = ?", [id]);
    res.status(201).json({ success: true, data: campaignOut(c, { slides: [] }) });
  } catch (e) { if (!badInput(req, res, e)) serverError(req, res, "createCampaign", e); }
};

// PUT /api/admin/campaigns/:id
export const updateCampaign = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const [before]: any[] = await query("SELECT * FROM campaigns WHERE id = ?", [req.params.id]);
    if (!before) return fail(req, res, 404, "Campagne introuvable.", "Campaign not found.");
    const { b, title, starts, ends } = campaignBody(req);
    const next = {
      title: title ?? before.title,
      starts: "starts_at" in b ? starts : (before.starts_at ? toDb(before.starts_at) : null),
      ends: "ends_at" in b ? ends : (before.ends_at ? toDb(before.ends_at) : null),
    };
    if (next.starts && next.ends && next.ends < next.starts) return fail(req, res, 400, "La date de fin doit suivre la date de début.", "The end date must be after the start date.");
    let themeId: number | null = before.theme_id === null ? null : Number(before.theme_id);
    if ("theme_id" in b) { const t = await checkThemeId(req, res, b.theme_id); if (t === false) return; themeId = t; }
    await query(
      `UPDATE campaigns SET title=?, is_active=?, starts_at=?, ends_at=?, theme_id=?, apply_theme=?, priority=? WHERE id=?`,
      [next.title, "is_active" in b ? (toBool(b.is_active) ? 1 : 0) : before.is_active, next.starts, next.ends, themeId,
        "apply_theme" in b ? (toBool(b.apply_theme, true) ? 1 : 0) : before.apply_theme,
        "priority" in b && Number.isFinite(Number(b.priority)) ? Math.trunc(Number(b.priority)) : before.priority, before.id]
    );
    void logAudit(req, "admin", "campaign_update", "campaign", Number(before.id), { title: before.title }, { title: next.title });
    const [c]: any[] = await query("SELECT * FROM campaigns WHERE id = ?", [before.id]);
    res.json({ success: true, data: campaignOut(c) });
  } catch (e) { if (!badInput(req, res, e)) serverError(req, res, "updateCampaign", e); }
};

// PATCH /api/admin/campaigns/:id/active   { is_active }
export const setCampaignActive = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const r: any = await query("UPDATE campaigns SET is_active = ? WHERE id = ?", [toBool(req.body?.is_active) ? 1 : 0, req.params.id]);
    if (!Number(r.affectedRows)) return fail(req, res, 404, "Campagne introuvable.", "Campaign not found.");
    void logAudit(req, "admin", toBool(req.body?.is_active) ? "campaign_activate" : "campaign_deactivate", "campaign", Number(req.params.id), null, null);
    const [c]: any[] = await query("SELECT * FROM campaigns WHERE id = ?", [req.params.id]);
    res.json({ success: true, data: campaignOut(c) });
  } catch (e) { serverError(req, res, "setCampaignActive", e); }
};

// DELETE /api/admin/campaigns/:id
export const deleteCampaign = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const [c]: any[] = await query("SELECT id, title FROM campaigns WHERE id = ?", [req.params.id]);
    if (!c) return fail(req, res, 404, "Campagne introuvable.", "Campaign not found.");
    await query("DELETE FROM campaigns WHERE id = ?", [c.id]);
    void logAudit(req, "admin", "campaign_delete", "campaign", Number(c.id), { title: c.title }, null);
    res.json({ success: true });
  } catch (e) { serverError(req, res, "deleteCampaign", e); }
};

// ══════════════════════════════════════════════════════════════════════
// ADMIN : slides
// ══════════════════════════════════════════════════════════════════════
const slideFields = (b: any) => {
  const f = {
    label: str(b.label, 120), title: str(b.title, 200), body: str(b.body, 2000),
    image_url: cleanImageUrl(b.image_url), linkedin_url: cleanLinkedIn(b.linkedin_url),
    cta_label: str(b.cta_label, 80), cta_url: cleanLink(b.cta_url),
  };
  return f;
};

// POST /api/admin/campaigns/:id/slides
export const createSlide = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const [c]: any[] = await query("SELECT id FROM campaigns WHERE id = ?", [req.params.id]);
    if (!c) return fail(req, res, 404, "Campagne introuvable.", "Campaign not found.");
    const f = slideFields(req.body || {});
    if (!f.title && !f.image_url && !f.linkedin_url) return fail(req, res, 400, "Une slide doit avoir au moins un titre, une image ou un post LinkedIn.", "A slide needs at least a title, an image or a LinkedIn post.");
    if (f.cta_url && !f.cta_label) return fail(req, res, 400, "Indiquez le texte du bouton.", "Provide the button text.");
    const [m]: any[] = await query("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM campaign_slides WHERE campaign_id = ?", [c.id]);
    const r: any = await query(
      `INSERT INTO campaign_slides (campaign_id, sort_order, is_active, label, title, body, image_url, linkedin_url, cta_label, cta_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, Number(m.n), toBool(req.body?.is_active, true) ? 1 : 0, f.label, f.title, f.body, f.image_url, f.linkedin_url, f.cta_label, f.cta_url]
    );
    const [s]: any[] = await query("SELECT * FROM campaign_slides WHERE id = ?", [Number(r.insertId)]);
    res.status(201).json({ success: true, data: slideOut(s) });
  } catch (e) { if (!badInput(req, res, e)) serverError(req, res, "createSlide", e); }
};

// PUT /api/admin/campaigns/slides/:slideId
export const updateSlide = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const [before]: any[] = await query("SELECT * FROM campaign_slides WHERE id = ?", [req.params.slideId]);
    if (!before) return fail(req, res, 404, "Slide introuvable.", "Slide not found.");
    const f = slideFields(req.body || {});
    if (!f.title && !f.image_url && !f.linkedin_url) return fail(req, res, 400, "Une slide doit avoir au moins un titre, une image ou un post LinkedIn.", "A slide needs at least a title, an image or a LinkedIn post.");
    if (f.cta_url && !f.cta_label) return fail(req, res, 400, "Indiquez le texte du bouton.", "Provide the button text.");
    await query(
      `UPDATE campaign_slides SET is_active=?, label=?, title=?, body=?, image_url=?, linkedin_url=?, cta_label=?, cta_url=? WHERE id=?`,
      [toBool(req.body?.is_active, !!Number(before.is_active)) ? 1 : 0, f.label, f.title, f.body, f.image_url, f.linkedin_url, f.cta_label, f.cta_url, before.id]
    );
    const [s]: any[] = await query("SELECT * FROM campaign_slides WHERE id = ?", [before.id]);
    res.json({ success: true, data: slideOut(s) });
  } catch (e) { if (!badInput(req, res, e)) serverError(req, res, "updateSlide", e); }
};

// PATCH /api/admin/campaigns/slides/:slideId/active   { is_active }
export const setSlideActive = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const r: any = await query("UPDATE campaign_slides SET is_active = ? WHERE id = ?", [toBool(req.body?.is_active) ? 1 : 0, req.params.slideId]);
    if (!Number(r.affectedRows)) return fail(req, res, 404, "Slide introuvable.", "Slide not found.");
    res.json({ success: true });
  } catch (e) { serverError(req, res, "setSlideActive", e); }
};

// DELETE /api/admin/campaigns/slides/:slideId
export const deleteSlide = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const r: any = await query("DELETE FROM campaign_slides WHERE id = ?", [req.params.slideId]);
    if (!Number(r.affectedRows)) return fail(req, res, 404, "Slide introuvable.", "Slide not found.");
    res.json({ success: true });
  } catch (e) { serverError(req, res, "deleteSlide", e); }
};

// PATCH /api/admin/campaigns/:id/slides/reorder   { ids: [slideId, …] }
export const reorderSlides = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return fail(req, res, 400, "Liste d'ordre vide.", "Empty order list.");
    const own: any[] = await query("SELECT id FROM campaign_slides WHERE campaign_id = ?", [req.params.id]);
    const ownIds = new Set(own.map((r) => Number(r.id)));
    if (ids.some((i) => !ownIds.has(i))) return fail(req, res, 400, "Slide inconnue dans cette campagne.", "Unknown slide for this campaign.");
    for (let i = 0; i < ids.length; i++) await query("UPDATE campaign_slides SET sort_order = ? WHERE id = ?", [i + 1, ids[i]]);
    res.json({ success: true });
  } catch (e) { serverError(req, res, "reorderSlides", e); }
};

// ══════════════════════════════════════════════════════════════════════
// ADMIN : thèmes (événements personnalisés)
// ══════════════════════════════════════════════════════════════════════
const themeFields = (b: any) => {
  const name = str(b?.name, 120);
  const colors = { primary: b?.primary, primary_light: b?.primary_light, primary_dark: b?.primary_dark, accent: b?.accent };
  for (const v of Object.values(colors)) if (!HEX.test(String(v ?? ""))) throw new Error("INVALID_COLOR");
  return { name, description: str(b?.description, 255), colors: Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, String(v).toLowerCase()])) as any };
};
const themeErr = (req: Request, res: Response, e: any): boolean => {
  if (e?.message === "INVALID_COLOR") { fail(req, res, 400, "Couleurs invalides : utilisez le format #RRGGBB.", "Invalid colours: use the #RRGGBB format.", { code: "INVALID_COLOR" }); return true; }
  return false;
};

// GET /api/admin/themes
export const listThemes = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const rows: any[] = await query(
      `SELECT t.*, (SELECT COUNT(*) FROM campaigns c WHERE c.theme_id = t.id) AS used_by FROM site_themes t ORDER BY t.is_builtin DESC, t.id ASC`
    );
    res.json({ success: true, data: rows.map((r) => ({ ...themeOut(r), used_by: Number(r.used_by) })) });
  } catch (e) { serverError(req, res, "listThemes", e); }
};

// POST /api/admin/themes
export const createTheme = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const { name, description, colors } = themeFields(req.body);
    if (!name) return fail(req, res, 400, "Le nom du thème est obligatoire.", "Theme name is required.");
    const base = slugify(name, { lower: true, strict: true }) || "theme";
    let slug = base; let n = 2;
    while ((await query("SELECT id FROM site_themes WHERE slug = ?", [slug])).length) slug = `${base}-${n++}`;
    const r: any = await query(
      `INSERT INTO site_themes (slug, name, description, primary_color, primary_light, primary_dark, accent_color, is_builtin) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [slug, name, description, colors.primary, colors.primary_light, colors.primary_dark, colors.accent]
    );
    void logAudit(req, "admin", "theme_create", "theme", Number(r.insertId), null, { name });
    const [t]: any[] = await query("SELECT * FROM site_themes WHERE id = ?", [Number(r.insertId)]);
    res.status(201).json({ success: true, data: { ...themeOut(t), used_by: 0 } });
  } catch (e) { if (!themeErr(req, res, e)) serverError(req, res, "createTheme", e); }
};

// PUT /api/admin/themes/:id
export const updateTheme = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const [t]: any[] = await query("SELECT * FROM site_themes WHERE id = ?", [req.params.id]);
    if (!t) return fail(req, res, 404, "Thème introuvable.", "Theme not found.");
    if (t.slug === "normal") return fail(req, res, 403, "Le thème « Normal » ne peut pas être modifié.", "The “Normal” theme cannot be edited.");
    const { name, description, colors } = themeFields({ ...req.body, name: req.body?.name ?? t.name });
    await query(
      `UPDATE site_themes SET name=?, description=?, primary_color=?, primary_light=?, primary_dark=?, accent_color=? WHERE id=?`,
      [name || t.name, description, colors.primary, colors.primary_light, colors.primary_dark, colors.accent, t.id]
    );
    void logAudit(req, "admin", "theme_update", "theme", Number(t.id), null, { name });
    const [u]: any[] = await query("SELECT * FROM site_themes WHERE id = ?", [t.id]);
    res.json({ success: true, data: themeOut(u) });
  } catch (e) { if (!themeErr(req, res, e)) serverError(req, res, "updateTheme", e); }
};

// DELETE /api/admin/themes/:id
export const deleteTheme = async (req: Req, res: Response) => {
  try {
    await ensureCampaignTables();
    const [t]: any[] = await query("SELECT * FROM site_themes WHERE id = ?", [req.params.id]);
    if (!t) return fail(req, res, 404, "Thème introuvable.", "Theme not found.");
    if (t.slug === "normal") return fail(req, res, 403, "Le thème « Normal » ne peut pas être supprimé.", "The “Normal” theme cannot be deleted.");
    const [u]: any[] = await query("SELECT COUNT(*) AS n FROM campaigns WHERE theme_id = ?", [t.id]);
    if (Number(u.n) > 0) return fail(req, res, 409, `Ce thème est utilisé par ${Number(u.n)} campagne(s). Changez leur thème d'abord.`, `This theme is used by ${Number(u.n)} campaign(s). Change their theme first.`, { code: "THEME_IN_USE" });
    await query("DELETE FROM site_themes WHERE id = ?", [t.id]);
    void logAudit(req, "admin", "theme_delete", "theme", Number(t.id), { name: t.name }, null);
    res.json({ success: true });
  } catch (e) { serverError(req, res, "deleteTheme", e); }
};
