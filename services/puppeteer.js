import puppeteerVanilla from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import sharp from 'sharp';
import getRuntime from './getRuntime.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import * as databaseManager from './databaseManager.js'

puppeteerExtra.use(StealthPlugin());

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Runtime helper ────────────────────────────────────────────────────────────

let runtime = getRuntime();
console.log(`[puppeteer] detected runtime: ${runtime}`);
async function resolveLaunchOptions(profile = 'default') {
    if (runtime === 'replit') {
        const { stdout } = await promisify(exec)('which chromium');
        return {
            executablePath: stdout.trim(),
            headless: 'new',
            userDataDir: `./userData/${profile}`,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
        };
    } else if (runtime === 'render') {
        return {
            headless: 'new',
            userDataDir: `./userData/${profile}`,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
        };
    } else if (runtime === 'windows') {
        return {
            headless: 'new',
            userDataDir: `./userData/${profile}`,
        };
    }
    return { headless: 'new' };
}

async function launchBrowser(opts) {
    // puppeteer-extra wraps launch and injects stealth patches before the
    // browser starts — must use it instead of vanilla puppeteer.launch()
    return puppeteerExtra.launch(opts);
}

// ─── Session map  (socket → session) ───────────────────────────────────────────
//
//  session shape:
//  {
//    browser    : Puppeteer.Browser
//    tabs       : Array<{ page: Puppeteer.Page, url: string | null, title: string }>
//    activeTab  : number               // index into tabs[]
//    streaming  : boolean
//    intervalId : NodeJS.Timeout | null
//    pendingFps : number               // stored until first navigate
//  }

const sessions = new Map();

function activePage(session) {
    return session.tabs[session.activeTab].page;
}

// Blocklist: prevent navigation to local file URLs
function isBlockedUrl(url) {
    if (typeof url !== 'string') return false;
    return /^\s*file:/i.test(url);
}

// ─── Tab helpers ───────────────────────────────────────────────────────────────

async function makeTab(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(USER_AGENT);
    // Route all downloads to ./downloads instead of the OS default temp dir
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior:     'allow',
        downloadPath: './downloads',
    });
    const tab = { page, url: null, title: 'New Tab' };
    // Keep tab metadata fresh after any navigation settles (redirects, CAPTCHA, etc.)
    // 'domcontentloaded' fires once the final page is parsed — after all redirects.
    // We debounce so rapid redirect chains only produce one pushTabState call.
    let navTimer = null;
    const syncTab = async () => {
        tab.url   = page.url();
        tab.title = await page.title().catch(() => tab.url);
        if (tab._onNavigate) tab._onNavigate();
    };
    page.on('domcontentloaded', () => {
        clearTimeout(navTimer);
        navTimer = setTimeout(syncTab, 100);
    });
    // Also catch client-side navigations (SPA pushState/replaceState)
    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        clearTimeout(navTimer);
        navTimer = setTimeout(syncTab, 100);
    });
    return tab;
}

/** Sends the full tab list state to the client so it can re-render the tab bar. */
function pushTabState(socket, session) {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({
        type:      'tabs',
        activeTab: session.activeTab,
        tabs: session.tabs.map((t, i) => ({
            index: i,
            url:   t.url   ?? '',
            title: t.title ?? 'New Tab',
        })),
    }));
}

// ─── Session lifecycle ─────────────────────────────────────────────────────────

async function createSession(socket, { fps = 10, profile = 'default', ephemeral = false } = {}) {
    const launchOpts = await resolveLaunchOptions(profile);
    const browser    = await launchBrowser(launchOpts);
    const firstTab   = await makeTab(browser);

    const session = {
        browser,
        tabs:       [firstTab],
        activeTab:  0,
        streaming:  false,       // starts after first navigate
        intervalId: null,
        pendingFps: fps,
        profile,
        ephemeral,               // if true, delete userDataDir on disconnect
    };

    sessions.set(socket, session);

    browser.on('disconnected', () => {
        console.warn('[puppeteer] browser disconnected unexpectedly');
        destroySession(socket);
    });

    // Close any popup/window opened by a page (window.open, target=_blank, etc.)
    // so they don't accumulate as invisible zombie targets eating memory.
    browser.on('targetcreated', async (target) => {
        if (target.type() !== 'page') return;
        // If this target was opened by one of our tracked pages it's a popup — kill it
        const opener = target.opener();
        if (!opener) return;
        const popup = await target.page().catch(() => null);
        if (popup) await popup.close().catch(() => {});
    });

    // Wire each tab's navigation callback now that session + socket are known
    session.tabs.forEach(tab => {
        tab._onNavigate = () => pushTabState(socket, session);
    });

    // Send initial tab state so client renders one blank tab immediately
    pushTabState(socket, session);

    console.log(`[session] created — active sessions: ${sessions.size}`);
    return session;
}

async function destroySession(socket) {
    const session = sessions.get(socket);
    if (!session) return;

    stopStreaming(socket);

    try { await session.browser.close(); }
    catch (e) { console.error('[session] error closing browser:', e.message); }

    const { profile, ephemeral } = session;
    sessions.delete(socket);
    console.log(`[session] destroyed — active sessions: ${sessions.size}`);

    if (ephemeral && profile) {
        const dir = `./userData/${profile}`;
        rm(dir, { recursive: true, force: true })
            .then(() => console.log(`[session] deleted ephemeral profile: ${dir}`))
            .catch(e => console.warn(`[session] failed to delete ${dir}:`, e.message));
    }
}

// ─── Navigation ────────────────────────────────────────────────────────────────

async function navigateTab(socket, tabIndex, url) {
    const session = sessions.get(socket);
    if (!session) throw new Error('No session for this socket');

    const tab = session.tabs[tabIndex];
    if (!tab) throw new Error(`No tab at index ${tabIndex}`);

    try {
        if (isBlockedUrl(url)) {
            console.warn('[navigate] blocked attempt to open file URL:', url);
            try {
                if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'navigateError', error: 'file URLs are not allowed' }));
            } catch {}
            return;
        }

        await tab.page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
        tab.url   = tab.page.url();
        tab.title = await tab.page.title() || tab.url;
        await new Promise(r => setTimeout(r, 300));
    } catch (e) {
        console.warn('[navigate] failed:', e.message);
    }

    pushTabState(socket, session);

    // Start streaming on first ever navigation
    if (!session.intervalId) startStreaming(socket, session.pendingFps);
}

// ─── Tab management ────────────────────────────────────────────────────────────

async function newTab(socket, url = null) {
    const session = sessions.get(socket);
    if (!session) throw new Error('No session for this socket');

    const tab = await makeTab(session.browser);
    tab._onNavigate = () => pushTabState(socket, session);
    session.tabs.push(tab);
    session.activeTab = session.tabs.length - 1;

    pushTabState(socket, session);

    if (url) {
        if (isBlockedUrl(url)) {
            console.warn('[newTab] blocked attempt to open file URL:', url);
            try { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'navigateError', error: 'file URLs are not allowed' })); } catch {}
            return;
        }
        await navigateTab(socket, session.activeTab, url);
    }
}

async function closeTab(socket, tabIndex) {
    const session = sessions.get(socket);
    if (!session) throw new Error('No session for this socket');

    if (session.tabs.length === 1) {
        // Last tab — treat as full disconnect
        destroySession(socket);
        socket.close();
        return;
    }

    const tab = session.tabs[tabIndex];
    try { await tab.page.close(); } catch {}

    session.tabs.splice(tabIndex, 1);

    // Keep activeTab in bounds
    if (session.activeTab >= session.tabs.length) {
        session.activeTab = session.tabs.length - 1;
    } else if (session.activeTab > tabIndex) {
        session.activeTab--;
    }

    pushTabState(socket, session);
}

function switchTab(socket, tabIndex) {
    const session = sessions.get(socket);
    if (!session) throw new Error('No session for this socket');
    if (!session.tabs[tabIndex]) throw new Error(`No tab at index ${tabIndex}`);

    session.activeTab = tabIndex;
    if (session._resetDelta) session._resetDelta();
    pushTabState(socket, session);
}

// ─── Delta encoding ───────────────────────────────────────────────────────────
//
//  Binary packet format sent over WebSocket:
//
//    [0]      type    : 0 = full frame, 1 = patch
//    [1-2]    x       : uint16 patch origin x (0 for full frame)
//    [3-4]    y       : uint16 patch origin y (0 for full frame)
//    [5-6]    w       : uint16 patch width    (frame width for full frame)
//    [7-8]    h       : uint16 patch height   (frame height for full frame)
//    [9...]   payload : JPEG bytes
//
const FRAME_W         = 1280;
const FRAME_H         = 720;
const FULL_FRAME_EVERY = 60;   // force full frame every N ticks to prevent drift
const DIFF_THRESHOLD  = 15;    // per-channel difference to count a pixel as changed

function buildHeader(type, x, y, w, h) {
    const buf = Buffer.alloc(9);
    buf.writeUInt8(type,  0);
    buf.writeUInt16BE(x,  1);
    buf.writeUInt16BE(y,  3);
    buf.writeUInt16BE(w,  5);
    buf.writeUInt16BE(h,  7);
    return buf;
}

/**
 * Finds the bounding box of pixels that differ between two raw RGB buffers.
 * Returns null if nothing changed.
 */
function diffBounds(prev, next, width, height) {
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let changed = false;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3; // RGB
            if (
                Math.abs(next[i]   - prev[i])   > DIFF_THRESHOLD ||
                Math.abs(next[i+1] - prev[i+1]) > DIFF_THRESHOLD ||
                Math.abs(next[i+2] - prev[i+2]) > DIFF_THRESHOLD
            ) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                changed = true;
            }
        }
    }

    return changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
}

// ─── Streaming ─────────────────────────────────────────────────────────────────

function startStreaming(socket, fps = 10) {
    const session = sessions.get(socket);
    if (!session || session.intervalId) return;

    const intervalMs = Math.max(20, Math.round(1000 / Math.max(1, fps)));

    let prevRaw   = null;
    let tickCount = 0;

    session._resetDelta = () => {
        prevRaw   = null;
        tickCount = 0;
    };

    session.streaming  = true;
    session.intervalId = true;  // truthy sentinel so callers know streaming is active

    // Self-scheduling loop — awaits each tick fully before starting the next.
    // This means there is never more than one screenshot in-flight at a time,
    // which is the root cause of stale frames appearing after tab switches.
    const loop = async () => {
        while (session.streaming && sessions.has(socket)) {
            const start      = Date.now();
            const currentTab = session.activeTab;  // snapshot BEFORE any await

            try {
                const page   = activePage(session);
                const pngBuf = await page.screenshot({ type: 'png' });

                // Tab changed while we were screenshotting — discard and loop
                if (session.activeTab !== currentTab) {
                    prevRaw   = null;
                    tickCount = 0;
                } else {
                    const { data: rawBuf } = await sharp(pngBuf)
                        .resize(FRAME_W, FRAME_H)
                        .removeAlpha()
                        .raw()
                        .toBuffer({ resolveWithObject: true });

                    // Check again after the sharp decode
                    if (session.activeTab !== currentTab) {
                        prevRaw   = null;
                        tickCount = 0;
                    } else {
                        tickCount++;
                        const forceFull = !prevRaw || tickCount % FULL_FRAME_EVERY === 0;

                        if (forceFull) {
                            const jpeg = await sharp(rawBuf, { raw: { width: FRAME_W, height: FRAME_H, channels: 3 } })
                                .jpeg({ quality: 50 })
                                .toBuffer();
                            const packet = Buffer.concat([buildHeader(0, 0, 0, FRAME_W, FRAME_H), jpeg]);
                            if (socket.readyState === socket.OPEN) socket.send(packet);
                        } else {
                            const bounds = diffBounds(prevRaw, rawBuf, FRAME_W, FRAME_H);
                            if (bounds) {
                                const patch = await sharp(rawBuf, { raw: { width: FRAME_W, height: FRAME_H, channels: 3 } })
                                    .extract({ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h })
                                    .jpeg({ quality: 50 })
                                    .toBuffer();
                                const packet = Buffer.concat([buildHeader(1, bounds.x, bounds.y, bounds.w, bounds.h), patch]);
                                if (socket.readyState === socket.OPEN) socket.send(packet);
                            }
                        }

                        prevRaw = rawBuf;
                    }
                }
            } catch (err) {
                const detached = err.message.includes('Not attached to an active page')
                              || err.message.includes('Target closed')
                              || err.message.includes('Session closed');
                if (!detached) console.error('[stream] error:', err.message);
            }

            // Wait out the remainder of the interval
            const elapsed = Date.now() - start;
            const wait    = Math.max(0, intervalMs - elapsed);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
        }
        session.intervalId = null;
    };

    loop();
}

function stopStreaming(socket) {
    const session = sessions.get(socket);
    if (!session || !session.intervalId) return;
    // intervalId is now a sentinel boolean, not a real interval —
    // setting streaming=false causes the loop to exit naturally
    session.streaming  = false;
    session.intervalId = null;
}

// ─── WebSocket message handler ─────────────────────────────────────────────────
//
//  Message types:
//    { type: "navigate",   url: "https://…" }       — navigate active tab
//    { type: "newtab",     url?: "https://…" }       — open new tab
//    { type: "closetab",   index: 0 }                — close tab by index
//    { type: "switchtab",  index: 0 }                — switch active tab
//    { type: "pause" }
//    { type: "resume" }
//    { type: "mousemove",  x, y }
//    { type: "click",      x, y }
//    { type: "rightclick", x, y }
//    { type: "scroll",     x, y }
//    { type: "type",       text }

async function handleWebSocketMessage(socket, raw) {
    const session = sessions.get(socket);
    if (!session) { console.warn('[ws] no session — ignoring'); return; }

    let msg;
    try { msg = JSON.parse(raw); }
    catch { console.warn('[ws] non-JSON ignored:', raw); return; }

    const page = activePage(session);

    switch (msg.type) {

        case 'navigate':
            await navigateTab(socket, session.activeTab, msg.url);
            break;

        case 'refresh':
            await activePage(session).reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            break;

        case 'newtab':
            await newTab(socket, msg.url ?? null);
            break;

        case 'closetab':
            await closeTab(socket, msg.index ?? session.activeTab);
            break;

        case 'switchtab':
            switchTab(socket, msg.index);
            break;

        case 'pause':
            session.streaming = false;
            break;

        case 'resume':
            session.streaming = true;
            break;

        case 'mousemove':
            await page.mouse.move(msg.x ?? 0, msg.y ?? 0);
            break;

        case 'click':
            await page.mouse.click(msg.x ?? 0, msg.y ?? 0);
            break;

        case 'rightclick':
            await page.mouse.click(msg.x ?? 0, msg.y ?? 0, { button: 'right' });
            break;

        case 'scroll':
            await page.mouse.wheel({ deltaX: msg.x ?? 0, deltaY: msg.y ?? 0 });
            break;

        case 'type':
            await page.keyboard.type(msg.text ?? '');
            break;

        case 'keydown':
            await page.keyboard.down(msg.key);
            break;

        case 'keyup':
            await page.keyboard.up(msg.key);
            break;

        default:
            console.warn('[ws] unknown message type:', msg.type);
    }
}

// ─── WSS wiring ────────────────────────────────────────────────────────────────

// ─── Auth helpers ──────────────────────────────────────────────────────────────

const HANDSHAKE_TIMEOUT_MS = 10_000;

function rejectAuth(socket, reason) {
    console.warn('[wss] auth rejected:', reason);
    try {
        if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'authError', error: reason }));
        }
    } catch {}
    socket.close();
}

function profileInUse(profile) {
    for (const s of sessions.values()) {
        if (s.profile === profile) return true;
    }
    return false;
}

function wireWebSocketServer(wss, opts = {}) {
    wss.on('connection', (socket) => {
        console.log('[wss] new connection — waiting for connect handshake');

        socket.on('close', () => { console.log('[wss] closed'); destroySession(socket); });
        socket.on('error', (err) => { console.error('[wss] error:', err.message); destroySession(socket); });

        // Drop the connection if the client never sends a handshake.
        const handshakeTimer = setTimeout(() => {
            rejectAuth(socket, 'handshake timeout');
        }, HANDSHAKE_TIMEOUT_MS);

        // First message must be { type: 'connect', profile, password }
        // Defer browser launch until we know which userDataDir the client wants.
        socket.once('message', async (raw) => {
            clearTimeout(handshakeTimer);

            let msg;
            try { msg = JSON.parse(raw); }
            catch { return rejectAuth(socket, 'handshake must be JSON'); }

            if (!msg || msg.type !== 'connect') {
                return rejectAuth(socket, 'first message must be { type: "connect" }');
            }

            // Sanitise profile: alphanumeric, hyphens, underscores only, max 64 chars
            const rawProfile = typeof msg.profile === 'string' ? msg.profile : '';
            const cleanProfile = rawProfile.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

            let profile;
            let ephemeral = false;

            if (!cleanProfile || cleanProfile === 'default') {
                // Anonymous session — unique throwaway dir, no DB lookup, no password required.
                profile   = `default-${randomUUID()}`;
                ephemeral = true;
            } else {
                // Named profile — require password and authenticate against the DB.
                const password = typeof msg.password === 'string' ? msg.password : '';
                if (!password) {
                    return rejectAuth(socket, 'password required for named profile');
                }

                try {
                    if (databaseManager.checkUser(cleanProfile)) {
                        // Existing user — verify password.
                        if (!databaseManager.checkPassword(cleanProfile, password)) {
                            return rejectAuth(socket, 'invalid credentials');
                        }
                    } else {
                        // New user — register on first connect.
                        databaseManager.addUser(cleanProfile, password);
                    }
                } catch (err) {
                    return rejectAuth(socket, `auth error: ${err.message}`);
                }

                // Refuse a second concurrent session on the same userDataDir —
                // Chromium holds an exclusive lock on it, so the second launch
                // would either fail or corrupt the profile.
                if (profileInUse(cleanProfile)) {
                    return rejectAuth(socket, 'profile already in use by another session');
                }

                profile = cleanProfile;
            }

            console.log(`[wss] starting session — profile: ${profile}${ephemeral ? ' (ephemeral)' : ''}`);

            try {
                await createSession(socket, { ...opts, profile, ephemeral });
            } catch (err) {
                console.error('[wss] failed to create session:', err);
                socket.close();
                return;
            }

            socket.on('message', (data) => handleWebSocketMessage(socket, data));
        });
    });
}

// ─── Shutdown ──────────────────────────────────────────────────────────────────

async function closeAllSessions() {
    await Promise.allSettled([...sessions.keys()].map(destroySession));
    console.log('[puppeteer] all sessions closed');
}

process.on('SIGINT',  async () => { await closeAllSessions(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllSessions(); process.exit(0); });

// ─── Exports ───────────────────────────────────────────────────────────────────

export {
    wireWebSocketServer,
    createSession,
    destroySession,
    navigateTab,
    newTab,
    closeTab,
    switchTab,
    startStreaming,
    stopStreaming,
    handleWebSocketMessage,
    closeAllSessions,
    sessions,
};