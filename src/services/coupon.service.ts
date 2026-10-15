// src/services/coupon.service.ts
// Codes promo : validation, réservation à l'inscription, libération en cas de rejet / suppression.
// La table `coupons` existait déjà mais n'était utilisée nulle part.
import { query } from "../config/database";

export type CouponError =
  | "NOT_FOUND" | "INACTIVE" | "NOT_STARTED" | "EXPIRED" | "EXHAUSTED" | "USER_LIMIT"
  | "NOT_APPLICABLE" | "MIN_AMOUNT" | "FREE_COURSE" | "PROMO_ACTIVE";

export interface CouponCheck {
  ok: boolean;
  error?: CouponError;
  coupon?: any;
  base: number;
  discount: number;
  final: number;
}

export const normalizeCode = (v: unknown): string => String(v ?? "").trim().toUpperCase().replace(/\s+/g, "").slice(0, 50);

const parseIds = (v: any): number[] => {
  try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number) : []; } catch { return []; }
};

/** Montant de la réduction pour un prix donné. */
export const discountFor = (coupon: any, price: number): number => {
  const raw = coupon.discount_type === "fixed" ? Number(coupon.discount_value) : (price * Number(coupon.discount_value)) / 100;
  return Math.min(Math.max(Math.round(raw), 0), price);
};

export async function checkCoupon(rawCode: unknown, userId: number, courseId: number): Promise<CouponCheck> {
  const code = normalizeCode(rawCode);
  const [course]: any = await query("SELECT id, price, is_free, category_id FROM courses WHERE id = ? AND is_published = 1", [courseId]);
  if (!course) return { ok: false, error: "NOT_FOUND", base: 0, discount: 0, final: 0 };
  const base = Number(course.price) || 0;
  const fail = (error: CouponError): CouponCheck => ({ ok: false, error, base, discount: 0, final: base });
  if (Number(course.is_free) === 1 || base <= 0) return fail("FREE_COURSE");

  const [c]: any = await query("SELECT * FROM coupons WHERE UPPER(code) = ? LIMIT 1", [code]);
  if (!c) return fail("NOT_FOUND");
  if (!Number(c.is_active)) return fail("INACTIVE");
  const now = Date.now();
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return fail("NOT_STARTED");
  if (c.expires_at && new Date(c.expires_at).getTime() <= now) return fail("EXPIRED");
  if (c.max_uses !== null && c.max_uses !== undefined && Number(c.uses_count) >= Number(c.max_uses)) return fail("EXHAUSTED");

  const [{ n }]: any = await query("SELECT COUNT(*) AS n FROM coupon_usages WHERE coupon_id = ? AND user_id = ?", [c.id, userId]);
  if (Number(n) >= Number(c.max_uses_per_user || 1)) return fail("USER_LIMIT");

  if (c.applicable_to === "specific_courses" && !parseIds(c.course_ids).includes(Number(course.id))) return fail("NOT_APPLICABLE");
  if (c.applicable_to === "specific_categories" && !parseIds(c.category_ids).includes(Number(course.category_id))) return fail("NOT_APPLICABLE");
  if (Number(c.minimum_amount) > base) return fail("MIN_AMOUNT");

  // pas de cumul avec une promotion de prix en cours (évite les remises excessives)
  try {
    // (une promotion « active » dont le prix du cours n'a pas réellement changé est un reste obsolète : ignorée)
    const [promo]: any = await query(
      `SELECT p.id FROM marketing_promotions p JOIN courses c ON c.id = p.course_id
        WHERE p.course_id = ? AND p.status = 'active'
          AND (c.price <> p.regular_price OR c.is_free <> p.regular_is_free) LIMIT 1`, [courseId]);
    if (promo) return fail("PROMO_ACTIVE");
  } catch { /* table marketing absente : pas de promotion */ }

  const discount = discountFor(c, base);
  return { ok: true, coupon: c, base, discount, final: Math.max(base - discount, 0) };
}

/** Réserve une utilisation (atomique). Renvoie false si le plafond vient d'être atteint. */
export async function reserveCoupon(couponId: number, userId: number, discount: number): Promise<boolean> {
  const r: any = await query("UPDATE coupons SET uses_count = uses_count + 1 WHERE id = ? AND (max_uses IS NULL OR uses_count < max_uses)", [couponId]);
  if (!Number(r?.affectedRows)) return false;
  await query("INSERT INTO coupon_usages (coupon_id, user_id, payment_id, discount_applied) VALUES (?, ?, NULL, ?)", [couponId, userId, discount]);
  return true;
}

/** Libère le code d'une inscription rejetée ou supprimée (idempotent, ne lève jamais). */
export async function releaseCouponForEnrollment(enrollmentId: number): Promise<void> {
  try {
    const [e]: any = await query("SELECT coupon_id, user_id FROM course_enrollments WHERE id = ?", [enrollmentId]);
    if (!e?.coupon_id) return;
    await query("DELETE FROM coupon_usages WHERE coupon_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1", [e.coupon_id, e.user_id]);
    await query("UPDATE coupons SET uses_count = GREATEST(uses_count - 1, 0) WHERE id = ?", [e.coupon_id]);
    await query("UPDATE course_enrollments SET coupon_id = NULL WHERE id = ?", [enrollmentId]);
  } catch (err: any) {
    console.warn("releaseCouponForEnrollment:", err?.message || err);
  }
}

/** Prix à payer pour une inscription (réduction du code appliquée si présent). */
export async function amountDueForEnrollment(enrollmentId: number): Promise<number | null> {
  const [e]: any = await query(
    `SELECT c.price, cp.discount_type, cp.discount_value FROM course_enrollments ce
       JOIN courses c ON c.id = ce.course_id LEFT JOIN coupons cp ON cp.id = ce.coupon_id WHERE ce.id = ?`, [enrollmentId]);
  if (!e) return null;
  const price = Number(e.price) || 0;
  return e.discount_type ? Math.max(price - discountFor(e, price), 0) : price;
}
