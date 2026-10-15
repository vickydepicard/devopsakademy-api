// scripts/load-translations.ts
// Charge dans `content_translations` les traductions préparées (dictionnaires JSON).
// Usage : node -r ts-node/register/transpile-only scripts/load-translations.ts <dossier> [--dry]
// Les textes d'origine ne sont jamais modifiés ; les traductions faites à la main ne sont jamais écrasées.
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();
import { query } from "../src/config/database";
import { ENTITIES, ensureTranslationTables, flattenList, hashOf } from "../src/services/contentTranslation";

const dir = process.argv[2];
const dry = process.argv.includes("--dry");
if (!dir) { console.error("Dossier des dictionnaires requis"); process.exit(1); }

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const uniq = read("unique.json");
const t1 = read("en_titles_descs.json");
const t2 = read("en_items.json");
const t3 = read("en_longs.json");

const norm = (s: string) => String(s).replace(/\r\n/g, "\n").trim();
const build = (src: string[], tr: Record<string, any>) => {
  const m = new Map<string, any>();
  src.forEach((s, i) => { if (tr[String(i)] !== undefined) m.set(norm(s), tr[String(i)]); });
  return m;
};
const titles = build(uniq.titles, t1.titles);
const descs = build(uniq.descs, t1.descs);
const longs = build(uniq.longs, t3.longs);
const items = build(uniq.items, t2.items);
const catFr = new Map<string, string>(Object.entries(t1.cat_fr));

const missing: string[] = [];
const miss = (where: string, text: string) => missing.push(`${where}: ${String(text).slice(0, 70)}`);

type Row = { entity: string; id: number; field: string; lang: string; text: string; hash: string };
const rows: Row[] = [];

const addText = (entity: string, id: number, field: string, lang: string, source: any, dict: Map<string, any>[]) => {
  if (source === null || source === undefined || String(source).trim() === "") return;
  const key = norm(source);
  let tr: any;
  for (const d of dict) { if (d.has(key)) { tr = d.get(key); break; } }
  if (typeof tr !== "string") { miss(`${entity}#${id}.${field}`, key); return; }
  const out = String(source).includes("\r\n") ? tr.replace(/\n/g, "\r\n") : tr;
  rows.push({ entity, id, field, lang, text: out, hash: hashOf(source, false) });
};

// Traduit une valeur de liste, y compris celles stockées en JSON imbriqué (tableau contenant du JSON…)
const trList = (s: string, where: string): string[] | null => {
  const direct = items.get(norm(s));
  if (Array.isArray(direct)) return direct.map(String);
  if (typeof direct === "string") return [direct];
  try {
    const p = JSON.parse(s.trim());
    if (Array.isArray(p)) {
      const out: string[] = [];
      for (const e of p) { const r = trList(String(e), where); if (!r) return null; out.push(...r); }
      return out;
    }
    if (typeof p === "string" && p !== s) return trList(p, where);
  } catch { /* texte brut */ }
  miss(where, s);
  return null;
};

const addList = (entity: string, id: number, field: string, source: any) => {
  if (source === null || source === undefined || String(source).trim() === "") return;
  const arr = trList(String(source), `${entity}#${id}.${field}`);
  if (arr && arr.length) rows.push({ entity, id, field, lang: "en", text: JSON.stringify(arr), hash: hashOf(source, true) });
};

(async () => {
  for (const [entity, def] of Object.entries(ENTITIES)) {
    let data: any[] = [];
    try { data = await query(`SELECT id, ${def.fields.join(", ")} FROM ${def.table}`); } catch { continue; }
    for (const r of data) {
      const id = Number(r.id);
      if (entity === "category") {
        addText(entity, id, "name", "fr", r.name, [{ has: (k: string) => catFr.has(k), get: (k: string) => catFr.get(k) } as any]);
        addText(entity, id, "description", "en", r.description, [descs]);
        continue;
      }
      for (const field of def.fields) {
        if (def.listFields.includes(field)) { addList(entity, id, field, r[field]); continue; }
        addText(entity, id, field, "en", r[field], [titles, descs, longs]);
      }
    }
  }

  const byEntity: Record<string, number> = {};
  rows.forEach((r) => { byEntity[`${r.entity}/${r.lang}`] = (byEntity[`${r.entity}/${r.lang}`] || 0) + 1; });
  console.log("Traductions préparées :", rows.length, JSON.stringify(byEntity));
  console.log("Textes sans traduction :", missing.length);
  [...new Set(missing)].slice(0, 25).forEach((m) => console.log("  -", m));
  if (dry) { console.log("(simulation : rien n'a été écrit)"); process.exit(0); }

  await ensureTranslationTables();
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const ph = chunk.map(() => "(?, ?, ?, ?, ?, ?, 0)").join(",");
    await query(
      `INSERT INTO content_translations (entity, entity_id, field, lang, text, source_hash, is_manual) VALUES ${ph}
       ON DUPLICATE KEY UPDATE text = IF(is_manual = 1, text, VALUES(text)), source_hash = IF(is_manual = 1, source_hash, VALUES(source_hash))`,
      chunk.flatMap((r) => [r.entity, r.id, r.field, r.lang, r.text, r.hash]));
    written += chunk.length;
  }
  console.log("Écrit dans la base :", written);
  process.exit(0);
})().catch((e) => { console.error("ERREUR", e?.message || e); process.exit(1); });
