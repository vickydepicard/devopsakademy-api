// src/controllers/marketingAudience.ts
// Ciblage : transforme les filtres d'une campagne en liste de destinataires (inscrits + contacts).
import { query } from "../config/database";
import { ensureAllPreferences, plain } from "./marketingSetup";

export type CampaignKind = "newsletter" | "offer" | "webinar" | "announcement";

export interface AudienceFilter {
  roles?: string[];                   // student | instructor
  lang?: "" | "fr" | "en";
  verified_only?: boolean;            // défaut : true
  enrolled_course_id?: number | null;
  category_id?: number | null;
  subscription?: "any" | "active" | "none";
  inactive_days?: number | null;      // sans connexion depuis N jours
  new_days?: number | null;           // inscrits depuis moins de N jours
  never_enrolled?: boolean;
  include_contacts?: boolean;         // visiteurs inscrits à la newsletter
}

export interface Recipient {
  user_id: number | null;
  contact_id: number | null;
  email: string;
  first_name: string | null;
  lang: "fr" | "en";
  pref_token: string;
}

// Préférence de communication correspondant au type de campagne
const PREF_COLUMN: Record<CampaignKind, "newsletter" | "promotions" | "events"> = {
  newsletter: "newsletter", announcement: "newsletter", offer: "promotions", webinar: "events",
};

const int = (v: any): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function resolveAudience(kind: CampaignKind, f: AudienceFilter = {}): Promise<Recipient[]> {
  await ensureAllPreferences();
  const pref = PREF_COLUMN[kind] || "newsletter";
  const roles = (f.roles && f.roles.length ? f.roles : ["student", "instructor"]).filter((r) => ["student", "instructor"].includes(r));

  const where: string[] = ["u.is_active = 1", `COALESCE(mp.unsubscribed_all, 0) = 0`, `COALESCE(mp.${pref}, 1) = 1`, `u.role IN (${roles.map(() => "?").join(",")})`];
  const params: any[] = [...roles];
  if (f.verified_only !== false) where.push("u.email_verified = 1");
  if (f.lang === "fr" || f.lang === "en") { where.push("COALESCE(u.preferred_language, 'fr') = ?"); params.push(f.lang); }
  if (int(f.enrolled_course_id)) {
    where.push("EXISTS (SELECT 1 FROM course_enrollments ce WHERE ce.user_id = u.id AND ce.course_id = ?)"); params.push(int(f.enrolled_course_id));
  }
  if (int(f.category_id)) {
    where.push("EXISTS (SELECT 1 FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id WHERE ce.user_id = u.id AND c.category_id = ?)"); params.push(int(f.category_id));
  }
  if (f.subscription === "active") where.push("u.subscription_status = 'active'");
  if (f.subscription === "none") where.push("(u.subscription_status IS NULL OR u.subscription_status <> 'active')");
  if (int(f.inactive_days)) { where.push("(u.last_login IS NULL OR u.last_login < NOW() - INTERVAL ? DAY)"); params.push(int(f.inactive_days)); }
  if (int(f.new_days)) { where.push("u.created_at > NOW() - INTERVAL ? DAY"); params.push(int(f.new_days)); }
  if (f.never_enrolled) where.push("NOT EXISTS (SELECT 1 FROM course_enrollments ce WHERE ce.user_id = u.id)");

  const users: any[] = await query(
    `SELECT u.id, u.email, u.first_name, COALESCE(u.preferred_language, 'fr') AS lang, mp.token
       FROM users u LEFT JOIN marketing_preferences mp ON mp.user_id = u.id
      WHERE ${where.join(" AND ")} ORDER BY u.id`, params);

  const out: Recipient[] = users.map((u) => ({
    user_id: Number(u.id), contact_id: null, email: String(u.email).toLowerCase(), first_name: u.first_name,
    lang: u.lang === "en" ? "en" : "fr", pref_token: u.token,
  }));

  if (f.include_contacts) {
    const contacts: any[] = await query(
      `SELECT id, email, first_name, lang, token FROM marketing_contacts WHERE status = 'subscribed'
        ${f.lang === "fr" || f.lang === "en" ? "AND lang = ?" : ""}`,
      f.lang === "fr" || f.lang === "en" ? [f.lang] : []);
    const seen = new Set(out.map((r) => r.email));
    for (const c of contacts) {
      const email = String(c.email).toLowerCase();
      if (seen.has(email)) continue;
      out.push({ user_id: null, contact_id: Number(c.id), email, first_name: c.first_name, lang: c.lang === "en" ? "en" : "fr", pref_token: c.token });
    }
  }
  return plain(out);
}
