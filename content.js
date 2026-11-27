// Injected on demand by the side panel (together with shared.js) — it is no longer
// a static content script running on every https site. Safe to inject twice.
(() => {
  if (globalThis.__vlaContentLoaded || !globalThis.VLA) return;
  globalThis.__vlaContentLoaded = true;

  const { MANEUVERS, SPEEDS, CONTEXTS } = globalThis.VLA;

  /* ------------------------------------------------------------------
   * CONFIG — if the annotation tool changes its markup, tweak these.
   * ------------------------------------------------------------------ */
  const SELECTED_SEL = [
    '[aria-selected="true"]', '[aria-checked="true"]', '[aria-pressed="true"]',
    '[data-state="checked"]', '[data-state="on"]', '[data-selected="true"]',
    ".selected", ".active", ".is-selected", ".is-active", ".checked"
  ].join(",");
  const CLICKABLE_SEL = 'button, [role="button"], [role="option"], [role="radio"], [role="checkbox"], [role="tab"], label, li, span, div, option';

  /* ------------------------------------------------------------------ */

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => norm(el.innerText || el.textContent);
  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  function isSelected(el) {
    return el.matches(SELECTED_SEL)
    || !!el.parentElement?.matches(SELECTED_SEL)
    || !!el.querySelector('input:checked');
  }

  function findAll(text) {
    return [...document.querySelectorAll(CLICKABLE_SEL)].filter((el) => {
      if (textOf(el) !== text || !isVisible(el)) return false;
      return ![...el.children].some((c) => textOf(c) === text);
    });
  }

  function labelFor(ta) {
    const parts = [
      ta.getAttribute("aria-label"), ta.placeholder, ta.name, ta.id,
 ta.labels && [...ta.labels].map((l) => l.textContent).join(" "),
 ta.closest("label")?.textContent,
 ta.previousElementSibling?.textContent,
 ta.parentElement?.previousElementSibling?.textContent
    ];
    return norm(parts.filter(Boolean).join(" ")).toLowerCase();
  }

  function findTextareas() {
    const all = [...document.querySelectorAll("textarea")];
    const pick = (re, skip) => {
      const m = all.filter((t) => t !== skip && re.test(labelFor(t)));
      return m.find(isVisible) || m[0];
    };
    let desc = pick(/descri/);
    let causal = pick(/causal|action/, desc);
    const rest = all.filter((t) => t !== desc && t !== causal);
    if (!desc) desc = rest.shift();
    if (!causal) causal = rest.shift();
    return { desc, causal };
  }


  // Locates the camera-view grid (Left / Front / Right / Rear left / Frame counter / Rear right).
  // Prefers the data-locked-tiling container; falls back to the closest common ancestor of the camera <figure>s,
  // so it keeps working if the obfuscated class names change.
  const CAMERA_ALTS = ["left", "front", "right", "rear left", "rear right"];
  function findCameraGrid() {
    const tiled = [...document.querySelectorAll("[data-locked-tiling]")].find(isVisible);
    if (tiled) return tiled;

    const figs = [...document.querySelectorAll("figure")].filter((f) => {
      const img = f.querySelector("img");
      const cap = norm(f.querySelector("figcaption")?.textContent || img?.alt).toLowerCase();
      return img && isVisible(f) && CAMERA_ALTS.includes(cap);
    });
    if (figs.length < 2) return null;
    let anc = figs[0].parentElement;
    while (anc && !figs.every((f) => anc.contains(f))) anc = anc.parentElement;
    return anc && anc !== document.body ? anc : null;
  }

  // Rendered picture box of an <img>: when the element letterboxes the picture (object-fit: contain)
  // the black side bars are not part of the picture, so crop them away.
  function contentRect(img) {
    const r = img.getBoundingClientRect();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh || !r.width || !r.height) return r;
    const fit = getComputedStyle(img).objectFit;
    if (fit !== "contain" && fit !== "scale-down") return r;
    const s = Math.min(r.width / nw, r.height / nh);
    const w = nw * s, h = nh * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  }

  // Original-resolution pixels of an <img> already loaded on the page (null when the browser
  // refuses because the image is cross-origin without CORS headers).
  function imageToDataUrl(img, maxSide = 1600) {
    try {
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * s));
      c.height = Math.max(1, Math.round(img.naturalHeight * s));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.9);
    } catch (_) { return null; }
  }

  // "Hide path": true = trajectory overlay hidden (the raw camera image is exactly what the user sees),
  // false = overlay drawn on top, null = checkbox not found.
  function overlayHidden() {
    for (const lab of document.querySelectorAll("label")) {
      if (!/hide path/i.test(lab.textContent || "")) continue;
      const cb = lab.querySelector('input[type="checkbox"]') || (lab.htmlFor && document.getElementById(lab.htmlFor));
      if (cb) return !!cb.checked;
    }
    return null;
  }

  // --- Read Only Detection ---
  function checkReadOnly(desc, causal) {
    if (desc && (desc.disabled || desc.readOnly || desc.closest('[aria-disabled="true"]'))) return true;
    if (causal && (causal.disabled || causal.readOnly || causal.closest('[aria-disabled="true"]'))) return true;

    const pageText = document.body.textContent.toLowerCase();
    if (pageText.includes("ext_approved") && pageText.includes("read only")) return true;

    return false;
  }

  // Helper to extract and format the first name from an email string
  function extractFirstName(emailText) {
    if (!emailText || !emailText.includes("@")) return "";
    const localPart = emailText.split("@")[0]; // e.g., "kwame.otieno"
    const rawName = localPart.split(".")[0] || localPart.split("_")[0] || localPart;
    return rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
  }

  function readChoice(values) {
    for (const sel of document.querySelectorAll("select")) {
      const t = norm(sel.selectedOptions?.[0]?.textContent);
      if (values.includes(t)) return t;
    }
    for (const r of document.querySelectorAll("input[type=radio]:checked")) {
      const t = norm(r.labels?.[0]?.textContent || r.closest("label")?.textContent);
      if (values.includes(t)) return t;
    }
    for (const v of values) {
      if (findAll(v).some(isSelected)) return v;
    }
    const visible = values.filter((v) => findAll(v).length > 0);
    return visible.length === 1 ? visible[0] : "Auto";
  }

  function readContexts() {
    return CONTEXTS.map((c) => c.value).filter((v) => findAll(v).some(isSelected));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  /* ------------------------------------------------------------------
   * Silent Selection Handlers
   * ------------------------------------------------------------------ */
  const POPUP_SEL = '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-floating-ui-portal], .MuiPopover-root, .MuiPopper-root, .MuiMenu-root';
  const OPTION_SEL = '[role="option"], [role="menuitem"], [role="menuitemradio"]';
  const TRIGGER_SEL = 'button[aria-haspopup="listbox"], [role="combobox"][aria-haspopup="listbox"]';
  const CLOAK = [["opacity", "0"], ["pointer-events", "none"], ["transition", "none"], ["animation", "none"]];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sameText = (el, v) => norm(el.textContent).toLowerCase() === v.toLowerCase();

  async function waitFor(pred, timeout = 600, step = 25) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(step);
    }
  }

  async function withCloak(fn) {
    const keep = [...document.querySelectorAll(POPUP_SEL)].filter(isVisible);
    keep.forEach((el) => el.setAttribute("data-vla-keep", ""));
    const style = document.createElement("style");
    style.textContent = `:is(${POPUP_SEL}):not([data-vla-keep]) { opacity: 0 !important; pointer-events: none !important; transition: none !important; animation: none !important; }`;
    document.documentElement.appendChild(style);

    const preexisting = new Set(document.body.children);
    const cloaked = new Map();
    const cloak = (el) => {
      if (cloaked.has(el)) return;
      cloaked.set(el, el.getAttribute("style"));
      CLOAK.forEach(([p, v]) => el.style.setProperty(p, v, "important"));
    };
    const obs = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType !== 1) continue;
          let top = node;
          while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
          if (top.parentElement === document.body && !preexisting.has(top)) cloak(top);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    try { return await fn(); } finally {
      obs.disconnect(); style.remove();
      keep.forEach((el) => el.removeAttribute("data-vla-keep"));
      cloaked.forEach((orig, el) => { if (orig === null) el.removeAttribute("style"); else el.setAttribute("style", orig); });
    }
  }

  function popupOpen(trigger) {
    const expanded = trigger.getAttribute("aria-expanded");
    if (expanded !== null) return expanded === "true";
    return [...document.querySelectorAll(OPTION_SEL)].some(isVisible);
  }

  function findOption(value) {
    const byRole = [...document.querySelectorAll(OPTION_SEL)].find((el) => isVisible(el) && sameText(el, value));
    if (byRole) return byRole;
    for (const box of document.querySelectorAll('[role="listbox"], [role="menu"]')) {
      const hit = [...box.querySelectorAll("li, div, span, button")].find((el) =>
      isVisible(el) && sameText(el, value) && ![...el.children].some((c) => sameText(c, value)));
      if (hit) return hit;
    }
    return null;
  }

  function fullPress(el) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  async function openAndFind(trigger, value) {
    trigger.click();
    let option = await waitFor(() => findOption(value), 500);
    if (!option && !popupOpen(trigger)) {
      fullPress(trigger);
      option = await waitFor(() => findOption(value), 500);
    }
    return option;
  }

  async function closePopup(trigger) {
    if (popupOpen(trigger)) { trigger.click(); await sleep(60); }
    if (popupOpen(trigger)) { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(60); }
  }

  async function selectFromDropdown(value, list) {
    const triggers = [...document.querySelectorAll(TRIGGER_SEL)].filter(isVisible);
    if (!triggers.length) return null;
    const owns = (t) => list.some((v) => sameText(t, v));
    const ordered = [...triggers.filter(owns), ...triggers.filter((t) => !owns(t))];
    if (triggers.some((t) => owns(t) && sameText(t, value))) return "SUCCESS";

    return withCloak(async () => {
      for (const trigger of ordered) {
        const option = await openAndFind(trigger, value);
        if (option) {
          option.click();
          await waitFor(() => !popupOpen(trigger), 600);
          await closePopup(trigger);
          await sleep(60);
          return "SUCCESS";
        }
        await closePopup(trigger);
      }
      return "NOT_FOUND";
    });
  }

  async function ensurePill(value, want = true) {
    const candidates = findAll(value);
    if (!candidates.length) return "NOT_FOUND";
    const isOn = () => findAll(value).some(isSelected);
    if (isOn() === want) return "SUCCESS";
    const target = want ? candidates[0] : (candidates.find(isSelected) || candidates[0]);
    target.click();
    await sleep(120);
    return isOn() === want ? "SUCCESS" : "UNVERIFIED";
  }

  async function ensureSelected(value) {
    if (!value) return "SKIPPED";
    const list = MANEUVERS.includes(value) ? MANEUVERS : SPEEDS.includes(value) ? SPEEDS : null;
    if (!list) return ensurePill(value);

    for (const sel of document.querySelectorAll("select")) {
      const opt = [...sel.options].find((o) => norm(o.textContent).toLowerCase() === value.toLowerCase());
      if (opt) {
        if (sel.value !== opt.value) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return "SUCCESS";
      }
    }
    const existing = [...document.querySelectorAll(CLICKABLE_SEL)].find(
      (el) => isVisible(el) && sameText(el, value) && isSelected(el)
    );
    if (existing) return "SUCCESS";

    const viaDropdown = await selectFromDropdown(value, list);
    if (viaDropdown === "SUCCESS") return "SUCCESS";

    const candidates = findAll(value);
    if (!candidates.length) return "NOT_FOUND";
    candidates[0].click();
    return "SUCCESS";
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "EXTRACT_DATA") {
      const { desc, causal } = findTextareas();

      // Locate the email element dynamically when extracting data
      const emailElement = document.querySelector('span.xif65rj.x42gl0w');
      const userEmail = emailElement ? emailElement.textContent.trim() : "";
      const firstName = extractFirstName(userEmail);

      sendResponse({
        description: desc ? desc.value : "",
        causalAction: causal ? causal.value : "",
        maneuver: readChoice(MANEUVERS),
                   speedChange: readChoice(SPEEDS),
                   contexts: readContexts(),
                   found: { description: !!desc, causalAction: !!causal },
                   firstName: firstName,
                   isReadOnly: checkReadOnly(desc, causal)
      });
    }
    else if (request.action === "GET_CAMERA_RECT") {
      (async () => {
        const el = findCameraGrid();
        if (!el) { sendResponse({ found: false }); return; }
        const vw = window.innerWidth, vh = window.innerHeight;
        let r = el.getBoundingClientRect();
        if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) {
          el.scrollIntoView({ block: "center", inline: "center" });
          await sleep(250);
          r = el.getBoundingClientRect();
        }
        const x = Math.max(0, r.left), y = Math.max(0, r.top);
        const width = Math.min(vw, r.right) - x, height = Math.min(vh, r.bottom) - y;
        sendResponse({ found: width > 0 && height > 0, x, y, width, height, viewportWidth: vw });
      })();
      return true;
    }
    else if (request.action === "GET_CAMERA_TILES") {
      // One entry per camera (front / left / right / rear left / rear right) with the picture's own
      // rectangle and, when allowed, its original-resolution pixels.
      (async () => {
        const grid = findCameraGrid();
        if (!grid) { sendResponse({ found: false }); return; }
        const vw = window.innerWidth, vh = window.innerHeight;
        let gr = grid.getBoundingClientRect();
        if (gr.top < 0 || gr.left < 0 || gr.bottom > vh || gr.right > vw) {
          grid.scrollIntoView({ block: "center", inline: "center" });
          await sleep(250);
        }
        const hidePath = overlayHidden();
        // The original image has no path overlay, so only use it when the overlay is hidden anyway
        const wantOriginals = request.originals !== false && hidePath === true;
        const tiles = [];
        for (const fig of grid.querySelectorAll("figure")) {
          const img = fig.querySelector("img");
          const cap = norm(fig.querySelector("figcaption")?.textContent || img?.alt).toLowerCase();
          if (!CAMERA_ALTS.includes(cap)) continue;
          const ok = !!img && img.complete && img.naturalWidth > 0 && isVisible(img);
          const noFrame = !ok || /no frame was captured/i.test(norm(fig.textContent));
          const tile = { name: cap, noFrame };
          if (!noFrame) {
            const r = contentRect(img);
            Object.assign(tile, { x: r.left, y: r.top, width: r.width, height: r.height });
            if (wantOriginals) tile.dataUrl = imageToDataUrl(img);
          }
          tiles.push(tile);
        }
        sendResponse({ found: true, tiles, hidePath, viewportWidth: vw });
      })();
      return true;
    }
    else if (request.action === "APPLY_TEXT") {
      const { desc, causal } = findTextareas();
      const target = request.field === "box1" ? desc : causal;
      if (!target) { sendResponse({ status: "NOT_FOUND" }); return; }
      // Undo/redo safety: if the field was edited on the page since we last set it, don't clobber it silently
      if (typeof request.expect === "string" && norm(target.value) !== norm(request.expect)) {
        sendResponse({ status: "CHANGED", current: target.value });
        return;
      }
      const previous = target.value;
      target.focus();
      setNativeValue(target, request.text);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new Event("blur", { bubbles: true }));
      sendResponse({ status: "SUCCESS", previous });
    }
    else if (request.action === "APPLY_METRICS") {
      (async () => {
        const results = {
          maneuver: request.maneuver ? await ensureSelected(request.maneuver) : "SKIPPED",
       speedChange: request.speedChange ? await ensureSelected(request.speedChange) : "SKIPPED",
       contexts: {}
        };
        const wanted = Array.isArray(request.contexts) ? request.contexts : null;
        results.removed = {};
        if (wanted) {
          for (const { value } of CONTEXTS) {
            if (wanted.includes(value)) continue;
            if (findAll(value).some(isSelected)) results.removed[value] = await ensurePill(value, false);
          }
          for (const c of wanted) results.contexts[c] = await ensurePill(c, true);
        }
        sendResponse({ status: "DONE", results });
      })();
      return true;
    }
  });
})();