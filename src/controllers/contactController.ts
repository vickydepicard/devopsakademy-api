import { Request, Response } from "express";
import { query } from "../config/database";

// ✅ Créer un contact
export const createContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      res.status(400).json({
        success: false,
        message: "Tous les champs sont obligatoires.",
      });
      return;
    }

    const sql =
      "INSERT INTO contacts (name, email, subject, message, created_at) VALUES (?, ?, ?, ?, NOW())";
    await query(sql, [name, email, subject, message]);

    res.status(201).json({
      success: true,
      message: "Message enregistré avec succès.",
    });
  } catch (error) {
    console.error("❌ Erreur lors de la création du contact :", error);
    res.status(500).json({
      success: false,
      message: "Erreur serveur lors de l'enregistrement du message.",
    });
  }
};

// ✅ Récupérer tous les contacts (pour admin)
export const getContacts = async (_req: Request, res: Response): Promise<void> => {
  try {
    const sql = "SELECT * FROM contacts ORDER BY created_at DESC";
    const result = await query(sql);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("❌ Erreur lors de la récupération des contacts :", error);
    res.status(500).json({
      success: false,
      message: "Erreur serveur lors du chargement des messages.",
    });
  }
};

// ✅ Récupérer un contact par ID
export const getContactById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const sql = "SELECT * FROM contacts WHERE id = ?";
    const result = await query(sql, [id]);

    if (!result || result.length === 0) {
      res.status(404).json({ success: false, message: "Message introuvable." });
      return;
    }

    res.status(200).json({ success: true, data: result[0] });
  } catch (error) {
    console.error("❌ Erreur lors de la récupération du contact :", error);
    res.status(500).json({
      success: false,
      message: "Erreur serveur.",
    });
  }
};

// ✅ Supprimer un message
export const deleteContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const sql = "DELETE FROM contacts WHERE id = ?";
    const result = await query(sql, [id]);

    if (result.affectedRows === 0) {
      res.status(404).json({ success: false, message: "Message introuvable." });
      return;
    }

    res.status(200).json({ success: true, message: "Message supprimé avec succès." });
  } catch (error) {
    console.error("❌ Erreur lors de la suppression du message :", error);
    res.status(500).json({
      success: false,
      message: "Erreur serveur lors de la suppression du message.",
    });
  }
};

