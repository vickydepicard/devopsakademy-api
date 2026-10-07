// src/services/commission.service.ts
// Jusqu'ici la table instructor_commissions n'était jamais alimentée : les gains
// affichés aux instructeurs valaient toujours 0. Une commission est maintenant créée
// quand une inscription payante est validée par l'admin (idempotent).
//
// Règle de partage (modifiable) :
//  - taux du cours = courses.instructor_commission_rate, sinon DEFAULT_INSTRUCTOR_COMMISSION_RATE (70 %)
//  - chaque co-instructeur accepté reçoit son course_instructors.commission_rate % de la vente
//  - le propriétaire reçoit le reste du taux du cours
import { query } from "../config/database";

export const defaultCommissionRate = (): number => {
  const v = Number(process.env.DEFAULT_INSTRUCTOR_COMMISSION_RATE);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 70;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function recordCommissionsForEnrollment(enrollmentId: number): Promise<void> {
  try {
    const [row]: any = await query(
      `SELECT ce.id, ce.user_id, ce.course_id, ce.payment_status,
              c.price, c.is_free, c.instructor_id, c.instructor_commission_rate
         FROM course_enrollments ce
         JOIN courses c ON c.id = ce.course_id
        WHERE ce.id = ?`,
      [enrollmentId]
    );
    if (!row || row.payment_status !== "verified" || row.is_free) return;

    // Paiement associé (créé quand l'étudiant envoie sa preuve) — sinon on en crée un.
    let [payment]: any = await query(
      "SELECT id, amount, status FROM payments WHERE user_id = ? AND course_id = ? ORDER BY id DESC LIMIT 1",
      [row.user_id, row.course_id]
    );
    if (!payment) {
      const ins: any = await query(
        `INSERT INTO payments (user_id, course_id, amount, currency, payment_method, status, reviewed_at)
         VALUES (?, ?, ?, 'XAF', 'manual', 'validated', NOW())`,
        [row.user_id, row.course_id, row.price]
      );
      payment = { id: Number(ins.insertId), amount: row.price, status: "validated" };
    } else if (payment.status !== "validated") {
      await query("UPDATE payments SET status = 'validated', reviewed_at = NOW() WHERE id = ?", [payment.id]);
    }

    const [already]: any = await query(
      "SELECT id FROM instructor_commissions WHERE payment_id = ? LIMIT 1",
      [payment.id]
    );
    if (already) return;

    const sale = Number(payment.amount);
    if (!(sale > 0)) return;

    const courseRate =
      row.instructor_commission_rate !== null && row.instructor_commission_rate !== undefined
        ? Number(row.instructor_commission_rate)
        : defaultCommissionRate();

    const coInstructors: any[] = await query(
      "SELECT instructor_id, commission_rate FROM course_instructors WHERE course_id = ? AND status = 'accepted'",
      [row.course_id]
    );
    const coTotal = coInstructors.reduce((s, c) => s + Number(c.commission_rate || 0), 0);
    const ownerRate = Math.max(courseRate - coTotal, 0);

    const shares = [
      { instructorId: Number(row.instructor_id), rate: ownerRate },
      ...coInstructors.map((c) => ({ instructorId: Number(c.instructor_id), rate: Number(c.commission_rate || 0) })),
    ].filter((s) => s.rate > 0);

    for (const s of shares) {
      await query(
        `INSERT INTO instructor_commissions
           (instructor_id, payment_id, course_id, sale_amount, commission_rate, commission_amount, status, earned_at)
         VALUES (?, ?, ?, ?, ?, ?, 'earned', NOW())`,
        [s.instructorId, payment.id, row.course_id, sale, s.rate, round2((sale * s.rate) / 100)]
      );
    }
  } catch (error: any) {
    // Ne jamais bloquer la validation d'une inscription à cause d'une commission.
    console.error("recordCommissionsForEnrollment:", error?.message || error);
  }
}

/** Annule les commissions non versées d'une inscription (rejet / suppression après validation). */
export async function voidCommissionsForEnrollment(enrollmentId: number): Promise<void> {
  try {
    const [row]: any = await query(
      "SELECT user_id, course_id FROM course_enrollments WHERE id = ?",
      [enrollmentId]
    );
    if (!row) return;
    await query(
      `DELETE ic FROM instructor_commissions ic
         JOIN payments p ON p.id = ic.payment_id
        WHERE p.user_id = ? AND p.course_id = ? AND ic.status <> 'paid'`,
      [row.user_id, row.course_id]
    );
  } catch (error: any) {
    console.error("voidCommissionsForEnrollment:", error?.message || error);
  }
}
