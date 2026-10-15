// src/controllers/marketingRender.ts
// Rendu HTML / texte des emails marketing à partir de blocs, avec suivi des clics et des ouvertures.
import { query } from "../config/database";
import { escapeHtml as esc } from "../services/mail.service";
import { frontendUrl, parseJson, plain } from "./marketingSetup";

export type Lang = "fr" | "en";
export interface Block {
  type: "heading" | "text" | "image" | "button" | "course" | "webinar" | "coupon" | "divider";
  text?: string; url?: string; alt?: string; label?: string; link?: string;
  course_id?: number; bootcamp_id?: number; code?: string;
}
export interface BlockData {
  courses: Record<number, any>;
  bootcamps: Record<number, any>;
}
export interface RenderCampaign {
  subject_fr: string; subject_en: string; preheader_fr?: string | null; preheader_en?: string | null;
  blocks_fr?: any; blocks_en?: any;
}
export interface RenderCtx {
  lang: Lang;
  firstName?: string | null;
  sendToken?: string;        // si présent : suivi des clics / ouvertures
  prefToken?: string;        // lien de désabonnement
  vars?: Record<string, string>;   // variables propres au destinataire ({{course_title}}…)
  apiBase: string;
  data: BlockData;
  preview?: boolean;
}

const BRAND = "#2d287f";
const money = (n: any, lang: Lang) => `${Number(n || 0).toLocaleString(lang === "en" ? "en-US" : "fr-FR")} XAF`;

export const getBlocks = (c: RenderCampaign, lang: Lang): Block[] => {
  const own = parseJson<Block[]>(lang === "en" ? c.blocks_en : c.blocks_fr, []);
  if (own.length) return own;
  return parseJson<Block[]>(lang === "en" ? c.blocks_fr : c.blocks_en, []);   // repli sur l'autre langue
};

export const getSubject = (c: RenderCampaign, lang: Lang): string =>
  (lang === "en" ? c.subject_en || c.subject_fr : c.subject_fr || c.subject_en) || "";

/** Charge les cours / webinaires référencés par les blocs. */
export async function loadBlockData(blocks: Block[]): Promise<BlockData> {
  const courseIds = [...new Set(blocks.filter((b) => b.type === "course" && b.course_id).map((b) => Number(b.course_id)))];
  const bcIds = [...new Set(blocks.filter((b) => b.type === "webinar" && b.bootcamp_id).map((b) => Number(b.bootcamp_id)))];
  const data: BlockData = { courses: {}, bootcamps: {} };
  if (courseIds.length) {
    const rows: any[] = await query(
      `SELECT id, title, short_description, thumbnail_url, price, original_price, is_free FROM courses WHERE id IN (${courseIds.map(() => "?").join(",")})`, courseIds);
    for (const r of plain<any[]>(rows)) data.courses[r.id] = r;
  }
  if (bcIds.length) {
    const rows: any[] = await query(
      `SELECT id, title, description, thumbnail_url, scheduled_at, duration_minutes, is_free, price FROM bootcamps WHERE id IN (${bcIds.map(() => "?").join(",")})`, bcIds);
    for (const r of plain<any[]>(rows)) data.bootcamps[r.id] = r;
  }
  return data;
}

const absUrl = (u: string | undefined): string => {
  const v = String(u ?? "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return frontendUrl(v);
  return frontendUrl();
};
const imgUrl = (u: string | undefined, apiBase: string): string | null => {
  const v = String(u ?? "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/uploads/")) return `${apiBase}${v}`;
  return null;
};

/** Liste ordonnée des liens cliquables d'une campagne (index utilisé par le suivi des clics). */
export function collectLinks(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "button") out.push(absUrl(b.url));
    else if (b.type === "image" && b.link) out.push(absUrl(b.link));
    else if (b.type === "course" && b.course_id) out.push(frontendUrl(`/courses/${b.course_id}`));
    else if (b.type === "webinar" && b.bootcamp_id) out.push(frontendUrl(`/bootcamps/${b.bootcamp_id}`));
  }
  return out;
}

const subst = (text: string | undefined, ctx: RenderCtx): string =>
  String(text ?? "")
    .replace(/\{\{\s*first_name\s*\}\}/g, ctx.firstName?.trim() || (ctx.lang === "en" ? "there" : "à vous"))
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (ctx.vars && ctx.vars[k] !== undefined ? ctx.vars[k] : m));

const paragraphs = (text: string, ctx: RenderCtx) =>
  subst(text, ctx).split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 14px;color:#444;font-size:15px;line-height:1.65;">${esc(p).replace(/\n/g, "<br/>")}</p>`).join("");

const btn = (href: string, label: string, color = BRAND) =>
  `<div style="text-align:center;margin:22px 0;"><a href="${esc(href)}" style="background:${color};color:#fff;text-decoration:none;padding:14px 30px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">${esc(label)}</a></div>`;

export function renderEmail(c: RenderCampaign, blocks: Block[], ctx: RenderCtx) {
  const { lang } = ctx;
  const T = (fr: string, en: string) => (lang === "en" ? en : fr);
  let idx = 0;
  const link = (direct: string): string =>
    ctx.sendToken ? `${ctx.apiBase}/api/marketing/c/${ctx.sendToken}/${idx++}` : (idx++, direct);

  const textParts: string[] = [];
  const body = blocks.map((b) => {
    switch (b.type) {
      case "heading":
        textParts.push(subst(b.text, ctx).toUpperCase());
        return `<h2 style="margin:6px 0 14px;color:${BRAND};font-size:22px;line-height:1.3;">${esc(subst(b.text, ctx))}</h2>`;
      case "text":
        textParts.push(subst(b.text, ctx));
        return paragraphs(b.text || "", ctx);
      case "image": {
        const src = imgUrl(b.url, ctx.apiBase);
        if (!src) return "";
        const img = `<img src="${esc(src)}" alt="${esc(b.alt || "")}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border-radius:12px;margin:8px auto 16px;" />`;
        return b.link ? `<a href="${esc(link(absUrl(b.link)))}">${img}</a>` : img;
      }
      case "button": {
        const href = link(absUrl(b.url));
        textParts.push(`${b.label || ""}: ${absUrl(b.url)}`);
        return btn(href, subst(b.label, ctx) || T("En savoir plus", "Learn more"));
      }
      case "course": {
        const co = b.course_id ? ctx.data.courses[Number(b.course_id)] : null;
        if (!co) return "";
        const href = link(frontendUrl(`/courses/${co.id}`));
        const thumb = imgUrl(co.thumbnail_url, ctx.apiBase);
        const free = Number(co.is_free) === 1 || Number(co.price) === 0;
        const strike = !free && Number(co.original_price) > Number(co.price);
        const price = free
          ? `<span style="background:#059669;color:#fff;border-radius:8px;padding:3px 10px;font-size:13px;font-weight:700;">${T("GRATUIT", "FREE")}</span>`
          : `${strike ? `<span style="color:#999;text-decoration:line-through;margin-right:8px;">${money(co.original_price, lang)}</span>` : ""}<strong style="color:${BRAND};font-size:18px;">${money(co.price, lang)}</strong>`;
        textParts.push(`${co.title} — ${free ? T("Gratuit", "Free") : money(co.price, lang)}: ${frontendUrl(`/courses/${co.id}`)}`);
        return `<div style="border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;margin:14px 0;">
          ${thumb ? `<a href="${esc(href)}"><img src="${esc(thumb)}" alt="" width="536" style="display:block;width:100%;height:auto;" /></a>` : ""}
          <div style="padding:16px 18px;">
            <p style="margin:0 0 6px;font-size:17px;font-weight:700;color:#222;">${esc(co.title)}</p>
            ${co.short_description ? `<p style="margin:0 0 10px;color:#666;font-size:14px;line-height:1.5;">${esc(String(co.short_description).slice(0, 180))}</p>` : ""}
            <p style="margin:0 0 4px;">${price}</p>
            ${btn(href, T("Voir le cours", "View the course"))}
          </div></div>`;
      }
      case "webinar": {
        const w = b.bootcamp_id ? ctx.data.bootcamps[Number(b.bootcamp_id)] : null;
        if (!w) return "";
        const href = link(frontendUrl(`/bootcamps/${w.id}`));
        const when = w.scheduled_at
          ? new Date(w.scheduled_at).toLocaleString(lang === "en" ? "en-GB" : "fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Africa/Douala" }) + " (Douala)"
          : "";
        textParts.push(`${w.title} — ${when}: ${frontendUrl(`/bootcamps/${w.id}`)}`);
        const thumb = imgUrl(w.thumbnail_url, ctx.apiBase);
        return `<div style="background:#f4f3fb;border-radius:14px;padding:18px;margin:14px 0;">
          <p style="margin:0 0 4px;color:#5653e1;font-size:12px;font-weight:700;letter-spacing:1px;">${T("WEBINAIRE EN DIRECT", "LIVE WEBINAR")}</p>
          ${thumb ? `<img src="${esc(thumb)}" alt="" width="500" style="display:block;width:100%;height:auto;border-radius:10px;margin:8px 0;" />` : ""}
          <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#222;">${esc(w.title)}</p>
          <p style="margin:0 0 4px;color:#444;font-size:14px;">📅 ${esc(when)}${w.duration_minutes ? ` · ${w.duration_minutes} min` : ""}</p>
          <p style="margin:0;color:#444;font-size:14px;">${Number(w.is_free) === 1 ? T("Gratuit", "Free") : money(w.price, lang)}</p>
          ${btn(href, T("Je m'inscris", "Register"))}</div>`;
      }
      case "coupon":
        textParts.push(`${T("Code", "Code")}: ${b.code}`);
        return `<div style="border:2px dashed ${BRAND};border-radius:14px;padding:16px;text-align:center;margin:16px 0;background:#faf9ff;">
          ${b.text ? `<p style="margin:0 0 8px;color:#555;font-size:14px;">${esc(subst(b.text, ctx))}</p>` : ""}
          <p style="margin:0;font-size:26px;font-weight:900;letter-spacing:3px;color:${BRAND};">${esc(String(b.code || "").toUpperCase())}</p></div>`;
      case "divider":
        return `<hr style="border:none;border-top:1px solid #eee;margin:22px 0;" />`;
      default:
        return "";
    }
  }).join("\n");

  const subject = subst(getSubject(c, lang), ctx);
  const preheader = subst((lang === "en" ? c.preheader_en || c.preheader_fr : c.preheader_fr || c.preheader_en) || "", ctx);
  const prefUrl = ctx.prefToken ? frontendUrl(`/email-preferences/${ctx.prefToken}`) : frontendUrl("/email-preferences/preview");
  const unsubUrl = ctx.prefToken ? `${ctx.apiBase}/api/marketing/unsubscribe/${ctx.prefToken}${ctx.sendToken ? `?s=${ctx.sendToken}` : ""}` : "#";
  const pixel = ctx.sendToken ? `<img src="${ctx.apiBase}/api/marketing/o/${ctx.sendToken}.gif" width="1" height="1" alt="" style="display:block;border:0;" />` : "";

  const html = `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f3fb;font-family:'Segoe UI',Arial,sans-serif;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>` : ""}
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3fb;padding:28px 12px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#2d287f,#5653e1);border-radius:16px 16px 0 0;padding:24px 32px;text-align:center;">
    <p style="margin:0;color:#facc15;font-size:22px;font-weight:900;">DevOps Akademy</p></td></tr>
  <tr><td style="background:#fff;padding:30px 32px;border-radius:0 0 16px 16px;">
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:28px 0 18px;" />
    <p style="color:#999;font-size:12px;text-align:center;margin:0;line-height:1.7;">
      ${T("Vous recevez cet email car vous êtes inscrit à DevOpsAkademy.", "You are receiving this email because you are registered on DevOpsAkademy.")}<br/>
      <a href="${esc(prefUrl)}" style="color:#5653e1;">${T("Gérer mes préférences", "Manage my preferences")}</a> ·
      <a href="${esc(unsubUrl)}" style="color:#5653e1;">${T("Me désabonner", "Unsubscribe")}</a>
    </p>
  </td></tr>
</table></td></tr></table>${pixel}</body></html>`;

  const text = `${subject}\n\n${textParts.join("\n\n")}\n\n— ${T("Se désabonner", "Unsubscribe")}: ${unsubUrl}`;
  return { subject, html, text, unsubscribeUrl: unsubUrl };
}
