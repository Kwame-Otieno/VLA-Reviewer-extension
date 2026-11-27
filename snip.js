// On-demand screenshot tool. Injected into the active tab by the side panel's toolbar button (or the
// Alt+Shift+S shortcut). Dims the page, lets the user drag a rectangle, then copies exactly that
// area to the clipboard as a PNG. Running it again while it is open cancels it.
(() => {
  if (globalThis.__vlaSnipCancel) { globalThis.__vlaSnipCancel(); return; } // toggle: second run closes it

  const MIN_SIZE = 6; // px; anything smaller is treated as an accidental click
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- overlay (closed shadow DOM so page CSS can't touch it) ---------------- */
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .dim { position: fixed; inset: 0; background: rgba(0,0,0,.28); cursor: crosshair; touch-action: none; user-select: none; }
      .dim.has-sel { background: transparent; }
      .sel { position: fixed; display: none; box-sizing: border-box; border: 1.5px solid #5b7ae8;
             box-shadow: 0 0 0 100vmax rgba(0,0,0,.42); pointer-events: none; }
      .size { position: fixed; display: none; padding: 2px 7px; border-radius: 4px; background: #111827; color: #fff;
              font: 600 11px/1.5 system-ui, -apple-system, sans-serif; pointer-events: none; white-space: nowrap; }
      .hint { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); padding: 7px 14px; border-radius: 999px;
              background: rgba(17,24,39,.92); color: #fff; font: 500 12px/1.4 system-ui, -apple-system, sans-serif;
              pointer-events: none; white-space: nowrap; }
      .toast { position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 10px; padding: 8px 14px 8px 8px;
               border-radius: 10px; color: #fff; font: 600 13px/1.3 system-ui, -apple-system, sans-serif;
               box-shadow: 0 8px 24px rgba(0,0,0,.35); opacity: 0; transition: opacity .18s ease; }
      .toast.ok { background: linear-gradient(135deg,#16a34a,#15803d); }
      .toast.warn { background: linear-gradient(135deg,#f59e0b,#d97706); }
      .toast.show { opacity: 1; }
      .toast img { display: block; max-width: 96px; max-height: 64px; border-radius: 5px; border: 1px solid rgba(255,255,255,.55); background: #fff; }
      .toast span { max-width: 220px; }
    </style>
    <div class="dim" id="dim"></div>
    <div class="sel" id="sel"></div>
    <div class="size" id="size"></div>
    <div class="hint" id="hint">Drag to select an area · Esc to cancel</div>`;
  document.documentElement.appendChild(host);
  const dim = root.getElementById("dim"), selEl = root.getElementById("sel"), sizeEl = root.getElementById("size"), hint = root.getElementById("hint");

  let start = null, rect = null, busy = false;

  const clampX = (x) => Math.min(Math.max(0, x), window.innerWidth);
  const clampY = (y) => Math.min(Math.max(0, y), window.innerHeight);
  const toRect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  function draw(r) {
    selEl.style.display = sizeEl.style.display = "block";
    selEl.style.left = r.x + "px"; selEl.style.top = r.y + "px";
    selEl.style.width = r.w + "px"; selEl.style.height = r.h + "px";
    sizeEl.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    // label below the selection, or above it when there is no room underneath
    const below = r.y + r.h + 30 < window.innerHeight;
    sizeEl.style.left = Math.min(r.x, window.innerWidth - 90) + "px";
    sizeEl.style.top = (below ? r.y + r.h + 6 : Math.max(4, r.y - 26)) + "px";
    dim.classList.add("has-sel");
  }
  function resetSelection() {
    start = rect = null;
    selEl.style.display = sizeEl.style.display = "none";
    dim.classList.remove("has-sel");
  }

  /* ---------------- input ---------------- */
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const onKey = (e) => { if (e.key === "Escape") { stop(e); cleanup(); } };
  const onWheel = (e) => stop(e); // keep the viewport still so the capture lines up with the selection

  dim.addEventListener("pointerdown", (e) => {
    stop(e);
    if (busy || e.button !== 0) return;
    dim.setPointerCapture(e.pointerId);
    hint.style.display = "none";
    start = { x: clampX(e.clientX), y: clampY(e.clientY) };
    rect = null;
  });
  dim.addEventListener("pointermove", (e) => {
    if (!start || busy) return;
    stop(e);
    rect = toRect(start, { x: clampX(e.clientX), y: clampY(e.clientY) });
    draw(rect);
  });
  dim.addEventListener("pointerup", (e) => {
    stop(e);
    if (!start || busy) return;
    const r = rect;
    if (!r || r.w < MIN_SIZE || r.h < MIN_SIZE) { resetSelection(); hint.style.display = ""; return; } // too small: try again
    finish(r);
  });
  dim.addEventListener("contextmenu", (e) => { stop(e); cleanup(); }); // right click cancels
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  host.addEventListener("pointerdown", stop); host.addEventListener("click", stop); host.addEventListener("mousedown", stop);

  function cleanup() {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", onWheel, { capture: true });
    host.remove();
    globalThis.__vlaSnipCancel = null;
  }
  globalThis.__vlaSnipCancel = cleanup;
  try { dim.focus?.(); window.focus(); } catch (_) {}

  /* ---------------- capture → crop → clipboard ---------------- */
  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image decode failed")); i.src = src; });

  async function showToast(kind, text, thumb) {
    // overlay chrome is hidden for the capture; bring back just the toast
    const old = root.querySelector(".toast"); if (old) old.remove();
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    if (thumb) { const img = document.createElement("img"); img.src = thumb; t.appendChild(img); }
    const s = document.createElement("span"); s.textContent = text; t.appendChild(s);
    root.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    await sleep(2600);
    t.classList.remove("show");
    await sleep(220);
  }

  function downloadBlob(blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
    document.documentElement.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function finish(r) {
    busy = true;
    // Hide everything of ours, let the page repaint, then take the screenshot of the visible tab
    dim.style.display = selEl.style.display = sizeEl.style.display = hint.style.display = "none";
    window.removeEventListener("keydown", onKey, true);
    await raf2();
    await sleep(60);

    let reply;
    try { reply = await chrome.runtime.sendMessage({ action: "VLA_SNIP_CAPTURE" }); }
    catch (e) { reply = { ok: false, error: e.message }; }
    if (!reply || !reply.ok) {
      host.style.pointerEvents = "none";
      const needsPermission = reply && /activeTab|all_urls|permission/i.test(reply.error || "");
      await showToast("warn", needsPermission
        ? "No permission to capture this tab. Click the screenshot button in the panel and allow access, or press Alt+Shift+S."
        : "Couldn't capture this page" + (reply && reply.error ? ` (${reply.error})` : ""));
      return cleanup();
    }

    let blob, thumb;
    try {
      const img = await loadImage(reply.dataUrl);
      const scale = img.naturalWidth / window.innerWidth; // device pixels per CSS pixel (DPR and zoom)
      const sx = Math.round(r.x * scale), sy = Math.round(r.y * scale);
      const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.round(r.w * scale)));
      const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.round(r.h * scale)));
      const canvas = document.createElement("canvas");
      canvas.width = sw; canvas.height = sh;
      canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      thumb = canvas.toDataURL("image/png");
    } catch (e) {
      host.style.pointerEvents = "none";
      await showToast("warn", "Couldn't process the screenshot");
      return cleanup();
    }

    host.style.pointerEvents = "none";
    host.style.display = "block";
    let copied = false;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      copied = true;
    } catch (_) { /* focus / permission: fall back to saving a file */ }

    if (copied) await showToast("ok", "Copied to clipboard", thumb);
    else { downloadBlob(blob); await showToast("warn", "Couldn't copy — saved as a file instead", thumb); }
    cleanup();
  }
})();
