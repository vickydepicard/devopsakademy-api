// src/controllers/subscriptionController.ts
// Abonnements : plans, souscription (en attente), annulation, historique + validation admin.
import { Response } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { query, withTransaction } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { tr, getUserLang } from "../utils/lang";
import { toPlain, parseJson, parseId } from "../utils/serialize";
import { fail, serverError, logAudit } from "../utils/respond";
import { publicBaseUrl, isSafeMediaUrl } from "../utils/publicUrl";
import { createNotification, notifyAdmins } from "../services/notification.service";

type Req = AuthenticatedRequest;

// ── Schéma : 'pending' + dates nulles tant que l'abonnement n'est pas validé (idempotent) ──
let schemaReady: Promise<void> | null = null;
export const ensureSubscriptionSchema = (): Promise<void> => {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(
        `ALTER TABLE subscriptions
           MODIFY status ENUM('pending','active','cancelled','expired','suspended') NOT NULL DEFAULT 'active',
           MODIFY starts_at DATETIME NULL,
           MODIFY ends_at DATETIME NULL`
      );
      const [{ n }]: any = await query("SELECT COUNT(*) AS n FROM subscription_plans");
      if (Number(n) === 0) {
        await query(
          `INSERT IGNORE INTO subscription_plans (name, slug, description, price_monthly, price_annual, features, is_active) VALUES
           ('Pro',   'pro',   'Accès illimité aux cours premium', 9900.00,  89000.00,  '["Cours premium illimités","Labs interactifs","Certificats de complétion"]', 1),
           ('Elite', 'elite', 'Tout Pro + accompagnement',        19900.00, 179000.00, '["Tout du plan Pro","Support prioritaire","Téléchargement des ressources"]', 1)`
        );
      }
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
};

const absUrl = (req: Req, v: any): string | null => {
  if (!v) return null;
  const s = String(v);
  return s.startsWith("/uploads/") ? `${publicBaseUrl(req)}${s}` : s;
};

/** Ramène une URL (absolue de cette API ou relative) à un chemin /uploads/… stockable ; null si refusée. */
const normalizeProofUrl = (raw: unknown): string | null => {
  const s = String(raw ?? "").trim().slice(0, 500);
  if (!s) return null;
  if (!isSafeMediaUrl(s)) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.pathname.startsWith("/uploads/")) return u.pathname;
    } catch { return null; }
  }
  return s;
};

const cycleOf = (v: unknown): "monthly" | "annual" => (String(v) === "yearly" || String(v) === "annual" ? "annual" : "monthly");
const periodOf = (c: string) => (c === "annual" ? "yearly" : "monthly");
const paymentStatusOut = (s: string) => (s === "validated" ? "verified" : s === "rejected" ? "rejected" : "pending");

/** Passe en 'expired' les abonnements dont la date de fin est dépassée. */
const expireSubscriptions = () =>
  query("UPDATE subscriptions SET status = 'expired' WHERE status IN ('active','cancelled') AND ends_at IS NOT NULL AND ends_at < NOW()");

const SUB_SELECT = `
  SELECT s.id, s.user_id, s.plan_id, s.billing_cycle, s.payment_id, s.status, s.starts_at, s.ends_at,
         s.cancelled_at, s.cancel_reason, s.auto_renew, s.created_at,
         sp.name AS plan_name, sp.slug AS plan_slug,
         p.amount AS paid_amount, p.proof_url AS payment_proof_url, p.status AS payment_status,
         IF(s.billing_cycle = 'annual', COALESCE(sp.price_annual, sp.price_monthly * 12), sp.price_monthly) AS plan_price
    FROM subscriptions s
    JOIN subscription_plans sp ON sp.id = s.plan_id
    LEFT JOIN payments p ON p.id = s.payment_id`;

const shape = (req: Req, r: any) => ({
  id: r.id,
  user_id: r.user_id,
  plan_id: r.plan_id,
  plan_name: r.plan_name,
  plan_slug: r.plan_slug,
  status: r.status,
  billing_period: periodOf(r.billing_cycle),
  billing_cycle: r.billing_cycle,
  amount: Number(r.paid_amount ?? r.plan_price ?? 0),
  start_date: r.starts_at,
  end_date: r.ends_at,
  starts_at: r.starts_at,
  ends_at: r.ends_at,
  auto_renew: Number(r.auto_renew) === 1,
  cancelled_at: r.cancelled_at,
  cancel_reason: r.cancel_reason,
  payment_id: r.payment_id,
  payment_status: r.payment_status ? paymentStatusOut(r.payment_status) : null,
  payment_proof_url: absUrl(req, r.payment_proof_url),
  created_at: r.created_at,
  ...(r.first_name !== undefined ? { first_name: r.first_name, last_name: r.last_name, email: r.email } : {}),
});

// ═══════════ Étudiant ═══════════

// GET /api/subscriptions/plans   (public)
export const listPlans = async (req: Req, res: Response) => {
  try {
    await ensureSubscriptionSchema();
    const rows = toPlain<any[]>(await query(
      "SELECT id, name, slug, description, price_monthly, price_annual, features FROM subscription_plans WHERE is_active = 1 ORDER BY price_monthly ASC"
    ));
    return res.json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        price_monthly: Number(r.price_monthly),
        price_annual: r.price_annual === null ? null : Number(r.price_annual),
        features: parseJson<any[]>(r.features, []),
      })),
    });
  } catch (e) { return serverError(req, res, "listPlans", e); }
};

// GET /api/subscriptions/my  → abonnement en cours (en attente, actif, ou annulé mais encore valide) ou null
export const mySubscription = async (req: Req, res: Response) => {
  try {
    await ensureSubscriptionSchema();
    await expireSubscriptions();
    const [row] = toPlain<any[]>(await query(
      `${SUB_SELECT}
        WHERE s.user_id = ? AND (s.status IN ('pending','active') OR (s.status = 'cancelled' AND s.ends_at > NOW()))
        ORDER BY FIELD(s.status, 'active', 'cancelled', 'pending'), s.created_at DESC, s.id DESC
        LIMIT 1`,
      [req.user!.id]
    ));
    return res.json({ success: true, data: row ? shape(req, row) : null });
  } catch (e) { return serverError(req, res, "mySubscription", e); }
};

// GET /api/subscriptions/history  → paiements d'abonnement de l'utilisateur
export const myHistory = async (req: Req, res: Response) => {
  try {
    await ensureSubscriptionSchema();
    const rows = toPlain<any[]>(await query(
      `SELECT p.id, p.amount, p.currency, p.status, p.proof_url, p.admin_note, p.created_at,
              sp.name AS plan_name, sp.slug AS plan_slug, s.id AS subscription_id, s.billing_cycle
         FROM payments p
         LEFT JOIN subscription_plans sp ON sp.id = p.subscription_plan_id
         LEFT JOIN subscriptions s ON s.payment_id = p.id
        WHERE p.user_id = ? AND p.subscription_plan_id IS NOT NULL
        ORDER BY p.created_at DESC, p.id DESC`,
      [req.user!.id]
    ));
    return res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        subscription_id: r.subscription_id,
        plan_name: r.plan_name,
        plan_slug: r.plan_slug,
        billing_period: periodOf(r.billing_cycle || "monthly"),
        amount: Number(r.amount),
        currency: r.currency,
        status: paymentStatusOut(r.status),
        admin_note: r.admin_note,
        payment_proof_url: absUrl(req, r.proof_url),
        created_at: r.created_at,
      })),
    });
  } catch (e) { return serverError(req, res, "myHistory", e); }
};

// POST /api/subscriptions/subscribe  { plan_slug, billing_period: monthly|yearly, payment_proof_url?, payment_method?, reference? }
export const subscribe = async (req: Req, res: Response) => {
  try {
    await ensureSubscriptionSchema();
    await expireSubscriptions();
    const uid = req.user!.id;
    const slug = String(req.body?.plan_slug ?? "").trim();
    const cycle = cycleOf(req.body?.billing_period ?? req.body?.billing_cycle);
    if (!slug) return fail(req, res, 400, "Plan requis", "Plan is required");

    const [plan]: any = await query("SELECT * FROM subscription_plans WHERE slug = ? AND is_active = 1", [slug]);
    if (!plan) return fail(req, res, 404, "Plan introuvable", "Plan not found");
    const price = cycle === "annual" ? plan.price_annual : plan.price_monthly;
    if (price === null || price === undefined) {
      return fail(req, res, 400, "Cette périodicité n'est pas disponible pour ce plan", "This billing period is not available for this plan");
    }

    let proof: string | null = null;
    if (req.body?.payment_proof_url) {
      proof = normalizeProofUrl(req.body.payment_proof_url);
      if (!proof) return fail(req, res, 400, "URL de preuve de paiement invalide", "Invalid payment proof URL");
    }

    const [pending]: any = await query("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'pending' LIMIT 1", [uid]);
    if (pending) {
      return fail(req, res, 409, "Une souscription est déjà en attente de validation", "A subscription is already awaiting validation");
    }
    const [active]: any = await query(
      "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' AND plan_id = ? AND billing_cycle = ? AND ends_at > NOW() LIMIT 1",
      [uid, plan.id, cycle]
    );
    if (active) {
      return fail(req, res, 409, "Vous avez déjà ce plan actif", "You already have this plan active");
    }

    const method = String(req.body?.payment_method ?? "manual").trim().slice(0, 80) || "manual";
    const reference = req.body?.reference ? String(req.body.reference).trim().slice(0, 150) : null;

    const created = await withTransaction(async (q) => {
      const pay: any = await q(
        `INSERT INTO payments (user_id, subscription_plan_id, amount, currency, payment_method, reference, proof_url, status)
         VALUES (?, ?, ?, 'XAF', ?, ?, ?, 'pending')`,
        [uid, plan.id, price, method, reference, proof]
      );
      const sub: any = await q(
        `INSERT INTO subscriptions (user_id, plan_id, billing_cycle, payment_id, status, auto_renew)
         VALUES (?, ?, ?, ?, 'pending', 0)`,
        [uid, plan.id, cycle, Number(pay.insertId)]
      );
      return { subscription_id: Number(sub.insertId), payment_id: Number(pay.insertId) };
    });

    void (async () => {
      await notifyAdmins({
        type: "payment_proof",
        title: `Nouvelle souscription ${plan.name}`,
        message: `${req.user!.first_name || ""} ${req.user!.last_name || ""} (${req.user!.email || ""}) — ${cycle === "annual" ? "annuel" : "mensuel"}`.trim(),
        link: "/admin/subscriptions?filter=pending",
      }, { email: false });
    })().catch(() => {});

    return res.status(201).json({
      success: true,
      message: tr(req, "Souscription enregistrée, en attente de validation", "Subscription recorded, awaiting validation"),
      data: { ...created, status: "pending", plan_slug: plan.slug, billing_period: periodOf(cycle), amount: Number(price) },
    });
  } catch (e) { return serverError(req, res, "subscribe", e); }
};

// POST /api/subscriptions/:id/cancel   { reason? }
export const cancelSubscription = async (req: Req, res: Response) => {
  try {
    await ensureSubscriptionSchema();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 400, "Identifiant invalide", "Invalid id");
    const [sub]: any = await query("SELECT * FROM subscriptions WHERE id = ?", [id]);
    if (!sub || Number(sub.user_id) !== req.user!.id) {
      return fail(req, res, 404, "Abonnement introuvable", "Subscription not found");
    }
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 1000) : null;

    if (sub.status === "pending") {
      await withTransaction(async (q) => {
        await q("UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = ?, auto_renew = 0 WHERE id = ?", [reason || "cancelled_by_user", id]);
        if (sub.payment_id) {
          await q("UPDATE payments SET status = 'rejected', admin_note = 'Annulé par l''utilisateur', reviewed_at = NOW() WHERE id = ? AND status = 'pending'", [sub.payment_id]);
        }
      });
      return res.json({ success: true, message: tr(req, "Souscription annulée", "Subscription cancelled"), data: { id, status: "cancelled", end_date: null } });
    }
    if (sub.status !== "active") {
      return fail(req, res, 409, "Cet abonnement ne peut pas être annulé", "This subscription cannot be cancelled");
    }
    // L'accès est conservé jusqu'à ends_at ; plus de renouvellement.
    await query("UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?", [reason, id]);
    const [after] = toPlain<any[]>(await query("SELECT ends_at FROM subscriptions WHERE id = ?", [id]));
    return res.json({
      success: true,
      message: tr(req, "Abonnement annulé : l'accès reste actif jusqu'à la date de fin", "Subscription cancelled: access remains until the end date"),
      data: { id, status: "cancelled", auto_renew: false, end_date: after.ends_at, ends_at: after.ends_at },
    });
  } catch (e) { return serverError(req, res, "cancelSubscription", e); }
};

// ═══════════ Upload de preuve de paiement ═══════════
const proofDir = path.join(process.cwd(), "uploads", "payments");
const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try { fs.mkdirSync(proofDir, { recursive: true }); } catch { /* ignoré */ }
      cb(null, proofDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".jpg";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("INVALID_PROOF_TYPE"));
  },
}).single("proof");

// POST /api/payments/upload-proof  (multipart, champ "proof")
export const uploadProof = (req: Req, res: Response) => {
  proofUpload(req as any, res as any, (err: any) => {
    if (err) {
      if (err.message === "INVALID_PROOF_TYPE") return fail(req, res, 400, "Format non supporté. Utilisez JPG, PNG, WEBP ou PDF.", "Unsupported format. Use JPG, PNG, WEBP or PDF.");
      if (err.code === "LIMIT_FILE_SIZE") return fail(req, res, 413, "Fichier trop volumineux (10 Mo max)", "File too large (10 MB max)");
      return serverError(req, res, "uploadProof", err);
    }
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return fail(req, res, 400, "Aucun fichier reçu (champ « proof »)", "No file received (field \"proof\")");
    const rel = `/uploads/payments/${file.filename}`;
    return res.status(201).json({
      success: true,
      message: tr(req, "Preuve téléversée", "Proof uploaded"),
      data: { url: `${publicBaseUrl(req)}${rel}`, path: rel, filename: file.filename, size: file.size },
    });
  });
};

// ═══════════ Admin ═══════════

// GET /api/admin/subscriptions?status=
export const adminListSubscriptions = async (req: Req, res: Response) => {
  try {
    await ensureSubscriptionSchema();
    await expireSubscriptions();
    const status = String(req.query.status || "");
    const params: any[] = [];
    let where = "";
    if (["pending", "active", "cancelled", "expired", "suspended"].includes(status)) { where = "WHERE s.status = ?"; params.push(status); }
    const rows = toPlain<any[]>(await query(
      `SELECT s.id, s.user_id, s.plan_id, s.billing_cycle, s.payment_id, s.status, s.starts_at, s.ends_at,
              s.cancelled_at, s.cancel_reason, s.auto_renew, s.created_at,
              sp.name AS plan_name, sp.slug AS plan_slug,
              p.amount AS paid_amount, p.proof_url AS payment_proof_url, p.status AS payment_status,
              IF(s.billing_cycle = 'annual', COALESCE(sp.price_annual, sp.price_monthly * 12), sp.price_monthly) AS plan_price,
              u.first_name, u.last_name, u.email
         FROM subscriptions s
         JOIN subscription_plans sp ON sp.id = s.plan_id
         JOIN users u ON u.id = s.user_id
         LEFT JOIN payments p ON p.id = s.payment_id
         ${where}
        ORDER BY (s.status = 'pending') DESC, s.created_at DESC, s.id DESC
        LIMIT 1000`,
      params
    ));
    return res.json({ success: true, data: rows.map((r) => shape(req, r)) });
  } catch (e) { return serverError(req, res, "adminListSubscriptions", e); }
};

// PATCH /api/admin/subscriptions/:id/activate
export const adminActivate = async (req: Req, res: Response) => {
  try {
    await ensureSubscriptionSchema();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 400, "Identifiant invalide", "Invalid id");
    const [sub]: any = await query(
      "SELECT s.*, sp.name AS plan_name FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.id = ?", [id]
    );
    if (!sub) return fail(req, res, 404, "Abonnement introuvable", "Subscription not found");
    if (sub.status !== "pending") return fail(req, res, 409, "Seul un abonnement en attente peut être validé", "Only a pending subscription can be validated");

    const interval = sub.billing_cycle === "annual" ? "INTERVAL 1 YEAR" : "INTERVAL 1 MONTH";
    await withTransaction(async (q) => {
      // Remplace l'éventuel abonnement actif précédent (changement de plan)
      await q(
        `UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, cancelled_at = NOW(), cancel_reason = 'replaced', ends_at = NOW()
          WHERE user_id = ? AND status = 'active' AND id <> ?`,
        [sub.user_id, id]
      );
      await q(
        `UPDATE subscriptions SET status = 'active', starts_at = NOW(), ends_at = DATE_ADD(NOW(), ${interval}), auto_renew = 1,
                cancelled_at = NULL, cancel_reason = NULL WHERE id = ?`,
        [id]
      );
      if (sub.payment_id) {
        await q("UPDATE payments SET status = 'validated', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [req.user!.id, sub.payment_id]);
      }
    });
    const [after] = toPlain<any[]>(await query("SELECT starts_at, ends_at FROM subscriptions WHERE id = ?", [id]));
    await logAudit(req, "subscription", "subscription.activated", "subscription", id, { status: "pending" }, { status: "active", ...after, user_id: Number(sub.user_id) });

    void (async () => {
      const en = (await getUserLang(Number(sub.user_id))) === "en";
      await createNotification(Number(sub.user_id), {
        type: "success",
        title: en ? `Your ${sub.plan_name} subscription is active` : `Votre abonnement ${sub.plan_name} est activé`,
        message: en ? "Your payment has been verified. Enjoy your premium access!" : "Votre paiement a été vérifié. Profitez de votre accès premium !",
        link: "/subscriptions",
      });
    })().catch(() => {});

    return res.json({
      success: true,
      message: tr(req, "Abonnement activé", "Subscription activated"),
      data: { id, status: "active", start_date: after.starts_at, end_date: after.ends_at },
    });
  } catch (e) { return serverError(req, res, "adminActivate", e); }
};

// PATCH /api/admin/subscriptions/:id/reject   { reason }
export const adminReject = async (req: Req, res: Response) => {
  try {
    await ensureSubscriptionSchema();
    const id = parseId(req.params.id);
    if (!id) return fail(req, res, 400, "Identifiant invalide", "Invalid id");
    const reason = String(req.body?.reason ?? "").trim().slice(0, 1000);
    const [sub]: any = await query(
      "SELECT s.*, sp.name AS plan_name FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.id = ?", [id]
    );
    if (!sub) return fail(req, res, 404, "Abonnement introuvable", "Subscription not found");
    if (sub.status !== "pending") return fail(req, res, 409, "Seul un abonnement en attente peut être rejeté", "Only a pending subscription can be rejected");

    await withTransaction(async (q) => {
      await q("UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?", [reason || "rejected", id]);
      if (sub.payment_id) {
        await q("UPDATE payments SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [reason || null, req.user!.id, sub.payment_id]);
      }
    });
    await logAudit(req, "subscription", "subscription.rejected", "subscription", id, { status: "pending" }, { status: "cancelled", reason: reason || null, user_id: Number(sub.user_id) });

    void (async () => {
      const en = (await getUserLang(Number(sub.user_id))) === "en";
      await createNotification(Number(sub.user_id), {
        type: "warning",
        title: en ? `Your ${sub.plan_name} subscription was declined` : `Votre souscription ${sub.plan_name} a été refusée`,
        message: reason || (en ? "Your payment could not be verified." : "Votre paiement n'a pas pu être vérifié."),
        link: "/subscriptions",
      });
    })().catch(() => {});

    return res.json({ success: true, message: tr(req, "Abonnement rejeté", "Subscription rejected"), data: { id, status: "cancelled", reason: reason || null } });
  } catch (e) { return serverError(req, res, "adminReject", e); }
};
