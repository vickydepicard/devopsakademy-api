// Le driver MariaDB renvoie COUNT(*)/SUM() en BigInt, que JSON.stringify ne sait pas sérialiser (→ erreur 500).
// On les convertit globalement en nombres.
(BigInt.prototype as any).toJSON = function () { return Number(this); };

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { getAllCategories } from "./controllers/adminController";
import helmet from "helmet";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import morgan from "morgan";

import swaggerSpec from "./docs/swagger";

// Routes
import authRoutes           from "./routes/auth";
import userRoutes           from "./routes/users";
import courseRoutes         from "./routes/courses";
import moduleRoutes         from "./routes/modules";
import progressRoutes       from "./routes/progress";
import forumRoutes          from "./routes/forum";
import { getPublicSettings } from "./controllers/settingsController";
import enrollmentsRoutes    from "./routes/enrollments.routes";
import lessonProgressRoutes from "./routes/lessonProgress.routes";
import adminRoutes          from "./routes/admin";
import contactRoutes        from "./routes/contactRoutes";
import testMailRoute        from "./routes/test-mail.route";
import mailRoute            from "./routes/mail.route";
import profileRoutes        from "./routes/Profileroutes";
import bootcampRoutes      from "./routes/bootcamp.routes"; // Bootcamps
import certificateRoutes    from "./routes/certificate.routes"; // NOUVEAU
import notificationRoutes    from "./routes/notification.routes";
import uploadsRoutes         from "./routes/uploads.routes";
import { ensureNotificationsTable } from "./services/notification.service";
import { ensureUserLanguageColumn } from "./utils/lang";
import instructorAppRoutes   from "./routes/instructor.routes";       // Candidatures instructeur
import instructorPortalRoutes from "./routes/instructorPortal.routes"; // Espace instructeur
import quizRoutes             from "./routes/quiz.routes";             // Quiz (étudiant)
import leaderboardRoutes      from "./routes/leaderboard.routes";      // Classement public
import subscriptionRoutes     from "./routes/subscription.routes";     // Abonnements
import paymentRoutes          from "./routes/payment.routes";          // Preuves de paiement
import submissionRoutes       from "./routes/submission";              // Devoirs

// Middleware
import { errorHandler }         from "./middleware/errorHandler";
import { checkTokenExpiration }  from "./middleware/tokenExpiration";

dotenv.config();

const app = express();

app.set("trust proxy", true);
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ── CORS ─────────────────────────────────────────────────────────────────
// Origines autorisées = CORS_ORIGINS (séparées par des virgules) + FRONTEND_URL.
// Normalisées (sans "/" final) pour éviter les faux refus ("https://site.com/" ≠ "https://site.com").
const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, "");

const allowedOrigins: string[] = [
  ...(process.env.CORS_ORIGINS?.split(",") || []),
  process.env.FRONTEND_URL || "",
].map(normalizeOrigin).filter(Boolean);

// En développement : toute origine localhost / 127.0.0.1 (Vite 5173, CRA 3000, preview 4173…)
const isLocalDevOrigin = (o: string) =>
  process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

console.log("Allowed CORS origins:", allowedOrigins, "(+ localhost en dev)");

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // curl, Postman, server-to-server
    const o = normalizeOrigin(origin);
    if (allowedOrigins.includes(o) || isLocalDevOrigin(o)) return callback(null, true);
    // Ne pas passer une Error : cela produit un 500 sans en-têtes CORS.
    // On refuse simplement les en-têtes CORS ; le navigateur bloque la requête.
    console.error(`CORS blocked: ${origin} — ajoutez-la à CORS_ORIGINS dans .env`);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With", "Range"],
  exposedHeaders: ["X-Token-Expiring-Soon", "Content-Range", "Accept-Ranges", "Content-Length"],
  maxAge: 86400,
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Fichiers statiques uploadés (vidéos, PDFs, ressources cours) ──
import path from "path";
import fs from "fs";
import { tr } from "./utils/lang";

// Headers CORS + Accept-Ranges explicites pour tous les fichiers /uploads
// Critique pour le streaming vidéo MP4 (le navigateur envoie des Range requests)
app.use("/uploads", (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin || "";
  if (!origin || allowedOrigins.includes(normalizeOrigin(origin)) || isLocalDevOrigin(normalizeOrigin(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.setHeader("Accept-Ranges", "bytes");
  // helmet() impose « same-origin » par défaut : le front (autre domaine) ne pourrait pas afficher
  // les images et vidéos uploadées dans <img>/<video>. Ces fichiers sont publics par nature.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Express static avec Range request support (streaming vidéo)
const staticOpts = {
  dotfiles: "deny" as const,
  etag: true,
  lastModified: true,
  setHeaders: (res: Response, filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".mp4":  "video/mp4",
      ".webm": "video/webm",
      ".ogg":  "video/ogg",
      ".mov":  "video/quicktime",
      ".pdf":  "application/pdf",
      ".png":  "image/png",
      ".jpg":  "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif":  "image/gif",
      ".webp": "image/webp",
      ".svg":  "image/svg+xml",
    };
    if (mimeMap[ext]) res.setHeader("Content-Type", mimeMap[ext]);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Accept-Ranges", "bytes");
  },
};

// Servir les fichiers uploadés depuis plusieurs chemins possibles
const uploadDirs = [
  path.join(process.cwd(), "uploads"),
  path.join(__dirname, "..", "uploads"),
  path.join(__dirname, "uploads"),
  path.resolve("uploads"),
];
uploadDirs.forEach(dir => {
  if (fs.existsSync(dir)) {
    app.use("/uploads", express.static(dir, staticOpts));
    console.log("Serving uploads from:", dir);
  }
});

// Debug log : afficher quels dossiers uploads existent au démarrage
const _uploadCheck = [
  path.join(process.cwd(), "uploads"),
  path.join(__dirname, "..", "uploads"),
  path.join(__dirname, "uploads"),
].map(d => `${d}: ${fs.existsSync(d) ? "EXISTS" : "NOT FOUND"}`);
console.log("Upload dirs:", _uploadCheck.join(" | "));

// Fallback magic bytes pour fichiers sans extension (multer dest sans extension)
app.use("/uploads", (req: Request, res: Response, next: NextFunction) => {
  const ext = path.extname(req.path).toLowerCase();
  if (ext) return next(); // a déjà une extension → déjà servi

  const filePath  = path.join(process.cwd(), "uploads", req.path);
  const altPath   = path.join(__dirname, "..", "uploads", req.path);
  const altPath2  = path.join(__dirname, "uploads", req.path);
  const altPath3  = path.resolve("uploads", req.path);
  const target    = [filePath, altPath, altPath2, altPath3].find(p => fs.existsSync(p)) || null;
  if (!target) return next();

  try {
    const buf = Buffer.alloc(12);
    const fd = fs.openSync(target, "r");
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);

    let mime = "application/octet-stream";
    if (buf[0] === 0x89 && buf[1] === 0x50)                                   mime = "image/png";
    else if (buf[0] === 0xFF && buf[1] === 0xD8)                               mime = "image/jpeg";
    else if (buf[0] === 0x47 && buf[1] === 0x49)                               mime = "image/gif";
    else if (buf[0] === 0x52 && buf[1] === 0x49)                               mime = "image/webp";
    else if (buf[0] === 0x25 && buf[1] === 0x50)                               mime = "application/pdf";
    // MP4 : ftyp box à l'offset 4
    else if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) mime = "video/mp4";

    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(target);
  } catch {
    next();
  }
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "OK",
    service: "DevOpsAkademy API",
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// Routes publiques (pas de token check)
app.use((req: Request, res: Response, next: NextFunction) => {
  const openRoutes = [
    "/health",
    "/api/auth",
    "/api-docs",
    "/api/certificates/verify", // vérification publique
    "/uploads",                  // Fichiers statiques (preuves paiement, vidéos, ressources)
  ];
  if (openRoutes.some(r => req.originalUrl.startsWith(r))) return next();
  return checkTokenExpiration(req, res, next);
});

// ── API ROUTES ──
app.use("/api/auth",         authRoutes);
app.get("/api/categories", getAllCategories); // liste publique (formulaire de cours, filtres)
app.use("/api/users",        userRoutes);
app.use("/api/courses",      courseRoutes);
app.use("/api/courses/:courseId/modules", moduleRoutes);
app.use("/api/progress",     progressRoutes);
app.get("/api/settings/public", getPublicSettings as any);
app.use("/api/forum",        forumRoutes);
app.use("/api/enrollments",  enrollmentsRoutes);
app.use("/api/courses",      lessonProgressRoutes);
app.use("/api/admin",        adminRoutes);
// Espace instructeur : routes dédiées avec contrôle de propriété du cours
// (avant : alias vers le routeur admin → 403 pour tous les instructeurs)
app.use("/api/instructor",   instructorPortalRoutes);
app.use("/api/quizzes",      quizRoutes);
app.use("/api/contacts",     contactRoutes);
app.use("/api/uploads",      uploadsRoutes);
app.use("/api/test",         testMailRoute);
app.use("/api/mails",        mailRoute);
app.use("/api/profile",      profileRoutes);
app.use("/api/bootcamps",  bootcampRoutes);   // Bootcamps & Lives
app.use("/api/certificates", certificateRoutes); // NOUVEAU
app.use("/api/instructor-applications", instructorAppRoutes);  // Candidatures instructeur
app.use("/api/notifications", notificationRoutes); // Notifications in-app + SSE
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/submissions", submissionRoutes);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, message: tr(req, `Route ${req.originalUrl} not found`, `Route ${req.originalUrl} not found`) });
});

app.use(errorHandler);

ensureNotificationsTable().catch(e => console.error("Table notifications:", e.message));
ensureUserLanguageColumn().catch(e => console.error("Colonne users.preferred_language:", e.message));

console.log("DevOpsAkademy API routes loaded");

export default app;