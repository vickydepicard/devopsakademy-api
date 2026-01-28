import { Router, Request, Response } from 'express';
import { sendEmail } from '../services/mail.service';

const router = Router();

/**
 * @route   POST /api/mails/test
 * @desc    Test SendGrid en local (Postman)
 * @access  Public (local only)
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    // 🔒 Validation minimale
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'email is required',
      });
    }

    await sendEmail({
      to: email,
      subject: 'Test SendGrid - DevOpsAkademy',
      html: `
        <h2>Email de test SendGrid</h2>
        <p>Envoyé depuis Postman 🚀</p>
      `,
    });

    return res.status(200).json({
      success: true,
      message: 'Email envoyé avec succès',
    });
  } catch (error: any) {
    console.error('MAIL ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Erreur lors de l’envoi du mail',
      error: error.message,
    });
  }
});

export default router;
