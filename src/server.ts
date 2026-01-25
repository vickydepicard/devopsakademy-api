import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
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

// Middleware
import { errorHandler } from "./middleware/errorHandler";
import { checkTokenExpiration } from "./middleware/tokenExpiration";

dotenv.config();

const app = express();

// ================== SECURITY ==================
app.use(helmet());

// ================== CORS ==================
const allowedOrigins = process.env.CORS_ORIGINS?.split(",") || [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// ================== BODY ==================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ================== HEALTH ==================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "DevOpsAkademy API is running",
    timestamp: new Date().toISOString(),
  });
});

// ================== TOKEN CHECK ==================
app.use(checkTokenExpiration);

// ================== ROUTES ==================
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

// ================== SWAGGER ==================
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ================== 404 ==================
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// ================== ERRORS ==================
app.use(errorHandler);

console.log("✅ DevOpsAkademy API routes loaded");

export default app;
