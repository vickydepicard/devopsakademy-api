// src/controllers/settingsController.ts
// Paramètres de la plateforme : table platform_settings (clé/valeur) + mode maintenance (table maintenance_mode).
import { Response } from "express";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { tr } from "../utils/lang";
import { fail, serverError, logAudit } from "../utils/respond";

type Req = AuthenticatedRequest;

type Spec = { type: "string" | "boolean" | "number"; def: string | boolean | number; min?: number; max?: number; kind?: "email" | "url" };

const SPEC: Record<string, Spec> = {
  // Général
  site_name: { type: "string", def: "DevOpsAkademy" },
  site_url: { type: "string", def: "", kind: "url" },
  support_email: { type: "string", def: "", kind: "email" },
  contact_email: { type: "string", def: "", kind: "email" },
  // Paiements
  currency: { type: "string", def: "XAF" },
  currency_symbol: { type: "string", def: "FCFA" },
  mobile_money_number: { type: "string", def: "" },
  bank_account: { type: "string", def: "" },
  // Fonctionnalités
  allow_registration: { type: "boolean", def: true },
  require_email_verification: { type: "boolean", def: true },
  allow_free_courses: { type: "boolean", def: true },
  allow_forum: { type: "boolean", def: true },
  maintenance_mode: { type: "boolean", def: false }, // stocké dans maintenance_mode.is_active
  // Notifications
  email_notifications: { type: "boolean", def: true },
  notify_on_enrollment: { type: "boolean", def: true },
  notify_on_completion: { type: "boolean", def: true },
  // Chat en direct (Tawk.to) : propriété et widget fournis dans Tawk.to > Administration > Chat Widget
  tawk_enabled: { type: "boolean", def: true },
  tawk_property_id: { type: "string", def: "" },
  tawk_widget_id: { type: "string", def: "default" },
  // Sécurité
  max_login_attempts: { type: "number", def: 5, min: 1, max: 100 },
  session_timeout_hours: { type: "number", def: 24, min: 1, max: 720 },
};

let tableReady: Promise<void> | null = null;
export const ensureSettingsTable = (): Promise<void> => {
  if (!tableReady) {
    tableReady = query(
      `CREATE TABLE IF NOT EXISTS platform_settings (
         setting_key   VARCHAR(100) NOT NULL PRIMARY KEY,
         setting_value TEXT NULL,
         updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    ).then(() => undefined).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
};

const decode = (spec: Spec, raw: string | null): string | boolean | number => {
  if (raw === null || raw === undefined) return spec.def;
  if (spec.type === "boolean") return raw === "1" || raw === "true";
  if (spec.type === "number") { const n = Number(raw); return Number.isFinite(n) ? n : spec.def; }
  return raw;
};

const readAll = async () => {
  await ensureSettingsTable();
  const rows: any[] = await query("SELECT setting_key, setting_value FROM platform_settings");
  const stored = new Map(rows.map((r) => [String(r.setting_key), r.setting_value as string | null]));
  const out: Record<string, string | boolean | number> = {};
  for (const [key, spec] of Object.entries(SPEC)) out[key] = decode(spec, stored.get(key) ?? null);
  try {
    const [m]: any = await query("SELECT is_active FROM maintenance_mode ORDER BY id ASC LIMIT 1");
    out.maintenance_mode = !!(m && Number(m.is_active) === 1);
  } catch { /* table absente : valeur par défaut */ }
  return out;
};

// GET /api/settings/public — uniquement les réglages sans risque, utilisables par le site public
export const getPublicSettings = async (req: Req, res: Response) => {
  try {
    const all = await readAll();
    const id = String(all.tawk_property_id || "").trim();
    const widget = String(all.tawk_widget_id || "default").trim() || "default";
    const safe = /^[a-zA-Z0-9]+$/;
    res.set("Cache-Control", "public, max-age=60");
    return res.json({
      success: true,
      data: {
        site_name: all.site_name,
        currency: all.currency,
        currency_symbol: all.currency_symbol,
        allow_registration: all.allow_registration,
        allow_forum: all.allow_forum,
        maintenance_mode: all.maintenance_mode,
        tawk: all.tawk_enabled && safe.test(id) && safe.test(widget) ? { property_id: id, widget_id: widget } : null,
      },
    });
  } catch (e) { return serverError(req, res, "getPublicSettings", e); }
};

// GET /api/admin/settings
export const getSettings = async (req: Req, res: Response) => {
  try {
    return res.json({ success: true, data: await readAll() });
  } catch (e) { return serverError(req, res, "getSettings", e); }
};

const truthy = (v: any) => v === true || v === 1 || v === "1" || v === "true" || v === "on";
const falsy = (v: any) => v === false || v === 0 || v === "0" || v === "false" || v === "off";

// PATCH|PUT /api/admin/settings   (clés inconnues ignorées)
export const updateSettings = async (req: Req, res: Response) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const errors: Record<string, string> = {};
    const changes: Record<string, string | boolean | number> = {};

    for (const [key, spec] of Object.entries(SPEC)) {
      if (!(key in body)) continue;
      const v = body[key];
      if (spec.type === "boolean") {
        if (truthy(v)) changes[key] = true;
        else if (falsy(v)) changes[key] = false;
        else errors[key] = "invalid_boolean";
      } else if (spec.type === "number") {
        const n = Number(v);
        if (v === "" || v === null || !Number.isFinite(n) || n < (spec.min ?? -Infinity) || n > (spec.max ?? Infinity)) errors[key] = "invalid_number";
        else changes[key] = Math.round(n);
      } else {
        const s = String(v ?? "").trim();
        if (s.length > 500) errors[key] = "too_long";
        else if (spec.kind === "email" && s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) errors[key] = "invalid_email";
        else if (spec.kind === "url" && s && !/^https?:\/\/[^\s]+$/i.test(s)) errors[key] = "invalid_url";
        else changes[key] = s;
      }
    }
    if (Object.keys(errors).length) {
      return fail(req, res, 400, "Paramètres invalides", "Invalid settings", { errors });
    }

    await ensureSettingsTable();
    const before = await readAll();

    for (const [key, value] of Object.entries(changes)) {
      if (key === "maintenance_mode") continue;
      const stored = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
      await query(
        "INSERT INTO platform_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
        [key, stored]
      );
    }
    if ("maintenance_mode" in changes) {
      const active = changes.maintenance_mode ? 1 : 0;
      const [row]: any = await query("SELECT id FROM maintenance_mode ORDER BY id ASC LIMIT 1");
      if (row) await query("UPDATE maintenance_mode SET is_active = ?, updated_by = ? WHERE id = ?", [active, req.user!.id, row.id]);
      else await query("INSERT INTO maintenance_mode (is_active, updated_by) VALUES (?, ?)", [active, req.user!.id]);
    }

    const after = await readAll();
    const diffBefore: Record<string, unknown> = {};
    const diffAfter: Record<string, unknown> = {};
    for (const k of Object.keys(changes)) if (before[k] !== after[k]) { diffBefore[k] = before[k]; diffAfter[k] = after[k]; }
    if (Object.keys(diffAfter).length) await logAudit(req, "admin", "settings.updated", "settings", null, diffBefore, diffAfter);

    return res.json({ success: true, message: tr(req, "Paramètres enregistrés", "Settings saved"), data: after });
  } catch (e) { return serverError(req, res, "updateSettings", e); }
};
