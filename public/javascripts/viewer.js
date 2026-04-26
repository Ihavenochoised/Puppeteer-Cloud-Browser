// ── State ──────────────────────────────────────────────────────────────────────
let ws = null;
let tabs = []; // [{ index, url, title }]
let activeTab = 0;
let connected = false;
let waitingForFullFrame = false; // set on tab switch, cleared when full frame arrives
let authRejected = false;        // set when server sends authError, suppresses generic close toast

// ── Elements ───────────────────────────────────────────────────────────────────
const tabBar = document.getElementById("tab-bar");
const btnNewTab = document.getElementById("btn-new-tab");
const urlInput = document.getElementById("url-input");
const btnGo = document.getElementById("btn-go");
const btnRefresh = document.getElementById("btn-refresh");
const btnStop = document.getElementById("btn-stop");
const streamImg = document.getElementById("stream");
const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const placeholder = document.getElementById("placeholder");
const profileInput = document.getElementById("profile-input");
const passwordInput = document.getElementById("password-input");

// ── Status ─────────────────────────────────────────────────────────────────────
function setStatus(state, text) {
    dot.className = "dot " + (state ?? "");
    statusText.textContent = text;
}

// ── Toast notifications ────────────────────────────────────────────────────────
const toastContainer = document.getElementById("toast-container");

function showToast(message, type = "info", durationMs = 4500) {
    if (!toastContainer) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const msg = document.createElement("span");
    msg.className = "toast-msg";
    msg.textContent = message;

    const close = document.createElement("span");
    close.className = "toast-close";
    close.textContent = "×";
    close.title = "Dismiss";

    toast.appendChild(msg);
    toast.appendChild(close);
    toastContainer.appendChild(toast);

    // Animate in on next frame so the transition runs
    requestAnimationFrame(() => toast.classList.add("show"));

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        toast.classList.remove("show");
        // Wait for fade-out to finish before removing from the DOM
        setTimeout(() => toast.remove(), 200);
    };

    close.addEventListener("click", dismiss);
    if (durationMs > 0) setTimeout(dismiss, durationMs);
}

// ── Tab bar rendering ──────────────────────────────────────────────────────────
function renderTabs() {
    // Remove all existing tab elements (keep the + button)
    [...tabBar.querySelectorAll(".tab")].forEach((el) => el.remove());

    tabs.forEach((tab) => {
        const el = document.createElement("div");
        el.className = "tab" + (tab.index === activeTab ? " active" : "");
        el.dataset.index = tab.index;

        const label = document.createElement("span");
        label.className = "tab-title";
        label.textContent = tab.title || tab.url || "New Tab";
        label.title = tab.url || "";

        const close = document.createElement("span");
        close.className = "tab-close";
        close.textContent = "×";
        close.title = "Close tab";
        close.addEventListener("click", (e) => {
            e.stopPropagation();
            send({ type: "closetab", index: tab.index });
        });

        el.appendChild(label);
        el.appendChild(close);

        el.addEventListener("click", () => {
            if (tab.index !== activeTab) {
                send({ type: "switchtab", index: tab.index });
            }
        });

        // Insert before the + button
        tabBar.insertBefore(el, btnNewTab);
    });

    // Update URL bar to show active tab's URL
    const active = tabs.find((t) => t.index === activeTab);
    if (active) urlInput.value = active.url || "";
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
        connected = true;
        authRejected = false;
        // Server still has to validate credentials before this is truly "live" —
        // the status flips to "connected" once the first tab state arrives.
        setStatus("", "authenticating…");
        btnGo.disabled = false;
        btnGo.textContent = "Go";
        btnStop.disabled = false;
        btnNewTab.style.pointerEvents = "";
        profileInput.disabled = true;  // lock while session is live
        passwordInput.disabled = true; // lock while session is live (parity with profile)
        urlInput.disabled = false;
        btnRefresh.disabled = false;

        // Tell server which profile (userDataDir) to use for this session
        const profile = profileInput.value.trim() || "default";
        const password = passwordInput.value;
        send({ type: "connect", profile, password });

        // Navigate immediately if URL was already typed before connecting
        const url = urlInput.value.trim();
        if (url) send({ type: "navigate", url });
    });

    ws.addEventListener("message", async (e) => {
        // Binary = delta packet  [ type(1) x(2) y(2) w(2) h(2) JPEG... ]
        if (e.data instanceof ArrayBuffer) {
            const dv = new DataView(e.data);
            const type = dv.getUint8(0);
            const x = dv.getUint16(1);
            const y = dv.getUint16(3);
            const w = dv.getUint16(5);
            const h = dv.getUint16(7);
            const payload = e.data.slice(9);

            // After a tab switch, ignore patches until a full frame arrives
            if (type === 1 && waitingForFullFrame) return;
            waitingForFullFrame = false;

            const blob = new Blob([payload], { type: "image/jpeg" });
            const bmp = await createImageBitmap(blob);
            const ctx = streamImg.getContext("2d");

            if (type === 0) {
                // Full frame — resize canvas if needed and draw
                if (streamImg.width !== w || streamImg.height !== h) {
                    streamImg.width = w;
                    streamImg.height = h;
                }
                ctx.drawImage(bmp, 0, 0);
            } else {
                // Patch — composite at the given offset
                ctx.drawImage(bmp, x, y);
            }

            bmp.close();

            if (!streamImg.classList.contains("visible")) {
                streamImg.classList.add("visible");
                placeholder.classList.add("hidden");
            }
            return;
        }

        // JSON = control message
        try {
            const msg = JSON.parse(e.data);

            if (msg.type === "authError") {
                // Server rejected the handshake — show the reason and let the
                // close handler reset the UI. Mark authRejected so we don't
                // also show a generic "disconnected" toast on top.
                authRejected = true;
                showToast(msg.error || "authentication failed", "error", 6000);
                return;
            }

            if (msg.type === "tabs") {
                // First tabs message after open = handshake succeeded.
                if (statusText.textContent === "authenticating…") {
                    setStatus("live", "connected");
                }
                const prevActive = activeTab;
                tabs = msg.tabs;
                activeTab = msg.activeTab;
                if (prevActive !== activeTab) {
                    waitingForFullFrame = true; // ignore patches until next full frame
                    const ctx = streamImg.getContext("2d");
                    ctx.clearRect(0, 0, streamImg.width, streamImg.height);
                }
                renderTabs();
            }
        } catch {}
    });

    ws.addEventListener("close", () => {
        connected = false;
        setStatus(authRejected ? "error" : "", authRejected ? "auth rejected" : "disconnected");
        btnGo.disabled = false;
        btnGo.textContent = "Connect";
        btnStop.disabled = true;
        profileInput.disabled = false; // allow changing profile before next connect
        passwordInput.disabled = false;
        urlInput.disabled = true;
        btnRefresh.disabled = true;
        streamImg.classList.remove("visible");
        placeholder.classList.remove("hidden");
    });

    ws.addEventListener("error", () => {
        setStatus("error", "connection error");
        // Only surface a generic error toast if we didn't already get a
        // specific authError from the server (which is more useful).
        if (!authRejected) showToast("connection error", "error");
    });
}

function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Button handlers ────────────────────────────────────────────────────────────
btnGo.addEventListener("click", () => {
    if (!connected) {
        setStatus("", "connecting…");
        btnGo.disabled = true;
        connect(); // URL will be sent automatically on open
    } else {
        const url = urlInput.value.trim();
        if (url) send({ type: "navigate", url });
    }
});

btnStop.addEventListener("click", () => {
    send({ type: "pause" });
    ws?.close();
});

btnRefresh.addEventListener("click", () => {
    send({ type: "refresh" });
});

btnNewTab.addEventListener("click", () => {
    if (!connected) return;
    send({ type: "newtab" });
});

// ── URL bar: navigate on Enter ─────────────────────────────────────────────────
urlInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;

    if (!connected) {
        setStatus("", "connecting…");
        btnGo.disabled = true;
        connect(); // URL will be sent automatically on open
    } else {
        const url = urlInput.value.trim();
        if (url) send({ type: "navigate", url });
    }
});

// ── Mouse forwarding ───────────────────────────────────────────────────────────
function toRemote(clientX, clientY) {
    const rect = streamImg.getBoundingClientRect();
    const cW = streamImg.width || 1280;
    const cH = streamImg.height || 720;
    const scale = Math.min(rect.width / cW, rect.height / cH);
    const offX = (rect.width - cW * scale) / 2;
    const offY = (rect.height - cH * scale) / 2;
    return {
        x: Math.round((clientX - rect.left - offX) / scale),
        y: Math.round((clientY - rect.top - offY) / scale),
    };
}

let lastMove = 0;
streamImg.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - lastMove < 16) return;
    lastMove = now;
    const { x, y } = toRemote(e.clientX, e.clientY);
    send({ type: "mousemove", x, y });
});

streamImg.addEventListener("click", (e) => {
    const { x, y } = toRemote(e.clientX, e.clientY);
    send({ type: "click", x, y });
});

streamImg.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const { x, y } = toRemote(e.clientX, e.clientY);
    send({ type: "rightclick", x, y });
});

streamImg.addEventListener(
    "wheel",
    (e) => {
        e.preventDefault();
        send({
            type: "scroll",
            x: Math.round(e.deltaX),
            y: Math.round(e.deltaY),
        });
    },
    { passive: false },
);

// ── Keyboard forwarding ────────────────────────────────────────────────────────
// Puppeteer key names match the DOM KeyboardEvent.key spec almost exactly,
// with a few remaps needed for special keys.
const KEY_REMAP = {
    " ": "Space",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
};

// Keys we want to forward but also need to suppress in the browser
const SUPPRESS = new Set([
    "Tab",
    "Backspace",
    "Delete",
    "Enter",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    " ",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
]);

// Only forward keys when the user has "clicked into" the stream
let streamFocused = false;
streamImg.addEventListener("click", () => {
    streamFocused = true;
    streamImg.style.outline = "2px solid #0a0a0a";
});
// Lose focus only when clicking outside the stream, not just mousing away —
// otherwise Shift+/ ('?') never reaches the remote page because mouseleave
// fires the moment you move toward the keyboard.
document.addEventListener("click", (e) => {
    if (e.target !== streamImg) {
        streamFocused = false;
        streamImg.style.outline = "";
    }
});

document.addEventListener("keydown", (e) => {
    if (!streamFocused || !connected) return;

    // Always let Ctrl/Cmd+R, Ctrl/Cmd+W etc. through to the real browser
    if (e.metaKey || e.ctrlKey) return;

    if (SUPPRESS.has(e.key)) e.preventDefault();

    const key = KEY_REMAP[e.key] ?? e.key;
    send({ type: "keydown", key });
});

document.addEventListener("keyup", (e) => {
    if (!streamFocused || !connected) return;
    if (e.metaKey || e.ctrlKey) return;
    const key = KEY_REMAP[e.key] ?? e.key;
    send({ type: "keyup", key });
});

// ── Mobile keyboard ────────────────────────────────────────────────────────────
// On touch devices there's no physical keyboard — tapping the stream focuses a
// hidden <input> which pulls up the native on-screen keyboard. Characters are
// forwarded as they're typed and the input is kept empty so it never fills up.
const mobileInput = document.getElementById("mobile-input");
let composing = false;

// Focus hidden input on stream tap (touchstart so it fires before click)
streamImg.addEventListener(
    "touchstart",
    () => {
        if (!connected) return;
        mobileInput.focus();
        mobileInput.value = "";
    },
    { passive: true },
);

mobileInput.addEventListener("compositionstart", () => {
    composing = true;
});
mobileInput.addEventListener("compositionend", (e) => {
    composing = false;
    // Send the completed composed character (e.g. Chinese/Japanese)
    if (e.data) send({ type: "type", text: e.data });
    mobileInput.value = "";
});

mobileInput.addEventListener("input", () => {
    if (composing) return; // wait for compositionend to fire

    const val = mobileInput.value;
    if (!val) return;

    // Count backspaces — any reduction in length is a deletion
    // (this handles swipe-to-delete and autocorrect replacements)
    send({ type: "type", text: val });
    mobileInput.value = "";
});

// Enter key on mobile keyboard
mobileInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        send({ type: "keydown", key: "Enter" });
        e.preventDefault();
    }
});
