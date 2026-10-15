// src/controllers/marketingSetup.ts
// Newsletter, offres, bannières, réseaux sociaux, promotions programmées : tables et outils communs.
import crypto from "crypto";
import { query } from "../config/database";
import { seedMarketingPresets } from "./marketingPresets";

let ready: Promise<void> | null = null;
export const ensureMarketingTables = (): Promise<void> => {
  if (!ready) {
    ready = (async () => {
      const ddl = [
        // Préférences de communication des utilisateurs inscrits (par défaut : tout activé, désabonnement facile)
        `CREATE TABLE IF NOT EXISTS marketing_preferences (
           user_id INT UNSIGNED NOT NULL PRIMARY KEY,
           newsletter TINYINT(1) NOT NULL DEFAULT 1,
           promotions TINYINT(1) NOT NULL DEFAULT 1,
           events TINYINT(1) NOT NULL DEFAULT 1,
           unsubscribed_all TINYINT(1) NOT NULL DEFAULT 0,
           token CHAR(40) NOT NULL UNIQUE,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        // Visiteurs sans compte inscrits à la newsletter
        `CREATE TABLE IF NOT EXISTS marketing_contacts (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           email VARCHAR(190) NOT NULL UNIQUE,
           first_name VARCHAR(100) NULL,
           lang VARCHAR(5) NOT NULL DEFAULT 'fr',
           source VARCHAR(40) NULL,
           status ENUM('pending','subscribed','unsubscribed') NOT NULL DEFAULT 'pending',
           token CHAR(40) NOT NULL UNIQUE,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           unsubscribed_at DATETIME NULL
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS marketing_campaigns (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           name VARCHAR(200) NOT NULL,
           kind ENUM('newsletter','offer','webinar','announcement') NOT NULL DEFAULT 'newsletter',
           template VARCHAR(40) NULL,
           status ENUM('draft','scheduled','sending','sent','cancelled') NOT NULL DEFAULT 'draft',
           subject_fr VARCHAR(250) NOT NULL DEFAULT '',
           subject_en VARCHAR(250) NOT NULL DEFAULT '',
           preheader_fr VARCHAR(250) NULL,
           preheader_en VARCHAR(250) NULL,
           blocks_fr LONGTEXT NULL,
           blocks_en LONGTEXT NULL,
           audience LONGTEXT NULL,
           channels LONGTEXT NULL,
           scheduled_at DATETIME NULL,
           started_at DATETIME NULL,
           finished_at DATETIME NULL,
           recipients_total INT UNSIGNED NOT NULL DEFAULT 0,
           api_base VARCHAR(200) NULL,
           created_by INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
           INDEX idx_status (status, scheduled_at)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS marketing_sends (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           campaign_id INT UNSIGNED NOT NULL,
           user_id INT UNSIGNED NULL,
           contact_id INT UNSIGNED NULL,
           email VARCHAR(190) NOT NULL,
           first_name VARCHAR(100) NULL,
           lang VARCHAR(5) NOT NULL DEFAULT 'fr',
           pref_token CHAR(40) NOT NULL,
           token CHAR(32) NOT NULL UNIQUE,
           status ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
           error VARCHAR(300) NULL,
           sent_at DATETIME NULL,
           opened_at DATETIME NULL,
           open_count INT UNSIGNED NOT NULL DEFAULT 0,
           clicked_at DATETIME NULL,
           click_count INT UNSIGNED NOT NULL DEFAULT 0,
           unsubscribed_at DATETIME NULL,
           UNIQUE KEY uq_campaign_email (campaign_id, email),
           INDEX idx_queue (campaign_id, status)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS marketing_link_stats (
           campaign_id INT UNSIGNED NOT NULL,
           link_index INT UNSIGNED NOT NULL,
           clicks INT UNSIGNED NOT NULL DEFAULT 0,
           PRIMARY KEY (campaign_id, link_index)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS marketing_banners (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           campaign_id INT UNSIGNED NULL,
           placement ENUM('top_bar','popup') NOT NULL DEFAULT 'top_bar',
           title_fr VARCHAR(200) NOT NULL,
           title_en VARCHAR(200) NOT NULL,
           body_fr VARCHAR(500) NULL,
           body_en VARCHAR(500) NULL,
           cta_label_fr VARCHAR(80) NULL,
           cta_label_en VARCHAR(80) NULL,
           cta_url VARCHAR(500) NULL,
           image_url VARCHAR(500) NULL,
           tone ENUM('info','promo','success','urgent') NOT NULL DEFAULT 'promo',
           audience ENUM('all','visitors','students','instructors') NOT NULL DEFAULT 'all',
           starts_at DATETIME NULL,
           ends_at DATETIME NULL,
           is_active TINYINT(1) NOT NULL DEFAULT 1,
           impressions INT UNSIGNED NOT NULL DEFAULT 0,
           clicks INT UNSIGNED NOT NULL DEFAULT 0,
           created_by INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_active (is_active, starts_at, ends_at)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS marketing_social_posts (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           campaign_id INT UNSIGNED NULL,
           channel VARCHAR(30) NOT NULL,
           text TEXT NOT NULL,
           image_url VARCHAR(500) NULL,
           link_url VARCHAR(500) NULL,
           status ENUM('draft','published','failed') NOT NULL DEFAULT 'draft',
           external_id VARCHAR(100) NULL,
           error VARCHAR(300) NULL,
           created_by INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           published_at DATETIME NULL
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        // Prix promotionnel temporaire : appliqué puis rétabli automatiquement
        `CREATE TABLE IF NOT EXISTS marketing_promotions (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           campaign_id INT UNSIGNED NULL,
           course_id INT UNSIGNED NOT NULL,
           type ENUM('free','percent') NOT NULL,
           percent DECIMAL(5,2) NULL,
           promo_price DECIMAL(10,2) NOT NULL DEFAULT 0,
           regular_price DECIMAL(10,2) NULL,
           regular_original_price DECIMAL(10,2) NULL,
           regular_is_free TINYINT(1) NULL,
           starts_at DATETIME NOT NULL,
           ends_at DATETIME NOT NULL,
           status ENUM('scheduled','active','ended','cancelled') NOT NULL DEFAULT 'scheduled',
           created_by INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_status (status, starts_at, ends_at),
           INDEX idx_course (course_id, status)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      ];
      ddl.push(
        `CREATE TABLE IF NOT EXISTS marketing_templates (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           slug VARCHAR(80) NOT NULL UNIQUE,
           type ENUM('campaign','banner','social') NOT NULL DEFAULT 'campaign',
           name_fr VARCHAR(200) NOT NULL,
           name_en VARCHAR(200) NOT NULL,
           description_fr VARCHAR(400) NULL,
           description_en VARCHAR(400) NULL,
           icon VARCHAR(40) NULL,
           category VARCHAR(30) NULL,
           kind VARCHAR(20) NULL,
           content LONGTEXT NULL,
           is_builtin TINYINT(1) NOT NULL DEFAULT 0,
           sort_order INT NOT NULL DEFAULT 0,
           created_by INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
           INDEX idx_type (type, sort_order)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS marketing_automations (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           slug VARCHAR(80) NOT NULL UNIQUE,
           name_fr VARCHAR(200) NOT NULL,
           name_en VARCHAR(200) NOT NULL,
           trigger_type ENUM('signup','no_enrollment','inactive','course_stalled','course_completed') NOT NULL,
           delay_days INT UNSIGNED NOT NULL DEFAULT 0,
           pref ENUM('newsletter','promotions','events') NOT NULL DEFAULT 'newsletter',
           subject_fr VARCHAR(250) NOT NULL DEFAULT '',
           subject_en VARCHAR(250) NOT NULL DEFAULT '',
           preheader_fr VARCHAR(250) NULL,
           preheader_en VARCHAR(250) NULL,
           blocks_fr LONGTEXT NULL,
           blocks_en LONGTEXT NULL,
           enabled TINYINT(1) NOT NULL DEFAULT 0,
           enabled_at DATETIME NULL,
           campaign_id INT UNSIGNED NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS marketing_automation_log (
           automation_id INT UNSIGNED NOT NULL,
           user_id INT UNSIGNED NOT NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           PRIMARY KEY (automation_id, user_id)
         ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      for (const sql of ddl) await query(sql);

      // Évolutions de tables déjà créées à l'étape 1 (tolérantes : une erreur isolée ne bloque pas le reste)
      const alters = [
        "ALTER TABLE marketing_sends MODIFY status ENUM('queued','sent','failed','held') NOT NULL DEFAULT 'queued'",
        "ALTER TABLE marketing_sends ADD COLUMN IF NOT EXISTS variant CHAR(1) NULL",
        "ALTER TABLE marketing_sends ADD COLUMN IF NOT EXISTS vars LONGTEXT NULL",
        "ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS ab_test LONGTEXT NULL",
        "ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS ab_state ENUM('none','testing','decided') NOT NULL DEFAULT 'none'",
        "ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS ab_winner CHAR(1) NULL",
        "ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS ab_decide_at DATETIME NULL",
        "ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS automation_id INT UNSIGNED NULL",
        "ALTER TABLE marketing_banners MODIFY placement ENUM('top_bar','popup','inline_home','inline_dashboard','inline_catalog') NOT NULL DEFAULT 'top_bar'",
        "ALTER TABLE coupons ADD COLUMN IF NOT EXISTS campaign_id INT UNSIGNED NULL",
        "ALTER TABLE coupons ADD COLUMN IF NOT EXISTS is_public TINYINT(1) NOT NULL DEFAULT 1",
      ];
      for (const sql of alters) { try { await query(sql); } catch (e: any) { console.warn("marketing alter:", e?.message); } }
      await seedMarketingPresets();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
};

export const newToken = (bytes = 20): string => crypto.randomBytes(bytes).toString("hex");

export const plain = <T = any>(v: any): T =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)));
export const num = (v: any) => (v === null || v === undefined ? 0 : Number(v) || 0);

export const parseJson = <T = any>(v: any, fallback: T): T => {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v === "object") return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
};

export const frontendUrl = (path = ""): string => {
  const base = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path ? (path.startsWith("/") ? path : `/${path}`) : ""}`;
};

/** Crée (si besoin) la ligne de préférences + jeton de désabonnement de tous les utilisateurs. */
export async function ensureAllPreferences(): Promise<void> {
  await query(
    `INSERT IGNORE INTO marketing_preferences (user_id, token)
     SELECT u.id, SHA1(CONCAT(UUID(), u.id, RAND())) FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM marketing_preferences p WHERE p.user_id = u.id)`
  );
}

/** Préférences d'un utilisateur (créées à la demande). */
export async function getUserPrefs(userId: number) {
  await query("INSERT IGNORE INTO marketing_preferences (user_id, token) VALUES (?, ?)", [userId, newToken()]);
  const [p]: any = await query("SELECT * FROM marketing_preferences WHERE user_id = ?", [userId]);
  return p;
}
