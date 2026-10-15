// src/controllers/translationsController.ts
// Administration des traductions du contenu : couverture, édition manuelle, traduction automatique.
import { Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { fail, serverError, logAudit } from "../utils/respond";
import { parseId } from "../utils/serialize";
import {
  ENTITIES, Lang, autoTranslate, autoTranslateConfigured, detectLang, ensureTranslationTables, flattenList, hashOf,
} from "../services/contentTranslation";

type Req = AuthenticatedRequest;
const LANGS: Lang[] = ["fr", "en"];
const asLang = (v: any): Lang => (v === "fr" ? "fr" : "en");

interface Item { entity: string; id: number; field: string; label: string; source: any; isList: boolean; hash: string }

async function loadItems(entities: string[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const entity of entities) {
    const def = ENTITIES[entity];
    if (!def) continue;
    let rows: any[] = [];
    try { rows = await query(`SELECT id, ${[...new Set([def.label, ...def.fields])].join(", ")} FROM ${def.table}`); } catch { continue; }
    for (const r of rows) {
      for (const field of def.fields) {
        const v = r[field];
        if (v === null || v === undefined || String(v).trim() === "") continue;
        const isList = def.listFields.includes(field);
        out.push({ entity, id: Number(r.id), field, label: String(r[def.label] ?? ""), source: v, isList, hash: hashOf(v, isList) });
      }
    }
  }
  return out;
}

const textOf = (it: Item): string => (it.isList ? flattenList(it.source).join(" ") : String(it.source));

type Status = "done" | "manual" | "stale" | "missing" | "same_lang";
async function statuses(items: Item[], lang: Lang) {
  const rows: any[] = await query("SELECT entity, entity_id, field, text, source_hash, is_manual FROM content_translations WHERE lang = ?", [lang]);
  const map = new Map(rows.map((r) => [`${r.entity}|${r.entity_id}|${r.field}`, r]));
  return items.map((it) => {
    const tr = map.get(`${it.entity}|${it.id}|${it.field}`);
    let status: Status;
    if (tr) status = Number(tr.is_manual) ? "manual" : tr.source_hash === it.hash ? "done" : "stale";
    else status = detectLang(textOf(it)) === lang ? "same_lang" : "missing";
    return { it, tr, status };
  });
}

// GET /status
export const getStatus = async (req: Req, res: Response) => {
  try {
    await ensureTranslationTables();
    return res.json({ success: true, data: { auto_configured: autoTranslateConfigured(), model: process.env.TRANSLATION_MODEL || "claude-haiku-5-5", languages: LANGS, entities: Object.keys(ENTITIES) } });
  } catch (e) { return serverError(req, res, "translations.status", e); }
};

// GET /summary?lang=en
export const getSummary = async (req: Req, res: Response) => {
  try {
    await ensureTranslationTables();
    const lang = asLang(req.query.lang);
    const items = await loadItems(Object.keys(ENTITIES));
    const st = await statuses(items, lang);
    const by: Record<string, { total: number; done: number; stale: number; missing: number; same_lang: number }> = {};
    for (const { it, status } of st) {
      const e = (by[it.entity] ||= { total: 0, done: 0, stale: 0, missing: 0, same_lang: 0 });
      e.total++;
      if (status === "done" || status === "manual") e.done++; else if (status === "stale") e.stale++; else if (status === "missing") e.missing++; else e.same_lang++;
    }
    return res.json({ success: true, data: by });
  } catch (e) { return serverError(req, res, "translations.summary", e); }
};

// GET /items?entity=&lang=&status=&search=&page=
export const listItems = async (req: Req, res: Response) => {
  try {
    await ensureTranslationTables();
    const lang = asLang(req.query.lang);
    const entity = String(req.query.entity || "");
    const status = String(req.query.status || "all");
    const search = String(req.query.search || "").trim().toLowerCase().slice(0, 80);
    const page = Math.max(parseId(req.query.page) || 1, 1), limit = 40;

    const items = await loadItems(ENTITIES[entity] ? [entity] : Object.keys(ENTITIES));
    let st = await statuses(items, lang);
    if (["done", "manual", "stale", "missing", "same_lang"].includes(status)) st = st.filter((x) => x.status === status);
    else if (status === "todo") st = st.filter((x) => x.status === "missing" || x.status === "stale");
    if (search) st = st.filter((x) => textOf(x.it).toLowerCase().includes(search) || x.it.label.toLowerCase().includes(search) || (x.tr && String(x.tr.text).toLowerCase().includes(search)));
    const total = st.length;
    const slice = st.slice((page - 1) * limit, page * limit).map(({ it, tr, status: s }) => ({
      entity: it.entity, id: it.id, field: it.field, label: it.label, is_list: it.isList, status: s,
      source: it.isList ? flattenList(it.source) : String(it.source),
      translation: tr ? (it.isList ? (() => { try { return JSON.parse(tr.text); } catch { return []; } })() : tr.text) : null,
    }));
    return res.json({ success: true, data: slice, pagination: { page, limit, total } });
  } catch (e) { return serverError(req, res, "translations.list", e); }
};

// PUT /item { entity, id, field, lang, text | items[] }
export const saveItem = async (req: Req, res: Response) => {
  try {
    await ensureTranslationTables();
    const { entity, field } = req.body || {};
    const id = parseId(req.body?.id);
    const lang = asLang(req.body?.lang);
    const def = ENTITIES[entity];
    if (!def || !def.fields.includes(field) || !id) return fail(req, res, 400, "Élément invalide", "Invalid item");
    const [row]: any = await query(`SELECT ${field} AS v FROM ${def.table} WHERE id = ?`, [id]);
    if (!row) return fail(req, res, 404, "Élément introuvable", "Item not found");
    const isList = def.listFields.includes(field);
    let text: string;
    if (isList) {
      const arr = (Array.isArray(req.body?.items) ? req.body.items : String(req.body?.text ?? "").split("\n")).map((x: any) => String(x).trim()).filter(Boolean);
      if (!arr.length) return fail(req, res, 400, "La traduction est vide.", "The translation is empty.");
      text = JSON.stringify(arr);
    } else {
      text = String(req.body?.text ?? "").trim();
      if (!text) return fail(req, res, 400, "La traduction est vide.", "The translation is empty.");
    }
    if (text.length > 200_000) return fail(req, res, 413, "Texte trop long.", "Text too long.");
    await query(
      `INSERT INTO content_translations (entity, entity_id, field, lang, text, source_hash, is_manual) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE text = VALUES(text), source_hash = VALUES(source_hash), is_manual = 1`,
      [entity, id, field, lang, text, hashOf(row.v, isList)]);
    await logAudit(req, "admin", "content.translation_saved", entity, id, null, { field, lang });
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "translations.save", e); }
};

// DELETE /item?entity&id&field&lang
export const deleteItem = async (req: Req, res: Response) => {
  try {
    await query("DELETE FROM content_translations WHERE entity = ? AND entity_id = ? AND field = ? AND lang = ?",
      [String(req.query.entity), parseId(req.query.id), String(req.query.field), asLang(req.query.lang)]);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "translations.delete", e); }
};

// POST /auto { lang, entity?, scope: 'missing' | 'stale' | 'todo', limit }
export const runAuto = async (req: Req, res: Response) => {
  try {
    await ensureTranslationTables();
    if (!autoTranslateConfigured())
      return fail(req, res, 501, "Traduction automatique non configurée (ANTHROPIC_API_KEY manquante).", "Automatic translation is not configured (ANTHROPIC_API_KEY missing).", { code: "NOT_CONFIGURED" });
    const lang = asLang(req.body?.lang);
    const from: Lang = lang === "en" ? "fr" : "en";
    const entity = String(req.body?.entity || "");
    const scope = ["missing", "stale"].includes(req.body?.scope) ? req.body.scope : "todo";
    const limit = Math.min(Math.max(Number(req.body?.limit) || 40, 1), 80);

    const items = await loadItems(ENTITIES[entity] ? [entity] : Object.keys(ENTITIES));
    const todo = (await statuses(items, lang)).filter((x) => (scope === "todo" ? x.status === "missing" || x.status === "stale" : x.status === scope)).slice(0, limit);
    if (!todo.length) return res.json({ success: true, data: { translated: 0, remaining: 0 } });

    // feuilles de texte uniques (les éléments de liste sont traduits un par un)
    const leaves: string[] = [];
    const index = new Map<string, number>();
    const add = (s: string) => { if (!index.has(s)) { index.set(s, leaves.length); leaves.push(s); } return index.get(s)!; };
    const plan = todo.map(({ it }) => ({ it, refs: it.isList ? flattenList(it.source).map(add) : [add(String(it.source).trim())] }));

    const out: string[] = new Array(leaves.length);
    for (let i = 0; i < leaves.length; i += 12) {
      const chunk = leaves.slice(i, i + 12);
      const tr = await autoTranslate(chunk, from, lang);
      tr.forEach((t, k) => { out[i + k] = t; });
    }
    for (const { it, refs } of plan) {
      const text = it.isList ? JSON.stringify(refs.map((r) => out[r])) : out[refs[0]];
      await query(
        `INSERT INTO content_translations (entity, entity_id, field, lang, text, source_hash, is_manual) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE text = VALUES(text), source_hash = VALUES(source_hash), is_manual = 0`,
        [it.entity, it.id, it.field, lang, text, it.hash]);
    }
    await logAudit(req, "admin", "content.auto_translated", null as any, null, null, { lang, count: todo.length });
    const remaining = (await statuses(items, lang)).filter((x) => x.status === "missing" || x.status === "stale").length;
    return res.json({ success: true, data: { translated: todo.length, remaining } });
  } catch (e: any) {
    console.error("translations.auto:", e?.message || e);
    return fail(req, res, 502, `Traduction automatique impossible : ${e?.message || "erreur"}`, `Automatic translation failed: ${e?.message || "error"}`);
  }
};
