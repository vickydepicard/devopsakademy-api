// src/services/contentTranslation.ts
// Traduction du contenu de la base (cours, modules, leçons, catégories, lives, abonnements…).
// Les textes d'origine ne sont JAMAIS modifiés : les traductions vivent dans `content_translations`
// et sont appliquées aux réponses de l'API selon la langue du visiteur.
import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { query } from "../config/database";
import { langFromReq } from "../utils/lang";

export type Lang = "fr" | "en";

// ══════════════════════════════════════════════════════
// ENTITÉS TRADUISIBLES
// ══════════════════════════════════════════════════════
export interface EntityDef { table: string; fields: string[]; listFields: string[]; label: string }
export const ENTITIES: Record<string, EntityDef> = {
  course:         { table: "courses",            fields: ["title", "short_description", "description", "requirements", "learning_outcomes"], listFields: ["requirements", "learning_outcomes"], label: "title" },
  module:         { table: "modules",            fields: ["title", "description"],                      listFields: [],           label: "title" },
  lesson:         { table: "lessons",            fields: ["title"],                                     listFields: [],           label: "title" },
  category:       { table: "course_categories",  fields: ["name", "description"],                       listFields: [],           label: "name" },
  bootcamp:       { table: "bootcamps",          fields: ["title", "description"],                      listFields: [],           label: "title" },
  plan:           { table: "subscription_plans", fields: ["name", "description", "features"],           listFields: ["features"], label: "name" },
  quiz:           { table: "quizzes",            fields: ["title", "description"],                      listFields: [],           label: "title" },
  forum_category: { table: "forum_categories",   fields: ["name", "description"],                       listFields: [],           label: "name" },
};

// ══════════════════════════════════════════════════════
// TABLE
// ══════════════════════════════════════════════════════
let ready: Promise<void> | null = null;
export const ensureTranslationTables = (): Promise<void> => {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS content_translations (
          entity VARCHAR(30) NOT NULL,
          entity_id INT UNSIGNED NOT NULL,
          field VARCHAR(40) NOT NULL,
          lang CHAR(2) NOT NULL,
          text LONGTEXT NOT NULL,
          source_hash CHAR(32) NOT NULL,
          is_manual TINYINT(1) NOT NULL DEFAULT 0,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (entity, entity_id, field, lang),
          INDEX idx_lang (lang, entity)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
};

// ══════════════════════════════════════════════════════
// EMPREINTE DU TEXTE D'ORIGINE (détecte les traductions périmées)
// ══════════════════════════════════════════════════════
/** Aplatit les listes, y compris celles stockées par erreur en JSON imbriqué. */
export const flattenList = (v: any): string[] => {
  if (Array.isArray(v)) return v.flatMap(flattenList);
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[") || s.startsWith('"')) {
      try { const p = JSON.parse(s); if (Array.isArray(p) || (typeof p === "string" && p !== s)) return flattenList(p); } catch { /* texte brut */ }
    }
    return s ? [s] : [];
  }
  return v === null || v === undefined ? [] : [String(v)];
};

export const hashOf = (value: any, isList: boolean): string =>
  crypto.createHash("md5").update(isList ? JSON.stringify(flattenList(value)) : String(value ?? "").trim()).digest("hex");

// ══════════════════════════════════════════════════════
// HABILLAGE DES RÉPONSES
// ══════════════════════════════════════════════════════
type Cand = { entity: string; id: number; field: string; obj: any; key: string };

// Détection d'une entité à partir des clés de l'objet JSON (schéma de la plateforme)
function detect(o: any): { entity: string; id: number; fields: { field: string; key: string }[] }[] {
  const out: { entity: string; id: number; fields: { field: string; key: string }[] }[] = [];
  const has = (k: string) => k in o;
  const id = Number(o.id);
  const f = (field: string, key = field) => ({ field, key });
  if (has("module_id") && has("title") && Number.isInteger(id)) {
    out.push({ entity: "lesson", id, fields: [f("title")] });
  } else if (has("course_id") && has("title") && (has("order_index") || has("lessons")) && Number.isInteger(id)) {
    out.push({ entity: "module", id, fields: [f("title"), ...(has("description") ? [f("description")] : [])] });
  } else if (has("title") && !has("course_id") && (has("price") || has("short_description") || has("instructor_id") || has("level")) && !has("stream_type") && !has("scheduled_at") && Number.isInteger(id)) {
    out.push({ entity: "course", id, fields: ["title", "short_description", "description", "requirements", "learning_outcomes"].filter(has).map((k) => f(k)) });
  } else if (has("title") && (has("stream_type") || has("scheduled_at")) && Number.isInteger(id)) {
    out.push({ entity: "bootcamp", id, fields: ["title", "description"].filter(has).map((k) => f(k)) });
  } else if (has("name") && has("slug") && (has("color") || has("icon") || has("order_index")) && !has("topic_count") && Number.isInteger(id)) {
    out.push({ entity: "category", id, fields: ["name", "description"].filter(has).map((k) => f(k)) });
  } else if (has("name") && has("features") && Number.isInteger(id)) {
    out.push({ entity: "plan", id, fields: ["name", "description", "features"].filter(has).map((k) => f(k)) });
  }
  // références : { course_id, course_title } ou { category_id, category_name }
  if (has("course_id") && has("course_title") && Number.isInteger(Number(o.course_id))) out.push({ entity: "course", id: Number(o.course_id), fields: [{ field: "title", key: "course_title" }] });
  if (has("category_id") && has("category_name") && Number.isInteger(Number(o.category_id))) out.push({ entity: "category", id: Number(o.category_id), fields: [{ field: "name", key: "category_name" }] });
  return out;
}

function collect(node: any, acc: Cand[], depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) collect(n, acc, depth + 1); return; }
  if (node instanceof Date) return;
  for (const d of detect(node)) {
    for (const { field, key } of d.fields) {
      if (node[key] !== null && node[key] !== undefined && node[key] !== "") acc.push({ entity: d.entity, id: d.id, field, obj: node, key });
    }
  }
  for (const v of Object.values(node)) collect(v, acc, depth + 1);
}

export async function overlayTranslations(payload: any, lang: Lang): Promise<void> {
  const cands: Cand[] = [];
  collect(payload, cands);
  if (!cands.length) return;

  const byEntity = new Map<string, Set<number>>();
  for (const c of cands) { if (!byEntity.has(c.entity)) byEntity.set(c.entity, new Set()); byEntity.get(c.entity)!.add(c.id); }
  const parts: string[] = []; const params: any[] = [lang];
  for (const [entity, ids] of byEntity) {
    const list = [...ids].slice(0, 2000);
    parts.push(`(entity = ? AND entity_id IN (${list.map(() => "?").join(",")}))`);
    params.push(entity, ...list);
  }
  const rows: any[] = await query(
    `SELECT entity, entity_id, field, text, source_hash, is_manual FROM content_translations WHERE lang = ? AND (${parts.join(" OR ")})`, params);
  if (!rows.length) return;
  const map = new Map<string, any>();
  for (const r of rows) map.set(`${r.entity}|${r.entity_id}|${r.field}`, r);

  for (const c of cands) {
    const row = map.get(`${c.entity}|${c.id}|${c.field}`);
    if (!row) continue;
    const isList = ENTITIES[c.entity].listFields.includes(c.field);
    const current = c.obj[c.key];
    // traduction périmée (texte d'origine modifié depuis) : on garde l'original, sauf traduction faite à la main
    if (!Number(row.is_manual) && row.source_hash !== hashOf(current, isList)) continue;
    if (isList) {
      let arr: any = null;
      try { arr = JSON.parse(row.text); } catch { arr = null; }
      if (!Array.isArray(arr)) continue;
      c.obj[c.key] = Array.isArray(current) ? arr : JSON.stringify(arr);
    } else {
      c.obj[c.key] = row.text;
    }
  }
}

// ── Rôle de l'appelant : administrateurs et instructeurs voient toujours l'original (ils l'éditent)
const roleCache = new Map<number, { role: string; at: number }>();
async function callerRole(req: Request): Promise<string | null> {
  const h = req.headers["authorization"];
  if (!h || !String(h).startsWith("Bearer ")) return null;
  try {
    const decoded: any = jwt.verify(String(h).split(" ")[1], process.env.JWT_SECRET as string);
    const id = Number(decoded?.id);
    if (!id) return null;
    const hit = roleCache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.role;
    const [u]: any = await query("SELECT role FROM users WHERE id = ?", [id]);
    if (u?.role) roleCache.set(id, { role: u.role, at: Date.now() });
    return u?.role || null;
  } catch { return null; }
}

/** Middleware : applique les traductions aux réponses JSON des routes de lecture publiques. */
export const translateResponses = (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET" || req.headers["x-original-content"] === "1") return next();
  const original = res.json.bind(res);
  (res as any).json = (body: any) => {
    (async () => {
      try {
        if (body && typeof body === "object" && res.statusCode < 400) {
          const role = await callerRole(req);
          if (!role || role === "student") {
            await ensureTranslationTables();
            await overlayTranslations(body, langFromReq(req));
          }
        }
      } catch (e: any) {
        console.warn("translateResponses:", e?.message || e);   // jamais bloquant : l'original est renvoyé
      }
      original(body);
    })();
    return res;
  };
  next();
};

// ══════════════════════════════════════════════════════
// TRADUCTION AUTOMATIQUE (optionnelle : nécessite ANTHROPIC_API_KEY)
// ══════════════════════════════════════════════════════
export const autoTranslateConfigured = (): boolean => !!process.env.ANTHROPIC_API_KEY;

const FR_WORDS = /\b(le|la|les|des|du|de|un|une|et|pour|avec|dans|sur|vous|votre|est|sont|cours|à|au|aux|ce|cette)\b/gi;
const EN_WORDS = /\b(the|and|of|to|for|with|in|on|is|are|you|your|this|that|course|a|an|from|by)\b/gi;
/** Heuristique simple pour éviter de « traduire » un texte déjà dans la langue cible. */
export const detectLang = (text: string): Lang | "unknown" => {
  const s = String(text || "");
  if (s.length < 12) return "unknown";
  const fr = (s.match(FR_WORDS) || []).length + (/[éèêàùçôî]/i.test(s) ? 2 : 0);
  const en = (s.match(EN_WORDS) || []).length;
  if (fr === en) return "unknown";
  return fr > en ? "fr" : "en";
};

export async function autoTranslate(texts: string[], from: Lang, to: Lang): Promise<string[]> {
  if (!autoTranslateConfigured()) throw new Error("AUTO_TRANSLATE_NOT_CONFIGURED");
  const names = { fr: "French", en: "English" };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": String(process.env.ANTHROPIC_API_KEY), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.TRANSLATION_MODEL || "claude-haiku-5-5",
      max_tokens: 8000,
      system: `You translate e-learning content for a DevOps training platform from ${names[from]} to ${names[to]}. ` +
        `Keep product names, tool names, certification codes, commands and acronyms unchanged (Docker, Kubernetes, AWS, CKA…). ` +
        `Preserve line breaks, bullet characters and punctuation style. Be natural and concise. ` +
        `Reply with ONLY a JSON array of strings, same length and order as the input array, no commentary.`,
      messages: [{ role: "user", content: JSON.stringify(texts) }],
    }),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  const raw = String(j?.content?.[0]?.text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error("Réponse de traduction invalide");
  return arr.map((x) => String(x));
}
