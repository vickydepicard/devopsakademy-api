// src/controllers/marketingExtras.ts
// Étape 2 du marketing : modèles enregistrés, automatisations, codes promo.
import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { fail, serverError, logAudit } from "../utils/respond";
import { parseId } from "../utils/serialize";
import { publicBaseUrl } from "../utils/publicUrl";
import { sendEmail } from "../services/mail.service";
import { checkCoupon, normalizeCode } from "../services/coupon.service";
import { couponMessage } from "./enrollmentController";
import { ensureMarketingTables, newToken, plain, num, parseJson } from "./marketingSetup";
import { AUTOMATION_PRESETS, originalPreset } from "./marketingPresets";
import { renderEmail, getBlocks, loadBlockData, Block } from "./marketingRender";
import { eligibleForAutomation } from "./marketingJobs";

type Req = AuthenticatedRequest;
const str = (v: any, max: number) => String(v ?? "").trim().slice(0, max);

// ══════════════════════════════════════════════════════
// MODÈLES (campagnes, bannières, réseaux sociaux) : prêts à publier, modifiables, créables
// ══════════════════════════════════════════════════════
const shapeTpl = (r: any) => ({ ...r, is_builtin: !!Number(r.is_builtin), content: parseJson(r.content, {}) });

export const listTemplates = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const type = ["campaign", "banner", "social"].includes(String(req.query.type)) ? String(req.query.type) : null;
    const rows: any[] = await query(
      `SELECT * FROM marketing_templates ${type ? "WHERE type = ?" : ""} ORDER BY is_builtin DESC, sort_order, id`, type ? [type] : []);
    return res.json({ success: true, data: plain(rows.map(shapeTpl)) });
  } catch (e) { return serverError(req, res, "listTemplates", e); }
};

const tplFields = (b: any) => ({
  type: ["campaign", "banner", "social"].includes(b?.type) ? b.type : "campaign",
  name_fr: str(b?.name_fr, 200), name_en: str(b?.name_en, 200) || str(b?.name_fr, 200),
  description_fr: str(b?.description_fr, 400) || null, description_en: str(b?.description_en, 400) || null,
  icon: str(b?.icon, 40) || "FileText", category: str(b?.category, 30) || "custom",
  kind: ["newsletter", "offer", "webinar", "announcement"].includes(b?.kind) ? b.kind : "newsletter",
  content: JSON.stringify(b?.content && typeof b.content === "object" ? b.content : {}),
});

export const createTemplate = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const f = tplFields(req.body);
    if (f.name_fr.length < 2) return fail(req, res, 400, "Donnez un nom au modèle.", "Give the template a name.", { errors: { name_fr: "required" } });
    if (f.content.length > 400_000) return fail(req, res, 413, "Modèle trop volumineux.", "Template too large.");
    const r: any = await query(
      `INSERT INTO marketing_templates (slug, type, name_fr, name_en, description_fr, description_en, icon, category, kind, content, is_builtin, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [`custom_${newToken(6)}`, f.type, f.name_fr, f.name_en, f.description_fr, f.description_en, f.icon, f.category, f.kind, f.content, req.user!.id]);
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "createTemplate", e); }
};

export const updateTemplate = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const [cur]: any = id ? await query("SELECT id FROM marketing_templates WHERE id = ?", [id]) : [];
    if (!cur) return fail(req, res, 404, "Modèle introuvable", "Template not found");
    const f = tplFields(req.body);
    if (f.name_fr.length < 2) return fail(req, res, 400, "Donnez un nom au modèle.", "Give the template a name.", { errors: { name_fr: "required" } });
    await query(
      `UPDATE marketing_templates SET name_fr=?, name_en=?, description_fr=?, description_en=?, icon=?, category=?, kind=?, content=? WHERE id=?`,
      [f.name_fr, f.name_en, f.description_fr, f.description_en, f.icon, f.category, f.kind, f.content, id]);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "updateTemplate", e); }
};

export const deleteTemplate = async (req: Req, res: Response) => {
  try {
    const r: any = await query("DELETE FROM marketing_templates WHERE id = ? AND is_builtin = 0", [parseId(req.params.id)]);
    if (!Number(r?.affectedRows)) return fail(req, res, 409, "Les modèles d'origine ne peuvent pas être supprimés (vous pouvez les modifier ou les restaurer).", "Original templates cannot be deleted (you can edit or restore them).");
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "deleteTemplate", e); }
};

// POST /templates/:id/reset — restaure le contenu d'origine d'un modèle fourni avec la plateforme
export const resetTemplate = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const [t]: any = id ? await query("SELECT slug, is_builtin FROM marketing_templates WHERE id = ?", [id]) : [];
    const orig = t && Number(t.is_builtin) ? originalPreset(t.slug) : null;
    if (!orig) return fail(req, res, 404, "Aucun modèle d'origine à restaurer.", "No original template to restore.");
    await query("UPDATE marketing_templates SET name_fr=?, name_en=?, description_fr=?, description_en=?, content=? WHERE id=?",
      [orig.name_fr, orig.name_en, orig.description_fr, orig.description_en, JSON.stringify(orig.content), id]);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "resetTemplate", e); }
};

// ══════════════════════════════════════════════════════
// AUTOMATISATIONS
// ══════════════════════════════════════════════════════
const AUTO_STATS = `
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = a.campaign_id AND s.status = 'sent') AS sent,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = a.campaign_id AND s.status = 'queued') AS queued,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = a.campaign_id AND s.opened_at IS NOT NULL) AS opened,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = a.campaign_id AND s.clicked_at IS NOT NULL) AS clicked,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = a.campaign_id AND s.unsubscribed_at IS NOT NULL) AS unsubscribed`;

const shapeAuto = (r: any) => ({
  ...r, enabled: !!Number(r.enabled), blocks_fr: parseJson(r.blocks_fr, []), blocks_en: parseJson(r.blocks_en, []),
  is_preset: AUTOMATION_PRESETS.some((p) => p.slug === r.slug),
  sent: num(r.sent), queued: num(r.queued), opened: num(r.opened), clicked: num(r.clicked), unsubscribed: num(r.unsubscribed),
});

export const listAutomations = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const rows: any[] = await query(`SELECT a.*, ${AUTO_STATS} FROM marketing_automations a ORDER BY a.id`);
    return res.json({ success: true, data: plain(rows.map(shapeAuto)) });
  } catch (e) { return serverError(req, res, "listAutomations", e); }
};

const cleanAutoBlocks = (raw: any): Block[] => {
  if (!Array.isArray(raw)) return [];
  const url = (u: any) => { const v = str(u, 500); return /^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//")) ? v : ""; };
  const out: Block[] = [];
  for (const b of raw.slice(0, 40)) {
    if (!b) continue;
    if (b.type === "heading" || b.type === "text") out.push({ type: b.type, text: str(b.text, 4000) });
    else if (b.type === "button") out.push({ type: "button", label: str(b.label, 80), url: url(b.url) });
    else if (b.type === "image") out.push({ type: "image", url: url(b.url), alt: str(b.alt, 200), link: url(b.link) });
    else if (b.type === "course") { const id = parseId(b.course_id); if (id) out.push({ type: "course", course_id: id }); }
    else if (b.type === "coupon") out.push({ type: "coupon", code: str(b.code, 40), text: str(b.text, 200) });
    else if (b.type === "divider") out.push({ type: "divider" });
  }
  return out;
};

export const saveAutomation = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const id = req.params.id ? parseId(req.params.id) : null;
    const b = req.body || {};
    const TRIGGERS = ["signup", "no_enrollment", "inactive", "course_stalled", "course_completed"];
    const name_fr = str(b.name_fr, 200);
    if (name_fr.length < 2) return fail(req, res, 400, "Donnez un nom à l'automatisation.", "Give the automation a name.", { errors: { name_fr: "required" } });
    const vals = [
      name_fr, str(b.name_en, 200) || name_fr, Math.min(Math.max(Number(b.delay_days) || 0, 0), 365),
      ["newsletter", "promotions", "events"].includes(b.pref) ? b.pref : "newsletter",
      str(b.subject_fr, 250), str(b.subject_en, 250), str(b.preheader_fr, 250) || null, str(b.preheader_en, 250) || null,
      JSON.stringify(cleanAutoBlocks(b.blocks_fr)), JSON.stringify(cleanAutoBlocks(b.blocks_en)),
    ];
    if (id) {
      await query(`UPDATE marketing_automations SET name_fr=?, name_en=?, delay_days=?, pref=?, subject_fr=?, subject_en=?, preheader_fr=?, preheader_en=?, blocks_fr=?, blocks_en=? WHERE id=?`, [...vals, id]);
      return res.json({ success: true, data: { id } });
    }
    if (!TRIGGERS.includes(b.trigger_type)) return fail(req, res, 400, "Déclencheur invalide.", "Invalid trigger.");
    const r: any = await query(
      `INSERT INTO marketing_automations (slug, name_fr, name_en, delay_days, pref, subject_fr, subject_en, preheader_fr, preheader_en, blocks_fr, blocks_en, trigger_type, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [`custom_${newToken(6)}`, ...vals, b.trigger_type]);
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "saveAutomation", e); }
};

export const toggleAutomation = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const on = req.body?.enabled ? 1 : 0;
    const [a]: any = id ? await query("SELECT id, subject_fr, subject_en FROM marketing_automations WHERE id = ?", [id]) : [];
    if (!a) return fail(req, res, 404, "Automatisation introuvable", "Automation not found");
    if (on && !a.subject_fr && !a.subject_en) return fail(req, res, 400, "Ajoutez un objet avant d'activer.", "Add a subject before enabling.");
    await query("UPDATE marketing_automations SET enabled = ?, enabled_at = IF(? = 1, NOW(), enabled_at) WHERE id = ?", [on, on, id]);
    await logAudit(req, "admin", on ? "marketing.automation_enabled" : "marketing.automation_disabled", "automation", id, null, null);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "toggleAutomation", e); }
};

export const deleteAutomation = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const [a]: any = id ? await query("SELECT slug FROM marketing_automations WHERE id = ?", [id]) : [];
    if (!a || !String(a.slug).startsWith("custom_")) return fail(req, res, 409, "Les automatisations d'origine ne peuvent pas être supprimées (désactivez-les).", "Original automations cannot be deleted (disable them instead).");
    await query("DELETE FROM marketing_automations WHERE id = ?", [id]);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "deleteAutomation", e); }
};

export const resetAutomation = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const [a]: any = id ? await query("SELECT slug FROM marketing_automations WHERE id = ?", [id]) : [];
    const p = a ? AUTOMATION_PRESETS.find((x) => x.slug === a.slug) : null;
    if (!p) return fail(req, res, 404, "Aucun modèle d'origine à restaurer.", "No original to restore.");
    await query(
      "UPDATE marketing_automations SET name_fr=?, name_en=?, delay_days=?, pref=?, subject_fr=?, subject_en=?, preheader_fr=?, preheader_en=?, blocks_fr=?, blocks_en=? WHERE id=?",
      [p.name_fr, p.name_en, p.delay_days, p.pref, p.subject_fr, p.subject_en, p.preheader_fr, p.preheader_en, JSON.stringify(p.blocks_fr), JSON.stringify(p.blocks_en), id]);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "resetAutomation", e); }
};

// POST /automations/:id/test { email, lang }
export const testAutomation = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const email = str(req.body?.email, 190).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(req, res, 400, "Adresse email invalide", "Invalid email address");
    const [a]: any = id ? await query("SELECT * FROM marketing_automations WHERE id = ?", [id]) : [];
    if (!a) return fail(req, res, 404, "Automatisation introuvable", "Automation not found");
    const lang = req.body?.lang === "en" ? "en" : "fr";
    const blocks = getBlocks(a, lang);
    const data = await loadBlockData(blocks);
    const mail = renderEmail(a, blocks, { lang, firstName: req.user?.first_name || "Marie", apiBase: publicBaseUrl(req), data, preview: true, vars: { course_title: lang === "en" ? "Docker Fundamentals" : "Docker Fondamentaux" } });
    await sendEmail({ to: email, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
    return res.json({ success: true });
  } catch (e: any) {
    return fail(req, res, 502, `Envoi impossible : ${e?.message || "erreur SMTP"}`, `Could not send: ${e?.message || "SMTP error"}`);
  }
};

// GET /automations/:id/preview?lang= — rendu HTML (aperçu)
export const previewAutomation = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const [a]: any = id ? await query("SELECT * FROM marketing_automations WHERE id = ?", [id]) : [];
    if (!a) return fail(req, res, 404, "Automatisation introuvable", "Automation not found");
    const lang = req.query.lang === "en" ? "en" : "fr";
    const blocks = getBlocks(a, lang);
    const data = await loadBlockData(blocks);
    const mail = renderEmail(a, blocks, { lang, firstName: req.user?.first_name || "Marie", apiBase: publicBaseUrl(req), data, preview: true, vars: { course_title: lang === "en" ? "Docker Fundamentals" : "Docker Fondamentaux" } });
    const waiting = (await eligibleForAutomation({ ...a, enabled_at: a.enabled_at || new Date() }, 500)).length;
    return res.json({ success: true, data: { subject: mail.subject, html: mail.html, eligible_now: waiting } });
  } catch (e) { return serverError(req, res, "previewAutomation", e); }
};

// ══════════════════════════════════════════════════════
// CODES PROMO
// ══════════════════════════════════════════════════════
export const listCoupons = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const rows: any[] = await query(
      `SELECT c.*, mc.name AS campaign_name,
              (SELECT COALESCE(SUM(u.discount_applied), 0) FROM coupon_usages u WHERE u.coupon_id = c.id) AS discount_total,
              (SELECT COALESCE(SUM(p.amount), 0) FROM course_enrollments ce
                 JOIN payments p ON p.user_id = ce.user_id AND p.course_id = ce.course_id AND p.status = 'validated'
                WHERE ce.coupon_id = c.id) AS revenue
         FROM coupons c LEFT JOIN marketing_campaigns mc ON mc.id = c.campaign_id ORDER BY c.id DESC LIMIT 300`);
    return res.json({ success: true, data: plain(rows.map((r) => ({ ...r, is_active: !!Number(r.is_active), course_ids: parseJson(r.course_ids, []), category_ids: parseJson(r.category_ids, []), discount_total: num(r.discount_total), revenue: num(r.revenue) }))) });
  } catch (e) { return serverError(req, res, "listCoupons", e); }
};

const randomCode = (prefix = "PROMO") => `${prefix.replace(/[^A-Z0-9]/g, "").slice(0, 10)}${newToken(3).toUpperCase()}`;

export const createCoupon = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const b = req.body || {};
    let code = normalizeCode(b.code);
    if (!code) code = randomCode(normalizeCode(b.prefix) || "PROMO");
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return fail(req, res, 400, "Code invalide (3 à 40 caractères : lettres, chiffres, - et _).", "Invalid code (3 to 40 characters: letters, digits, - and _).", { errors: { code: "invalid" } });
    const type = b.discount_type === "fixed" ? "fixed" : "percentage";
    const value = Number(b.discount_value);
    if (!Number.isFinite(value) || value <= 0 || (type === "percentage" && value > 100)) return fail(req, res, 400, type === "percentage" ? "Réduction entre 1 et 100 %." : "Montant invalide.", type === "percentage" ? "Discount must be between 1 and 100%." : "Invalid amount.", { errors: { discount_value: "invalid" } });
    const [dup]: any = await query("SELECT id FROM coupons WHERE UPPER(code) = ?", [code]);
    if (dup) return fail(req, res, 409, "Ce code existe déjà.", "This code already exists.", { errors: { code: "duplicate" } });

    const scope = ["specific_courses", "specific_categories"].includes(b.applicable_to) ? b.applicable_to : "all";
    const ids = (a: any) => (Array.isArray(a) ? a.map(parseId).filter(Boolean) : []);
    const courseIds = scope === "specific_courses" ? ids(b.course_ids) : [];
    const catIds = scope === "specific_categories" ? ids(b.category_ids) : [];
    if (scope === "specific_courses" && !courseIds.length) return fail(req, res, 400, "Choisissez au moins un cours.", "Choose at least one course.");
    if (scope === "specific_categories" && !catIds.length) return fail(req, res, 400, "Choisissez au moins une catégorie.", "Choose at least one category.");
    const date = (v: any) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
    const expires = date(b.expires_at);
    if (expires && expires.getTime() <= Date.now()) return fail(req, res, 400, "La date de fin doit être dans le futur.", "The end date must be in the future.", { errors: { expires_at: "invalid" } });

    const r: any = await query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, max_uses, max_uses_per_user, applicable_to, course_ids, category_ids, minimum_amount, starts_at, expires_at, is_active, created_by, campaign_id, is_public)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [code, str(b.description, 255) || null, type, value, parseId(b.max_uses), Math.max(parseId(b.max_uses_per_user) || 1, 1), scope,
       courseIds.length ? JSON.stringify(courseIds) : null, catIds.length ? JSON.stringify(catIds) : null, Math.max(Number(b.minimum_amount) || 0, 0),
       date(b.starts_at), expires, req.user!.id, parseId(b.campaign_id), b.is_public === false ? 0 : 1]);
    await logAudit(req, "admin", "marketing.coupon_created", "coupon", Number(r.insertId), null, { code, type, value });
    return res.status(201).json({ success: true, data: { id: Number(r.insertId), code } });
  } catch (e) { return serverError(req, res, "createCoupon", e); }
};

export const updateCoupon = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const b = req.body || {};
    const date = (v: any) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
    await query("UPDATE coupons SET is_active = ?, expires_at = ?, max_uses = ?, is_public = COALESCE(?, is_public) WHERE id = ?",
      [b.is_active === false ? 0 : 1, date(b.expires_at), parseId(b.max_uses), typeof b.is_public === "boolean" ? (b.is_public ? 1 : 0) : null, id]);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "updateCoupon", e); }
};

// GET /marketing/offers — codes promo « affichés sur le site » (public, sans connexion).
// Ne renvoie que les codes actifs, commencés, non expirés et non épuisés, pour que les cours affichent le pourcentage.
export const publicOffers = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const rows: any[] = await query(
      `SELECT code, discount_type, discount_value, applicable_to, course_ids, category_ids, minimum_amount, expires_at, max_uses, uses_count
         FROM coupons
        WHERE is_active = 1 AND is_public = 1
          AND (starts_at IS NULL OR starts_at <= NOW()) AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses IS NULL OR uses_count < max_uses)
        ORDER BY discount_value DESC LIMIT 50`);
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ success: true, data: plain(rows.map((r) => ({
      code: r.code, discount_type: r.discount_type, discount_value: Number(r.discount_value), applicable_to: r.applicable_to,
      course_ids: parseJson(r.course_ids, []), category_ids: parseJson(r.category_ids, []), minimum_amount: Number(r.minimum_amount) || 0,
      expires_at: r.expires_at, remaining: r.max_uses === null || r.max_uses === undefined ? null : Math.max(Number(r.max_uses) - Number(r.uses_count), 0),
    }))) });
  } catch (e) { return serverError(req, res, "publicOffers", e); }
};

export const deleteCoupon = async (req: Req, res: Response) => {
  try {
    const r: any = await query("DELETE FROM coupons WHERE id = ? AND uses_count = 0", [parseId(req.params.id)]);
    if (!Number(r?.affectedRows)) return fail(req, res, 409, "Un code déjà utilisé ne peut pas être supprimé : désactivez-le.", "A code that has been used cannot be deleted: disable it instead.");
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "deleteCoupon", e); }
};

// POST /coupons/validate { code, course_id } — étudiant connecté, avant le paiement
export const validateCoupon = async (req: Req, res: Response) => {
  try {
    const courseId = parseId(req.body?.course_id);
    if (!courseId) return fail(req, res, 400, "Cours invalide", "Invalid course");
    const chk = await checkCoupon(req.body?.code, req.user!.id, courseId);
    if (!chk.ok) return res.status(200).json({ success: true, data: { valid: false, code: chk.error, message: couponMessage(req as unknown as Request, chk.error!) } });
    return res.json({
      success: true,
      data: { valid: true, code: String(chk.coupon.code), base_price: chk.base, discount: chk.discount, final_price: chk.final },
    });
  } catch (e) { return serverError(req, res, "validateCoupon", e); }
};
