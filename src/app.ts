// src/app.ts — DevOpsAkademy API
// VERSION CORRIGÉE — conserve tous les imports originaux + corrige les doublons

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import morgan from "morgan";
import path from "path";
import cookieParser from "cookie-parser";

import swaggerSpec from "./docs/swagger";

// ── Routes ──────────────────────────────────────────────────────
import authRoutes            from "./routes/auth";
import userRoutes            from "./routes/users";
import courseRoutes          from "./routes/courses";
import moduleRoutes          from "./routes/modules";
import progressRoutes        from "./routes/progress";
import forumRoutes           from "./routes/forum";
import enrollmentsRoutes     from "./routes/enrollments.routes";
import lessonProgressRoutes  from "./routes/lessonProgress.routes";
import adminRoutes           from "./routes/admin";
import contactRoutes         from "./routes/contactRoutes";
import testMailRoute         from "./routes/test-mail.route";
import mailRoute             from "./routes/mail.route";
import profileRoutes         from "./routes/Profileroutes";
import certificateRoutes     from "./routes/certificate.routes";
import reviewRoutes          from "./routes/reviews.routes";
import instructorAppRoutes   from "./routes/instructor.routes";
import submissionRoutes      from "./routes/submission";

// ── Middleware ───────────────────────────────────────────────────
import { errorHandler }         from "./middleware/errorHandler";
import { checkTokenExpiration }  from "./middleware/tokenExpiration";

dotenv.config();

const app = express();

app.set("trust proxy", true);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(cookieParser());

// ── CORS ────────────────────────────────────────────────────────
const allowedOrigins: string[] =
  process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) || [];

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
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── Fichiers statiques ───────────────────────────────────────────
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ── Health check ─────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "OK",
    service: "DevOpsAkademy API",
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ── Token expiration check ────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const openRoutes = [
    "/health",
    "/api/auth",
    "/api-docs",
    "/api/certificates/verify",
    "/api/contacts",
  ];
  if (openRoutes.some((r) => req.originalUrl.startsWith(r))) return next();
  return checkTokenExpiration(req, res, next);
});

// ── API ROUTES ───────────────────────────────────────────────────
app.use("/api/auth",                      authRoutes);
app.use("/api/users",                     userRoutes);
app.use("/api/courses",                   courseRoutes);
app.use("/api/courses/:courseId/modules", moduleRoutes);
app.use("/api/progress",                  progressRoutes);
app.use("/api/forum",                     forumRoutes);
app.use("/api/enrollments",               enrollmentsRoutes);
app.use("/api/courses",                   lessonProgressRoutes);
app.use("/api/admin",                     adminRoutes);
app.use("/api/contacts",                  contactRoutes);
app.use("/api/test",                      testMailRoute);
app.use("/api/mails",                     mailRoute);
app.use("/api/profile",                   profileRoutes);
app.use("/api/certificates",              certificateRoutes);
app.use("/api/courses",                   reviewRoutes);
app.use("/api/instructor-applications",   instructorAppRoutes); // ✅ un seul mount
app.use("/api/submissions",               submissionRoutes);

// ── Swagger ───────────────────────────────────────────────────────
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── 404 ───────────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// ── Error handler ─────────────────────────────────────────────────
app.use(errorHandler);

console.log("✅ DevOpsAkademy API routes loaded");

export default app;