// src/routes/mail.route.ts — DevOpsAkademy
import { Router, Request, Response } from 'express';
import { sendEmail } from '../services/mail.service';

const router = Router();

/**
 * POST /api/mails/test
 * Test d'envoi email (dev uniquement)
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'email requis',
      });
    }

    await sendEmail({
      to: email,
      subject: 'Test email — DevOpsAkademy',
      html: '<h2>Email de test 🚀</h2><p>Si vous recevez ceci, Brevo fonctionne correctement.</p>',
    });

    return res.status(200).json({
      success: true,
      message: 'Email envoyé avec succès',
    });
  } catch (error: any) {
    console.error('MAIL ERROR:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'envoi du mail",
      error: error.message,
    });
  }
});

export default router;