import { query } from "../config/database";

export interface Contact {
  id?: number;
  name: string;
  email: string;
  subject: string;
  message: string;
  created_at?: Date;
}

// ➕ Créer un contact
export const createContact = async (contact: Contact): Promise<any> => {
  const sql = `
    INSERT INTO contacts (name, email, subject, message, created_at)
    VALUES (?, ?, ?, ?, NOW())
  `;
  const params = [contact.name, contact.email, contact.subject, contact.message];
  return query(sql, params);
};

// 📋 Récupérer tous les contacts
export const getAllContacts = async (): Promise<Contact[]> => {
  const sql = `SELECT * FROM contacts ORDER BY created_at DESC`;
  return query(sql);
};

// 🔍 Récupérer un contact par ID
export const getContactById = async (id: number): Promise<Contact | null> => {
  const sql = `SELECT * FROM contacts WHERE id = ?`;
  const result = await query(sql, [id]);
  return result.length ? result[0] : null;
};
