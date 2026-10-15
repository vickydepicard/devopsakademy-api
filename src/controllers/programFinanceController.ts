// src/controllers/programFinanceController.ts
// Moyen de paiement des instructeurs, versements groupés, relevés (CSV) et paliers de commission.
import { Response } from "express";
import { query, withTransaction } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { fail, serverError, logAudit } from "../utils/respond";
import { langFromReq } from "../utils/lang";
import { parseId } from "../utils/serialize";
import { defaultCommissionRate } from "../services/commission.service";
import { ensureProgramTables, notifyUser, plain, num, ACTIVE_INSTRUCTOR_SQL } from "./programSetup";

type Req = AuthenticatedRequest;

// ══════════════════════════════════════════════════════
// MOYEN DE PAIEMENT
// ══════════════════════════════════════════════════════
const METHODS = ["mobile_money", "bank", "other"];

// GET /payout-profile (instructeur)
export const getMyPayoutProfile = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const [p]: any = await query("SELECT method, provider, account_name, account_number, country, notes, updated_at FROM instructor_payout_profiles WHERE user_id = ?", [req.user!.id]);
    return res.json({ success: true, data: p ? plain(p) : null });
  } catch (e) { return serverError(req, res, "getMyPayoutProfile", e); }
};

// PUT /payout-profile (instructeur)
export const saveMyPayoutProfile = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const b = req.body || {};
    const method = METHODS.includes(b.method) ? b.method : null;
    const accountName = String(b.account_name ?? "").trim().slice(0, 120);
    const accountNumber = String(b.account_number ?? "").trim().slice(0, 80);
    const errors: Record<string, string> = {};
    if (!method) errors.method = "invalid";
    if (accountName.length < 2) errors.account_name = "required";
    if (accountNumber.length < 4) errors.account_number = "required";
    if (Object.keys(errors).length) return fail(req, res, 400, "Certains champs sont invalides", "Some fields are invalid", { errors });
    await query(
      `INSERT INTO instructor_payout_profiles (user_id, method, provider, account_name, account_number, country, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE method = VALUES(method), provider = VALUES(provider), account_name = VALUES(account_name),
         account_number = VALUES(account_number), country = VALUES(country), notes = VALUES(notes)`,
      [req.user!.id, method, String(b.provider ?? "").trim().slice(0, 80) || null, accountName, accountNumber,
       String(b.country ?? "").trim().slice(0, 80) || null, String(b.notes ?? "").trim().slice(0, 500) || null]);
    await logAudit(req, "admin", "instructor.payout_profile_updated", "user", req.user!.id, null, { method });
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "saveMyPayoutProfile", e); }
};

// GET /admin/instructors/:id/payout-profile
export const adminGetPayoutProfile = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [p]: any = id ? await query("SELECT method, provider, account_name, account_number, country, notes, updated_at FROM instructor_payout_profiles WHERE user_id = ?", [id]) : [];
    return res.json({ success: true, data: p ? plain(p) : null });
  } catch (e) { return serverError(req, res, "adminGetPayoutProfile", e); }
};

// ══════════════════════════════════════════════════════
// VERSEMENTS GROUPÉS
// ══════════════════════════════════════════════════════
// GET /admin/payouts/summary — ce qui est dû, par instructeur
export const adminPayoutSummary = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email,
              SUM(ic.commission_amount) AS due_amount, COUNT(*) AS due_count, MIN(ic.earned_at) AS oldest_due,
              pp.method, pp.provider, pp.account_name, pp.account_number, pp.country
         FROM instructor_commissions ic
         JOIN users u ON u.id = ic.instructor_id
         LEFT JOIN instructor_payout_profiles pp ON pp.user_id = u.id
        WHERE ic.status <> 'paid'
        GROUP BY u.id, u.first_name, u.last_name, u.email, pp.method, pp.provider, pp.account_name, pp.account_number, pp.country
        ORDER BY due_amount DESC`);
    const [paid]: any = await query("SELECT COALESCE(SUM(commission_amount), 0) AS total FROM instructor_commissions WHERE status = 'paid'");
    const batches: any[] = await query(
      `SELECT b.id, b.reference, b.instructors_count, b.total_amount, b.created_at, u.first_name, u.last_name
         FROM instructor_payout_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 20`);
    const data = rows.map((r) => ({
      id: Number(r.id), first_name: r.first_name, last_name: r.last_name, email: r.email,
      due_amount: num(r.due_amount), due_count: num(r.due_count), oldest_due: r.oldest_due,
      profile: r.account_number ? { method: r.method, provider: r.provider, account_name: r.account_name, account_number: r.account_number, country: r.country } : null,
    }));
    return res.json({
      success: true,
      data: plain(data),
      totals: { due: data.reduce((s, d) => s + d.due_amount, 0), instructors: data.length, paid: num(paid?.total), currency: "XAF" },
      batches: plain(batches),
    });
  } catch (e) { return serverError(req, res, "adminPayoutSummary", e); }
};

// POST /admin/payouts/batch { instructor_ids: number[], reference, skip_without_profile? }
export const adminPayoutBatch = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const reference = String(req.body?.reference ?? "").trim();
    if (reference.length < 3 || reference.length > 90)
      return fail(req, res, 400, "Indiquez une référence de lot (3 à 90 caractères).", "Provide a batch reference (3 to 90 characters).", { errors: { reference: "invalid" } });
    const ids: number[] = [...new Set<number>((Array.isArray(req.body?.instructor_ids) ? req.body.instructor_ids : []).map(parseId).filter(Boolean) as number[])];
    if (!ids.length) return fail(req, res, 400, "Sélectionnez au moins un instructeur.", "Select at least one instructor.");

    const results: { instructor_id: number; amount: number; count: number; skipped?: string }[] = [];
    for (const id of ids) {
      if (req.body?.skip_without_profile) {
        const [p]: any = await query("SELECT user_id FROM instructor_payout_profiles WHERE user_id = ?", [id]);
        if (!p) { results.push({ instructor_id: id, amount: 0, count: 0, skipped: "no_profile" }); continue; }
      }
      const payRef = `${reference}-${id}`;
      const r = await withTransaction(async (q) => {
        const due: any[] = await q("SELECT id, commission_amount FROM instructor_commissions WHERE instructor_id = ? AND status <> 'paid' FOR UPDATE", [id]);
        if (!due.length) return { count: 0, amount: 0 };
        const amount = due.reduce((s, x) => s + Number(x.commission_amount), 0);
        await q(`UPDATE instructor_commissions SET status = 'paid', paid_at = NOW(), payout_reference = ? WHERE id IN (${due.map(() => "?").join(",")})`,
          [payRef, ...due.map((x) => x.id)]);
        return { count: due.length, amount: Math.round(amount * 100) / 100 };
      });
      if (!r.count) { results.push({ instructor_id: id, amount: 0, count: 0, skipped: "nothing_due" }); continue; }
      results.push({ instructor_id: id, ...r });
      void notifyUser(id, {
        type: "success",
        fr: { title: "Versement enregistré", body: `Un versement de ${r.amount} XAF a été enregistré (réf. ${payRef}).` },
        en: { title: "Payout recorded", body: `A payout of ${r.amount} XAF has been recorded (ref. ${payRef}).` },
        link: "/instructor/earnings",
        email: { ctaFr: "Voir mes gains", ctaEn: "View my earnings" },
      });
      await logAudit(req, "commission", "instructor.payout", "user", id, null, { reference: payRef, ...r, batch: reference });
    }
    const paid = results.filter((r) => !r.skipped);
    const total = paid.reduce((s, r) => s + r.amount, 0);
    if (paid.length) {
      await query("INSERT INTO instructor_payout_batches (reference, created_by, instructors_count, total_amount) VALUES (?, ?, ?, ?)",
        [reference, req.user!.id, paid.length, total]);
    }
    return res.json({ success: true, data: { results, paid_count: paid.length, total } });
  } catch (e) { return serverError(req, res, "adminPayoutBatch", e); }
};

// ══════════════════════════════════════════════════════
// RELEVÉS (CSV / JSON)
// ══════════════════════════════════════════════════════
const csvCell = (v: any) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : String(v);
  // neutralise l'injection de formules dans Excel / LibreOffice
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

async function buildStatement(instructorId: number, q: any) {
  const where: string[] = ["ic.instructor_id = ?"];
  const params: any[] = [instructorId];
  const from = String(q.from ?? ""), to = String(q.to ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push("DATE(COALESCE(ic.earned_at, ic.created_at)) >= ?"); params.push(from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push("DATE(COALESCE(ic.earned_at, ic.created_at)) <= ?"); params.push(to); }
  if (["earned", "paid", "pending"].includes(String(q.status))) { where.push("ic.status = ?"); params.push(q.status); }
  const rows: any[] = await query(
    `SELECT ic.id, COALESCE(ic.earned_at, ic.created_at) AS date, c.title AS course, ic.sale_amount, ic.commission_rate,
            ic.commission_amount, ic.status, ic.paid_at, ic.payout_reference
       FROM instructor_commissions ic JOIN courses c ON c.id = ic.course_id
      WHERE ${where.join(" AND ")} ORDER BY date DESC LIMIT 5000`, params);
  const total = rows.reduce((s, r) => s + Number(r.commission_amount), 0);
  const paid = rows.filter((r) => r.status === "paid").reduce((s, r) => s + Number(r.commission_amount), 0);
  return { rows, total: Math.round(total * 100) / 100, paid: Math.round(paid * 100) / 100, due: Math.round((total - paid) * 100) / 100 };
}

async function sendStatement(req: Req, res: Response, instructorId: number) {
  const st = await buildStatement(instructorId, req.query);
  if (String(req.query.format) === "csv") {
    const en = langFromReq(req) === "en";
    const head = en
      ? ["Date", "Course", "Sale amount (XAF)", "Rate (%)", "Commission (XAF)", "Status", "Paid on", "Payout reference"]
      : ["Date", "Cours", "Montant de la vente (XAF)", "Taux (%)", "Commission (XAF)", "Statut", "Versé le", "Référence de versement"];
    const lines = [head.map(csvCell).join(",")];
    for (const r of st.rows) {
      lines.push([r.date, r.course, r.sale_amount, r.commission_rate, r.commission_amount, r.status, r.paid_at, r.payout_reference].map(csvCell).join(","));
    }
    lines.push("");
    lines.push([en ? "Total" : "Total", "", "", "", st.total].map(csvCell).join(","));
    lines.push([en ? "Paid" : "Versé", "", "", "", st.paid].map(csvCell).join(","));
    lines.push([en ? "Due" : "Reste dû", "", "", "", st.due].map(csvCell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="statement-${instructorId}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send("﻿" + lines.join("\r\n"));
  }
  return res.json({ success: true, data: plain(st) });
}

// GET /statement (instructeur)  ?from&to&status&format=csv
export const getMyStatement = async (req: Req, res: Response) => {
  try { await ensureProgramTables(); return await sendStatement(req, res, req.user!.id); }
  catch (e) { return serverError(req, res, "getMyStatement", e); }
};
// GET /admin/instructors/:id/statement
export const adminStatement = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");
    return await sendStatement(req, res, id);
  } catch (e) { return serverError(req, res, "adminStatement", e); }
};

// ══════════════════════════════════════════════════════
// PALIERS (rôles d'instructeur)
// ══════════════════════════════════════════════════════
const rate = (v: any): number | null => {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null;
};

// GET /admin/tiers
export const adminListTiers = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const rows: any[] = await query(
      `SELECT t.*, (SELECT COUNT(*) FROM instructor_tier_assignments a WHERE a.tier_id = t.id) AS members
         FROM instructor_tiers t ORDER BY t.sort_order, t.id`);
    return res.json({ success: true, data: plain(rows.map((r) => ({ ...r, is_active: !!Number(r.is_active) }))), default_rate: defaultCommissionRate() });
  } catch (e) { return serverError(req, res, "adminListTiers", e); }
};

const tierPayload = (req: Req) => {
  const b = req.body || {};
  const name_fr = String(b.name_fr ?? "").trim().slice(0, 80);
  const name_en = String(b.name_en ?? "").trim().slice(0, 80) || name_fr;
  const r = rate(b.default_commission_rate);
  return { name_fr, name_en, r, description: String(b.description ?? "").trim().slice(0, 300) || null, is_active: b.is_active === false ? 0 : 1 };
};

// POST /admin/tiers
export const adminCreateTier = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const p = tierPayload(req);
    if (p.name_fr.length < 2 || p.r === null) return fail(req, res, 400, "Nom et taux (0–100 %) requis.", "Name and rate (0–100%) are required.");
    const slug = p.name_fr.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `tier-${Date.now()}`;
    const [dup]: any = await query("SELECT id FROM instructor_tiers WHERE slug = ?", [slug]);
    if (dup) return fail(req, res, 409, "Un palier de ce nom existe déjà.", "A tier with this name already exists.");
    const [{ m }]: any = await query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM instructor_tiers");
    const r: any = await query(
      "INSERT INTO instructor_tiers (slug, name_fr, name_en, description, default_commission_rate, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [slug, p.name_fr, p.name_en, p.description, p.r, num(m) + 1, p.is_active]);
    await logAudit(req, "admin", "instructor.tier_created", "user", null, null, { id: Number(r.insertId), name: p.name_fr, rate: p.r });
    return res.status(201).json({ success: true, data: { id: Number(r.insertId) } });
  } catch (e) { return serverError(req, res, "adminCreateTier", e); }
};

// PATCH /admin/tiers/:id
export const adminUpdateTier = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [t]: any = id ? await query("SELECT * FROM instructor_tiers WHERE id = ?", [id]) : [];
    if (!t) return fail(req, res, 404, "Palier introuvable", "Tier not found");
    const p = tierPayload(req);
    if (p.name_fr.length < 2 || p.r === null) return fail(req, res, 400, "Nom et taux (0–100 %) requis.", "Name and rate (0–100%) are required.");
    await query("UPDATE instructor_tiers SET name_fr = ?, name_en = ?, description = ?, default_commission_rate = ?, is_active = ? WHERE id = ?",
      [p.name_fr, p.name_en, p.description, p.r, p.is_active, id]);
    await logAudit(req, "admin", "instructor.tier_updated", "user", null, { rate: num(t.default_commission_rate) }, { id, name: p.name_fr, rate: p.r });
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "adminUpdateTier", e); }
};

// DELETE /admin/tiers/:id — refusé si des instructeurs y sont rattachés
export const adminDeleteTier = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [{ n }]: any = await query("SELECT COUNT(*) AS n FROM instructor_tier_assignments WHERE tier_id = ?", [id]);
    if (num(n) > 0) return fail(req, res, 409, "Des instructeurs sont rattachés à ce palier. Désactivez-le plutôt.", "Instructors are assigned to this tier. Deactivate it instead.");
    await query("DELETE FROM instructor_tiers WHERE id = ?", [id]);
    await logAudit(req, "admin", "instructor.tier_deleted", "user", null, { id }, null);
    return res.json({ success: true });
  } catch (e) { return serverError(req, res, "adminDeleteTier", e); }
};

// GET /admin/instructors/:id/tier
export const adminGetInstructorTier = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [a]: any = id ? await query(
      `SELECT t.id, t.slug, t.name_fr, t.name_en, t.default_commission_rate, a.assigned_at
         FROM instructor_tier_assignments a JOIN instructor_tiers t ON t.id = a.tier_id WHERE a.user_id = ?`, [id]) : [];
    return res.json({ success: true, data: a ? plain(a) : null });
  } catch (e) { return serverError(req, res, "adminGetInstructorTier", e); }
};

// PUT /admin/instructors/:id/tier { tier_id | null, apply_to_courses: 'none' | 'default_only' | 'all' }
export const adminAssignTier = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const id = parseId(req.params.id);
    const [user]: any = id ? await query("SELECT id FROM users WHERE id = ? AND role = 'instructor'", [id]) : [];
    if (!user) return fail(req, res, 404, "Instructeur introuvable", "Instructor not found");

    const tierId = req.body?.tier_id === null ? null : parseId(req.body?.tier_id);
    let tier: any = null;
    if (tierId) {
      [tier] = await query("SELECT * FROM instructor_tiers WHERE id = ? AND is_active = 1", [tierId]);
      if (!tier) return fail(req, res, 404, "Palier introuvable ou inactif", "Tier not found or inactive");
    }
    if (!tierId) {
      await query("DELETE FROM instructor_tier_assignments WHERE user_id = ?", [id]);
      await logAudit(req, "admin", "instructor.tier_assigned", "user", id, null, { tier: null });
      return res.json({ success: true, data: { updated_courses: 0, skipped_courses: 0 } });
    }

    await query(
      `INSERT INTO instructor_tier_assignments (user_id, tier_id, assigned_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE tier_id = VALUES(tier_id), assigned_by = VALUES(assigned_by), assigned_at = NOW()`,
      [id, tierId, req.user!.id]);

    // Application du taux aux cours existants (en respectant la part déjà attribuée aux co-instructeurs)
    const mode = ["default_only", "all"].includes(req.body?.apply_to_courses) ? req.body.apply_to_courses : "none";
    let updated = 0, skipped = 0;
    if (mode !== "none") {
      const newRate = num(tier.default_commission_rate);
      const courses: any[] = await query(
        `SELECT c.id, c.instructor_commission_rate,
                (SELECT COALESCE(SUM(commission_rate), 0) FROM course_instructors ci WHERE ci.course_id = c.id AND ci.status = 'accepted') AS co_share
           FROM courses c WHERE c.instructor_id = ?`, [id]);
      for (const c of courses) {
        if (mode === "default_only" && c.instructor_commission_rate !== null) continue;
        if (newRate < num(c.co_share)) { skipped++; continue; }
        await query("UPDATE courses SET instructor_commission_rate = ?, updated_at = NOW() WHERE id = ?", [newRate, c.id]);
        updated++;
      }
    }
    await logAudit(req, "commission", "instructor.tier_assigned", "user", id, null, { tier: tier.slug, rate: num(tier.default_commission_rate), apply: mode, updated, skipped });
    void notifyUser(id!, {
      type: "info",
      fr: { title: `Votre palier : ${tier.name_fr}`, body: `Votre taux de commission par défaut est désormais de ${num(tier.default_commission_rate)} %.` },
      en: { title: `Your tier: ${tier.name_en}`, body: `Your default commission rate is now ${num(tier.default_commission_rate)}%.` },
      link: "/instructor/earnings",
    });
    return res.json({ success: true, data: { updated_courses: updated, skipped_courses: skipped } });
  } catch (e) { return serverError(req, res, "adminAssignTier", e); }
};

// GET /tier/me (instructeur)
export const getMyTier = async (req: Req, res: Response) => {
  try {
    await ensureProgramTables();
    const [a]: any = await query(
      `SELECT t.name_fr, t.name_en, t.default_commission_rate FROM instructor_tier_assignments a
         JOIN instructor_tiers t ON t.id = a.tier_id WHERE a.user_id = ?`, [req.user!.id]);
    return res.json({ success: true, data: a ? plain(a) : null });
  } catch (e) { return serverError(req, res, "getMyTier", e); }
};

export { ACTIVE_INSTRUCTOR_SQL };
