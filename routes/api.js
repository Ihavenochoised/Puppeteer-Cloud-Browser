import express from 'express';
import { sessions, closeAllSessions, navigateTab } from '../services/puppeteer.js';

const router = express.Router();

// ─── General ───────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
    res.json({ message: 'Welcome to the API 🚀' });
});

router.get('/status', (req, res) => {
    res.json({ uptime: process.uptime(), status: 'OK', time: new Date() });
});

// ─── Session info ──────────────────────────────────────────────────────────────

// GET /api/sessions
// Returns a snapshot of all active browser sessions (safe — no raw socket/browser objects)
router.get('/sessions', (req, res) => {
    const snapshot = [...sessions.entries()].map(([_, session], i) => ({
        index:     i,
        streaming: session.streaming,
        tabCount:  session.tabs.length,
        activeTab: session.activeTab,
        tabs: session.tabs.map((t, ti) => ({ index: ti, url: t.url, title: t.title })),
    }));
    res.json({ count: snapshot.length, sessions: snapshot });
});

// ─── Admin controls ────────────────────────────────────────────────────────────

// POST /api/admin/close-all
// Body: { "password": "…" }  OR  Authorization: Bearer <PASSWORD>
router.post('/admin/close-all', async (req, res) => {
    const provided = req.body?.password ?? req.headers.authorization?.replace('Bearer ', '');
    if (provided !== process.env.PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    await closeAllSessions();
    res.json({ message: 'All sessions closed', remaining: sessions.size });
});

// ─── Stream control (REST convenience wrappers) ────────────────────────────────
//
//  These let you control a specific session by its index in the sessions Map.
//  For real-time control prefer sending WS messages directly from the client.

function getSessionByIndex(index) {
    return [...sessions.entries()][index] ?? null; // [socket, session] | null
}

// POST /api/stream/navigate   body: { index: 0, url: "https://…" }
router.post('/stream/navigate', async (req, res) => {
    const { index = 0, url } = req.body ?? {};
    if (!url) return res.status(400).json({ error: '`url` is required' });

    const entry = getSessionByIndex(index);
    if (!entry) return res.status(404).json({ error: `No session at index ${index}` });

    const [socket] = entry;
    await navigateTab(socket, entry[1].activeTab, url);
    res.json({ message: `Session ${index} navigated to ${url}` });
});

// POST /api/stream/pause      body: { index: 0 }
router.post('/stream/pause', (req, res) => {
    const { index = 0 } = req.body ?? {};
    const entry = getSessionByIndex(index);
    if (!entry) return res.status(404).json({ error: `No session at index ${index}` });

    entry[1].streaming = false;
    res.json({ message: `Session ${index} paused` });
});

// POST /api/stream/resume     body: { index: 0 }
router.post('/stream/resume', (req, res) => {
    const { index = 0 } = req.body ?? {};
    const entry = getSessionByIndex(index);
    if (!entry) return res.status(404).json({ error: `No session at index ${index}` });

    entry[1].streaming = true;
    res.json({ message: `Session ${index} resumed` });
});

// ─── Export ────────────────────────────────────────────────────────────────────

export default router;