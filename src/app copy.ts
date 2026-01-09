import express from "express"
import cors from "cors"
import helmet from "helmet"
import dotenv from "dotenv"

// Import routes
import authRoutes from "./routes/auth"
import userRoutes from "./routes/users"
import courseRoutes from "./routes/courses"
import moduleRoutes from "./routes/modules"
import progressRoutes from "./routes/progress"
import forumRoutes from "./routes/forum"
import enrollmentsRoutes from "./routes/enrollments.routes"
import lessonProgressRoutes from "./routes/lessonProgress.routes"


import adminRoutes from "./routes/admin"

// Import middleware
import { errorHandler } from "./middleware/errorHandler"
import { checkTokenExpiration } from "./middleware/tokenExpiration"

import contactRoutes from "./routes/contactRoutes";


dotenv.config()

const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(helmet())
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173", // ✅ corrigé pour Vite
    credentials: true,
  })
)
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true }))

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "DevOpsAkademy API is running",
    timestamp: new Date().toISOString(),
  })
})

// ================== ROUTES ==================


// ================== ROUTES ==================
app.use("/api/auth", authRoutes)
app.use("/api/users", userRoutes)
app.use("/api/courses", courseRoutes)
app.use("/api/courses/:courseId/modules", moduleRoutes) // ✅ c'est ici qu'on branche
app.use("/api/progress", progressRoutes)
app.use("/api/forum", forumRoutes)
app.use("/api/enrollments", enrollmentsRoutes)
app.use("/api/courses", lessonProgressRoutes)    // Progression des leçons
app.use("/api/admin", adminRoutes); // ✅ ← ajoute ceci



console.log("✅ Routes chargées : courses, modules, enrollments");


app.use("/api/contacts", contactRoutes);


// Vérification expiration token
app.use(checkTokenExpiration)

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  })
})

// Error handling middleware
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📚 DevOpsAkademy API started`)
  console.log(`🔗 Health check: http://localhost:${PORT}/health`)
})

export default app
