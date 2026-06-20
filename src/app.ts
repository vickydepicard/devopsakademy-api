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
import bootcampRoutes      from "./routes/bootcamp.routes"; // ✅ Bootcamps
import certificateRoutes    from "./routes/certificate.routes"; // ✅ NOUVEAU
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
import path from "path";
import fs from "fs";

// ✅ Headers CORS + Accept-Ranges explicites pour tous les fichiers /uploads
// Critique pour le streaming vidéo MP4 (le navigateur envoie des Range requests)
app.use("/uploads", (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin || "";
  if (allowedOrigins.includes(origin) || !origin) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.setHeader("Accept-Ranges", "bytes");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ✅ Express static avec Range request support (streaming vidéo)
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
    };
    if (mimeMap[ext]) res.setHeader("Content-Type", mimeMap[ext]);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Accept-Ranges", "bytes");
  },
};

app.use("/uploads", express.static(path.join(process.cwd(), "uploads"), staticOpts));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads"), staticOpts));

// ✅ Fallback magic bytes pour fichiers sans extension (multer dest sans extension)
app.use("/uploads", (req: Request, res: Response, next: NextFunction) => {
  const ext = path.extname(req.path).toLowerCase();
  if (ext) return next(); // a déjà une extension → déjà servi

  const filePath = path.join(process.cwd(), "uploads", req.path);
  const altPath  = path.join(__dirname, "..", "uploads", req.path);
  const target   = fs.existsSync(filePath) ? filePath : fs.existsSync(altPath) ? altPath : null;
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
// Routes instructor (alias vers admin pour modules/lessons)
app.use("/api/instructor",   adminRoutes); // même controller, auth vérifie le rôle
app.use("/api/contacts",     contactRoutes);
app.use("/api/test",         testMailRoute);
app.use("/api/mails",        mailRoute);
app.use("/api/profile",      profileRoutes);
app.use("/api/bootcamps",  bootcampRoutes);   // ✅ Bootcamps & Lives
app.use("/api/certificates", certificateRoutes); // ✅ NOUVEAU
app.use("/api/instructor-applications", instructorAppRoutes);  // ✅ Candidatures instructeur      // ✅ Reviews (POST/GET /:courseId/reviews)
app.use('/api/instructor-applications', instructorApplicationRoutes);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

app.use(errorHandler);

console.log("✅ DevOpsAkademy API routes loaded");

export default app;