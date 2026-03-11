import puppeteerVanilla from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import sharp from 'sharp';
import getRuntime from './getRuntime.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

puppeteerExtra.use(StealthPlugin());

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Runtime helper ────────────────────────────────────────────────────────────

async function resolveLaunchOptions() {
    if (getRuntime() === 'replit') {
        const { stdout } = await promisify(exec)('which chromium');
        return {
            executablePath: stdout.trim(),
            headless: 'new',
            userDataDir: './userData',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
        };
    } else if (getRuntime() === 'render') {
        return {
            headless: 'new',
            userDataDir: './userData',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
        };
    }
    return { headless: 'new' };
}

async function launchBrowser() {
    const opts = await resolveLaunchOptions();
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

async function createSession(socket, { fps = 10 } = {}) {
    const launchOpts = await resolveLaunchOptions();
    const browser    = await launchBrowser();
    const firstTab   = await makeTab(browser);

    const session = {
        browser,
        tabs:       [firstTab],
        activeTab:  0,
        streaming:  false,       // starts after first navigate
        intervalId: null,
        pendingFps: fps,
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

    sessions.delete(socket);
    console.log(`[session] destroyed — active sessions: ${sessions.size}`);
}

// ─── Navigation ────────────────────────────────────────────────────────────────

async function navigateTab(socket, tabIndex, url) {
    const session = sessions.get(socket);
    if (!session) throw new Error('No session for this socket');

    const tab = session.tabs[tabIndex];
    if (!tab) throw new Error(`No tab at index ${tabIndex}`);

    try {
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

    if (url) await navigateTab(socket, session.activeTab, url);
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
    // Reset delta state so we don't diff the new tab against the old tab's pixels
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

    // Delta state — stored per streaming session, reset on tab switch
    let prevRaw   = null;   // raw RGB Buffer of last sent frame
    let tickCount = 0;

    // Reset delta state whenever the active tab changes so we don't diff
    // across two completely different pages
    const origSwitchTab = session._resetDelta;
    session._resetDelta = () => { prevRaw = null; tickCount = 0; };

    session.streaming  = true;
    session.intervalId = setInterval(async () => {
        if (!session.streaming) return;

        try {
            const page = activePage(session);

            // Always capture as raw PNG so we get lossless pixels for diffing
            const pngBuf = await page.screenshot({ type: 'png' });

            // Decode to raw RGB (3 channels — alpha not needed for diffing)
            const { data: rawBuf } = await sharp(pngBuf)
                .resize(FRAME_W, FRAME_H)
                .removeAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });

            tickCount++;
            const forceFull = !prevRaw || tickCount % FULL_FRAME_EVERY === 0;

            if (forceFull) {
                // Full frame — encode as JPEG and send with type=0 header
                const jpeg = await sharp(rawBuf, { raw: { width: FRAME_W, height: FRAME_H, channels: 3 } })
                    .jpeg({ quality: 50 })
                    .toBuffer();
                const packet = Buffer.concat([buildHeader(0, 0, 0, FRAME_W, FRAME_H), jpeg]);
                if (socket.readyState === socket.OPEN) socket.send(packet);
            } else {
                // Diff against previous frame
                const bounds = diffBounds(prevRaw, rawBuf, FRAME_W, FRAME_H);

                if (bounds) {
                    // Crop just the changed region and JPEG encode it
                    const patch = await sharp(rawBuf, { raw: { width: FRAME_W, height: FRAME_H, channels: 3 } })
                        .extract({ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h })
                        .jpeg({ quality: 50 })
                        .toBuffer();
                    const packet = Buffer.concat([buildHeader(1, bounds.x, bounds.y, bounds.w, bounds.h), patch]);
                    if (socket.readyState === socket.OPEN) socket.send(packet);
                }
                // If bounds is null, nothing changed — send nothing at all
            }

            prevRaw = rawBuf;

        } catch (err) {
            const detached = err.message.includes('Not attached to an active page')
                          || err.message.includes('Target closed')
                          || err.message.includes('Session closed');
            if (!detached) console.error('[stream] error:', err.message);
            // mid-navigation: framenavigated listener will sync tab state once settled
        }
    }, intervalMs);
}

function stopStreaming(socket) {
    const session = sessions.get(socket);
    if (!session || !session.intervalId) return;
    clearInterval(session.intervalId);
    session.intervalId = null;
    session.streaming  = false;
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

function wireWebSocketServer(wss, opts = {}) {
    wss.on('connection', async (socket) => {
        console.log('[wss] new connection');
        try {
            await createSession(socket, opts);
        } catch (err) {
            console.error('[wss] failed to create session:', err);
            socket.close();
            return;
        }

        socket.on('message', (data) => handleWebSocketMessage(socket, data));
        socket.on('close',   ()     => { console.log('[wss] closed'); destroySession(socket); });
        socket.on('error',   (err)  => { console.error('[wss] error:', err.message); destroySession(socket); });
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