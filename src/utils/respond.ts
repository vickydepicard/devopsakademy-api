// src/utils/respond.ts — réponses d'erreur bilingues communes aux nouveaux contrôleurs
import { Request, Response } from "express";
import { query } from "../config/database";
import { tr } from "./lang";

export const fail = (req: Request, res: Response, status: number, fr: string, en: string, extra: object = {}) =>
  res.status(status).json({ success: false, message: tr(req, fr, en), ...extra });

export const serverError = (req: Request, res: Response, label: string, error: any) => {
  console.error(`${label}:`, error?.message || error);
  return fail(req, res, 500, "Erreur serveur", "Server error");
};

/** Nombre (DECIMAL/BigInt/string du driver MariaDB) → Number, null conservé. */
export const toNum = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

export type AuditCategory = "admin" | "payment" | "subscription" | "system" | "course" | "user";

/** Journal d'audit (table audit_logs) — ne bloque jamais l'action. */
export async function logAudit(
  req: Request & { user?: { id: number; role: string } },
  category: AuditCategory,
  action: string,
  targetType: string | null,
  targetId: number | null,
  before: object | null,
  after: object | null
) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_role, category, action, target_type, target_id, data_before, data_after, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user?.id ?? null, req.user?.role ?? null, category, action, targetType, targetId,
        before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
        (req.ip || "").slice(0, 45), String(req.headers["user-agent"] || "").slice(0, 500) || null,
      ]
    );
  } catch (e: any) {
    console.warn("audit_logs:", e?.message || e);
  }
}
