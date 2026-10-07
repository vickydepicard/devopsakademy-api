// Import de fichiers depuis l'ordinateur : image (miniature), vidéo (aperçu), document.
// Retourne l'URL publique à enregistrer dans le champ concerné.
import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { authenticate, authorizeRoles } from "../middleware/auth";
import { publicBaseUrl } from "../utils/publicUrl";
import { tr } from "../utils/lang";

const router = Router();

const KINDS: Record<string, { dir: string; max: number; mime: RegExp }> = {
  image: { dir: "library/images", max: 10 * 1024 * 1024, mime: /^image\/(jpeg|png|webp|gif|svg\+xml)$/i },
  video: { dir: "library/videos", max: 2 * 1024 * 1024 * 1024, mime: /^video\// },
  file: {
    dir: "library/files", max: 200 * 1024 * 1024,
    mime: /^(application\/(pdf|zip|x-zip-compressed|json|msword|vnd\.ms-(powerpoint|excel)|vnd\.openxmlformats-officedocument\.[a-z.]+)|text\/(plain|markdown)|image\/(jpeg|png|webp|gif))$/i,
  },
};

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(process.cwd(), "uploads", KINDS[(req as any).params.kind].dir);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
  },
});

const validKind = (req: Request, res: Response, next: any) => {
  if (!KINDS[req.params.kind]) return res.status(400).json({ success: false, message: tr(req, "Type d'import invalide", "Invalid upload type") });
  next();
};

const receive = (req: Request, res: Response, next: any) => {
  const k = KINDS[req.params.kind];
  multer({
    storage, limits: { fileSize: k.max },
    fileFilter: (_r, f, cb) => (k.mime.test(f.mimetype) ? cb(null, true) : cb(new Error("UNSUPPORTED"))),
  }).single("file")(req, res, (err: any) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    res.status(tooBig ? 413 : 400).json({
      success: false,
      message: tooBig ? tr(req, "Fichier trop volumineux", "File too large") : tr(req, "Format de fichier non pris en charge", "Unsupported file format"),
    });
  });
};

router.post("/:kind", authenticate, authorizeRoles(["admin", "superadmin", "instructor"]), validKind, receive, (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ success: false, message: tr(req, "Aucun fichier reçu", "No file received") });
  const url = `${publicBaseUrl(req)}/uploads/${KINDS[req.params.kind].dir}/${file.filename}`;
  res.json({ success: true, data: { url, file_name: file.originalname, size: file.size } });
});

export default router;
