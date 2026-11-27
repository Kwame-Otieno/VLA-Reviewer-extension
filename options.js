"use strict";

const $ = (id) => document.getElementById(id);
const escapeHTML = (str) => String(str ?? "").replace(/[&<>'"`]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;", "`": "&#96;"
}[c]));
const COLOR = { ok: "#15803d", err: "#ef4444" };

const isGroqModel = (modelId) => /^(llama|gemma|mixtral|qwen|openai\/|meta-llama\/|groq\/)/i.test(modelId);

function flash(btn, text, bg, resetText, ms = 2000) {
    btn.textContent = text;
    btn.style.background = bg || "";
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => { btn.textContent = resetText; btn.style.background = ""; }, ms);
}

function notify(html, cls = "warning") {
    $("notice").innerHTML = html ? `<div class="warning" style="margin-bottom: 16px;">${html}</div>` : "";
}

document.addEventListener("DOMContentLoaded", async () => {
    const stored = await chrome.storage.local.get([
        "vla_gemini_key", "vla_groq_key", "vla_gemini_key2", "vla_groq_key2", "vla_model", "vla_auto_fetch",
        "vla_auto_audit", "vla_show_badge", "vla_warn_page_change", "vla_theme",
        "calc_thresholds", "sheet_url"
    ]);

    if (stored.vla_theme) document.documentElement.setAttribute("data-theme", stored.vla_theme);

    $("api-key").value = stored.vla_gemini_key || "";
    $("groq-api-key").value = stored.vla_groq_key || "";
    $("api-key-2").value = stored.vla_gemini_key2 || "";
    $("groq-api-key-2").value = stored.vla_groq_key2 || "";
    $("model-input").value = stored.vla_model || VLA.DEFAULT_MODEL;
    VLA.setupModelPicker($("model-select"), $("model-input"));
    $("auto-fetch").checked = stored.vla_auto_fetch !== false;
    $("auto-audit").checked = stored.vla_auto_audit === true;
    $("show-badge").checked = stored.vla_show_badge !== false;
    $("warn-page-change").checked = stored.vla_warn_page_change === true;

    // Enforce checkbox dependencies
    $("auto-audit").addEventListener("change", (e) => {
        if (e.target.checked) $("auto-fetch").checked = true;
    });
    $("show-badge").addEventListener("change", (e) => {
        if (e.target.checked) $("auto-fetch").checked = true;
    });
    $("auto-fetch").addEventListener("change", (e) => {
        if (!e.target.checked) {
            $("show-badge").checked = false;
            $("auto-audit").checked = false;
        }
    });

    /* ---- Speed Calculator settings — shared with the calculator view in the side panel.
     * Saved instantly on change (no Save needed), using the same storage key the
     * side panel's calculator reads: calc_thresholds. ---- */
    const DEFAULT_THRESHOLDS = { nearStop: 0.3, stopDrop: 0.1, maintainBand: 0.8 };
    let THR = { ...DEFAULT_THRESHOLDS, ...((stored.calc_thresholds || {})) };
    delete THR.strongDrop; // retired setting
    const syncThresholdInputs = () => document.querySelectorAll(".thr-input").forEach((inp) => { inp.value = THR[inp.dataset.thr]; });

    document.querySelectorAll(".thr-input").forEach((inp) => {
        inp.addEventListener("input", () => {
            const v = parseFloat(inp.value);
            if (isNaN(v) || v < 0) { inp.style.borderColor = "var(--alert-warning-border)"; return; } // invalid → red border, not saved
            inp.style.borderColor = "";
            THR[inp.dataset.thr] = v;
            chrome.storage.local.set({ calc_thresholds: THR }).catch(() => {});
        });
    });

    $("thr-reset-btn").addEventListener("click", () => {
        THR = { ...DEFAULT_THRESHOLDS };
        chrome.storage.local.set({ calc_thresholds: THR }).catch(() => {});
        syncThresholdInputs();
        document.querySelectorAll(".thr-input").forEach((inp) => { inp.style.borderColor = ""; });
    });

    syncThresholdInputs();

    /* ---- Google Sheet link — saved instantly; the side panel's Sheets button reads "sheet_url" ---- */
    const normalizeSheetUrl = (raw) => {
        const t = (raw || "").trim();
        if (!t) return "";
        const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
        try {
            const u = new URL(withScheme);
            return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u.href : null;
        } catch (_) { return null; }
    };
    const sheetInput = $("sheet-url");
    sheetInput.value = stored.sheet_url || "";
    sheetInput.addEventListener("input", () => {
        const raw = sheetInput.value.trim();
        if (!raw) { // cleared → forget the link
            sheetInput.style.borderColor = "";
            chrome.storage.local.remove("sheet_url").catch(() => {});
            return;
        }
        const url = normalizeSheetUrl(raw);
        if (!url) { sheetInput.style.borderColor = "var(--alert-warning-border)"; return; } // invalid → red border, not saved
        sheetInput.style.borderColor = "";
        chrome.storage.local.set({ sheet_url: url }).catch(() => {});
    });

    $("save-key-btn").addEventListener("click", async () => {
        const btn = $("save-key-btn");
        const typedKey = $("api-key").value.trim();
        const typedGroqKey = $("groq-api-key").value.trim();
        const typedKey2 = $("api-key-2").value.trim();
        const typedGroqKey2 = $("groq-api-key-2").value.trim();
        const model = $("model-input").value.trim() || VLA.DEFAULT_MODEL;
        const isGroq = isGroqModel(model);

        if (isGroq && !typedGroqKey) {
            flash(btn, "Groq Key required!", COLOR.err, "Save & Verify");
            return;
        }
        if (!isGroq && !typedKey) {
            flash(btn, "Gemini Key required!", COLOR.err, "Save & Verify");
            return;
        }

        btn.textContent = "Verifying Key...";
        btn.disabled = true;

        // A rate-limited key (429 / quota / overload) is still valid — it just hit its limit for now.
        // Saving is allowed as long as at least one key of this provider works.
        const isLimitError = (status, msg) =>
            status === 429 || status === 503 ||
            /rate.?limit|quota|exhausted|overload|high demand|spikes in demand|too many requests/i.test(msg || "");

        const keyStatus = async (provider, key) => {
            try {
                let resp;
                if (provider === "groq") {
                    resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
                        body: JSON.stringify({ model: model, messages: [{ role: "user", content: "ping" }], max_tokens: 10 })
                    });
                } else {
                    resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
                        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] })
                    });
                }
                if (resp.ok) return "OK";
                const errJson = await resp.json().catch(() => ({}));
                const msg = errJson.error?.message || `HTTP ${resp.status}`;
                if (isLimitError(resp.status, msg)) return "LIMITED";
                return "INVALID:" + msg;
            } catch (e) {
                return "INVALID:" + (e.message || "network error");
            }
        };

        const provider = isGroq ? "groq" : "gemini";
        const name = isGroq ? "Groq" : "Google";
        const primary = isGroq ? typedGroqKey : typedKey;
        const backup = isGroq ? typedGroqKey2 : typedKey2;
        const [primaryStatus, backupStatus] = await Promise.all([
            keyStatus(provider, primary),
            (backup && backup !== primary) ? keyStatus(provider, backup) : Promise.resolve(null)
        ]);

        if (primaryStatus.startsWith("INVALID") && (!backupStatus || backupStatus.startsWith("INVALID"))) {
            // Neither key of this provider works — nothing usable to save
            flash(btn, "Invalid API Key ❌", COLOR.err, "Save & Verify", 3500);
            notify(`<strong>API Key Verification Failed:</strong> ${escapeHTML(primaryStatus.slice(8))}`);
            btn.disabled = false;
            return;
        }

        // At least one key works — save, but list anything worth knowing
        const warnings = [];
        if (primaryStatus.startsWith("INVALID")) warnings.push(`⚠️ Primary ${name} key failed (${primaryStatus.slice(8)}) — saved anyway because the backup works. Fix the primary key.`);
        if (primaryStatus === "LIMITED") warnings.push(`ℹ️ Primary ${name} key is at its rate limit right now — saved anyway.`);
        if (backupStatus === "LIMITED") warnings.push(`ℹ️ Backup ${name} key is at its rate limit right now — saved anyway.`);
        if (backupStatus && backupStatus.startsWith("INVALID")) warnings.push(`⚠️ Backup ${name} key could not be verified (${backupStatus.slice(8)}) — saved anyway. Check it when you can.`);

        chrome.storage.local.set({
            vla_gemini_key: typedKey,
            vla_groq_key: typedGroqKey,
            vla_gemini_key2: typedKey2,
            vla_groq_key2: typedGroqKey2,
            vla_model: model,
            vla_auto_fetch: $("auto-fetch").checked,
            vla_auto_audit: $("auto-audit").checked,
            vla_show_badge: $("show-badge").checked,
            vla_warn_page_change: $("warn-page-change").checked
        }, () => {
            btn.disabled = false;
            flash(btn, warnings.length ? "Saved with notes ⚠️" : "Saved & Verified ✓", COLOR.ok, "Save & Verify");
            notify(warnings.length ? `<strong>Saved with notes:</strong><br>${warnings.map(escapeHTML).join("<br>")}` : "");
            setTimeout(() => window.close(), warnings.length ? 4500 : 1000);
        });
    });
});
/* ---- Speed Calculator autocheck settings — shared with the side panel (instant-save).
 * Storage key "autocheck_settings": { enabled, frames }. The side panel's calculator
 * reads these (autocheck runs when a clip loads, while the calculator view is open). ---- */
document.addEventListener("DOMContentLoaded", async () => {
    const box = $("ac-enabled");
    const sel = $("ac-frames");
    if (!box || !sel) return;
    const DEFAULTS = { enabled: true, frames: 50 };
    const norm = (raw) => {
        const frames = parseInt(raw && raw.frames, 10);
        return {
            enabled: !raw || raw.enabled !== false,
            frames: frames >= 1 && frames <= 200 ? frames : DEFAULTS.frames
        };
    };
    const stored = (await chrome.storage.local.get("autocheck_settings").catch(() => ({}))) || {};
    const cur = norm(stored.autocheck_settings);
    box.checked = cur.enabled;
    sel.value = String(cur.frames);
    const save = () => {
        chrome.storage.local.set({ autocheck_settings: { enabled: box.checked, frames: parseInt(sel.value, 10) || DEFAULTS.frames } }).catch(() => {});
    };
    box.addEventListener("change", save);
    sel.addEventListener("change", save);

    /* "Disable speed check in review mode" — instant-save, key "vla_speed_check_review_off"
     * (read by the side panel: no speed measurement on /review/ pages / read-only clips) */
    const revBox = $("ac-review-off");
    if (revBox) {
        const st2 = (await chrome.storage.local.get("vla_speed_check_review_off").catch(() => ({}))) || {};
        revBox.checked = st2.vla_speed_check_review_off === true;
        revBox.addEventListener("change", () => {
            chrome.storage.local.set({ vla_speed_check_review_off: revBox.checked }).catch(() => {});
        });
    }
});

/* ---- Camera zoom on/off — instant-save, key "zoom_enabled" (read by zoom.js on the annotation page) ---- */
document.addEventListener("DOMContentLoaded", async () => {
    const box = $("zoom-enabled");
    if (!box) return;
    const st = (await chrome.storage.local.get("zoom_enabled").catch(() => ({}))) || {};
    box.checked = st.zoom_enabled !== false;
    box.addEventListener("change", () => chrome.storage.local.set({ zoom_enabled: box.checked }).catch(() => {}));
});