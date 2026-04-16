// src/services/mail.service.ts
// Service email universel — Brevo SMTP (nodemailer)
import nodemailer from "nodemailer";

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
    console.error("❌ MAIL_USER ou MAIL_PASSWORD manquant dans .env");
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

    console.log(`✅ Email envoyé → ${to} | ID: ${info.messageId}`);
  } catch (err: any) {
    console.error(`❌ Erreur envoi email → ${to}:`, err.message);
    throw err; // Relancer pour que l'appelant puisse gérer
  }
};

// ══════════════════════════════════════
// TEMPLATES PRÊTS À L'EMPLOI
// ══════════════════════════════════════

// Template HTML de base
function baseTemplate(content: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f3fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3fb;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2d287f,#5653e1);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
            <p style="margin:0;color:#facc15;font-size:22px;font-weight:900;letter-spacing:-0.5px;">DevOps Akademy</p>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.7);font-size:13px;">La plateforme DevOps & Cloud</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#fff;padding:36px 32px;border-radius:0 0 16px 16px;box-shadow:0 4px 24px rgba(45,40,127,0.08);">
            ${content}
            <hr style="border:none;border-top:1px solid #eee;margin:32px 0 24px;" />
            <p style="color:#aaa;font-size:12px;text-align:center;margin:0;">
              © ${new Date().getFullYear()} DevOpsAkademy · Douala, Cameroun<br/>
              <a href="mailto:support@devopsakademy.com" style="color:#5653e1;">support@devopsakademy.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── 1. Bienvenue (inscription) ──────────────────────
export const sendWelcomeEmail = async (
  to: string,
  firstName: string
): Promise<void> => {
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">Bienvenue, ${firstName} 👋</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Votre compte <strong>DevOpsAkademy</strong> a été créé avec succès.
    </p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Vous pouvez dès maintenant explorer notre catalogue de formations DevOps, Cloud et CI/CD.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}courses"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        🚀 Explorer les formations
      </a>
    </div>
    <p style="color:#888;font-size:13px;">Des questions ? Répondez à cet email ou contactez-nous.</p>
  `;
  await sendEmail({ to, subject: "Bienvenue sur DevOpsAkademy 🚀", html: baseTemplate(content, "Bienvenue") });
};

// ── 2. Paiement reçu (en attente de validation) ─────
export const sendPaymentReceivedEmail = async (
  to: string,
  firstName: string,
  courseTitle: string,
  amount: number
): Promise<void> => {
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">Preuve de paiement reçue ✅</h2>
    <p style="color:#555;font-size:15px;">Bonjour <strong>${firstName}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Nous avons bien reçu votre preuve de paiement pour :
    </p>
    <div style="background:#f4f3fb;border-radius:12px;padding:20px 24px;margin:16px 0;">
      <p style="margin:0 0 8px;font-weight:700;color:#2d287f;font-size:16px;">📚 ${courseTitle}</p>
      <p style="margin:0;color:#5653e1;font-weight:700;font-size:20px;">${amount.toLocaleString('fr-FR')} XAF</p>
    </div>
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:16px 20px;margin:16px 0;">
      <p style="margin:0;color:#92400e;font-size:14px;">
        ⏳ <strong>Délai de validation : 24 à 48h ouvrées</strong><br/>
        Vous recevrez un email dès validation de votre accès.
      </p>
    </div>
    <p style="color:#888;font-size:13px;">
      Une question ? Contactez-nous à <a href="mailto:support@devopsakademy.com" style="color:#5653e1;">support@devopsakademy.com</a>
    </p>
  `;
  await sendEmail({ to, subject: `Preuve reçue — ${courseTitle}`, html: baseTemplate(content, "Paiement reçu") });
};

// ── 3. Paiement validé (accès accordé) ──────────────
export const sendPaymentApprovedEmail = async (
  to: string,
  firstName: string,
  courseTitle: string,
  courseId: number
): Promise<void> => {
  const courseUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}courses/${courseId}/learn`;
  const content = `
    <h2 style="color:#059669;margin:0 0 8px;">Paiement validé — Accès accordé ! 🎉</h2>
    <p style="color:#555;font-size:15px;">Bonjour <strong>${firstName}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Bonne nouvelle ! Votre inscription au cours suivant est maintenant <strong>active</strong> :
    </p>
    <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:20px 24px;margin:16px 0;">
      <p style="margin:0;font-weight:700;color:#065f46;font-size:16px;">✅ ${courseTitle}</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${courseUrl}"
        style="background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        ▶ Commencer le cours maintenant
      </a>
    </div>
    <p style="color:#888;font-size:13px;">Bon apprentissage ! L'équipe DevOpsAkademy 🚀</p>
  `;
  await sendEmail({ to, subject: `✅ Accès accordé — ${courseTitle}`, html: baseTemplate(content, "Accès accordé") });
};

// ── 4. Paiement rejeté (re-soumettre) ───────────────
export const sendPaymentRejectedEmail = async (
  to: string,
  firstName: string,
  courseTitle: string,
  reason?: string
): Promise<void> => {
  const paymentsUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}student/payments`;
  const content = `
    <h2 style="color:#dc2626;margin:0 0 8px;">Preuve de paiement refusée ❌</h2>
    <p style="color:#555;font-size:15px;">Bonjour <strong>${firstName}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Votre preuve de paiement pour <strong>${courseTitle}</strong> n'a pas pu être validée.
    </p>
    ${reason ? `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px 20px;margin:16px 0;">
      <p style="margin:0;color:#991b1b;font-size:14px;"><strong>Motif :</strong> ${reason}</p>
    </div>` : ''}
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px 20px;margin:16px 0;">
      <p style="margin:0 0 8px;color:#92400e;font-weight:700;font-size:14px;">Ce que nous vérifions :</p>
      <ul style="margin:0;padding-left:20px;color:#92400e;font-size:13px;line-height:1.8;">
        <li>Le montant correspond exactement au prix du cours</li>
        <li>Le destinataire est bien DevOpsAkademy</li>
        <li>La date de transaction est récente</li>
        <li>Le statut indique « réussi » ou « confirmé »</li>
      </ul>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${paymentsUrl}"
        style="background:linear-gradient(135deg,#dc2626,#ef4444);color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        🔄 Renvoyer une preuve correcte
      </a>
    </div>
  `;
  await sendEmail({ to, subject: `Preuve refusée — ${courseTitle}`, html: baseTemplate(content, "Paiement refusé") });
};

// ── 5. Certificat émis ───────────────────────────────
export const sendCertificateEmail = async (
  to: string,
  firstName: string,
  courseTitle: string,
  certificateNumber: string
): Promise<void> => {
  const certUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}certificates/verify/${certificateNumber}`;
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">Félicitations, vous avez réussi ! 🎓</h2>
    <p style="color:#555;font-size:15px;">Bonjour <strong>${firstName}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Vous avez complété avec succès la formation :
    </p>
    <div style="background:linear-gradient(135deg,#2d287f15,#5653e115);border:2px solid #5653e1;border-radius:12px;padding:20px 24px;margin:16px 0;text-align:center;">
      <p style="margin:0 0 8px;font-weight:900;color:#2d287f;font-size:18px;">🏆 ${courseTitle}</p>
      <p style="margin:0;color:#5653e1;font-size:13px;font-weight:600;">Certificat N° ${certificateNumber}</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${certUrl}"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        📜 Voir mon certificat
      </a>
    </div>
    <p style="color:#888;font-size:13px;">Partagez votre réussite sur LinkedIn ! L'équipe DevOpsAkademy 🚀</p>
  `;
  await sendEmail({ to, subject: `🎓 Certificat obtenu — ${courseTitle}`, html: baseTemplate(content, "Certificat") });
};

// ── 6. Réinitialisation mot de passe ────────────────
export const sendPasswordResetEmail = async (
  to: string,
  firstName: string,
  resetToken: string
): Promise<void> => {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">Réinitialisation de mot de passe 🔑</h2>
    <p style="color:#555;font-size:15px;">Bonjour <strong>${firstName}</strong>,</p>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous :
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${resetUrl}"
        style="background:linear-gradient(135deg,#2d287f,#5653e1);color:#fff;text-decoration:none;
               padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;display:inline-block;">
        🔑 Réinitialiser mon mot de passe
      </a>
    </div>
    <div style="background:#f4f3fb;border-radius:12px;padding:14px 20px;margin:16px 0;">
      <p style="margin:0;color:#555;font-size:13px;">
        ⚠️ Ce lien expire dans <strong>30 minutes</strong>.<br/>
        Si vous n'avez pas fait cette demande, ignorez cet email.
      </p>
    </div>
  `;
  await sendEmail({ to, subject: "Réinitialisation de mot de passe", html: baseTemplate(content, "Reset password") });
};

// ── 7. Contact reçu (admin) ──────────────────────────
export const sendContactNotificationEmail = async (
  adminEmail: string,
  senderName: string,
  senderEmail: string,
  subject: string,
  message: string
): Promise<void> => {
  const content = `
    <h2 style="color:#2d287f;margin:0 0 8px;">Nouveau message de contact 📩</h2>
    <div style="background:#f4f3fb;border-radius:12px;padding:20px 24px;margin:16px 0;">
      <p style="margin:0 0 6px;"><strong>Nom :</strong> ${senderName}</p>
      <p style="margin:0 0 6px;"><strong>Email :</strong> <a href="mailto:${senderEmail}" style="color:#5653e1;">${senderEmail}</a></p>
      <p style="margin:0 0 6px;"><strong>Sujet :</strong> ${subject}</p>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px 24px;margin:16px 0;">
      <p style="margin:0;color:#555;white-space:pre-wrap;font-size:15px;line-height:1.7;">${message}</p>
    </div>
  `;
  await sendEmail({
    to: adminEmail,
    subject: `Contact: ${subject}`,
    html: baseTemplate(content, "Nouveau contact"),
    replyTo: senderEmail,
  });
};

// ── Test de connexion SMTP ───────────────────────────
export const testEmailConnection = async (): Promise<boolean> => {
  try {
    const transporter = getTransporter();
    await transporter.verify();
    console.log("✅ Connexion SMTP Brevo OK");
    return true;
  } catch (err: any) {
    console.error("❌ Connexion SMTP échouée:", err.message);
    return false;
  }
};