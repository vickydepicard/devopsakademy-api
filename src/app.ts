import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
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
import enrollmentsRoutes    from "./routes/enrollments.routes";
import lessonProgressRoutes from "./routes/lessonProgress.routes";
import adminRoutes          from "./routes/admin";
import contactRoutes        from "./routes/contactRoutes";
import testMailRoute        from "./routes/test-mail.route";
import mailRoute            from "./routes/mail.route";
import profileRoutes        from "./routes/Profileroutes";
import certificateRoutes    from "./routes/certificate.routes"; // ✅ NOUVEAU
import reviewRoutes          from "./routes/reviews.routes";
import instructorAppRoutes   from "./routes/instructor.routes";       // ✅ Reviews

import instructorApplicationRoutes from './routes/instructor.routes';

// Middleware
import { errorHandler }         from "./middleware/errorHandler";
import { checkTokenExpiration }  from "./middleware/tokenExpiration";

dotenv.config();

const app = express();

app.set("trust proxy", true);
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

const allowedOrigins: string[] =
  process.env.CORS_ORIGINS?.split(",").map(o => o.trim()) || [];
console.log("🌍 Allowed CORS origins:", allowedOrigins);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.error(`❌ CORS blocked: ${origin}`);
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Fichiers statiques uploadés (vidéos, PDFs, ressources cours) ──
// IMPORTANT: avant les routes API pour que /uploads soit accessible
import path from "path";
// ✅ Servir les uploads avec Content-Type forcé pour les fichiers sans extension
// Nécessaire car multer { dest } sauvegarde sans extension
// Le navigateur ne peut pas deviner le type → on lit la signature du fichier (magic bytes)
app.use("/uploads", (req: Request, res: Response, next: NextFunction) => {
  const filePath = path.join(process.cwd(), "uploads", req.path);
  const altPath  = path.join(__dirname, "..", "uploads", req.path);

  const fs = require("fs");
  const target = fs.existsSync(filePath) ? filePath : fs.existsSync(altPath) ? altPath : null;
  if (!target) return next();

  // Si pas d'extension → détecter le type depuis les magic bytes
  const ext = path.extname(req.path).toLowerCase();
  if (ext && ext !== ".htm" && ext !== ".html") return next(); // a déjà une bonne extension

  try {
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(target, "r");
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);

    // Magic bytes detection
    let mime = "image/jpeg"; // défaut
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = "image/png";
    else if (buf[0] === 0x47 && buf[1] === 0x49) mime = "image/gif";
    else if (buf[0] === 0x52 && buf[1] === 0x49) mime = "image/webp";
    else if (buf[0] === 0x25 && buf[1] === 0x50) mime = "application/pdf";
    else if (buf[0] === 0xFF && buf[1] === 0xD8) mime = "image/jpeg";

    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(target);
  } catch {
    next();
  }
});

// Fallback statique normal
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

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
    "/uploads",                  // ✅ Fichiers statiques (preuves paiement, vidéos, ressources)
  ];
  if (openRoutes.some(r => req.originalUrl.startsWith(r))) return next();
  return checkTokenExpiration(req, res, next);
});

// ── API ROUTES ──
app.use("/api/auth",         authRoutes);
app.use("/api/users",        userRoutes);
app.use("/api/courses",      courseRoutes);
app.use("/api/courses/:courseId/modules", moduleRoutes);
app.use("/api/progress",     progressRoutes);
app.use("/api/forum",        forumRoutes);
app.use("/api/enrollments",  enrollmentsRoutes);
app.use("/api/courses",      lessonProgressRoutes);
app.use("/api/admin",        adminRoutes);
app.use("/api/contacts",     contactRoutes);
app.use("/api/test",         testMailRoute);
app.use("/api/mails",        mailRoute);
app.use("/api/profile",      profileRoutes);
app.use("/api/certificates", certificateRoutes); // ✅ NOUVEAU
app.use("/api/courses",      reviewRoutes);
app.use("/api/instructor-applications", instructorAppRoutes);  // ✅ Candidatures instructeur      // ✅ Reviews (POST/GET /:courseId/reviews)
app.use('/api/instructor-applications', instructorApplicationRoutes);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

app.use(errorHandler);

console.log("✅ DevOpsAkademy API routes loaded");

export default app;