import 'dotenv/config'; 
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pageRouter from "./routes/routes.js";
import apiRouter from "./routes/api.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(express.static(path.join(__dirname, "public")));

// 🧩 Routers
app.use("/", pageRouter);
app.use("/api", express.json(), apiRouter);

// 404 fallback
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, "public/pages/404/index.html"));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
