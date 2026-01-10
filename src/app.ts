import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express"
import swaggerSpec from "./docs/swagger"


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
dotenv.config()

// ================== MIDDLEWARE ==================
app.use(helmet());
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://172.27.93.136',
  'http://172.27.93.136:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Postman / curl
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));


app.options('*', cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ================== HEALTH ==================

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Vérifie l’état de l’API
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: API opérationnelle
 */

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "DevOpsAkademy API is running",
    timestamp: new Date().toISOString(),
  });
});

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
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec))


// Vérification expiration token
app.use(checkTokenExpiration);


// ================== 404 ==================
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// ================== ERRORS ==================
app.use(errorHandler);


console.log("✅ Routes chargées : auth, users, courses, modules, enrollments");



export default app;
