// src/utils/serialize.ts
// Le driver MariaDB renvoie des BigInt pour COUNT(), SUM() et insertId :
// JSON.stringify les refuse. Ces helpers les convertissent proprement.

export const toPlain = <T = any>(value: any): T => {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return Number(value) as any;
  if (value instanceof Date) return value as any;
  if (Array.isArray(value)) return value.map(toPlain) as any;
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toPlain(v);
    return out as T;
  }
  return value;
};

/** Parse un champ JSON stocké en texte (colonne longtext) avec valeur de repli. */
export const parseJson = <T = any>(value: any, fallback: T): T => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

/** Entier strictement positif, sinon null. */
export const parseId = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Accepte un tableau ou un texte multi-lignes ; nettoie, limite le volume. */
export const toStringList = (value: unknown, maxItems = 50, maxLen = 300): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  return raw
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((v) => v.slice(0, maxLen));
};
