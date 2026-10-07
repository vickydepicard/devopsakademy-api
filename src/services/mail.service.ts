// src/services/mail.service.ts
// Service email universel — Brevo SMTP (nodemailer) — gabarits bilingues FR / EN
import nodemailer from "nodemailer";
import { Lang, DEFAULT_LANG } from "../utils/lang";

// ══════════════════════════════════════
// TYPES
// ══════════════════════════════════════
interface SendEmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;     // version texte optionnelle
  replyTo?: string;  // réponse à une adresse différente
}

// ══════════════════════════════════════
// TRANSPORTER (Brevo SMTP)
// ══════════════════════════════════════
let _transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (_transporter) return _transporter;

  const host = process.env.MAIL_HOST || "smtp-relay.brevo.com";
  const port = Number(process.env.MAIL_PORT) || 587;
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASSWORD;

  if (!user || !pass) {
    console.error("MAIL_USER ou MAIL_PASSWORD manquant dans .env");
    throw new Error("Configuration email manquante");
  }

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure: process.env.MAIL_SECURE === "true",
    auth: { user, pass },
    // Brevo timeout
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  return _transporter;
}

// ══════════════════════════════════════
// FONCTION PRINCIPALE
// ══════════════════════════════════════
export const sendEmail = async ({ to, subject, html, text, replyTo }: SendEmailParams): Promise<void> => {
  try {
    const transporter = getTransporter();
    const fromName  = process.env.MAIL_FROM_NAME  || "DevOpsAkademy";
    const fromEmail = process.env.MAIL_FROM_EMAIL || process.env.MAIL_USER || "";

    const info = await transporter.sendMail({
      from:    `"${fromName}" <${fromEmail}>`,
      to:      Array.isArray(to) ? to.join(", ") : to,
      subject,
      html,
      text:    text || html.replace(/<[^>]+>/g, ""),
      replyTo: replyTo || fromEmail,
    });

    console.log(`Email envoyé → ${to} | ID: ${info.messageId}`);
  } catch (err: any) {
    console.error(`Erreur envoi email → ${to}:`, err.message);
    throw err; // Relancer pour que l'appelant puisse gérer
  }
};

// ══════════════════════════════════════
// OUTILS
// ══════════════════════════════════════
// Le contenu provient d'utilisateurs (noms, titres, motifs…) → toujours échapper
export const escapeHtml = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const esc = escapeHtml;

/** URL du frontend + chemin, sans double ni absence de « / » */
const fe = (path = ""): string => {
  const base = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path ? (path.startsWith("/") ? path : `/${path}`) : ""}`;
};

const supportEmail = (): string =>
  (process.env.ADMIN_EMAIL || "").split(",")[0].trim() || "contact@devopsakademy.cloud";

/** Sélecteur de texte : l(lang)("français", "english") */
const l = (lang: Lang) => (fr: string, en: string): string => (lang === "en" ? en : fr);

const button = (href: string, label: string, gradient = "#2d287f,#5653e1") => `
    <div style="text-align:center;margin:28px 0;">
      <a href="${href}"
        style="background:linear-gradient(135deg,${gradient});color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        ${label}
      </a>
    </div>`;

const card = (inner: string, bg = "#f4f3fb", border = "transparent") =>
  `<div style="background:${bg};border:1px solid ${border};border-radius:12px;padding:20px 24px;margin:16px 0;">${inner}</div>`;

// Template HTML de base
function baseTemplate(content: string, title: string, lang: Lang = DEFAULT_LANG): string {
  const t = l(lang);
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f3fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3fb;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2d287f,#5653e1);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
            <p style="margin:0;color:#facc15;font-size:22px;font-weight:900;letter-spacing:-0.5px;">DevOps Akademy</p>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.7);font-size:13px;">${t("La plateforme DevOps &amp; Cloud", "The DevOps &amp; Cloud learning platform")}</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#fff;padding:36px 32px;border-radius:0 0 16px 16px;box-shadow:0 4px 24px rgba(45,40,127,0.08);">
            ${content}
            <hr style="border:none;border-top:1px solid #eee;margin:32px 0 24px;" />
            <p style="color:#aaa;font-size:12px;text-align:center;margin:0;">
              &copy; ${new Date().getFullYear()} DevOpsAkademy &middot; ${t("Douala, Cameroun", "Douala, Cameroon")}<br/>
              <a href="mailto:${supportEmail()}" style="color:#5653e1;">${supportEmail()}</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ══════════════════════════════════════
// GABARITS
// ══════════════════════════════════════

// ── 1. Vérification de l'adresse email (inscription / renvoi) ──
export const sendVerificationEmail = async (
  to: string, firstName: string, verifyToken: string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const url = fe(`/verify-email/${verifyToken}`);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 12px;">${t("Bonjour", "Hello")} ${esc(firstName)}</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Votre compte a été créé avec succès.<br/>Cliquez sur le bouton ci-dessous pour l'activer :",
          "Your account has been created.<br/>Click the button below to activate it:")}
    </p>
    ${button(url, t("Activer mon compte", "Activate my account"))}
    <p style="color:#888;font-size:13px;text-align:center;">
      ${t("Ce lien expire dans <strong>24 heures</strong>.<br/>Si vous n'avez pas créé ce compte, ignorez cet email.",
          "This link expires in <strong>24 hours</strong>.<br/>If you did not create this account, you can ignore this email.")}
    </p>`;
  await sendEmail({
    to,
    subject: t("Activez votre compte DevOpsAkademy", "Activate your DevOpsAkademy account"),
    html: baseTemplate(content, t("Activation du compte", "Account activation"), lang),
  });
};

// ── 2. Bienvenue (après activation) ─────────────────
export const sendWelcomeEmail = async (to: string, firstName: string, lang: Lang = DEFAULT_LANG): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Bienvenue", "Welcome")}, ${esc(firstName)}</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Votre compte <strong>DevOpsAkademy</strong> est maintenant actif.",
          "Your <strong>DevOpsAkademy</strong> account is now active.")}
    </p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Vous pouvez dès maintenant explorer notre catalogue de formations DevOps, Cloud et CI/CD.",
          "You can now explore our catalog of DevOps, Cloud and CI/CD courses.")}
    </p>
    ${button(fe("/courses"), t("Explorer les formations", "Explore courses"))}
    <p style="color:#888;font-size:13px;">${t("Une question ? Répondez à cet email ou contactez-nous.", "Any question? Reply to this email or contact us.")}</p>`;
  await sendEmail({
    to,
    subject: t("Bienvenue sur DevOpsAkademy", "Welcome to DevOpsAkademy"),
    html: baseTemplate(content, t("Bienvenue", "Welcome"), lang),
  });
};

// ── 3. Paiement reçu (en attente de validation) ─────
export const sendPaymentReceivedEmail = async (
  to: string, firstName: string, courseTitle: string, amount: number, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Preuve de paiement reçue", "Proof of payment received")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Nous avons bien reçu votre preuve de paiement pour :", "We have received your proof of payment for:")}
    </p>
    ${card(`<p style="margin:0 0 8px;font-weight:700;color:#2d287f;font-size:16px;">${esc(courseTitle)}</p>
            <p style="margin:0;color:#5653e1;font-weight:700;font-size:20px;">${amount.toLocaleString(lang === "en" ? "en-US" : "fr-FR")} XAF</p>`)}
    ${card(`<p style="margin:0;color:#92400e;font-size:14px;">
              <strong>${t("Délai de validation : 24 à 48 h ouvrées", "Validation time: 24 to 48 business hours")}</strong><br/>
              ${t("Vous recevrez un email dès la validation de votre accès.", "You will receive an email as soon as your access is approved.")}
            </p>`, "#fffbeb", "#fde68a")}
    <p style="color:#888;font-size:13px;">
      ${t("Une question ? Contactez-nous à", "Any question? Contact us at")} <a href="mailto:${supportEmail()}" style="color:#5653e1;">${supportEmail()}</a>
    </p>`;
  await sendEmail({
    to,
    subject: `${t("Preuve reçue", "Proof received")} — ${courseTitle}`,
    html: baseTemplate(content, t("Paiement reçu", "Payment received"), lang),
  });
};

// ── 4. Paiement validé (accès accordé) ──────────────
export const sendPaymentApprovedEmail = async (
  to: string, firstName: string, courseTitle: string, courseId: number, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#059669;margin:0 0 8px;">${t("Paiement validé : accès accordé", "Payment approved: access granted")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Bonne nouvelle ! Votre inscription au cours suivant est maintenant <strong>active</strong> :",
          "Good news! Your enrollment in the following course is now <strong>active</strong>:")}
    </p>
    ${card(`<p style="margin:0;font-weight:700;color:#065f46;font-size:16px;">${esc(courseTitle)}</p>`, "#ecfdf5", "#a7f3d0")}
    ${button(fe(`/courses/${courseId}/learn`), t("Commencer le cours", "Start the course"), "#059669,#10b981")}
    <p style="color:#888;font-size:13px;">${t("Bon apprentissage ! L'équipe DevOpsAkademy", "Happy learning! The DevOpsAkademy team")}</p>`;
  await sendEmail({
    to,
    subject: `${t("Accès accordé", "Access granted")} — ${courseTitle}`,
    html: baseTemplate(content, t("Accès accordé", "Access granted"), lang),
  });
};

// ── 5. Paiement rejeté (re-soumettre) ───────────────
export const sendPaymentRejectedEmail = async (
  to: string, firstName: string, courseTitle: string, reason?: string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#dc2626;margin:0 0 8px;">${t("Preuve de paiement refusée", "Proof of payment declined")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Votre preuve de paiement pour", "Your proof of payment for")} <strong>${esc(courseTitle)}</strong>
      ${t("n'a pas pu être validée.", "could not be approved.")}
    </p>
    ${reason ? card(`<p style="margin:0;color:#991b1b;font-size:14px;"><strong>${t("Motif", "Reason")} :</strong> ${esc(reason)}</p>`, "#fef2f2", "#fecaca") : ""}
    ${card(`<p style="margin:0 0 8px;color:#92400e;font-weight:700;font-size:14px;">${t("Ce que nous vérifions :", "What we check:")}</p>
            <ul style="margin:0;padding-left:20px;color:#92400e;font-size:13px;line-height:1.8;">
              <li>${t("Le montant correspond exactement au prix du cours", "The amount matches the course price exactly")}</li>
              <li>${t("Le destinataire est bien DevOpsAkademy", "The recipient is DevOpsAkademy")}</li>
              <li>${t("La date de transaction est récente", "The transaction date is recent")}</li>
              <li>${t("Le statut indique « réussi » ou « confirmé »", "The status shows “successful” or “confirmed”")}</li>
            </ul>`, "#fff7ed", "#fed7aa")}
    ${button(fe("/student/payments"), t("Renvoyer une preuve correcte", "Submit a valid proof"), "#dc2626,#ef4444")}`;
  await sendEmail({
    to,
    subject: `${t("Preuve refusée", "Proof declined")} — ${courseTitle}`,
    html: baseTemplate(content, t("Paiement refusé", "Payment declined"), lang),
  });
};

// ── 6. Certificat émis ──────────────────────────────
export const sendCertificateEmail = async (
  to: string, firstName: string, courseTitle: string, certificateNumber: string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Félicitations, vous avez réussi", "Congratulations, you did it")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Vous avez complété avec succès la formation :", "You have successfully completed the course:")}
    </p>
    <div style="background:#f4f3fb;border:2px solid #5653e1;border-radius:12px;padding:20px 24px;margin:16px 0;text-align:center;">
      <p style="margin:0 0 8px;font-weight:900;color:#2d287f;font-size:18px;">${esc(courseTitle)}</p>
      <p style="margin:0;color:#5653e1;font-size:13px;font-weight:600;">${t("Certificat N°", "Certificate No.")} ${esc(certificateNumber)}</p>
    </div>
    ${button(fe(`/certificates/verify/${encodeURIComponent(certificateNumber)}`), t("Voir mon certificat", "View my certificate"))}
    <p style="color:#888;font-size:13px;">${t("Partagez votre réussite sur LinkedIn ! L'équipe DevOpsAkademy", "Share your achievement on LinkedIn! The DevOpsAkademy team")}</p>`;
  await sendEmail({
    to,
    subject: `${t("Certificat obtenu", "Certificate earned")} — ${courseTitle}`,
    html: baseTemplate(content, t("Certificat", "Certificate"), lang),
  });
};

// ── 7. Réinitialisation du mot de passe ─────────────
export const sendPasswordResetEmail = async (
  to: string, firstName: string, resetToken: string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Réinitialisation de mot de passe", "Password reset")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous :",
          "You asked to reset your password. Click the button below:")}
    </p>
    ${button(fe(`/reset-password/${resetToken}`), t("Réinitialiser mon mot de passe", "Reset my password"))}
    ${card(`<p style="margin:0;color:#555;font-size:13px;">
              ${t("Ce lien expire dans <strong>30 minutes</strong>.<br/>Si vous n'avez pas fait cette demande, ignorez cet email.",
                  "This link expires in <strong>30 minutes</strong>.<br/>If you did not make this request, you can ignore this email.")}
            </p>`)}`;
  await sendEmail({
    to,
    subject: t("Réinitialisation de mot de passe", "Reset your password"),
    html: baseTemplate(content, t("Réinitialisation du mot de passe", "Password reset"), lang),
  });
};

// ── 8. Mot de passe modifié ─────────────────────────
export const sendPasswordChangedEmail = async (to: string, firstName: string, lang: Lang = DEFAULT_LANG): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Mot de passe modifié", "Password changed")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">${t("Votre mot de passe a été modifié avec succès.", "Your password has been changed successfully.")}</p>
    <p style="color:#555;font-size:14px;">${t("Si ce n'est pas vous, contactez-nous immédiatement à", "If this was not you, contact us immediately at")}
      <a href="mailto:${supportEmail()}" style="color:#5653e1;">${supportEmail()}</a>.</p>`;
  await sendEmail({
    to,
    subject: t("Mot de passe modifié — DevOpsAkademy", "Password changed — DevOpsAkademy"),
    html: baseTemplate(content, t("Mot de passe modifié", "Password changed"), lang),
  });
};

// ── 9. Message de contact reçu (admin) — toujours en français ──
export const sendContactNotificationEmail = async (
  adminEmail: string, senderName: string, senderEmail: string, subject: string, message: string
): Promise<void> => {
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">Nouveau message de contact</h2>
    ${card(`<p style="margin:0 0 6px;"><strong>Nom :</strong> ${esc(senderName)}</p>
            <p style="margin:0 0 6px;"><strong>Email :</strong> <a href="mailto:${esc(senderEmail)}" style="color:#5653e1;">${esc(senderEmail)}</a></p>
            <p style="margin:0 0 6px;"><strong>Sujet :</strong> ${esc(subject)}</p>`)}
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px 24px;margin:16px 0;">
      <p style="margin:0;color:#555;white-space:pre-wrap;font-size:15px;line-height:1.7;">${esc(message)}</p>
    </div>`;
  await sendEmail({
    to: adminEmail,
    subject: `Contact: ${subject}`,
    html: baseTemplate(content, "Nouveau contact", "fr"),
    replyTo: senderEmail,
  });
};

// ── 10. Accusé de réception du message de contact ───
export const sendContactReceivedEmail = async (
  to: string, name: string, subject: string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Message bien reçu", "We received your message")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(name)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Merci de nous avoir contactés. Nous avons bien reçu votre message concernant :",
          "Thank you for contacting us. We have received your message regarding:")}
    </p>
    ${card(`<p style="margin:0;color:#2d287f;font-weight:700;">${esc(subject)}</p>`)}
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Notre équipe vous répondra sous <strong>24 à 48 heures ouvrées</strong>.",
          "Our team will reply within <strong>24 to 48 business hours</strong>.")}
    </p>`;
  await sendEmail({
    to,
    subject: t("Nous avons bien reçu votre message — DevOpsAkademy", "We received your message — DevOpsAkademy"),
    html: baseTemplate(content, t("Message reçu", "Message received"), lang),
  });
};

// ── 11. Candidature instructeur : reçue ─────────────
export const sendInstructorApplicationReceivedEmail = async (
  to: string, firstName: string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Candidature reçue", "Application received")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Nous avons bien reçu votre candidature pour devenir instructeur sur <strong>DevOpsAkademy</strong>.",
          "We have received your application to become an instructor on <strong>DevOpsAkademy</strong>.")}
    </p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Notre équipe l'examinera sous <strong>3 à 5 jours ouvrés</strong>. Vous recevrez une réponse par email.",
          "Our team will review it within <strong>3 to 5 business days</strong>. You will receive an answer by email.")}
    </p>
    <p style="color:#555;font-size:15px;">${t("Merci pour votre intérêt !", "Thank you for your interest!")}</p>`;
  await sendEmail({
    to,
    subject: t("Candidature instructeur reçue — DevOpsAkademy", "Instructor application received — DevOpsAkademy"),
    html: baseTemplate(content, t("Candidature reçue", "Application received"), lang),
  });
};

// ── 12. Candidature instructeur : acceptée ──────────
export const sendInstructorApplicationAcceptedEmail = async (
  to: string, firstName: string, note?: string | null, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#059669;margin:0 0 8px;">${t("Candidature acceptée", "Application accepted")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Félicitations ! Votre candidature pour devenir instructeur sur <strong>DevOpsAkademy</strong> a été <strong>acceptée</strong>.",
          "Congratulations! Your application to become an instructor on <strong>DevOpsAkademy</strong> has been <strong>accepted</strong>.")}
    </p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Votre compte a été mis à jour. Reconnectez-vous pour accéder à votre espace instructeur.",
          "Your account has been updated. Log in again to access your instructor area.")}
    </p>
    ${note ? card(`<p style="margin:0;color:#555;font-size:14px;"><strong>${t("Message de l'équipe", "Message from the team")} :</strong> ${esc(note)}</p>`) : ""}
    ${button(fe("/login"), t("Accéder à mon espace instructeur", "Go to my instructor area"), "#059669,#10b981")}
    <p style="color:#888;font-size:13px;">${t("Bienvenue dans l'équipe ! DevOpsAkademy", "Welcome to the team! DevOpsAkademy")}</p>`;
  await sendEmail({
    to,
    subject: t("Candidature acceptée : vous êtes maintenant instructeur", "Application accepted: you are now an instructor"),
    html: baseTemplate(content, t("Candidature acceptée", "Application accepted"), lang),
  });
};

// ── 13. Candidature instructeur : refusée ───────────
export const sendInstructorApplicationRejectedEmail = async (
  to: string, firstName: string, reason: string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Décision concernant votre candidature", "Decision on your application")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Après examen de votre candidature, nous ne sommes pas en mesure de vous accepter comme instructeur pour le moment.",
          "After reviewing your application, we are unable to accept you as an instructor at this time.")}
    </p>
    ${card(`<p style="margin:0;color:#991b1b;font-size:14px;"><strong>${t("Motif", "Reason")} :</strong> ${esc(reason)}</p>`, "#fef2f2", "#fecaca")}
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("Cela ne signifie pas que votre candidature est définitivement refusée. Vous pouvez en soumettre une nouvelle dans 3 mois avec un profil enrichi.",
          "This is not a permanent refusal. You may submit a new application in 3 months with an enriched profile.")}
    </p>
    <p style="color:#555;font-size:15px;">${t("Continuez d'apprendre sur la plateforme : nous espérons vous revoir prochainement.", "Keep learning on the platform: we hope to see you again soon.")}</p>`;
  await sendEmail({
    to,
    subject: t("Candidature instructeur : décision de notre équipe", "Instructor application: our team's decision"),
    html: baseTemplate(content, t("Décision candidature", "Application decision"), lang),
  });
};

// ── 14. Invitation co-instructeur ───────────────────
export const sendCoInstructorInviteEmail = async (
  to: string, firstName: string, courseTitle: string, commissionRate: number | string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 12px;">${t("Bonjour", "Hello")} ${esc(firstName)}</h2>
    <p style="color:#555;font-size:14px;line-height:1.7;">
      ${t("Vous avez été invité(e) à devenir <strong>co-instructeur</strong> sur le cours :",
          "You have been invited to become a <strong>co-instructor</strong> on the course:")}
    </p>
    ${card(`<p style="margin:0;font-size:15px;font-weight:700;color:#2d287f;">${esc(courseTitle)}</p>
            <p style="margin:4px 0 0;font-size:13px;color:#6366f1;">${t("Commission", "Commission")} : ${esc(commissionRate)}% ${t("sur chaque vente", "on each sale")}</p>`, "#f8f7ff", "#e0e7ff")}
    <p style="color:#555;font-size:13px;">${t("Connectez-vous pour accepter ou refuser cette invitation.", "Log in to accept or decline this invitation.")}</p>
    ${button(fe("/instructor"), t("Voir l'invitation", "View the invitation"))}`;
  await sendEmail({
    to,
    subject: `${t("Invitation co-instructeur", "Co-instructor invitation")} — ${courseTitle}`,
    html: baseTemplate(content, t("Invitation co-instructeur", "Co-instructor invitation"), lang),
  });
};

// ── 15. Alerte admin (notification plateforme) — toujours en français ──
export const sendAdminAlertEmail = async (
  to: string | string[],
  title: string,
  message: string,
  link?: string,
  replyTo?: string
): Promise<void> => {
  const url = link ? fe(link) : fe("/admin/notifications");
  const content = `
    <p style="margin:0 0 6px;color:#5653e1;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Notification administrateur</p>
    <h2 style="color:#2d287f;margin:0 0 16px;">${esc(title)}</h2>
    ${card(`<p style="margin:0;color:#555;white-space:pre-wrap;font-size:15px;line-height:1.7;">${esc(message)}</p>`)}
    ${button(url, "Ouvrir dans l'admin")}`;
  await sendEmail({
    to,
    subject: `[Admin] ${title}`,
    html: baseTemplate(content, "Notification admin", "fr"),
    replyTo,
  });
};

// ── 16. Compte instructeur créé par un administrateur ──
export const sendInstructorAccountCreatedEmail = async (
  to: string, firstName: string, resetToken: string, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${t("Votre espace instructeur est prêt", "Your instructor account is ready")}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      ${t("L'équipe <strong>DevOpsAkademy</strong> vous a créé un compte instructeur. Choisissez votre mot de passe pour y accéder :",
          "The <strong>DevOpsAkademy</strong> team created an instructor account for you. Choose your password to get started:")}
    </p>
    ${button(fe(`/reset-password/${resetToken}`), t("Choisir mon mot de passe", "Set my password"))}
    ${card(`<p style="margin:0;color:#555;font-size:13px;">
              ${t("Ce lien expire dans <strong>7 jours</strong>. Passé ce délai, utilisez « Mot de passe oublié » sur la page de connexion.",
                  "This link expires in <strong>7 days</strong>. After that, use “Forgot password” on the login page.")}
            </p>`)}`;
  await sendEmail({
    to,
    subject: t("Votre compte instructeur DevOpsAkademy", "Your DevOpsAkademy instructor account"),
    html: baseTemplate(content, t("Compte instructeur", "Instructor account"), lang),
  });
};

// ── 17. Changement de statut d'un instructeur (suspension / réactivation / retrait) ──
export const sendInstructorStatusEmail = async (
  to: string, firstName: string, kind: "suspended" | "reactivated" | "revoked", reason: string | null, lang: Lang = DEFAULT_LANG
): Promise<void> => {
  const t = l(lang);
  const titles = {
    suspended:   t("Votre compte instructeur est suspendu", "Your instructor account has been suspended"),
    reactivated: t("Votre compte instructeur est réactivé", "Your instructor account has been reactivated"),
    revoked:     t("Votre accès instructeur a pris fin", "Your instructor access has ended"),
  } as const;
  const bodies = {
    suspended:   t("Votre accès à la plateforme a été suspendu par notre équipe.", "Your access to the platform has been suspended by our team."),
    reactivated: t("Votre accès à la plateforme est de nouveau actif. Vous pouvez vous reconnecter.", "Your access to the platform is active again. You can log in."),
    revoked:     t("Votre statut d'instructeur a été retiré. Votre compte reste utilisable en tant qu'étudiant.", "Your instructor status has been removed. Your account remains usable as a student."),
  } as const;
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">${titles[kind]}</h2>
    <p style="color:#555;font-size:15px;">${t("Bonjour", "Hello")} <strong>${esc(firstName)}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">${bodies[kind]}</p>
    ${reason ? card(`<p style="margin:0;color:#555;font-size:14px;"><strong>${t("Précision de l'équipe", "Note from the team")} :</strong> ${esc(reason)}</p>`) : ""}
    <p style="color:#555;font-size:14px;">${t("Pour toute question, répondez à cet email.", "If you have any question, reply to this email.")}</p>`;
  await sendEmail({ to, subject: titles[kind], html: baseTemplate(content, titles[kind], lang) });
};

// ── Test de connexion SMTP ───────────────────────────
export const testEmailConnection = async (): Promise<boolean> => {
  try {
    const transporter = getTransporter();
    await transporter.verify();
    console.log("Connexion SMTP Brevo OK");
    return true;
  } catch (err: any) {
    console.error("Connexion SMTP échouée:", err.message);
    return false;
  }
};
