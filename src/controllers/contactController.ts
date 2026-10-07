import { Request, Response } from "express";
import { query } from "../config/database";
import { notifyAdmins } from "../services/notification.service";
import { sendContactReceivedEmail } from "../services/mail.service";
import { langFromReq } from "../utils/lang";
import { tr } from "../utils/lang";

// Créer un contact
export const createContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      res.status(400).json({
        success: false,
        message: tr(req, "Tous les champs sont obligatoires.", "All fields are required."),
      });
      return;
    }

    const sql =
      "INSERT INTO contacts (name, email, subject, message, created_at) VALUES (?, ?, ?, ?, NOW())";
    await query(sql, [name, email, subject, message]);

    // Notifier les admins (non bloquant)
    void notifyAdmins(
      {
        type: "new_contact",
        title: `Nouveau message de contact : ${String(subject).slice(0, 80)}`,
        message: `De ${name} <${email}>

${String(message).slice(0, 500)}`,
        link: "/admin/messages",
      },
      { emailReplyTo: email }
    );

    // Accusé de réception dans la langue du visiteur (non bloquant)
    void sendContactReceivedEmail(email, name, subject, langFromReq(req))
      .catch(e => console.warn("Accusé de réception contact:", e.message));

    res.status(201).json({
      success: true,
      message: langFromReq(req) === "en" ? "Message saved successfully." : "Message enregistré avec succès.",
    });
  } catch (error) {
    console.error("Erreur lors de la création du contact :", error);
    res.status(500).json({
      success: false,
      message: tr(req, "Erreur serveur lors de l'enregistrement du message.", "Server error while saving the message."),
    });
  }
};

// Récupérer tous les contacts (pour admin)
export const getContacts = async (_req: Request, res: Response): Promise<void> => {
  try {
    const sql = "SELECT * FROM contacts ORDER BY created_at DESC";
    const result = await query(sql);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("Erreur lors de la récupération des contacts :", error);
    res.status(500).json({
      success: false,
      message: tr(_req, "Erreur serveur lors du chargement des messages.", "Server error while loading messages."),
    });
  }
};

// Récupérer un contact par ID
export const getContactById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const sql = "SELECT * FROM contacts WHERE id = ?";
    const result = await query(sql, [id]);

    if (!result || result.length === 0) {
      res.status(404).json({ success: false, message: tr(req, "Message introuvable.", "Message not found.") });
      return;
    }

    res.status(200).json({ success: true, data: result[0] });
  } catch (error) {
    console.error("Erreur lors de la récupération du contact :", error);
    res.status(500).json({
      success: false,
      message: tr(req, "Erreur serveur.", "Server error."),
    });
  }
};

// Supprimer un message
export const deleteContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const sql = "DELETE FROM contacts WHERE id = ?";
    const result = await query(sql, [id]);

    if (result.affectedRows === 0) {
      res.status(404).json({ success: false, message: tr(req, "Message introuvable.", "Message not found.") });
      return;
    }

    res.status(200).json({ success: true, message: tr(req, "Message supprimé avec succès.", "Message deleted successfully.") });
  } catch (error) {
    console.error("Erreur lors de la suppression du message :", error);
    res.status(500).json({
      success: false,
      message: tr(req, "Erreur serveur lors de la suppression du message.", "Server error while deleting the message."),
    });
  }
};


// PATCH /api/contacts/:id/handled — marquer un message comme traité / non traité
export const setContactHandled = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    const handled = req.body?.is_handled === false || req.body?.is_handled === 0 ? 0 : 1;
    const adminId = (req as any).user?.id ?? null;
    const result = await query(
      "UPDATE contacts SET is_handled = ?, handled_by = ?, handled_at = ? WHERE id = ?",
      [handled, handled ? adminId : null, handled ? new Date() : null, id]
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ success: false, message: tr(req, "Message introuvable.", "Message not found.") });
      return;
    }
    res.json({ success: true, data: { id, is_handled: handled } });
  } catch (error) {
    console.error("setContactHandled error:", error);
    res.status(500).json({ success: false, message: tr(req, "Erreur serveur", "Server error") });
  }
};
