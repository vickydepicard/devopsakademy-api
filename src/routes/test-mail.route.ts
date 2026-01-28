import { Router } from 'express';
import { sendEmail } from '../services/mail.service';

const router = Router();

router.post('/test-sendgrid', async (req, res) => {
  try {
    await sendEmail({
      to: req.body.email,
      subject: 'Test SendGrid Local',
      html: '<h2>Email envoyé depuis le local 🚀</h2>',
    });

    res.json({ success: true, message: 'Email envoyé' });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Erreur SendGrid',
      error: error.message,
    });
  }
});

export default router;
