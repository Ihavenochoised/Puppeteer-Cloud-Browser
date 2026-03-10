// ── State ──────────────────────────────────────────────────────────────────────
let ws = null;
let tabs = []; // [{ index, url, title }]
let activeTab = 0;
let connected = false;

// ── Elements ───────────────────────────────────────────────────────────────────
const tabBar = document.getElementById("tab-bar");
const btnNewTab = document.getElementById("btn-new-tab");
const urlInput = document.getElementById("url-input");
const btnGo = document.getElementById("btn-go");
const btnStop = document.getElementById("btn-stop");
const streamImg = document.getElementById("stream");
const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const placeholder = document.getElementById("placeholder");

// ── Status ─────────────────────────────────────────────────────────────────────
function setStatus(state, text) {
    dot.className = "dot " + (state ?? "");
    statusText.textContent = text;
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
        setStatus("live", "connected");
        btnGo.disabled = false;
        btnStop.disabled = false;
        btnNewTab.style.pointerEvents = "";

        // Navigate if there's already a URL typed
        const url = urlInput.value.trim();
        if (url) send({ type: "navigate", url });
    });

    ws.addEventListener("message", (e) => {
        // Binary = JPEG frame
        if (e.data instanceof ArrayBuffer) {
            const blob = new Blob([e.data], { type: "image/jpeg" });
            const old = streamImg.src;
            streamImg.src = URL.createObjectURL(blob);
            if (old.startsWith("blob:")) URL.revokeObjectURL(old);

            if (!streamImg.classList.contains("visible")) {
                streamImg.classList.add("visible");
                placeholder.classList.add("hidden");
            }
            return;
        }

        // JSON = control message
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === "tabs") {
                tabs = msg.tabs;
                activeTab = msg.activeTab;
                renderTabs();
            }
        } catch {}
    });

    ws.addEventListener("close", () => {
        connected = false;
        setStatus("", "disconnected");
        btnGo.disabled = false;
        btnStop.disabled = true;
        streamImg.classList.remove("visible");
        placeholder.classList.remove("hidden");
    });

    ws.addEventListener("error", () => setStatus("error", "connection error"));
}

function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Button handlers ────────────────────────────────────────────────────────────
btnGo.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (!url) return;

    if (!connected) {
        setStatus("", "connecting…");
        btnGo.disabled = true;
        connect(); // navigate is sent automatically on open
    } else {
        send({ type: "navigate", url });
    }
});

btnStop.addEventListener("click", () => {
    send({ type: "pause" });
    ws?.close();
});

btnNewTab.addEventListener("click", () => {
    if (!connected) return;
    send({ type: "newtab" });
});

// ── URL bar: navigate on Enter ─────────────────────────────────────────────────
urlInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const url = urlInput.value.trim();
    if (!url) return;

    if (!connected) {
        setStatus("", "connecting…");
        btnGo.disabled = true;
        connect();
    } else {
        send({ type: "navigate", url });
    }
});

// Auto-connect on load so tabs state arrives immediately
connect();

// ── Mouse forwarding ───────────────────────────────────────────────────────────
function toRemote(clientX, clientY) {
    const rect = streamImg.getBoundingClientRect();
    const nW = 1280,
        nH = 720;
    const scale = Math.min(rect.width / nW, rect.height / nH);
    const offX = (rect.width - nW * scale) / 2;
    const offY = (rect.height - nH * scale) / 2;
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
