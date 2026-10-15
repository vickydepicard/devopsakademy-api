// src/controllers/marketingJobs.ts
// Tâches de fond : démarrage des campagnes programmées, file d'envoi limitée, promotions de prix, publication Telegram.
import { query } from "../config/database";
import { sendEmail } from "../services/mail.service";
import { createNotification } from "../services/notification.service";
import { ensureMarketingTables, newToken, num, parseJson, frontendUrl, ensureAllPreferences } from "./marketingSetup";
import { resolveAudience } from "./marketingAudience";
import { Block, collectLinks, getBlocks, loadBlockData, renderEmail } from "./marketingRender";

// ══════════════════════════════════════════════════════
// TELEGRAM (publication automatique, si configuré)
// ══════════════════════════════════════════════════════
export const telegramConfigured = (): boolean => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export async function publishTelegram(text: string, imageUrl?: string | null): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!telegramConfigured()) return { ok: false, error: "Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)" };
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const useImage = !!imageUrl && /^https?:\/\//i.test(imageUrl) && text.length <= 1000;
    const res = await fetch(`https://api.telegram.org/bot${token}/${useImage ? "sendPhoto" : "sendMessage"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(useImage
        ? { chat_id: process.env.TELEGRAM_CHAT_ID, photo: imageUrl, caption: text }
        : { chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }),
    });
    const j: any = await res.json();
    if (!j.ok) return { ok: false, error: String(j.description || "Erreur Telegram").slice(0, 280) };
    return { ok: true, id: String(j.result?.message_id ?? "") };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 280) };
  }
}

// ══════════════════════════════════════════════════════
// DÉMARRAGE D'UNE CAMPAGNE
// ══════════════════════════════════════════════════════
export async function startCampaign(id: number): Promise<boolean> {
  await ensureMarketingTables();
  const claim: any = await query(
    "UPDATE marketing_campaigns SET status = 'sending', started_at = NOW() WHERE id = ? AND status IN ('draft','scheduled')", [id]);
  if (!Number(claim?.affectedRows)) return false;   // déjà démarrée ou annulée

  const [c]: any = await query("SELECT * FROM marketing_campaigns WHERE id = ?", [id]);
  const channels = parseJson<any>(c.channels, { email: true });
  const audience = parseJson<any>(c.audience, {});
  let total = 0;

  try {
    if (channels.email || channels.inapp) {
      const recipients = await resolveAudience(c.kind, audience);
      total = recipients.length;

      if (channels.email) {
        // Test A/B : un échantillon reçoit les variantes A et B, le reste attend le gagnant
        const ab = parseJson<any>(c.ab_test, null);
        const abOn = !!(ab?.enabled && (ab.subject_b_fr || ab.subject_b_en) && recipients.length >= 20);
        let plan: { r: (typeof recipients)[number]; variant: string | null; status: string }[];
        if (abOn) {
          const shuffled = [...recipients].sort(() => Math.random() - 0.5);
          const pct = Math.min(Math.max(Number(ab.sample_percent) || 20, 10), 50);
          const half = Math.max(Math.floor((shuffled.length * pct) / 100 / 2), 1);
          plan = shuffled.map((r, i) => (i < half ? { r, variant: "A", status: "queued" } : i < half * 2 ? { r, variant: "B", status: "queued" } : { r, variant: null, status: "held" }));
          const wait = Math.min(Math.max(Number(ab.wait_hours) || 4, 1), 72);
          await query("UPDATE marketing_campaigns SET ab_state = 'testing', ab_decide_at = NOW() + INTERVAL ? HOUR WHERE id = ?", [wait, id]);
        } else {
          plan = recipients.map((r) => ({ r, variant: null, status: "queued" }));
        }
        for (let i = 0; i < plan.length; i += 200) {
          const chunk = plan.slice(i, i + 200);
          const ph = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
          const vals = chunk.flatMap(({ r, variant, status }) => [id, r.user_id, r.contact_id, r.email, r.first_name, r.lang, r.pref_token, newToken(16), variant, status]);
          await query(`INSERT IGNORE INTO marketing_sends (campaign_id, user_id, contact_id, email, first_name, lang, pref_token, token, variant, status) VALUES ${ph}`, vals);
        }
      }
      if (channels.inapp) {
        for (const r of recipients.filter((x) => x.user_id)) {
          const subject = r.lang === "en" ? c.subject_en || c.subject_fr : c.subject_fr || c.subject_en;
          const pre = r.lang === "en" ? c.preheader_en || c.preheader_fr : c.preheader_fr || c.preheader_en;
          await createNotification(Number(r.user_id), { type: "info", title: subject, message: pre || "", link: channels.inapp_link || "/" }).catch(() => {});
        }
      }
    }

    if (channels.banner && typeof channels.banner === "object") {
      const b = channels.banner;
      await query(
        `INSERT INTO marketing_banners (campaign_id, placement, title_fr, title_en, body_fr, body_en, cta_label_fr, cta_label_en, cta_url, image_url, tone, audience, starts_at, ends_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [id, b.placement === "popup" ? "popup" : "top_bar", String(b.title_fr || c.subject_fr).slice(0, 200), String(b.title_en || b.title_fr || c.subject_en || c.subject_fr).slice(0, 200),
         b.body_fr || null, b.body_en || null, b.cta_label_fr || null, b.cta_label_en || null, b.cta_url || null, b.image_url || null,
         ["info", "promo", "success", "urgent"].includes(b.tone) ? b.tone : "promo", ["all", "visitors", "students", "instructors"].includes(b.audience) ? b.audience : "all",
         b.ends_at ? new Date(b.ends_at) : new Date(Date.now() + 7 * 86400_000), c.created_by]);
    }

    if (channels.telegram && telegramConfigured()) {
      const text = String(channels.social_text || c.subject_fr || "").slice(0, 3500);
      const link = channels.social_link ? String(channels.social_link) : "";
      const full = link ? `${text}\n\n${link}` : text;
      const r = await publishTelegram(full, channels.social_image || null);
      await query("INSERT INTO marketing_social_posts (campaign_id, channel, text, image_url, link_url, status, external_id, error, created_by, published_at) VALUES (?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, text, channels.social_image || null, link || null, r.ok ? "published" : "failed", r.id || null, r.error || null, c.created_by, r.ok ? new Date() : null]);
    }
  } catch (e: any) {
    console.error("startCampaign:", e?.message || e);
  }

  await query("UPDATE marketing_campaigns SET recipients_total = ? WHERE id = ?", [total, id]);
  if (!channels.email || total === 0) {
    await query("UPDATE marketing_campaigns SET status = 'sent', finished_at = NOW() WHERE id = ?", [id]);
  }
  return true;
}

// ══════════════════════════════════════════════════════
// FILE D'ENVOI (limite quotidienne + lots, pour respecter les quotas Brevo)
// ══════════════════════════════════════════════════════
let sending = false;
export const dailyLimit = () => Math.max(Number(process.env.MARKETING_DAILY_LIMIT) || 250, 1);
const batchSize = () => Math.max(Number(process.env.MARKETING_BATCH) || 25, 1);

export async function sentToday(): Promise<number> {
  const [r]: any = await query("SELECT COUNT(*) AS n FROM marketing_sends WHERE status = 'sent' AND sent_at >= CURDATE()");
  return num(r?.n);
}

const campaignCache = new Map<number, { blocks: Record<"fr" | "en", Block[]>; data: any; apiBase: string; row: any; rowB: any; at: number }>();
async function loadCampaignForSend(id: number) {
  const hit = campaignCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const [row]: any = await query("SELECT * FROM marketing_campaigns WHERE id = ?", [id]);
  const blocks = { fr: getBlocks(row, "fr"), en: getBlocks(row, "en") };
  const data = await loadBlockData([...blocks.fr, ...blocks.en]);
  const apiBase = (row.api_base || process.env.API_BASE_URL || "").replace(/\/+$/, "");
  const ab = parseJson<any>(row.ab_test, null);
  const rowB = ab ? { ...row, subject_fr: ab.subject_b_fr || row.subject_fr, subject_en: ab.subject_b_en || row.subject_en, preheader_fr: ab.preheader_b_fr || row.preheader_fr, preheader_en: ab.preheader_b_en || row.preheader_en } : row;
  const entry = { blocks, data, apiBase, row, rowB, at: Date.now() };
  campaignCache.set(id, entry);
  return entry;
}

export async function processQueue(): Promise<void> {
  if (sending) return;
  sending = true;
  try {
    await ensureMarketingTables();
    const remaining = dailyLimit() - (await sentToday());
    if (remaining <= 0) return;
    const rows: any[] = await query(
      `SELECT s.* FROM marketing_sends s JOIN marketing_campaigns c ON c.id = s.campaign_id
        WHERE s.status = 'queued' AND c.status = 'sending' ORDER BY s.id LIMIT ?`, [Math.min(batchSize(), remaining)]);
    const touched = new Set<number>();
    for (const s of rows) {
      touched.add(Number(s.campaign_id));
      try {
        const cc = await loadCampaignForSend(Number(s.campaign_id));
        const lang: "fr" | "en" = s.lang === "en" ? "en" : "fr";
        const vars = parseJson<Record<string, string>>(s.vars, {});
        const mail = renderEmail(s.variant === "B" ? cc.rowB : cc.row, cc.blocks[lang], { lang, firstName: s.first_name, sendToken: s.token, prefToken: s.pref_token, apiBase: cc.apiBase, data: cc.data, vars });
        await sendEmail({
          to: s.email, subject: mail.subject, html: mail.html, text: mail.text,
          headers: { "List-Unsubscribe": `<${mail.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "Precedence": "bulk" },
        });
        await query("UPDATE marketing_sends SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = ?", [s.id]);
      } catch (e: any) {
        await query("UPDATE marketing_sends SET status = 'failed', error = ? WHERE id = ?", [String(e?.message || e).slice(0, 290), s.id]);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const id of touched) {
      const [q]: any = await query("SELECT COUNT(*) AS n FROM marketing_sends WHERE campaign_id = ? AND status IN ('queued','held')", [id]);
      if (num(q?.n) === 0) await query("UPDATE marketing_campaigns SET status = 'sent', finished_at = NOW() WHERE id = ? AND status = 'sending' AND automation_id IS NULL", [id]);
    }
  } catch (e: any) {
    console.warn("processQueue:", e?.message || e);
  } finally {
    sending = false;
  }
}

// ══════════════════════════════════════════════════════
// PROMOTIONS DE PRIX (activation et rétablissement automatiques)
// ══════════════════════════════════════════════════════
export async function activatePromotion(p: any): Promise<void> {
  const [course]: any = await query("SELECT id, price, original_price, is_free FROM courses WHERE id = ?", [p.course_id]);
  if (!course) { await query("UPDATE marketing_promotions SET status = 'cancelled' WHERE id = ?", [p.id]); return; }
  const [other]: any = await query("SELECT id FROM marketing_promotions WHERE course_id = ? AND status = 'active' AND id <> ?", [p.course_id, p.id]);
  if (other) { await query("UPDATE marketing_promotions SET status = 'cancelled' WHERE id = ?", [p.id]); return; }
  const regular = num(course.price);
  const free = p.type === "free";
  const promo = free ? 0 : Math.max(Math.round(regular * (1 - num(p.percent) / 100)), 0);
  await query(
    "UPDATE marketing_promotions SET status = 'active', regular_price = ?, regular_original_price = ?, regular_is_free = ?, promo_price = ? WHERE id = ?",
    [course.price, course.original_price, Number(course.is_free), promo, p.id]);
  await query("UPDATE courses SET price = ?, original_price = ?, is_free = ?, updated_at = NOW() WHERE id = ?",
    [promo, regular > 0 ? regular : course.original_price, free ? 1 : 0, p.course_id]);
}

export async function endPromotion(p: any, finalStatus: "ended" | "cancelled"): Promise<void> {
  if (p.status === "active") {
    const [course]: any = await query("SELECT price FROM courses WHERE id = ?", [p.course_id]);
    // on ne rétablit que si le prix n'a pas été modifié à la main entre-temps
    if (course && Math.abs(num(course.price) - num(p.promo_price)) < 0.01) {
      await query("UPDATE courses SET price = ?, original_price = ?, is_free = ?, updated_at = NOW() WHERE id = ?",
        [p.regular_price, p.regular_original_price, Number(p.regular_is_free) || 0, p.course_id]);
    }
  }
  await query("UPDATE marketing_promotions SET status = ? WHERE id = ?", [finalStatus, p.id]);
}

export async function runPromotions(): Promise<void> {
  try {
    await ensureMarketingTables();
    const ending: any[] = await query("SELECT * FROM marketing_promotions WHERE status IN ('active','scheduled') AND ends_at <= NOW()");
    for (const p of ending) await endPromotion(p, "ended");
    const starting: any[] = await query("SELECT * FROM marketing_promotions WHERE status = 'scheduled' AND starts_at <= NOW() AND ends_at > NOW()");
    for (const p of starting) await activatePromotion(p);
  } catch (e: any) {
    console.warn("runPromotions:", e?.message || e);
  }
}

// ══════════════════════════════════════════════════════
// TEST A/B : choix du gagnant puis envoi au reste du public
// ══════════════════════════════════════════════════════
export async function decideAbTests(): Promise<void> {
  try {
    const due: any[] = await query("SELECT id, ab_test, ab_decide_at FROM marketing_campaigns WHERE ab_state = 'testing' AND ab_decide_at <= NOW() AND status = 'sending'");
    for (const c of due) {
      const [pending]: any = await query("SELECT COUNT(*) AS n FROM marketing_sends WHERE campaign_id = ? AND variant IN ('A','B') AND status = 'queued'", [c.id]);
      // on attend que l'échantillon soit parti (sauf si l'attente dépasse 24 h après l'échéance)
      if (num(pending?.n) > 0 && Date.now() - new Date(c.ab_decide_at).getTime() < 24 * 3600_000) continue;
      const ab = parseJson<any>(c.ab_test, {});
      const metric = ab.metric === "opens" ? "opened_at" : "clicked_at";
      const stats: any[] = await query(
        `SELECT variant, COUNT(*) AS sent, SUM(${metric} IS NOT NULL) AS hits FROM marketing_sends WHERE campaign_id = ? AND variant IN ('A','B') AND status = 'sent' GROUP BY variant`, [c.id]);
      const rate = (v: string) => { const r = stats.find((x) => x.variant === v); return r && num(r.sent) ? num(r.hits) / num(r.sent) : 0; };
      const winner = rate("B") > rate("A") ? "B" : "A";   // égalité : variante A
      await query("UPDATE marketing_sends SET status = 'queued', variant = ? WHERE campaign_id = ? AND status = 'held'", [winner, c.id]);
      await query("UPDATE marketing_campaigns SET ab_state = 'decided', ab_winner = ? WHERE id = ?", [winner, c.id]);
      campaignCache.delete(Number(c.id));
    }
  } catch (e: any) {
    console.warn("decideAbTests:", e?.message || e);
  }
}

// ══════════════════════════════════════════════════════
// AUTOMATISATIONS (bienvenue, relances…) — un envoi par personne et par automatisation
// ══════════════════════════════════════════════════════
const SCAN_LIMIT = 40;

async function automationCampaign(a: any): Promise<number> {
  const kind = a.pref === "promotions" ? "offer" : "newsletter";
  if (a.campaign_id) {
    await query(
      "UPDATE marketing_campaigns SET subject_fr = ?, subject_en = ?, preheader_fr = ?, preheader_en = ?, blocks_fr = ?, blocks_en = ?, kind = ?, status = 'sending' WHERE id = ?",
      [a.subject_fr, a.subject_en, a.preheader_fr, a.preheader_en, a.blocks_fr, a.blocks_en, kind, a.campaign_id]);
    campaignCache.delete(Number(a.campaign_id));
    return Number(a.campaign_id);
  }
  const r: any = await query(
    `INSERT INTO marketing_campaigns (name, kind, status, subject_fr, subject_en, preheader_fr, preheader_en, blocks_fr, blocks_en, channels, audience, automation_id, api_base, started_at)
     VALUES (?, ?, 'sending', ?, ?, ?, ?, ?, ?, '{"email":true}', '{}', ?, ?, NOW())`,
    [`[Auto] ${a.slug}`, kind, a.subject_fr, a.subject_en, a.preheader_fr, a.preheader_en, a.blocks_fr, a.blocks_en, a.id, process.env.API_BASE_URL || null]);
  const id = Number(r.insertId);
  await query("UPDATE marketing_automations SET campaign_id = ? WHERE id = ?", [id, a.id]);
  return id;
}

/** Destinataires admissibles pour une automatisation (hors personnes déjà servies). */
export async function eligibleForAutomation(a: any, limit = SCAN_LIMIT): Promise<any[]> {
  const delay = Number(a.delay_days) || 0;
  const common = `u.is_active = 1 AND u.email_verified = 1 AND u.role = 'student'
     AND COALESCE(mp.unsubscribed_all, 0) = 0 AND COALESCE(mp.${a.pref}, 1) = 1
     AND NOT EXISTS (SELECT 1 FROM marketing_automation_log l WHERE l.automation_id = ? AND l.user_id = u.id)`;
  const base = `SELECT u.id, u.email, u.first_name, COALESCE(u.preferred_language, 'fr') AS lang, mp.token AS pref_token`;
  const from = `FROM users u LEFT JOIN marketing_preferences mp ON mp.user_id = u.id`;
  const enabledAt = a.enabled_at || new Date();
  switch (a.trigger_type) {
    case "signup":
      return query(`${base}, NULL AS course_title ${from} WHERE ${common} AND u.created_at >= ? AND u.created_at <= NOW() - INTERVAL ? DAY LIMIT ?`, [a.id, enabledAt, delay, limit]);
    case "no_enrollment":
      return query(`${base}, NULL AS course_title ${from} WHERE ${common} AND u.created_at >= ? AND u.created_at <= NOW() - INTERVAL ? DAY
                    AND NOT EXISTS (SELECT 1 FROM course_enrollments ce WHERE ce.user_id = u.id) LIMIT ?`, [a.id, enabledAt, delay, limit]);
    case "inactive":
      return query(`${base}, NULL AS course_title ${from} WHERE ${common} AND COALESCE(u.last_login, u.created_at) <= NOW() - INTERVAL ? DAY
                    AND u.created_at <= NOW() - INTERVAL ? DAY LIMIT ?`, [a.id, delay, delay, limit]);
    case "course_stalled":
      return query(`${base}, c.title AS course_title ${from}
                    JOIN course_enrollments ce ON ce.user_id = u.id AND ce.is_approved = 1 AND ce.completion_percentage > 0 AND ce.completion_percentage < 100
                         AND ce.last_accessed_at <= NOW() - INTERVAL ? DAY AND ce.last_accessed_at >= NOW() - INTERVAL 60 DAY
                    JOIN courses c ON c.id = ce.course_id
                    WHERE ${common} GROUP BY u.id LIMIT ?`, [delay, a.id, limit]);
    case "course_completed":
      return query(`${base}, c.title AS course_title ${from}
                    JOIN course_enrollments ce ON ce.user_id = u.id AND ce.completed_at IS NOT NULL AND ce.completed_at >= ? AND ce.completed_at <= NOW() - INTERVAL ? DAY
                    JOIN courses c ON c.id = ce.course_id
                    WHERE ${common} GROUP BY u.id LIMIT ?`, [enabledAt, delay, a.id, limit]);
    default:
      return [];
  }
}

export async function runAutomations(): Promise<void> {
  try {
    await ensureMarketingTables();
    const autos: any[] = await query("SELECT * FROM marketing_automations WHERE enabled = 1");
    if (!autos.length) return;
    await ensureAllPreferences();
    for (const a of autos) {
      const cid = await automationCampaign(a);
      const rows = await eligibleForAutomation(a);
      for (const u of rows) {
        if (!u.pref_token) continue;
        const log: any = await query("INSERT IGNORE INTO marketing_automation_log (automation_id, user_id) VALUES (?, ?)", [a.id, u.id]);
        if (!Number(log?.affectedRows)) continue;
        await query(
          "INSERT IGNORE INTO marketing_sends (campaign_id, user_id, email, first_name, lang, pref_token, token, vars, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')",
          [cid, u.id, String(u.email).toLowerCase(), u.first_name, u.lang === "en" ? "en" : "fr", u.pref_token, newToken(16), JSON.stringify(u.course_title ? { course_title: u.course_title } : {})]);
      }
    }
  } catch (e: any) {
    console.warn("runAutomations:", e?.message || e);
  }
}

// ══════════════════════════════════════════════════════
// PLANIFICATEUR
// ══════════════════════════════════════════════════════
async function tick() {
  try {
    await ensureMarketingTables();
    const due: any[] = await query("SELECT id FROM marketing_campaigns WHERE status = 'scheduled' AND scheduled_at <= NOW()");
    for (const d of due) await startCampaign(Number(d.id));
    await processQueue();
    await decideAbTests();
    await runAutomations();
    await runPromotions();
  } catch (e: any) {
    console.warn("marketing tick:", e?.message || e);
  }
}

export const startMarketingJobs = (): void => {
  setInterval(tick, 60_000).unref?.();
  setTimeout(tick, 20_000).unref?.();
};

export { frontendUrl, collectLinks };
