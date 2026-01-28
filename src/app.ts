import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import morgan from "morgan";

import swaggerSpec from "./docs/swagger";

// Routes
import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import courseRoutes from "./routes/courses";
import moduleRoutes from "./routes/modules";
import progressRoutes from "./routes/progress";
import forumRoutes from "./routes/forum";
import enrollmentsRoutes from "./routes/enrollments.routes";
import lessonProgressRoutes from "./routes/lessonProgress.routes";
import adminRoutes from "./routes/admin";
import contactRoutes from "./routes/contactRoutes";

import testMailRoute from './routes/test-mail.route';
import mailRoute from './routes/mail.route';



// Middleware
import { errorHandler } from "./middleware/errorHandler";
import { checkTokenExpiration } from "./middleware/tokenExpiration";

dotenv.config();

const app = express();

/* =========================================================
   ⚙️ APP CONFIG
========================================================= */

app.set("trust proxy", true);

/* =========================================================
   🔐 SECURITY
========================================================= */

app.use(helmet());

/* =========================================================
   📝 LOGS
========================================================= */

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

/* =========================================================
   🌍 CORS
========================================================= */

const allowedOrigins: string[] =
  process.env.CORS_ORIGINS?.split(",").map(o => o.trim()) || [];

console.log("🌍 Allowed CORS origins:", allowedOrigins);

app.use(
  cors({
    origin: (origin, callback) => {
      // Autorise Postman / curl / server-to-server
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.error(`❌ CORS blocked: ${origin}`);
      return callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* =========================================================
   📦 BODY PARSING
========================================================= */

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   ❤️ HEALTH CHECK
========================================================= */

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "OK",
    service: "DevOpsAkademy API",
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

/* =========================================================
   🔑 TOKEN CHECK (EXCEPT AUTH & HEALTH)
========================================================= */

app.use((req: Request, res: Response, next: NextFunction) => {
  const openRoutes = ["/health", "/api/auth", "/api-docs"];

  if (openRoutes.some(route => req.originalUrl.startsWith(route))) {
    return next();
  }

  return checkTokenExpiration(req, res, next);
});

/* =========================================================
   🚀 API ROUTES
========================================================= */

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/courses/:courseId/modules", moduleRoutes);
app.use("/api/progress", progressRoutes);
app.use("/api/forum", forumRoutes);
app.use("/api/enrollments", enrollmentsRoutes);
app.use("/api/courses", lessonProgressRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/contacts", contactRoutes);

app.use('/api/test', testMailRoute);
app.use('/api/mails', mailRoute);



/* =========================================================
   📚 SWAGGER
========================================================= */

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/* =========================================================
   ❌ 404 HANDLER
========================================================= */

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

/* =========================================================
   🧯 GLOBAL ERROR HANDLER
========================================================= */

app.use(errorHandler);

console.log("✅ DevOpsAkademy API routes loaded");

export default app;
