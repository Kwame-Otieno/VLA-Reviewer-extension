const PENDING_KEY = "vla_pending_audit";
const SPEED_PENDING_KEY = "vla_pending_speedcheck";
const PENDING_TTL_MS = 10000;

const ALLOWED_ORIGIN = "https://data-annotation-app.applied.ondana.ai";
const isRestrictedUrl = (u) => !u || !u.startsWith(ALLOWED_ORIGIN);

try {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
} catch (e) {
  console.log("Side panel API error.");
}

// "image" is included so the menu also appears when right-clicking directly on a camera picture
// (an image has its own context; page-only items would not show there).
const MENU_CONTEXTS = ["page", "selection", "editable", "image"];
function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "vla-check-compliance", title: "Check VLA Compliance", contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: "vla-speed-check", title: "Speed Check", contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: "vla-screenshot", title: "Screenshot (drag to copy)", contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: "vla-copy-url", title: "Copy Clip URL", contexts: MENU_CONTEXTS });
  });
}
chrome.runtime.onInstalled.addListener(buildContextMenus);
chrome.runtime.onStartup.addListener(buildContextMenus);

/* ---------------- audit request handshake ---------------- */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "VLA_SNIP_CAPTURE") {
    // snip.js (the screenshot tool) asks the background to photograph the visible tab,
    // because captureVisibleTab cannot run inside the page itself.
    (async () => {
      try {
        const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        sendResponse({ ok: true, dataUrl });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || "capture failed" });
      }
    })();
    return true;
  }
  if (request.action === "SIDEPANEL_READY") {
    chrome.storage.session.get([PENDING_KEY, SPEED_PENDING_KEY]).then(async (r) => {
      const ts = r[PENDING_KEY];
      const sts = r[SPEED_PENDING_KEY];
      const pending = typeof ts === "number" && Date.now() - ts < PENDING_TTL_MS;
      const speedPending = typeof sts === "number" && Date.now() - sts < PENDING_TTL_MS;
      if (ts) await chrome.storage.session.remove(PENDING_KEY);
      if (sts) await chrome.storage.session.remove(SPEED_PENDING_KEY);
      sendResponse({ pendingAudit: pending, pendingSpeedCheck: speedPending });
    }).catch(() => {
      sendResponse({ pendingAudit: false, pendingSpeedCheck: false });
    });
    return true;
  }
});

async function requestAudit(windowId) {
  const opening = chrome.sidePanel && chrome.sidePanel.open
  ? chrome.sidePanel.open({ windowId }).catch(() => {})
  : Promise.resolve();
  await chrome.storage.session.set({ [PENDING_KEY]: Date.now() });
  await opening;
  try {
    const reply = await chrome.runtime.sendMessage({ action: "TRIGGER_AUDIT" });
    if (reply && reply.handled) await chrome.storage.session.remove(PENDING_KEY);
  } catch (_) { }
}

// Same hand-off as the audit: open the side panel, then tell it to open the calculator and run the check
// (if the panel is still starting up it asks for the pending request itself via SIDEPANEL_READY).
async function requestSpeedCheck(windowId) {
  const opening = chrome.sidePanel && chrome.sidePanel.open
  ? chrome.sidePanel.open({ windowId }).catch(() => {})
  : Promise.resolve();
  await chrome.storage.session.set({ [SPEED_PENDING_KEY]: Date.now() });
  await opening;
  try {
    const reply = await chrome.runtime.sendMessage({ action: "TRIGGER_SPEED_CHECK" });
    if (reply && reply.handled) await chrome.storage.session.remove(SPEED_PENDING_KEY);
  } catch (_) { }
}

async function copyViaOffscreen(text) {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!existing.length) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Copy the clip URL to the clipboard from the context menu"
    });
  }
  const res = await chrome.runtime.sendMessage({ target: "offscreen", action: "COPY", text });
  if (!res || !res.ok) throw new Error("copy failed");
}

function showToast(tabId, message, isError) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (msg, err) => {
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "closed" });
      const toast = document.createElement("div");
      toast.textContent = msg;
      Object.assign(toast.style, {
        position: "fixed", top: "calc(100vh - 100px)", left: "50vw", transform: "translateX(-50%)",
                    backgroundColor: err ? "#ef4444" : "#10b981", color: "white", padding: "16px 24px", borderRadius: "8px",
                    fontFamily: "system-ui, -apple-system, sans-serif", fontSize: "16px", fontWeight: "600",
                    boxShadow: "0 10px 15px -3px rgba(0,0,0,0.3)", zIndex: "2147483647",
                    opacity: "0", transition: "opacity 0.3s ease-in-out", pointerEvents: "none", textAlign: "center"
      });
      shadow.appendChild(toast);
      document.documentElement.appendChild(host);
      requestAnimationFrame(() => (toast.style.opacity = "1"));
      setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => host.remove(), 300);
      }, 2500);
    },
    args: [message, !!isError]
  }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === "vla-check-compliance") {
    requestAudit(tab.windowId);
  } else if (info.menuItemId === "vla-speed-check") {
    requestSpeedCheck(tab.windowId);
  } else if (info.menuItemId === "vla-screenshot") {
    injectSnip(tab); // a context-menu click grants activeTab for this page, which the capture needs
  } else if (info.menuItemId === "vla-copy-url") {
    const url = info.pageUrl || tab.url;
    if (isRestrictedUrl(url)) return;
    try {
      await copyViaOffscreen(url);
      await showToast(tab.id, "🔗 Clip URL Copied! ✓", false);
    } catch (err) {
      console.error("Copy failed:", err);
      await showToast(tab.id, "Copy failed", true);
    }
  }
});

// Snip tool: inject snip.js into the annotation page (the side panel toolbar button and the
// Alt+Shift+S command both come through here). Running it again while it is open cancels it.
async function injectSnip(tab) {
  const t = tab && tab.id ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0];
  if (!t || !t.id || isRestrictedUrl(t.url)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["snip.js"] });
  } catch (e) {
    console.error("Screenshot injection failed:", e);
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "take-screenshot") {
    injectSnip(tab); // the keyboard shortcut also grants activeTab for the active page
    return;
  }
  if (command !== "run-audit") return;
  if (tab && tab.windowId !== undefined) {
    requestAudit(tab.windowId);
  } else {
    chrome.windows.getCurrent().then((w) => requestAudit(w.id));
  }
});

/* ---------------- clip-open tracking (statistics) ----------------
   A clip counts as "opened" when its URL is navigated to — typed/pasted in the
   address bar, a link, or the app's queue — NOT when the side panel fetches data
   from an already-open tab. Two URL shapes: /annotate/<id> and /review/<id>.
   Written here (not in sidepanel.js) so it works even when the panel is closed. */
const OPENS_KEY = "vla_opens_daily";  // day "YYYY-MM-DD" -> { url: 1 }
const SEEN_KEY = "vla_clip_seen";     // url -> { t, a } (a = audited)
const CLIP_URL_RX = /^https:\/\/data-annotation-app\.applied\.ondana\.ai\/(?:annotate|review)\/[\w-]+/i;
const pad2 = (n) => String(n).padStart(2, "0");
const lastClipUrl = {}; // tabId -> last clip URL already recorded (skips reloads)

async function recordClipOpened(url) {
  try {
    const st = (await chrome.storage.local.get([OPENS_KEY, SEEN_KEY]).catch(() => ({}))) || {};
    const days = (st[OPENS_KEY] && typeof st[OPENS_KEY] === "object") ? st[OPENS_KEY] : {};
    const seen = (st[SEEN_KEY] && typeof st[SEEN_KEY] === "object") ? st[SEEN_KEY] : {};
    const now = new Date();
    const ds = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
    if (days[ds] && days[ds][url] && seen[url]) return; // already recorded — nothing to write
    (days[ds] = days[ds] && typeof days[ds] === "object" ? days[ds] : {})[url] = 1;
    const dayKeys = Object.keys(days).sort(); // "YYYY-MM-DD" strings sort chronologically
    if (dayKeys.length > 60) { // keep the newest 60 days
      for (const k of dayKeys.slice(0, dayKeys.length - 60)) delete days[k];
    }
    if (!seen[url]) seen[url] = { t: Date.now(), a: false }; // "a" is set by the audit, never reset here
    const seenKeys = Object.keys(seen);
    if (seenKeys.length > 1000) { // keep the newest 1000 clips
      seenKeys.sort((a, b) => (seen[a].t || 0) - (seen[b].t || 0));
      for (const k of seenKeys.slice(0, seenKeys.length - 1000)) delete seen[k];
    }
    await chrome.storage.local.set({ [OPENS_KEY]: days, [SEEN_KEY]: seen });
  } catch (_) {}
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  const url = String((info && info.url) || "").split("#")[0];
  if (!url || lastClipUrl[tabId] === url) return;
  lastClipUrl[tabId] = url;
  if (CLIP_URL_RX.test(url)) recordClipOpened(url);
});

chrome.tabs.onRemoved.addListener((tabId) => { delete lastClipUrl[tabId]; });

// When the user resets statistics (the panel removes the daily-opens key), forget the
// per-tab cache too: a tab parked on a clip URL counts as opened again on its next visit.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[OPENS_KEY] && changes[OPENS_KEY].newValue === undefined) {
    for (const k of Object.keys(lastClipUrl)) delete lastClipUrl[k];
  }
});