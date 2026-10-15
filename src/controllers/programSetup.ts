// src/controllers/programSetup.ts
// Programme instructeurs : tables, données par défaut et outils communs
// (onboarding, contrat, paliers, versements, messages, annonces, collaborations, grille de relecture).
import { query } from "../config/database";
import { getUserLang, Lang } from "../utils/lang";
import { createNotification } from "../services/notification.service";
import { sendProgramEmail } from "../services/mail.service";

// ══════════════════════════════════════════════════════
// TEXTE PAR DÉFAUT DU CONTRAT (à faire relire par un juriste avant usage réel)
// ══════════════════════════════════════════════════════
const DEFAULT_BODY_FR = `CHARTE ET CONTRAT D'INSTRUCTEUR — DevOpsAkademy

1. Objet
Le présent document définit les conditions dans lesquelles vous publiez et animez des formations sur la plateforme DevOpsAkademy en qualité d'instructeur.

2. Vos engagements
• Fournir des contenus exacts, à jour, originaux, et dont vous détenez les droits.
• Respecter les règles de qualité de la plateforme (structure pédagogique, qualité audio et vidéo, ressources fournies).
• Répondre aux questions et aux devoirs des apprenants dans des délais raisonnables.
• Ne pas utiliser la plateforme pour démarcher les apprenants vers des offres concurrentes.

3. Propriété intellectuelle
Vous restez propriétaire de vos contenus. Vous accordez à DevOpsAkademy une licence non exclusive, pour la durée de publication du cours, afin de les héberger, les diffuser et les promouvoir.

4. Rémunération
Vous percevez un pourcentage des ventes de vos cours, fixé par votre palier d'instructeur ou par accord particulier sur un cours. Les commissions sont calculées sur les paiements validés et versées sur le moyen de paiement que vous avez renseigné.

5. Validation des cours
Chaque cours est relu par l'équipe avant publication. Un cours peut être renvoyé pour corrections ou dépublié s'il ne respecte plus les règles de la plateforme.

6. Confidentialité et données
Vous vous engagez à ne pas divulguer les données personnelles des apprenants auxquelles vous avez accès.

7. Suspension et fin de collaboration
DevOpsAkademy peut suspendre ou retirer le statut d'instructeur en cas de manquement, avec un motif communiqué. Vous pouvez quitter le programme à tout moment ; vos cours peuvent alors être transférés pour garantir la continuité de service aux apprenants.

8. Acceptation
En signant, vous confirmez avoir lu et accepté la présente charte.`;

const DEFAULT_BODY_EN = `INSTRUCTOR CHARTER AND AGREEMENT — DevOpsAkademy

1. Purpose
This document sets out the terms under which you publish and teach courses on the DevOpsAkademy platform as an instructor.

2. Your commitments
• Provide accurate, up-to-date, original content that you hold the rights to.
• Follow the platform's quality rules (teaching structure, audio and video quality, supplied resources).
• Answer learners' questions and assignments within a reasonable time.
• Not use the platform to solicit learners towards competing offers.

3. Intellectual property
You remain the owner of your content. You grant DevOpsAkademy a non-exclusive licence, for as long as the course is published, to host, distribute and promote it.

4. Compensation
You receive a percentage of your courses' sales, set by your instructor tier or by a specific agreement on a course. Commissions are calculated on validated payments and paid to the payout method you provided.

5. Course review
Every course is reviewed by the team before publication. A course may be sent back for changes or unpublished if it no longer follows the platform's rules.

6. Confidentiality and data
You agree not to disclose the personal data of learners you have access to.

7. Suspension and end of collaboration
DevOpsAkademy may suspend or remove instructor status in case of breach, with a stated reason. You may leave the programme at any time; your courses may then be transferred to ensure continuity for learners.

8. Acceptance
By signing, you confirm that you have read and accepted this charter.`;

// ══════════════════════════════════════════════════════
// TABLES
// ══════════════════════════════════════════════════════
let ready: Promise<void> | null = null;
export const ensureProgramTables = (): Promise<void> => {
  if (!ready) {
    ready = (async () => {
      const ddl = [
        `CREATE TABLE IF NOT EXISTS instructor_agreements (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           version INT UNSIGNED NOT NULL,
           title VARCHAR(200) NOT NULL,
           body_fr LONGTEXT NOT NULL,
           body_en LONGTEXT NOT NULL,
           is_current TINYINT(1) NOT NULL DEFAULT 0,
           created_by INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_agreement_signatures (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           user_id INT UNSIGNED NOT NULL,
           agreement_id INT UNSIGNED NOT NULL,
           signed_name VARCHAR(150) NOT NULL,
           signed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           ip_address VARCHAR(45) NULL,
           user_agent VARCHAR(500) NULL,
           UNIQUE KEY uq_user_agreement (user_id, agreement_id),
           INDEX idx_agreement (agreement_id)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_onboarding (
           user_id INT UNSIGNED NOT NULL PRIMARY KEY,
           reminder_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
           last_reminder_at DATETIME NULL,
           completed_notified TINYINT(1) NOT NULL DEFAULT 0
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_payout_profiles (
           user_id INT UNSIGNED NOT NULL PRIMARY KEY,
           method ENUM('mobile_money','bank','other') NOT NULL DEFAULT 'mobile_money',
           provider VARCHAR(80) NULL,
           account_name VARCHAR(120) NOT NULL,
           account_number VARCHAR(80) NOT NULL,
           country VARCHAR(80) NULL,
           notes VARCHAR(500) NULL,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_payout_batches (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           reference VARCHAR(100) NOT NULL,
           created_by INT UNSIGNED NULL,
           instructors_count INT UNSIGNED NOT NULL DEFAULT 0,
           total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_tiers (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           slug VARCHAR(50) NOT NULL UNIQUE,
           name_fr VARCHAR(80) NOT NULL,
           name_en VARCHAR(80) NOT NULL,
           description VARCHAR(300) NULL,
           default_commission_rate DECIMAL(5,2) NOT NULL DEFAULT 70,
           sort_order INT NOT NULL DEFAULT 0,
           is_active TINYINT(1) NOT NULL DEFAULT 1,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_tier_assignments (
           user_id INT UNSIGNED NOT NULL PRIMARY KEY,
           tier_id INT UNSIGNED NOT NULL,
           assigned_by INT UNSIGNED NULL,
           assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_tier (tier_id)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_messages (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           instructor_id INT UNSIGNED NOT NULL,
           sender_id INT UNSIGNED NOT NULL,
           sender_role ENUM('admin','instructor') NOT NULL,
           body TEXT NOT NULL,
           read_at DATETIME NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_thread (instructor_id, created_at)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_announcements (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           title VARCHAR(200) NOT NULL,
           body TEXT NOT NULL,
           tier_id INT UNSIGNED NULL,
           send_email TINYINT(1) NOT NULL DEFAULT 0,
           created_by INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS instructor_announcement_reads (
           announcement_id INT UNSIGNED NOT NULL,
           user_id INT UNSIGNED NOT NULL,
           read_at DATETIME NULL,
           PRIMARY KEY (announcement_id, user_id),
           INDEX idx_user (user_id, read_at)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS course_collab_requests (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           course_id INT UNSIGNED NOT NULL,
           applicant_id INT UNSIGNED NOT NULL,
           role ENUM('co_instructor','assistant') NOT NULL DEFAULT 'assistant',
           message TEXT NULL,
           status ENUM('pending','accepted','declined','withdrawn') NOT NULL DEFAULT 'pending',
           response_note VARCHAR(500) NULL,
           decided_by INT UNSIGNED NULL,
           decided_at DATETIME NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_status (status, created_at),
           INDEX idx_applicant (applicant_id),
           INDEX idx_course (course_id)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS course_review_rounds (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           course_id INT UNSIGNED NOT NULL,
           reviewer_id INT UNSIGNED NULL,
           decision ENUM('approved','changes_requested') NOT NULL,
           criteria LONGTEXT NULL,
           comment TEXT NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_course (course_id, created_at)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      ];
      for (const sql of ddl) await query(sql);

      // Contrat v1 si aucun n'existe
      const [{ n }]: any = await query("SELECT COUNT(*) AS n FROM instructor_agreements");
      if (Number(n) === 0) {
        await query(
          "INSERT INTO instructor_agreements (version, title, body_fr, body_en, is_current) VALUES (1, ?, ?, ?, 1)",
          ["Charte et contrat d'instructeur", DEFAULT_BODY_FR, DEFAULT_BODY_EN]
        );
      }
      // Paliers par défaut
      const [{ t }]: any = await query("SELECT COUNT(*) AS t FROM instructor_tiers");
      if (Number(t) === 0) {
        await query(
          `INSERT INTO instructor_tiers (slug, name_fr, name_en, description, default_commission_rate, sort_order) VALUES
            ('junior', 'Junior', 'Junior', 'Nouvel instructeur', 60, 1),
            ('confirmed', 'Confirmé', 'Experienced', 'Instructeur avec des cours publiés et de bons retours', 70, 2),
            ('partner', 'Partenaire', 'Partner', 'Partenaire stratégique de la plateforme', 80, 3)`
        );
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
};

// ══════════════════════════════════════════════════════
// OUTILS COMMUNS
// ══════════════════════════════════════════════════════
export const plain = <T = any>(v: any): T =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)));

export const num = (v: any) => (v === null || v === undefined ? 0 : Number(v) || 0);

/** Notification + email (optionnel) dans la langue du destinataire. Ne lève jamais. */
export async function notifyUser(
  userId: number,
  opts: {
    type?: "info" | "success" | "warning";
    fr: { title: string; body: string };
    en: { title: string; body: string };
    link: string;
    email?: { ctaFr: string; ctaEn: string };
  }
): Promise<void> {
  try {
    const lang: Lang = await getUserLang(userId);
    const txt = lang === "en" ? opts.en : opts.fr;
    await createNotification(userId, { type: opts.type || "info", title: txt.title, message: txt.body.slice(0, 300), link: opts.link });
    if (opts.email) {
      const [u]: any = await query("SELECT email, first_name FROM users WHERE id = ?", [userId]);
      if (u?.email) {
        await sendProgramEmail(u.email, u.first_name, txt.title, txt.title, txt.body,
          { path: opts.link, label: lang === "en" ? opts.email.ctaEn : opts.email.ctaFr }, lang)
          .catch((e) => console.warn("Email programme:", e?.message));
      }
    }
  } catch (e: any) {
    console.warn("notifyUser:", e?.message || e);
  }
}

/** Instructeurs actifs (rôle instructeur + candidature acceptée). */
export const ACTIVE_INSTRUCTOR_SQL =
  `u.role = 'instructor' AND u.is_active = 1
   AND EXISTS (SELECT 1 FROM instructor_applications ia WHERE ia.user_id = u.id AND ia.status = 'accepted')`;
