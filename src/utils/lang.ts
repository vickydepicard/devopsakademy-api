// src/utils/lang.ts — langue de l'utilisateur (FR / EN) pour les emails et les messages API
import { Request } from "express";
import { query } from "../config/database";

export type Lang = "fr" | "en";
export const DEFAULT_LANG: Lang = "fr";

/** "en-US,en;q=0.9" → "en" ; toute valeur inconnue → langue par défaut */
export const normalizeLang = (value?: unknown): Lang => {
  const v = String(value ?? "").trim().toLowerCase();
  if (v.startsWith("en")) return "en";
  if (v.startsWith("fr")) return "fr";
  return DEFAULT_LANG;
};

/** Langue demandée par le client : body.language > en-tête Accept-Language */
export const langFromReq = (req: Request): Lang => {
  const fromBody = (req.body as any)?.language;
  if (fromBody) return normalizeLang(fromBody);
  const header = req.headers["accept-language"];
  return normalizeLang(Array.isArray(header) ? header[0] : header);
};

/** Choisit le texte selon la langue de la requête */
export const tr = (req: Request, fr: string, en: string): string =>
  langFromReq(req) === "en" ? en : fr;

// ── Colonne users.preferred_language ───────────────────────────────────────
export const ensureUserLanguageColumn = async (): Promise<void> => {
  await query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(5) NOT NULL DEFAULT 'fr'"
  );
};

/** Langue enregistrée pour un utilisateur (id ou email). Ne lève jamais : repli sur FR. */
export const getUserLang = async (idOrEmail: number | string, fallback: Lang = DEFAULT_LANG): Promise<Lang> => {
  try {
    const isEmail = typeof idOrEmail === "string" && idOrEmail.includes("@");
    const rows: any[] = await query(
      `SELECT preferred_language FROM users WHERE ${isEmail ? "email" : "id"} = ? LIMIT 1`,
      [idOrEmail]
    );
    return rows[0]?.preferred_language ? normalizeLang(rows[0].preferred_language) : fallback;
  } catch {
    return fallback;
  }
};

/** Enregistre la langue préférée (non bloquant si la colonne n'existe pas encore). */
export const setUserLang = async (userId: number, lang: Lang): Promise<void> => {
  try {
    await query("UPDATE users SET preferred_language = ? WHERE id = ?", [lang, userId]);
  } catch (e: any) {
    console.warn("preferred_language non enregistrée:", e.message);
  }
};
