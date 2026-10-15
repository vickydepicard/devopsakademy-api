// src/controllers/marketingController.ts
// Newsletter, offres, bannières, réseaux sociaux, promotions : API d'administration + routes publiques
// (ouverture, clic, désabonnement, préférences, inscription, bannières actives).
import { Request, Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { fail, serverError, logAudit } from "../utils/respond";
import { publicBaseUrl } from "../utils/publicUrl";
import { parseId } from "../utils/serialize";
import { sendEmail, escapeHtml } from "../services/mail.service";
import { ensureMarketingTables, newToken, plain, num, parseJson, frontendUrl, ensureAllPreferences, getUserPrefs } from "./marketingSetup";
import { resolveAudience, CampaignKind } from "./marketingAudience";
import { Block, collectLinks, getBlocks, loadBlockData, renderEmail } from "./marketingRender";
import { startCampaign, dailyLimit, sentToday, telegramConfigured, publishTelegram, activatePromotion, endPromotion } from "./marketingJobs";

type Req = AuthenticatedRequest;

const KINDS: CampaignKind[] = ["newsletter", "offer", "webinar", "announcement"];
const BLOCK_TYPES = ["heading", "text", "image", "button", "course", "webinar", "coupon", "divider"];
const str = (v: any, max: number) => String(v ?? "").trim().slice(0, max);

// ══════════════════════════════════════════════════════
// NETTOYAGE DES ENTRÉES
// ══════════════════════════════════════════════════════
const cleanBlocks = (raw: any): Block[] => {
  if (!Array.isArray(raw)) return [];
  const safeUrl = (u: any) => { const v = str(u, 500); return /^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//")) ? v : ""; };
  const out: Block[] = [];
  for (const b of raw.slice(0, 60)) {
    if (!b || !BLOCK_TYPES.includes(b.type)) continue;
    const t = b.type as Block["type"];
    if (t === "heading" || t === "text") out.push({ type: t, text: str(b.text, 4000) });
    else if (t === "image") out.push({ type: t, url: safeUrl(b.url), alt: str(b.alt, 200), link: safeUrl(b.link) });
    else if (t === "button") out.push({ type: t, label: str(b.label, 80), url: safeUrl(b.url) });
    else if (t === "course") { const id = parseId(b.course_id); if (id) out.push({ type: t, course_id: id }); }
    else if (t === "webinar") { const id = parseId(b.bootcamp_id); if (id) out.push({ type: t, bootcamp_id: id }); }
    else if (t === "coupon") out.push({ type: t, code: str(b.code, 40), text: str(b.text, 200) });
    else out.push({ type: "divider" });
  }
  return out;
};

const cleanAudience = (a: any) => {
  const o = a && typeof a === "object" ? a : {};
  const id = (v: any) => parseId(v);
  return {
    roles: (Array.isArray(o.roles) ? o.roles : []).filter((r: any) => ["student", "instructor"].includes(r)),
    lang: ["fr", "en"].includes(o.lang) ? o.lang : "",
    verified_only: o.verified_only !== false,
    enrolled_course_id: id(o.enrolled_course_id),
    category_id: id(o.category_id),
    subscription: ["active", "none"].includes(o.subscription) ? o.subscription : "any",
    inactive_days: id(o.inactive_days),
    new_days: id(o.new_days),
    never_enrolled: !!o.never_enrolled,
    include_contacts: !!o.include_contacts,
  };
};

const cleanChannels = (c: any) => {
  const o = c && typeof c === "object" ? c : {};
  const banner = o.banner && typeof o.banner === "object" ? {
    placement: o.banner.placement === "popup" ? "popup" : "top_bar",
    title_fr: str(o.banner.title_fr, 200), title_en: str(o.banner.title_en, 200),
    body_fr: str(o.banner.body_fr, 500), body_en: str(o.banner.body_en, 500),
    cta_label_fr: str(o.banner.cta_label_fr, 80), cta_label_en: str(o.banner.cta_label_en, 80),
    cta_url: str(o.banner.cta_url, 500), image_url: str(o.banner.image_url, 500),
    tone: ["info", "promo", "success", "urgent"].includes(o.banner.tone) ? o.banner.tone : "promo",
    audience: ["all", "visitors", "students", "instructors"].includes(o.banner.audience) ? o.banner.audience : "all",
    ends_at: o.banner.ends_at || null,
  } : null;
  return {
    email: o.email !== false, inapp: !!o.inapp, inapp_link: str(o.inapp_link, 300) || "/",
    banner, telegram: !!o.telegram, social_text: str(o.social_text, 3500), social_link: str(o.social_link, 500), social_image: str(o.social_image, 500),
  };
};

const cleanAb = (a: any) => {
  const o = a && typeof a === "object" ? a : {};
  return {
    enabled: !!o.enabled,
    subject_b_fr: str(o.subject_b_fr, 250), subject_b_en: str(o.subject_b_en, 250),
    preheader_b_fr: str(o.preheader_b_fr, 250), preheader_b_en: str(o.preheader_b_en, 250),
    sample_percent: Math.min(Math.max(Number(o.sample_percent) || 20, 10), 50),
    wait_hours: Math.min(Math.max(Number(o.wait_hours) || 4, 1), 72),
    metric: o.metric === "opens" ? "opens" : "clicks",
  };
};

const toDate = (v: any): Date | null => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };

// ══════════════════════════════════════════════════════
// ADMIN — VUE D'ENSEMBLE
// ══════════════════════════════════════════════════════
export const adminMeta = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const [q]: any = await query("SELECT COUNT(*) AS n FROM marketing_sends s JOIN marketing_campaigns c ON c.id = s.campaign_id WHERE s.status = 'queued' AND c.status = 'sending'");
    return res.json({
      success: true,
      data: {
        telegram_configured: telegramConfigured(),
        smtp_configured: !!(process.env.MAIL_USER && process.env.MAIL_PASSWORD),
        daily_limit: dailyLimit(), sent_today: await sentToday(), queued: num(q?.n),
      },
    });
  } catch (e) { return serverError(req, res, "adminMeta", e); }
};

// ══════════════════════════════════════════════════════
// ADMIN — CAMPAGNES
// ══════════════════════════════════════════════════════
const STATS_SQL = `
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = c.id AND s.status = 'sent') AS sent,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = c.id AND s.status = 'failed') AS failed,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = c.id AND s.status = 'queued') AS queued,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = c.id AND s.opened_at IS NOT NULL) AS opened,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = c.id AND s.clicked_at IS NOT NULL) AS clicked,
  (SELECT COUNT(*) FROM marketing_sends s WHERE s.campaign_id = c.id AND s.unsubscribed_at IS NOT NULL) AS unsubscribed`;

const shape = (r: any) => ({
  ...r,
  blocks_fr: parseJson(r.blocks_fr, []), blocks_en: parseJson(r.blocks_en, []),
  audience: parseJson(r.audience, {}), channels: parseJson(r.channels, { email: true }), ab_test: parseJson(r.ab_test, null),
  sent: num(r.sent), failed: num(r.failed), queued: num(r.queued), opened: num(r.opened), clicked: num(r.clicked), unsubscribed: num(r.unsubscribed),
});

export const listCampaigns = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const rows: any[] = await query(
      `SELECT c.id, c.name, c.kind, c.template, c.status, c.subject_fr, c.subject_en, c.scheduled_at, c.started_at, c.finished_at, c.recipients_total, c.created_at, ${STATS_SQL}
         FROM marketing_campaigns c WHERE c.automation_id IS NULL ORDER BY c.id DESC LIMIT 200`);
    return res.json({ success: true, data: plain(rows.map((r) => ({ ...r, sent: num(r.sent), failed: num(r.failed), queued: num(r.queued), opened: num(r.opened), clicked: num(r.clicked), unsubscribed: num(r.unsubscribed) }))) });
  } catch (e) { return serverError(req, res, "listCampaigns", e); }
};

export const getCampaign = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const id = parseId(req.params.id);
    const [r]: any = id ? await query(`SELECT c.*, ${STATS_SQL} FROM marketing_campaigns c WHERE c.id = ?`, [id]) : [];
    if (!r) return fail(req, res, 404, "Campagne introuvable", "Campaign not found");
    const c = shape(plain(r));
    const links = collectLinks(c.blocks_fr.length ? c.blocks_fr : c.blocks_en);
    const stats: any[] = await query("SELECT link_index, clicks FROM marketing_link_stats WHERE campaign_id = ?", [id]);
    const byIdx = new Map(stats.map((s) => [Number(s.link_index), num(s.clicks)]));
    const vs: any[] = await query(
      `SELECT variant, COUNT(*) AS total, SUM(status = 'sent') AS sent, SUM(opened_at IS NOT NULL) AS opened, SUM(clicked_at IS NOT NULL) AS clicked
         FROM marketing_sends WHERE campaign_id = ? AND variant IN ('A','B') GROUP BY variant`, [id]);
    const variants = vs.map((v) => ({ variant: v.variant, total: num(v.total), sent: num(v.sent), opened: num(v.opened), clicked: num(v.clicked) }));
    const [held]: any = await query("SELECT COUNT(*) AS n FROM marketing_sends WHERE campaign_id = ? AND status = 'held'", [id]);
    return res.json({ success: true, data: { ...c, links: links.map((url, i) => ({ url, clicks: byIdx.get(i) || 0 })), variants, held: num(held?.n) } });
  } catch (e) { return serverError(req, res, "getCampaign", e); }
};

export const saveCampaign = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const id = req.params.id ? parseId(req.params.id) : null;
    const b = req.body || {};
    const name = str(b.name, 200);
    if (name.length < 2) return fail(req, res, 400, "Donnez un nom à la campagne.", "Give the campaign a name.", { errors: { name: "required" } });
    const kind: CampaignKind = KINDS.includes(b.kind) ? b.kind : "newsletter";
    const row = [
      name, kind, str(b.template, 40) || null,
      str(b.subject_fr, 250), str(b.subject_en, 250), str(b.preheader_fr, 250) || null, str(b.preheader_en, 250) || null,
      JSON.stringify(cleanBlocks(b.blocks_fr)), JSON.stringify(cleanBlocks(b.blocks_en)),
      JSON.stringify(cleanAudience(b.audience)), JSON.stringify(cleanChannels(b.channels)), publicBaseUrl(req), JSON.stringify(cleanAb(b.ab_test)),
    ];
    if (id) {
      const [cur]: any = await query("SELECT status FROM marketing_campaigns WHERE id = ?", [id]);
      if (!cur) return fail(req, res, 404, "Campagne introuvable", "Campaign not found");
      if (!["draft", "scheduled"].includes(cur.status)) return fail(req, res, 409, "Cette campagne n'est plus modifiable.", "This campaign can no longer be edited.");
      await query(
        `UPDATE marketing_campaigns SET name=?, kind=?, template=?, subject_fr=?, subject_en=?, preheader_fr=?, preheader_en=?, blocks_fr=?, blocks_en=?, audience=?, channels=?, api_base=?, ab_test=? WHERE id=?`,
        [...row, id]);
      return res.json({ success: true, data: { id } });
    }
    const r: any = await query(
      `INSERT INTO marketing_campaigns (name, kind, template, subject_fr, subject_en, preheader_fr, preheader_en, blocks_fr, blocks_en, audience, channels, api_base, ab_test, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...row, req.user!.id]);
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "saveCampaign", e); }
};

export const deleteCampaign = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const r: any = await query("DELETE FROM marketing_campaigns WHERE id = ? AND status IN ('draft','cancelled')", [id]);
    if (!Number(r?.affectedRows)) return fail(req, res, 409, "Seuls les brouillons et campagnes annulées peuvent être supprimés.", "Only drafts and cancelled campaigns can be deleted.");
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "deleteCampaign", e); }
};

export const duplicateCampaign = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const r: any = await query(
      `INSERT INTO marketing_campaigns (name, kind, template, subject_fr, subject_en, preheader_fr, preheader_en, blocks_fr, blocks_en, audience, channels, api_base, ab_test, created_by)
       SELECT CONCAT(name, ' (copie)'), kind, template, subject_fr, subject_en, preheader_fr, preheader_en, blocks_fr, blocks_en, audience, channels, api_base, ab_test, ? FROM marketing_campaigns WHERE id = ? AND automation_id IS NULL`,
      [req.user!.id, id]);
    if (!Number(r?.insertId)) return fail(req, res, 404, "Campagne introuvable", "Campaign not found");
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "duplicateCampaign", e); }
};

// POST /campaigns/:id/schedule { scheduled_at? }  — sans date : envoi immédiat
export const scheduleCampaign = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const id = parseId(req.params.id);
    const [c]: any = id ? await query("SELECT * FROM marketing_campaigns WHERE id = ?", [id]) : [];
    if (!c) return fail(req, res, 404, "Campagne introuvable", "Campaign not found");
    if (!["draft", "scheduled"].includes(c.status)) return fail(req, res, 409, "Cette campagne est déjà lancée.", "This campaign has already been launched.");

    const channels = parseJson<any>(c.channels, { email: true });
    const blocks = [...getBlocks(c, "fr"), ...getBlocks(c, "en")];
    if (channels.email && ((!c.subject_fr && !c.subject_en) || !blocks.length))
      return fail(req, res, 400, "Ajoutez un objet et du contenu avant d'envoyer.", "Add a subject and some content before sending.");
    if (!channels.email && !channels.inapp && !channels.banner && !channels.telegram)
      return fail(req, res, 400, "Choisissez au moins un canal.", "Choose at least one channel.");

    const when = toDate(req.body?.scheduled_at);
    await query("UPDATE marketing_campaigns SET api_base = ? WHERE id = ?", [publicBaseUrl(req), id]);
    if (when && when.getTime() > Date.now() + 30_000) {
      await query("UPDATE marketing_campaigns SET status = 'scheduled', scheduled_at = ? WHERE id = ?", [when, id]);
      await logAudit(req, "admin", "marketing.campaign_scheduled", "campaign", id, null, { scheduled_at: when.toISOString() });
      return res.json({ success: true, data: { status: "scheduled" } });
    }
    await query("UPDATE marketing_campaigns SET scheduled_at = NOW() WHERE id = ?", [id]);
    const started = await startCampaign(id!);
    await logAudit(req, "admin", "marketing.campaign_sent", "campaign", id, null, { name: c.name });
    return res.json({ success: true, data: { status: started ? "sending" : c.status } });
  } catch (e) { return serverError(req, res, "scheduleCampaign", e); }
};

export const cancelCampaign = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const r: any = await query("UPDATE marketing_campaigns SET status = 'cancelled', finished_at = NOW() WHERE id = ? AND status IN ('scheduled','sending')", [id]);
    if (!Number(r?.affectedRows)) return fail(req, res, 409, "Cette campagne ne peut pas être annulée.", "This campaign cannot be cancelled.");
    await query("DELETE FROM marketing_sends WHERE campaign_id = ? AND status IN ('queued','held')", [id]);   // les envois non partis sont retirés
    await logAudit(req, "admin", "marketing.campaign_cancelled", "campaign", id, null, null);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "cancelCampaign", e); }
};

export const retryFailed = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const r: any = await query("UPDATE marketing_sends SET status = 'queued', error = NULL WHERE campaign_id = ? AND status = 'failed'", [id]);
    if (Number(r?.affectedRows)) await query("UPDATE marketing_campaigns SET status = 'sending', finished_at = NULL WHERE id = ? AND status = 'sent'", [id]);
    return res.json({ success: true, data: { requeued: Number(r?.affectedRows) || 0 } });
  } catch (e) { return serverError(req, res, "retryFailed", e); }
};

// POST /preview { campaign fields, lang }
export const previewCampaign = async (req: Req, res: Response) => {
  try {
    const lang = req.body?.lang === "en" ? "en" : "fr";
    const blocks = cleanBlocks(lang === "en" ? req.body?.blocks_en : req.body?.blocks_fr);
    const fallback = cleanBlocks(lang === "en" ? req.body?.blocks_fr : req.body?.blocks_en);
    const use = blocks.length ? blocks : fallback;
    const data = await loadBlockData(use);
    const mail = renderEmail(
      { subject_fr: str(req.body?.subject_fr, 250), subject_en: str(req.body?.subject_en, 250), preheader_fr: str(req.body?.preheader_fr, 250), preheader_en: str(req.body?.preheader_en, 250) },
      use, { lang, firstName: req.user?.first_name || "Marie", apiBase: publicBaseUrl(req), data, preview: true });
    return res.json({ success: true, data: { subject: mail.subject, html: mail.html } });
  } catch (e) { return serverError(req, res, "previewCampaign", e); }
};

// POST /campaigns/:id/test { email, lang }
export const testCampaign = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const email = str(req.body?.email, 190).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(req, res, 400, "Adresse email invalide", "Invalid email address");
    const [c]: any = id ? await query("SELECT * FROM marketing_campaigns WHERE id = ?", [id]) : [];
    if (!c) return fail(req, res, 404, "Campagne introuvable", "Campaign not found");
    const lang = req.body?.lang === "en" ? "en" : "fr";
    const blocks = getBlocks(c, lang);
    const data = await loadBlockData(blocks);
    const mail = renderEmail(c, blocks, { lang, firstName: req.user?.first_name || "Marie", apiBase: publicBaseUrl(req), data, preview: true });
    await sendEmail({ to: email, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
    return res.json({ success: true });
  } catch (e: any) {
    console.error("testCampaign:", e?.message || e);
    return fail(req, res, 502, `Envoi impossible : ${e?.message || "erreur SMTP"}`, `Could not send: ${e?.message || "SMTP error"}`);
  }
};

// POST /audience/count { kind, audience }
export const audienceCount = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const kind: CampaignKind = KINDS.includes(req.body?.kind) ? req.body.kind : "newsletter";
    const list = await resolveAudience(kind, cleanAudience(req.body?.audience));
    return res.json({
      success: true,
      data: {
        total: list.length, fr: list.filter((r) => r.lang === "fr").length, en: list.filter((r) => r.lang === "en").length,
        contacts: list.filter((r) => r.contact_id).length,
        sample: list.slice(0, 5).map((r) => ({ email: r.email.replace(/^(.).*(@.*)$/, "$1***$2"), first_name: r.first_name })),
      },
    });
  } catch (e) { return serverError(req, res, "audienceCount", e); }
};

export const listRecipients = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const status = ["queued", "sent", "failed"].includes(String(req.query.status)) ? String(req.query.status) : null;
    const page = Math.max(parseId(req.query.page) || 1, 1), limit = 50;
    const where = `campaign_id = ?${status ? " AND status = ?" : ""}`;
    const params = status ? [id, status] : [id];
    const rows: any[] = await query(
      `SELECT id, email, first_name, lang, status, error, sent_at, opened_at, open_count, clicked_at, click_count, unsubscribed_at FROM marketing_sends WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]);
    const [{ n }]: any = await query(`SELECT COUNT(*) AS n FROM marketing_sends WHERE ${where}`, params);
    return res.json({ success: true, data: plain(rows), pagination: { page, limit, total: num(n) } });
  } catch (e) { return serverError(req, res, "listRecipients", e); }
};

// ══════════════════════════════════════════════════════
// ADMIN — BANNIÈRES
// ══════════════════════════════════════════════════════
export const listBanners = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const rows: any[] = await query("SELECT * FROM marketing_banners ORDER BY id DESC LIMIT 200");
    return res.json({ success: true, data: plain(rows.map((r) => ({ ...r, is_active: !!Number(r.is_active) }))) });
  } catch (e) { return serverError(req, res, "listBanners", e); }
};

export const saveBanner = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const id = req.params.id ? parseId(req.params.id) : null;
    const b = req.body || {};
    const title_fr = str(b.title_fr, 200);
    if (title_fr.length < 2) return fail(req, res, 400, "Titre requis (français).", "A title is required (French).", { errors: { title_fr: "required" } });
    const url = str(b.cta_url, 500);
    if (url && !/^https?:\/\//i.test(url) && !url.startsWith("/")) return fail(req, res, 400, "Lien invalide.", "Invalid link.", { errors: { cta_url: "invalid" } });
    const v = [
      ["popup", "inline_home", "inline_dashboard", "inline_catalog"].includes(b.placement) ? b.placement : "top_bar", title_fr, str(b.title_en, 200) || title_fr,
      str(b.body_fr, 500) || null, str(b.body_en, 500) || null, str(b.cta_label_fr, 80) || null, str(b.cta_label_en, 80) || null,
      url || null, str(b.image_url, 500) || null,
      ["info", "promo", "success", "urgent"].includes(b.tone) ? b.tone : "promo",
      ["all", "visitors", "students", "instructors"].includes(b.audience) ? b.audience : "all",
      toDate(b.starts_at), toDate(b.ends_at), b.is_active === false ? 0 : 1,
    ];
    if (id) {
      await query(`UPDATE marketing_banners SET placement=?, title_fr=?, title_en=?, body_fr=?, body_en=?, cta_label_fr=?, cta_label_en=?, cta_url=?, image_url=?, tone=?, audience=?, starts_at=?, ends_at=?, is_active=? WHERE id=?`, [...v, id]);
      return res.json({ success: true, data: { id } });
    }
    const r: any = await query(`INSERT INTO marketing_banners (placement, title_fr, title_en, body_fr, body_en, cta_label_fr, cta_label_en, cta_url, image_url, tone, audience, starts_at, ends_at, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...v, req.user!.id]);
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "saveBanner", e); }
};

export const deleteBanner = async (req: Req, res: Response) => {
  try { await query("DELETE FROM marketing_banners WHERE id = ?", [parseId(req.params.id)]); return res.json({ success: true }); }
  catch (e) { return serverError(req, res, "deleteBanner", e); }
};

// ══════════════════════════════════════════════════════
// ADMIN — RÉSEAUX SOCIAUX
// ══════════════════════════════════════════════════════
export const listSocial = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const rows: any[] = await query("SELECT * FROM marketing_social_posts ORDER BY id DESC LIMIT 100");
    return res.json({ success: true, data: plain(rows), telegram_configured: telegramConfigured() });
  } catch (e) { return serverError(req, res, "listSocial", e); }
};

// POST /social { channel, text, image_url, link_url, publish }
export const createSocial = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const channel = ["telegram", "linkedin", "facebook", "x", "whatsapp"].includes(req.body?.channel) ? req.body.channel : "telegram";
    const text = str(req.body?.text, 3500), image = str(req.body?.image_url, 500) || null, link = str(req.body?.link_url, 500) || null;
    if (text.length < 3) return fail(req, res, 400, "Écrivez le texte de la publication.", "Write the post text.");
    let status: "draft" | "published" | "failed" = "draft", externalId: string | null = null, error: string | null = null;
    if (req.body?.publish && channel === "telegram") {
      const r = await publishTelegram(link ? `${text}\n\n${link}` : text, image);
      status = r.ok ? "published" : "failed"; externalId = r.id || null; error = r.error || null;
      if (!r.ok) return fail(req, res, 502, `Publication Telegram impossible : ${r.error}`, `Telegram publishing failed: ${r.error}`);
    }
    const ins: any = await query(
      "INSERT INTO marketing_social_posts (channel, text, image_url, link_url, status, external_id, error, created_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [channel, text, image, link, status, externalId, error, req.user!.id, status === "published" ? new Date() : null]);
    return res.status(201).json({ success: true, data: { id: Number(ins.insertId), status } });
  } catch (e) { return serverError(req, res, "createSocial", e); }
};

export const deleteSocial = async (req: Req, res: Response) => {
  try { await query("DELETE FROM marketing_social_posts WHERE id = ?", [parseId(req.params.id)]); return res.json({ success: true }); }
  catch (e) { return serverError(req, res, "deleteSocial", e); }
};

// ══════════════════════════════════════════════════════
// ADMIN — ABONNÉS
// ══════════════════════════════════════════════════════
export const subscribersSummary = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    await ensureAllPreferences();
    const [u]: any = await query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(mp.unsubscribed_all = 0 AND mp.newsletter = 1), 0) AS newsletter,
              COALESCE(SUM(mp.unsubscribed_all = 0 AND mp.promotions = 1), 0) AS promotions,
              COALESCE(SUM(mp.unsubscribed_all = 0 AND mp.events = 1), 0) AS events,
              COALESCE(SUM(mp.unsubscribed_all = 1), 0) AS unsubscribed
         FROM users u JOIN marketing_preferences mp ON mp.user_id = u.id WHERE u.is_active = 1`);
    const [c]: any = await query("SELECT COALESCE(SUM(status='subscribed'),0) AS subscribed, COALESCE(SUM(status='pending'),0) AS pending, COALESCE(SUM(status='unsubscribed'),0) AS unsubscribed FROM marketing_contacts");
    return res.json({ success: true, data: plain({ users: u, contacts: c }) });
  } catch (e) { return serverError(req, res, "subscribersSummary", e); }
};

export const listSubscribers = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    await ensureAllPreferences();
    const search = str(req.query.search, 80);
    const filter = ["subscribed", "unsubscribed"].includes(String(req.query.filter)) ? String(req.query.filter) : "all";
    const page = Math.max(parseId(req.query.page) || 1, 1), limit = 40;
    const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
    const where: string[] = ["u.is_active = 1"]; const params: any[] = [];
    if (search) { where.push("(u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)"); params.push(like, like, like); }
    if (filter === "subscribed") where.push("mp.unsubscribed_all = 0");
    if (filter === "unsubscribed") where.push("mp.unsubscribed_all = 1");
    const rows: any[] = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, COALESCE(u.preferred_language,'fr') AS lang, mp.newsletter, mp.promotions, mp.events, mp.unsubscribed_all
         FROM users u JOIN marketing_preferences mp ON mp.user_id = u.id WHERE ${where.join(" AND ")} ORDER BY u.id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    const [{ n }]: any = await query(`SELECT COUNT(*) AS n FROM users u JOIN marketing_preferences mp ON mp.user_id = u.id WHERE ${where.join(" AND ")}`, params);
    const contacts: any[] = page === 1 ? await query(
      `SELECT id, email, first_name, lang, status, created_at, source FROM marketing_contacts ${search ? "WHERE email LIKE ? OR first_name LIKE ?" : ""} ORDER BY id DESC LIMIT 100`, search ? [like, like] : []) : [];
    return res.json({ success: true, data: plain(rows.map((r) => ({ ...r, newsletter: !!Number(r.newsletter), promotions: !!Number(r.promotions), events: !!Number(r.events), unsubscribed_all: !!Number(r.unsubscribed_all) }))), contacts: plain(contacts), pagination: { page, limit, total: num(n) } });
  } catch (e) { return serverError(req, res, "listSubscribers", e); }
};

// PATCH /subscribers/user/:id { unsubscribed_all }
export const setUserSubscription = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 404, "Utilisateur introuvable", "User not found");
    await getUserPrefs(id);
    await query("UPDATE marketing_preferences SET unsubscribed_all = ? WHERE user_id = ?", [req.body?.unsubscribed_all ? 1 : 0, id]);
    await logAudit(req, "admin", "marketing.subscription_changed", "user", id, null, { unsubscribed_all: !!req.body?.unsubscribed_all });
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "setUserSubscription", e); }
};

// POST /contacts { email, first_name, lang } — ajout manuel (confirmé d'office : consentement recueilli par ailleurs)
export const addContact = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const email = str(req.body?.email, 190).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(req, res, 400, "Adresse email invalide", "Invalid email address");
    await query(
      `INSERT INTO marketing_contacts (email, first_name, lang, source, status, token) VALUES (?, ?, ?, 'admin', 'subscribed', ?)
       ON DUPLICATE KEY UPDATE first_name = COALESCE(VALUES(first_name), first_name), status = 'subscribed', unsubscribed_at = NULL`,
      [email, str(req.body?.first_name, 100) || null, req.body?.lang === "en" ? "en" : "fr", newToken()]);
    return res.status(201).json({ success: true });
  } catch (e) { return serverError(req, res, "addContact", e); }
};

export const exportSubscribers = async (req: Req, res: Response) => {
  try {
    await ensureAllPreferences();
    const rows: any[] = await query(
      `SELECT u.email, u.first_name, u.last_name, u.role, COALESCE(u.preferred_language,'fr') AS lang, mp.newsletter, mp.promotions, mp.events, mp.unsubscribed_all
         FROM users u JOIN marketing_preferences mp ON mp.user_id = u.id WHERE u.is_active = 1 ORDER BY u.id`);
    const cell = (v: any) => { const s = String(v ?? ""); return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
    const lines = [["email", "first_name", "last_name", "role", "lang", "newsletter", "promotions", "events", "unsubscribed_all"].join(",")];
    for (const r of rows) lines.push([r.email, r.first_name, r.last_name, r.role, r.lang, num(r.newsletter), num(r.promotions), num(r.events), num(r.unsubscribed_all)].map(cell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="subscribers-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send("﻿" + lines.join("\r\n"));
  } catch (e) { return serverError(req, res, "exportSubscribers", e); }
};

// ══════════════════════════════════════════════════════
// ADMIN — PROMOTIONS DE PRIX (cours gratuit, moitié prix…)
// ══════════════════════════════════════════════════════
export const listPromotions = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const rows: any[] = await query(
      `SELECT p.*, c.title AS course_title, c.price AS current_price FROM marketing_promotions p JOIN courses c ON c.id = p.course_id ORDER BY p.id DESC LIMIT 200`);
    return res.json({ success: true, data: plain(rows) });
  } catch (e) { return serverError(req, res, "listPromotions", e); }
};

// POST /promotions { course_id, type: 'free'|'percent', percent?, starts_at, ends_at, campaign_id? }
export const createPromotion = async (req: Req, res: Response) => {
  try {
    await ensureMarketingTables();
    const courseId = parseId(req.body?.course_id);
    const type = req.body?.type === "free" ? "free" : "percent";
    const percent = type === "percent" ? Number(req.body?.percent) : null;
    const start = toDate(req.body?.starts_at) || new Date();
    const end = toDate(req.body?.ends_at);
    if (!courseId) return fail(req, res, 400, "Choisissez un cours.", "Choose a course.", { errors: { course_id: "required" } });
    if (type === "percent" && !(percent! >= 1 && percent! <= 95)) return fail(req, res, 400, "Réduction entre 1 et 95 %.", "Discount must be between 1 and 95%.", { errors: { percent: "invalid" } });
    if (!end || end.getTime() <= Math.max(start.getTime(), Date.now())) return fail(req, res, 400, "La date de fin doit être dans le futur, après le début.", "The end date must be in the future, after the start.", { errors: { ends_at: "invalid" } });
    if (end.getTime() - start.getTime() > 90 * 86400_000) return fail(req, res, 400, "Durée maximale : 90 jours.", "Maximum duration: 90 days.", { errors: { ends_at: "invalid" } });

    const [course]: any = await query("SELECT id, title, price, is_free FROM courses WHERE id = ?", [courseId]);
    if (!course) return fail(req, res, 404, "Cours introuvable", "Course not found");
    const [overlap]: any = await query(
      "SELECT id FROM marketing_promotions WHERE course_id = ? AND status IN ('scheduled','active') AND starts_at < ? AND ends_at > ?", [courseId, end, start]);
    if (overlap) return fail(req, res, 409, "Une promotion existe déjà sur ce cours pour cette période.", "A promotion already exists on this course for this period.");
    const [active]: any = await query("SELECT id FROM marketing_promotions WHERE course_id = ? AND status = 'active'", [courseId]);
    if (!active && (Number(course.is_free) === 1 || Number(course.price) <= 0)) return fail(req, res, 409, "Ce cours est déjà gratuit.", "This course is already free.");

    const ins: any = await query(
      "INSERT INTO marketing_promotions (campaign_id, course_id, type, percent, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [parseId(req.body?.campaign_id), courseId, type, percent, start, end, req.user!.id]);
    const pid = Number(ins.insertId);
    if (start.getTime() <= Date.now() + 5_000) {
      const [p]: any = await query("SELECT * FROM marketing_promotions WHERE id = ?", [pid]);
      await activatePromotion(p);
    }
    await logAudit(req, "admin", "marketing.promotion_created", "course", courseId, null, { type, percent, ends_at: end.toISOString() });
    return res.status(201).json({ success: true, data: { id: pid } });
  } catch (e) { return serverError(req, res, "createPromotion", e); }
};

export const cancelPromotion = async (req: Req, res: Response) => {
  try {
    const id = parseId(req.params.id);
    const [p]: any = id ? await query("SELECT * FROM marketing_promotions WHERE id = ?", [id]) : [];
    if (!p || !["scheduled", "active"].includes(p.status)) return fail(req, res, 404, "Promotion introuvable ou terminée", "Promotion not found or finished");
    await endPromotion(p, "cancelled");
    await logAudit(req, "admin", "marketing.promotion_cancelled", "course", Number(p.course_id), null, null);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "cancelPromotion", e); }
};

// ── Sélecteurs pour l'éditeur ──
export const pickers = async (req: Req, res: Response) => {
  try {
    const courses: any[] = await query("SELECT id, title, price, is_free, is_published, category_id FROM courses ORDER BY is_published DESC, title LIMIT 300");
    const bootcamps: any[] = await query("SELECT id, title, scheduled_at, status FROM bootcamps ORDER BY scheduled_at DESC LIMIT 100");
    const categories: any[] = await query("SELECT id, name FROM course_categories ORDER BY order_index");
    return res.json({ success: true, data: plain({ courses, bootcamps, categories }) });
  } catch (e) { return serverError(req, res, "pickers", e); }
};

// ══════════════════════════════════════════════════════
// PUBLIC — SUIVI, DÉSABONNEMENT, PRÉFÉRENCES, INSCRIPTION, BANNIÈRES
// ══════════════════════════════════════════════════════
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const validToken = (t: any, len: number) => typeof t === "string" && new RegExp(`^[a-f0-9]{${len}}$`).test(t);

export const trackOpen = async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token || "").replace(/\.gif$/, "");
    if (validToken(token, 32)) await query("UPDATE marketing_sends SET open_count = open_count + 1, opened_at = COALESCE(opened_at, NOW()) WHERE token = ?", [token]);
  } catch { /* le pixel ne doit jamais échouer visiblement */ }
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  return res.end(GIF);
};

export const trackClick = async (req: Request, res: Response) => {
  const home = frontendUrl();
  try {
    const token = String(req.params.token || "");
    const idx = Number(req.params.idx);
    if (!validToken(token, 32) || !Number.isInteger(idx) || idx < 0) return res.redirect(302, home);
    const [s]: any = await query("SELECT s.id, s.campaign_id, s.lang FROM marketing_sends s WHERE s.token = ?", [token]);
    if (!s) return res.redirect(302, home);
    const [c]: any = await query("SELECT blocks_fr, blocks_en FROM marketing_campaigns WHERE id = ?", [s.campaign_id]);
    const links = collectLinks(getBlocks(c, s.lang === "en" ? "en" : "fr"));
    const target = links[idx];
    if (!target || !/^https?:\/\//i.test(target)) return res.redirect(302, home);
    await query("UPDATE marketing_sends SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, NOW()), opened_at = COALESCE(opened_at, NOW()) WHERE id = ?", [s.id]);
    await query("INSERT INTO marketing_link_stats (campaign_id, link_index, clicks) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE clicks = clicks + 1", [s.campaign_id, idx]);
    return res.redirect(302, target);
  } catch {
    return res.redirect(302, home);
  }
};

const page = (title: string, body: string) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f4f3fb;margin:0;padding:48px 16px;"><div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;text-align:center;box-shadow:0 4px 24px rgba(45,40,127,.08);">
<p style="color:#2d287f;font-weight:900;font-size:20px;margin:0 0 16px;">DevOps Akademy</p>${body}</div></body></html>`;

// GET|POST /unsubscribe/:ptoken?s=<sendToken>  (désabonnement en un clic)
export const unsubscribe = async (req: Request, res: Response) => {
  try {
    await ensureMarketingTables();
    const ptoken = String(req.params.ptoken || "");
    let done = false;
    if (validToken(ptoken, 40)) {
      const a: any = await query("UPDATE marketing_preferences SET unsubscribed_all = 1 WHERE token = ?", [ptoken]);
      const b: any = await query("UPDATE marketing_contacts SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE token = ?", [ptoken]);
      done = !!(Number(a?.affectedRows) || Number(b?.affectedRows));
      const s = String(req.query.s || "");
      if (validToken(s, 32)) await query("UPDATE marketing_sends SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()) WHERE token = ?", [s]);
    }
    if (req.method === "POST") return res.status(done ? 200 : 404).send(done ? "OK" : "Not found");
    const pref = frontendUrl(`/email-preferences/${ptoken}`);
    return res.status(done ? 200 : 404).type("html").send(done
      ? page("Désabonnement", `<h2 style="color:#111;margin:0 0 8px;">Vous êtes désabonné</h2><p style="color:#555;">Vous ne recevrez plus d'emails promotionnels. Les emails liés à votre compte (paiements, sécurité) continueront d'être envoyés.</p><p style="margin-top:20px;"><a href="${escapeHtml(pref)}" style="color:#5653e1;font-weight:700;">Choisir mes préférences</a></p>`)
      : page("Lien invalide", `<h2 style="color:#111;">Lien invalide ou expiré</h2><p style="color:#555;">Utilisez le lien présent dans le dernier email reçu.</p>`));
  } catch {
    return res.status(500).send("Erreur");
  }
};

const maskEmail = (e: string) => e.replace(/^(.{2}).*(@.*)$/, "$1***$2");

// GET /preferences/:ptoken
export const getPreferences = async (req: Request, res: Response) => {
  try {
    await ensureMarketingTables();
    const t = String(req.params.ptoken || "");
    if (!validToken(t, 40)) return fail(req, res, 404, "Lien invalide", "Invalid link");
    const [u]: any = await query(
      `SELECT mp.newsletter, mp.promotions, mp.events, mp.unsubscribed_all, usr.email, usr.first_name FROM marketing_preferences mp JOIN users usr ON usr.id = mp.user_id WHERE mp.token = ?`, [t]);
    if (u) return res.json({ success: true, data: { kind: "user", email: maskEmail(u.email), first_name: u.first_name, newsletter: !!Number(u.newsletter), promotions: !!Number(u.promotions), events: !!Number(u.events), unsubscribed_all: !!Number(u.unsubscribed_all) } });
    const [c]: any = await query("SELECT email, first_name, status FROM marketing_contacts WHERE token = ?", [t]);
    if (c) return res.json({ success: true, data: { kind: "contact", email: maskEmail(c.email), first_name: c.first_name, newsletter: c.status === "subscribed", promotions: c.status === "subscribed", events: c.status === "subscribed", unsubscribed_all: c.status !== "subscribed" } });
    return fail(req, res, 404, "Lien invalide", "Invalid link");
  } catch (e) { return serverError(req, res, "getPreferences", e); }
};

// PUT /preferences/:ptoken { newsletter, promotions, events, unsubscribed_all }
export const savePreferences = async (req: Request, res: Response) => {
  try {
    const t = String(req.params.ptoken || "");
    if (!validToken(t, 40)) return fail(req, res, 404, "Lien invalide", "Invalid link");
    const b = req.body || {};
    const all = b.unsubscribed_all ? 1 : 0;
    const a: any = await query("UPDATE marketing_preferences SET newsletter = ?, promotions = ?, events = ?, unsubscribed_all = ? WHERE token = ?",
      [b.newsletter ? 1 : 0, b.promotions ? 1 : 0, b.events ? 1 : 0, all, t]);
    if (!Number(a?.affectedRows)) {
      const c: any = await query("UPDATE marketing_contacts SET status = ?, unsubscribed_at = ? WHERE token = ?", [all || !(b.newsletter || b.promotions || b.events) ? "unsubscribed" : "subscribed", all ? new Date() : null, t]);
      if (!Number(c?.affectedRows)) return fail(req, res, 404, "Lien invalide", "Invalid link");
    }
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "savePreferences", e); }
};

// POST /subscribe { email, first_name, lang, website(honeypot) } — double opt-in
const hits = new Map<string, number[]>();
export const subscribePublic = async (req: Request, res: Response) => {
  try {
    await ensureMarketingTables();
    if (req.body?.website) return res.json({ success: true });                    // honeypot : on ne répond rien d'utile aux robots
    const ip = req.ip || "x";
    const recent = (hits.get(ip) || []).filter((t) => Date.now() - t < 3600_000);
    if (recent.length >= 5) return fail(req, res, 429, "Trop de tentatives, réessayez plus tard.", "Too many attempts, try again later.");
    hits.set(ip, [...recent, Date.now()]);

    const email = str(req.body?.email, 190).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(req, res, 400, "Adresse email invalide", "Invalid email address", { errors: { email: "invalid" } });
    const lang = req.body?.lang === "en" ? "en" : "fr";
    const [user]: any = await query("SELECT id FROM users WHERE email = ?", [email]);
    if (user) {   // compte existant : on réactive simplement ses préférences
      await getUserPrefs(Number(user.id));
      await query("UPDATE marketing_preferences SET unsubscribed_all = 0, newsletter = 1 WHERE user_id = ?", [user.id]);
      return res.json({ success: true, data: { status: "subscribed" } });
    }
    const token = newToken();
    await query(
      `INSERT INTO marketing_contacts (email, first_name, lang, source, status, token) VALUES (?, ?, ?, ?, 'pending', ?)
       ON DUPLICATE KEY UPDATE first_name = COALESCE(VALUES(first_name), first_name), lang = VALUES(lang),
         status = IF(status = 'subscribed', 'subscribed', 'pending')`,
      [email, str(req.body?.first_name, 100) || null, lang, str(req.body?.source, 40).replace(/[^a-z0-9_-]/gi, "") || "website", token]);
    const [c]: any = await query("SELECT token, status FROM marketing_contacts WHERE email = ?", [email]);
    if (c.status === "pending") {
      const link = `${publicBaseUrl(req)}/api/marketing/confirm/${c.token}`;
      const fr = lang === "fr";
      await sendEmail({
        to: email,
        subject: fr ? "Confirmez votre inscription à la newsletter DevOpsAkademy" : "Confirm your DevOpsAkademy newsletter subscription",
        html: page("Confirmation", `<h2 style="color:#111;margin:0 0 8px;">${fr ? "Confirmez votre inscription" : "Confirm your subscription"}</h2><p style="color:#555;">${fr ? "Cliquez pour recevoir nos actualités, offres et webinaires." : "Click to receive our news, offers and webinars."}</p><p style="margin-top:20px;"><a href="${escapeHtml(link)}" style="background:#2d287f;color:#fff;text-decoration:none;padding:12px 26px;border-radius:12px;font-weight:700;display:inline-block;">${fr ? "Je confirme" : "Confirm"}</a></p><p style="color:#999;font-size:12px;margin-top:20px;">${fr ? "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message." : "If you did not request this, ignore this message."}</p>`),
      }).catch((e) => console.warn("Email confirmation newsletter:", e?.message));
    }
    return res.json({ success: true, data: { status: c.status === "subscribed" ? "subscribed" : "pending" } });
  } catch (e) { return serverError(req, res, "subscribePublic", e); }
};

// GET /confirm/:token
export const confirmSubscription = async (req: Request, res: Response) => {
  try {
    const t = String(req.params.token || "");
    const r: any = validToken(t, 40) ? await query("UPDATE marketing_contacts SET status = 'subscribed', unsubscribed_at = NULL WHERE token = ? AND status <> 'unsubscribed'", [t]) : null;
    const ok = !!Number(r?.affectedRows);
    return res.status(ok ? 200 : 404).type("html").send(ok
      ? page("Confirmé", `<h2 style="color:#111;margin:0 0 8px;">Inscription confirmée ✅</h2><p style="color:#555;">Merci ! Vous recevrez nos actualités, offres et webinaires.</p><p style="margin-top:20px;"><a href="${escapeHtml(frontendUrl())}" style="color:#5653e1;font-weight:700;">Retour au site</a></p>`)
      : page("Lien invalide", `<h2 style="color:#111;">Lien invalide ou expiré</h2>`));
  } catch { return res.status(500).send("Erreur"); }
};

// GET /banners/active?lang=fr  (audience déduite du compte connecté, si présent)
export const activeBanners = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureMarketingTables();
    const role = req.user?.role;
    const audiences = !role ? ["all", "visitors"] : role === "instructor" ? ["all", "instructors"] : ["admin", "superadmin"].includes(role) ? ["all", "students", "instructors"] : ["all", "students"];
    const rows: any[] = await query(
      `SELECT id, placement, title_fr, title_en, body_fr, body_en, cta_label_fr, cta_label_en, cta_url, image_url, tone, ends_at
         FROM marketing_banners
        WHERE is_active = 1 AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at > NOW()) AND audience IN (${audiences.map(() => "?").join(",")})
        ORDER BY id DESC LIMIT 5`, audiences);
    return res.json({ success: true, data: plain(rows) });
  } catch { return res.json({ success: true, data: [] }); }
};

export const bannerEvent = (field: "impressions" | "clicks") => async (req: Request, res: Response) => {
  try { await query(`UPDATE marketing_banners SET ${field} = ${field} + 1 WHERE id = ?`, [parseId(req.params.id)]); } catch { /* non bloquant */ }
  return res.json({ success: true });
};
