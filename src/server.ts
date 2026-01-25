import app from "./app";
import dotenv from "dotenv";

dotenv.config();

const PORT: number = Number(process.env.PORT) || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});
