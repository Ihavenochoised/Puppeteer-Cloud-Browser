import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pageRouter from './routes/routes.js';
import apiRouter from './routes/api.js';
import http from 'http';
import { WebSocketServer } from 'ws';
import { wireWebSocketServer } from './services/puppeteer.js';
import 'dotenv/config';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));

// 🧩 Routers
app.use('/', pageRouter);
app.use('/api', express.json(), apiRouter);

// 404 fallback
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public/404.html'));
});

// ===== WEBSOCKET SETUP =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wireWebSocketServer(wss, { fps: 15 });

// ===== USER DATABASE SETUP =====
import { addUser, getUserCount } from './services/databaseManager.js';

// ===== SERVER START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));