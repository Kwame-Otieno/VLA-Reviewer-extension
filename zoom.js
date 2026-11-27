// Double-click a camera image (Left / Front / Right / Rear left / Rear right) on the annotation page to open it
// in a large overview on top of the page — same tab, nothing opens elsewhere. The picture is shown as large as
// fits. ← → keep stepping the clip as usual (the page handles them) and the overview follows the live frame, so you
// can play through the clip while zoomed. The big ‹ › arrows on the sides switch camera (as do ↑ ↓ and a click on
// the camera-name pill), and the page's frame counter (e.g. "12 / 150") is mirrored at the top centre. Left-click
// zooms in, right-click zooms out, drag moves the picture. Close with the ✕ button, Esc, or by clicking the dark area around it.
// While an action frame is set, the ACTION FRAME pill turns green for the whole 19-frame window that ends at
// the action frame (frames action−19 … action). For action points less than 19 frames from the start of the clip the
// window simply starts at the first frame of the clip, so those are covered too.
(() => {
  if (globalThis.__vlaZoomLoaded) return;
  globalThis.__vlaZoomLoaded = true;

  const CAMERA_ALTS = ["left", "front", "right", "rear left", "rear right"]; // also the order of ← →
  const LABEL = { "left": "Left", "front": "Front", "right": "Right", "rear left": "Rear left", "rear right": "Rear right" };
  let enabled = true;
  try {
    chrome.storage.local.get("zoom_enabled").then((s) => { enabled = s.zoom_enabled !== false; }).catch(() => {});
    chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.zoom_enabled) enabled = c.zoom_enabled.newValue !== false; });
  } catch (_) { /* no extension APIs: stays enabled */ }

  let viewer = null; // { host, close }
  const altOf = (el) => (el.alt || "").trim().toLowerCase();

  // The camera <img> under the pointer, even when something else (e.g. the path overlay) is drawn over it
  function cameraImageAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.tagName === "IMG" && CAMERA_ALTS.includes(altOf(el)) && el.naturalWidth > 0) return el;
    }
    return null;
  }

  // The currently shown picture of every camera, keyed by name
  function allCameraImages() {
    const found = {};
    for (const el of document.querySelectorAll("img")) {
      const k = altOf(el);
      if (CAMERA_ALTS.includes(k) && el.naturalWidth > 0 && (el.offsetWidth || el.getClientRects().length) && !found[k]) found[k] = el;
    }
    return found;
  }

  async function openViewer(clicked) {
    if (viewer) viewer.close();

    const imgs = allCameraImages();
    imgs[altOf(clicked)] = clicked;
    const names = CAMERA_ALTS.filter((k) => imgs[k]);
    let current = altOf(clicked);

    /* ---- DOM (closed shadow root: the page's CSS can't touch it) ---- */
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.72); }
        .box { position: fixed; left: 3vw; top: 4vh; width: 94vw; height: 92vh; background: #000; border: 1px solid #5b7ae8; border-radius: 8px;
               overflow: hidden; box-shadow: 0 14px 50px rgba(0,0,0,.6); cursor: zoom-in; touch-action: none; user-select: none; }
        .box.dragging { cursor: grabbing; }
        canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; max-width: none; max-height: none; will-change: transform; }
        .fstep { font-size: 11px; letter-spacing: -1px; }
        .chip { position: absolute; left: 12px; top: 12px; padding: 4px 11px; border-radius: 999px; background: rgba(17,24,39,.85); color: #fff;
                font: 600 12px/1.5 system-ui, -apple-system, sans-serif; pointer-events: auto; cursor: pointer; }
        .frame { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); padding: 4px 11px; border-radius: 999px; background: rgba(17,24,39,.85); color: #fff;
                 font: 600 12px/1.5 system-ui, -apple-system, sans-serif; pointer-events: none; font-variant-numeric: tabular-nums; }
        .vel { position: absolute; left: 12px; bottom: 12px; padding: 4px 11px; border-radius: 999px; background: rgba(17,24,39,.85); color: #fff;
               font: 600 12px/1.5 system-ui, -apple-system, sans-serif; pointer-events: none; font-variant-numeric: tabular-nums; }
        .abtn { width: auto; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0 11px; border-radius: 999px; background: #334155; color: #fff;
                font: 600 12px/1 system-ui, -apple-system, sans-serif; pointer-events: auto; cursor: pointer; user-select: none; font-variant-numeric: tabular-nums; }
        .abtn:hover { background: #475569; }
        /* Action frame set but outside the 19-frame window: the existing blue. Inside the window: green. */
        .abtn.near { background: #16a34a; }
        .abtn.near:hover { background: #15803d; }
        @keyframes abtn-pop { 0% { transform: scale(1); } 35% { transform: scale(1.07); } 100% { transform: scale(1); } }
        @keyframes abtn-ring { 0% { box-shadow: 0 0 0 0 rgba(22,163,74,.45); } 100% { box-shadow: 0 0 0 8px rgba(22,163,74,0); } }
        .abtn.pulse { animation: abtn-pop .3s ease, abtn-ring .45s ease; }
        .bar { position: absolute; right: 12px; top: 12px; display: flex; gap: 5px; }
        button { all: unset; box-sizing: border-box; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 7px;
                 background: rgba(17,24,39,.85); color: #fff; font: 600 16px/1 system-ui, -apple-system, sans-serif; cursor: pointer; }
        button:hover { background: #5b7ae8; }
        button.exit:hover { background: #ef4444; }
        .nav { position: absolute; top: 50%; transform: translateY(-50%); width: 40px; height: 56px; font-size: 26px; }
        .prev { left: 10px; } .next { right: 10px; }
        .hint { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); padding: 5px 14px; border-radius: 999px; background: rgba(17,24,39,.85);
                color: #fff; font: 500 12px/1.4 system-ui, -apple-system, sans-serif; white-space: nowrap; pointer-events: none; transition: opacity .6s; }
        [hidden] { display: none !important; }
      </style>
      <div class="backdrop"></div>
      <div class="box" role="dialog" aria-label="Camera image overview">
        <canvas></canvas>
        <div class="chip" title="Switch camera (↑ ↓)" role="button" aria-label="Switch camera"></div>
        <div class="frame" hidden></div>
        <div class="vel" hidden></div>
        <div class="bar">
          <button type="button" class="abtn" hidden>SET ACTION FRAME</button>
          <button class="fstep fprev" title="Previous frame (←)" aria-label="Previous frame">|◀</button>
          <button class="fstep fnext" title="Next frame (→)" aria-label="Next frame">▶|</button>
          <button class="zin" title="Zoom in" aria-label="Zoom in">+</button>
          <button class="zout" title="Zoom out" aria-label="Zoom out">−</button>
          <button class="fit" title="Fit to window" aria-label="Fit to window">⟲</button>
          <button class="exit" title="Close (Esc)" aria-label="Close">✕</button>
        </div>
        <button class="nav prev" title="Previous camera (↑)" aria-label="Previous camera">‹</button>
        <button class="nav next" title="Next camera (↓)" aria-label="Next camera">›</button>
        <div class="hint">Click to zoom in · right-click to zoom out · drag to move · ← → step the clip (live) · ‹ › or ↑ ↓ switch camera · Esc or ✕ to close</div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    const box = $(".box"), pic = $("canvas"), chip = $(".chip"), hint = $(".hint"), backdrop = $(".backdrop");
    if (names.length < 2) { $(".prev").hidden = true; $(".next").hidden = true; } // one camera: no camera arrows
    document.documentElement.appendChild(host);
    setTimeout(() => { hint.style.opacity = "0"; }, 3500);

    /* ---- view state: scale s and offset (x, y) of the image inside the box ---- */
    let s = 1, x = 0, y = 0, fitS = 1, nw = 1, nh = 1;
    const ctx = pic.getContext("2d");
    const MAXS = () => Math.max(8, fitS * 16);
    const size = () => ({ w: box.clientWidth, h: box.clientHeight });
    function clampPan() {
      const { w, h } = size(), iw = nw * s, ih = nh * s, keep = 48; // never let the image leave the window entirely
      x = Math.min(Math.max(x, keep - iw), w - keep);
      y = Math.min(Math.max(y, keep - ih), h - keep);
    }
    function render() {
      clampPan();
      pic.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
      pic.style.imageRendering = s >= 3 ? "pixelated" : "auto"; // show real pixels once looked at closely
      chip.textContent = `${LABEL[current]} · ${names.indexOf(current) + 1}/${names.length}` + (Math.abs(s - fitS) > 1e-6 ? ` · ${Math.round(s / fitS * 100)}%` : "");
    }
    function fit(tries = 0) { // the overview: the whole picture, as large as the window allows
      const { w, h } = size();
      if ((!w || !h) && tries < 20) { requestAnimationFrame(() => fit(tries + 1)); return; } // not laid out yet
      fitS = Math.min(w / nw, h / nh);
      s = fitS; x = (w - nw * s) / 2; y = (h - nh * s) / 2;
      render();
    }
    function zoomAt(px, py, factor) {
      const ns = Math.min(Math.max(s * factor, fitS), MAXS()); // never smaller than the overview
      const k = ns / s;
      x = px - (px - x) * k; y = py - (py - y) * k; s = ns;
      if (Math.abs(s - fitS) < 1e-3) fit(); else render(); // back at the overview: re-centre it
    }
    const centre = () => { const { w, h } = size(); return [w / 2, h / 2]; };
    const local = (e) => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    // Draw the page's current picture of the selected camera into the overview. Called when the page changes
    // the image (clip stepped / played), so the zoom keeps showing the live frame. Zoom and pan are kept.
    let lastEl = null, lastKey = null;
    function paint(force) {
      const el = allCameraImages()[current];
      if (!el || !el.complete || !el.naturalWidth) return false; // new frame still loading: keep the old one on screen
      const key = el.currentSrc || el.src;
      if (!force && el === lastEl && key === lastKey) return false; // nothing new
      const w = el.naturalWidth, h = el.naturalHeight;
      let resized = false;
      if (pic.width !== w || pic.height !== h) {
        pic.width = w; pic.height = h;
        pic.style.width = w + "px"; pic.style.height = h + "px";
        nw = w; nh = h; resized = true;
      }
      try { ctx.drawImage(el, 0, 0); } catch (_) { return false; }
      lastEl = el; lastKey = key;
      return resized;
    }
    function show(name) { // switching camera: new picture, back to the overview
      current = name; lastEl = null;
      chip.textContent = LABEL[name];
      paint(true);
      updateFrame();
      updateVel();
      updateAction();
      fit();
    }
    let raf = 0;
    const schedulePaint = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; if (viewer && viewer.host === host) { if (paint(false)) fit(); updateFrame(); updateVel(); updateAction(); } });
    };
    // Follow the page: its camera <img> gets a new src (or is replaced) whenever the clip moves; the frame
    // counter pill follows the page's own counter text (characterData catches plain text updates)
    const mo = new MutationObserver(schedulePaint);
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "srcset"] });
    const onImgLoad = (e) => { if (e.target && e.target.tagName === "IMG") schedulePaint(); };
    window.addEventListener("load", onImgLoad, true); // load doesn't bubble, so listen in the capture phase
    const step = (d) => { if (names.length < 2) return; show(names[(names.indexOf(current) + d + names.length) % names.length]); };

    // The page's frame counter (e.g. "Frame 109of 150"), mirrored at the top centre of the overview as
    // "FRAME 109/150". It lives in the camera grid next to the camera figures; the page glues neighbouring
    // labels onto it with no spaces, so reduce it to its numbers and reformat.
    const frame = $(".frame");
    function frameLabel() {
      const img = allCameraImages()[current];
      const fig = img && img.closest("figure");
      const grid = fig ? (fig.closest("[data-locked-tiling]") || fig.parentElement) : null;
      if (!grid) return "";
      let best = null;
      for (const el of grid.querySelectorAll("figcaption, span, div, p")) {
        if (el.querySelector && el.querySelector("img")) continue; // skip containers holding the camera pictures
        const t = (el.textContent || "").trim();
        if (!t || t.length > 40 || t.includes(":")) continue; // drop long texts and timestamps
        const nums = t.match(/\d+/g);
        if (!nums || !nums.length || CAMERA_ALTS.includes(t.toLowerCase())) continue;
        const score = (nums.length >= 2 ? 0 : 1000) + t.length; // prefer current+total pairs, then shortest
        if (!best || score < best.score) best = { nums, score };
      }
      if (!best) return "";
      const n = best.nums;
      return n.length >= 2 ? `FRAME ${n[0]}/${n[1]}` : `FRAME ${n[0]}`;
    }
    function updateFrame() {
      const t = frameLabel();
      frame.hidden = !t;
      if (t) frame.textContent = t;
    }

    // The page's velocity readout (e.g. "Velocity 12.4 m/s"), mirrored at the bottom left of the
    // overview. It changes with the frame, and the same MutationObserver that repaints the picture
    // refreshes it. The element is found once by its text (the site's class names are build hashes)
    // and cached; only when it disappears or stops matching is the page scanned again.
    const vel = $(".vel");
    const VEL_RX = /Velocity\s*(-?\d+(?:\.\d+)?)\s*m\/s/i;
    let velEl = null;
    function velLabel() {
      if (velEl && velEl.isConnected) {
        const m = (velEl.textContent || "").match(VEL_RX);
        if (m) return `VELOCITY ${m[1]} m/s`;
        velEl = null; // text no longer a velocity (page redeployed / clip changed) → rescan
      }
      let best = null;
      for (const el of document.querySelectorAll("span, div, p")) {
        const t = el.textContent || "";
        if (t.length > 60 || !VEL_RX.test(t)) continue;
        if (!best || t.length < best.textContent.length) best = el;
      }
      if (!best) return "";
      velEl = best;
      const m = best.textContent.match(VEL_RX);
      return m ? `VELOCITY ${m[1]} m/s` : "";
    }
    function updateVel() {
      const t = velLabel();
      vel.hidden = !t;
      if (t) vel.textContent = t;
    }

    // Action-frame toggle (top right, under the zoom toolbar). The page shows a "Set to N"
    // button while no action frame is set and a "Clear" button once one is; the frame number comes
    // from the page's "frame N" label. The pill mirrors that state (amber when set) and clicking it
    // presses the page's own button, so the annotation stays exactly what the page records.
    const abtn = $(".abtn");
    const ACTION_SET_RX = /^set to \d+$/i, ACTION_CLEAR_RX = /^clear$/i, ACTION_FRAME_RX = /^(?:action point\s*)?frame\s*\d+$/i;
    const NEAR_WINDOW = 19; // light-yellow cue: from 19 frames before the action frame through the action frame
    function actionButton(re) {
      const cands = [...document.querySelectorAll("button")].filter((b) => re.test((b.textContent || "").trim()));
      if (cands.length <= 1) return cands[0] || null;
      // several matches (e.g. an unrelated "Clear" elsewhere): prefer the one nearest the playback slider
      const slider = document.querySelector('[role="slider"][aria-label="Playback time"]');
      if (!slider) return cands[0];
      const sr = slider.getBoundingClientRect(), scx = sr.left + sr.width / 2, scy = sr.top + sr.height / 2;
      const d = (b) => { const r = b.getBoundingClientRect(); return Math.hypot(r.left + r.width / 2 - scx, r.top + r.height / 2 - scy); };
      return cands.sort((a, b) => d(a) - d(b))[0];
    }
    function actionState() {
      const setBtn = actionButton(ACTION_SET_RX);
      const clearBtn = actionButton(ACTION_CLEAR_RX);
      if (!setBtn && !clearBtn) return null; // page without these buttons: hide the toggle
      // The page's "frame N" label is the ground truth of whether an action frame is set
      let n = null, best = null;
      for (const el of document.querySelectorAll("span, div, p")) {
        const t = (el.textContent || "").trim();
        if (t.length > 40 || !ACTION_FRAME_RX.test(t)) continue;
        if (!best || t.length < best.length) { best = t; n = parseInt(t.match(/(\d+)/)[1], 10); }
      }
      if (setBtn && clearBtn) return { set: n != null, btn: n != null ? clearBtn : setBtn, frame: n };
      if (clearBtn) return { set: true, btn: clearBtn, frame: n };
      return { set: false, btn: setBtn };
    }
    let lastActionKey = null;
    function updateAction() {
      const st = actionState();
      abtn.hidden = !st;
      // State change (set/cleared/moved) → play the pop-and-ring animation once
      const key = st ? (st.set ? `on:${st.frame}` : "off") : "hidden";
      if (lastActionKey !== null && key !== lastActionKey && st) {
        abtn.classList.remove("pulse");
        void abtn.offsetWidth; // restart the animation if it is still running
        abtn.classList.add("pulse");
        setTimeout(() => abtn.classList.remove("pulse"), 700);
      }
      lastActionKey = key;
      if (!st) return;
      if (st.set) {
        abtn.textContent = st.frame != null ? `ACTION FRAME ${st.frame}` : "ACTION FRAME SET";
        abtn.title = "Click to move the action frame to the current frame";
      } else {
        abtn.textContent = "SET ACTION FRAME";
        abtn.title = "Click to set the action frame at the current frame";
      }
      // Window cue: green while the displayed frame is inside the 19-frame window ending at the action frame
      // (window start clamped to the first frame of the clip for early action points); blue otherwise.
      let near = false;
      if (st.set && st.frame != null) {
        const fm = frameLabel().match(/^FRAME (\d+)/);
        if (fm) {
          const cur = parseInt(fm[1], 10);
          near = cur >= Math.max(0, st.frame - NEAR_WINDOW) && cur <= st.frame;
        }
      }
      abtn.classList.toggle("near", near);
    }
    abtn.addEventListener("click", async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = actionState();
      if (!st) return;
      if (!st.set) {
        st.btn.click(); // no action frame yet → set it at the current frame
      } else {
        // An action frame is already set → move it to the current frame in one click: press the
        // page's "Set to N" directly when it is offered, otherwise clear first and press
        // "Set to N" as soon as it appears.
        const setBtn = actionButton(ACTION_SET_RX);
        if (setBtn) setBtn.click();
        else {
          st.btn.click(); // Clear
          for (let i = 0; i < 12 && !actionButton(ACTION_SET_RX); i++) await sleep(150);
          const sb = actionButton(ACTION_SET_RX);
          if (sb) sb.click();
        }
      }
      setTimeout(updateAction, 250); // the page updates a beat later; the observer also refreshes this
      setTimeout(updateAction, 800);
    });

    /* ---- interaction ---- */
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    let drag = null;
    // Left button: a click zooms in at the cursor, a drag (more than a few pixels) moves the picture instead
    box.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, .abtn, .chip")) return;
      e.stopPropagation();
      box.setPointerCapture(e.pointerId);
      drag = { px: e.clientX, py: e.clientY, x, y, moved: false };
    });
    box.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      box.classList.add("dragging");
      x = drag.x + dx; y = drag.y + dy;
      render();
    });
    const endDrag = () => { drag = null; box.classList.remove("dragging"); };
    box.addEventListener("pointerup", (e) => {
      if (drag && !drag.moved) { const [px, py] = local(e); zoomAt(px, py, 1.6); }
      endDrag();
    });
    box.addEventListener("pointercancel", endDrag);
    box.addEventListener("wheel", (e) => {
      stop(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const [px, py] = local(e);
      zoomAt(px, py, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018))); // trackpad pinch arrives as ctrl+wheel
    }, { passive: false });
    box.addEventListener("dblclick", stop); // a double-click here must not open another viewer or reach the page
    // Right-click zooms out at the cursor (instead of the browser's menu)
    box.addEventListener("contextmenu", (e) => {
      stop(e);
      if (e.target.closest("button")) return;
      const [px, py] = local(e);
      zoomAt(px, py, 1 / 1.6);
    });
    backdrop.addEventListener("pointerdown", (e) => { stop(e); close(); }); // click outside the picture closes
    host.addEventListener("click", (e) => e.stopPropagation());
    $(".zin").addEventListener("click", () => { const [cx, cy] = centre(); zoomAt(cx, cy, 1.5); });
    $(".zout").addEventListener("click", () => { const [cx, cy] = centre(); zoomAt(cx, cy, 1 / 1.5); });
    $(".fit").addEventListener("click", fit);
    // On-screen frame buttons send the same arrow key the page already listens to
    const frameStep = (d) => {
      const key = d < 0 ? "ArrowLeft" : "ArrowRight", code = d < 0 ? 37 : 39;
      const init = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
      const t = document.activeElement || document.body;
      t.dispatchEvent(new KeyboardEvent("keydown", init));
      t.dispatchEvent(new KeyboardEvent("keyup", init));
    };
    $(".fprev").addEventListener("click", () => frameStep(-1));
    $(".fnext").addEventListener("click", () => frameStep(1));
    host.addEventListener("mousedown", (e) => e.preventDefault()); // clicking the overview must not steal the page's keyboard focus
    $(".prev").addEventListener("click", () => step(-1)); // the side arrows switch camera again
    $(".next").addEventListener("click", () => step(1)); // (playback stepping stays on ← → and |◀ ▶|)
    $(".chip").addEventListener("click", () => step(1)); // camera pill: tap to cycle cameras (↑ ↓ also work)
    $(".exit").addEventListener("click", () => close());

    const onKey = (e) => {
      if (e.key === "Escape") { stop(e); close(); }
      else if (e.key === "ArrowUp") { stop(e); step(-1); }    // ↑ ↓ switch camera
      else if (e.key === "ArrowDown") { stop(e); step(1); }
      // ← → are deliberately left alone: the page steps the clip with them and the overview follows (see paint)
    };
    const onResize = () => fit();
    if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (Math.abs(s - fitS) < 1e-6) fit(); }).observe(box); // keep the overview filling its frame
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    function close() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("load", onImgLoad, true);
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      host.remove();
      if (viewer && viewer.host === host) viewer = null;
    }
    viewer = { host, close };
    show(current);
  }

  // Capture phase on the window so it still works if the page stops the event bubbling
  window.addEventListener("dblclick", (e) => {
    if (!enabled || e.button !== 0) return;
    if (viewer && e.composedPath().includes(viewer.host)) return; // inside the overview: nothing to open
    const img = cameraImageAt(e.clientX, e.clientY);
    if (!img) return;
    e.preventDefault();
    openViewer(img);
  }, true);
})();