// src/utils/publicUrl.ts
import { Request } from "express";

/**
 * URL publique de l'API, utilisée pour construire les liens de fichiers uploadés.
 * Avant : repli codé en dur sur http://localhost:5000 → liens cassés en production.
 * Maintenant : API_BASE_URL (si défini et non local) sinon l'hôte réel de la requête
 * (app.set("trust proxy") est activé, donc le protocole https derrière nginx est correct).
 */
export const publicBaseUrl = (req: Request): string => {
  const fromEnv = (process.env.API_BASE_URL || "").trim().replace(/\/+$/, "");
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(fromEnv);
  const host = req.get("host") || "";
  const requestIsLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  if (fromEnv && (!isLocal || requestIsLocal)) return fromEnv;
  return `${req.protocol}://${host}`;
};

/** Accepte uniquement http(s) ou un chemin /uploads/… (évite javascript:, data:, etc.). */
export const isSafeMediaUrl = (value: string): boolean =>
  /^https?:\/\/[^\s]+$/i.test(value) || /^\/uploads\/[^\s]+$/.test(value);
