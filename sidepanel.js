"use strict";

/* ====================================================================
 * Helpers
 * ==================================================================== */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Stage timings (open the side panel's DevTools console and filter on "VLA perf")
const perfLog = (stage, ms) => { try { console.log(`[VLA perf] ${stage}: ${Math.round(ms)} ms`); } catch (_) {} };
const escapeHTML = (str) => String(str ?? "").replace(/[&<>'"`]/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;", "`": "&#96;"
}[c]));
const stripHash = (u) => (u || "").split("#")[0];

const ALLOWED_ORIGIN = "https://data-annotation-app.applied.ondana.ai";
const isRestrictedUrl = (u) => !u || !u.startsWith(ALLOWED_ORIGIN);

// Tolerant: strips code fences and, if there is prose around the JSON, parses from the first { to the last }
const parseLLMResponse = (text) => {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); } catch (e) {
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw e;
  }
};

const COLOR = { ok: "#15803d", err: "#ef4444", warn: "#ca8a04", good: "#059669" };
const FETCH_LABEL = "🔄 Fetch Data from Page";
const AUDIT_LABEL = "Check Compliance";

const VISION_DEFAULT_MODEL = "gemini-3.6-flash"; // image analysis reads markings/signs better than Flash-Lite

const state = {
  key: "",
  groqKey: "",
  model: VLA.DEFAULT_MODEL,
  chatModel: VLA.DEFAULT_MODEL,
  visionModel: VISION_DEFAULT_MODEL,
  autoFetch: true,
  autoAudit: false,
  showBadge: true,
  warnPageChange: false,
  badgeAlert: null,
  busy: false,
  auditTab: null,
  last: null,
  trusted: {},
  rephrased: { box1: [], box2: [] },
  lastSeenPage: "",
  pendingReloadTab: null,
  isReadOnly: false,
  speedCheckReviewOff: false, // "Disable speed check in review mode" (Settings / options page)
  userName: "",
  key2: "",     // backup Google AI Studio key (optional)
  groqKey2: ""  // backup Groq key (optional)
};

let pendingChatImage = null;

// Helper to determine if the selected model uses the Groq API (supports 2026 vendor prefixes)
const isGroqModel = (modelId) => /^(llama|gemma|mixtral|qwen|openai\/|meta-llama\/|groq\/)/i.test(modelId);

// Key cooldown: a key that just hit its rate limit is tried LAST for the next minute, so each new
// request doesn't waste a round-trip on a key that is still limited. It returns to the front
// automatically once the cooldown expires or the key works again.
const KEY_COOLDOWN_MS = 60000;
// Quotas are per model, so the cooldown is tracked per (model, key): a key limited on one model is not
// treated as limited on another.
const keyCooldown = new Map(); // "model|key" -> cooldown end (ms)
const cdKey = (model, key) => `${model || ""}|${key}`;
const markKeyLimited = (provider, key, model) => { if (key) keyCooldown.set(cdKey(model, key), Date.now() + KEY_COOLDOWN_MS); };
const clearKeyLimited = (key, model) => keyCooldown.delete(cdKey(model, key));
const isKeyLimited = (key, model) => { const u = keyCooldown.get(cdKey(model, key)); return !!u && Date.now() < u; };

// All usable API keys for one provider, in the order they should be tried: a key that is
// still in its rate-limit cooldown (for this model) goes last, the healthy key leads.
const providerKeys = (isGroq, model) => {
  const primary = ((isGroq ? state.groqKey : state.key) || "").trim();
  const backup = ((isGroq ? state.groqKey2 : state.key2) || "").trim();
  const keys = primary ? [primary] : [];
  if (backup && !keys.includes(backup)) keys.push(backup);
  if (keys.length > 1 && isKeyLimited(keys[0], model) && !isKeyLimited(keys[1], model)) keys.reverse();
  return keys;
};

// One model: first key; on a 429 / dead connection rotate once to the other key. Overload (503 / "high
// demand") is model-wide, so a second key can't help and it goes straight to the model fallback.
// If the other key was limited on this model a moment ago, it is not tried again (no bouncing).
async function runWithKeyRotation(model, run) {
  const isGroq = isGroqModel(model);
  const provider = isGroq ? "groq" : "gemini";
  const keys = providerKeys(isGroq, model);
  try {
    return await run(model, keys[0]);
  } catch (err) {
    const rateLimited = err.status === 429;
    if (!(rateLimited || err.isNetwork) || keys.length < 2) throw err;
    if (rateLimited) {
      markKeyLimited(provider, keys[0], model);
      if (isKeyLimited(keys[1], model)) { err.bothKeysLimited = true; throw err; }
      showKeyTooltip();
    }
    await sleep(250);
    try {
      return await run(model, keys[1]);
    } catch (err2) {
      if (err2.status === 429) {
        markKeyLimited(provider, keys[1], model);
        if (rateLimited) err2.bothKeysLimited = true; // both keys answered "limit reached"
      }
      throw err2;
    }
  }
}

// ==========================================
// API HELPERS: network retry + readable quota errors
// ==========================================
// fetch that retries once on a network-level failure (dropped connection, momentary DNS/VPN blip).
// Timeouts (AbortError) are never retried; a failure is flagged with .isNetwork for the callers.
async function fetchRetry(url, init, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (attempt >= retries) { e.isNetwork = true; throw e; }
      await sleep(300);
    }
  }
}

// Builds an Error from an API error body, keeping what we need to explain a 429 properly
function apiError(data, status) {
  const rawMsg = data?.error?.message || `HTTP ${status}`;
  const err = new Error(rawMsg);
  err.status = status;
  if (status === 429) {
    const details = data?.error?.details || [];
    const retry = details.find((d) => String(d["@type"] || "").includes("RetryInfo"))?.retryDelay;
    const secs = retry ? parseFloat(retry) : NaN;
    const violations = details.find((d) => String(d["@type"] || "").includes("QuotaFailure"))?.violations || [];
    err.retrySeconds = Number.isFinite(secs) ? secs : null;
    err.noFreeQuota = /limit:\s*0\b/.test(rawMsg);
    err.dailyQuota = violations.some((v) => /PerDay/i.test(v.quotaId || "")) || /per day/i.test(rawMsg);
  }
  return err;
}

function fmtDuration(secs) {
  if (secs < 90) return `${Math.ceil(secs)} seconds`;
  if (secs < 5400) return `${Math.round(secs / 60)} minutes`;
  return `${Math.round(secs / 3600)} hours`;
}

// Friendly replacement for the raw API error (or the original error if there is nothing to improve)
function decorateApiError(err, model) {
  const name = model || "this model";
  let msg = null;
  if (err.isNetwork) {
    msg = `Couldn't reach the API (network error: ${err.message}). Check your connection, VPN or ad blocker and try again.`;
  } else if (err.status === 429 && err.noFreeQuota) {
    msg = `${name} has no free-tier quota, so it can't be used with a free key. Pick another model in Settings (⚙️), e.g. Gemini 3.5 Flash-Lite.`;
  } else if (err.status === 429 && err.dailyQuota) {
    const when = err.retrySeconds ? ` It resets in about ${fmtDuration(err.retrySeconds)}.` : "";
    msg = `The daily free quota for ${name} is used up.${when} Pick another model in Settings (⚙️); a backup key only helps if it comes from a different Google project.`;
  } else if (err.status === 429 && err.retrySeconds) {
    msg = `Rate limit reached for ${name}. Try again in about ${fmtDuration(err.retrySeconds)}, or pick another model in Settings (⚙️).`;
  } else if (err.status === 404) {
    msg = `Model "${name}" was not found — pick a different model in Settings (⚙️). (${err.message})`;
  } else if (err.status === 429) {
    msg = `Rate limit reached — wait a moment, or pick another model in Settings (⚙️). (${err.message})`;
  }
  if (!msg) return err;
  if (err.status === 429 && err.bothKeysLimited) msg += " Both of your API keys were tried and both are limited. Keys from the same Google project share ONE quota, so a backup key only helps if it comes from a different project.";
  const out = new Error(msg);
  out.bothKeysLimited = err.bothKeysLimited;
  out.status = err.status;
  out.isNetwork = err.isNetwork;
  return out;
}

// ==========================================
// TEMPORARY MODEL REROUTE
// When the selected model is overloaded / rate limited / timing out, requests are served by a backup
// model for a cooldown period — the saved selection is never changed. When the cooldown ends, the
// next real request tries the selected model again (no extra "ping" requests, so no wasted quota):
// if it works the reroute is cleared, if it is still overloaded the cooldown grows (3 → 6 → 12 → 15 min).
// ==========================================
const SECONDARY_MODEL = "gemini-3.1-flash-lite";
const REROUTE_MIN_MS = 3 * 60 * 1000;
const REROUTE_MAX_MS = 15 * 60 * 1000;
const REROUTE_QUOTA_MS = 60 * 60 * 1000; // no free quota / daily quota used up: re-check hourly
const reroutes = new Map(); // selected model id -> { target, until, backoffMs }

const shortModelName = (id) => {
  const m = VLA.FREE_MODELS.find((x) => x.id === id);
  return m ? m.label.replace(/\s*\(.*\)\s*$/, "") : id;
};

function isRetryableApiError(e) {
  const msg = (e.message || "").toLowerCase();
  return msg.includes("high demand") || msg.includes("spikes in demand") || msg.includes("timed out") ||
    !!e.isTimeout || e.status === 429 || e.status === 503;
}

function rerouteCooldownMs(e, prevBackoffMs) {
  if (e.noFreeQuota || e.dailyQuota) return REROUTE_QUOTA_MS;
  return Math.min(prevBackoffMs ? prevBackoffMs * 2 : REROUTE_MIN_MS, REROUTE_MAX_MS);
}

// Models to try, in order, when `requested` can't serve the request (Gemini only — needs a Gemini key)
function fallbackChain(requested) {
  if (!(state.key || state.key2)) return [];
  return [VLA.DEFAULT_MODEL, SECONDARY_MODEL].filter((m, i, arr) => m !== requested && arr.indexOf(m) === i);
}

// attempt(model) must run one request on that model (including the primary→backup key rotation)
async function routeWithFallback(requested, attempt, indicatorId) {
  const chain = fallbackChain(requested);
  const prev = reroutes.get(requested);
  const rerouted = !!prev && Date.now() < prev.until;
  let lastErr = null;

  if (!rerouted) {
    try {
      updateModelIndicator(indicatorId, true);
      const out = await attempt(requested);
      if (prev) { // the selected model works again → leave the temporary reroute
        reroutes.delete(requested);
        showInfoTooltip(`✅ <b>${escapeHTML(shortModelName(requested))}</b> is back — switched back from <b>${escapeHTML(shortModelName(prev.target || ""))}</b>.`);
      }
      return out;
    } catch (e) {
      if (!chain.length || !isRetryableApiError(e)) {
        updateModelIndicator(indicatorId, false);
        throw decorateApiError(e, requested);
      }
      lastErr = e;
      const backoffMs = rerouteCooldownMs(e, prev && prev.backoffMs);
      reroutes.set(requested, { target: chain[0], until: Date.now() + backoffMs, backoffMs });
      showFallbackTooltip(shortModelName(requested), e.isTimeout || /timed out/i.test(e.message || "") ? "timeout" : "capacity",
        shortModelName(chain[0]), Math.max(1, Math.round(backoffMs / 60000)));
      await sleep(150);
    }
  }

  for (const target of chain) {
    try {
      const out = await attempt(target);
      const r = reroutes.get(requested);
      if (r) r.target = target;
      const mins = r ? Math.max(1, Math.round((r.until - Date.now()) / 60000)) : 0;
      updateModelIndicator(indicatorId, true, `Temporarily using ${shortModelName(target)} — ${shortModelName(requested)} is retried in ~${mins} min`);
      return out;
    } catch (e2) {
      lastErr = e2;
      if (!isRetryableApiError(e2)) break;
    }
  }
  updateModelIndicator(indicatorId, false);
  throw decorateApiError(lastErr || new Error("Request failed"), requested);
}

// ==========================================
// TOOLTIP HELPER FOR AUTO-FALLBACK
// ==========================================
function showFallbackTooltip(modelName, reasonType, targetName, minutes) {
  document.querySelectorAll(".fallback-tooltip").forEach(el => el.remove());

  const tooltip = document.createElement("div");
  tooltip.className = "fallback-tooltip";

  const why = reasonType === "timeout" ? "took too long to answer" : "is at capacity";
  tooltip.innerHTML = `⚠️ <b>${escapeHTML(modelName)}</b> ${why}.<br>Using <b>${escapeHTML(targetName)}</b> for now — retrying in ~${minutes} min.`;

  document.body.appendChild(tooltip);
  setTimeout(() => tooltip.remove(), 4500);
}

// Plain info tooltip (same look), e.g. when the preferred model is back
function showInfoTooltip(html) {
  document.querySelectorAll(".fallback-tooltip").forEach(el => el.remove());
  const tooltip = document.createElement("div");
  tooltip.className = "fallback-tooltip";
  tooltip.innerHTML = html;
  document.body.appendChild(tooltip);
  setTimeout(() => tooltip.remove(), 4000);
}

// Tooltip shown when a request rotates from the primary API key to the backup key
function showKeyTooltip() {
  document.querySelectorAll(".fallback-tooltip").forEach(el => el.remove());

  const tooltip = document.createElement("div");
  tooltip.className = "fallback-tooltip";
  tooltip.innerHTML = `🔑 This API key hit its rate limit.<br>Switching to your <b>backup key</b>...`;

  document.body.appendChild(tooltip);
  setTimeout(() => tooltip.remove(), 4000);
}

function updateModelIndicator(modelInputId, isActive, note) {
  const inputEl = $(modelInputId);
  if (!inputEl) return;
  let wrapper = inputEl.parentElement;
  if (!wrapper) return;

  let indicator = wrapper.querySelector(".model-active-indicator");
  if (!indicator) {
    indicator = document.createElement("span");
    indicator.className = "model-active-indicator";
    indicator.title = "Active Model Status";
    wrapper.style.position = "relative";
    wrapper.appendChild(indicator);
  }

  indicator.style.cssText = `
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: 8px;
    height: 8px;
    background-color: ${note ? "#f59e0b" : isActive ? "#10b981" : "#6b7280"};
    border-radius: 50%;
    box-shadow: 0 0 6px ${note ? "#f59e0b" : isActive ? "#10b981" : "transparent"};
  `;
  indicator.title = note || "Active Model Status"; // amber dot = temporarily rerouted to a backup model
}

function flash(btn, text, bg, resetText, ms = 2000) {
  btn.textContent = text;
  btn.style.background = bg || "";
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => { btn.textContent = resetText; btn.style.background = ""; }, ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const temp = document.createElement("textarea");
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(temp);
    return ok;
  }
}

async function handleCopy(btn, text, defaultText = "Copy") {
  const ok = await copyText(text);
  flash(btn, ok ? "Copied! ✓" : "Copy failed", ok ? COLOR.ok : COLOR.err, defaultText);
}

function setUIState(isProcessing) {
  document.querySelectorAll("textarea, select, .context-pill, #fetch-btn, #refresh-btn, #audit-btn, #speed-calc-btn").forEach((el) => {
    el.disabled = isProcessing;
  });
}

function notify(html, cls = "warning") {
  const readOnlyBanner = state.isReadOnly
  ? `<div class="card warning">⚠️ This clip is <strong>read only</strong>. You cannot apply changes. Please ask your reviewer to <strong>reject</strong> the clip first to unlock it.</div>`
  : "";
  const standardNotice = html ? `<div class="card ${cls}">${html}</div>` : "";
  $("notice").innerHTML = readOnlyBanner + standardNotice;
}

/* ---- Google Sheet shortcut: the link comes from Settings (storage key "sheet_url") ---- */
// "https://…" with a scheme added when the user pastes a bare docs.google.com/… link; null if invalid
const normalizeSheetUrl = (raw) => {
  const t = (raw || "").trim();
  if (!t) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u.href : null;
  } catch (_) { return null; }
};

// Identity of a sheet: its spreadsheet ID (so ?gid=…, #gid=… and /u/1/ variants all match);
// any other link falls back to origin + path.
const sheetKey = (u) => {
  try {
    const x = new URL(u);
    const m = x.pathname.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/);
    return m ? `sheet:${m[1]}` : `${x.origin}${x.pathname.replace(/\/+$/, "")}`;
  } catch (_) { return null; }
};

async function getSheetUrl() {
  const st = (await chrome.storage.local.get("sheet_url").catch(() => ({}))) || {};
  return normalizeSheetUrl(st.sheet_url) || "";
}

// The tab that holds the clip: the last tab we read from / audited, if it still exists and is
// still on the annotation site (a closed or navigated-away tab is no longer "the clip").
async function findClipTab() {
  for (const c of [state.dataTab, state.auditTab]) {
    if (!c) continue;
    const t = await chrome.tabs.get(c.id).catch(() => null);
    if (t && !isRestrictedUrl(t.url)) return t;
  }
  return null;
}

let footerSeq = 0;
async function updateFooterButtons(activeTab) {
  const seq = ++footerSeq; // only the latest call may touch the buttons (these awaits can finish out of order)
  const sheetBtn = $("open-sheet-btn");
  const returnBtn = $("return-tab-btn");
  if (!sheetBtn || !returnBtn) return;

  let tab = activeTab;
  if (!tab) tab = await getActiveTab().catch(() => null);
  if (!tab) return;

  const sheetUrl = await getSheetUrl();
  const clipTab = await findClipTab();
  if (seq !== footerSeq) return;

  const key = sheetUrl ? sheetKey(sheetUrl) : null;
  const isOnSheet = !!(key && tab.url && sheetKey(tab.url) === key);

  sheetBtn.disabled = !!isOnSheet;
  sheetBtn.style.opacity = isOnSheet ? "0.5" : "1";
  sheetBtn.style.cursor = isOnSheet ? "not-allowed" : "pointer";

  const isOnClip = !!clipTab && tab.id === clipTab.id;
  const disableReturn = !clipTab || isOnClip;

  returnBtn.disabled = !!disableReturn;
  returnBtn.style.opacity = disableReturn ? "0.5" : "1";
  returnBtn.style.cursor = disableReturn ? "not-allowed" : "pointer";
}

/* ====================================================================
 * Toolbar Icon Badge Handler
 * ==================================================================== */
// Which selection a Causal Action / selection warning is really about (null = a plain text problem)
function topicOfWarning(w) {
  const t = String(w || "");
  // The telemetry cross-checks get their OWN topics: classified as "speed"/"maneuver" they would
  // be dropped by the one-problem-one-warning dedupe whenever the mismatch / a model warning had
  // already claimed that topic — exactly in the wrong-selection cases they exist for.
  if (/^Context mismatch:/i.test(t)) return "context";
  if (/brake pedal/i.test(t)) return "brake";
  if (/steering angle/i.test(t)) return "steer";
  if (/speed[- ]change|measured|telemetry|speed match|\b(?:accelerat|decelerat)\w*|maintain(?:s|ing)? speed|remain stopped|resume motion/i.test(t)) return "speed";
  if (/\bcontexts?\b|cut-in|consistent driving|slow for the lead|stop for the lead|yield to vrus?|nudge preparation|lane change preparation/i.test(t)) return "context";
  if (/\bmaneuvers?\b|lane change (?:left|right)|gap-searching|pull-over|start from stop|lead obstacle following/i.test(t)) return "maneuver";
  return null;
}

async function updateBadge() {
  if (!chrome.action) return;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = tabs[0]?.id;

  if (!state.showBadge) {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    if (tabId) chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
    return;
  }

  const isUsingGroq = isGroqModel(state.model);
  const hasRequiredKey = isUsingGroq ? (state.groqKey || state.groqKey2) : (state.key || state.key2);

  if (!hasRequiredKey) {
    chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#ca8a04" }).catch(() => {});
    return;
  } else {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }

  if (!tabId) return;

  if (state.badgeAlert === "NO_ACCESS") {
    chrome.action.setBadgeText({ text: "!", tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444", tabId }).catch(() => {});
    return;
  }

  if (!state.autoFetch || !state.last || !state.last.res || !state.auditTab || state.auditTab.id !== tabId) {
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
    return;
  }

  const res = state.last.res;
  const ctx = state.last.ctx;

  // One underlying problem = ONE count, wherever it shows up. A wrong Maneuver / Speed Change / Context
  // selection and the Causal Action warnings that are just that same problem seen from the text side
  // (e.g. a verb that contradicts the measured speed) are merged; identical warnings in one box count once.
  const uniq = (arr) => { const seen = new Set(); return (arr || []).filter((w) => { const k = String(w).trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const box1W = uniq(res.box1?.warnings);
  let box2W = uniq(res.box2?.warnings);

  const mismatched = []; // topics whose selection disagrees with the prediction / measurement
  const p = res.predictedManeuver;
  if (p && ctx) {
    const sameSet = (a, b) => a.length === b.length && a.every((c) => b.includes(c));
    const userAuto = ctx.userContexts.length === 1 && ctx.userContexts[0] === "Auto";
    // "Auto" = unset (predicted, not criticised) — never a badge violation
    if (!(ctx.userManeuver === "Auto" || (!!p.maneuverLabel && ctx.userManeuver === p.maneuverLabel))) mismatched.push("maneuver");
    if (!(ctx.userSpeed === "Auto" || (!!p.suggestedSpeedChange && ctx.userSpeed === p.suggestedSpeedChange))) mismatched.push("speed");
    if (!(userAuto || sameSet(p.suggestedContexts, ctx.userContexts))) mismatched.push("context");
  }
  if (!mismatched.includes("context") && (res.selectionWarnings || []).some((w) => /^Context mismatch:/i.test(w))) mismatched.push("context");
  if (mismatched.length) {
    box2W = box2W.filter((w) => {
      const t = topicOfWarning(w);
      return !(t && mismatched.includes(t)); // already counted as the selection problem
    });
  }

  const totalViolations = box1W.length + box2W.length + mismatched.length;

  const text = totalViolations > 0 ? String(totalViolations) : "✓";
  const color = totalViolations > 0 ? "#ef4444" : "#10b981";

  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
}

/* ====================================================================
 * AI Chat Logic
 * ==================================================================== */
let chatHistory = [];

// What is actually sent: the last few turns only, and screenshots only on the newest message
// (older ones are replaced by a text note) — chatHistory itself is never changed.
const CHAT_HISTORY_TURNS = 10;
function prepareChatContents(contents) {
  let c = contents.slice(-CHAT_HISTORY_TURNS);
  while (c.length > 1 && c[0].role !== "user") c = c.slice(1);
  const last = c.length - 1;
  return c.map((m, i) => (i === last || !m.parts.some((p) => p.inlineData)) ? m
    : { ...m, hasImage: false, parts: m.parts.map((p) => (p.inlineData ? { text: "[earlier screenshot omitted]" } : p)) });
}
// Blocks that are only worth sending when the user is talking about rules / flags / syntax
function chatExtraBlocks(contents) {
  const last = [...contents].reverse().find((m) => m.role === "user");
  const t = last ? last.parts.map((p) => p.text || "").join(" ") : "";
  return /\b(rules?|flag(?:s|ged|ging)?|false.?positives?|syntax|guard)\b/i.test(t) ? ["FALSE_POSITIVE_GUARD", "STANDARD_DESCRIPTION_SYNTAX"] : [];
}

async function callChatGemini(contents) {
  contents = prepareChatContents(contents);
  const lastIsImage = !!(contents.length && contents[contents.length - 1].hasImage);
  const originalModel = lastIsImage ? state.visionModel : state.chatModel;

  const executeFetch = async (modelToUse, apiKey = null) => {
    const isGroq = isGroqModel(modelToUse);
    const usableKey = apiKey || providerKeys(isGroq, modelToUse)[0];
    if (!usableKey) throw new Error(`Add your ${isGroq ? "Groq" : "Google AI Studio"} API key in settings (⚙️) first.`);

    const lastMsg = contents[contents.length - 1];
    let systemText = Prompts.getChatSystemInstruction(state.last, { extraBlocks: chatExtraBlocks(contents) });
    if (lastMsg && lastMsg.hasImage) {
      systemText = Prompts.getChatVisionSystemInstruction(state.last);
    } else if (lastSceneRead && lastSceneRead.description) {
      // The image tool's findings ride along, so follow-up questions understand what was described
      systemText += "\n\n=== WHAT THE IMAGE TOOL DESCRIBED (camera observations of this clip) ===\n"
        + "Generated Description: \"" + lastSceneRead.description + "\"\n"
        + "Raw camera observations: " + JSON.stringify(lastSceneRead.observations) + "\n"
        + "When the user asks about the scene, what is around ego, or why the Description says what it says, answer from these observations. Never invent scene details that are not in them, and keep anything you write consistent with the Generated Description.";
    }

    let url, body, headers;
    if (isGroq) {
      url = "https://api.groq.com/openai/v1/chat/completions";
      const messages = [{ role: "system", content: systemText }];
      
      contents.forEach(m => {
        let contentVal;
        const hasImages = m.parts.some(p => p.inlineData);
        
        if (hasImages) {
          contentVal = [];
          m.parts.forEach(p => {
            if (p.text) contentVal.push({ type: "text", text: p.text });
            if (p.inlineData) {
              contentVal.push({
                type: "image_url",
                image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` }
              });
            }
          });
        } else {
          contentVal = m.parts.map(p => p.text || "").join("\n");
        }
        
        messages.push({ role: m.role === "model" ? "assistant" : "user", content: contentVal });
      });

      body = {
        model: modelToUse,
        messages: messages,
        temperature: (lastMsg && lastMsg.hasImage) ? 0.2 : 0.7,
        max_tokens: 4096
      };
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${usableKey}` };
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelToUse)}:generateContent`;
      const cleanedContents = contents.map(m => ({
        role: m.role,
        parts: m.parts.map(p => {
          if (p.inlineData) return { inline_data: { mime_type: p.inlineData.mimeType, data: p.inlineData.data } };
          return { text: p.text };
        })
      }));

      body = {
        contents: cleanedContents,
        systemInstruction: { parts: [{ text: systemText }] },
        generationConfig: { 
          temperature: (lastMsg && lastMsg.hasImage) ? 0.2 : 0.7,
          maxOutputTokens: 3000, // room for thinking + a full rule proposal (800 truncated them)
          ...(/^gemini-3/i.test(modelToUse) ? { thinkingConfig: { thinkingLevel: "low" } } : {})
        }
      };
      headers = { "Content-Type": "application/json", "x-goog-api-key": usableKey };
    }

    const controller = new AbortController();
    const chatTimeoutMs = (lastMsg && lastMsg.hasImage) ? 60000 : 30000;
    const timeoutId = setTimeout(() => controller.abort(), chatTimeoutMs);

    try {
      const resp = await fetchRetry(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await resp.json();
      if (!resp.ok || data.error) throw apiError(data, resp.status);

      let out = "";
      if (isGroq) {
          out = data.choices?.[0]?.message?.content || "";
      } else {
          const cand = data.candidates?.[0];
          out = (cand?.content?.parts || []).map((p) => p.text || "").join("");
      }
      
      if (!out) throw new Error(`Empty response from model.`);
      // The key that just worked is healthy again — clear its cooldown so it leads the next run
      clearKeyLimited(usableKey, modelToUse);
      return out;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === "AbortError") {
        const timeoutErr = new Error("The request timed out after " + Math.round(chatTimeoutMs / 1000) + " seconds. Try again or switch to Flash Lite.");
        timeoutErr.isTimeout = true;
        throw timeoutErr;
      }
      if (e.isNetwork) {
        const netErr = new Error(`Network error: ${e.message}`);
        netErr.isNetwork = true;
        throw netErr;
      }
      throw e;
    }
  };

  // One model: primary key first; on a rate limit / dead connection rotate once to the backup key
  const tryChatKeys = (model) => runWithKeyRotation(model, executeFetch);

  return routeWithFallback(originalModel, tryChatKeys, "chat-model-input");
}

function formatChatText(text) {
  let t = escapeHTML(text);
  t = t.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|\n)\* /g, '$1• ');
  t = t.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
  return t;
}

/* ====================================================================
 * AI prompt editor: the chat can propose changes to the rule blocks.
 * The model only PROPOSES (a <<<RULE_PROPOSAL>>> JSON block in its reply);
 * the change is written to the block override (chrome.storage
 * "vla_prompt_overrides", same as Settings → 🧠 Prompts) only after the
 * user presses "Apply rule" on the confirmation card.
 * ==================================================================== */
const RULE_PROPOSAL_RE = /<+\s*RULE[\s_-]*PROPOSAL\s*>+\s*([\s\S]*?)\s*<+\s*END[\s_-]*RULE[\s_-]*PROPOSAL\s*>+/i;
const RULE_LOOSE_RE = /<+\s*RULE[\s_-]*PROPOSAL[\s\S]*/i; // malformed block: strip from the marker to the end
const RULE_BLOCK_KEYS = ["UNIVERSAL_RULES", "LANE_AND_ROAD_RULES", "DESCRIPTION_RULES", "CAUSAL_RULES", "MANEUVER_RULES", "CROSS_FIELD_RULES", "DECISION_FRAME_GUIDE", "EXAMPLES", "FALSE_POSITIVE_GUARD", "STANDARD_DESCRIPTION_SYNTAX"];

// Lenient JSON reader for model output. Models often wrap the proposal in a code fence, use
// smart quotes, leave a trailing comma, or break a string across lines — all of which make
// strict JSON.parse fail and the whole proposal get thrown away as "malformed". Strip the
// fences, normalize the quotes, drop trailing commas, and if parsing still fails pull the
// fields out with regexes (which also survives literal line breaks inside string values).
function parseProposalJson(raw) {
  let t = String(raw || "").replace(/```[a-z]*/gi, "").replace(/```/g, "");
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  t = t.slice(s, e + 1)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(t); } catch (_) {}
  // Last resort: the model left inner double quotes unescaped (e.g. a rule that starts with
  // "Bypass construction objects":), so the JSON is broken and cannot be parsed. Recover the
  // fields by their known key markers instead: a value runs from after its opening quote to
  // the last `","` before the next known key (or to the closing quote of the object).
  const KEYS = ["block", "action", "find", "replace", "after", "summary"];
  const starts = {};
  for (const k of KEYS) {
    const m = t.match(new RegExp('"' + k + '"\\s*:\\s*"', "i"));
    if (m) starts[k] = m.index + m[0].length;
  }
  const order = KEYS.filter((k) => starts[k] !== undefined).sort((a, b) => starts[a] - starts[b]);
  if (!order.includes("block")) return null;
  const o = {};
  for (let i = 0; i < order.length; i++) {
    const k = order[i], from = starts[k];
    let to;
    if (i + 1 < order.length) {
      const seg = t.slice(from, starts[order[i + 1]]);
      const cut = seg.lastIndexOf('","');
      to = cut === -1 ? seg.length : cut;
    } else {
      const close = t.lastIndexOf('"');
      to = close > from ? close - from : t.length - from;
    }
    o[k] = t.slice(from, from + to).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return o;
}

// The model sometimes invents a block name that does not exist (e.g. "CONTEXT_RULES" for the
// context rulings, which actually live in MANEUVER_RULES). Map near-miss names onto the real
// blocks instead of throwing the whole proposal away.
const RULE_BLOCK_ALIASES = [
  [/FALSE|GUARD|POSITIVE/, "FALSE_POSITIVE_GUARD"],
  [/SYNTAX|STANDARD/, "STANDARD_DESCRIPTION_SYNTAX"],
  [/^UNIVERSAL/, "UNIVERSAL_RULES"],
  [/LANE|ROAD/, "LANE_AND_ROAD_RULES"],
  [/DESC/, "DESCRIPTION_RULES"],
  [/CAUSAL/, "CAUSAL_RULES"],
  [/CROSS/, "CROSS_FIELD_RULES"],
  [/DECISION|FRAME/, "DECISION_FRAME_GUIDE"],
  [/EXAMPLE/, "EXAMPLES"],
  [/MANEUVER|CONTEXT|SPEED/, "MANEUVER_RULES"],
];
function normalizeRuleBlockKey(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return null;
  if (RULE_BLOCK_KEYS.includes(s)) return s;
  for (const [re, key] of RULE_BLOCK_ALIASES) if (re.test(s)) return key;
  return null;
}

// Parses ONE proposal (the raw JSON between the markers); null when unusable.
function parseRuleProposalBody(body) {
  const p = parseProposalJson(body);
  if (!p) return null;
  const block = normalizeRuleBlockKey(p.block);
  if (!block) return null;
  const action = p.action === "update" || p.action === "remove" ? p.action : "add";
  const find = String(p.find || "").trim();
  const replace = String(p.replace || "").trim();
  if (action !== "add" && !find) return null;
  if (action !== "remove" && !replace) return null;
  return { block, action, find, replace, after: String(p.after || "").trim(), summary: String(p.summary || "").trim() };
}

function parseRuleProposal(text) {
  const m = String(text || "").match(RULE_PROPOSAL_RE);
  return m ? parseRuleProposalBody(m[1]) : null;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normWs = (s) => String(s || "").replace(/\s+/g, " ").trim();
const ruleTextRe = (needle, global) => new RegExp("[ \\t]*" + escRe(normWs(needle)).split(" ").join("\\s+") + "\\n?", global ? "g" : "");

// Fuzzy fallback for "find": the model is told to quote the rule text character-for-character,
// but it sometimes paraphrases or the block was edited since the proposal. When the exact
// (whitespace-tolerant) match fails, match the closest rule line by token overlap instead of
// failing outright — the user still confirms every apply on the card.
const normText = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const lineScore = (line, needle) => {
  const hay = new Set(normText(line).split(" ").filter(Boolean));
  const parts = normText(needle).split(" ").filter(Boolean);
  if (!parts.length) return 0;
  let hit = 0;
  for (const t of parts) if (hay.has(t)) hit++;
  return hit / parts.length;
};
function fuzzyFindLine(blockText, find) {
  const lines = blockText.split("\n");
  let best = null, second = 0;
  lines.forEach((line, i) => {
    const sc = lineScore(line, find);
    if (!best || sc > best.s) { if (best) second = best.s; best = { s: sc, i, line: line.trim() }; }
    else if (sc > second) second = sc;
  });
  if (!best || best.s < 0.6) return null; // below this the match is too ambiguous to trust
  if (second >= 0.6 && second >= best.s - 0.05) return null; // two lines match about equally: refuse to guess
  return best;
}

// Where would this proposal land? Used by the card BEFORE applying (so the user sees the line that
// will really change) and again by applyRuleProposal on click.
function resolveRuleTarget(p, cur) {
  if (typeof cur !== "string") return { kind: "none", msg: "Unknown prompt block." };
  if (p.action === "add") {
    if (!p.after) return { kind: "end" };
    const m = fuzzyFindLine(cur, p.after);
    return m ? { kind: "anchor", i: m.i, line: m.line } : { kind: "end", anchorMissing: true };
  }
  const lines = cur.split("\n");
  if (ruleTextRe(p.find).test(cur)) {
    const i = lines.findIndex((l) => normWs(l).includes(normWs(p.find)));
    return { kind: "exact", i, line: i >= 0 ? lines[i].trim() : normWs(p.find) };
  }
  const m = fuzzyFindLine(cur, p.find);
  if (!m) return { kind: "none", msg: "The rule text was not found in the block (or two lines match equally) — it may have changed since the proposal. Open ⚙️ Settings → 🧠 Prompts to edit it by hand." };
  return { kind: "fuzzy", i: m.i, line: m.line };
}

// The closest existing rules in all editable blocks (local, free): shown on the card so the user
// sees a duplicate or a contradicting rule before applying.
function relatedRules(p, skipLine) {
  const needle = normText(p.replace || p.find).split(" ").filter((t) => t.length > 3);
  if (needle.length < 2) return [];
  const out = [];
  for (const k of RULE_BLOCK_KEYS) {
    const txt = Prompts.getBlock(k);
    if (typeof txt !== "string") continue;
    for (const line of txt.split("\n")) {
      const l = line.trim();
      if (l.length < 20 || l === skipLine) continue;
      const hay = new Set(normText(l).split(" "));
      let hit = 0;
      for (const t of needle) if (hay.has(t)) hit++;
      const sc = hit / needle.length;
      if (sc >= 0.5) out.push({ s: sc, k, line: l });
    }
  }
  return out.sort((x, y) => y.s - x.s).slice(0, 3);
}

// Undo history: the block text before each applied change (last 20)
const RULE_HISTORY_KEY = "vla_prompt_history";
async function rememberRuleChange(block, before) {
  try {
    const r = await chrome.storage.local.get(RULE_HISTORY_KEY);
    const h = Array.isArray(r[RULE_HISTORY_KEY]) ? r[RULE_HISTORY_KEY] : [];
    h.push({ block, before, t: Date.now() });
    await chrome.storage.local.set({ [RULE_HISTORY_KEY]: h.slice(-20) });
  } catch (_) {}
}

async function applyRuleProposal(p) {
  const cur = Prompts.getBlock(p.block);
  if (typeof cur !== "string") return { ok: false, msg: "Unknown prompt block." };
  const t = resolveRuleTarget(p, cur);
  let next = cur;
  let note = null;
  if (p.action === "add") {
    const line = p.replace.replace(/^\s+/, "");
    if (normWs(cur).includes(normWs(line))) return { ok: false, msg: "That exact rule is already in the block — nothing to add." };
    if (t.kind === "anchor") {
      const ls = cur.split("\n");
      ls.splice(t.i + 1, 0, "  " + line);
      next = ls.join("\n");
    } else {
      next = cur.replace(/\s*$/, "") + "\n  " + line + "\n";
      if (t.anchorMissing) note = "the line to insert after was not found, so it was added at the end";
    }
  } else if (t.kind === "none") {
    return { ok: false, msg: t.msg };
  } else if (t.kind === "exact") {
    if (p.action === "update") next = cur.replace(ruleTextRe(p.find), () => "  " + p.replace.replace(/^\s+/, "") + "\n");
    else next = cur.replace(ruleTextRe(p.find, true), "").replace(/\n{3,}/g, "\n\n");
  } else { // fuzzy: the same line the card showed
    if (p.action === "update") next = cur.split("\n").map((l, i) => (i === t.i ? "  " + p.replace.replace(/^\s+/, "") : l)).join("\n");
    else next = cur.split("\n").filter((_, i) => i !== t.i).join("\n").replace(/\n{3,}/g, "\n\n");
    note = "matched by similarity to: \u201C" + (t.line.length > 120 ? t.line.slice(0, 117) + "..." : t.line) + "\u201D";
  }
  await rememberRuleChange(p.block, cur);
  await Prompts.setBlock(p.block, next);
  return { ok: true, note, before: cur, after: next };
}

function addRuleUndoRow(block, before, after) {
  const container = $("chat-history");
  if (!container) return;
  const row = document.createElement("div");
  row.className = "btn-row";
  row.style.margin = "4px 0 8px";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "action-btn";
  b.textContent = "↩ Undo this rule change";
  b.onclick = async () => {
    b.disabled = true;
    if (Prompts.getBlock(block) !== after) {
      appendChatMessage("error", "⚠️ The " + ruleBlockLabel(block) + " block was changed again since — undo it in ⚙️ Settings → 🧠 Prompts.");
      row.remove();
      return;
    }
    await Prompts.setBlock(block, before);
    row.remove();
    appendChatMessage("model", "↩ Undone — the " + ruleBlockLabel(block) + " block is back to how it was before that change.");
  };
  row.appendChild(b);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function ruleBlockLabel(key) {
  const blocks = typeof Prompts.listBlocks === "function" ? Prompts.listBlocks() : [];
  const b = blocks.find((x) => x.key === key);
  return b ? b.label : key;
}

function buildRuleProposalCard(p) {
  const card = document.createElement("div");
  card.style.cssText = "background: var(--bg-suggestion); border: 1px solid var(--border-input); padding: 8px; border-radius: 6px; margin: 8px 0;";
  const mk = (css, text) => { const d = document.createElement("div"); d.style.cssText = css + " word-break: break-word;"; d.textContent = text; card.appendChild(d); return d; };
  const cur = Prompts.getBlock(p.block);
  const t = resolveRuleTarget(p, cur);
  mk("font-size: 11px; color: var(--text-muted); font-weight: 600; margin-bottom: 4px; text-transform: uppercase;", "Proposed rule change — waiting for your confirmation");
  mk("font-size: 11px; color: var(--text-main); margin-bottom: 4px;", (p.action === "add" ? "Add to " : p.action === "update" ? "Update in " : "Remove from ") + ruleBlockLabel(p.block) + ":");

  let blocked = false;
  if (p.action !== "add") {
    if (t.kind === "none") {
      blocked = true;
      mk("font-size: 11px; color: var(--alert-warning-border); margin-bottom: 4px;", "⚠️ " + t.msg);
      if (p.find) mk("font-size: 11px; color: var(--text-muted); text-decoration: line-through; margin-bottom: 2px;", p.find);
    } else {
      mk("font-size: 11px; color: var(--text-muted); text-decoration: line-through; margin-bottom: 2px;", t.line);
      if (t.kind === "fuzzy") mk("font-size: 10px; color: var(--alert-warning-border); margin-bottom: 4px;", "No exact match — this is the closest rule in the block, and this is the line that will be changed.");
    }
  } else if (t.kind === "anchor") {
    mk("font-size: 10px; color: var(--text-muted); margin-bottom: 4px;", "Inserted right after: " + t.line);
  } else {
    mk("font-size: 10px; color: var(--text-muted); margin-bottom: 4px;", t.anchorMissing ? "The line to insert after was not found — it will be added at the end of the block." : "Added at the end of the block.");
  }
  if (p.replace) {
    if (p.action === "update" && t.kind !== "none" && typeof VLA.diffWords === "function") {
      const d = document.createElement("div");
      d.style.cssText = "font-size: 12px; color: var(--text-main); margin-bottom: 4px; word-break: break-word;";
      for (const w of VLA.diffWords(t.line.replace(/^-\s*/, ""), p.replace.replace(/^-\s*/, ""))) {
        if (w.t === "del") continue;
        const sp = document.createElement("span");
        sp.textContent = w.w + " ";
        if (w.t === "ins") sp.style.cssText = "background: rgba(34,197,94,.25); border-radius: 2px;";
        d.appendChild(sp);
      }
      const lead = document.createElement("span"); lead.textContent = "- "; d.insertBefore(lead, d.firstChild);
      card.appendChild(d);
    } else {
      mk("font-size: 12px; color: var(--text-main); margin-bottom: 4px;", p.replace);
    }
  }
  if (p.summary) mk("font-size: 11px; color: var(--text-muted); margin-bottom: 6px;", p.summary);

  const rel = relatedRules(p, t.line);
  if (rel.length) {
    const dup = p.action === "add" && rel[0].s >= 0.8;
    mk("font-size: 10px; color: " + (dup ? "var(--alert-warning-border)" : "var(--text-muted)") + "; font-weight: 600; margin: 2px 0;", dup ? "⚠️ Very similar rule already exists:" : "Related existing rules (check for conflicts):");
    for (const r of rel) mk("font-size: 10px; color: var(--text-muted); margin-bottom: 2px;", "• [" + ruleBlockLabel(r.k) + "] " + (r.line.length > 160 ? r.line.slice(0, 157) + "..." : r.line));
  }

  const row = document.createElement("div");
  row.className = "btn-row";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "apply-btn";
  yes.textContent = "✅ Apply rule";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "action-btn";
  no.textContent = "✕ Discard";
  if (blocked) yes.disabled = true;
  yes.onclick = async () => {
    yes.disabled = true; no.disabled = true;
    try {
      const r = await applyRuleProposal(p);
      if (r.ok) {
        appendChatMessage("model", "✅ Done — the rule is now part of the " + ruleBlockLabel(p.block) + " block." + (r.note ? " " + r.note + "." : "") + " It applies to every AI feature (audit, chat, rephrase, 📷) immediately.");
        addRuleUndoRow(p.block, r.before, r.after);
        card.remove();
      } else {
        appendChatMessage("error", "⚠️ " + r.msg);
        yes.disabled = false; no.disabled = false;
      }
    } catch (e) {
      appendChatMessage("error", "⚠️ Couldn't apply the rule: " + (e && e.message ? e.message : e));
      yes.disabled = false; no.disabled = false;
    }
  };
  no.onclick = () => { card.remove(); appendChatMessage("model", "Discarded — the rules are unchanged."); };
  card.applyNow = async () => { if (!yes.disabled) await yes.onclick(); };
  row.appendChild(yes); row.appendChild(no);
  card.appendChild(row);
  return card;
}

/* ====================================================================
 * AI panel editor: the chat can propose changes to the reviewer panel
 * (Description, Causal Action, Maneuver, Speed change, Contexts). The model
 * only PROPOSES (a <<<PANEL_PROPOSAL>>> JSON block in its reply); the fields
 * are written only after the user presses "Apply to panel" on the card.
 * On Apply, the fields go to the reviewer panel AND to the annotation page:
 * text through the undoable applyToPage, dropdowns/contexts via APPLY_METRICS.
 * ==================================================================== */
const PANEL_PROPOSAL_RE = /<+\s*PANEL[\s_-]*PROPOSAL\s*>+\s*([\s\S]*?)\s*<+\s*END[\s_-]*PANEL[\s_-]*PROPOSAL\s*>+/i;
const PANEL_LOOSE_RE = /<+\s*PANEL[\s_-]*PROPOSAL[\s\S]*/i; // malformed block: strip from the marker to the end
// Global variants: a reply may carry SEVERAL proposal blocks (one per rule change).
const RULE_PROPOSAL_RE_G = /<+\s*RULE[\s_-]*PROPOSAL\s*>+\s*([\s\S]*?)\s*<+\s*END[\s_-]*RULE[\s_-]*PROPOSAL\s*>+/gi;
const PANEL_PROPOSAL_RE_G = /<+\s*PANEL[\s_-]*PROPOSAL\s*>+\s*([\s\S]*?)\s*<+\s*END[\s_-]*PANEL[\s_-]*PROPOSAL\s*>+/gi;
const PANEL_FIELD_LABELS = { description: "Description", causal: "Causal Action", maneuver: "Maneuver", speed: "Speed change", contexts: "Context" };

// Parses ONE panel proposal (the raw JSON between the markers); null when unusable.
function parsePanelProposalBody(body) {
  const p = parseProposalJson(body);
  if (!p || !Array.isArray(p.changes)) return null;
  const knownCtx = new Set(["Auto", ...VLA.CONTEXTS.map((x) => x.value)]);
  const out = [];
  for (let c of p.changes) {
    if (!c || typeof c !== "object") continue;
    if (!c.field) {
      // Shorthand entries like {"maneuver":"X"} or {"contexts":{"add":[...],"remove":[...]}}
      const keys = ["description", "causal", "maneuver", "speed", "contexts"].filter((k) => c[k] !== undefined && c[k] !== null);
      if (keys.length !== 1) continue;
      c = { field: keys[0], value: c[keys[0]] };
    }
    if (c.field === "description" || c.field === "causal") {
      const v = String(c.value || "").trim();
      if (v) out.push({ field: c.field, value: v });
    } else if (c.field === "maneuver" || c.field === "speed") {
      const v = String(c.value || "").trim();
      const opts = c.field === "maneuver" ? VLA.MANEUVERS : VLA.SPEEDS;
      if (opts.includes(v)) out.push({ field: c.field, value: v });
    } else {
      const src = (c.value && typeof c.value === "object" && !Array.isArray(c.value)) ? c.value : c;
      const add = Array.isArray(src.add) ? src.add.filter((v) => knownCtx.has(v)) : (typeof src.value === "string" ? [src.value] : []);
      const remove = Array.isArray(src.remove) ? src.remove.filter((v) => knownCtx.has(v)) : [];
      if (add.length || remove.length) out.push({ field: "contexts", add, remove });
    }
  }
  return out.length ? { changes: out } : null;
}

function parsePanelProposal(text) {
  const m = String(text || "").match(PANEL_PROPOSAL_RE);
  return m ? parsePanelProposalBody(m[1]) : null;
}

async function applyPanelProposal(p) {
  const applied = [];
  const errors = [];
  const readOnly = !!state.isReadOnly;
  let metrics = null; // { maneuver, speedChange, contexts } → one APPLY_METRICS call for the page
  for (const c of p.changes) {
    if (c.field === "description" || c.field === "causal") {
      $(c.field === "description" ? "box1-input" : "box2-input").value = c.value;
      applied.push(PANEL_FIELD_LABELS[c.field]);
      if (!readOnly) {
        try {
          const { response } = await applyToPage(c.field === "description" ? "box1" : "box2", c.value);
          if (!response || response.status !== "SUCCESS") {
            errors.push(PANEL_FIELD_LABELS[c.field] + " was not written to the page" + (response && response.status === "CHANGED" ? " (it was edited on the page since the last check)" : ""));
          }
        } catch (e) { errors.push(PANEL_FIELD_LABELS[c.field] + " (page): " + (e && e.message ? e.message : e)); }
      }
    } else if (c.field === "maneuver" || c.field === "speed") {
      const el = $(c.field === "maneuver" ? "user-maneuver" : "user-speed");
      if ([...el.options].some((o) => o.value === c.value)) {
        el.value = c.value;
        applied.push(PANEL_FIELD_LABELS[c.field] + ": " + c.value);
        metrics = metrics || {};
        if (c.field === "maneuver") metrics.maneuver = c.value; else metrics.speedChange = c.value;
      }
    } else if ((c.add || []).includes("Auto")) {
      setSelectedContexts(["Auto"]); // "Auto" added = clear all contexts
      applied.push("Context: Auto (cleared)");
      metrics = metrics || {};
      metrics.contexts = []; // the page removes every selected context pill
    } else {
      const set = new Set(getSelectedContexts().filter((v) => v !== "Auto"));
      (c.remove || []).forEach((v) => set.delete(v));
      (c.add || []).forEach((v) => set.add(v));
      setSelectedContexts(set.size ? [...set] : ["Auto"]);
      applied.push("Context: " + (set.size ? [...set].join(", ") : "Auto (cleared)"));
      metrics = metrics || {};
      metrics.contexts = [...set];
    }
  }
  if (readOnly && applied.length) {
    errors.push("Clip is read only — nothing was written to the page");
  } else if (metrics) {
    try {
      const { response } = await callPage({
        action: "APPLY_METRICS",
        maneuver: metrics.maneuver || null,
        speedChange: metrics.speedChange || null,
        contexts: metrics.contexts !== undefined ? metrics.contexts : null
      }, { sameTab: true });
      const r = (response && response.results) || {};
      if (r.maneuver === "NOT_FOUND") errors.push("Maneuver not found on the page");
      if (r.speedChange === "NOT_FOUND") errors.push("Speed change not found on the page");
      const ctxVals = [...Object.values(r.contexts || {}), ...Object.values(r.removed || {})];
      if (ctxVals.includes("NOT_FOUND")) errors.push("Some context pills were not found on the page");
    } catch (e) { errors.push("Page dropdowns/contexts: " + (e && e.message ? e.message : e)); }
  }
  if (applied.length) { refreshInputLint(); persistSoon(); }
  return { applied, errors };
}

function buildPanelProposalCard(p) {
  const card = document.createElement("div");
  card.style.cssText = "background: var(--bg-suggestion); border: 1px solid var(--border-input); padding: 8px; border-radius: 6px; margin: 8px 0;";
  const label = document.createElement("div");
  label.style.cssText = "font-size: 11px; color: var(--text-muted); font-weight: 600; margin-bottom: 4px; text-transform: uppercase;";
  label.textContent = "Proposed panel changes — waiting for your confirmation";
  card.appendChild(label);
  const list = document.createElement("div");
  list.style.cssText = "font-size: 12px; color: var(--text-main); margin-bottom: 6px;";
  for (const c of p.changes) {
    const row = document.createElement("div");
    row.style.cssText = "margin-bottom: 4px; word-break: break-word;";
    if (c.field === "description" || c.field === "causal") {
      const cur = $(c.field === "description" ? "box1-input" : "box2-input").value.trim();
      if (cur) {
        const oldEl = document.createElement("div");
        oldEl.style.cssText = "font-size: 11px; color: var(--text-muted); text-decoration: line-through;";
        oldEl.textContent = cur;
        row.appendChild(oldEl);
      }
      row.appendChild(document.createTextNode(PANEL_FIELD_LABELS[c.field] + ": " + c.value));
    } else if (c.field === "maneuver" || c.field === "speed") {
      const cur = $(c.field === "maneuver" ? "user-maneuver" : "user-speed").value || "Auto";
      row.textContent = PANEL_FIELD_LABELS[c.field] + ": " + cur + " → " + c.value;
    } else {
      const parts = [];
      (c.remove || []).forEach((v) => parts.push("− " + v));
      (c.add || []).filter((v) => v !== "Auto").forEach((v) => parts.push("+ " + v));
      if ((c.add || []).includes("Auto") || (!(c.add || []).length && (c.remove || []).length && getSelectedContexts().filter((v) => v !== "Auto").length <= (c.remove || []).length)) parts.push("→ Auto (cleared)");
      row.textContent = "Context: " + parts.join(", ");
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  const row = document.createElement("div");
  row.className = "btn-row";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "apply-btn";
  yes.textContent = "✅ Apply to panel";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "action-btn";
  no.textContent = "✕ Discard";
  yes.onclick = async () => {
    yes.disabled = true; no.disabled = true;
    try {
      const r = await applyPanelProposal(p);
      if (r.applied.length) {
        let msg = "✅ Applied to the reviewer panel and the annotation page: " + r.applied.join("; ") + ".";
        if (r.errors.length) msg += " ⚠️ Page notes: " + r.errors.join("; ") + ".";
        appendChatMessage("model", msg);
        card.remove();
      } else {
        appendChatMessage("error", "⚠️ Nothing could be applied — the panel fields may have changed. Edit them by hand if needed.");
        yes.disabled = false; no.disabled = false;
      }
    } catch (e) {
      appendChatMessage("error", "⚠️ Couldn't apply the panel changes: " + (e && e.message ? e.message : e));
      yes.disabled = false; no.disabled = false;
    }
  };
  no.onclick = () => { card.remove(); appendChatMessage("model", "Discarded — the panel is unchanged."); };
  row.appendChild(yes); row.appendChild(no);
  card.appendChild(row);
  return card;
}

// A proposal block was present but too malformed to parse: never show the raw symbols.
function malformedProposalCard(kind, raw) {
  const card = document.createElement("div");
  card.style.cssText = "background: var(--bg-suggestion); border: 1px solid var(--alert-warning-border); padding: 8px; border-radius: 6px; margin: 8px 0; font-size: 12px; color: var(--text-main);";
  card.textContent = "⚠️ The AI proposed a " + (kind === "rule" ? "rule" : "panel") + " change but the proposal was malformed, so nothing was applied. Ask it to try again.";
  if (raw && raw.trim()) {
    const details = document.createElement("details");
    details.style.cssText = "margin-top: 6px;";
    const sum = document.createElement("summary");
    sum.style.cssText = "font-size: 11px; color: var(--text-muted); cursor: pointer;";
    sum.textContent = "Show what it wrote";
    const pre = document.createElement("pre");
    pre.style.cssText = "font-size: 11px; white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; color: var(--text-muted); user-select: text;";
    pre.textContent = raw.trim().slice(0, 2000);
    details.appendChild(sum); details.appendChild(pre);
    card.appendChild(details);
  }
  return card;
}

/* Bouncing-balls loading bubble — replaces the old step-by-step messages */
let chatLoadingEl = null;
function showChatLoading() {
  hideChatLoading();
  const container = $("chat-history");
  const div = document.createElement("div");
  div.className = "chat-message model";
  const balls = document.createElement("div");
  balls.className = "ai-loading";
  for (let i = 0; i < 3; i++) balls.appendChild(document.createElement("span"));
  div.appendChild(balls);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  chatLoadingEl = div;
}
function hideChatLoading() {
  if (chatLoadingEl && chatLoadingEl.remove) chatLoadingEl.remove();
  chatLoadingEl = null;
}

function appendChatMessage(role, text, imageInlineData = null, opts = {}) {
  const container = $("chat-history");
  const div = document.createElement("div");
  div.className = `chat-message ${role}`;

  // A model reply may carry one or more rule-proposal and/or panel-proposal blocks: parse them
  // ALL and strip them from the visible text up front, so no rendering branch below can ever
  // show the raw markers. Each proposal renders as its own confirmation card; a block that
  // cannot be parsed renders as a malformed-proposal card of its own.
  let ruleProposals = [];
  let panelProposals = [];
  if (role === "model") {
    for (const m of text.matchAll(RULE_PROPOSAL_RE_G)) {
      const p = parseRuleProposalBody(m[1]);
      ruleProposals.push(p || { malformed: true, raw: m[0] });
    }
    if (ruleProposals.length) text = text.replace(RULE_PROPOSAL_RE_G, "").trim();
    else if (RULE_LOOSE_RE.test(text)) { const raw = text.match(RULE_LOOSE_RE)[0]; text = text.replace(RULE_LOOSE_RE, "").trim(); ruleProposals.push({ malformed: true, raw }); }

    for (const m of text.matchAll(PANEL_PROPOSAL_RE_G)) {
      const p = parsePanelProposalBody(m[1]);
      panelProposals.push(p || { malformed: true, raw: m[0] });
    }
    if (panelProposals.length) text = text.replace(PANEL_PROPOSAL_RE_G, "").trim();
    else if (PANEL_LOOSE_RE.test(text)) { const raw = text.match(PANEL_LOOSE_RE)[0]; text = text.replace(PANEL_LOOSE_RE, "").trim(); panelProposals.push({ malformed: true, raw }); }
  }

  if (imageInlineData) {
    const imgSrc = `data:${imageInlineData.mimeType};base64,${imageInlineData.data}`;
    const img = document.createElement("img");
    img.src = imgSrc;
    img.alt = "Uploaded scene";
    img.style.cssText = "max-width: 100%; max-height: 150px; border-radius: 4px; margin-bottom: 6px; display: block;";
    div.appendChild(img);
  }

  // Detect auto-generated Description block to render an editable widget with actions
  if (role === "model" && /(?:^|\n)Description:/i.test(text)) {
    const descRegex = /(?:^|\n)Description:\s*([\s\S]*?)(?=\n\n|$)/i;
    
    const descMatch = text.match(descRegex);
    if (descMatch) {
        const descText = descMatch[1].trim();
        
        let beforeText = text.substring(0, descMatch.index).trim();
        let afterText = text.substring(descMatch.index + descMatch[0].length).trim();

        if (beforeText) {
            const p = document.createElement("div");
            p.style.marginBottom = "8px";
            p.innerHTML = formatChatText(beforeText);
            div.appendChild(p);
        }
        
        // Editable Description Widget
        const widget = document.createElement("div");
        widget.style.cssText = "background: var(--bg-suggestion); border: 1px solid var(--border-input); padding: 8px; border-radius: 6px; margin: 8px 0;";
        
        const label = document.createElement("div");
        label.style.cssText = "font-size: 11px; color: var(--text-muted); font-weight: 600; margin-bottom: 4px; text-transform: uppercase;";
        label.textContent = "Generated Description";
        widget.appendChild(label);
        
        const ta = document.createElement("textarea");
        ta.className = "suggestion-edit";
        ta.style.minHeight = "60px";
        ta.style.overflow = "hidden"; // Hide scrollbar to prevent jumping during auto-resize
        ta.value = descText;

        // Auto-resize handler
        const autoResize = () => {
            ta.style.height = "auto";
            ta.style.height = ta.scrollHeight + "px";
        };
        ta.addEventListener("input", autoResize);

        widget.appendChild(ta);
        
        const btnRow = document.createElement("div");
        btnRow.className = "btn-row";
        btnRow.style.marginTop = "6px";
        
        const btnPanel = document.createElement("button");
        btnPanel.className = "action-btn";
        btnPanel.textContent = "Copy to Panel";
        btnPanel.onclick = () => {
            $("box1-input").value = ta.value;
            if (typeof refreshInputLint === "function") refreshInputLint();
            if (typeof persistSoon === "function") persistSoon();
            flash(btnPanel, "Copied ✓", COLOR.ok, "Copy to Panel");
        };
        
        const btnPage = document.createElement("button");
        btnPage.className = "apply-btn";
        btnPage.textContent = "Copy to Page";
        btnPage.onclick = async () => {
            if (state.isReadOnly) {
                flash(btnPage, "Clip is read only", COLOR.err, "Copy to Page", 3000);
                return;
            }
            btnPage.disabled = true;
            try {
                const { response } = await applyToPage("box1", ta.value);
                if (response && response.status === "SUCCESS") {
                    flash(btnPage, "Applied ✓", COLOR.ok, "Copy to Page");
                } else {
                    flash(btnPage, "Field not found", COLOR.err, "Copy to Page", 3000);
                }
            } catch (e) {
                flash(btnPage, "Error", COLOR.err, "Copy to Page", 3000);
            }
            btnPage.disabled = false;
        };
        
        const btnUndo = document.createElement("button");
        btnUndo.className = "action-btn page-undo-btn";
        btnUndo.textContent = "↶ Undo";
        btnUndo.setAttribute("aria-label", "Undo apply to page");
        btnUndo.disabled = true;
        btnUndo.onclick = () => stepPageHistory("undo", btnUndo);

        const btnRedo = document.createElement("button");
        btnRedo.className = "action-btn page-redo-btn";
        btnRedo.textContent = "↷ Redo";
        btnRedo.setAttribute("aria-label", "Redo apply to page");
        btnRedo.disabled = true;
        btnRedo.onclick = () => stepPageHistory("redo", btnRedo);

        btnRow.appendChild(btnPanel);
        btnRow.appendChild(btnPage);
        btnRow.appendChild(makeBookmarkBtn("description", () => ta.value, "chat", { labeled: true }));

        // Same button style/size as Copy to Panel / Copy to Page, on their own row
        const historyRow = document.createElement("div");
        historyRow.className = "btn-row";
        historyRow.style.marginTop = "2px";
        historyRow.appendChild(btnUndo);
        historyRow.appendChild(btnRedo);
        widget.appendChild(btnRow);
        widget.appendChild(historyRow);
        updateHistoryButtons();
        
        div.appendChild(widget);
        
        if (afterText) {
            const p = document.createElement("div");
            p.style.marginTop = "8px";
            p.innerHTML = formatChatText(afterText);
            div.appendChild(p);
        }
        
        container.appendChild(div);
        
        // Trigger resize right after the element has been painted to the DOM
        setTimeout(() => {
            autoResize();
            container.scrollTop = container.scrollHeight;
        }, 10);
        return;
    }
  }

  // Standard Output Block — proposals (rules / panel) render as confirmation cards
  if (role === "model") {
    const p = document.createElement("div");
    p.innerHTML = formatChatText(text);
    div.appendChild(p);
    if (ruleProposals.length) {
      const cards = [];
      for (const rp of ruleProposals) {
        const c = rp.malformed ? malformedProposalCard("rule", rp.raw) : buildRuleProposalCard(rp);
        if (!rp.malformed) cards.push(c);
        div.appendChild(c);
      }
      if (cards.length > 1) {
        const all = document.createElement("button");
        all.type = "button";
        all.className = "apply-btn";
        all.textContent = "✅ Apply all " + cards.length + " rules";
        all.onclick = async () => { all.disabled = true; for (const c of cards) if (c.isConnected && c.applyNow) await c.applyNow(); all.remove(); };
        div.appendChild(all);
      }
    }
    if (panelProposals.length) for (const pp of panelProposals) div.appendChild(pp.malformed ? malformedProposalCard("panel", pp.raw) : buildPanelProposalCard(pp));
  } else {
    const p = document.createElement("div");
    p.innerHTML = escapeHTML(text);
    div.appendChild(p);
  }

  // Failed request → one-click retry that re-runs the very same request (images included)
  if (role === "error" && typeof opts.retry === "function") {
    const row = document.createElement("div");
    row.style.marginTop = "6px";
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "action-btn";
    retryBtn.textContent = "🔄 Retry";
    retryBtn.onclick = () => opts.retry(div);
    row.appendChild(retryBtn);
    div.appendChild(row);
  }

  if (role === "model") {
    const actions = document.createElement("div");
    actions.className = "chat-actions";
    actions.appendChild(makeBookmarkBtn("chat", () => text, "chat", { labeled: true, className: "bm-chat-btn" }));
    div.appendChild(actions);
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showChatSuggestions(suggestions) {
  const container = $("chat-suggestions");
  if (!container) return;

  container.innerHTML = "";

  if (!suggestions || suggestions.length === 0) {
    container.hidden = true;
    return;
  }

  suggestions.forEach(text => {
    const btn = document.createElement("button");
    btn.className = "chat-suggestion-bubble";
    btn.textContent = text;
    btn.onclick = () => {
      $("chat-input").value = text;
      container.hidden = true;
      sendChatMessage();
    };
    container.appendChild(btn);
  });

  container.hidden = false;
}

/* ====================================================================
 * Auto-screenshot of the camera views (replaces manual photo upload)
 * ==================================================================== */
const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("Could not read the screenshot."));
  img.src = src;
});

let seekAndReadRef = null;   // set in init(): seeks the page player to a frame (and verifies it)
let aiSpeedCheckRef = null;  // set in init(): full AI speed check (start at action point, end 50 frames later or at the clip's last frame when shorter)
let readPageStateRef = null; // set in init(): passive (non-seeking) read of the page's action point / frame counter — used by the audit's action-point check
let runOnActiveTabRef = null; // set in init(): run a function in the active tab (handles the access-permission dance) — used by the Action Point section
let telemetryRef = null;     // set in init(): whole-clip telemetry from the clip API (no seeking) —
                             // { ensure, extrasAt, stats, frameTime, speedAt, series, historyStats, historyFrame }
let pendingScene = null;     // { shots: [{ label, inlineData }], preview: inlineData }
let lastSceneRead = null;    // { observations, description } — what the image tool last described, so the chat AI understands it

const CAMERA_ORDER = ["front", "left", "right", "rear left", "rear right"];
const CAMERA_LABEL = {
  "front": "FRONT camera (ahead of ego)",
  "left": "LEFT camera (beside ego, left side)",
  "right": "RIGHT camera (beside ego, right side)",
  "rear left": "REAR LEFT camera (behind ego, left side)",
  "rear right": "REAR RIGHT camera (behind ego, right side)"
};
// Earlier moments only need the FRONT camera (how the lead traffic changes); the decision moment gets all five.
// Frames run at 10 per second, so 10 frames = 1 second.
const SCENE_MOMENTS = [
  { off: -20, text: "about 2 seconds before the decision", cams: ["front"] },
  { off: -10, text: "about 1 second before the decision", cams: ["front"] },
  { off: 0, text: "the decision moment", cams: CAMERA_ORDER }
];

async function screenshotTab(tab) {
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (capErr) {
    // captureVisibleTab only works with activeTab (granted by clicking the toolbar icon on that tab)
    // or <all_urls>. If neither applies, ask once for <all_urls> and retry.
    if (!/permission/i.test(capErr.message)) throw capErr;
    const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
    if (!granted) throw new Error("Screenshot permission was declined.");
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  }
}

// Draws (a region of) an image to a canvas, scaled down so its longest side is at most maxSide
function toCanvas(img, sx, sy, sw, sh, maxSide) {
  const down = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * down));
  canvas.height = Math.max(1, Math.round(sh * down));
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Cuts off letterbox bars: only columns/rows that are completely black are removed (a dark scene still
// has some lit pixel in every column), and never more than a third from each side.
function trimBlackBars(canvas, thr = 8) {
  const w = canvas.width, h = canvas.height;
  if (w < 60 || h < 60) return canvas;
  let data;
  try { data = canvas.getContext("2d").getImageData(0, 0, w, h).data; } catch (_) { return canvas; }
  const lum = (x, y) => { const i = (y * w + x) * 4; return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; };
  const colBlack = (x) => { for (let y = 0; y < h; y += 3) if (lum(x, y) > thr) return false; return true; };
  const rowBlack = (y) => { for (let x = 0; x < w; x += 3) if (lum(x, y) > thr) return false; return true; };
  let l = 0; while (l < w / 3 && colBlack(l)) l++;
  let r = w - 1; while (r > w - w / 3 && colBlack(r)) r--;
  let t = 0; while (t < h / 3 && rowBlack(t)) t++;
  let b = h - 1; while (b > h - h / 3 && rowBlack(b)) b--;
  const nw = r - l + 1, nh = b - t + 1;
  if (nw < w * 0.5 || nh < h * 0.5 || (l === 0 && t === 0 && r === w - 1 && b === h - 1)) return canvas;
  const out = document.createElement("canvas");
  out.width = nw; out.height = nh;
  out.getContext("2d").drawImage(canvas, l, t, nw, nh, 0, 0, nw, nh);
  return out;
}

const canvasToInline = (canvas, q = 0.9) => ({ mimeType: "image/jpeg", data: canvas.toDataURL("image/jpeg", q).split(",")[1] });

// Reads the cameras at the CURRENT playhead position. Original-resolution pixels when the page allows it,
// otherwise a per-camera crop of a screenshot. Returns { shots } or { empty: true } (cameras show
// "no frame was captured") or { noTiles: true } (camera structure not recognised).
async function grabCameras(wantedCams, momentText) {
  await sleep(450); // let the new frame's images finish loading
  const { tab, response } = await callPage({ action: "GET_CAMERA_TILES" });
  if (!response.found || !(response.tiles || []).length) return { noTiles: true };
  const usable = response.tiles.filter((t) => !t.noFrame && wantedCams.includes(t.name));
  if (!usable.length) return { empty: true };

  let shot = null;
  const getShot = async () => {
    if (!shot) {
      const img = await loadImage(await screenshotTab(tab));
      shot = { img, scale: img.width / response.viewportWidth };
    }
    return shot;
  };

  const shots = [];
  for (const name of wantedCams) {
    const t = usable.find((x) => x.name === name);
    if (!t) continue;
    let canvas;
    if (t.dataUrl) {
      const img = await loadImage(t.dataUrl);
      canvas = toCanvas(img, 0, 0, img.width, img.height, 1600);
    } else {
      const s = await getShot();
      const sx = Math.max(0, Math.round(t.x * s.scale)), sy = Math.max(0, Math.round(t.y * s.scale));
      const sw = Math.min(s.img.width - sx, Math.round(t.width * s.scale));
      const sh = Math.min(s.img.height - sy, Math.round(t.height * s.scale));
      if (sw < 8 || sh < 8) continue;
      canvas = toCanvas(s.img, sx, sy, sw, sh, 1600);
    }
    shots.push({ label: `${momentText} — ${CAMERA_LABEL[name]}`, inlineData: canvasToInline(trimBlackBars(canvas)) });
  }
  return shots.length ? { shots } : { empty: true };
}

// Last resort when the individual cameras can't be located: the old whole-grid screenshot
async function grabGridFallback() {
  const { tab, response } = await callPage({ action: "GET_CAMERA_RECT" });
  if (!response.found) throw new Error("Camera views not found on this page.");
  const img = await loadImage(await screenshotTab(tab));
  const scale = img.width / response.viewportWidth;
  const sx = Math.round(response.x * scale), sy = Math.round(response.y * scale);
  const sw = Math.min(img.width - sx, Math.round(response.width * scale));
  const sh = Math.min(img.height - sy, Math.round(response.height * scale));
  const canvas = toCanvas(img, sx, sy, sw, sh, 2000);
  return [{
    label: "the current moment (treat it as the decision moment) — all camera views in ONE grid image: FRONT top-centre, LEFT top-left, RIGHT top-right, REAR LEFT bottom-left, REAR RIGHT bottom-right; the bottom-centre tile is a UI counter, ignore it",
    inlineData: canvasToInline(canvas, 0.92)
  }];
}

async function captureCameraViews() {
  const btn = $("chat-upload-btn");
  if (btn.disabled) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳";

  let startFrame = null, moved = false;
  try {
    const shots = [];
    let seekable = !!seekAndReadRef;

    // Where is the playhead now? (restored afterwards) and can we find the decision point to seek from?
    if (seekable) {
      try {
        const cur = await seekAndReadRef("start", null, true);
        if (cur?.status === "OK") startFrame = cur.frame; else seekable = false;
      } catch (_) { seekable = false; }
    }

    if (seekable) {
      for (let i = 0; i < SCENE_MOMENTS.length; i++) {
        const m = SCENE_MOMENTS[i];
        btn.textContent = `⏳${i + 1}/${SCENE_MOMENTS.length}`;
        let res;
        try { res = await seekAndReadRef("offset", m.off, true); } catch (_) { res = null; }
        if (res?.status !== "OK") { if (i === 0) seekable = false; break; }
        moved = true;
        const g = await grabCameras(m.cams, m.text);
        if (g.noTiles) break;
        if (g.shots) shots.push(...g.shots);
      }
    }

    // Decision point not found / cameras not recognised / no frames there → what is on screen right now
    if (!shots.length) {
      if (moved && startFrame !== null) { await seekAndReadRef("abs", startFrame, true).catch(() => {}); moved = false; }
      const g = await grabCameras(CAMERA_ORDER, "the current moment (treat it as the decision moment)");
      if (g.shots) shots.push(...g.shots);
      else if (g.noTiles) shots.push(...(await grabGridFallback()));
      else throw new Error("The cameras show no frame at the decision point. Move the playhead into the history window and try again.");
    }

    const preview = (shots.find((s) => /decision moment — FRONT/.test(s.label)) || shots[shots.length - 1]).inlineData;
    pendingChatImage = null;
    pendingScene = { shots, preview };
    $("chat-image-preview").src = `data:${preview.mimeType};base64,${preview.data}`;
    $("chat-image-name").textContent = `Scene capture · ${shots.length} image${shots.length === 1 ? "" : "s"}`;
    $("chat-image-preview-container").style.display = "flex";
  } catch (e) {
    let msg = e.message;
    if (e.code === "NO_ACCESS") msg = "VLA Reviewer needs access to this site. Close chat and click \"Allow on this site\".";
    else if (e.code === "UNSUPPORTED") msg = "Open the annotation page in the active tab first.";
    appendChatMessage("error", `Screenshot failed: ${msg}`);
  } finally {
    // Put the playhead back where the user left it
    if (moved && startFrame !== null && seekAndReadRef) { try { await seekAndReadRef("abs", startFrame, true); } catch (_) {} }
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ====================================================================
 * Scene review in two stages
 *  1) OBSERVE: the (stronger) image model reads the labelled camera images into a structured form,
 *     including how confident it is and what it could not see.
 *  2) WRITE: a text-only call writes the Description from those observations alone, so nothing is
 *     added from imagination. The local linter then checks it, and anything uncertain is listed as
 *     "please verify" instead of being stated as fact.
 * ==================================================================== */
const SCENE_SCHEMA = {
  type: "OBJECT",
  properties: {
    roadType: { type: "STRING" },
    lanesInEgoDirection: { type: "INTEGER" },
    laneCountConfidence: { type: "STRING", enum: ["high", "medium", "low"] },
    egoLane: { type: "STRING" },
    turnLanes: { type: "STRING" },
    leftOfEgo: { type: "STRING" },
    rightOfEgo: { type: "STRING" },
    trafficControl: { type: "STRING" },
    actors: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING" },
          lane: { type: "STRING" },
          position: { type: "STRING" },
          note: { type: "STRING" },
          confidence: { type: "STRING", enum: ["high", "medium", "low"] }
        },
        required: ["kind", "lane", "position", "note", "confidence"]
      }
    },
    changesOverTime: { type: "STRING" },
    roadFeatures: { type: "STRING" },
    uncertain: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["roadType", "lanesInEgoDirection", "laneCountConfidence", "egoLane", "turnLanes", "leftOfEgo", "rightOfEgo", "trafficControl", "actors", "changesOverTime", "roadFeatures", "uncertain"]
};
const SCENE_WRITE_SCHEMA = {
  type: "OBJECT",
  properties: { description: { type: "STRING" }, verify: { type: "ARRAY", items: { type: "STRING" } } },
  required: ["description", "verify"]
};

// Speed and motion of the surroundings are left to the human annotator, so the image features must not write
// them. Local check (the audit of human text still allows these words, so it lives here, not in shared.js).
const MOTION_RX = /\b(?:faster|slower|slowing|slows?|slowly|quickly|rapidly|accelerat\w*|decelerat\w*|speeding|speeds?|braking|brakes?|braked|approach\w*|closing|overtak\w*|passing|passes|moving|moves?|stopped|stopping|stationary|driving(?!\s+lane)|drives?|travell?ing|cruising|crawling|backing)\b/i;
const motionIssues = (text) => {
  const m = (text || "").match(MOTION_RX);
  return m ? [{ level: "error", msg: `Speed/motion word "${m[0]}" — describe only what is there and where; leave speed and motion to the human`, match: m[0] }] : [];
};
const sceneLint = (text) => [...VLA.lint("box1", text), ...motionIssues(text)];

async function describeScene(shots) {
  const images = shots.map((s) => ({ mimeType: s.inlineData.mimeType, data: s.inlineData.data }));
  const labels = shots.map((s) => s.label);

  // Stage 1: observe
  const observations = await callGemini({
    system: Prompts.getSceneObserveSystemInstruction(),
    text: Prompts.getSceneObserveUserPrompt({ labels }),
    schema: SCENE_SCHEMA,
    images, labels,
    model: state.visionModel,
    maxTokens: 4096,
    timeoutMs: 90000
  });

  // Stage 2: write from the observations only. The annotator's current causal action and
  // selections are passed as a hint: they steer what gets priority (never invented facts).
  const annCausal = ($("box2-input")?.value || "").trim();
  const annSelections = {
    maneuver: $("user-maneuver")?.value || "Auto",
    speedChange: $("user-speed")?.value || "Auto",
    contexts: getSelectedContexts().filter((c) => c !== "Auto")
  };
  const write = (fixes = "") => callGemini({
    system: Prompts.getSceneWriteSystemInstruction(),
    text: Prompts.getSceneWriteUserPrompt({
      observations, fixes,
      causalAction: annCausal,
      selections: annSelections
    }),
    schema: SCENE_WRITE_SCHEMA,
    model: state.chatModel,
    maxTokens: 1200
  });

  const errorsOf = (issues) => issues.filter((i) => i.level === "error");
  const first = await write();
  let description = String(first.description || "").trim();
  let verify = Array.isArray(first.verify) ? first.verify : [];
  let issues = sceneLint(description);

  if (description && issues.length) { // one corrective pass with the reviewer's own checker findings
    try {
      const retry = await write(issues.map((i) => i.msg).join("; "));
      const d2 = String(retry.description || "").trim();
      if (d2) {
        const issues2 = sceneLint(d2);
        if (errorsOf(issues2).length <= errorsOf(issues).length) {
          description = d2; issues = issues2;
          if (Array.isArray(retry.verify)) verify = retry.verify;
        }
      }
    } catch (_) { /* keep the first version and flag it below */ }
  }
  if (!description) throw new Error("The model returned no description. Try again.");
  lastSceneRead = { observations, description }; // kept for the chat: follow-up questions can use what was described

  const uncertain = Array.isArray(observations.uncertain) ? observations.uncertain : [];
  const toVerify = [...new Set([...verify, ...uncertain].map((s) => String(s).trim()).filter(Boolean))].slice(0, 6);

  let out = `Description: ${description}`;
  if (toVerify.length) out += `\n\n🔍 Please verify against the video: ${toVerify.join("; ")}`;
  const errs = errorsOf(issues);
  if (errs.length) out += `\n\n⚠️ Still breaks: ${errs.map((e) => e.msg).join("; ")}`;
  return out;
}

const VISION_REPLY_RX = /^\s*Description:\s*([\s\S]*?)(?:\n\s*Note:[\s\S]*)?$/i;

// The describer must write in the same standard syntax the reviewer enforces. It sometimes breaks rules its own
// prompt states (e.g. "multi-lane", "car", no lane count), so lint its Description with the SAME local checker the
// reviewer uses (errors and hints). If it fails, ask once for a corrected version, and flag any error left.
async function lintVisionReply(responseText) {
  const m = responseText.match(VISION_REPLY_RX);
  if (!m) return responseText;
  const issuesOf = (t) => sceneLint(t);
  const errorsOf = (issues) => issues.filter((i) => i.level === "error");

  let current = responseText;
  let issues = issuesOf(m[1].trim());
  if (!issues.length) return current;

  try {
    const fixHistory = [
      ...chatHistory,
      { role: "model", parts: [{ text: current }] },
      { role: "user", hasImage: true, parts: [{ text: `Rewrite the Description in the standard VLA description syntax so it fixes these reviewer findings: ${issues.map((e) => e.msg).join("; ")}. Keep the same format and only facts that are in the image.` }] }
    ];
    const retry = await callChatGemini(fixHistory);
    const m2 = retry.match(VISION_REPLY_RX);
    if (m2) {
      const retryIssues = issuesOf(m2[1].trim());
      // keep the retry unless it is worse than the first attempt
      if (errorsOf(retryIssues).length <= errorsOf(issues).length) { current = retry; issues = retryIssues; }
    }
  } catch (_) { /* keep the original reply and flag it below */ }

  const errs = errorsOf(issues);
  if (errs.length) current += `\n\n⚠️ Still breaks: ${errs.map((e) => e.msg).join("; ")}`;
  return current;
}

async function sendChatMessage() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text && !pendingChatImage && !pendingScene) return;

  const suggestionsContainer = $("chat-suggestions");
  if (suggestionsContainer) suggestionsContainer.hidden = true;

  const btn = $("chat-send-btn");
  btn.disabled = true;
  input.disabled = true;

  const scene = pendingScene;
  const userParts = [];
  if (scene) {
    for (const s of scene.shots) { userParts.push({ text: s.label }); userParts.push({ inlineData: s.inlineData }); }
  } else if (pendingChatImage) {
    userParts.push(pendingChatImage);
  }
  userParts.push({ text: text || "Write the Description for this driving scene." });

  appendChatMessage("user", text || (scene ? `[Scene capture: ${scene.shots.length} image${scene.shots.length === 1 ? "" : "s"}]` : "[Attached Driving Scene Image]"),
    scene ? scene.preview : (pendingChatImage ? pendingChatImage.inlineData : null));

  input.value = "";
  const attachedImg = scene || pendingChatImage;

  pendingChatImage = null;
  pendingScene = null;
  $("chat-image-preview-container").style.display = "none";

  try {
    await runChatRequest({ text, scene, attachedImg, userParts });
  } finally {
    btn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

/* AI chat tools: the model can end a reply with markers that the panel executes.
 * <<<RUN_AUDIT>>> — fetch the panel data from the annotation page and run the full
 *   compliance review (used when there is no data yet, e.g. autocheck is disabled).
 * <<<SPEED_CHECK>>> / <<<SPEED_CHECK 20>>> — measure the speeds with the calculator's
 *   own check (50 frames by default, any value below 50 on request, capped at the
 *   clip's last frame when the clip is shorter).
 * The results are posted into the conversation and the model interprets them in ONE
 * follow-up reply. Markers in the follow-up are stripped, never re-run. */
const AI_SPEED_CHECK_RE = /<+\s*SPEED_CHECK(?:\s*[:\-]?\s*(\d+))?\s*>+/i;
const RUN_AUDIT_RE = /<+\s*RUN_AUDIT\s*>+/i;
const AI_TOOL_MARKERS_RX = /<+\s*(?:SPEED_CHECK|RUN_AUDIT)\b[^>]*>+/i;
const AI_SPEED_WINDOW_DEFAULT = 50;

async function runAiToolTurn(speedMarkerText, wantsAudit) {
  const steps = [];
  showChatLoading();
  // Step 1 - full review: fetch the panel data from the page, then run the compliance audit
  if (wantsAudit) {
    let ok = false;
    try { ok = (await fetchFromPage({ triggerAudit: true })) === true && !!state.last; }
    catch (e) { ok = false; }
    steps.push(ok
      ? "[REVIEW RESULT] The full compliance review just completed on the data fetched from the page. The fresh results (warnings, suggestions, selections) are in the CURRENT DATA section of your instructions. Summarize them for the user in plain words: what complies, what breaks which rule, and the recommended fixes."
      : "[REVIEW FAILED] The review could not run — the annotation page with the clip may not be open in the active tab, or its fields could not be read. Tell the user this in plain words.");
  }
  // Step 2 - speed measurement through the calculator's own check
  if (speedMarkerText) {
    if (typeof aiSpeedCheckRef !== "function") {
      steps.push("[SPEED CHECK FAILED] The speed reader isn't ready yet. Tell the user to try again in a moment.");
    } else {
      // Optional window from the marker: <<<SPEED_CHECK 20>>> = 20 frames. Default 50;
      // any value below 50 is allowed on the user's request, never 50 or more.
      let frames = AI_SPEED_WINDOW_DEFAULT;
      const mm = String(speedMarkerText).match(AI_SPEED_CHECK_RE);
      if (mm && mm[1]) {
        const v = parseInt(mm[1], 10);
        if (v >= 1 && v < AI_SPEED_WINDOW_DEFAULT) frames = v;
      }
      let r;
      try { r = await aiSpeedCheckRef(frames); }
      catch (e) { r = { ok: false, msg: (e && e.message) || String(e) }; }
      if (r.ok) {
        const capNote = r.capped ? " — capped at the clip's last frame, the clip is shorter than " + frames + " frames (total " + r.totalFrames + ")" : "";
        steps.push("[SPEED CHECK RESULT] Start speed " + r.startSpeed + " m/s at frame " + r.startFrame + " (action point " + r.actionPoint + "); end speed " + r.endSpeed + " m/s at frame " + r.endFrame + " (" + r.windowFrames + " frames after the action point" + capNote + "); change " + (r.delta > 0 ? "+" : "") + r.delta + " m/s; calculator suggestion: " + r.suggestion + extrasText(r.extras) + ". Interpret this for the user in plain words: the start and end speeds, how the speed changed, and whether it agrees with the selected Speed Change label.");
      } else {
        steps.push("[SPEED CHECK FAILED] " + r.msg + " Tell the user this in plain words.");
      }
    }
  }
  hideChatLoading();
  // Step 3 - one continuation interpreting everything (results go into the history only,
  // they are not displayed as messages — the model's answer tells the user what happened)
  const resultText = steps.join("\n");
  chatHistory.push({ role: "user", parts: [{ text: resultText }], hasImage: false });
  showChatLoading();
  try {
    const reply = await callChatGemini(chatHistory);
    const clean = reply.replace(AI_TOOL_MARKERS_RX, "").trim(); // markers in the follow-up are stripped, never re-run
    chatHistory.push({ role: "model", parts: [{ text: clean }] });
    hideChatLoading();
    appendChatMessage("model", clean);
  } catch (e) {
    hideChatLoading();
    chatHistory.pop(); // the failed turn must not stay in the conversation
    appendChatMessage("error", "Error: " + (e && e.message ? e.message : e));
  }
}

// Runs one chat / scene-review request. Self-contained (its context carries the images), so the Retry
// button on an error bubble can simply run it again.
async function runChatRequest(ctx) {
  const { text, scene, attachedImg, userParts } = ctx;
  chatHistory.push({ role: "user", parts: userParts, hasImage: !!attachedImg });
  showChatLoading();

  try {
    let responseText;
    if (scene && !text) {
      // Image only → the two-stage scene review (observe, then write). A typed question goes to the chat below.
      responseText = await describeScene(scene.shots);
    } else {
      responseText = await callChatGemini(chatHistory);
    }
    if (attachedImg && !(scene && !text)) {
      responseText = await lintVisionReply(responseText);
      // Safety net: never show a "Note:" line under a generated Description
      if (/^\s*Description:/i.test(responseText)) responseText = responseText.replace(/\n+\s*Note:[\s\S]*?(?=\n+\s*⚠️ Still breaks:|$)/i, "").trim();
    }
    // AI tools: the model may end its reply with <<<RUN_AUDIT>>> (run the full review when
    // there is no data yet) and/or <<<SPEED_CHECK[n]>>> (measure the speeds). Chat path only —
    // never under a scene Description. Strip everything from the first marker on, run the
    // requested tools and hand the results back for interpretation.
    let speedMarker = null;
    let wantsAudit = false;
    if (!(scene && !text)) {
      speedMarker = responseText.match(AI_SPEED_CHECK_RE);
      wantsAudit = RUN_AUDIT_RE.test(responseText);
      if (speedMarker || wantsAudit) {
        const cut = responseText.search(AI_TOOL_MARKERS_RX);
        responseText = (cut !== -1 ? responseText.slice(0, cut) : responseText).trim();
        if (!responseText) responseText = wantsAudit ? "Let me run the full review — one moment." : "Let me measure the speeds on the page — one moment.";
      }
    }
    chatHistory.push({ role: "model", parts: [{ text: responseText }] });
    hideChatLoading();
    appendChatMessage("model", responseText);
    if (speedMarker || wantsAudit) await runAiToolTurn(speedMarker && speedMarker[0], wantsAudit);
  } catch (e) {
    hideChatLoading();
    chatHistory.pop(); // the failed request must not stay in the conversation
    appendChatMessage("error", `Error: ${e.message}`, null, { retry: (errDiv) => retryChatRequest(ctx, errDiv) });
  }
}

async function retryChatRequest(ctx, errDiv) {
  const sendBtn = $("chat-send-btn"), input = $("chat-input");
  if (sendBtn.disabled) return; // another request is still running
  if (errDiv && errDiv.remove) errDiv.remove();
  sendBtn.disabled = true;
  input.disabled = true;
  try {
    await runChatRequest(ctx);
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

function setSettingsVisibility(show) {
  $("main-view").hidden = show;
  $("settings-view").hidden = !show;
  if (show) { $("chat-view").hidden = true; $("bookmarks-view").hidden = true; $("calc-view").hidden = true; $("stats-view").hidden = true; }
}

async function setBookmarksVisibility(show) {
  $("main-view").hidden = show;
  $("bookmarks-view").hidden = !show;
  if (show) {
    $("settings-view").hidden = true;
    $("chat-view").hidden = true;
    $("calc-view").hidden = true;
    $("stats-view").hidden = true;
    await bmLoad();
    renderBookmarks();
    refreshBookmarkButtons();
    setTimeout(() => $("bm-search").focus(), 50);
  }
}

async function setChatVisibility(show) {
  $("main-view").hidden = show;
  $("chat-view").hidden = !show;
  if (show) {
    $("settings-view").hidden = true;
    $("bookmarks-view").hidden = true;
    $("calc-view").hidden = true;
    $("stats-view").hidden = true;
    setTimeout(() => $("chat-input").focus(), 100);

    try {
      const tab = await getActiveTab();
      if (tab && !isRestrictedUrl(tab.url)) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const emailEl = document.querySelector('span.xif65rj.x42gl0w');
            if (!emailEl) return "";
            const emailText = emailEl.textContent.trim();
            const localPart = emailText.split("@")[0];
            const rawName = localPart.split(".")[0] || localPart.split("_")[0] || localPart;
            return rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
          }
        });

        const firstName = results?.[0]?.result;
        if (firstName) {
          state.userName = firstName;
          const initialGreeting = $("chat-history")?.querySelector(".chat-message.model");
          if (initialGreeting) {
            initialGreeting.textContent = `Hello ${firstName}! I'm here to help with VLA guidelines, edge cases, and phrasing. What's on your mind?`;
          }
        }
      }
    } catch (_) {}
  }
}

function setCalcVisibility(show) {
  $("main-view").hidden = show;
  $("calc-view").hidden = !show;
  if (show) {
    $("settings-view").hidden = true;
    $("chat-view").hidden = true;
    $("bookmarks-view").hidden = true;
    $("stats-view").hidden = true;
    setTimeout(() => $("calc-start").focus(), 50);
  }
}

/* ====================================================================
 * Gemini / Groq Router (Review & Audit Model)
 * ==================================================================== */
const cache = new Map();
const CACHE_MAX = 40;

// Audit results also survive closing the panel / restarting Chrome (chrome.storage.local). The key includes the
// rules prompt, so editing a rule never serves an answer produced under the old rules.
const PCACHE_KEY = "vla_audit_cache";
const PCACHE_MAX = 80;
let pcache = null;
let pcacheTimer = null;
const hashStr = (str) => {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
};
async function pcacheLoad() {
  if (pcache) return pcache;
  const st = (await chrome.storage.local.get(PCACHE_KEY).catch(() => ({}))) || {};
  pcache = (st[PCACHE_KEY] && typeof st[PCACHE_KEY] === "object") ? st[PCACHE_KEY] : {};
  return pcache;
}
function pcacheSaveSoon() {
  clearTimeout(pcacheTimer);
  pcacheTimer = setTimeout(() => chrome.storage.local.set({ [PCACHE_KEY]: pcache }).catch(() => {}), 500);
}
const cacheKeys = (parts, request) => {
  const k = JSON.stringify([state.model, parts]);
  return { k, pk: parts[0] === "audit" ? "k" + hashStr(request.system || "") + hashStr(k) : null };
};
async function hasCachedGemini(parts, request) {
  const { k, pk } = cacheKeys(parts, request);
  if (cache.has(k)) return true;
  if (!pk) return false;
  const pc = await pcacheLoad();
  return !!pc[pk];
}

async function cachedGemini(parts, request) {
  const { k, pk } = cacheKeys(parts, request);
  if (cache.has(k)) return cache.get(k);
  if (pk) {
    const pc = await pcacheLoad();
    if (pc[pk]) { cache.set(k, pc[pk].v); return pc[pk].v; }
  }
  const result = await callGemini(request);
  cache.set(k, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  if (pk) {
    const pc = await pcacheLoad();
    pc[pk] = { t: Date.now(), v: result };
    const keys = Object.keys(pc);
    if (keys.length > PCACHE_MAX) { keys.sort((a, b) => pc[a].t - pc[b].t); for (const x of keys.slice(0, keys.length - PCACHE_MAX)) delete pc[x]; }
    pcacheSaveSoon();
  }
  return result;
}

const stripEnums = (schema) => JSON.parse(JSON.stringify(schema, (k, v) => (k === "enum" ? undefined : v)));

async function callGemini({ system, text, schema, images = [], labels = [], timeoutMs = 60000, temperature = 0, model = null, maxTokens = 600 }) {
  const originalModel = model || state.model;
  // Start from a budget remembered from earlier cut-offs (thinking models burn output tokens before the JSON)
  let budget = Math.min(16384, maxTokens * (state.tokenBoost || 1));

  const executeAuditFetchOnce = async (modelToUse, apiKey = null) => {
    const isGroq = isGroqModel(modelToUse);
    const usableKey = apiKey || providerKeys(isGroq, modelToUse)[0];
    if (!usableKey) throw new Error(`Add your ${isGroq ? "Groq" : "Google AI Studio"} API key in settings (⚙️) first.`);
    
    let url, body, headers;
    
    if (isGroq) {
      url = "https://api.groq.com/openai/v1/chat/completions";
      const systemInstruction = `${system || ""}\n\nYou MUST respond in pure JSON format following this schema: ${JSON.stringify(stripEnums(schema))}. Do not include markdown formatting or explanations.`;
      
      let userContent;
      if (images && images.length > 0) {
        userContent = [];
        if (text) userContent.push({ type: "text", text });
        images.forEach((i, n) => {
           if (labels[n]) userContent.push({ type: "text", text: labels[n] });
           userContent.push({
             type: "image_url",
             image_url: { url: `data:${i.mimeType || "image/png"};base64,${i.data}` }
           });
        });
      } else {
        userContent = text || "";
      }

      body = {
        model: modelToUse,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userContent }
        ],
        temperature,
        max_tokens: Math.max(4096, budget)
      };
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${usableKey}` };
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelToUse)}:generateContent`;
      body = {
        contents: [{ role: "user", parts: [{ text }, ...images.flatMap((i, n) => [
          ...(labels[n] ? [{ text: labels[n] }] : []),
          { inlineData: { mimeType: i.mimeType || "image/png", data: i.data } }
        ])] }],
        generationConfig: { 
          temperature, 
          maxOutputTokens: budget, 
          responseMimeType: "application/json", 
          responseSchema: schema 
        }
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (state.plainSchema) body.generationConfig.responseSchema = stripEnums(schema);
      // Flash models spend output budget on hidden thinking before the JSON: keep it low for this structured task
      if (!state.noThinkingCfg && /flash/i.test(modelToUse)) body.generationConfig.thinkingConfig = { thinkingLevel: "low" };
      headers = { "Content-Type": "application/json", "x-goog-api-key": usableKey };
    }

    const ctrl = new AbortController();
    // fast models should answer quickly: a hung request moves on to the fallback model after 20-30 s instead of 60
    const tmo = (images && images.length) ? timeoutMs : Math.min(timeoutMs, /lite/i.test(modelToUse) ? 20000 : 30000);
    const timer = setTimeout(() => ctrl.abort(), tmo);

    let resp;
    try {
      resp = await fetchRetry(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError" || e.isTimeout) {
        const timeoutErr = new Error("The check timed out. Try again or switch to Gemini 3.5 Flash Lite in Settings (⚙️).");
        timeoutErr.isTimeout = true;
        throw timeoutErr;
      }
      const netErr = new Error(`Network error: ${e.message}`);
      netErr.isNetwork = true;
      throw netErr;
    }
    clearTimeout(timer);

    let data;
    try { data = await resp.json(); } catch (_) { throw new Error(`Bad response from the API (HTTP ${resp.status}).`); }

    if (!resp.ok || data.error) {
      const ae = apiError(data, resp.status);
      if (ae.status === 400 && /thinking/i.test(ae.message)) ae.thinkingUnsupported = true; // model doesn't take the setting
      throw ae;
    }
    
    let out = "";
    let finishReason = "";
    if (isGroq) {
        out = data.choices?.[0]?.message?.content || "";
        finishReason = data.choices?.[0]?.finish_reason === "length" ? "MAX_TOKENS" : "";
        if (!out) throw new Error(`Empty response from the model.`);
    } else {
        if (data.promptFeedback?.blockReason) throw new Error(`Blocked by the API: ${data.promptFeedback.blockReason}`);
        const cand = data.candidates?.[0];
        finishReason = cand?.finishReason || "";
        out = (cand?.content?.parts || []).map((p) => p.text || "").join("");
        if (!out) throw new Error(`Empty response from the model${cand?.finishReason ? ` (${cand.finishReason})` : ""}.`);
    }

    // The key that just worked is healthy again — clear its cooldown so it leads the next run
    clearKeyLimited(usableKey, modelToUse);

    try {
      return parseLLMResponse(out);
    } catch (_) {
      const bad = new Error(finishReason === "MAX_TOKENS" ? `The model's reply was cut off. Try again.` : `The model returned invalid JSON. Try again.`);
      bad.isBadJson = true;
      throw bad;
    }
  };

  // A cut-off or unparsable reply is retried once, automatically, with twice the output budget
  // (thinking models spend part of the budget before they start writing the JSON)
  const executeAuditFetch = async (modelToUse, apiKey = null) => {
    try {
      try {
        return await executeAuditFetchOnce(modelToUse, apiKey);
      } catch (e) {
        if (!e.thinkingUnsupported) throw e;
        state.noThinkingCfg = true; // remember: send no thinking setting from now on
        return await executeAuditFetchOnce(modelToUse, apiKey);
      }
    } catch (e) {
      if (!e.isBadJson) throw e;
      // Cut off / unparsable: retry up to twice, each time with a much bigger output budget
      let last = e;
      for (let step = 0; step < 2; step++) {
        budget = Math.min(16384, budget * 2);
        try {
          const out = await executeAuditFetchOnce(modelToUse, apiKey);
          state.tokenBoost = Math.min(4, Math.max(state.tokenBoost || 1, Math.ceil(budget / maxTokens))); // start higher next time
          return out;
        } catch (e2) {
          if (!e2.isBadJson) throw e2;
          last = e2;
        }
      }
      throw last;
    }
  };

  // One model: primary key first; on a rate limit / dead connection rotate once to the backup key
  const tryAuditKeys = (model) => runWithKeyRotation(model, executeAuditFetch);

  // Overloaded? Serve this request with a backup model for a while, then switch back automatically
  return routeWithFallback(originalModel, tryAuditKeys, "model-input");
}

const STR_ARRAY = { type: "ARRAY", items: { type: "STRING" } };
const enumOf = (values) => ({ type: "STRING", enum: values });
const WARNING_SCHEMA = {
  type: "OBJECT",
  properties: { rule: { type: "STRING" }, quote: { type: "STRING" }, message: { type: "STRING" } },
  required: ["rule", "quote", "message"]
};
const BOX_SCHEMA = {
  type: "OBJECT",
  properties: { hasIssues: { type: "BOOLEAN" }, warnings: { type: "ARRAY", items: WARNING_SCHEMA }, complianceNotes: STR_ARRAY, suggestions: STR_ARRAY },
  required: ["hasIssues", "warnings", "complianceNotes", "suggestions"]
};
const AUDIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    box1: BOX_SCHEMA,
    box2: BOX_SCHEMA,
    selectionWarnings: STR_ARRAY,
    predictedManeuver: {
      type: "OBJECT",
      properties: {
        maneuverLabel: enumOf(VLA.MANEUVERS),
        suggestedSpeedChange: enumOf(VLA.SPEEDS),
        suggestedContexts: { type: "ARRAY", items: enumOf(VLA.CONTEXTS.map((c) => c.value)) },
        reasoning: { type: "STRING" }
      },
      required: ["maneuverLabel", "suggestedSpeedChange", "suggestedContexts", "reasoning"]
    }
  },
  required: ["box1", "box2", "selectionWarnings", "predictedManeuver"]
};
const VALIDATION_SCHEMA = {
  type: "OBJECT",
  properties: { isValid: { type: "BOOLEAN" }, violation: { type: "STRING" } },
  required: ["isValid", "violation"]
};

const REPHRASE_SCHEMA = {
  type: "OBJECT",
  properties: { text: { type: "STRING" } },
  required: ["text"]
};

function buildControls() {
  const mSel = $("user-maneuver");
  ["Auto", ...VLA.MANEUVERS].forEach((v) => mSel.add(new Option(v, v)));
  const sSel = $("user-speed");
  ["Auto", ...VLA.SPEEDS].forEach((v) => sSel.add(new Option(v, v)));

  const bmMSel = $("bm-maneuver-filter");
  if (bmMSel) ["Auto", ...VLA.MANEUVERS].forEach((v) => bmMSel.add(new Option(v, v)));

  const grid = $("context-container");
  [{ value: "Auto", label: "Auto" }, ...VLA.CONTEXTS].forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "context-pill" + (c.value === "Auto" ? " selected" : "");
    b.dataset.val = c.value;
    b.textContent = c.label;
    b.setAttribute("aria-pressed", c.value === "Auto" ? "true" : "false");
    grid.appendChild(b);
  });

  grid.addEventListener("click", (e) => {
    const pill = e.target.closest(".context-pill");
    if (!pill || pill.disabled) return;
    const pills = [...grid.querySelectorAll(".context-pill")];
    const autoPill = pills.find((p) => p.dataset.val === "Auto");
    if (pill.dataset.val === "Auto") {
      setSelectedContexts(["Auto"]);
    } else {
      pill.classList.toggle("selected");
      autoPill.classList.remove("selected");
      if (!pills.some((p) => p.classList.contains("selected"))) autoPill.classList.add("selected");
      syncPillAria();
    }
    persistSoon();
  });
}

function syncPillAria() {
  document.querySelectorAll(".context-pill").forEach((p) =>
  p.setAttribute("aria-pressed", p.classList.contains("selected") ? "true" : "false"));
}

function getSelectedContexts() {
  const sel = [...document.querySelectorAll(".context-pill.selected")].map((p) => p.dataset.val);
  return sel.length ? sel : ["Auto"];
}

function setSelectedContexts(values) {
  const wanted = new Set(values);
  let any = false;
  document.querySelectorAll(".context-pill").forEach((p) => {
    const on = wanted.has(p.dataset.val);
    p.classList.toggle("selected", on);
    if (on) any = true;
  });
  if (!any) document.querySelector('.context-pill[data-val="Auto"]').classList.add("selected");
  syncPillAria();
}

let persistTimer;
function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 300); }
function persist() {
  const snapshot = {
    box1: $("box1-input").value,
    box2: $("box2-input").value,
    maneuver: $("user-maneuver").value,
    speed: $("user-speed").value,
    contexts: getSelectedContexts(),
    auditTab: state.auditTab,
    dataTab: state.dataTab,
    last: state.last,
    isReadOnly: state.isReadOnly
  };
  chrome.storage.session.set({ vla_state: snapshot }).catch(() => {});
}

async function restoreSession() {
  try {
    const { vla_state: s } = await chrome.storage.session.get("vla_state");
    if (!s) return;
    $("box1-input").value = s.box1 || "";
    $("box2-input").value = s.box2 || "";
    if (s.maneuver && [...$("user-maneuver").options].some((o) => o.value === s.maneuver)) $("user-maneuver").value = s.maneuver;
    if (s.speed && [...$("user-speed").options].some((o) => o.value === s.speed)) $("user-speed").value = s.speed;
    setSelectedContexts(s.contexts || ["Auto"]);
    state.auditTab = s.auditTab || null;
    state.dataTab = s.dataTab || null;
    state.isReadOnly = s.isReadOnly || false;
    if (s.last && s.last.res && s.last.ctx) {
      state.last = s.last;
      renderResults(s.last.res, s.last.ctx);
      updateBadge();
    }
  } catch (_) { }
}

/* ====================================================================
 * Live local lint
 * ==================================================================== */
function renderLint(field, text, lintEl, countEl) {
  const n = VLA.wordCount(text);
  countEl.textContent = text.trim() ? `${n}/${VLA.MAX_WORDS} words` : "";
  countEl.classList.toggle("over", n > VLA.MAX_WORDS);
  const issues = VLA.lint(field, text);
  lintEl.innerHTML = issues.length
  ? `<ul class="lint">${issues.map((i) =>
    `<li class="lint-${i.level}">${i.level === "error" ? "⚠️" : "💡"} ${escapeHTML(i.msg)}</li>`).join("")}</ul>`
    : "";
  return issues;
}

function refreshInputLint() {
  renderLint("box1", $("box1-input").value, $("box1-lint"), $("box1-count"));
  renderLint("box2", $("box2-input").value, $("box2-lint"), $("box2-count"));
  refreshBookmarkButtons();
}

/* ====================================================================
 * Talking to the page
 * ==================================================================== */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function panelError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "content.js"] });
    } catch (e) {
      throw panelError("NO_ACCESS", e.message);
    }
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

function showAccessCard(tab, retry) {
  if (!tab || !tab.url || !tab.url.startsWith(ALLOWED_ORIGIN)) return;

  $("access-text").textContent = `VLA Reviewer needs permission to read and fill the fields on ${ALLOWED_ORIGIN}. This is granted for this site only.`;
  $("access-card").hidden = false;
  $("access-btn").onclick = async () => {
    const granted = await chrome.permissions.request({ origins: [`${ALLOWED_ORIGIN}/*`] });
    if (granted) {
      $("access-card").hidden = true;
      state.badgeAlert = null;
      updateBadge();
      if (retry) retry();
    }
  };
}

async function callPage(message, { sameTab = false, retry = null } = {}) {
  const tab = await getActiveTab();
  if (!tab || isRestrictedUrl(tab.url)) throw panelError("UNSUPPORTED", "This page type isn't supported.");
  if (sameTab && state.auditTab && (tab.id !== state.auditTab.id || stripHash(tab.url) !== state.auditTab.url)) {
    throw panelError("PAGE_CHANGED", "The page changed since this check — run Check Compliance again.");
  }
  try {
    const response = await sendToTab(tab.id, message);
    if (!response) throw panelError("NO_RESPONSE", "No response from the page.");
    return { tab, response };
  } catch (e) {
    if (e.code === "NO_ACCESS") showAccessCard(tab, retry);
    throw e;
  }
}

function errorLabel(e, fallback = "Error — retry") {
  switch (e.code) {
    case "PAGE_CHANGED": return "Page changed — re-run check";
    case "NO_ACCESS": return "Allow site access ↑";
    case "UNSUPPORTED": return "Unsupported page";
    case "NOT_READY": return "Fields not found on page";
    default: return fallback;
  }
}

function fillFromPage(resp) {
  const found = resp.found || {};
  if (found.description !== false) $("box1-input").value = resp.description || "";
  if (found.causalAction !== false) $("box2-input").value = resp.causalAction || "";

  if (resp.maneuver && [...$("user-maneuver").options].some((o) => o.value === resp.maneuver)) {
    $("user-maneuver").value = resp.maneuver;
  }
  if (resp.speedChange && [...$("user-speed").options].some((o) => o.value === resp.speedChange)) {
    $("user-speed").value = resp.speedChange;
  }
  if (resp.contexts) setSelectedContexts(resp.contexts.length ? resp.contexts : ["Auto"]);

  state.isReadOnly = !!resp.isReadOnly;
  updateHistoryButtons();

  if (resp.firstName) {
    state.userName = resp.firstName;
    const initialGreeting = $("chat-history")?.querySelector(".chat-message.model");
    if (initialGreeting) {
      initialGreeting.textContent = `Hello ${resp.firstName}! I'm here to help with VLA guidelines, edge cases, and phrasing. What's on your mind?`;
    }
  }

  refreshInputLint();
  notify("");
}

function clearResults() {
  $("output").innerHTML = "";
  state.last = null;
  lastSceneRead = null; // the scene observations belong to the previous clip
  state.auditTab = null;
  state.trusted = {};
  state.badgeAlert = null;
  state.isReadOnly = false;
  notify("");
  updateBadge();
  updateFooterButtons();
}

function clearPanel() {
  clearResults();
  $("box1-input").value = "";
  $("box2-input").value = "";
  $("user-maneuver").value = "Auto";
  $("user-speed").value = "Auto";
  setSelectedContexts(["Auto"]);
  refreshInputLint();
  state.dataTab = null;
  persist();
  updateFooterButtons();
}

const pageReady = (r) => !!(r.found && (r.found.description || r.found.causalAction));

function updateFetchVisibility() {
  $("fetch-btn").hidden = state.autoFetch && !state.autoFetchFailed;
}

async function fetchFromPage({ triggerAudit = false, silent = false, ui = null, withSpeed = true } = {}) {
  const tPage = performance.now();
  const u = ui || { btn: $("fetch-btn"), busy: "Fetching...", ok: "Data Fetched! ✓", idle: FETCH_LABEL, short: false };
  const btn = u.btn;
  if (!silent) btn.textContent = u.busy;
  state.badgeAlert = null;

  try {
    const before = state.auditTab;
    const attempts = silent ? 28 : 14;
    let result;
    for (let i = 0; i < attempts; i++) {
      result = await callPage({ action: "EXTRACT_DATA" }, {
        retry: () => fetchFromPage({ triggerAudit, silent: false, ui, withSpeed })
      });
      if (pageReady(result.response)) break;
      if (i < attempts - 1) await sleep(300);
    }
    const { tab, response } = result;
    if (!pageReady(response)) throw panelError("NOT_READY", "Description / Causal Action fields not found on the page.");
    fillFromPage(response);
    perfLog("page read", performance.now() - tPage);
    state.lastSeenPage = `${tab.id}|${stripHash(tab.url)}`;

    if (before && (before.id !== tab.id || before.url !== stripHash(tab.url))) clearResults();

    state.dataTab = { id: tab.id, url: stripHash(tab.url) };
    renderClipLog(state.dataTab.url);
    updateFooterButtons();
    state.autoFetchFailed = false;
    updateFetchVisibility();
    refreshActionPointUI(); // the Action Point section follows the clip that was just fetched
    if (!silent) flash(btn, u.ok, COLOR.good, u.idle);
    persistSoon();

    state.badgeAlert = null;
    updateBadge();

    if (triggerAudit) await auditText({ withSpeed });
    return true;
  } catch (e) {
    if (e.code === "NO_ACCESS") {
      state.badgeAlert = "NO_ACCESS";
    }
    updateBadge();

    if (silent) {
      if (e.code === "NOT_READY") {
        const t = await getActiveTab().catch(() => null);
        if (t && state.dataTab && t.id === state.dataTab.id) clearPanel();
      } else {
        state.autoFetchFailed = true;
        updateFetchVisibility();
      }
    } else {
      flash(btn, u.short ? "⚠️" : errorLabel(e, "⚠️ Couldn't read the page"), COLOR.err, u.idle, 3500);
      if (u.short || btn.hidden) notify(escapeHTML(e.message || "Couldn't read the page."));
    }
    return false;
  }
}

/* ====================================================================
 * Audit
 * ==================================================================== */
function normBox(b, boxText = "", allText = "") {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);
  const rawWarnings = Array.isArray(b?.warnings) ? b.warnings : [];
  const box = {
    warnings: Prompts.filterWarnings(rawWarnings, boxText, allText),
    suggestions: Prompts.filterSuggestions(arr(b?.suggestions), boxText, allText),
    complianceNotes: arr(b?.complianceNotes)
  };
  // Every warning was a false positive -> the rewrites were nitpicks too
  if (rawWarnings.length && !box.warnings.length) box.suggestions = [];
  box.hasIssues = box.warnings.length > 0;
  return box;
}

function mergeLocalFindings(box, field, text) {
  if (!text) return;
  const hay = box.warnings.join(" ").toLowerCase();
  VLA.lint(field, text).filter((i) => i.level === "error").forEach((i) => {
    const needle = String(i.match || "words").toLowerCase();
    if (!hay.includes(needle)) box.warnings.push(`[Local check] ${i.msg}`);
  });
  box.hasIssues = box.warnings.length > 0;
}

function normalizeAudit(raw, ctx) {
  const allText = `${ctx.box1Text} ${ctx.box2Text}`;
  const res = {
    box1: normBox(raw.box1, ctx.box1Text, allText),
    box2: normBox(raw.box2, ctx.box2Text, allText),
    selectionWarnings: (Array.isArray(raw.selectionWarnings) ? raw.selectionWarnings : [])
      .filter((x) => typeof x === "string" && x.trim()),
    predictedManeuver: null
  };
  mergeLocalFindings(res.box1, "box1", ctx.box1Text);
  mergeLocalFindings(res.box2, "box2", ctx.box2Text);
  const p = raw.predictedManeuver;
  if (p) {
    const ctxValues = VLA.CONTEXTS.map((c) => c.value);
    res.predictedManeuver = {
      maneuverLabel: VLA.MANEUVERS.includes(p.maneuverLabel) ? p.maneuverLabel : "",
      suggestedSpeedChange: VLA.SPEEDS.includes(p.suggestedSpeedChange) ? p.suggestedSpeedChange : "",
      suggestedContexts: (p.suggestedContexts || []).filter((c) => ctxValues.includes(c)),
      reasoning: p.reasoning || ""
    };
  }
  return res;
}

const AUTO_SPEED_FRAMES = 50;
let speedMemo = null; // { url, userSpeed, speedCheck, unavailable } from the last speed measurement

// Speed check used by the auto-audit: the calculator's own 50-frame measurement.
// opts.noSeek = read everything from the clip's telemetry API without moving the playhead
// (used on read-only / review clips). Waits out "busy" / "still loading" answers for a while;
// any other failure is final. Never throws - the review simply runs without speed data when
// no reading is possible.
async function measureSpeedForAudit(opts) {
  if (typeof aiSpeedCheckRef !== "function") return { ok: false, msg: "The speed reader isn't ready." };
  const deadline = Date.now() + 45000;
  let last = { ok: false, msg: "The speed check did not run." };
  while (Date.now() < deadline) {
    try { last = await aiSpeedCheckRef(AUTO_SPEED_FRAMES, opts || {}); }
    catch (e) { last = { ok: false, msg: (e && e.message) || String(e) }; }
    if (last.ok) return last;
    if (!/already reading|still loading|can't read the annotation page|didn't finish in time/i.test(last.msg || "")) return last;
    await sleep(700);
  }
  return last;
}

// Telemetry WITHOUT a speed reading: when the clip has no usable speed (or the speed read failed) but still
// has steering / acceleration / brake data, the review keeps using those channels. Reads the clip's own
// data (no seeking) over the same window as the speed check: action point -> +50 frames (or the clip's end).
// Returns null when no channel has data. Shape matches ctx.speedCheck (speed fields null, suggestion null).
async function partialTelemetryFor(dp) {
  try {
    if (!telemetryRef || dp == null) return null;
    const s = await telemetryRef.ensure();
    if (!s || !s.ch || !s.frameT || !s.frameT.length) return null;
    if (!(s.ch.steer || s.ch.accel || s.ch.brake)) return null;
    const last = s.frameT.length;
    const f0 = Math.min(Math.max(1, dp), last);
    const f1 = Math.min(dp + AUTO_SPEED_FRAMES, last);
    const window = telemetryRef.stats(f0, f1);
    const extras = { start: telemetryRef.extrasAt(f0), end: telemetryRef.extrasAt(f1), window };
    if (!window && !extras.start && !extras.end) return null;
    return {
      startSpeed: null, endSpeed: null, delta: null, suggestion: null,
      frames: Math.max(1, f1 - f0), capped: f1 < dp + AUTO_SPEED_FRAMES,
      extras, history: telemetryRef.historyStats(dp) || null,
      noSeek: true, partial: true, actionPoint: dp, totalFrames: last
    };
  } catch (_) { return null; }
}

// "; telemetry ..." for the AI chat's speed-check result (empty when the clip has no such data)
function extrasText(ex) {
  if (!ex) return "";
  const names = { accel: "acceleration", steer: "steering angle", brake: "brake pedal" };
  const parts = [];
  for (const k of ["accel", "steer", "brake"]) {
    const a = ex.start && ex.start[k], b = ex.end && ex.end[k];
    if (!a && !b) continue;
    const u = (b && b.unit) || (a && a.unit) || "";
    parts.push(names[k] + " " + (a ? a.v : "n/a") + " -> " + (b ? b.v : "n/a") + (u ? " " + u : ""));
  }
  const w = ex.window;
  if (w) {
    if (w.accelMin != null) parts.push("hardest braking (lowest acceleration) " + w.accelMin + " " + (w.accelUnit || ""));
    if (w.brakeMax != null) parts.push("peak brake pedal " + w.brakeMax + " " + (w.brakeUnit || ""));
    if (w.steerMin != null) parts.push("steering range " + w.steerMin + " to " + w.steerMax + " " + (w.steerUnit || ""));
  }
  const h = ex.history;
  if (h) {
    const hp = [];
    if (h.speedMin != null) hp.push("speed " + h.speedMin + " to " + h.speedMax + " " + (h.speedUnit || "m/s"));
    if (h.steerMin != null) hp.push("steering " + h.steerMin + " to " + h.steerMax + " " + (h.steerUnit || ""));
    if (h.accelMin != null) hp.push("lowest acceleration " + h.accelMin + " " + (h.accelUnit || ""));
    if (h.brakeMax != null) hp.push("peak brake " + h.brakeMax + " " + (h.brakeUnit || ""));
    if (hp.length) parts.push("in the 2 s before the action point: " + hp.join(", "));
  }
  return parts.length ? "; telemetry at action point -> end: " + parts.join(", ") : "";
}

// Normalised view of a speed reading for the prompt / cache key (ctx.speedCheck).
function speedCtxFrom(r, userSpeed) {
  if (!r || !r.ok) return null;
  return {
    startSpeed: r.startSpeed, endSpeed: r.endSpeed, delta: r.delta,
    frames: r.windowFrames, capped: !!r.capped, suggestion: r.suggestion,
    extras: r.extras || null, // { start, end, window }: acceleration / steering / brake from the clip's own telemetry data
    history: r.history || null, // same stats for the ~2 s BEFORE the action point (what the Description describes)
    noSeek: !!r.noSeek, // true = read from the clip's telemetry API, the playhead was never moved
    actionPoint: (r.actionPoint != null ? r.actionPoint : null), // frame of the action point (fallback for the action-point check)
    totalFrames: (r.totalFrames != null ? r.totalFrames : null)
  };
}

// Deterministic cross-check: the selected Speed Change vs. the measured one.
// Decelerate / Strong decelerate share a family (the calculator cannot tell emergencies apart).
function speedMismatchWarning(userSpeed, sc) {
  if (!sc || !userSpeed || userSpeed === "Auto") return null;
  const fam = (x) => (x === "Strong decelerate" ? "Decelerate" : x);
  if (fam(userSpeed) === fam(sc.suggestion)) return null;
  const sign = sc.delta > 0 ? "+" : "";
  return `Selected Speed Change is "${userSpeed}", but the measured speed went ${sc.startSpeed} → ${sc.endSpeed} m/s over ${sc.frames} frames (${sign}${sc.delta} m/s), which points to "${sc.suggestion}".`;
}

// The speed meaning of the causal action's opening verb (null = can't tell)
function speedLabelOfVerb(text) {
  const t = String(text || "").trim().toLowerCase();
  let m;
  if ((m = t.match(/^(?:accelerat\w*|speed(?:ing)? up|increase (?:the )?speed|gain speed|pick up speed|build speed)/))) return { label: "Accelerate", said: m[0] };
  if ((m = t.match(/^(?:decelerat\w*|slow(?:ing)?(?: down)?|reduce (?:the )?speed|lower (?:the )?speed|brak\w*|ease off)/))) return { label: "Decelerate", said: m[0] };
  // "maintain/keep/hold/continue … speed" only counts when no OTHER speed verb sits between the
  // opening verb and the speed word: "Maintain lane and reduce speed" is a Decelerate instruction
  // (the lane is what is maintained), not a Maintain-speed one — the old lazy gap matched it.
  if ((m = t.match(/^(?:maintain|keep|hold|continue)\b(?:(?!\b(?:reduce|lower|slow|decelerat|accelerat|brak|speed up|increase|stop|resume|start moving)\b)[^.,;])*?\b(?:speed|pace|velocity)\b/))) return { label: "Maintain speed", said: m[0] };
  if ((m = t.match(/^(?:stop\b|come to a (?:complete )?stop|halt\b)/))) return { label: "Stop", said: m[0] };
  if ((m = t.match(/^(?:remain|stay|wait)\b[^.,;]*?\b(?:stopped|stationary|still)\b/))) return { label: "Remain stopped", said: m[0] };
  if ((m = t.match(/^(?:resume|start moving|start from|begin moving|move off|proceed)/))) return { label: "Resume motion", said: m[0] };
  return null;
}
const SPEED_FAMILY = { "Accelerate": "up", "Resume motion": "up", "Decelerate": "down", "Strong decelerate": "down", "Stop": "down", "Maintain speed": "keep", "Remain stopped": "still" };

// Causal action verb vs the MEASURED speed (no AI needed)
function verbSpeedWarning(box2Text, sc) {
  const v = speedLabelOfVerb(box2Text);
  if (!v || !sc) return null;
  if (SPEED_FAMILY[v.label] === SPEED_FAMILY[sc.suggestion]) return null;
  const sign = sc.delta > 0 ? "+" : "";
  return `The causal action verb "${v.said}" means ${v.label}, but the measured speed went ${sc.startSpeed} → ${sc.endSpeed} m/s (${sign}${sc.delta} m/s), which points to "${sc.suggestion}".`;
}

// The measured speed decides the opening verb of a SUGGESTED causal action: when the suggestion's
// verb disagrees with the telemetry, its opening verb phrase is swapped for the measured one
// ("Maintain lane and speed to match the flow" + measured Accelerate -> "Accelerate to match the flow").
const VERB_FOR_LABEL = { "Accelerate": "Accelerate", "Decelerate": "Slow down", "Strong decelerate": "Slow down", "Maintain speed": "Maintain speed", "Stop": "Stop", "Remain stopped": "Remain stopped", "Resume motion": "Resume motion" };
function telemetryFirstText(text, sc) {
  const t = String(text || "").trim();
  if (!t || !sc || !sc.suggestion) return t;
  const v = speedLabelOfVerb(t);
  if (!v || SPEED_FAMILY[v.label] === SPEED_FAMILY[sc.suggestion]) return t;
  const verb = VERB_FOR_LABEL[sc.suggestion];
  if (!verb) return t;
  const rest = t.slice(v.said.length).replace(/^[\s,]+/, "");
  const out = rest ? verb + " " + rest : verb;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// Selected contexts that need a particular speed behaviour (no AI needed)
function contextSpeedWarning(userContexts, sc) {
  if (!sc || !Array.isArray(userContexts)) return null;
  const fam = SPEED_FAMILY[sc.suggestion];
  const bad = [];
  if (userContexts.includes("Slow for the lead vehicle") && fam !== "down") bad.push('"Slow for the lead vehicle" needs a measured Decelerate or Stop');
  if (userContexts.includes("Stop for the lead vehicle") && (sc.suggestion === "Accelerate" || fam === "keep")) bad.push('"Stop for the lead vehicle" needs a measured slow-down, stop or restart');
  if (userContexts.includes("Consistent driving") && fam !== "keep") bad.push('"Consistent driving" needs a measured Maintain speed');
  return bad.length ? `Context mismatch: ${bad.join("; ")} (measured ${sc.startSpeed} → ${sc.endSpeed} m/s, ${sc.suggestion}).` : null;
}

/* ---- Telemetry cross-checks from the acceleration / steering / brake channels (no AI needed).
   All of them are hints driven by the clip's own data; they only fire when the measured values
   clearly disagree with the annotation or the selected labels. ---- */

// Maneuvers whose whole point is turning the wheels (steering should move when they happen)
const MERGE_SPLIT = "Merge / split (facility change)";
const LATERAL_MANEUVERS = [
  "Lane change left", "Lane change right", "Turn (intersection/roundabout/U-turn)",
  "Double lane change", "Out-of-lane nudge (straddle avoidance)", "In-lane nudge",
  "Pull-over / curb approach left", "Pull-over / curb approach right",
  "Pull-out / rejoin road left", "Pull-out / rejoin road right",
  "Merge / split (facility change)", "Lateral maneuver abort"
];

// Steering calibration (road-wheel degrees — the site's charts show lane-keeping noise within
// roughly ±0.5°, while a real intersection/roundabout turn holds several degrees):
// below QUIET a lateral maneuver cannot have happened, above TURN it clearly did, and in
// between the check stays silent rather than guessing.
const STEER_QUIET_MAX = 0.5;
const STEER_TURN_MIN = 2.0;

// Shared steering verdict: "bad" = measured steering contradicts the maneuver, "ok" = consistent,
// null = uncertain (no verdict, no warning). Used by both the warning and the card's ✓/✗ row.
function steerVerdict(userManeuver, w, clipMax) {
  if (!w || w.steerMin == null) return null;
  const maxAbs = Math.max(Math.abs(w.steerMin), Math.abs(w.steerMax));
  const deg = !w.steerUnit || w.steerUnit === "°" || /deg/i.test(w.steerUnit); // absolute thresholds assume degrees
  if (userManeuver === MERGE_SPLIT) {
    // Official ruling: approaching a merge/split and MAINTAINING the lane is still a Merge / split,
    // so quiet steering never contradicts it (a clear swing still supports it).
    if (deg) return maxAbs >= STEER_TURN_MIN * 0.5 ? "ok" : null;
    return clipMax > 0 && maxAbs >= clipMax * 0.5 ? "ok" : null;
  }
  if (LATERAL_MANEUVERS.includes(userManeuver)) {
    // A Turn (intersection/roundabout/U-turn) holds much more steering than a lane change,
    // nudge or pull-out — so it gets a higher bar for "clearly happened".
    const isTurn = userManeuver === "Turn (intersection/roundabout/U-turn)";
    const quiet = isTurn ? STEER_QUIET_MAX : STEER_QUIET_MAX * 0.6; // 0.5° vs 0.3°
    const clear = isTurn ? STEER_TURN_MIN : STEER_TURN_MIN * 0.5;   // 2.0° vs 1.0°
    if (deg) {
      if (maxAbs < quiet) return "bad";
      if (maxAbs >= clear) return "ok";
    } else if (clipMax > 0) {
      if (maxAbs < clipMax * 0.1) return "bad";
      if (maxAbs >= clipMax * 0.5) return "ok";
    }
    return null;
  }
  if (userManeuver === "Lane keeping & centering") {
    if (deg) {
      if (maxAbs > 2) return "bad"; // definitely more than lane-keeping corrections, whatever the clip
      // relative swing only counts when the clip actually contains real turning somewhere
      if (clipMax >= STEER_TURN_MIN && maxAbs > clipMax * 0.6) return "bad";
    } else if (clipMax > 0 && maxAbs > clipMax * 0.6) return "bad";
    return "ok";
  }
  return null;
}

// Largest |steering| over the whole clip (what a "big swing" is measured against)
function steerClipMax() {
  let m = 0;
  try {
    const ch = telemetryRef && telemetryRef.series() && telemetryRef.series().ch.steer;
    if (ch) for (const x of ch.v) { const a = Math.abs(x); if (a > m) m = a; }
  } catch (_) {}
  return m;
}

// Contexts the MEASURED channels contradict (steering, brake, acceleration — each used when the clip has it).
// Returns [{ ctx, msg }]. Only clear contradictions count; the noise band never flags anything.
function telemetryContextProblems(contexts, sc, clipMax) {
  const w = sc && sc.extras && sc.extras.window;
  if (!w || !Array.isArray(contexts)) return [];
  const out = [];
  const add = (c, msg) => { if (contexts.includes(c)) out.push({ ctx: c, msg }); };
  const su = w.steerUnit === "°" ? "°" : " " + (w.steerUnit || "deg");
  const sRange = w.steerMin != null ? `${w.steerMin} … ${w.steerMax}${su}` : "";
  const bigSwing = w.steerMin != null && steerVerdict("Lane keeping & centering", w, clipMax) === "bad";
  const quiet = w.steerMin != null && steerVerdict("Lane change left", w, clipMax) === "bad";
  const braked = w.brakeMax != null && w.brakeMax >= 0.1;
  const hardAccel = w.accelMin != null && (w.accelMin <= -1.5 || w.accelMax >= 1.5);
  if (bigSwing) add("Consistent driving", `"Consistent driving" but the steering angle swung widely (${sRange}) — that is more than steady driving`);
  if (braked) add("Consistent driving", `"Consistent driving" but the brake pedal was applied (peak ${w.brakeMax}${w.brakeUnit === "%" ? "%" : " " + (w.brakeUnit || "")})`);
  if (hardAccel) add("Consistent driving", `"Consistent driving" but acceleration reached ${w.accelMin} … ${w.accelMax} ${w.accelUnit || "m/s²"} — a strong speed change`);
  if (quiet) {
    add("Lane change", `"Lane change" but the steering angle stayed in ${sRange} — no measurable lane change`);
    add("Curvy road", `"Curvy road" but the steering angle stayed in ${sRange} — no measurable curve`);
  }
  const down = accelVerdictFor("Decelerate", w);
  if (down && down.ok === false) {
    add("Slow for the lead vehicle", `"Slow for the lead vehicle" needs a slow-down, but ${down.text.replace(/^Acceleration:\s*/, "acceleration ").replace(/ — contradicts.*$/, "")}`);
    add("Stop for the lead vehicle", `"Stop for the lead vehicle" needs a slow-down, but ${down.text.replace(/^Acceleration:\s*/, "acceleration ").replace(/ — contradicts.*$/, "")}`);
  }
  return out;
}

// One "Context mismatch:" line out of the speed-based and the telemetry-based findings
function combineContextWarnings(speedWarn, problems) {
  const parts = [];
  if (speedWarn) parts.push(String(speedWarn).replace(/^Context mismatch:\s*/i, "").replace(/\.\s*$/, ""));
  for (const pr of problems || []) parts.push(pr.msg);
  return parts.length ? "Context mismatch: " + parts.join("; ") + "." : null;
}

// Plain-language telemetry facts for the AI reconcile step
function telemetryFacts(sc, clipMax) {
  const w = (sc && sc.extras && sc.extras.window) || {};
  const f = [];
  if (w.steerMin != null) {
    const su = w.steerUnit === "°" ? "°" : " " + (w.steerUnit || "deg");
    const r = `${w.steerMin} to ${w.steerMax}${su}`;
    if (steerVerdict("Lane keeping & centering", w, clipMax) === "bad") f.push(`STEERING swung widely (${r}): far more than lane-keeping corrections, so a turn, lane change, lane split/merge, nudge or other lateral movement really happened. "Lane keeping & centering" and "Consistent driving" are WRONG.`);
    else if (steerVerdict("Lane change left", w, clipMax) === "bad") f.push(`STEERING stayed quiet (${r}): no turn or lane change happened, so lane changes, turns, nudges and pull-overs are WRONG. EXCEPTION (official rule): "Merge / split (facility change)" stays valid when ego approaches a merge or split and simply keeps its lane; if the Description / Causal Action describe a merge or split, keep that maneuver and do NOT switch to "Lane keeping & centering".`);
    else f.push(`STEERING moved moderately (${r}): inconclusive.`);
  }
  if (w.brakeMax != null) f.push(w.brakeMax >= 0.1 ? "BRAKE pedal was applied: ego slowed or stopped on purpose." : "BRAKE pedal was not used.");
  if (w.accelMin != null) f.push(`ACCELERATION ranged ${w.accelMin} to ${w.accelMax} ${w.accelUnit || "m/s²"}.`);
  if (sc && sc.suggestion) f.push(`SPEED change over the window: ${sc.suggestion}.`);
  return f;
}

const RECONCILE_SCHEMA = {
  type: "OBJECT",
  properties: {
    maneuverLabel: enumOf(VLA.MANEUVERS),
    suggestedContexts: { type: "ARRAY", items: enumOf(VLA.CONTEXTS.map((c) => c.value)) },
    reasoning: { type: "STRING" }
  },
  required: ["maneuverLabel", "suggestedContexts", "reasoning"]
};

// The suggested Maneuver and Contexts must agree with the measured telemetry. When the AI's draft contradicts
// it (e.g. "Lane keeping" while the steering swung widely, "Consistent driving" while braking), the draft is
// corrected: first by asking the model again WITH the telemetry facts, and if that fails or is still
// contradicted, by removing the contradicted contexts in code. Never throws.
async function reconcileWithTelemetry(res, ctx, sc) {
  const p = res && res.predictedManeuver;
  if (!p || !sc || !sc.extras || !sc.extras.window) return;
  const clipMax = steerClipMax();
  const w = sc.extras.window;
  const manBad = !!p.maneuverLabel && steerVerdict(p.maneuverLabel, w, clipMax) === "bad";
  const flagged = (list) => telemetryContextProblems(list, sc, clipMax).map((x) => x.ctx);
  const ctxBad = flagged(p.suggestedContexts || []);
  if (!manBad && !ctxBad.length) return;

  const facts = telemetryFacts(sc, clipMax);
  const keepOk = (r) => {
    if (!r || !VLA.MANEUVERS.includes(r.maneuverLabel)) return null;
    const cs = (Array.isArray(r.suggestedContexts) ? r.suggestedContexts : []).filter((c) => VLA.CONTEXTS.some((x) => x.value === c));
    if (steerVerdict(r.maneuverLabel, w, clipMax) === "bad" || flagged(cs).length) return null;
    // a wide steering swing means a lateral maneuver: the corrected pick must be one
    if (steerVerdict("Lane keeping & centering", w, clipMax) === "bad" && !LATERAL_MANEUVERS.includes(r.maneuverLabel)) return null;
    return { maneuverLabel: r.maneuverLabel, suggestedContexts: cs, reasoning: String(r.reasoning || "") };
  };
  let fixed = null;
  try {
    const req = {
      system: "You correct the Maneuver and Context suggestions of a driving-clip annotation so they agree with the measured vehicle telemetry. Telemetry is ground truth and OVERRIDES the text and your earlier draft. Choose exactly one Maneuver from the allowed list and any fitting Contexts from the allowed list. Keep the maneuver closest to what the Description and Causal Action describe among those the telemetry allows. Do not write numbers in the reasoning.",
      text: JSON.stringify({
        description: ctx.box1Text, causal_action: ctx.box2Text,
        earlier_draft: { maneuver: p.maneuverLabel, contexts: p.suggestedContexts, reasoning: p.reasoning },
        annotator_selected: { maneuver: ctx.userManeuver, contexts: ctx.userContexts },
        telemetry_facts: facts
      }),
      schema: RECONCILE_SCHEMA,
      timeoutMs: 30000,
      maxTokens: 1500
    };
    fixed = keepOk(await cachedGemini(["reconcile", ctx.box1Text, ctx.box2Text, p.maneuverLabel, p.suggestedContexts, facts], req));
  } catch (_) { fixed = null; }

  if (fixed) {
    p.maneuverLabel = fixed.maneuverLabel;
    p.suggestedContexts = fixed.suggestedContexts;
    if (fixed.reasoning) p.reasoning = fixed.reasoning;
    return;
  }
  // Fallback in code: drop the contradicted contexts (the maneuver stays flagged through its own warning)
  const drop = new Set(ctxBad);
  p.suggestedContexts = (p.suggestedContexts || []).filter((c) => !drop.has(c));
}

// Brake pedal applied during the measured window while "Accelerate" is selected.
function brakeAccelWarning(userSpeed, sc) {
  if (!sc || !sc.extras || !sc.extras.window || !userSpeed || userSpeed === "Auto") return null;
  const w = sc.extras.window;
  if (w.brakeMax == null || w.brakeMax < 0.02) return null; // 2% pedal or less is noise
  if (userSpeed !== "Accelerate") return null;
  const unit = w.brakeUnit === "%" ? "%" : " " + (w.brakeUnit || "");
  return `Selected Speed Change is "Accelerate", but the brake pedal was applied in the measured window (peak ${w.brakeMax}${unit}).`;
}

// Selected maneuver vs the measured steering angle across the measured window.
function steerManeuverWarning(userManeuver, sc) {
  if (!sc || !sc.extras || !sc.extras.window || !userManeuver || userManeuver === "Auto") return null;
  const w = sc.extras.window;
  if (w.steerMin == null || w.steerMax == null) return null;
  let clipMax = 0;
  try {
    const ch = telemetryRef && telemetryRef.series() && telemetryRef.series().ch.steer;
    if (ch) for (const v of ch.v) { const a = Math.abs(v); if (a > clipMax) clipMax = a; }
  } catch (_) {}
  const unit = w.steerUnit === "°" ? "°" : " " + (w.steerUnit || "deg");
  const range = `steering angle stayed in ${w.steerMin} to ${w.steerMax}${unit}`;
  const v = steerVerdict(userManeuver, w, clipMax);
  if (v === "bad" && LATERAL_MANEUVERS.includes(userManeuver)) {
    return `Selected Maneuver is "${userManeuver}" (a lateral maneuver), but the measured ${range} — within normal lane-keeping range, no turn or lane change in the measured window. The maneuver tag may not match the clip.`;
  }
  if (v === "bad" && userManeuver === "Lane keeping & centering") {
    return `Selected Maneuver is "Lane keeping & centering", but the measured ${range} across the measured window — a large swing for this clip.`;
  }
  return null;
}

// Description claims ego is stopped, but the measured speed in the 2 s before the action point
// never came near a stop. Only ego-stopped claims count ("a stopped vehicle ahead" is fine).
function stoppedClaimWarning(box1Text, sc) {
  if (!sc || !sc.history || !box1Text) return null;
  const w = sc.history;
  if (w.speedMin == null || w.speedMin <= 0.5) return null;
  if (!/\bego\b[^.]{0,60}?\bstop(?:ped)?\b(?!\s+(?:vehicle|truck|pickup))|\bego\b[^.]{0,60}?\b(?:stationary|standstill|halted)\b/i.test(box1Text)) return null;
  return `The Description says ego is stopped, but the measured speed in the 2 seconds before the action point stayed between ${w.speedMin} and ${w.speedMax} m/s — ego was still rolling.`;
}

async function auditText({ withSpeed = true } = {}) {  // every compliance check (button, shortcut, context menu, auto) measures speed first
  if (state.busy) return;
  const ctx = {
    box1Text: $("box1-input").value.trim(),
    box2Text: $("box2-input").value.trim(),
    userManeuver: $("user-maneuver").value || "Auto",
    userSpeed: $("user-speed").value || "Auto",
    userContexts: getSelectedContexts()
  };

  if (!ctx.box1Text && !ctx.box2Text) {
    notify("Enter or fetch a Description / Causal Action first.");
    return;
  }

  // NOTE: The local pre-check optimization block was removed here to allow 
  // the AI to review and rewrite text that violates local rules (e.g., >50 words).

  const isGroq = isGroqModel(state.model);
  if ((isGroq && !state.groqKey && !state.groqKey2) || (!isGroq && !state.key && !state.key2)) {
    setSettingsVisibility(true);
    return;
  }

  state.busy = true;
  $("audit-btn").textContent = "Analyzing...";
  setUIState(true);
  notify("");
  $("output").innerHTML = `<div class="card skeleton-loader">Evaluating VLA Compliance... ⏳</div>`;

  try {
    const tTotal = performance.now();
    const tab = await getActiveTab().catch(() => null);
    const auditTab = tab ? { id: tab.id, url: stripHash(tab.url) } : null;

    // Action point check (rendered just before the Description results): a passive, non-seeking
    // read of the page's own action-point label. The decision frame must not be less than frame 21
    // (2 seconds into the clip at 10 fps); anything earlier is flagged. When the page can't be read
    // here (no access, player not ready), the speed measurement's action point is the fallback below.
    let apReading = null;
    try {
      const ps = readPageStateRef ? await readPageStateRef() : null;
      if (ps && (ps.dp != null || ps.ready)) apReading = { dp: ps.dp != null ? ps.dp : null, total: ps.total != null ? ps.total : null };
    } catch (_) {}

    // The speed measurement (seeks the video) and the AI call (network only) run AT THE SAME TIME.
    // The AI reviews the text and labels; the speed numbers are applied in code afterwards.
    // Review mode = read-only clips AND /review/ pages. There the playhead is never moved: the
    // reading comes from the clip's own telemetry API (no seek), with the seek-based reading only
    // as a fallback when the clip record has no usable speed data. "Disable speed check in review
    // mode" (Settings) turns the review-mode measurement off entirely.
    // NOTE: state.isReadOnly is only set after a successful page fetch, so the URL is checked too —
    // an audit run before the first fetch on a /review/ page must not seek either.
    const reviewPage = !!(auditTab && auditTab.url && /\/review\/[\w-]/.test(auditTab.url));
    const roMode = state.isReadOnly || reviewPage;
    const speedCheckEnabled = withSpeed && !(roMode && state.speedCheckReviewOff);
    let speedP = Promise.resolve({ speedCheck: null, unavailable: false, note: "" });
    if (speedCheckEnabled) {
      const memo = speedMemo;
      if (memo && auditTab && memo.url === auditTab.url && memo.userSpeed === ctx.userSpeed) {
        // same clip + same selected Speed Change as the run that already measured it: reuse that reading
        speedP = Promise.resolve({ speedCheck: memo.speedCheck, unavailable: !!memo.unavailable, note: "" });
      } else {
        speedP = (async () => {
          const t = performance.now();
          let sr, seekFallback = false;
          if (roMode) {
            sr = await measureSpeedForAudit({ noSeek: true });
            if (!sr || !sr.ok) { seekFallback = true; sr = await measureSpeedForAudit(); } // no telemetry in the clip record → seek after all
          } else {
            sr = await measureSpeedForAudit();
          }
          const sc = speedCtxFrom(sr, ctx.userSpeed);
          const noTelemetry = /no telemetry/i.test((sr && sr.msg) || "");
          let note = "";
          if (!sc && !noTelemetry) note = `Speed check skipped: ${sr && sr.msg ? sr.msg : "no reading"} Your selected Speed Change was kept.`;
          if (sc && seekFallback) note = "Read by seeking the playhead: the clip's own record had no usable speed data.";
          if (auditTab && (sc || noTelemetry)) speedMemo = { url: auditTab.url, userSpeed: ctx.userSpeed, speedCheck: sc, unavailable: !sc };
          perfLog("speed check", performance.now() - t);
          return { speedCheck: sc, unavailable: !sc, note };
        })().catch(() => ({ speedCheck: null, unavailable: true, note: "" }));
      }
    }

    const auditReq = {
      system: Prompts.getAuditSystemInstruction(),
      text: Prompts.getAuditUserPrompt(ctx), // ctx has no speed data here: the cache key stays stable
      schema: AUDIT_SCHEMA,
      timeoutMs: 60000,
      maxTokens: 3000 // the default (600) was eaten by hidden thinking and cut the JSON off
    };
    const auditWasCached = await hasCachedGemini(["audit", ctx], auditReq);
    const tAI = performance.now();
    const aiP = cachedGemini(["audit", ctx], auditReq)
      .then((v) => ({ v }), (e) => ({ e }))
      .finally(() => perfLog("AI call" + (auditWasCached ? " (cached)" : ""), performance.now() - tAI));
    const [aiOut, sp] = await Promise.all([aiP, speedP]);
    if (aiOut.e) throw aiOut.e;
    const raw = aiOut.v;

    const speedNote = sp.note;
    ctx.speedCheck = sp.speedCheck || null;
    if (sp.unavailable) ctx.speedUnavailable = true;
    // No speed reading: still use whatever other channels the clip has (steering is almost always there)
    if (!ctx.speedCheck && speedCheckEnabled) {
      const dpForTele = apReading && apReading.dp != null ? apReading.dp : null;
      const part = await partialTelemetryFor(dpForTele);
      if (part) ctx.partialTelemetry = part;
    }
    // Fallback for the action-point check: when the passive read above couldn't see the page,
    // the speed measurement (which seeks to the action point) knows its frame.
    if (!apReading && sp.speedCheck && sp.speedCheck.actionPoint != null) {
      apReading = { dp: sp.speedCheck.actionPoint, total: sp.speedCheck.totalFrames != null ? sp.speedCheck.totalFrames : null };
    }
    ctx.actionPoint = apReading; // null = page unreadable: no action-point card in the results

    const res = normalizeAudit(structuredClone(raw), ctx);
    const mismatch = speedMismatchWarning(ctx.userSpeed, ctx.speedCheck);
    if (mismatch && ctx.speedCheck) {
      // The measurement is the truth, the selected label is what is wrong. The AI did not see the speed, so drop any
      // Causal Action warning that blames the verb for disagreeing with the (wrong) selected label.
      const sel = String(ctx.userSpeed).toLowerCase();
      const before = res.box2.warnings.length;
      res.box2.warnings = res.box2.warnings.filter((w) => {
        const t = String(w).toLowerCase();
        return !(/speed change|selected/.test(t) && /contradict|disagree|mismatch|conflict|match/.test(t) && t.includes(sel) && !/measured|telemetry/.test(t));
      });
      if (before && !res.box2.warnings.length) res.box2.suggestions = []; // those rewrites only chased the wrong label
      res.box2.hasIssues = res.box2.warnings.length > 0;
    }
    if (ctx.speedCheck) {
      // Verb vs measured speed (code-level)
      const vw = verbSpeedWarning(ctx.box2Text, ctx.speedCheck);
      if (vw) { res.box2.warnings.push(vw); res.box2.hasIssues = true; }
      // Telemetry always wins in the suggested versions: fix any suggestion whose verb contradicts the measured speed
      res.box2.suggestions = [...new Set(res.box2.suggestions.map((s) => telemetryFirstText(s, ctx.speedCheck)))];
    }
    if (ctx.speedUnavailable) {
      // No telemetry: the user's Speed Change stands, no speed-selection warnings from the model
      res.selectionWarnings = res.selectionWarnings.filter((w) => !/speed[- ]change/i.test(w));
    }
    if (mismatch) res.selectionWarnings.unshift(mismatch);
    const teleSc = ctx.speedCheck || ctx.partialTelemetry || null; // speed-independent channels work either way
    const cw = combineContextWarnings(
      contextSpeedWarning(ctx.userContexts, ctx.speedCheck),
      telemetryContextProblems(ctx.userContexts, teleSc, steerClipMax()));
    if (cw) res.selectionWarnings.push(cw);
    // Telemetry cross-checks (acceleration / steering / brake channels, no AI needed)
    const bw = brakeAccelWarning(ctx.userSpeed, teleSc);
    if (bw) res.selectionWarnings.push(bw);
    const stw = steerManeuverWarning(ctx.userManeuver, teleSc);
    if (stw) res.selectionWarnings.push(stw);
    const scw = stoppedClaimWarning(ctx.box1Text, ctx.speedCheck);
    if (scw) { res.box1.warnings.push(scw); res.box1.hasIssues = true; }
    // One problem = one warning: keep the first selection warning per topic (the code-level ones win)
    { const seenTopics = new Set();
      res.selectionWarnings = res.selectionWarnings.filter((w) => {
        const t = topicOfWarning(w); // classifies the code-level speed/context warnings too
        if (!t) return true;
        if (seenTopics.has(t)) return false;
        seenTopics.add(t);
        return true;
      }); }
    if (ctx.speedCheck && res.predictedManeuver && VLA.SPEEDS.includes(ctx.speedCheck.suggestion)) {
      res.predictedManeuver.suggestedSpeedChange = ctx.speedCheck.suggestion; // measured beats predicted
    }
    if (ctx.speedUnavailable && res.predictedManeuver && ctx.userSpeed !== "Auto" && VLA.SPEEDS.includes(ctx.userSpeed)) {
      res.predictedManeuver.suggestedSpeedChange = ctx.userSpeed; // no telemetry: the user's choice stands
    }
    // Telemetry always has the last word on the suggested Maneuver / Contexts
    if (res.predictedManeuver && (ctx.speedCheck || ctx.partialTelemetry)) {
      await reconcileWithTelemetry(res, ctx, ctx.speedCheck || ctx.partialTelemetry);
    }
    perfLog("audit total", performance.now() - tTotal);
    state.auditTab = auditTab;
    state.last = { res, ctx };
    renderResults(res, ctx);
    refreshActionPointUI();
    if (speedNote) notify(escapeHTML(speedNote));
    persist();
    updateBadge();
    if (!auditWasCached) recordAuditEvent(res, ctx); // cached re-checks are not counted twice
  } catch (e) {
    $("output").innerHTML = `<div class="card warning">${escapeHTML(e.message)}</div>`;
  } finally {
    state.busy = false;
    $("audit-btn").textContent = AUDIT_LABEL;
    setUIState(false);
  }
}

/* ====================================================================
 * Applying text / metrics
 * ==================================================================== */
function warningHtml(items, tools = "") {
  return `<div class="warning${tools ? " has-tools" : ""}">${tools ? `<div class="warn-tools">${tools}</div>` : ""}<strong>⚠️ Violations:</strong><ul>${items.map((w) => `<li>${escapeHTML(w)}</li>`).join("")}</ul></div>`;
}

/* ---- Tools in the top-right corner of a violation rectangle ----
 * 💬 opens the AI chat pre-filled with a question about the flagged violation(s);
 * ✕ dismisses them (the text is marked compliant). Rendered by warningHtml(),
 * wired once per render in renderResults(). */
function discussToolHtml(id) {
  return `<button type="button" class="warn-tool-btn" id="discuss-${id}" title="Discuss in the AI chat" aria-label="Discuss in the AI chat">💬</button>`;
}
function dismissToolHtml(id) {
  return `<button type="button" class="warn-tool-btn" id="dismiss-${id}" title="Dismiss suggestion (mark the text compliant)" aria-label="Dismiss suggestion (mark the text compliant)">✕</button>`;
}

// Replaces the violation rectangle with the green compliant block and clears the field's
// warnings, so the badge count and the restored session agree with the dismissal.
function dismissFieldWarnings(field) {
  const status = $(`${field}-status`);
  if (status) status.innerHTML = `<div class="success"><span>✓</span> <strong>100% Compliant Text</strong> <span class="muted-label">(violations dismissed)</span></div>`;
  const res = state.last?.res;
  if (res && res[field]) {
    res[field].warnings = [];
    res[field].hasIssues = false;
  }
  const ctx = state.last?.ctx;
  const original = ctx ? ctx[field === "box1" ? "box1Text" : "box2Text"] : "";
  if (original && state.trusted[field]) state.trusted[field].add(original.trim());
  persistSoon();
  updateBadge();
}

/* ====================================================================
 * Audit statistics (📊 view) + per-clip audit log (🕘 card)
 * An "attempt" = one clip's audits from its first audit until it comes
 * back clean; first-pass compliance counts attempts that were clean
 * immediately. Everything lives in chrome.storage.local, this browser only.
 * ==================================================================== */
const STATS_KEY = "vla_audit_stats";
const CLIP_LOG_KEY = "vla_clip_log";
const SEEN_KEY = "vla_clip_seen";   // url -> { t, a } (a = has been audited) — "opened" entries are written by background.js on navigation
const OPENS_KEY = "vla_opens_daily"; // day "YYYY-MM-DD" -> { url: 1 } — unique clip URLs NAVIGATED to per day (written by background.js, not by fetch)
const STATS_MAX = 2000;   // events kept
const STATS_DAYS = 90;    // days kept
const CLIP_LOG_PER_CLIP = 5;
let statsRange = "7d";   // active statistics filter: "today" | "7d" | "30d" | "all"
let statsCat = "all";   // active category filter: "all" | "desc" | "causal" | "man" | "spd" | "ctx" | "gram"

const pad2 = (n) => String(n).padStart(2, "0");
const todayStr = (d = new Date()) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
const timeStr = (t) => { const d = new Date(t); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
// Fixed concise labels for recurring rule names — complete phrases, never cut off:
const RULE_ALIASES = [
  [/reason must use/i, "Reason must use because/due to"],
];
const ruleAlias = (s) => { for (const a of RULE_ALIASES) if (a[0].test(s)) return a[1]; return ""; };
const ruleShort = (w) => {
  const s0 = String(w || "").replace(/^\[Local check\]\s*/i, "");
  const alias = ruleAlias(s0); // a known rule gets its fixed label straight away
  if (alias) return alias;
  const s = s0;
  let head = (s.split(/:|\u2014/)[0] || s).trim();
  const cut = head.indexOf(". ");          // keep only the first sentence
  if (cut > 0) head = head.slice(0, cut);
  head = head.replace(/\.$/, "");
  const tail = head.search(/,|;|\s['"\u201c\u2018]/); // drop list tails like 'because', 'due to', ...
  if (tail > 8) head = head.slice(0, tail).trim();
  const m = head.match(/\s+(?:using|via|such as|rather than|instead of|without|must be|should be|e\.g\.)/i);
  if (m && m.index > 10) head = head.slice(0, m.index).trim(); // keep only the leading phrase
  head = head.replace(/[\u2018\u2019'"]+$/, "").trim(); // never end on a dangling quote
  return head || "Other";
};
// Shortens already-stored rule names for display. Legacy entries saved by older versions
// were chopped at 34 chars, mid-word: the trailing fragment is dropped. A label is
// NEVER shown cut off — no "…" is ever appended here.
const ruleDisplay = (r) => {
  let s = String(r || "").replace(/\u2026+$/, "").trim();
  const alias = ruleAlias(s); // a known rule gets its fixed label straight away
  if (alias) return alias;
  const cut = s.indexOf(". ");
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/\.$/, "");
  if (s.length >= 33) { // legacy 34-char cuts ended mid-word: drop the trailing fragment
    const sp = s.lastIndexOf(" ");
    if (sp > 16 && sp >= s.length - 5) s = s.slice(0, sp);
  }
  const tail = s.search(/,|;|\s['"\u201c\u2018]/); // same cuts as ruleShort
  if (tail > 8) s = s.slice(0, tail).trim();
  s = s.replace(/[\u2018\u2019'"]+$/, "").trim(); // never end on a dangling quote
  return s || "Other";
};

async function recordAuditEvent(res, ctx) {
  try {
    const url = state.auditTab?.url || "";
    if (!url || isRestrictedUrl(url)) return;
    const w1 = res.box1?.warnings || [];
    const w2 = res.box2?.warnings || [];
    const sw = res.selectionWarnings || [];
    const nb = w1.length + w2.length;
    const ns = sw.length;
    // Bulleted warning list for the clip log: one audit = ONE row, the warnings under it.
    const warns = [];
    if (ctx.box1Text) for (const w of w1) warns.push("Description: " + String(w));
    if (ctx.box2Text) for (const w of w2) warns.push("Causal Action: " + String(w));
    for (const w of sw) warns.push("Selection: " + String(w));
    const rules = [];
    for (const w of [...w1, ...w2]) {
      const r = ruleShort(w);
      if (r && !rules.includes(r)) rules.push(r);
    }

    // Per-category data: desc = Description box, causal = Causal Action box,
    // man = maneuver tag, spd = speed-change tag, ctx = context tags, gram = grammar/wording issues.
    // Selection warnings are split by wording: context words -> ctx, speed words -> spd, the rest -> man.
    const CTX_WORD_RX = /context|weather|rain|fog|snow|night|dusk|dawn|daylight|wind|visib|lighting|surface|wet|urban|rural|highway|intersection|traffic/i;
    const SPD_WORD_RX = /speed|decelerat|accelerat|maintain|stop|motion/i;
    const GRAM_WORD_RX = /grammar|spelling|typo|punctuat|capital|tense|plural|articl\w*\b|wording|phras|concise|redundan|repetit|passive|readab/i;
    const manSel = [];
    const spdSel = [];
    const ctxSel = [];
    for (const w of sw) {
      if (CTX_WORD_RX.test(String(w))) ctxSel.push(w);
      else if (SPD_WORD_RX.test(String(w))) spdSel.push(w);
      else manSel.push(w);
    }

    const sameSet = (a, b) => a.length === b.length && a.every((c) => b.includes(c));
    const userAuto = ctx.userContexts.length === 1 && ctx.userContexts[0] === "Auto";
    const p = res.predictedManeuver;
    // A selection left on "Auto" is unset: predicted, not criticised -> exempt from mismatch counting
    const manOk = !p || ctx.userManeuver === "Auto" || (!!p.maneuverLabel && ctx.userManeuver === p.maneuverLabel);
    const spdOk = !p || ctx.userSpeed === "Auto" || (!!p.suggestedSpeedChange && ctx.userSpeed === p.suggestedSpeedChange);
    const ctxOk = !p || userAuto || sameSet(p.suggestedContexts || [], ctx.userContexts);

    const cats = {};
    const catRules = {};
    if (ctx.box1Text) {
      cats.desc = { n: w1.length, clean: w1.length === 0 };
      catRules.desc = [...new Set(w1.map(ruleShort))];
    }
    if (ctx.box2Text) {
      cats.causal = { n: w2.length, clean: w2.length === 0 };
      catRules.causal = [...new Set(w2.map(ruleShort))];
    }
    const manN = (p ? (manOk ? 0 : 1) : 0) + manSel.length;
    if (p || manSel.length) {
      cats.man = { n: manN, clean: manN === 0 };
      const mr = manSel.map(ruleShort);
      if (p && !manOk) mr.push("Maneuver");
      catRules.man = [...new Set(mr)];
    }
    const spdN = (p ? (spdOk ? 0 : 1) : 0) + spdSel.length;
    if (p || spdSel.length) {
      cats.spd = { n: spdN, clean: spdN === 0 };
      const sr = spdSel.map(ruleShort);
      if (p && !spdOk) sr.push("Speed change");
      catRules.spd = [...new Set(sr)];
    }
    const ctxN = (p ? (ctxOk ? 0 : 1) : 0) + ctxSel.length;
    if (p || ctxSel.length) {
      cats.ctx = { n: ctxN, clean: ctxN === 0 };
      const cr = ctxSel.map(ruleShort);
      if (p && !ctxOk) cr.push("Context(s)");
      catRules.ctx = [...new Set(cr)];
    }
    const gramWarns = [...w1, ...w2].filter((w) => GRAM_WORD_RX.test(String(w)));
    if (cats.desc || cats.causal) {
      cats.gram = { n: gramWarns.length, clean: gramWarns.length === 0 };
      catRules.gram = [...new Set(gramWarns.map(ruleShort))];
    }

    const ev = { t: Date.now(), d: todayStr(), clip: url, clean: nb + ns === 0, nb, ns, rules, cats, catRules, warns: warns.slice(0, 8) };

    const st = (await chrome.storage.local.get(STATS_KEY).catch(() => ({}))) || {};
    const events = Array.isArray(st[STATS_KEY]?.events) ? st[STATS_KEY].events : [];
    // Each URL counts ONCE in the stats: only the first time it is checked is recorded.
    // Re-checking the same clip (Check Compliance pressed again) never adds a second event.
    if (!events.some((e) => e.clip === url)) {
      events.push(ev);
      const cutoff = Date.now() - STATS_DAYS * 86400000;
      await chrome.storage.local.set({ [STATS_KEY]: { events: events.filter((e) => (e.t || 0) >= cutoff).slice(-STATS_MAX) } });
    }

    const log = (await chrome.storage.local.get(CLIP_LOG_KEY).catch(() => ({}))) || {};
    const byClip = (log[CLIP_LOG_KEY] && typeof log[CLIP_LOG_KEY] === "object") ? log[CLIP_LOG_KEY] : {};
    const mine = Array.isArray(byClip[url]?.events) ? byClip[url].events : [];
    // One audit = ONE row: re-running the SAME audit (identical findings) only refreshes the
    // newest row's time; it never adds a duplicate row. A changed result adds a new row.
    const sig = (e) => JSON.stringify([e.clean, e.nb, e.ns, e.rules, e.warns]);
    const lastEv = mine[mine.length - 1];
    if (lastEv && sig(lastEv) === sig(ev)) { lastEv.t = ev.t; lastEv.d = ev.d; }
    else mine.push(ev);
    byClip[url] = { events: mine.slice(-CLIP_LOG_PER_CLIP) };
    const keys = Object.keys(byClip);
    if (keys.length > 300) { // keep the newest 300 clips
      keys.sort((a, b) => (((byClip[b].events || []).at(-1) || {}).t || 0) - (((byClip[a].events || []).at(-1) || {}).t || 0));
      for (const k of keys.slice(300)) delete byClip[k];
    }
    await chrome.storage.local.set({ [CLIP_LOG_KEY]: byClip });

    markClipSeen(url, true);

    renderClipLog(url);
    if (!$("stats-view").hidden) renderStats();
  } catch (_) {}
}

// Marks a clip URL as audited ("a" flips to true on its first audit). The "opened"
// entries themselves are written by background.js when the URL is navigated to.
async function markClipSeen(url, audited) {
  try {
    if (!url || isRestrictedUrl(url)) return;
    const st = (await chrome.storage.local.get(SEEN_KEY).catch(() => ({}))) || {};
    const seen = (st[SEEN_KEY] && typeof st[SEEN_KEY] === "object") ? st[SEEN_KEY] : {};
    seen[url] = { t: Date.now(), a: !!audited || !!(seen[url] && seen[url].a) };
    const keys = Object.keys(seen);
    if (keys.length > 1000) { // keep the newest 1000 clips
      keys.sort((x, y) => (seen[x].t || 0) - (seen[y].t || 0));
      for (const k of keys.slice(0, keys.length - 1000)) delete seen[k];
    }
    await chrome.storage.local.set({ [SEEN_KEY]: seen });
  } catch (_) {}
}

// Recent-audits list: one row per audit — the time on the left, ALL of its warnings combined into
// ONE meaningful sentence on the right, AI-written and cached. "Details" holds the full texts.
const firstSentence = (w) => {
  const t = String(w || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^[\s\S]*?[.!?]["'\u2019]?(?=\s+[A-Z"'\u201c\u0028]|\s*$)/);
  let s = m ? m[0].trim() : t;
  if (s.length > 160) s = s.slice(0, 157).replace(/\s+\S*$/, "") + "…";
  return s;
};

const WARN_SUMMARY_KEY = "vla_warn_summaries"; // warnings-signature -> { s, t } — cached AI summaries
const SUMMARY_SCHEMA = { type: "OBJECT", properties: { summary: { type: "STRING" } }, required: ["summary"] };

// Asks the AI for ONE meaningful sentence covering the given warnings.
// Cached in storage by the warnings signature, so an unchanged set of warnings costs no request.
async function summarizeWarnings(warns) {
  const sig = JSON.stringify(warns);
  const st = (await chrome.storage.local.get(WARN_SUMMARY_KEY).catch(() => ({}))) || {};
  const cache = (st[WARN_SUMMARY_KEY] && typeof st[WARN_SUMMARY_KEY] === "object") ? st[WARN_SUMMARY_KEY] : {};
  if (cache[sig] && cache[sig].s) return cache[sig].s;
  const r = await callGemini({
    system: "You summarize VLA annotation audit warnings for a data annotator. Reply with the summary sentence only.",
    text: "Summarize these audit warnings into ONE short meaningful sentence of at most 25 words that names the main problems. Warnings:\n- " + warns.join("\n- "),
    schema: SUMMARY_SCHEMA,
    model: state.chatModel,
    maxTokens: 300
  });
  const s = String((r && r.summary) || "").replace(/^["'\u201c\s]+|["'\u201d\s]+$/g, "").split("\n")[0].trim() || firstSentence(warns[0]);
  cache[sig] = { s, t: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > 50) {
    keys.sort((a, b) => (cache[a].t || 0) - (cache[b].t || 0));
    for (const k of keys.slice(0, keys.length - 50)) delete cache[k];
  }
  await chrome.storage.local.set({ [WARN_SUMMARY_KEY]: cache }).catch(() => {});
  return s;
}

async function renderClipLog(url) {
  const el = $("clip-audit-history");
  if (!el) return;
  if (!url || isRestrictedUrl(url)) { el.hidden = true; el.innerHTML = ""; return; }
  const log = (await chrome.storage.local.get(CLIP_LOG_KEY).catch(() => ({}))) || {};
  const byClip = (log[CLIP_LOG_KEY] && typeof log[CLIP_LOG_KEY] === "object") ? log[CLIP_LOG_KEY] : {};
  const evs = (Array.isArray(byClip[url]?.events) ? byClip[url].events : []).slice(-4).reverse();
  if (!evs.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = '<h4 class="card-title">🕘 Recent audits on this clip</h4>';

  // One row per audit: the time stays on the left, the warnings share ONE combined sentence next
  // to it — no per-warning bullets and no count text on the right any more.
  const seenW = new Set();
  const distinct = [];
  for (const e of evs) {
    const row = document.createElement("div");
    row.className = "clip-log-row";
    const t = document.createElement("span");
    t.className = "t";
    t.style.color = e.clean ? "var(--alert-success-text)" : "var(--alert-warning-text)";
    t.textContent = (e.clean ? "✓" : "⚠") + " " + timeStr(e.t);
    const s = document.createElement("span");
    s.className = "s";
    const warns = (Array.isArray(e.warns) ? e.warns : []).map((w) => String(w || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (e.clean || !warns.length) {
      s.textContent = "clean";
      s.style.color = "var(--text-muted)";
    } else {
      s.textContent = firstSentence(warns[0]); // fallback line until the AI combination arrives
      for (const w of warns) { const k = w.toLowerCase(); if (!seenW.has(k)) { seenW.add(k); distinct.push(w); } }
      summarizeWarnings(warns).then((txt) => {
        if (s.isConnected) s.textContent = txt; // stale rows are disconnected by re-renders
      }).catch(() => { /* keep the fallback line */ });
    }
    row.appendChild(t);
    row.appendChild(s);
    el.appendChild(row);
  }

  // Full texts, deduplicated across the shown audits, one click away
  if (distinct.length) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "action-btn";
    toggle.style.cssText = "margin-top:6px;";
    toggle.textContent = "▾ Details (" + distinct.length + ")";
    const det = document.createElement("div");
    det.hidden = true;
    det.style.marginTop = "4px";
    det.innerHTML = '<ul class="clip-log-warns">' + distinct.map((w) => {
      const short = firstSentence(w);
      if (short === w) return "<li>" + escapeHTML(short) + "</li>";
      return '<li style="cursor:pointer;" title="Click to show the full warning" data-short="' + escapeHTML(short) + '" data-full="' + escapeHTML(w) + '">' + escapeHTML(short) + "</li>";
    }).join("") + "</ul>";
    toggle.onclick = () => {
      det.hidden = !det.hidden;
      toggle.textContent = (det.hidden ? "▾" : "▴") + " Details (" + distinct.length + ")";
    };
    el.appendChild(toggle);
    el.appendChild(det);
  }

  // Click a truncated warning in the details to show its full text, click again to collapse
  el.onclick = (ev) => {
    const li = ev.target && ev.target.closest ? ev.target.closest("li[data-full]") : null;
    if (!li) return;
    const expanded = li.dataset.expanded === "1";
    li.textContent = expanded ? li.dataset.short : li.dataset.full;
    li.dataset.expanded = expanded ? "0" : "1";
  };
  el.hidden = false;
}
async function renderStats() {
  const el = $("stats-content");
  if (!el) return;
  const st = (await chrome.storage.local.get(STATS_KEY).catch(() => ({}))) || {};
  const events = Array.isArray(st[STATS_KEY]?.events) ? st[STATS_KEY].events : [];
  const now = Date.now();
  const DAY = 86400000;
  const today = todayStr();

  const rangeLabel = statsRange === "today" ? "today" : statsRange === "7d" ? "7 days" : statsRange === "30d" ? "30 days" : "all time";
  const catLabel = statsCat === "desc" ? "description" : statsCat === "causal" ? "causal action" : statsCat === "man" ? "maneuver tag" : statsCat === "spd" ? "speed change" : statsCat === "ctx" ? "context" : statsCat === "gram" ? "grammar" : "";
  const scopeLabel = (catLabel ? catLabel + " · " : "") + rangeLabel;
  const cutoff = statsRange === "7d" ? now - 7 * DAY : statsRange === "30d" ? now - 30 * DAY : 0;
  const inRange = (e) => (statsRange === "today" ? e.d === today : (e.t || 0) >= cutoff);

  // Project an event onto the active category (null = no data for it, e.g. older events)
  const evOf = (e) => {
    if (statsCat === "all") return { n: (e.nb || 0) + (e.ns || 0), clean: !!e.clean, rules: e.rules || [] };
    const c = e.cats && e.cats[statsCat];
    if (!c) return null;
    return { n: c.n || 0, clean: !!c.clean, rules: (e.catRules && e.catRules[statsCat]) || [] };
  };

  const ev = events.filter(inRange).map(evOf).filter(Boolean);
  const clips = new Set(events.filter(inRange).filter((e) => evOf(e)).map((e) => e.clip)).size;
  // Clips whose audit found any issue (unique by clip; the audited total is "clips" above)
  const issueClips = new Set(events.filter(inRange).filter((e) => { const p = evOf(e); return p && !p.clean; }).map((e) => e.clip)).size;

  // Unique clips opened but never audited (opening the same clip several times counts once)
  const seenSt = (await chrome.storage.local.get(SEEN_KEY).catch(() => ({}))) || {};
  const seen = (seenSt[SEEN_KEY] && typeof seenSt[SEEN_KEY] === "object") ? seenSt[SEEN_KEY] : {};
  const unaudited = Object.keys(seen).filter((k) => seen[k] && seen[k].a !== true).length;

  // Clips opened per day: unique links per day (audited or not). Each URL counts
  // once per day it was opened; the union below dedupes across the whole range.
  const openSt = (await chrome.storage.local.get(OPENS_KEY).catch(() => ({}))) || {};
  const openDays = (openSt[OPENS_KEY] && typeof openSt[OPENS_KEY] === "object") ? openSt[OPENS_KEY] : {};
  const rangeDays = statsRange === "today" ? 1 : statsRange === "7d" ? 7 : statsRange === "30d" ? 30 : 60;
  const openUrls = new Set();
  for (let i = rangeDays - 1; i >= 0; i--) {
    const u = openDays[todayStr(new Date(now - i * DAY))];
    if (u) for (const k of Object.keys(u)) openUrls.add(k);
  }
  const openedCount = openUrls.size;

  // Attempts: per clip, a new attempt starts at the first audit after "never" or after a clean one
  const last = {};
  const attempts = [];
  for (const e of [...events].sort((a, b) => (a.t || 0) - (b.t || 0))) {
    const pr = evOf(e);
    if (!pr) continue;
    const prev = last[e.clip];
    if (!prev || prev.clean) attempts.push({ t: e.t || 0, clean: pr.clean });
    last[e.clip] = pr;
  }
  const att = attempts.filter((a) => (statsRange === "today" ? new Date(a.t).toDateString() === new Date(now).toDateString() : a.t >= cutoff));
  const cleanAtt = att.filter((a) => a.clean).length;
  const score = att.length ? Math.round((100 * cleanAtt) / att.length) : null;

  // Summary numbers for the selected range and category
  const warns = ev.reduce((n, p) => n + p.n, 0);
  const cleans = ev.filter((p) => p.clean).length;
  const cleanRate = ev.length ? Math.round((100 * cleans) / ev.length) : 0;
  const avgWarn = ev.length ? warns / ev.length : 0;

  // 🦉 Duolingo-style nudges: based on unaudited clips and the first-pass score
  const pointerBits = [];
  if (unaudited >= 10) pointerBits.push("🦉 " + unaudited + " opened clips are still unaudited. They have formed a support group. They mention you often.");
  else if (unaudited >= 3) pointerBits.push("🦉 " + unaudited + " unaudited clips are giving the owl side-eye. One audit each and we never speak of this again.");
  if (score === null) pointerBits.push("🦉 No audits yet. The owl is watching. It is ALWAYS watching.");
  else if (score >= 90) pointerBits.push("🔥 " + score + "% first-pass — the owl checked twice. Suspiciously good.");
  else if (score >= 70) pointerBits.push("💪 " + score + "% first-pass. The owl will allow it. For now.");
  else if (score >= 40) pointerBits.push("😐 " + score + "% first-pass. The owl is inhaling slowly. Check before you submit, friend.");
  else pointerBits.push("🫠 " + score + "% first-pass. The owl has made tea. It's going to be a long session.");
  const pointer = '<div style="background:var(--bg-eval);border:1px solid var(--border-main);border-radius:6px;padding:8px 10px;margin-top:10px;font-size:12px;line-height:1.5;">' + pointerBits.join("<br>") + "</div>";

  const chip = (label, val) =>
    '<div style="background:var(--bg-secondary-btn);border-radius:4px;padding:6px 8px;min-width:0;">' +
    '<div style="font-size:14px;font-weight:700;color:var(--text-main);">' + val + "</div>" +
    '<div class="muted-label" style="font-size:10px;">' + label + "</div></div>";

  // Audits by time of day — same design as "Active hours", the only difference is the green bar color
  let chart = "";
  if (ev.length) {
    const H0 = 6, H1 = 21; // show 6am through 9pm only
    const hours = new Array(24).fill(0);
    for (const e of events.filter(inRange)) {
      if (evOf(e)) hours[new Date(e.t || 0).getHours()]++;
    }
    const shown = [];
    for (let h = H0; h <= H1; h++) shown.push(h);
    const maxH = Math.max(1, ...shown.map((h) => hours[h]));
    const hour12 = (h) => (h % 12 || 12) + (h < 12 ? "am" : "pm");
    chart = '<div style="margin-top:12px;"><span class="muted-label">Audits by time of day — green (6am–9pm)</span>' +
      '<div style="display:flex;align-items:flex-end;gap:1px;height:22px;margin-top:6px;">' +
      shown.map(function (h) {
        const n = hours[h];
        const hgt = n ? Math.max(3, Math.round((18 * n) / maxH)) : 2;
        return '<div title="' + hour12(h) + " — " + n + " audit" + (n === 1 ? "" : "s") + '" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:22px;">' +
          '<div style="height:' + hgt + 'px;background:' + (n ? "var(--alert-success-border)" : "var(--bg-pill-hover)") + ';border-radius:1px;"></div></div>';
      }).join("") + "</div>" +
      '<div style="display:flex;gap:1px;margin-top:2px;">' +
      shown.map(function (h) {
        return '<div style="flex:1;text-align:center;font-size:9px;color:var(--text-muted);white-space:nowrap;overflow:visible;">' + (h % 3 === 0 ? hour12(h) : "") + "</div>";
      }).join("") + "</div></div>";
  }

  // Active hours: audits by hour of day, 6am–9pm (the times you are actually working)
  let hoursChart = "";
  if (ev.length) {
    const H0 = 6, H1 = 21; // show 6am through 9pm only
    const hours = new Array(24).fill(0);
    for (const e of events.filter(inRange)) {
      if (evOf(e)) hours[new Date(e.t || 0).getHours()]++;
    }
    const shown = [];
    for (let h = H0; h <= H1; h++) shown.push(h);
    const maxH = Math.max(1, ...shown.map((h) => hours[h]));
    const hour12 = (h) => (h % 12 || 12) + (h < 12 ? "am" : "pm");
    hoursChart = '<div style="margin-top:12px;"><span class="muted-label">Active hours — audits by time of day (6am–9pm)</span>' +
      '<div style="display:flex;align-items:flex-end;gap:1px;height:22px;margin-top:6px;">' +
      shown.map(function (h) {
        const n = hours[h];
        const hgt = n ? Math.max(3, Math.round((18 * n) / maxH)) : 2;
        return '<div title="' + hour12(h) + " — " + n + " audit" + (n === 1 ? "" : "s") + '" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:22px;">' +
          '<div style="height:' + hgt + 'px;background:' + (n ? "var(--accent)" : "var(--bg-pill-hover)") + ';border-radius:1px;"></div></div>';
      }).join("") + "</div>" +
      '<div style="display:flex;gap:1px;margin-top:2px;">' +
      shown.map(function (h) {
        return '<div style="flex:1;text-align:center;font-size:9px;color:var(--text-muted);white-space:nowrap;overflow:visible;">' + (h % 3 === 0 ? hour12(h) : "") + "</div>";
      }).join("") + "</div></div>";
  }

  // Warnings by category (All view) — the rows are clickable filters
  let byCat = "";
  if (statsCat === "all" && ev.length) {
    const catNames = [["desc", "Description"], ["causal", "Causal Action"], ["man", "Maneuver tag"], ["spd", "Speed change"], ["ctx", "Context"], ["gram", "Grammar"]];
    const catWarns = {};
    const seenCat = new Set();
    let known = false;
    for (const e of events.filter(inRange)) {
      for (const k of ["desc", "causal", "man", "spd", "ctx", "gram"]) {
        const c = e.cats && e.cats[k];
        if (!c) continue;
        known = true;
        // One count per distinct problem per clip — re-auditing the same issue doesn't inflate it
        const cr = (e.catRules && e.catRules[k]) || [];
        const list = cr.length ? cr : (c.n > 0 ? ["(unspecified)"] : []);
        for (const r of list) {
          const kk = e.clip + "|" + k + "|" + ruleDisplay(r);
          if (seenCat.has(kk)) continue;
          seenCat.add(kk);
          catWarns[k] = (catWarns[k] || 0) + 1;
        }
      }
    }
    const maxW = Math.max(1, ...["desc", "causal", "man", "spd", "ctx", "gram"].map((k) => catWarns[k] || 0));
    if (known) {
      byCat = '<div style="margin-top:12px;"><span class="muted-label">Problems by category — click to filter</span>' +
        catNames.map(function (cn) {
          return '<div class="cat-filter-row" data-cat="' + cn[0] + '" title="Show only ' + cn[1] + '" style="margin-top:6px;font-size:12px;display:flex;align-items:baseline;gap:6px;cursor:pointer;">' +
            '<span style="flex:1;">' + cn[1] + "</span>" +
            '<span style="font-size:11px;color:var(--text-muted);">×' + (catWarns[cn[0]] || 0) + "</span></div>" +
            '<div style="height:4px;border-radius:2px;background:var(--bg-pill);margin-top:2px;">' +
            '<div style="height:4px;border-radius:2px;background:var(--accent);width:' +
            Math.max(4, Math.round((100 * (catWarns[cn[0]] || 0)) / maxW)) + '%;"></div></div>';
        }).join("") + "</div>";
    }
  }

  // Top issues: each problem counts once per clip (a re-audit of the same issue on the same clip doesn't inflate it)
  const rules = {};
  const seenRule = new Set();
  for (const e of events.filter(inRange)) {
    const pr = evOf(e);
    if (!pr) continue;
    for (const r0 of (pr.rules || [])) {
      const r = ruleDisplay(r0);
      const key = e.clip + "|" + r;
      if (seenRule.has(key)) continue;
      seenRule.add(key);
      rules[r] = (rules[r] || 0) + 1;
    }
  }
  const top = Object.entries(rules).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxR = top.length ? top[0][1] : 1;

  el.innerHTML = pointer +
    (!ev.length
      ? '<div class="hint-text">No audits in this range yet — audit a few clips and come back.</div>'
      : '<div style="text-align:center;margin:10px 0 4px;">' +
        '<div style="font-size:34px;font-weight:700;color:' +
        (score >= 80 ? "var(--alert-success-border)" : score >= 50 ? "#ca8a04" : "var(--alert-warning-border)") + ';">' +
        (score === null ? "—" : score + "%") + "</div>" +
        '<div class="hint-text" style="margin-top:0;">First-pass compliance (' + scopeLabel + ") — " +
        cleanAtt + " of " + att.length + " attempts clean on the first audit</div></div>" +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:10px;">' +
        chip("Clips opened", openedCount) +
        chip("Clips reviewed", clips) +
        chip("Clips with issues", issueClips + " / " + clips) +
        chip("Clean audits", cleans + " (" + cleanRate + "%)") +
        chip("Opened, not audited", unaudited) +
        chip("Avg warnings / audit", avgWarn.toFixed(1)) +
        "</div>" + chart + hoursChart + byCat +
        (top.length
          ? '<div style="margin-top:12px;"><span class="muted-label">Top issues — per clip (' + scopeLabel + ")</span>" +
            top.map(function (r) {
              return '<div style="margin-top:6px;font-size:12px;display:flex;align-items:baseline;gap:6px;">' +
                '<span style="flex:1;">' + escapeHTML(r[0]) + "</span>" +
                '<span style="font-size:11px;color:var(--text-muted);">×' + r[1] + "</span></div>" +
                '<div style="height:4px;border-radius:2px;background:var(--bg-pill);margin-top:2px;">' +
                '<div style="height:4px;border-radius:2px;background:var(--accent);width:' +
                Math.max(4, Math.round((100 * r[1]) / maxR)) + '%;"></div></div>';
            }).join("") + "</div>"
          : ""));

  // Clicking a "Warnings by category" row switches to that category filter
  el.querySelectorAll(".cat-filter-row").forEach((r) => {
    r.onclick = () => {
      statsCat = r.dataset.cat;
      const sel = $("stats-cat-select");
      if (sel) sel.value = statsCat;
      renderStats();
    };
  });
}

async function setStatsVisibility(show) {
  $("main-view").hidden = show;
  $("stats-view").hidden = !show;
  if (show) {
    $("settings-view").hidden = true;
    $("bookmarks-view").hidden = true;
    $("chat-view").hidden = true;
    $("calc-view").hidden = true;
    await renderStats();
  }
}

/* ====================================================================
 * Page apply history (Undo / Redo for text applied to the page)
 * Kept per clip URL; each entry is one action (Apply Both = one action).
 * ==================================================================== */
const HISTORY_KEY = "vla_page_history";
const HISTORY_MAX = 30;
const FIELD_NAME = { box1: "Description", box2: "Causal Action" };
let pageHistory = {};      // url -> { undo: [action], redo: [action] }; action = { entries: [{ field, before, after }] }
let batchCollector = null; // while Apply Both runs, both applies are collected into one action

const histFor = (url) => (pageHistory[url] ||= { undo: [], redo: [] });
const saveHistory = () => chrome.storage.session.set({ [HISTORY_KEY]: pageHistory }).catch(() => {});

async function loadHistory() {
  try {
    const r = await chrome.storage.session.get(HISTORY_KEY);
    if (r[HISTORY_KEY] && typeof r[HISTORY_KEY] === "object") pageHistory = r[HISTORY_KEY];
  } catch (_) { }
}

function recordApply(tab, field, before, after) {
  if (String(before ?? "").trim() === String(after).trim()) return; // nothing actually changed
  const entry = { field, before: before ?? "", after };
  if (batchCollector) {
    batchCollector.url = stripHash(tab.url);
    batchCollector.entries.push(entry);
    return;
  }
  pushAction(stripHash(tab.url), [entry]);
}

function pushAction(url, entries) {
  if (!entries.length) return;
  const h = histFor(url);
  h.undo.push({ entries });
  if (h.undo.length > HISTORY_MAX) h.undo.shift();
  h.redo = []; // a new apply invalidates the redo path
  saveHistory();
  updateHistoryButtons();
}

// Every write of text to the page goes through here so it can be undone.
async function applyToPage(field, text) {
  const { tab, response } = await callPage({ action: "APPLY_TEXT", field, text }, { sameTab: true });
  if (response && response.status === "SUCCESS") recordApply(tab, field, response.previous, text);
  return { tab, response };
}

async function updateHistoryButtons() {
  const tab = await getActiveTab().catch(() => null);
  const h = tab && !isRestrictedUrl(tab.url) ? pageHistory[stripHash(tab.url)] : null;
  const describe = (a) => a.entries.map((e) => FIELD_NAME[e.field] || e.field).join(" + ");
  const canUndo = !!(h && h.undo.length) && !state.isReadOnly;
  const canRedo = !!(h && h.redo.length) && !state.isReadOnly;
  const undoTitle = canUndo ? `Undo: restore ${describe(h.undo[h.undo.length - 1])} on the page` : "Nothing to undo";
  const redoTitle = canRedo ? `Redo: re-apply ${describe(h.redo[h.redo.length - 1])} to the page` : "Nothing to redo";
  document.querySelectorAll(".page-undo-btn").forEach((b) => { b.disabled = !canUndo; b.title = undoTitle; });
  document.querySelectorAll(".page-redo-btn").forEach((b) => { b.disabled = !canRedo; b.title = redoTitle; });
}

async function stepPageHistory(dir, btn) {
  if (state.isReadOnly) { notify("⚠️ This clip is read only. Ask your reviewer to reject it first."); return; }
  const tab = await getActiveTab().catch(() => null);
  if (!tab || isRestrictedUrl(tab.url)) return;

  const h = histFor(stripHash(tab.url));
  const from = dir === "undo" ? h.undo : h.redo;
  const to = dir === "undo" ? h.redo : h.undo;
  if (!from.length) return;

  const action = from[from.length - 1];
  // Undo walks the action backwards, redo replays it forwards
  const entries = dir === "undo" ? [...action.entries].reverse() : action.entries;

  notify("");
  btn.disabled = true;
  try {
    for (const e of entries) {
      const text = dir === "undo" ? e.before : e.after;
      const expect = dir === "undo" ? e.after : e.before;
      let { response } = await callPage({ action: "APPLY_TEXT", field: e.field, text, expect });
      if (response.status === "CHANGED") {
        const ok = window.confirm(`The ${FIELD_NAME[e.field] || e.field} was edited on the page after it was ${dir === "undo" ? "applied" : "undone"}. ${dir === "undo" ? "Undo" : "Redo"} anyway and overwrite those edits?`);
        if (!ok) return;
        ({ response } = await callPage({ action: "APPLY_TEXT", field: e.field, text }));
      }
      if (response.status !== "SUCCESS") {
        notify("⚠️ Couldn't find the field on the page.");
        return;
      }
    }
    from.pop();
    to.push(action);
    if (to.length > HISTORY_MAX) to.shift();
    saveHistory();
  } catch (e) {
    notify(escapeHTML(e.message || "Couldn't update the page."));
  } finally {
    updateHistoryButtons();
  }
}

async function applyField(field) {
  if (state.isReadOnly) { notify("⚠️ This clip is read only. Ask your reviewer to reject it first."); return false; }

  const btn = $(`apply-${field}`);
  const ta = $(`edit-${field}`);
  const status = $(`${field}-status`);
  const RESET = "Apply to Page";
  const text = ta.value.trim();
  notify("");
  if (!text) { flash(btn, "Nothing to apply", COLOR.err, RESET); return false; }

  btn.disabled = true;
  try {
    // No verification here: whatever is in the box goes straight onto the page.
    // (Compliance problems are still shown by Check Compliance and the live lint under the text.)

    const { response } = await applyToPage(field, text);
    if (response.status !== "SUCCESS") {
      flash(btn, "Field not found on page", COLOR.err, RESET, 3000);
      return false;
    }
    flash(btn, "Applied ✓", COLOR.ok, RESET);
    return true;
  } catch (e) {
    flash(btn, errorLabel(e, "Error — retry"), COLOR.err, RESET, 3000);
    if (e.code === "PAGE_CHANGED") status.innerHTML = warningHtml([e.message]);
    return false;
  } finally {
    btn.disabled = false;
  }
}

async function applyBoth() {
  if (state.isReadOnly) { notify("⚠️ This clip is read only. Ask your reviewer to reject it first."); return; }

  const btn = $("apply-both");
  const RESET = "Apply Both to Page";
  btn.disabled = true;
  batchCollector = { url: "", entries: [] };
  try {
    if (!(await applyField("box1"))) { flash(btn, "Fix Description first", COLOR.err, RESET, 2500); return; }
    if (!(await applyField("box2"))) { flash(btn, "Fix Causal Action first", COLOR.err, RESET, 2500); return; }
    flash(btn, "Both applied ✓", COLOR.ok, RESET);
  } finally {
    const done = batchCollector;
    batchCollector = null;
    if (done && done.entries.length) pushAction(done.url, done.entries); // whatever did apply is one undo step
    btn.disabled = false;
  }
}

function markMetricsApplied(p) {
  if (p.maneuverLabel) $("user-maneuver").value = p.maneuverLabel;
  if (p.suggestedSpeedChange) $("user-speed").value = p.suggestedSpeedChange;
  setSelectedContexts(p.suggestedContexts.length ? p.suggestedContexts : ["Auto"]);
  if (!state.last || !$("metrics-section")) return;
  state.last.ctx = {
    ...state.last.ctx,
    userManeuver: $("user-maneuver").value || "Auto",
    userSpeed: $("user-speed").value || "Auto",
    userContexts: getSelectedContexts()
  };
  $("metrics-section").innerHTML = renderMetrics(state.last.res, state.last.ctx).html;
  wireMetrics(state.last.res);
  persistSoon();
}

async function applyMetrics(btn, p) {
  if (state.isReadOnly) { notify("⚠️ This clip is read only. Ask your reviewer to reject it first."); return; }

  const RESET = "Apply Maneuver, Speed & Contexts to Page";
  notify("");
  btn.disabled = true;
  try {
    const { response } = await callPage({
      action: "APPLY_METRICS",
      maneuver: p.maneuverLabel,
      speedChange: p.suggestedSpeedChange,
      contexts: p.suggestedContexts
    }, { sameTab: true });
    const r = response.results || {};
    const ctxVals = Object.values(r.contexts || {});
    const removedVals = Object.values(r.removed || {});
    const missing = [];
    if (r.maneuver === "NOT_FOUND") missing.push("maneuver");
    if (r.speedChange === "NOT_FOUND") missing.push("speed");
    const ctxMissing = ctxVals.filter((s) => s === "NOT_FOUND").length;
    if (ctxMissing) missing.push(`${ctxMissing}/${ctxVals.length} contexts`);
    const unverified = [...ctxVals, ...removedVals].filter((s) => s === "UNVERIFIED").length;
    const removedOk = removedVals.filter((s) => s === "SUCCESS").length;

    if (missing.length) flash(btn, `Not found on page: ${missing.join(", ")}`, COLOR.warn, RESET, 4000);
    else if (unverified) flash(btn, `Applied, but ${unverified} context change${unverified > 1 ? "s" : ""} couldn't be confirmed — check the page`, COLOR.warn, RESET, 5000);
    else if (removedOk) flash(btn, `Applied ✓ (removed ${removedOk} wrong context${removedOk > 1 ? "s" : ""})`, COLOR.ok, RESET, 3500);
    else flash(btn, "Applied ✓", COLOR.ok, RESET);

    if (!missing.length && !unverified) markMetricsApplied(p);
  } catch (e) {
    flash(btn, errorLabel(e, "Error — retry"), COLOR.err, RESET, 3000);
  } finally {
    btn.disabled = false;
  }
}

/* ====================================================================
 * Rendering results
 * ==================================================================== */
function renderDiff(a, b) {
  return VLA.diffWords(a, b).map((op) => {
    const w = escapeHTML(op.w);
    return op.t === "del" ? `<del>${w}</del>` : op.t === "ins" ? `<ins>${w}</ins>` : w;
  }).join(" ");
}

function renderBox(title, data, field, originalText) {
  const tools = data.hasIssues ? discussToolHtml(field) + dismissToolHtml(field) : "";
  const statusHtml = data.hasIssues
  ? warningHtml(data.warnings, tools)
  : `<div class="success"><span>✓</span> <strong>100% Compliant Text</strong>${
    data.complianceNotes.length ? `<ul>${data.complianceNotes.map((n) => `<li>${escapeHTML(n)}</li>`).join("")}</ul>` : ""
  }</div>`;

  const first = data.suggestions[0] ?? originalText;
  const alts = data.suggestions.length > 1
  ? `<div class="alt-title">Alt Suggestions:</div>` + data.suggestions.slice(1).map((alt, i) =>
  `<button type="button" class="alt-suggestion" data-field="${field}" data-idx="${i + 1}">${escapeHTML(alt)}</button>`).join("")
  : "";

  const applyAttr = state.isReadOnly ? 'disabled title="Clip is read only"' : '';

  return `
  <div class="card">
  <h4 class="card-title">${title}</h4>
  <div id="${field}-status">${statusHtml}</div>
  <strong class="muted-label">💡 Suggested Version:</strong>
  <div class="suggestion-box">
  <button type="button" class="bm-btn bm-star" id="bm-${field}" aria-label="Bookmark this text">☆</button>
  <textarea id="edit-${field}" class="suggestion-edit bm-star-pad" aria-label="${title} — suggested text">${escapeHTML(first)}</textarea>
  <div class="count-line"><span class="counter" id="count-${field}"></span></div>
  <div id="lint-${field}"></div>
  <div id="diff-${field}" class="diff"></div>
  <div class="btn-row">
  <button type="button" class="apply-btn" id="apply-${field}" ${applyAttr}>Apply to Page</button>
  <button type="button" class="action-btn" id="copy-${field}">Copy</button>
  <button type="button" class="action-btn" id="rephrase-${field}" title="Generate a different wording of this text">${RESET_REPHRASE}</button>
  <span class="undo-group">
  <button type="button" class="undo-btn" id="undo-${field}" aria-label="Undo" disabled>↶</button>
  <button type="button" class="redo-btn" id="redo-${field}" aria-label="Redo" disabled>↷</button>
  </span>
  </div>
  ${alts}
  </div>
  </div>`;
}

function metricRow(name, yours, suggested, ok) {
  return `<div class="metric-row ${ok ? "ok" : "bad"}">
  <span class="metric-name">${name}</span>
  <span class="metric-val">${ok ? "✓" : "✗"} ${escapeHTML(yours)}${ok ? "" : ` <span class="arrow">→</span> <strong>Suggested: ${escapeHTML(suggested)}</strong>`}</span>
  </div>`;
}

function renderMetrics(res, ctx) {
  const p = res.predictedManeuver;
  if (!p) return { html: "", compliant: false };

  const sameSet = (a, b) => a.length === b.length && a.every((c) => b.includes(c));
  const userAuto = ctx.userContexts.length === 1 && ctx.userContexts[0] === "Auto";
  // A selection left on "Auto" is unset: the AI predicts it and never criticises it, so it is green,
  // not a flag — the suggestion is shown inside the row for information.
  const maneuverOk = ctx.userManeuver === "Auto" || (!!p.maneuverLabel && ctx.userManeuver === p.maneuverLabel);
  const speedOk = ctx.userSpeed === "Auto" || (!!p.suggestedSpeedChange && ctx.userSpeed === p.suggestedSpeedChange);
  const contextsOk = userAuto || sameSet(p.suggestedContexts, ctx.userContexts);
  const ctxYours = userAuto && p.suggestedContexts.length ? "Auto (suggested: " + p.suggestedContexts.join(", ") + ")" : ctx.userContexts.join(", ");
  const ctxSuggested = p.suggestedContexts.length ? p.suggestedContexts.join(", ") : "None";
  // Selection issues are distributed to their own section row instead of a separate
  // "Selection Issues" card: brake/speed warnings under Speed change, steering/maneuver
  // warnings under Maneuver, context warnings under Context(s), the rest at the end.
  const bySec = { maneuver: [], speed: [], context: [], other: [] };
  for (const w of res.selectionWarnings || []) {
    const t = String(w);
    // "Context mismatch:" warnings mention measured speeds, so the generic topic regexes
    // would file them under speed — route them by their prefix first.
    let topic = /^Context mismatch:/i.test(t) ? "context" : topicOfWarning(t);
    if (topic === "brake") topic = "speed";
    else if (topic === "steer") topic = "maneuver";
    (bySec[topic] || bySec.other).push(t);
  }
  // Maneuver: the model's "it should be X" line and the measured-steering line are the same problem.
  // Keep the measured one (the suggested maneuver is already shown in the row and in the reasoning).
  if (bySec.maneuver.length > 1) {
    const measured = bySec.maneuver.filter((w) => /steering angle|\bmeasured\b/i.test(w));
    if (measured.length) bySec.maneuver = [measured[0]];
  }
  // A selection can match the (telemetry-corrected) suggestion and still be contradicted by a measured channel:
  // any warning filed under a row means that row is not compliant, and the banner cannot say 100%.
  const manOk2 = maneuverOk && !bySec.maneuver.length;
  const spdOk2 = speedOk && !bySec.speed.length;
  const ctxOk2 = contextsOk && !bySec.context.length;
  const compliant = manOk2 && spdOk2 && ctxOk2 && !bySec.other.length;
  const sugg = (yours, label, ok) => (!ok && yours === label ? "re-check against the telemetry" : label);
  const secWarns = (list) => list.map((w) =>
    '<div style="margin: 2px 0 6px 14px; color: var(--alert-warning-text); font-size: 11px; line-height: 1.4;">✗ ' + escapeHTML(w) + "</div>").join("");

  // Order: Maneuver first, then Speed change, then Context(s), then anything unclassified.
  const rows =
  metricRow("Maneuver", ctx.userManeuver === "Auto" && p.maneuverLabel ? "Auto (suggested: " + p.maneuverLabel + ")" : ctx.userManeuver, sugg(ctx.userManeuver, p.maneuverLabel || "—", manOk2), manOk2) + secWarns(bySec.maneuver) +
  metricRow("Speed change", ctx.userSpeed === "Auto" && p.suggestedSpeedChange ? "Auto (suggested: " + p.suggestedSpeedChange + ")" : ctx.userSpeed, sugg(ctx.userSpeed, p.suggestedSpeedChange || "—", spdOk2), spdOk2) + secWarns(bySec.speed) +
  metricRow("Context(s)", ctxYours, ctxSuggested, ctxOk2) + secWarns(bySec.context) +
  secWarns(bySec.other);

  const reasoning = p.reasoning ? `<div class="eval-item" style="margin-top:8px;"><strong>Reasoning:</strong> ${escapeHTML(p.reasoning)}</div>` : "";

  if (compliant) {
    return {
      compliant,
      html: `<div class="card"><h4 class="card-title">Maneuver &amp; Contexts</h4>
      <div class="success"><span>✓</span> <strong>100% Compliant Selections</strong></div>
      <div style="margin-top:8px;">${rows}</div>${reasoning}</div>`
    };
  }

  const applyAttr = state.isReadOnly ? 'disabled title="Clip is read only"' : '';

  return {
    compliant,
    html: `<div class="eval-card" style="border-left-color: var(--alert-warning-border);">
    <h4 style="color: var(--alert-warning-text);">⚠️ Maneuver Section Non-Compliance Detected</h4>
    ${rows}${reasoning}
    <button type="button" class="apply-btn full" style="margin-top:10px;" id="apply-metrics-btn" ${applyAttr}>Apply Maneuver, Speed &amp; Contexts to Page</button>
    </div>`
  };
}

function wireSuggestionEditor(field, original, suggestions, originalHadIssues = false) {
  const ta = $(`edit-${field}`);
  const undoBtn = $(`undo-${field}`);
  const redoBtn = $(`redo-${field}`);
  let undoStack = [ta.value];
  let redoStack = [];
  let timer;

  state.trusted[field] = new Set([...(originalHadIssues ? [] : [original.trim()]), ...suggestions.map((s) => s.trim())].filter(Boolean));

  const updateBtns = () => {
    undoBtn.disabled = undoStack.length <= 1;
    redoBtn.disabled = redoStack.length === 0;
  };
  const refresh = () => {
    renderLint(field, ta.value, $(`lint-${field}`), $(`count-${field}`));
    const bmBtn = $(`bm-${field}`);
    if (bmBtn) paintBookmarkBtn(bmBtn);
    const changed = original.trim() && ta.value.trim() !== original.trim();
    $(`diff-${field}`).innerHTML = changed
    ? `<span class="muted-label">Changes vs your text:</span><br>${renderDiff(original, ta.value)}`
    : "";
  };
  const commit = () => {
    if (ta.value !== undoStack[undoStack.length - 1]) {
      undoStack.push(ta.value);
      redoStack = [];
      updateBtns();
    }
  };

  ta.addEventListener("input", () => { refresh(); clearTimeout(timer); timer = setTimeout(commit, 400); });

  undoBtn.onclick = () => {
    clearTimeout(timer);
    commit();
    if (undoStack.length > 1) {
      redoStack.push(undoStack.pop());
      ta.value = undoStack[undoStack.length - 1];
      updateBtns();
      refresh();
    }
  };
  redoBtn.onclick = () => {
    if (redoStack.length) {
      const next = redoStack.pop();
      undoStack.push(next);
      ta.value = next;
      updateBtns();
      refresh();
    }
  };

  document.querySelectorAll(`.alt-suggestion[data-field="${field}"]`).forEach((b) => {
    b.addEventListener("click", () => {
      ta.value = suggestions[Number(b.dataset.idx)] ?? ta.value;
      commit();
      refresh();
    });
  });

  $(`copy-${field}`).onclick = (e) => handleCopy(e.currentTarget, ta.value, "Copy");
  $(`apply-${field}`).onclick = () => applyField(field);
  $(`rephrase-${field}`).onclick = (e) => rephraseSuggestion(e.currentTarget, field);
  bindBookmarkBtn($(`bm-${field}`), field === "box1" ? "description" : "causal", () => ta.value, "review");
  refresh();
}

/* ====================================================================
 * Rephrase: ask the model for a different wording of ONE suggested text
 * (Description and Causal Action each have their own button)
 * ==================================================================== */
const RESET_REPHRASE = "🔄 Rephrase";

async function rephraseSuggestion(btn, field) {
  if (state.busy) return;
  const ta = $(`edit-${field}`);
  if (!ta) return;

  const isGroq = isGroqModel(state.model);
  if ((isGroq && !state.groqKey && !state.groqKey2) || (!isGroq && !state.key && !state.key2)) {
    setSettingsVisibility(true);
    return;
  }

  const otherField = field === "box1" ? "box2" : "box1";
  const current = ta.value.trim();
  const otherText = $(`edit-${otherField}`)?.value.trim() || "";
  if (!current) { flash(btn, "Nothing to rephrase", COLOR.err, RESET_REPHRASE); return; }

  const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();

  state.busy = true;
  setUIState(true);
  btn.disabled = true;
  btn.textContent = "Rephrasing...";
  notify("");

  // Keep the meaning and the rules: a real rewording (at least 3 word-level changes, not a tense tweak),
  // inside the word limit, with no rule problem the current text didn't already have.
  const baseIssues = new Set(VLA.lint(field, current).map((i) => i.msg));
  const changedWords = (t) => VLA.diffWords(current, t).filter((d) => d.t !== "eq").length;
  const keepsSyntax = (t) =>
    changedWords(t) >= 3 &&
    VLA.wordCount(t) <= VLA.MAX_WORDS &&
    VLA.lint(field, t).every((i) => baseIssues.has(i.msg));

  let result = "";
  let failure = null;
  const rejected = [];
  try {
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      const previous = [current, ...state.rephrased[field], ...rejected];
      const raw = await callGemini({
        system: Prompts.getRephraseSystemInstruction(field),
        text: Prompts.getRephraseUserPrompt({
          field, text: current, otherText, previous,
          userManeuver: $("user-maneuver")?.value || "Auto",
          userSpeed: $("user-speed")?.value || "Auto",
          userContexts: getSelectedContexts().filter((c) => c !== "Auto")
        }),
        schema: REPHRASE_SCHEMA,
        timeoutMs: 40000,
        temperature: 0.9,
        maxTokens: 1200
      });
      // "highway" survives a rephrase: restore it if the rewording swapped it for "road" without a cue
      let t = Prompts.filterSuggestions([String(raw?.text ?? "").replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "").replace(/\s+/g, " ").trim()], current, current + " " + otherText)[0];
      if (!t || norm(t) === norm(current)) continue;
      if (field === "box2" && state.last && state.last.ctx && state.last.ctx.speedCheck) t = telemetryFirstText(t, state.last.ctx.speedCheck);
      if (!t || norm(t) === norm(current)) continue;
      if (keepsSyntax(t)) result = t;
      else rejected.push(t);
    }
  } catch (e) {
    failure = e;
  } finally {
    state.busy = false;
    setUIState(false);
    btn.disabled = false;
  }

  if (failure) {
    flash(btn, errorLabel(failure, "Error — retry"), COLOR.err, RESET_REPHRASE, 3000);
    notify(escapeHTML(failure.message));
    return;
  }
  if (!result) {
    flash(btn, "No new wording — retry", COLOR.err, RESET_REPHRASE, 3000);
    return;
  }

  ta.value = result;
  state.rephrased[field].push(result);
  ta.dispatchEvent(new Event("input", { bubbles: true })); // refreshes lint / diff and records an undo step
  flash(btn, "Rephrased ✓", COLOR.ok, RESET_REPHRASE);
}

// Compact "Measured telemetry" card for the review results: the same numbers the calculator
// shows (speed, acceleration, steering, brake), read from the clip's own telemetry channels.
// Lets the reviewer see the measured behaviour right next to the warnings without opening the
// calculator. Empty when the clip has no telemetry or the speed check didn't run.
// Direction of the measured acceleration vs a Speed Change label: ✓ only when the channel
// clearly supports it, ✗ only when it clearly contradicts, null = unclear (noise band).
// Used by the review card AND the speed calculator's telemetry box.
function accelVerdictFor(speedLabel, w) {
  if (!w || w.accelMin == null) return null;
  const up = speedLabel === "Accelerate" || speedLabel === "Resume motion";
  const down = speedLabel === "Decelerate" || speedLabel === "Strong decelerate" || speedLabel === "Stop";
  if (!up && !down) return null;
  const u = w.accelUnit || "m/s²";
  if (up) {
    if (w.accelMax <= 0.05 && w.accelMin <= -0.3) return { ok: false, text: "Acceleration: braking to " + w.accelMin + " " + u + " — contradicts " + speedLabel };
    if (w.accelMax >= 0.6) return { ok: true, text: "Acceleration: up to +" + w.accelMax + " " + u + " — supports " + speedLabel };
  } else {
    if (w.accelMin >= -0.05 && w.accelMax >= 0.3) return { ok: false, text: "Acceleration: rising to +" + w.accelMax + " " + u + " — contradicts " + speedLabel };
    if (w.accelMin <= -0.6) return { ok: true, text: "Acceleration: down to " + w.accelMin + " " + u + " — supports " + speedLabel };
  }
  return null;
}

// Brake pedal vs a Speed Change label: applied while Accelerate = ✗, applied while slowing = ✓,
// not applied while a non-slowing label is selected = ✓, otherwise no verdict.
function brakeVerdictFor(speedLabel, w) {
  if (!w || w.brakeMax == null) return null;
  const bu = w.brakeUnit == null ? "" : (w.brakeUnit === "%" ? "%" : (w.brakeUnit ? " " + w.brakeUnit : ""));
  const down = speedLabel === "Decelerate" || speedLabel === "Strong decelerate" || speedLabel === "Stop";
  if (w.brakeMax >= 0.02) {
    if (speedLabel === "Accelerate") return { ok: false, text: "Brake: pedal applied (peak " + w.brakeMax + bu + ") — contradicts Accelerate" };
    if (down) return { ok: true, text: "Brake: pedal applied (peak " + w.brakeMax + bu + ") — supports " + speedLabel };
    return null;
  }
  if (down) return { ok: null, text: "Brake: pedal not used — deceleration without the brake pedal" };
  if (speedLabel && speedLabel !== "Auto") return { ok: true, text: "Brake: pedal not used — fits " + speedLabel };
  return null;
}

// ✓/✗ cross-check rows for the telemetry card — ONE row per channel (speed, acceleration,
// steering, brake), plus the Description's stopped claim. A channel the clip has no data for
// gets an explicit "no data in this clip" row instead of being silently dropped, so a short
// list always means "checked", never "skipped". ok: true = ✓ consistent, false = ✗ contradicts,
// null = informational (measured, but no verdict possible).
function telemetryVerdictRows(res, ctx) {
  const sc = ctx && (ctx.speedCheck || ctx.partialTelemetry);
  if (!sc) return [];
  const rows = [];
  const e = sc.extras || {};
  const w = e.window || {};
  const none = (label) => ({ ok: null, text: label + ": no data in this clip" });
  const upSel = ctx.userSpeed === "Accelerate" || ctx.userSpeed === "Resume motion";
  const downSel = ctx.userSpeed === "Decelerate" || ctx.userSpeed === "Strong decelerate" || ctx.userSpeed === "Stop";
  const has = (k) => !!((e.start && e.start[k]) || (e.end && e.end[k])
    || (k === "accel" && w.accelMin != null) || (k === "steer" && w.steerMin != null) || (k === "brake" && w.brakeMax != null));
  const gray = (row) => { row.gray = true; return row; }
  const pair = (k, u) => "Steering: " + ((e.start && e.start[k]) ? e.start[k].v : "—") + " → " + ((e.end && e.end[k]) ? e.end[k].v : "—") + " " + u;

  // 1. Speed — the measured change vs the selected Speed Change
  if (sc.startSpeed != null && sc.endSpeed != null) {
    const meas = "Speed: measured " + sc.startSpeed + " → " + sc.endSpeed + " m/s (Δ " + (sc.delta > 0 ? "+" : "") + sc.delta + ")";
    if (ctx.userSpeed && ctx.userSpeed !== "Auto" && sc.suggestion) {
      const bad = speedMismatchWarning(ctx.userSpeed, sc);
      rows.push(bad
        ? { ok: false, text: meas + " — points to " + sc.suggestion + ", not " + ctx.userSpeed }
        : { ok: true, text: meas + " — agrees with " + ctx.userSpeed });
    } else {
      rows.push({ ok: null, text: meas + (sc.suggestion ? " → " + sc.suggestion : "") });
    }
  } else rows.push({ ok: null, text: "Speed: no data in this clip" + (has("accel") ? " — acceleration is the speed evidence" : "") });

  // 2. Acceleration — direction of the measured force vs the selected Speed Change
  if (has("accel")) {
    const u = w.accelUnit || "m/s²";
    const v = accelVerdictFor(ctx.userSpeed, w);
    if (v) rows.push(v);
    else if (w.accelMin != null) rows.push(gray({ ok: null, text: "Acceleration: " + w.accelMin + " … " + w.accelMax + " " + u, grayNote: " — unclear" }));
    else rows.push({ ok: null, text: pair("accel", u) });
  } else rows.push(none("Acceleration"));

  // 3. Steering — the measured swing vs the selected Maneuver
  if (has("steer")) {
    const su = w.steerUnit || "°";
    if (ctx.userManeuver && ctx.userManeuver !== "Auto" && w.steerMin != null) {
      let clipMax = 0;
      try {
        const ch = telemetryRef && telemetryRef.series() && telemetryRef.series().ch.steer;
        if (ch) for (const x of ch.v) { const a = Math.abs(x); if (a > clipMax) clipMax = a; }
      } catch (_) {}
      const rangeTxt = "Steering: " + w.steerMin + " … " + w.steerMax + su;
      const v = steerVerdict(ctx.userManeuver, w, clipMax);
      if (v === "bad" && LATERAL_MANEUVERS.includes(ctx.userManeuver)) {
        rows.push({ ok: false, text: "Steering: no measurable turn or lane change (" + w.steerMin + " … " + w.steerMax + su + ") — inconsistent with " + ctx.userManeuver });
      } else if (v === "bad") {
        rows.push({ ok: false, text: "Steering: large swing (" + rangeTxt + ") — inconsistent with " + ctx.userManeuver });
      } else if (v === "ok") {
        rows.push({ ok: true, text: rangeTxt + " — consistent with " + ctx.userManeuver });
      } else {
        // Unclear for the selected maneuver — but when the audit's suggested maneuver is
        // clearly consistent with the measured steering, the selected one is wrong: ✗.
        const pred = res && res.predictedManeuver && res.predictedManeuver.maneuverLabel;
        const predV = pred && pred !== ctx.userManeuver ? steerVerdict(pred, w, clipMax) : null;
        if (predV === "ok") rows.push({ ok: false, text: rangeTxt + " — fits " + pred + ", not " + ctx.userManeuver });
        else rows.push(gray({ ok: null, text: rangeTxt, grayNote: " — unclear for " + ctx.userManeuver }));
      }
    } else {
      rows.push({ ok: null, text: w.steerMin != null
        ? "Steering: " + w.steerMin + " … " + w.steerMax + su
        : pair("steer", su) });
    }
  } else rows.push(none("Steering"));

  // 4. Brake pedal — applied / not applied vs the selected Speed Change
  if (has("brake")) {
    const v = brakeVerdictFor(ctx.userSpeed, w);
    if (v) rows.push(v);
    else rows.push(gray({ ok: null, text: "Brake: peak " + w.brakeMax + (w.brakeUnit == null ? "" : (w.brakeUnit === "%" ? "%" : (w.brakeUnit ? " " + w.brakeUnit : ""))), grayNote: "" }));
  } else rows.push(none("Brake"));

  // 5. A "ego is stopped" claim in the Description vs the measured speed before the action point
  if (ctx.box1Text && sc.history && sc.history.speedMin != null &&
      /\bego\b[^.]{0,60}?\bstop(?:ped)?\b(?!\s+(?:vehicle|truck|pickup))|\bego\b[^.]{0,60}?\b(?:stationary|standstill|halted)\b/i.test(ctx.box1Text)) {
    rows.push(sc.history.speedMin <= 0.5
      ? { ok: true, text: "Stopped claim: speed was ≤ " + sc.history.speedMin + " m/s before the action point — fits" }
      : { ok: false, text: "Stopped claim: speed stayed at " + sc.history.speedMin + "–" + sc.history.speedMax + " m/s — ego was rolling" });
  }
  // Corroboration: the telemetry channels are only witnesses. When the AI's predicted maneuver matches the
  // selected one AND the speed row agrees with the selected Speed Change, the scenario is already confirmed by
  // two independent sources, so an inconclusive channel (steering / acceleration / brake in the noise band) adds
  // nothing: it becomes ✓ "consistent with the annotation". The ❔ survives only when nothing else backs the annotation.
  const pm = res && res.predictedManeuver && res.predictedManeuver.maneuverLabel;
  // The witnesses are whatever data exists: the AI's maneuver agreeing with the selection, plus at least one
  // measured channel that agrees (speed when there is one, otherwise steering / acceleration / brake) and
  // none that disagrees. Works the same with 4, 3, 2 or 1 channels.
  const anyAgree = rows.some((r) => r.ok === true), anyDisagree = rows.some((r) => r.ok === false);
  const corroborated = !!(pm && ctx.userManeuver && ctx.userManeuver !== "Auto" && pm === ctx.userManeuver
    && anyAgree && !anyDisagree);
  for (const r of rows) {
    if (!r.gray) continue;
    if (corroborated) { r.ok = true; r.text += " — consistent with the annotation"; }
    else if (r.grayNote) r.text += r.grayNote;
    delete r.gray; delete r.grayNote;
  }
  return rows;
}

// The "Measured telemetry" card, summarized: cross-check rows only — one ✓/✗/– row per channel
// (speed, acceleration, steering, brake) plus the stopped claim. The measured numbers live
// inside the check texts; a channel with no data is named as "no data in this clip" rather
// than dropped, so silence can never be mistaken for a missing check.
function telemetryCardHtml(res, ctx) {
  const sc = ctx && (ctx.speedCheck || ctx.partialTelemetry);
  if (!sc) return "";
  const rows = telemetryVerdictRows(res, ctx);
  if (!rows.length) return "";
  let html = '<div class="telemetry-box" style="margin-top: 12px;">';
  const ex = sc.extras || {}, ww = ex.window || {};
  const hasCh = (k, m) => !!((ex.start && ex.start[k]) || (ex.end && ex.end[k]) || ww[m] != null);
  const present = [];
  if (sc.startSpeed != null && sc.endSpeed != null) present.push("speed");
  if (hasCh("accel", "accelMin")) present.push("acceleration");
  if (hasCh("steer", "steerMin")) present.push("steering");
  if (hasCh("brake", "brakeMax")) present.push("brake");
  const partialTxt = present.length < 4 ? " — using " + (present.join(", ") || "no channels") + " only" : "";
  html += '<div class="tele-title">Telemetry cross-checks · action point → ' + (sc.frames || 50) + " frames later" + partialTxt + (sc.noSeek ? " (from the clip's data — playhead not moved)" : "") + "</div>";
  for (const v of rows) {
    // Mark and text inline, left-aligned: the old flex row pushed the text right, so wrapped
    // lines came back ragged and detached from their ✓/✗ mark.
    const mark = v.ok === true ? '<span style="color:#16a34a">✓</span>'
      : v.ok === false ? '<span style="color:#ef4444">✗</span>'
      : '<span style="color:var(--text-muted)">❔</span>';
    html += '<div class="tele-row" style="display:block; text-align:left">' + mark + '&nbsp; <span style="font-weight:600">' + escapeHTML(v.text) + "</span></div>";
  }
  return html + "</div>";
}

// The decision frame must sit at least 2 seconds into the clip: the page numbers frames as
// floor(t × 10) + 1, so 2 s = frame 21. Anything earlier is flagged before the Description results.
const AP_MIN_FRAME = 21;

function renderActionPointCard(ctx) {
  const ap = ctx && ctx.actionPoint;
  if (!ap) return ""; // page unreadable (no access / player not ready): nothing to check
  let mark, text;
  if (ap.dp == null) {
    mark = '<span style="color:#ef4444">✗</span>';
    text = "No action point is selected in this clip. Set one on the page — it must be frame " + AP_MIN_FRAME + " or later.";
  } else if (ap.dp < AP_MIN_FRAME) {
    mark = '<span style="color:#ef4444">✗</span>';
    text = "Action point is frame " + ap.dp + " — it must not be less than frame " + AP_MIN_FRAME + " (2 seconds into the clip). Move the action point to frame " + AP_MIN_FRAME + " or later.";
  } else {
    mark = '<span style="color:#16a34a">✓</span>';
    text = "Action point is frame " + ap.dp + (ap.total ? " of " + ap.total : "") + " — at least 2 seconds into the clip.";
  }
  return '<div class="telemetry-box" style="margin: 0 0 12px;">' +
    '<div class="tele-title">Action point check</div>' +
    '<div class="tele-row" style="display:block; text-align:left">' + mark + '&nbsp; <span style="font-weight:600">' + escapeHTML(text) + "</span></div>" +
    "</div>";
}

/* ====================================================================
 * Action Point section (main view): READ-ONLY. Shows the clip's action
 * point (frame + time) and the cursor (playhead) position; it never presses
 * anything on the page — the annotation page stays the single source of truth.
 * ==================================================================== */
// Injected into the active tab: reads the page's action-point widget.
// The widget (per the page's markup): a container holding the readout
// ("1.50s" + "frame 16" spans — the action point's time and frame) and the
// "Set to N" button, whose N is the cursor frame the action point would be set at.
const apActOnPage = () => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const slider = document.querySelector('[role="slider"][aria-label="Playback time"]');
  // Several same-text buttons can exist on a crowded page: prefer the one nearest the playback slider
  const setBtn = (() => {
    const list = [...document.querySelectorAll("button")].filter((b) => /^set to \d+$/i.test(norm(b.textContent)));
    if (list.length <= 1) return list[0] || null;
    if (!slider) return list[0];
    const sr = slider.getBoundingClientRect(), scx = sr.left + sr.width / 2, scy = sr.top + sr.height / 2;
    const d = (b) => { const r = b.getBoundingClientRect(); return Math.hypot(r.left + r.width / 2 - scx, r.top + r.height / 2 - scy); };
    return [...list].sort((a, b) => d(a) - d(b))[0];
  })();
  if (!setBtn) {
    // Page variant without the widget buttons: fall back to the smallest "frame N" label
    let best = null;
    for (const el of document.querySelectorAll("span, div, p")) {
      const t = norm(el.textContent);
      if (t.length > 30 || !/^(?:action point\s*)?frame\s*\d+$/i.test(t)) continue;
      if (!best || t.length < best.length) best = t;
    }
    return { ok: true, hasWidgets: false, dp: best ? parseInt(best.match(/\d+/)[0], 10) : null, dpTime: null, cursorFrame: null };
  }
  // The readout spans sit in a sibling div of the buttons' div: climb from the buttons until
  // the container also holds the "frame N" label (the action point) and its "1.50s" time.
  let dp = null, dpTime = null;
  let root = setBtn.parentElement;
  for (let up = 0; up < 4 && root && dp === null; up++) {
    for (const el of root.querySelectorAll("span")) {
      const t = norm(el.textContent);
      if (dp === null && /^frame\s*\d+$/i.test(t)) dp = parseInt(t.match(/\d+/)[0], 10);
      else if (dpTime === null && /^\d+(?:\.\d+)?\s*s$/i.test(t)) dpTime = t;
    }
    root = root.parentElement;
  }
  // The cursor position: the N of "Set to N"; when the button is missing, the playhead's own value
  let cursorFrame = parseInt(norm(setBtn.textContent).match(/\d+/)[0], 10);
  if (!Number.isFinite(cursorFrame) && slider) {
    const now = parseFloat(slider.getAttribute("aria-valuenow"));
    if (isFinite(now)) cursorFrame = Math.floor(now * 10 + 1e-6) + 1; // the page shows frame = floor(t × 10) + 1
  }
  return { ok: true, hasWidgets: true, dp, dpTime, cursorFrame };
};

async function apPageOp() {
  if (!runOnActiveTabRef) throw new Error("The page reader isn't ready yet.");
  return runOnActiveTabRef(apActOnPage, []);
}

// Paints the section from a read result; st = null when the page can't be read
function apPaint(st) {
  const readout = $("ap-readout"), note = $("ap-note"), cursorEl = $("ap-cursor");
  if (!readout) return;
  if (!st || !st.ok) {
    readout.textContent = "—";
    readout.className = "ap-readout";
    if (cursorEl) cursorEl.textContent = "";
    if (note) { note.hidden = true; note.textContent = ""; }
    return;
  }
  if (cursorEl) cursorEl.textContent = st.cursorFrame != null ? "cursor: frame " + st.cursorFrame : "";
  if (note) {
    if (st.dp != null && st.dp < AP_MIN_FRAME) {
      note.hidden = false;
      note.className = "frames-note fn-bad";
      note.textContent = "Below frame " + AP_MIN_FRAME + " — the action point must be at least 2 seconds into the clip.";
    } else if (st.dp == null) {
      note.hidden = false;
      note.className = "frames-note fn-muted";
      note.textContent = st.hasWidgets ? "No action point is set on the page." : "No action point found on the page.";
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }
  if (st.dp != null) {
    const secs = ((st.dp - 1) / 10).toFixed(2);
    readout.textContent = "frame " + st.dp + " · " + (st.dpTime || secs + "s");
    readout.className = "ap-readout " + (st.dp >= AP_MIN_FRAME ? "ok" : "bad");
  } else {
    readout.textContent = "Not set";
    readout.className = "ap-readout";
  }
}

let apRefreshing = false;
async function refreshActionPointUI() {
  if (apRefreshing || state.busy || !$("ap-readout")) return;
  const tab = await getActiveTab().catch(() => null);
  if (!tab || isRestrictedUrl(tab.url)) { apPaint(null); return; }
  apRefreshing = true;
  try { apPaint(await apPageOp()); }
  catch (_) { apPaint(null); }
  finally { apRefreshing = false; }
}

function renderResults(res, ctx) {
  state.trusted = {};
  state.rephrased = { box1: [], box2: [] };
  let html = "";
  const hasBox1 = !!ctx.box1Text;
  const hasBox2 = !!ctx.box2Text;

  html += renderActionPointCard(ctx); // action point check, just before the Description results
  if (hasBox1) html += renderBox("Description Results", res.box1, "box1", ctx.box1Text);
  if (hasBox2) html += renderBox("Causal Action Results", res.box2, "box2", ctx.box2Text);

  const applyAttr = state.isReadOnly ? 'disabled title="Clip is read only"' : '';
  if (hasBox1 && hasBox2) html += `<button type="button" class="apply-btn full" id="apply-both" ${applyAttr}>Apply Both to Page</button>`;

  const metrics = renderMetrics(res, ctx);
  html += `<div id="metrics-section">${metrics.html}</div>`;

  html += telemetryCardHtml(res, ctx);

  // Selection warnings are no longer a separate card: renderMetrics() distributes each one
  // under its own section row (Maneuver / Speed change / Context(s)).
  html += `
  <button type="button" id="ask-ai-results-btn" class="action-btn full" style="margin-top: 8px; width: 100%; padding: 8px; font-size: 12px; background: var(--bg-pill); color: var(--text-main);">
  💬 Ask AI about these results
  </button>`;

  $("output").innerHTML = html;

  // ✕ dismiss + 💬 discuss, together in the top-right corner of each violation rectangle
  const wireWarnTools = (field, label) => {
    const dismissBtn = $(`dismiss-${field}`);
    const discussBtn = $(`discuss-${field}`);
    const warns = (state.last?.res?.[field]?.warnings || []).slice();
    if (discussBtn) discussBtn.onclick = () => {
      setChatVisibility(true);
      $("chat-input").value = 'Why is this a violation, and how do I fix it? The reviewer flagged these ' + label + ' violations: "' + warns.join('"; "') + '"';
      $("chat-input").focus();
    };
    if (dismissBtn) dismissBtn.onclick = () => dismissFieldWarnings(field);
  };
  if (hasBox1 && res.box1.hasIssues) wireWarnTools("box1", "Description");
  if (hasBox2 && res.box2.hasIssues) wireWarnTools("box2", "Causal Action");

  if (hasBox1) wireSuggestionEditor("box1", ctx.box1Text, res.box1.suggestions, res.box1.hasIssues);
  if (hasBox2) wireSuggestionEditor("box2", ctx.box2Text, res.box2.suggestions, res.box2.hasIssues);
  if (hasBox1 && hasBox2) $("apply-both").onclick = applyBoth;

  wireMetrics(res);

  const askAiBtn = $("ask-ai-results-btn");
  if (askAiBtn) {
    askAiBtn.onclick = () => {
      setChatVisibility(true);

      const hasViolations = res.box1.hasIssues || res.box2.hasIssues || !metrics.compliant || selWarnings.length > 0;

      let suggestions = [];
      if (hasViolations) {
        suggestions = ["Explain my violations", "How do I fix the Description?", "How do I fix the Causal Action?"];
        if (!metrics.compliant) suggestions.push("Why are my maneuver tags wrong?");
      } else {
        suggestions = ["Why is this 100% compliant?", "Can you make my text more concise?", "Are there edge cases I missed?"];
      }

      showChatSuggestions(suggestions);
    };
  }
}

function wireMetrics(res) {
  const metricsBtn = $("apply-metrics-btn");
  if (metricsBtn) metricsBtn.onclick = (e) => applyMetrics(e.currentTarget, res.predictedManeuver);
}

/* ====================================================================
 * Tab / clip changes
 * ==================================================================== */
let tabTimer;
let tabUrlMemory = {}; // tabId -> last URL seen in that tab (to detect reload / clip change)

function onTabChanged(tabId) {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(async () => {
    if (state.busy) return;
    const tab = await getActiveTab().catch(() => null);
    if (!tab || tab.id !== tabId) return;

    updateFooterButtons(tab);
    updateHistoryButtons();

    const stale = state.auditTab && (state.auditTab.id !== tab.id || state.auditTab.url !== stripHash(tab.url));

    if (!stale) {
      notify("");
    }

    const pageKey = `${tab.id}|${stripHash(tab.url)}`;
    if (pageKey === state.lastSeenPage) return;
    state.lastSeenPage = pageKey;

    // Page reload (F5) or navigation to a different clip URL -> reset the calculator
    const pageUrl = stripHash(tab.url);
    const wasReloaded = state.pendingReloadTab === tabId;
    if (wasReloaded) state.pendingReloadTab = null;
    if (!isRestrictedUrl(tab.url)) tabUrlMemory[tab.id] = pageUrl;

    if (isRestrictedUrl(tab.url)) {
      state.badgeAlert = null;
      updateBadge();
      if (state.warnPageChange && stale && state.last) {
        notify("⚠️ The page changed since the last check — these results may not apply. Return to Ondana tab");
      }
      return;
    }

    if (state.autoFetch && state.dataTab && state.dataTab.id === tab.id && state.dataTab.url !== stripHash(tab.url)) {
      clearPanel();
    }

    let fetched = false;
    if (state.autoFetch) {
      fetched = await fetchFromPage({ silent: true, triggerAudit: state.autoAudit, withSpeed: state.autoAudit });
    } else {
      updateBadge();
    }

    if (state.warnPageChange && stale && state.last) {
      notify("⚠️ The page changed since the last check — these results may not apply. Re-run Check Compliance.");
    }
  }, 250);
}

/* ====================================================================
 * Init
 * ==================================================================== */
/* ====================================================================
 * Global bookmarks: save any Description, Causal Action or AI chat reply.
 * Stored in chrome.storage.local, so the same list is available on every clip.
 * ==================================================================== */
const BM_KEY = "vla_bookmarks";
const BM_MAX = 300;
const BM_TEXT_MAX = 6000;
const BM_TYPES = { description: "Description", causal: "Causal Action", chat: "AI chat" };
let bookmarks = [];
let bmFilter = "all";
let bmQuery = "";
let bmManeuverFilter = "all";

const bmNorm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
const bmFind = (type, text) => bookmarks.find((b) => b.type === type && bmNorm(b.text) === bmNorm(text));
const bmId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function bmLoad() {
  const stored = await chrome.storage.local.get(BM_KEY);
  bookmarks = Array.isArray(stored[BM_KEY]) ? stored[BM_KEY] : [];
}

// Adds the bookmark, or removes it if the same text is already saved. Returns "added" | "removed" | "full".
async function toggleBookmark(type, text, source) {
  await bmLoad();                                   // always start from what is really stored
  const clean = String(text || "").trim().slice(0, BM_TEXT_MAX);
  const existing = bmFind(type, clean);
  let result;
  const maneuver = (type === "description" || type === "causal") ? $("user-maneuver").value : null;

  if (existing) {
    bookmarks = bookmarks.filter((b) => b !== existing);
    result = "removed";
  } else if (bookmarks.length >= BM_MAX) {
    return "full";
  } else {
    bookmarks.unshift({ id: bmId(), type, text: clean, source, created: Date.now(), maneuver });
    result = "added";
  }
  await chrome.storage.local.set({ [BM_KEY]: bookmarks });
  refreshBookmarkButtons();
  if (!$("bookmarks-view").hidden) renderBookmarks();
  return result;
}

function paintBookmarkBtn(btn) {
  const text = (btn._bmText ? btn._bmText() : "").trim();
  const saved = !!text && !!bmFind(btn.dataset.bmType, text);
  const labeled = btn.dataset.bmLabel === "1";
  btn.textContent = saved ? (labeled ? "★ Saved" : "★") : (labeled ? "☆ Save" : "☆");
  btn.title = saved ? "Bookmarked on every clip — click to remove" : "Bookmark this text (available on every clip)";
  btn.classList.toggle("saved", saved);
  btn.setAttribute("aria-pressed", String(saved));
}

function refreshBookmarkButtons() {
  document.querySelectorAll(".bm-btn").forEach(paintBookmarkBtn);
}

function bindBookmarkBtn(btn, type, getText, source, { labeled = false } = {}) {
  btn.dataset.bmType = type;
  if (labeled) btn.dataset.bmLabel = "1";
  btn._bmText = getText;
  btn.addEventListener("click", async () => {
    const text = (getText() || "").trim();
    if (!text) { flash(btn, "Empty", COLOR.err, btn.textContent, 1500); return; }
    const result = await toggleBookmark(type, text, source);
    if (result === "full") flash(btn, "Full", COLOR.err, btn.textContent, 2000);
  });
  paintBookmarkBtn(btn);
  return btn;
}

function makeBookmarkBtn(type, getText, source, { labeled = true, className = "action-btn" } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `${className} bm-btn`;
  return bindBookmarkBtn(btn, type, getText, source, { labeled });
}

const bmMatches = (b) => {
  if (bmFilter !== "all" && b.type !== bmFilter) return false;
  if (bmManeuverFilter !== "all" && b.maneuver !== bmManeuverFilter) return false;
  const q = bmQuery.trim().toLowerCase();
  return !q || b.text.toLowerCase().includes(q);
};

function renderBookmarks() {
  const counts = { all: bookmarks.length, description: 0, causal: 0, chat: 0 };
  bookmarks.forEach((b) => { if (b.type in counts) counts[b.type]++; });
  const names = { all: "All", description: "Description", causal: "Causal", chat: "Chat" };
  document.querySelectorAll("#bm-filter .seg-btn").forEach((btn) => {
    const f = btn.dataset.filter;
    btn.classList.toggle("active", f === bmFilter);
    btn.textContent = `${names[f]} (${counts[f] || 0})`;
  });

  const list = $("bm-list");
  if (!bookmarks.length) {
    list.innerHTML = `<div class="bm-empty">No bookmarks yet.<br>Tap ☆ on a Description, a Causal Action or an AI reply to keep it here for every clip.</div>`;
    return;
  }
  const items = bookmarks.filter(bmMatches);
  if (!items.length) {
    list.innerHTML = `<div class="bm-empty">No bookmarks match.</div>`;
    return;
  }
  list.innerHTML = items.map((b) => {
    const date = new Date(b.created).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const useLabel = b.type === "description" ? "Use in Description" : "Use in Causal Action";
    
    // Convert Chat syntax to formatted HTML layout, otherwise plain strings
    const htmlText = b.type === "chat" ? formatChatText(b.text) : escapeHTML(b.text);
    
    return `
    <div class="bm-item" data-id="${escapeHTML(b.id)}">
      <div class="bm-meta">
        <span class="bm-tag bm-tag-${escapeHTML(b.type)}">${escapeHTML(BM_TYPES[b.type] || b.type)}</span>
        ${b.maneuver && b.maneuver !== "Auto" ? `<span class="bm-tag bm-tag-maneuver">${escapeHTML(b.maneuver)}</span>` : ""}
        <span class="bm-date" style="margin-left:auto;">${escapeHTML(date)}</span>
      </div>
      
      <!-- Static text display -->
      <div class="bm-text" title="Click to expand / collapse">${htmlText}</div>
      
      <!-- Edit mode UI (Hidden by default) -->
      <div class="bm-edit-container" style="display: none; margin-top: 6px;">
        <textarea class="suggestion-edit" style="width: 100%; min-height: 60px; resize: none; overflow: hidden; margin-bottom: 6px; padding: 6px; box-sizing: border-box; font-size: 12px; font-family: inherit;" aria-label="Edit bookmark text">${escapeHTML(b.text)}</textarea>
        <div class="btn-row">
          <button type="button" class="apply-btn" data-act="save">💾 Save</button>
          <button type="button" class="action-btn" data-act="cancel">Cancel</button>
        </div>
      </div>

      <div class="btn-row bm-actions">
        <button type="button" class="action-btn" data-act="copy">Copy</button>
        ${b.type !== "chat" ? `<button type="button" class="action-btn" data-act="use">${useLabel}</button>` : ""}
        <button type="button" class="action-btn" data-act="edit">✏️ Edit</button>
        <button type="button" class="action-btn" data-act="del" title="Remove this bookmark">🗑 Remove</button>
      </div>
    </div>`;
  }).join("");
}

function wireBookmarksView() {
  $("bookmarks-toggle").addEventListener("click", () => setBookmarksVisibility($("bookmarks-view").hidden));
  $("close-bookmarks-btn").addEventListener("click", () => setBookmarksVisibility(false));

  $("stats-toggle").addEventListener("click", () => setStatsVisibility($("stats-view").hidden));
  $("close-stats-btn").addEventListener("click", () => setStatsVisibility(false));
  $("stats-range").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    statsRange = b.dataset.range;
    document.querySelectorAll("#stats-range .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    renderStats();
  });
  $("stats-cat-select").addEventListener("change", (e) => {
    statsCat = e.target.value;
    renderStats();
  });
  $("stats-reset-btn").addEventListener("click", async () => {
    // Full reset: audit events, daily opens AND the opened/audited ledger — the ledger
    // powers "Opened, not audited" and the owl's "unaudited clips" message.
    await chrome.storage.local.remove(STATS_KEY).catch(() => {});
    await chrome.storage.local.remove(OPENS_KEY).catch(() => {});
    await chrome.storage.local.remove(SEEN_KEY).catch(() => {});
    renderStats();
  });

  $("bm-filter").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    bmFilter = b.dataset.filter;
    renderBookmarks();
  });
  $("bm-search").addEventListener("input", (e) => { bmQuery = e.target.value; renderBookmarks(); });
  
  const mFilter = $("bm-maneuver-filter");
  if (mFilter) mFilter.addEventListener("change", (e) => { bmManeuverFilter = e.target.value; renderBookmarks(); });

  $("bm-list").addEventListener("click", async (e) => {
    const item = e.target.closest(".bm-item");
    if (!item) return;
    const bm = bookmarks.find((x) => x.id === item.dataset.id);
    if (!bm) return;
    const btn = e.target.closest("[data-act]");
    if (!btn) {
      if (e.target.closest(".bm-text")) item.querySelector(".bm-text").classList.toggle("expanded");
      return;
    }

    const act = btn.dataset.act;

    if (act === "copy") {
      handleCopy(btn, bm.text, "Copy");
    } else if (act === "use") {
      const input = $(bm.type === "description" ? "box1-input" : "box2-input");
      input.value = bm.text;
      
      if (bm.maneuver && bm.maneuver !== "Auto") {
        const mSel = $("user-maneuver");
        if (mSel && [...mSel.options].some(o => o.value === bm.maneuver)) {
          mSel.value = bm.maneuver;
        }
      }
      
      input.dispatchEvent(new Event("input", { bubbles: true }));   // refreshes the live check and saves the draft
      await setBookmarksVisibility(false);
      notify(`Bookmark inserted into the ${bm.type === "description" ? "Description" : "Causal Action"} box. Run <strong>Check Compliance</strong> before applying it.`, "success");
    } else if (act === "del") {
      await toggleBookmark(bm.type, bm.text, bm.source);
    } else if (act === "edit") {
      // Hide static text and default action row
      item.querySelector(".bm-text").style.display = "none";
      item.querySelector(".bm-actions").style.display = "none";
      
      // Show edit UI
      const editContainer = item.querySelector(".bm-edit-container");
      editContainer.style.display = "block";
      const ta = editContainer.querySelector("textarea");
      
      // Auto-resize bound dynamically on edit
      const autoResize = () => {
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      };
      ta.addEventListener("input", autoResize);
      
      // Wait slightly for DOM to paint block before calculating height and focusing
      setTimeout(() => {
        ta.focus();
        ta.selectionStart = ta.value.length; // Place cursor at end
        autoResize();
      }, 10);

    } else if (act === "cancel") {
      // Revert visibility back to CSS stylesheet defaults
      item.querySelector(".bm-edit-container").style.display = "none";
      item.querySelector(".bm-text").style.display = ""; 
      item.querySelector(".bm-actions").style.display = "";
    } else if (act === "save") {
      const newText = item.querySelector("textarea").value.trim();
      if (!newText) {
        flash(btn, "Cannot be empty", COLOR.err, "💾 Save", 1500);
        return;
      }
      
      // Save globally
      bm.text = newText.slice(0, BM_TEXT_MAX);
      await chrome.storage.local.set({ [BM_KEY]: bookmarks });
      
      // We call renderBookmarks to rebuild the UI with the updated data, wiping the edit mode clean
      refreshBookmarkButtons();
      renderBookmarks(); 
    }
  });

  // Manually add a bookmark by typing or pasting.
  // The active tab bar (All / Description / Causal / Chat) dictates the type,
  // and the maneuver filter dropdown dictates the bookmark's maneuver.
  const bmAddBtn = $("bm-add-btn");
  const addManualBookmark = async () => {
    const text = $("bm-add-text").value.trim();
    if (!text) { flash(bmAddBtn, "Empty", COLOR.err, "➕ Add", 1500); return; }
    if (bmFilter === "all") { flash(bmAddBtn, "Pick a tab first", COLOR.warn, "➕ Add", 2000); return; }

    const type = bmFilter;
    if (bmFind(type, text)) { flash(bmAddBtn, "Already saved", COLOR.warn, "➕ Add", 2000); return; }

    const result = await toggleBookmark(type, text, "manual");
    if (result === "full") { flash(bmAddBtn, "Full", COLOR.err, "➕ Add", 2000); return; }

    // Attach the maneuver chosen in the filter dropdown (null when it's "All Maneuvers"/Auto)
    const added = bmFind(type, text);
    if (added) {
      added.maneuver = (bmManeuverFilter !== "all" && bmManeuverFilter !== "Auto") ? bmManeuverFilter : null;
      await chrome.storage.local.set({ [BM_KEY]: bookmarks });
    }
    $("bm-add-text").value = "";
    flash(bmAddBtn, "Added ✓", COLOR.ok, "➕ Add");
    renderBookmarks();
  };
  bmAddBtn.addEventListener("click", addManualBookmark);
  $("bm-add-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addManualBookmark(); }
  });

  // The ☆ next to the Description / Causal Action fields of the main form
  bindBookmarkBtn($("bm-box1-input"), "description", () => $("box1-input").value, "form");
  bindBookmarkBtn($("bm-box2-input"), "causal", () => $("box2-input").value, "form");

  // Keep every open ☆ in sync if the list changes somewhere else (another window, another tab)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[BM_KEY]) return;
    bookmarks = Array.isArray(changes[BM_KEY].newValue) ? changes[BM_KEY].newValue : [];
    refreshBookmarkButtons();
    if (!$("bookmarks-view").hidden) renderBookmarks();
  });
}

async function init() {
  // Load user-edited prompt blocks (Settings → "🧠 Prompts") before any AI call can run
  await Prompts.load();
  try {
    const od = typeof Prompts.outdatedBlocks === "function" ? Prompts.outdatedBlocks() : [];
    if (od.length) setTimeout(() => showInfoTooltip("ℹ️ The default <b>" + od.map(ruleBlockLabel).map(escapeHTML).join(", ") + "</b> rules changed in this version, but you have your own edited copy, so the new defaults are not used. Reset the block in ⚙️ Settings → 🧠 Prompts to get them."), 1500);
  } catch (_) {}

  buildControls();

  const stored = await chrome.storage.local.get([
    "vla_gemini_key", "vla_groq_key", "vla_gemini_key2", "vla_groq_key2", "vla_model", "vla_chat_model", "vla_vision_model",
    "vla_auto_fetch", "vla_auto_audit", "vla_show_badge", "vla_warn_page_change", "vla_theme", "vla_speed_check_review_off"
  ]);
  
  state.key = stored.vla_gemini_key || "";
  state.groqKey = stored.vla_groq_key || "";
  state.key2 = stored.vla_gemini_key2 || "";
  state.groqKey2 = stored.vla_groq_key2 || "";
  state.model = stored.vla_model || VLA.DEFAULT_MODEL;
  state.chatModel = stored.vla_chat_model || VLA.DEFAULT_MODEL;
  state.visionModel = stored.vla_vision_model || VISION_DEFAULT_MODEL;
  state.autoFetch = stored.vla_auto_fetch !== false;
  state.autoAudit = stored.vla_auto_audit === true;
  state.showBadge = stored.vla_show_badge !== false;
  state.warnPageChange = stored.vla_warn_page_change === true;
  state.speedCheckReviewOff = stored.vla_speed_check_review_off === true;

  $("api-key").value = state.key;
  if ($("groq-api-key")) $("groq-api-key").value = state.groqKey;
  if ($("api-key-2")) $("api-key-2").value = state.key2;
  if ($("groq-api-key-2")) $("groq-api-key-2").value = state.groqKey2;
  
  $("model-input").value = state.model;
  VLA.setupModelPicker($("model-select"), $("model-input"));
  updateModelIndicator("model-input", true);

  $("chat-model-input").value = state.chatModel;
  VLA.setupModelPicker($("chat-model-select"), $("chat-model-input"));

  // Image analysis model: saved instantly (no Save button), like the other live settings
  $("vision-model-input").value = state.visionModel;
  VLA.setupModelPicker($("vision-model-select"), $("vision-model-input"));
  const saveVisionModel = () => {
    const v = $("vision-model-input").value.trim() || VISION_DEFAULT_MODEL;
    state.visionModel = v;
    chrome.storage.local.set({ vla_vision_model: v }).catch(() => {});
  };
  $("vision-model-select").addEventListener("change", saveVisionModel); // setupModelPicker's own handler ran first
  $("vision-model-input").addEventListener("input", saveVisionModel);
  updateModelIndicator("chat-model-input", true);

  $("auto-fetch").checked = state.autoFetch;
  $("auto-audit").checked = state.autoAudit;
  $("show-badge").checked = state.showBadge;
  $("warn-page-change").checked = state.warnPageChange;

  updateFetchVisibility();
  if (stored.vla_theme) document.documentElement.setAttribute("data-theme", stored.vla_theme);

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
      updateBadge();
    }
  });

  $("theme-toggle").addEventListener("click", () => {
    let current = document.documentElement.getAttribute("data-theme");
    if (!current) current = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    chrome.storage.local.set({ vla_theme: next });
  });

  // --- Screenshot (camera icon in the main toolbar, right after the Speed Calculator) --- //
  // Injects snip.js into the annotation page: drag a rectangle and it is copied to the
  // clipboard as a PNG (a file is saved if the clipboard refuses). Click the button again,
  // press Esc or right-click on the page to cancel while the tool is open.
  const snipBtn = $("screenshot-btn");
  if (snipBtn) snipBtn.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab || isRestrictedUrl(tab.url)) {
      showInfoTooltip("Open the annotation page in the active tab, then click the camera button.");
      return;
    }
    const inject = () => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["snip.js"] });
    try {
      await inject();
    } catch (e) {
      if (/cannot access|permission/i.test(e.message || "")) {
        const granted = await chrome.permissions.request({ origins: [ALLOWED_ORIGIN + "/*"] });
        if (granted) {
          try { await inject(); } catch (e2) { showInfoTooltip("Screenshot failed: " + ((e2 && e2.message) || "unknown error")); }
        } else {
          showInfoTooltip("The screenshot needs access to the annotation site — click the camera button again and allow it.");
        }
      } else {
        // e.g. "Could not load file 'snip.js'" when the file is missing from this extension's folder
        showInfoTooltip("Screenshot failed: " + ((e && e.message) || "unknown error"));
      }
    }
  });

  await bmLoad();
  wireBookmarksView();

  $("chat-toggle").addEventListener("click", () => {
    const isChatOpen = !$("chat-view").hidden;
    setChatVisibility(!isChatOpen);
  });

  $("close-chat-btn").addEventListener("click", () => {
    setChatVisibility(false);
  });

  $("chat-send-btn").addEventListener("click", sendChatMessage);
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  $("chat-upload-btn").addEventListener("click", captureCameraViews);

  // Sample buttons: one-tap AI tools in the chat
  $("sample-speed-btn").addEventListener("click", () => {
    if ($("chat-send-btn").disabled) return; // a request is already running
    $("chat-input").value = "Check the speed change for this clip.";
    sendChatMessage(); // the chat model emits the speed-check marker and interprets the result
  });
  $("sample-describe-btn").addEventListener("click", async () => {
    const b = $("sample-describe-btn");
    if ($("chat-send-btn").disabled || b.disabled) return; // a request is already running
    b.disabled = true;
    try {
      await captureCameraViews(); // grabs the camera views (the image tool)
      if (pendingScene) sendChatMessage(); // capture succeeded → scene review describes ego's environment
    } finally { b.disabled = false; }
  });

  $("remove-chat-image-btn").addEventListener("click", () => {
    pendingChatImage = null;
    pendingScene = null;
    $("chat-image-preview-container").style.display = "none";
  });

  $("chat-input").addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = (uploadEvent) => {
          const base64String = uploadEvent.target.result.split(",")[1];
          pendingScene = null;
          pendingChatImage = {
            inlineData: {
              mimeType: file.type,
              data: base64String
            }
          };
          $("chat-image-preview").src = uploadEvent.target.result;
          $("chat-image-name").textContent = file.name || "Pasted image";
          $("chat-image-preview-container").style.display = "flex";
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  });

  $("settings-toggle").addEventListener("click", () => {
    const isSettingsOpen = !$("settings-view").hidden;
    setSettingsVisibility(!isSettingsOpen);
  });

  $("close-settings-btn").addEventListener("click", () => {
    setSettingsVisibility(false);
  });

  // --- Speed Calculator Bindings --- //
  $("calc-toggle").addEventListener("click", () => {
    const isCalcOpen = !$("calc-view").hidden;
    setCalcVisibility(!isCalcOpen);
  });

  $("close-calc-btn").addEventListener("click", () => {
    setCalcVisibility(false);
  });

  /* ====================================================================
   * Speed Calculator (auto-seek fetch, frames-ahead window, apply to page)
   * ==================================================================== */
  const SPEEDS = VLA.SPEEDS; // the speed-change menu of the annotation page
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  let currentSuggestion = null; // recommendation from the Δ calculation, used by the choice checker
  let frameWindow = 50; // frames ahead of the action point; null = no window, Fetch reads at the playhead
  let lastClipUrl = null;

  // Calc buttons contain an SVG icon + a .btn-label span, so flashes must only touch the label
  const setBtnLabel = (btn, txt) => {
    const lbl = btn.querySelector(":scope > .btn-label");
    if (lbl) lbl.textContent = txt;
    else btn.textContent = txt;
  };

  const calcFlash = (btn, text, bg, resetText, ms = 2000) => {
    setBtnLabel(btn, text);
    btn.style.background = bg || "";
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      setBtnLabel(btn, resetText);
      btn.style.background = "";
    }, ms);
  };

  // Runs a function inside the active tab. Clicking the extension icon (which opens this
  // panel) grants activeTab access to that page; if that has lapsed, ask once for
  // permanent access to the annotation site and retry.
  const runOnActiveTab = async (func, args = []) => {
    const tab = await getActiveTab();
    if (!tab || isRestrictedUrl(tab.url)) throw new Error("Open the annotation page in this window's active tab first.");

    const inject = () => chrome.scripting.executeScript({ target: { tabId: tab.id }, args, func });
    try {
      const results = await inject();
      return results?.[0]?.result;
    } catch (e) {
      if (/cannot access|permission/i.test(e.message || "")) {
        const granted = await chrome.permissions.request({ origins: [`${ALLOWED_ORIGIN}/*`] });
        if (!granted) throw new Error("The calculator needs access to the annotation site. Click the button again and allow it.");
        const results = await inject();
        return results?.[0]?.result;
      }
      throw e;
    }
  };

  /* Fetch speed from the page: seeks to the action point (start) or action
   * point + selected frames (end), then reads the velocity at that position */
  // Shared page reader: seeks to the action point ("start") or +window frames ("end") and
  // reads the velocity there. win = null reads at the current playhead without seeking.
  // mode: "start" (action point), "end" / "offset" (action point + win frames; win may be negative for
  // "offset"), "abs" (frame number win). quick = skip the velocity read (used by the camera capture).
  const seekAndReadRaw = (mode, win, quick = false) => runOnActiveTab(async (mode, win, quick) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const slider = document.querySelector('[role="slider"][aria-label="Playback time"]');
        if (!slider) return { status: "NO_SLIDER" };
        // The site's class names are build hashes that change between deploys, so try the
        // known hashes first and fall back to finding the elements by their text.
        const smallestMatch = (re) => {
          let best = null;
          for (const el of document.querySelectorAll("span, div, p")) {
            const t = el.textContent || "";
            if (t.length > 60 || !re.test(t)) continue;
            if (!best || t.length < best.textContent.length) best = el;
          }
          return best;
        };
        // The page shows frame = floor(time x 10) + 1, and the scrubber can rest between two
        // frames (5.350 s is frame 54, not 55). Floor like the page does; the epsilon only guards
        // exact frame times against float noise (4.4 * 10 = 43.99999...).
        const toFrame = (t) => Math.floor(t * 10 + 1e-6) + 1;
        // GROUND TRUTH: the page's own "FRAME 54 of 200" tile. Computing the frame from the slider
        // time is only an inference and breaks on some clips, so every check reads the tile and
        // falls back to the time formula only when the tile can't be found.
        const frameRe = /FRAME\s*(\d+)\s*of\s*(\d+)/i;
        const readTile = () => {
          const el = smallestMatch(frameRe);
          const m = el ? el.textContent.match(frameRe) : null;
          return m ? { frame: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
        };
        const currentFrame = () => {
          const t = readTile();
          return t ? t.frame : toFrame(parseFloat(slider.getAttribute("aria-valuenow")) || 0);
        };
        // Wait until the displayed frame has stopped changing (seeks finish a beat after the click)
        const settledFrame = async (ms = 1000) => {
          let last = null, same = 0;
          const end = Date.now() + ms;
          while (Date.now() < end) {
            const f = currentFrame();
            if (f === last) { if (++same >= 2) return f; } else { same = 0; last = f; }
            await sleep(120);
          }
          return currentFrame();
        };
        const findVelEl = () => document.querySelector('span.x3nfvp2.x6s0dn4.x1a02dak.x1nejdyq') || smallestMatch(/Velocity\s*-?\d/i);

        // No frames-ahead window selected: don't seek — read at the current playhead position
        if (win === null || win === undefined) {
          const readVelNow = () => {
            const el = findVelEl();
            if (!el) return null;
            const m = el.textContent.match(/Velocity\s*(-?\d+(?:\.\d+)?)\s*m\/s/i);
            return m ? parseFloat(m[1]) : null;
          };
          let velocity = readVelNow();
          if (velocity === null) { await sleep(400); velocity = readVelNow(); }
          const frame = currentFrame();
          return { status: "OK", frame, velocity, capped: false };
        }

        // Action point frame ("frame 21") — not needed for an absolute-frame seek
        let dp = null;
        if (mode !== "abs") {
          const dpEl = document.querySelector('span.x4z9k3i.xfrs9s4.x1gaeufd.x1mb2qyg.xss6m8b') || smallestMatch(/^\s*(action point\s*)?frame\s*\d+\s*$/i);
          const dpMatch = dpEl ? dpEl.textContent.match(/(\d+)/) : null;
          if (!dpMatch) return { status: "NO_DP" };
          dp = parseInt(dpMatch[1], 10);
        }

        const min = parseFloat(slider.getAttribute("aria-valuemin")) || 0;
        const max = parseFloat(slider.getAttribute("aria-valuemax"));
        const lastFrame = (readTile() || {}).total || toFrame(max);
        const relative = mode === "end" || mode === "offset";
        let targetFrame = mode === "abs" ? Math.min(Math.max(1, win), lastFrame)
          : mode === "start" ? dp
          : Math.min(Math.max(1, dp + win), lastFrame);
        const capped = relative && dp + win > lastFrame;
        // Aim at the CENTRE of the target frame's time cell, never its edge: (targetFrame - 1)/10 is
        // exactly the boundary between two frames, so the tiniest aim bias lands one frame short.
        let targetTime = (targetFrame - 0.5) / 10;

        // Skip the seek only if the playhead is already exactly at the target frame
        const before = parseFloat(slider.getAttribute("aria-valuenow"));
        let frame = currentFrame();
        let landed = frame === targetFrame;

        // Simulates a click on the scrubber at the position for the wanted time.
        // Positions are clamped slightly inside the track: clicking the exact edge
        // (e.g. for the clip's last frame) can miss the slider.
        const clickAt = (t, direct) => {
          const frac = Math.min(Math.max((t - min) / (max - min), 0.002), 0.998);
          const rect = slider.getBoundingClientRect();
          const x = rect.left + frac * rect.width;
          const y = rect.top + rect.height / 2;
          const el = direct ? slider : (document.elementFromPoint(x, y) || slider);
          const p = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true };
          const m = { clientX: x, clientY: y, bubbles: true, cancelable: true };
          el.dispatchEvent(new PointerEvent("pointerdown", { ...p, buttons: 1 }));
          el.dispatchEvent(new MouseEvent("mousedown", { ...m, buttons: 1 }));
          document.dispatchEvent(new PointerEvent("pointermove", { ...p, buttons: 1 }));
          document.dispatchEvent(new MouseEvent("mousemove", { ...m, buttons: 1 }));
          el.dispatchEvent(new PointerEvent("pointerup", { ...p, buttons: 0 }));
          el.dispatchEvent(new MouseEvent("mouseup", m));
        };

        if (!landed) {
          let usedDirect = false; // after a miss, aim the click at the slider element itself
          for (let attempt = 0; attempt < 5 && !landed; attempt++) {
            clickAt(targetTime, usedDirect);
            await sleep(450);
            const now = parseFloat(slider.getAttribute("aria-valuenow"));
            if (isNaN(now)) return { status: "READ_FAIL" };
            if (Math.abs(now - before) < 0.001) {
              if (usedDirect) return { status: "NO_MOVE" };
              usedDirect = true;
              continue;
            }
            frame = await settledFrame();
            // Accept only the exact frame; keep correcting the aim (removes thumb-size bias)
            if (frame === targetFrame) { landed = true; break; }
            targetTime += (targetFrame - frame) / 10;
          }

          // Fine-tune with the keyboard: two neighbouring frames can share the same pixel, so a
          // click sometimes lands one frame short (e.g. 49 frames ahead instead of 50). The scrubber
          // answers arrow keys in single-frame steps, which can hit the exact frame a click can't.
          if (!landed) {
            try { if (typeof slider.focus === "function") slider.focus(); } catch (_) {}
            const readNow = () => parseFloat(slider.getAttribute("aria-valuenow"));
            const pressKey = async (dir) => {
              const code = dir < 0 ? "ArrowLeft" : "ArrowRight";
              const kc = dir < 0 ? 37 : 39;
              const init = { key: code, code: code, keyCode: kc, which: kc, bubbles: true, cancelable: true };
              slider.dispatchEvent(new KeyboardEvent("keydown", init));
              slider.dispatchEvent(new KeyboardEvent("keyup", init));
              await sleep(240);
            };
            const beforeKb = readNow();
            const frameBeforeKb = currentFrame();
            const dir0 = frameBeforeKb < targetFrame ? 1 : -1;
            await pressKey(dir0); // probe: how far does one key press move the playhead?
            const stepFrames = Math.abs((await settledFrame(600)) - frameBeforeKb);
            if (stepFrames === 1) {
              // Single-frame stepping → walk to the exact frame
              let lastF = null, stalls = 0;
              for (let i = 0; i < 60 && !landed; i++) {
                const f = currentFrame();
                if (f === targetFrame) { landed = (await settledFrame(600)) === targetFrame; if (landed) break; continue; }
                if (f === lastF) { if (++stalls >= 2) break; } else stalls = 0; // keys stop working (clip end) → give up
                lastF = f;
                await pressKey(f < targetFrame ? 1 : -1);
              }
            } else if (stepFrames > 1) {
              await pressKey(-dir0); // undo the probe — keys step too coarsely to fine-tune
            }
            if (landed) frame = targetFrame;
            else frame = await settledFrame();
          }
        }

        // Camera capture only needs the picture: let the new frame render, skip the velocity read
        if (quick) {
          await sleep(350);
          frame = await settledFrame(600);
          return { status: "OK", frame, velocity: null, capped, dp, total: lastFrame, offBy: frame === targetFrame ? 0 : frame - targetFrame };
        }

        // Give the telemetry a moment to catch up with the new playhead position
        const readVel = () => {
          const el = findVelEl();
          if (!el) return null;
          const m = el.textContent.match(/Velocity\s*(-?\d+(?:\.\d+)?)\s*m\/s/i);
          return m ? parseFloat(m[1]) : null;
        };
        await sleep(500);
        let velocity = readVel();
        if (velocity === null) { await sleep(700); velocity = readVel(); }
        // Re-read until two consecutive values agree, so we never grab the previous frame's number
        for (let i = 0, prev = velocity; i < 4; i++) {
          await sleep(200);
          const v = readVel();
          if (v === prev) break;
          prev = v; velocity = v;
        }
        // Final verification against the page's own frame tile (the page may have snapped since)
        frame = await settledFrame(600);
        landed = frame === targetFrame;

        // One frame off can't always be helped — tell the panel instead of hiding it
        return { status: "OK", frame, velocity, capped, dp, total: lastFrame, offBy: frame === targetFrame ? 0 : frame - targetFrame };
      }, [mode, win, quick]);
  // One seek at a time: while a seek is running (pageBusy > 0) the autocheck monitor waits,
  // and manual fetches show their own "reading" state instead of racing the player.
  let pageBusy = 0;

  /* ======================================================================================
   * Whole-clip telemetry from the page's own data: GET /api/clips/<id> returns the frame
   * times (frame_offsets_s) and four channels (acceleration, speed, steering angle, brake
   * pedal pct) as timestamped sample lists. Looking a frame up is a calculation, so none of
   * this moves the playhead.
   * ==================================================================================== */
  let series = null;          // { clipId, frameT: number[], ch: { accel, speed, steer, brake } } each { t[], v[], unit }
  let seriesLoading = null;   // { clipId, promise }
  let seriesFail = null;      // { clipId, at } - don't hammer a failing endpoint
  const clipIdOfUrl = (u) => (String(u || "").match(/\/(?:annotate|review)\/([\w-]+)/) || [])[1] || null;
  const CH_MATCH = { accel: /accel/i, speed: /speed|veloc/i, steer: /steer/i, brake: /brake/i };
  const DEFAULT_UNIT = { accel: "m/s²", steer: "°", brake: "%" }; // some channels ship without a unit in the clip record
  const niceUnit = (u) => (/pct|percent|%/i.test(u || "") ? "%" : /deg/i.test(u || "") ? "°" : (u || ""));
  const round2 = (x) => Math.round(x * 100) / 100;

  const loadSeries = async (clipId) => {
    const data = await runOnActiveTab(async (id) => {
      const ids = [id];
      try { // the clip's real id may differ from the URL's on some pages: also try the one the page itself requested
        for (const r of performance.getEntriesByType("resource")) {
          const m = r.name.match(/\/api\/clips\/([\w-]+)(?:[?]|$)/);
          if (m && !ids.includes(m[1])) ids.push(m[1]);
        }
      } catch (_) {}
      let last = "no clip id";
      for (const cid of ids.slice(0, 3)) {
        try {
          const r = await fetch("/api/clips/" + encodeURIComponent(cid), { credentials: "same-origin" });
          if (!r.ok) { last = "HTTP " + r.status; continue; }
          const j = await r.json();
          if (!Array.isArray(j.telemetry) || !j.telemetry.length) { last = "no telemetry in the clip record"; continue; }
          return {
            frame_offsets_s: j.frame_offsets_s || [],
            telemetry: j.telemetry.map((c) => ({ channel: c.channel, name: c.display_name, unit: c.unit, quality: c.quality, t: c.offsets_s || [], v: c.values || [] }))
          };
        } catch (e) { last = String((e && e.message) || e); }
      }
      return { error: last };
    }, [clipId]);
    if (!data || data.error || !data.telemetry) return null;
    const ch = {};
    for (const [k, rx] of Object.entries(CH_MATCH)) {
      const c = data.telemetry.find((x) => rx.test(x.channel || "") || rx.test(x.name || ""));
      if (c && c.t.length && c.t.length === c.v.length) ch[k] = { t: c.t, v: c.v, unit: niceUnit(c.unit) || DEFAULT_UNIT[k], quality: c.quality };
    }
    return { clipId, frameT: data.frame_offsets_s, ch };
  };

  // Never rejects, never waits more than ~4 s: the speed reading must not depend on this
  const ensureSeries = async () => {
    try {
      const tab = await getActiveTab().catch(() => null);
      const id = tab && clipIdOfUrl(tab.url);
      if (!id) return null;
      if (series && series.clipId === id) return series;
      if (seriesFail && seriesFail.clipId === id && Date.now() - seriesFail.at < 20000) return null;
      if (!(seriesLoading && seriesLoading.clipId === id)) {
        const promise = loadSeries(id).then((r) => {
          if (r) { series = r; seriesFail = null; } else seriesFail = { clipId: id, at: Date.now() };
          return r;
        }).catch(() => { seriesFail = { clipId: id, at: Date.now() }; return null; })
          .finally(() => { if (seriesLoading && seriesLoading.clipId === id) seriesLoading = null; });
        seriesLoading = { clipId: id, promise };
      }
      return await Promise.race([seriesLoading.promise, sleep(4000).then(() => null)]);
    } catch (_) { return null; }
  };

  // Linear interpolation of a channel at time t (null outside the channel's coverage)
  const interp = (c, t) => {
    const T = c.t, V = c.v, n = T.length;
    if (!n || t == null || !isFinite(t)) return null;
    const step = n > 1 ? (T[n - 1] - T[0]) / (n - 1) : 0.1;
    if (t < T[0] - step / 2 || t > T[n - 1] + step / 2) return null;
    if (t <= T[0]) return V[0];
    if (t >= T[n - 1]) return V[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; }
    const f = (t - T[lo]) / ((T[hi] - T[lo]) || 1);
    return V[lo] + (V[hi] - V[lo]) * f;
  };
  const frameTime = (f) => (series && f != null && series.frameT[f - 1] != null ? series.frameT[f - 1] : null); // page frame numbers are 1-based

  // { accel, steer, brake } at a frame, each { v, unit } | null  (null altogether when there is no data)
  const seriesExtras = (frame) => {
    const t = frameTime(frame);
    if (t == null) return null;
    const out = {};
    for (const k of ["accel", "steer", "brake"]) {
      const c = series.ch[k];
      const v = c ? interp(c, t) : null;
      out[k] = v == null ? null : { v: round2(v), unit: c.unit };
    }
    return out.accel || out.steer || out.brake ? out : null;
  };

  // Extremes between two frames (inclusive): hardest braking (lowest acceleration), peak brake pedal, steering range
  const windowStats = (f0, f1) => {
    const t0 = frameTime(f0), t1 = frameTime(f1);
    if (!series || t0 == null || t1 == null || t1 < t0) return null;
    const vals = (c) => {
      const o = [];
      for (let i = 0; i < c.t.length; i++) if (c.t[i] >= t0 && c.t[i] <= t1) o.push(c.v[i]);
      for (const t of [t0, t1]) { const x = interp(c, t); if (x != null) o.push(x); }
      return o;
    };
    const res = {};
    if (series.ch.accel) { const a = vals(series.ch.accel); if (a.length) { res.accelMin = round2(Math.min(...a)); res.accelMax = round2(Math.max(...a)); res.accelUnit = series.ch.accel.unit; } }
    if (series.ch.brake) { const b = vals(series.ch.brake); if (b.length) { res.brakeMax = round2(Math.max(...b)); res.brakeUnit = series.ch.brake.unit; } }
    if (series.ch.steer) { const d = vals(series.ch.steer); if (d.length) { res.steerMin = round2(Math.min(...d)); res.steerMax = round2(Math.max(...d)); res.steerUnit = series.ch.steer.unit; } }
    if (series.ch.speed) { const s = vals(series.ch.speed); if (s.length) { res.speedMin = round2(Math.min(...s)); res.speedMax = round2(Math.max(...s)); res.speedUnit = series.ch.speed.unit; } }
    return Object.keys(res).length ? res : null;
  };

  // The ~2 s of clip BEFORE the action point: the window the Description describes. Expressed in
  // time (not a fixed frame count), so it is correct on slow clips too.
  const HISTORY_SECS = 2;
  const historyFrame = (dp) => {
    if (!series || !series.frameT.length || dp == null) return null;
    const lastF = series.frameT.length;
    const f0 = Math.min(Math.max(1, dp), lastF);
    const t = frameTime(f0);
    if (t == null) return null;
    let f = f0;
    while (f > 1 && frameTime(f - 1) != null && frameTime(f - 1) > t - HISTORY_SECS) f--;
    return f;
  };
  const historyStats = (dp) => { const f = historyFrame(dp); return f != null ? windowStats(f, dp) : null; };

  // Exposed to the whole file (review mode / audit): whole-clip telemetry without seeking.
  telemetryRef = {
    ensure: ensureSeries,
    extrasAt: seriesExtras,
    stats: windowStats,
    frameTime,
    historyFrame,
    historyStats,
    speedAt: (f) => { const t = frameTime(f); const c = series && series.ch.speed; return c ? interp(c, t) : null; },
    series: () => series
  };

  // Console check that the data matches the page's own Velocity tile (filter the console on "VLA telemetry")
  const verifyAgainstTile = (res) => {
    try {
      if (!series || !series.ch.speed || res.velocity == null || res.frame == null) return;
      const v = interp(series.ch.speed, frameTime(res.frame));
      if (v == null) return;
      console.log(`[VLA telemetry] frame ${res.frame}: page tile ${res.velocity} m/s vs clip data ${Math.round(v * 1000) / 1000} m/s (diff ${Math.round((v - res.velocity) * 1000) / 1000})`);
    } catch (_) {}
  };

  /* ---- shown under End Speed: the same summarized cross-check format as the review card —
   * one row per channel (speed, acceleration, steering, brake), each checked against the
   * calculator's own recommendation where a verdict is possible, and a channel the clip has
   * no data for is named as "no data in this clip" instead of being silently dropped. ---- */
  const telem = { start: null, end: null, window: null, read: false };
  const TELEM_ROWS = [["accel", "Acceleration"], ["steer", "Steering angle"], ["brake", "Brake pedal"]];
  const renderTelemetry = () => {
    const box = $("calc-telemetry");
    if (!box) return;
    if (!telem.read) { box.hidden = true; box.innerHTML = ""; return; }
    const has = (k) => !!((telem.start && telem.start[k]) || (telem.end && telem.end[k])
      || (telem.window && ((k === "accel" && telem.window.accelMin != null) || (k === "steer" && telem.window.steerMin != null) || (k === "brake" && telem.window.brakeMax != null))));
    const val = (x) => (x ? String(x.v) : "—");
    const unit = (k) => { const u = (telem.end && telem.end[k] && telem.end[k].unit) || (telem.start && telem.start[k] && telem.start[k].unit) || ""; return u ? (/^[°%]$/.test(u) ? u : " " + u) : ""; };
    const s = parseFloat($("calc-start").value), en = parseFloat($("calc-end").value);
    const rows = [];
    // Speed: the measured change and the recommendation it produces
    if (!isNaN(s) && !isNaN(en)) {
      const d = Math.round((en - s) * 100) / 100;
      rows.push({ ok: null, text: "Speed: " + s + " → " + en + " m/s (Δ " + (d > 0 ? "+" : "") + d + ")" + (currentSuggestion ? " → " + currentSuggestion : "") });
    }
    // Acceleration / brake verdicts against the recommendation (same rules as the review card)
    const av = accelVerdictFor(currentSuggestion, telem.window);
    if (av) rows.push(av);
    const bv = brakeVerdictFor(currentSuggestion, telem.window);
    if (bv) rows.push(bv);
    for (const [k, label] of TELEM_ROWS) {
      if (!has(k)) { rows.push({ ok: null, text: label + ": no data in this clip" }); continue; }
      if ((k === "accel" && av) || (k === "brake" && bv)) continue; // already shown as a verdict row
      if (k === "accel" && telem.window && telem.window.accelMin != null) {
        rows.push({ ok: null, text: "Acceleration: " + telem.window.accelMin + " … " + telem.window.accelMax + (telem.window.accelUnit ? " " + telem.window.accelUnit : "") });
        continue;
      }
      rows.push({ ok: null, text: label + ": " + val(telem.start && telem.start[k]) + " → " + val(telem.end && telem.end[k]) + unit(k) });
    }
    box.hidden = false;
    box.innerHTML = '<div class="tele-title">Telemetry · action point → end</div>' + rows.map((v) => {
      const mark = v.ok === true ? '<span style="color:#16a34a">✓</span>' : v.ok === false ? '<span style="color:#ef4444">✗</span>' : '<span style="color:var(--text-muted)">❔</span>';
      return '<div class="tele-row" style="display:block; text-align:left">' + mark + '&nbsp; <span style="font-weight:600">' + escapeHTML(v.text) + "</span></div>";
    }).join("");
  };
  const setTelem = (which, extras) => { telem[which] = extras || null; telem.read = true; renderTelemetry(); };
  const setWindow = (f0, f1) => { telem.window = windowStats(f0, f1); renderTelemetry(); };
  let lastLiveExtras = "";
  const seekAndRead = async (mode, win, quick = false) => {
    pageBusy++;
    try {
      const loading = quick ? null : ensureSeries(); // fetched while the player seeks, so it costs no extra time
      const res = await seekAndReadRaw(mode, win, quick);
      if (!quick && res && res.status === "OK") {
        await loading;
        if (res.frame != null) res.extras = seriesExtras(res.frame);
        verifyAgainstTile(res);
      }
      return res;
    } finally { pageBusy--; }
  };
  seekAndReadRef = seekAndRead; // the camera capture (outside init) seeks with the same, verified routine

  const fetchVelocityFromPage = async (targetInputId, btn) => {
    if (ac.running) { notify(AUTOCHECK_RUNNING_MSG); return; }
    const originalText = btn.textContent;
    setBtnLabel(btn, "Seeking...");
    btn.disabled = true;

    try {
      const res = await seekAndRead(targetInputId === "calc-start" ? "start" : "end", frameWindow);
      if (res?.status === "OK" && res.velocity !== null && res.velocity !== undefined) {
        $(targetInputId).value = res.velocity;
        $(targetInputId).dispatchEvent(new Event("input", { bubbles: true }));
        if (targetInputId === "calc-start" && res.dp != null) knownStart = { url: lastClipUrl, dp: res.dp, speed: res.velocity };
        setTelem(targetInputId === "calc-start" ? "start" : "end", res.extras);
        if (res.capped) calcFlash(btn, `Read ✓ (last frame ${res.frame})`, COLOR.ok, originalText, 3000);
        else if (res.offBy) calcFlash(btn, `Read ✓ (frame ${res.frame}, off by ${Math.abs(res.offBy)})`, COLOR.warn, originalText, 4000);
        else calcFlash(btn, `Read ✓ (frame ${res.frame})`, COLOR.ok, originalText);
      } else if (res?.status === "OK") {
        calcFlash(btn, "No velocity shown", COLOR.warn, originalText, 3000);
      } else if (res?.status === "NO_MOVE") {
        calcFlash(btn, "Couldn't move player", COLOR.err, originalText, 3000);
        notify("The page's scrubber did not respond to the automated click.");
      } else if (res?.status === "NO_DP") {
        calcFlash(btn, "Action point not found", COLOR.warn, originalText, 3000);
      } else if (res?.status === "READ_FAIL") {
        calcFlash(btn, "Player not readable", COLOR.err, originalText, 3000);
      } else {
        calcFlash(btn, "Player not found", COLOR.err, originalText, 3000);
      }
    } catch (err) {
      notify(escapeHTML(err.message));
      calcFlash(btn, "Error", COLOR.err, originalText, 3000);
    } finally {
      btn.disabled = false;
    }
  };

  document.querySelectorAll(".calc-fetch-speed-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => fetchVelocityFromPage(e.currentTarget.dataset.target, e.currentTarget));
  });

  /* Fetch Both — one click reads the start speed at the action point and the end
   * speed +window frames later, then fills everything in */
  const FETCH_ERRORS = {
    NO_SLIDER: "Player not found on the page.",
    NO_DP: "Action point not found on the page.",
    NO_MOVE: "The page's scrubber did not respond to the automated click.",
    READ_FAIL: "Player not readable."
  };

  const fetchBothSpeeds = async (btn) => {
    const DEFAULT_LABEL = btn.textContent;
    if (ac.running) { notify(AUTOCHECK_RUNNING_MSG); return; }
    if (!frameWindow) {
      notify("Pick a frames-ahead window first (10–50) — Fetch Both needs it to know where to read the end speed.");
      calcFlash(btn, "Pick a window first", COLOR.warn, DEFAULT_LABEL, 3000);
      return;
    }
    btn.disabled = true;

    try {
      // Same action point and an untouched start speed → skip the trip back to the action point
      let reuse = false;
      try {
        const pg = await readPageState();
        reuse = !!(knownStart && pg && pg.dp !== null && knownStart.url === lastClipUrl && knownStart.dp === pg.dp &&
                   String(knownStart.speed) === $("calc-start").value.trim());
      } catch (_) {}

      let startRes;
      if (reuse) {
        startRes = { status: "OK", velocity: knownStart.speed, dp: knownStart.dp };
      } else {
        setBtnLabel(btn, "Reading start speed...");
        startRes = await seekAndRead("start", frameWindow);
        if (startRes?.status !== "OK" || startRes.velocity === null || startRes.velocity === undefined) {
          throw new Error(FETCH_ERRORS[startRes?.status] || "Could not read the start speed.");
        }
        if (startRes.dp != null) knownStart = { url: lastClipUrl, dp: startRes.dp, speed: startRes.velocity };
      }

      setBtnLabel(btn, reuse ? "Reading end speed (start kept)..." : "Reading end speed...");
      const endRes = await seekAndRead("end", frameWindow);
      if (endRes?.status !== "OK" || endRes.velocity === null || endRes.velocity === undefined) {
        throw new Error(FETCH_ERRORS[endRes?.status] || "Could not read the end speed.");
      }

      if (!reuse) setTelem("start", startRes.extras);
      setTelem("end", endRes.extras);
      setWindow(startRes.dp != null ? startRes.dp : (knownStart && knownStart.dp), endRes.frame);
      $("calc-start").value = startRes.velocity;
      $("calc-end").value = endRes.velocity;
      $("calc-diff").value = (endRes.velocity - startRes.velocity).toFixed(2);
      // isTrusted=false → keeps the speeds, recomputes the suggestion with them
      $("calc-diff").dispatchEvent(new Event("input", { bubbles: true }));
      saveCalcState();

      // Report any landing imprecision instead of hiding it
      const notes = [];
      if (endRes.capped) notes.push(`end capped at last frame ${endRes.frame}`);
      if (startRes.offBy) notes.push(`start off by ${Math.abs(startRes.offBy)}`);
      if (endRes.offBy) notes.push(`end off by ${Math.abs(endRes.offBy)}`);
      if (notes.length) calcFlash(btn, `Read ✓ (${notes.join(", ")})`, COLOR.warn, DEFAULT_LABEL, 4000);
      else calcFlash(btn, "Both read ✓", COLOR.ok, DEFAULT_LABEL);
    } catch (err) {
      notify(escapeHTML(err.message));
      const hint = $("calc-hint");
      if (hint) { const old = hint.textContent; hint.textContent = "⚠ " + err.message; setTimeout(() => { hint.textContent = old; }, 8000); }
      calcFlash(btn, "Fetch failed", COLOR.err, DEFAULT_LABEL, 3000);
    } finally {
      btn.disabled = false;
    }
  };

  $("calc-fetch-both-btn").addEventListener("click", (e) => fetchBothSpeeds(e.currentTarget));

  /* Suggestion from the Δ calculation — mirrors the annotation page's 7 speed-change
   * options (Maintain speed, Accelerate, Decelerate, Stop, Remain stopped,
   * Resume motion). "Strong decelerate" is no longer recommended. */
  // Decision thresholds — adjustable via ⚙ Thresholds in the calculator view, persisted in chrome.storage
  const DEFAULT_THRESHOLDS = { nearStop: 0.3, stopDrop: 0.1, maintainBand: 0.8 };
  let THR = { ...DEFAULT_THRESHOLDS };

  const calcUpdateSuggestion = (start, end, diff) => {
    const s = parseFloat(start);
    const e = parseFloat(end);
    const d = isNaN(diff) ? (isNaN(s) || isNaN(e) ? NaN : e - s) : diff;

    let sugg;
    if (!isNaN(s) && !isNaN(e)) {
      // Both speeds known → full decision tree over the 6 options
      if (s <= THR.nearStop && e <= THR.nearStop) sugg = (s - e) >= THR.stopDrop ? "Stop" : "Remain stopped"; // speed still dropping = stop completed here; unchanged = already stopped
      else if (s <= THR.nearStop) sugg = "Resume motion";                 // stopped → moving
      else if (e <= THR.nearStop) sugg = "Stop";                          // moving → stopped
      else if (d >= THR.maintainBand) sugg = "Accelerate";
      else if (d <= -THR.maintainBand) sugg = "Decelerate";
      else sugg = "Maintain speed";
    } else {
      // Only Δ typed — stop/resume states can't be detected without the actual speeds
      sugg = "Maintain speed";
      if (d >= THR.maintainBand) sugg = "Accelerate";
      else if (d <= -THR.maintainBand) sugg = "Decelerate";
    }

    const suggEl = $("calc-suggestion");
    suggEl.textContent = sugg;
    if (sugg === "Accelerate" || sugg === "Resume motion") suggEl.style.color = "var(--alert-success-border)";
    else if (sugg === "Stop") suggEl.style.color = "var(--alert-warning-border)";
    else if (sugg === "Decelerate") suggEl.style.color = "#f59e0b";
    else suggEl.style.color = "var(--text-main)";

    currentSuggestion = sugg;

    const applyPageBtn = $("calc-apply-page-btn");
    applyPageBtn.style.display = "block";
    applyPageBtn.dataset.val = sugg;
  };

  /* AI speed check (💬 AI Chat): the chat model can request a measurement by ending its
   * reply with <<<SPEED_CHECK>>> (default 50 frames) or <<<SPEED_CHECK 20>>> for any
   * window below 50 on the user's request. The panel then runs the calculator's OWN check
   * (runAutocheck) over that window, capped at the clip's last frame when the clip is
   * shorter, and returns the measured numbers + the calculator's suggestion for the model
   * to interpret. aiSuggestion is only a fallback. */
  const aiSuggestion = (s, e) => {
    const d = e - s;
    if (s <= THR.nearStop && e <= THR.nearStop) return (s - e) >= THR.stopDrop ? "Stop" : "Remain stopped";
    if (s <= THR.nearStop) return "Resume motion";
    if (e <= THR.nearStop) return "Stop";
    if (d >= THR.maintainBand) return "Accelerate";
    if (d <= -THR.maintainBand) return "Decelerate";
    return "Maintain speed";
  };
  aiSpeedCheckRef = async (frames, opts) => {
    // Default 50 frames; any value below 50 on the user's request, never 50 or more.
    const n = typeof frames === "number" && frames >= 1 && frames < AI_SPEED_WINDOW_DEFAULT ? frames : AI_SPEED_WINDOW_DEFAULT;
    if (ac.running || pageBusy) return { ok: false, msg: "A speed check is already reading the clip — try again in a moment." };
    // Same first step as the autocheck monitor: read the page state (no seeking) for the
    // action point and the clip's total, with the same readiness handling.
    let st;
    try { st = await readPageState(); }
    catch (e) { return { ok: false, msg: "Can't read the annotation page yet. Open the clip in the active tab and try again." }; }
    if (!st || !st.ready) return { ok: false, msg: "The clip is still loading — try again in a moment." };
    if (st.dp === null) return { ok: false, msg: "No action point is selected in this clip. Pick one on the page first, then ask again." };

    // NO-SEEK MODE (read-only / review clips): everything comes from the clip's own telemetry
    // API — the playhead is never moved. Needs the speed channel in the clip record.
    if (opts && opts.noSeek) {
      const s0 = await ensureSeries();
      if (!s0 || !s0.ch || !s0.ch.speed) return { ok: false, msg: "No telemetry data for this clip (the clip record has no speed channel)." };
      const lastFrame = s0.frameT.length;
      if (!lastFrame) return { ok: false, msg: "No frame times in the clip record." };
      const f0 = Math.min(Math.max(1, st.dp), lastFrame);
      const f1 = Math.min(st.dp + n, lastFrame);
      const v0 = interp(s0.ch.speed, frameTime(f0)), v1 = interp(s0.ch.speed, frameTime(f1));
      if (v0 == null || v1 == null) return { ok: false, msg: "The clip's telemetry does not cover the action point." };
      const s = round2(v0), e = round2(v1);
      try { console.log(`[VLA telemetry] no-seek read: frames ${f0}→${f1}, ${s} → ${e} m/s (playhead not moved)`); } catch (_) {}
      return {
        ok: true,
        noSeek: true, // the playhead was never moved
        startSpeed: s, endSpeed: e,
        delta: Math.round((e - s) * 100) / 100,
        startFrame: f0, endFrame: f1,
        actionPoint: st.dp, totalFrames: lastFrame,
        windowFrames: Math.max(1, f1 - f0),
        capped: f1 < st.dp + n,
        extras: { start: seriesExtras(f0), end: seriesExtras(f1), window: windowStats(f0, f1) },
        history: historyStats(st.dp),
        suggestion: aiSuggestion(s, e)
      };
    }

    // Keep ac.url current even when the calculator view has never been opened (the monitor
    // normally does this), so the reuse check and the ac_done persistence key off the right clip.
    const prevUrl = ac.url;
    const clipTab = await getActiveTab().catch(() => null);
    if (clipTab && clipTab.url && !isRestrictedUrl(clipTab.url)) ac.url = stripHash(clipTab.url);

    // SAME CLIP + SAME ACTION POINT + SAME WINDOW as an earlier run: the speeds at those frames
    // cannot change, so reuse that first reading instead of seeking the playhead again.
    const lr0 = ac.lastResult;
    if (lr0 && !lr0.gaveUp && prevUrl === ac.url && ac.dpDone === st.dp && ac.doneN === n) {
      await ensureSeries(); // for the history-window stats below (cheap when already loaded)
      const s = lr0.start, e = lr0.end;
      return {
        ok: true,
        reused: true, // no new seek happened — the first run's reading is returned as-is
        startSpeed: s, endSpeed: e,
        delta: Math.round((e - s) * 100) / 100,
        startFrame: lr0.dp, endFrame: lr0.dp + lr0.gotN,
        actionPoint: lr0.dp, totalFrames: lr0.total,
        windowFrames: lr0.gotN, // frames actually checked (smaller than 50 when the clip is shorter)
        capped: lr0.capped,
        extras: { start: lr0.startExtras || null, end: lr0.endExtras || null, window: lr0.windowStats || null },
        history: historyStats(lr0.dp),
        suggestion: aiSuggestion(s, e) // recomputed from the same numbers — always in sync
      };
    }

    // Then run the calculator's OWN check (runAutocheck): its start/end reads, full-window
    // verification, short-clip proof (capped readings accepted only when the timeline was
    // already that short and stayed stable), slow-clip retries and the real suggestion logic.
    // The window is forced to 50 frames for this measurement (the user's pill is restored
    // afterwards); a clip shorter than that caps the reading at its last frame.
    const savedWindow = frameWindow, savedDeselected = windowDeselected;
    frameWindow = n;
    windowDeselected = false;
    ac.dpDone = null; ac.doneN = null; ac.final = null; ac.force = true;
    ac.inexact = 0; ac.sameTotal = 0; ac.lastTotal = null;
    ac.preTotal = st.total != null ? st.total : null; // short-clip proof: the total BEFORE the check ran (same as the monitor)
    ac.lastResult = null;
    try {
      setActiveWindowBtn(); updateHint();
      await runAutocheck(st.dp, false);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await sleep(250);
        if (ac.running) continue;
        if (ac.dpDone === st.dp && ac.doneN === n && ac.lastResult) break; // complete reading
        if (ac.final || ac.paused) break; // gave up / no telemetry / clip too slow
        if (Date.now() >= ac.nextTry) await runAutocheck(st.dp, false); // drive the retry when no monitor does it
      }
      const lr = ac.lastResult;
      if (lr && !lr.gaveUp) {
        await ensureSeries(); // for the history-window stats below (cheap when already loaded)
        const s = lr.start, e = lr.end;
        return {
          ok: true,
          startSpeed: s, endSpeed: e,
          delta: Math.round((e - s) * 100) / 100,
          startFrame: lr.dp, endFrame: lr.dp + lr.gotN,
          actionPoint: lr.dp, totalFrames: lr.total,
          windowFrames: lr.gotN, // frames actually checked (smaller than 50 when the clip is shorter)
          capped: lr.capped,
          extras: { start: lr.startExtras || null, end: lr.endExtras || null, window: lr.windowStats || null },
          history: historyStats(lr.dp),
          suggestion: currentSuggestion || aiSuggestion(s, e) // the calculator's own suggestion
        };
      }
      if (ac.final) return { ok: false, msg: "The calculator couldn't take a reliable reading: " + ac.final.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() };
      return { ok: false, msg: "The speed check didn't finish in time — the clip may still be loading. Try again in a moment." };
    } finally {
      frameWindow = savedWindow; windowDeselected = savedDeselected; // give the user their pill back
      setActiveWindowBtn(); updateHint();
    }
  };

  const handleCalcInput = (e) => {
    if (e.target.id === "calc-diff" && e.isTrusted) {
      $("calc-start").value = "";
      $("calc-end").value = "";
    } else if (e.target.id === "calc-start" || e.target.id === "calc-end") {
      const s = parseFloat($("calc-start").value);
      const eVal = parseFloat($("calc-end").value);
      if (!isNaN(s) && !isNaN(eVal)) {
        $("calc-diff").value = (eVal - s).toFixed(2);
      }
    }

    const diff = parseFloat($("calc-diff").value);
    if (!isNaN(diff)) {
      calcUpdateSuggestion($("calc-start").value, $("calc-end").value, diff);
    } else {
      $("calc-suggestion").textContent = "—";
      $("calc-apply-page-btn").style.display = "none";
      currentSuggestion = null;
    }
    saveCalcState();
  };

  $("calc-start").addEventListener("input", handleCalcInput);
  $("calc-end").addEventListener("input", handleCalcInput);
  $("calc-diff").addEventListener("input", handleCalcInput);

  /* Apply speed change to the page (opens the speed-change dropdown and picks the option) */
  const applySpeedToPage = async (speedLabel, btn) => {
    const originalText = btn.textContent;
    setBtnLabel(btn, "⏳...");
    btn.disabled = true;

    try {
      if (state.isReadOnly) throw new Error("readonly");

      const result = await runOnActiveTab(async (label, speedValues) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

        const getListbox = (trigger) => {
          const id = trigger.getAttribute("aria-controls");
          return (id && document.getElementById(id)) || document.querySelector('[role="listbox"]:not([hidden])');
        };

        // Options are leaf elements inside the listbox; match the wanted label exactly first
        const pickOption = (listbox) => {
          const leaves = [...listbox.querySelectorAll("*")].filter((el) => el.childElementCount === 0 && el.textContent.trim());
          return leaves.find((el) => norm(el.textContent) === norm(label)) ||
                 leaves.find((el) => norm(el.textContent).startsWith(norm(label)));
        };

        const openAndPick = async (trigger) => {
          trigger.click();
          for (let i = 0; i < 25; i++) {
            await sleep(100);
            const listbox = getListbox(trigger);
            if (!listbox || listbox.childElementCount === 0) continue;
            const target = pickOption(listbox);
            if (!target) continue;
            target.click();
            return { status: "SUCCESS" };
          }
          // Option not found; close the dropdown again
          trigger.click();
          return { status: "OPTION_NOT_FOUND" };
        };

        const buttons = [...document.querySelectorAll('button[aria-haspopup="listbox"]')];

        // 1) The speed-change dropdown is the one already showing a speed value (e.g. "Strong decelerate")
        const active = buttons.find((b) => speedValues.some((v) => norm(b.textContent) === norm(v)));
        if (active) {
          if (norm(active.textContent) === norm(label)) return { status: "ALREADY_SET" };
          return openAndPick(active);
        }

        // 2) Otherwise probe the unset ("Choose…") dropdowns: open each and keep the one
        //    whose options contain the speed menu (e.g. "Maintain speed", "Strong decelerate", ...)
        for (const b of buttons) {
          if (norm(b.textContent) !== "choose…") continue;
          b.click();
          let verdict = null;
          for (let i = 0; i < 25; i++) {
            await sleep(100);
            const listbox = getListbox(b);
            if (!listbox || listbox.childElementCount === 0) continue;
            const texts = [...listbox.querySelectorAll("*")]
              .filter((el) => el.childElementCount === 0 && el.textContent.trim())
              .map((el) => norm(el.textContent));
            const hits = speedValues.filter((v) => texts.includes(norm(v))).length;
            if (hits >= 4) {
              const target = pickOption(listbox);
              if (target) { target.click(); return { status: "SUCCESS" }; }
              verdict = "OPTION_NOT_FOUND";
            }
            break;
          }
          // Close this dropdown before moving to the next candidate
          b.click();
          if (verdict === "OPTION_NOT_FOUND") return { status: "OPTION_NOT_FOUND" };
        }
        return { status: "NOT_FOUND" };
      }, [speedLabel, SPEEDS]);

      const status = result?.status;
      if (status === "SUCCESS") calcFlash(btn, "Applied ✓", COLOR.ok, originalText);
      else if (status === "ALREADY_SET") calcFlash(btn, "Already set ✓", COLOR.ok, originalText);
      else if (status === "NOT_FOUND") calcFlash(btn, "Dropdown not found", COLOR.err, originalText, 3000);
      else calcFlash(btn, "Option not found", COLOR.err, originalText, 3000);
    } catch (err) {
      if (err.message === "readonly") calcFlash(btn, "Clip is read only", COLOR.err, originalText, 3000);
      else {
        notify(escapeHTML(err.message));
        calcFlash(btn, "Error", COLOR.err, originalText, 3000);
      }
    } finally {
      btn.disabled = false;
    }
  };

  $("calc-apply-page-btn").addEventListener("click", (e) => {
    const val = e.currentTarget.dataset.val;
    if (val) applySpeedToPage(val, e.currentTarget);
  });

  /* Choice checker (watches the page's speed-change dropdown) */
  function setChoiceStatus(html, colorVar) {
    const el = $("calc-choice-status");
    el.innerHTML = html;
    el.style.display = "block";
    el.style.color = colorVar || "var(--text-muted)";
  }

  const readChosenSpeed = async () => {
    try {
      return await runOnActiveTab((speedValues) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const buttons = [...document.querySelectorAll('button[aria-haspopup="listbox"]')];
        // The speed-change dropdown is the one currently showing a speed value
        const active = buttons.find((b) => speedValues.some((v) => norm(b.textContent) === norm(v)));
        return active ? norm(active.textContent) : null;
      }, [SPEEDS]);
    } catch (_) {
      return undefined; // annotation page not open / not readable right now
    }
  };

  const updateChoiceStatus = async () => {
    const chosen = await readChosenSpeed();
    if (chosen === undefined) {
      $("calc-choice-status").style.display = "none";
      return;
    }

    if (!chosen) {
      setChoiceStatus("Chosen on page: <em>not chosen yet</em>", "var(--text-muted)");
      return;
    }

    const label = SPEEDS.find((v) => norm(v) === chosen) || chosen;

    if (!currentSuggestion) {
      setChoiceStatus(`Chosen on page: <strong>${escapeHTML(label)}</strong> — no recommendation yet`, "var(--text-muted)");
      return;
    }

    if (norm(chosen) === norm(currentSuggestion)) {
      setChoiceStatus(`✓ <strong>${escapeHTML(label)}</strong> — matches the recommendation`, "var(--alert-success-border)");
    } else {
      setChoiceStatus(`✗ <strong>${escapeHTML(label)}</strong> — recommendation is <strong>${escapeHTML(currentSuggestion)}</strong>`, "var(--alert-warning-border)");
    }
  };

  setInterval(updateChoiceStatus, 1500);
  updateChoiceStatus();

  /* State persistence: values survive a page refresh, a new clip clears them */
  const pageKey = (u) => (u || "").split("#")[0];

  function clearCalcInputs() {
    $("calc-start").value = "";
    $("calc-end").value = "";
    $("calc-diff").value = "";
    $("calc-suggestion").textContent = "—";
    $("calc-suggestion").style.color = "var(--text-main)";
    $("calc-apply-page-btn").style.display = "none";
    $("calc-apply-page-btn").dataset.val = "";
    currentSuggestion = null;
    telem.start = telem.end = telem.window = null; telem.read = false; lastLiveExtras = ""; renderTelemetry();
  }

  function saveCalcState() {
    if (!lastClipUrl) return;
    chrome.storage.local.set({
      calc_state: {
        url: lastClipUrl,
        start: $("calc-start").value,
        end: $("calc-end").value,
        diff: $("calc-diff").value
      }
    }).catch(() => {});
  }

  async function initClipTracking() {
    // Restore the values saved for this clip (survives page refreshes and panel closes)
    const tab = await getActiveTab().catch(() => null);
    lastClipUrl = tab ? pageKey(tab.url) : null;

    const { calc_state } = (await chrome.storage.local.get("calc_state").catch(() => ({}))) || {};
    if (calc_state && calc_state.url === lastClipUrl) {
      if (calc_state.start !== undefined) $("calc-start").value = calc_state.start;
      if (calc_state.end !== undefined) $("calc-end").value = calc_state.end;
      if (calc_state.diff !== undefined) $("calc-diff").value = calc_state.diff;
      const s = parseFloat($("calc-start").value);
      const eVal = parseFloat($("calc-end").value);
      if (!isNaN(s) && !isNaN(eVal)) $("calc-diff").value = (eVal - s).toFixed(2);
      const diff = parseFloat($("calc-diff").value);
      if (!isNaN(diff)) calcUpdateSuggestion($("calc-start").value, $("calc-end").value, diff);
    }

    // Watch for clip changes: switching to a different clip clears the data
    setInterval(async () => {
      const tab = await getActiveTab().catch(() => null);
      if (!tab || !tab.url || isRestrictedUrl(tab.url)) return;
      const url = pageKey(tab.url);
      if (url !== lastClipUrl) {
        lastClipUrl = url;
        clearCalcInputs();
        saveCalcState();
      }
    }, 1500);
  }
  initClipTracking();

  /* ====================================================================
   * Autocheck + live tracking (from the standalone Speed Calculator)
   *
   * Settings (Settings view / options page) -> chrome.storage "autocheck_settings" { enabled, frames }.
   * Runs only while the calculator view is open, so the page's playhead is never moved
   * behind your back while you work in another view. One monitor loop watches the
   * annotation page and drives everything:
   *   - clip still loading / slow        -> warn, keep rechecking automatically
   *   - no action point selected         -> warn, run as soon as one is picked
   *   - action point found               -> read start speed + speed N frames later, fill the calculator
   *   - no velocity shown (no telemetry) -> tell the user
   *   - afterwards                       -> End Speed / Speed Difference / recommendation update in realtime from the action point (forward only)
   * ==================================================================== */
  let knownStart = null; // { url, dp, speed }: the start speed already read for this action point
  const AUTOCHECK_RUNNING_MSG = "Autocheck is reading the clip right now — try again in a moment.";
  const DEFAULT_AC = { enabled: true, frames: 50 };
  let AC = { ...DEFAULT_AC };

  const AC_TICK_MS = 800;
  const SLOW_RETRY_LIMIT = 8;
  const INEXACT_RETRY_LIMIT = 12;  // attempts to read the FULL frames-ahead window before accepting what the clip gives
  const SHORT_CLIP_CONFIRMS = 3;   // same last frame seen this many times in a row (when capped) -> the clip really is that short

  const ac = {
    url: null,        // clip the monitor is currently looking at
    dpDone: null,     // action-point frame that has already been autochecked
    doneN: null,      // frames-ahead window that the finished check used (a different pill triggers a new check)
    restored: null,   // {url, dp} saved before the panel was last closed
    running: false,   // an autocheck is seeking right now
    final: null,      // {kind, html} message to keep showing once the check finished
    slowTicks: 0,     // consecutive monitor ticks where the player wasn't ready
    slowFails: 0,     // consecutive autocheck attempts that failed because the page was slow
    noDpTicks: 0,     // consecutive ticks with the player ready but no action point
    nextTry: 0,       // timestamp before which a slow-clip retry is not attempted
    paused: false,    // gave up after SLOW_RETRY_LIMIT failures until "Recheck" is pressed
    force: false,     // the user asked for a check (frames-ahead pill) even though the action point changed
    inexact: 0,       // consecutive checks that could not read the full frames-ahead window (clip still loading)
    lastTotal: null,  // last frame of the clip seen by the previous inexact check
    sameTotal: 0,     // how many inexact checks in a row saw that same last frame
    preTotal: null    // the clip's total frame count as the monitor last saw it BEFORE a check runs
  };
  let windowDeselected = false; // autocheck mode only: the playhead is NOT on the selected "+N" frame

  const normalizeAC = (v) => {
    const frames = parseInt(v && v.frames, 10);
    return {
      enabled: !v || v.enabled !== false,
      frames: frames >= 1 && frames <= 200 ? frames : DEFAULT_AC.frames
    };
  };

  const acReady = chrome.storage.local.get(["autocheck_settings", "ac_done"])
    .then((s) => { AC = normalizeAC(s.autocheck_settings); ac.restored = s.ac_done || null; })
    .catch(() => {});

  /* ---------- UI: with autocheck on, the manual Fetch buttons are hidden ---------- */
  function applyAutoUI() {
    $("calc-fetch-both-btn").hidden = AC.enabled;
    document.querySelectorAll(".calc-fetch-speed-btn").forEach((b) => { b.hidden = AC.enabled; });
  }

  /* ---------- status banner ---------- */
  let acStatusKey = "";
  function setAutoStatus(kind, html, recheck = false, cls = "") {
    const key = kind + "|" + html + "|" + recheck + "|" + cls;
    if (key === acStatusKey) return; // unchanged -> no re-render, no flicker
    acStatusKey = key;
    const el = $("autocheck-status");
    el.hidden = false;
    el.className = "ac-status ac-" + kind + (cls ? " " + cls : "");
    el.innerHTML = '<div class="ac-text">' + html + "</div>" +
      (recheck ? '<button type="button" class="action-btn" id="ac-recheck-btn">' + (recheck === true ? "↻ Recheck" : escapeHTML(recheck)) + "</button>" : "");
  }
  function hideAutoStatus() { acStatusKey = ""; $("autocheck-status").hidden = true; }

  /* ---------- result popup (toast) ---------- */
  let toastTimer = null;
  function calcToast(kind, html, ms = 6000) {
    const el = $("calc-toast");
    el.className = "toast toast-" + kind;
    el.innerHTML = '<div class="toast-text">' + html + '</div><button type="button" class="toast-close" aria-label="Dismiss">✕</button>';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  $("calc-toast").addEventListener("click", (e) => {
    if (e.target.closest(".toast-close")) { clearTimeout(toastTimer); $("calc-toast").hidden = true; }
  });

  /* ---------- "N frames from the action point" note under End Speed + pill sync ---------- */
  const FRAME_LIMIT = 50; // more than this many frames from the action point -> red; this many or fewer -> green

  // kind: "ok" (green) | "bad" (red) | "muted" | null (hide)
  function setFrameInfo(kind, text) {
    const el = $("calc-end-frames");
    if (!el) return;
    if (!kind) {
      if (!el.hidden) { el.hidden = true; el.textContent = ""; el.className = "frames-note"; }
      return;
    }
    const cls = "frames-note fn-" + kind;
    if (el.className !== cls) el.className = cls;
    if (el.textContent !== text) el.textContent = text;
    el.hidden = false;
  }

  // Saved so a panel reopen can tell whether the check should simply be resumed or redone
  // (playhead left away from the selected frame -> redo the autocheck and reselect the value)
  function persistAcDone() {
    if (!ac.url || ac.dpDone == null || ac.doneN == null) return;
    chrome.storage.local.set({ ac_done: { url: ac.url, dp: ac.dpDone, n: ac.doneN, away: windowDeselected } }).catch(() => {});
  }

  // The annotation page was reloaded (or its player vanished): forget the finished check so
  // autocheck runs again by itself, reselecting the frames-ahead value.
  function resetCheckForReload() {
    if (!AC.enabled) return;
    ac.dpDone = null; ac.doneN = null; ac.final = null;
    ac.slowFails = 0; ac.nextTry = 0; ac.paused = false; ac.force = false;
    ac.inexact = 0; ac.lastTotal = null; ac.sameTotal = 0;
    windowDeselected = false;
    setActiveWindowBtn(); updateHint(); setFrameInfo(null);
    chrome.storage.local.remove("ac_done").catch(() => {});
  }

  const framesWord = (n) => n + " frame" + (n === 1 ? "" : "s");

  function updateFrameInfo(st) {
    // 1) Note under End Speed: where the playhead is relative to the action point
    const off = st.frame - st.dp;
    if (off < 0) setFrameInfo("muted", framesWord(-off) + " before the action point");
    else if (off === 0) setFrameInfo("ok", "At the action point (0 frames)");
    else setFrameInfo(off > FRAME_LIMIT ? "bad" : "ok", framesWord(off) + " from the action point");

    // 2) Pill: selected only while the playhead sits exactly on the checked "+N" frame
    //    (capped at the clip's last frame). Skipped while a different window is pending.
    if (ac.doneN === frameWindow) {
      const target = Math.min(st.dp + frameWindow, st.total || Infinity);
      const away = st.frame !== target;
      if (away !== windowDeselected) {
        windowDeselected = away;
        setActiveWindowBtn();
        updateHint();
        persistAcDone();
      }
    }
  }

  // Realtime tracking: from the action point onward, End Speed and Speed Difference follow the
  // playhead and the Recommended Action is recomputed. Frames before the action point are ignored.
  function updateLive(st) {
    if (!AC.enabled) return;
    if (st.frame - st.dp < 0) return;      // before the action point -> leave the values alone
    if (st.velocity === null) return;      // no telemetry at this frame
    const startVal = parseFloat($("calc-start").value);
    if (isNaN(startVal)) return;           // needs the start speed (autocheck / Fetch sets it)
    const active = document.activeElement;
    if (active && (active.id === "calc-start" || active.id === "calc-end" || active.id === "calc-diff")) return; // don't fight typing

    { // acceleration / steering / brake follow the playhead too (a lookup in the clip's data, no page read)
      const ex = seriesExtras(st.frame);
      if (ex) {
        const key = JSON.stringify(ex) + st.frame + "|" + st.dp;
        if (key !== lastLiveExtras) { lastLiveExtras = key; telem.end = ex; telem.read = true; telem.window = windowStats(st.dp, st.frame); renderTelemetry(); }
      } else if (!series) ensureSeries();
    }
    const endStr = String(st.velocity);
    if ($("calc-end").value === endStr) return; // unchanged
    $("calc-end").value = endStr;
    $("calc-diff").value = (st.velocity - startVal).toFixed(2);
    $("calc-diff").dispatchEvent(new Event("input", { bubbles: true })); // isTrusted=false -> keeps the speeds, recomputes, saves state
  }

  /* ---------- light, non-seeking read of the page ---------- */
  const readPageState = () => runOnActiveTab(() => {
    const slider = document.querySelector('[role="slider"][aria-label="Playback time"]');
    const smallestMatch = (re) => {
      let best = null;
      for (const el of document.querySelectorAll("span, div, p")) {
        const t = el.textContent || "";
        if (t.length > 60 || !re.test(t)) continue;
        if (!best || t.length < best.textContent.length) best = el;
      }
      return best;
    };
    const frameRe = /FRAME\s*(\d+)\s*of\s*(\d+)/i;
    const tileEl = smallestMatch(frameRe);
    const tm = tileEl ? tileEl.textContent.match(frameRe) : null;

    const now = slider ? parseFloat(slider.getAttribute("aria-valuenow")) : NaN;
    const max = slider ? parseFloat(slider.getAttribute("aria-valuemax")) : NaN;
    const frame = tm ? parseInt(tm[1], 10) : (isFinite(now) ? Math.floor(now * 10 + 1e-6) + 1 : null);

    const dpEl = document.querySelector('span.x4z9k3i.xfrs9s4.x1gaeufd.x1mb2qyg.xss6m8b') || smallestMatch(/^\s*(action point\s*)?frame\s*\d+\s*$/i);
    const dm = dpEl ? dpEl.textContent.match(/(\d+)/) : null;

    const velEl = document.querySelector('span.x3nfvp2.x6s0dn4.x1a02dak.x1nejdyq') || smallestMatch(/Velocity\s*-?\d/i);
    const vm = velEl ? velEl.textContent.match(/Velocity\s*(-?\d+(?:\.\d+)?)\s*m\/s/i) : null;

    return {
      ready: !!slider && isFinite(max) && max > 0 && frame !== null, // player is on the page and has a timeline
      frame,
      total: tm ? parseInt(tm[2], 10) : (isFinite(max) ? Math.floor(max * 10 + 1e-6) + 1 : null), // last frame of the clip
      dp: dm ? parseInt(dm[1], 10) : null,
      velocity: vm ? parseFloat(vm[1]) : null
    };
  });
  readPageStateRef = readPageState; // expose to the audit (action-point check) outside the calculator scope
  runOnActiveTabRef = runOnActiveTab; // expose to the Action Point section (read / set / clear)

  /* ---------- the autocheck itself ---------- */
  function handleSeekFail(res) {
    if (res?.status === "NO_DP") {
      setAutoStatus("warn", "<strong>No action point selected</strong> in this clip. Pick one on the page — autocheck will start automatically.");
      return;
    }
    // NO_SLIDER / NO_MOVE / READ_FAIL / nothing back -> the page is slow or not ready: retry on its own
    ac.slowFails++;
    if (ac.slowFails >= SLOW_RETRY_LIMIT) {
      ac.paused = true;
      setAutoStatus("err", "<strong>The clip is too slow to check.</strong> Autocheck gave up after several tries. Once the clip has loaded, press Recheck.", true);
      return;
    }
    const wait = Math.min(2000 + ac.slowFails * 1500, 10000);
    ac.nextTry = Date.now() + wait;
    setAutoStatus("warn", "<strong>The clip is responding slowly</strong> (" + escapeHTML(FETCH_ERRORS[res?.status] || "no response from the page") + "). Rechecking automatically in " + Math.round(wait / 1000) + "s — attempt " + ac.slowFails + " of " + SLOW_RETRY_LIMIT + ".");
  }

  function finishNoTelemetry(dp, where, n) {
    ac.dpDone = dp;
    ac.doneN = n;
    chrome.storage.local.set({ ac_done: { url: ac.url, dp, n } }).catch(() => {});
    ac.final = { kind: "warn", html: "<strong>No telemetry in this clip.</strong> The page shows no velocity " + where + ", so speeds can't be read automatically. Type the speeds (or the Δ) in by hand." };
    setAutoStatus(ac.final.kind, ac.final.html, true);
  }

  // reuseStart: same action point as the finished check -> keep the start speed, just go to dp + n and read the end
  async function runAutocheck(dp, reuseStart = false) {
    const myUrl = ac.url;
    const n = frameWindow || AC.frames; // the pill picked in the panel (starts at the Settings default)
    ac.running = true;
    windowDeselected = false; setActiveWindowBtn(); updateHint(); // the check ends on the +N frame -> value selected again
    try {
      setAutoStatus("info", reuseStart
        ? "<strong>Autocheck running…</strong> going straight to " + n + " frames after the action point (frame " + (dp + n) + ")."
        : "<strong>Autocheck running…</strong> reading the speed at the action point (frame " + dp + ") and " + n + " frames later.");

      // Reads one point; if the page is up but shows no velocity yet, waits once and looks again (slow telemetry)
      const readPoint = async (mode) => {
        let res = await seekAndRead(mode, n);
        if (ac.url !== myUrl) return null;
        if (res?.status === "OK" && res.velocity == null) {
          setAutoStatus("warn", "Waiting for telemetry to appear… checking again.");
          await sleep(2500);
          if (ac.url !== myUrl) return null;
          res = await seekAndRead(mode, n);
        }
        return ac.url === myUrl ? res : null;
      };

      let start;
      if (reuseStart) {
        // Start speed at this action point is already known: don't go back to it
        start = { status: "OK", velocity: parseFloat($("calc-start").value) };
      } else {
        start = await readPoint("start");
        if (!start) return;
        if (start.status !== "OK") return handleSeekFail(start);
        if (start.velocity == null) return finishNoTelemetry(dp, "at the action point (frame " + dp + ")", n);
        knownStart = { url: ac.url, dp, speed: start.velocity };
      }

      const end = await readPoint("end");
      if (!end) return;
      if (end.status !== "OK") return handleSeekFail(end);
      if (end.velocity == null) return finishNoTelemetry(dp, n + " frames after the action point (frame " + end.frame + ")", n);

      // Did we really read the full window? A clip that is still loading reports a shorter timeline (or the seek
      // stops short), which would give a speed from FEWER frames than chosen -> look again until it is right.
      const gotN = end.frame - dp;
      const startOk = reuseStart || !start.offBy;
      const exact = startOk && end.frame === dp + n;
      let gaveUp = false;
      if (!exact) {
        ac.inexact++;
        if (end.capped && end.total != null) {
          ac.sameTotal = end.total === ac.lastTotal ? ac.sameTotal + 1 : 1;
          ac.lastTotal = end.total;
        } else { ac.sameTotal = 0; ac.lastTotal = null; }
        // SHORT CLIP, FIRST RUN: the window reaches past the clip's last frame, and the timeline was already
        // that short BEFORE this check began and did not grow while it ran (the page read before the check,
        // the start seek and the end seek all saw the same total) -> the clip genuinely ends before dp + n,
        // so the capped reading from this very first run is final. Accept it instead of re-seeking.
        const shortOnFirstRun = end.capped && startOk && end.total != null && end.total === ac.preTotal &&
          (ac.sameTotal >= 2 || (!reuseStart && start.total === end.total));
        const clipIsShort = (end.capped && startOk && ac.sameTotal >= SHORT_CLIP_CONFIRMS) || shortOnFirstRun; // timeline stable -> genuinely short clip
        if (!clipIsShort && ac.inexact < INEXACT_RETRY_LIMIT) {
          const wait = Math.min(1500 + ac.inexact * 1000, 6000);
          ac.nextTry = Date.now() + wait;
          setAutoStatus("warn", "<strong>The clip is still loading</strong> — only " + Math.max(gotN, 0) + " of " + n + " frames after the action point could be read. Rechecking automatically in " + Math.round(wait / 1000) + "s (attempt " + ac.inexact + ").");
          return; // values stay untouched until a complete reading arrives
        }
        gaveUp = !clipIsShort;
      }

      if (!reuseStart) setTelem("start", start.extras);
      setTelem("end", end.extras);
      setWindow(dp, end.frame);
      // Fill the calculator exactly like "Fetch Both" does
      $("calc-start").value = start.velocity;
      $("calc-end").value = end.velocity;
      $("calc-diff").value = (end.velocity - start.velocity).toFixed(2);
      $("calc-diff").dispatchEvent(new Event("input", { bubbles: true })); // isTrusted=false -> keeps the speeds
      saveCalcState();

      ac.dpDone = dp;
      ac.doneN = n;
      ac.slowFails = 0;
      ac.nextTry = 0;
      chrome.storage.local.set({ ac_done: { url: ac.url, dp, n } }).catch(() => {});

      const notes = [];
      if (end.capped) notes.push("end capped at the clip's last frame (" + end.frame + (gotN < n ? ", only " + Math.max(gotN, 0) + " of " + n + " frames after the action point" : "") + ")");
      if (start.offBy) notes.push("start off by " + Math.abs(start.offBy) + " frame");
      if (end.offBy) notes.push("end off by " + Math.abs(end.offBy) + " frame");
      ac.lastResult = { dp, n, gotN, start: start.velocity, end: end.velocity, capped: !!end.capped, total: end.total != null ? end.total : null, gaveUp, startExtras: telem.start, endExtras: telem.end, windowStats: telem.window }; // the full reading, also used by the AI speed check
      const tries = ac.inexact;
      ac.inexact = 0; ac.sameTotal = 0; ac.lastTotal = null;
      if (gaveUp) { // never got the full window: keep a warning with a Recheck button instead of hiding it
        ac.final = { kind: "warn", html: "<strong>Couldn't read the full " + n + " frames.</strong> After " + tries + " tries only " + Math.max(gotN, 0) + " frames after the action point could be read. Once the clip has loaded, press Recheck." };
        setAutoStatus(ac.final.kind, ac.final.html, true);
      } else {
        ac.final = null; // nothing to keep on screen: the result arrives as a popup
        hideAutoStatus();
      }
      calcToast(notes.length ? "warn" : "ok",
        "✓ <strong>Autocheck done</strong> — " + start.velocity + " → " + end.velocity + " m/s over " + gotN + " frames (Δ " + $("calc-diff").value + ")." +
        (notes.length ? " Note: " + escapeHTML(notes.join(", ")) + "." : ""));
    } catch (err) {
      ac.slowFails++;
      ac.nextTry = Date.now() + 4000;
      setAutoStatus("warn", "Autocheck couldn't read the page: " + escapeHTML(err.message) + " Retrying automatically.", true);
    } finally {
      ac.running = false;
    }
  }

  /* ---------- monitor loop ---------- */
  let acTickBusy = false;
  async function autocheckTick() {
    if (acTickBusy) return;
    if ($("calc-view").hidden) return; // only runs while the calculator view is open — never moves the playhead behind your back
    acTickBusy = true;
    try {
      await acReady;

      const tab = await getActiveTab().catch(() => null);
      if (!tab || !tab.url || isRestrictedUrl(tab.url)) { hideAutoStatus(); setFrameInfo(null); return; }

      const url = pageKey(tab.url);
      if (url !== ac.url) { // first look at this panel, or a different clip
        const first = ac.url === null;
        ac.url = url;
        windowDeselected = false; setFrameInfo(null); // new clip -> start clean
        const sameClip = first && ac.restored && ac.restored.url === url;
        const resumed = sameClip && !ac.restored.away; // don't redo a finished check after a reopen — unless the playhead had been moved off the value
        ac.dpDone = resumed ? ac.restored.dp : null;
        ac.doneN = resumed ? (ac.restored.n || null) : null;
        if (AC.enabled) { // each clip starts from the Settings default, unless we are coming back to this clip's own choice
          frameWindow = (sameClip && ac.restored.n) || AC.frames;
          applyAutoUI(); setActiveWindowBtn(); updateHint();
        }
        Object.assign(ac, { final: null, slowTicks: 0, slowFails: 0, noDpTicks: 0, nextTry: 0, paused: false, force: false, inexact: 0, lastTotal: null, sameTotal: 0, preTotal: null });
        if (!first && url !== lastClipUrl) { lastClipUrl = url; clearCalcInputs(); saveCalcState(); }
        hideAutoStatus();
      }

      if (!AC.enabled) { windowDeselected = false; setFrameInfo(null); hideAutoStatus(); applyAutoUI(); return; }
      if (ac.running || pageBusy) return;

      let st;
      try {
        st = await readPageState();
      } catch (err) {
        setAutoStatus("warn", "Autocheck can't read the annotation page yet. Press Recheck and allow access if Chrome asks.", true);
        setFrameInfo(null);
        return;
      }
      if (!st) return;

      // 1) Clip still loading / slow
      if (!st.ready) {
        if (ac.dpDone !== null) resetCheckForReload(); // player vanished -> the page reloaded: check again once it is back
        setFrameInfo(null);
        ac.slowTicks++;
        const secs = Math.round(ac.slowTicks * AC_TICK_MS / 1000);
        setAutoStatus("warn", secs < 10
          ? "<strong>Clip is still loading…</strong> autocheck will start as soon as the player is ready."
          : "<strong>This clip is loading slowly</strong> (" + secs + "s so far). Still waiting — autocheck rechecks automatically.");
        return;
      }
      ac.slowTicks = 0;

      // 2) No action point
      if (st.dp === null) {
        setFrameInfo(null);
        ac.noDpTicks++;
        if (ac.noDpTicks >= 3) setAutoStatus("warn", "<strong>No action point selected</strong> in this clip. Pick one on the page — autocheck will start automatically.");
        else setAutoStatus("info", "Autocheck: looking for the action point…");
        return;
      }
      ac.noDpTicks = 0;

      // 3) Action point present: run the check once per clip / action point
      const wantN = frameWindow || AC.frames;

      // The action point moved AFTER a finished check: don't re-check by itself — say so and offer a button
      if (ac.dpDone !== null && ac.dpDone !== st.dp && !ac.force) {
        setFrameInfo(null); // the speeds still belong to the old action point, so no live tracking / frame note
        setAutoStatus("warn",
          "<strong>The action point has changed</strong> from frame " + ac.dpDone + " to frame " + st.dp + "." +
          '<span class="ac-sub">The speeds shown still belong to frame ' + ac.dpDone + ".</span>",
          "↻ Recheck from frame " + st.dp, "ac-changed");
        return;
      }

      if (ac.dpDone !== st.dp || ac.doneN !== wantN) {
        setFrameInfo(null);
        if (ac.paused || Date.now() < ac.nextTry) return; // waiting out a slow-clip retry
        const reuse = ac.dpDone === st.dp && !isNaN(parseFloat($("calc-start").value)); // only the window changed
        ac.preTotal = st && st.total != null ? st.total : null; // the clip's timeline BEFORE this check runs (short-clip proof)
        await runAutocheck(st.dp, reuse);
        return;
      }

      // 4) Already checked -> keep the result on screen and track live
      if (ac.final) setAutoStatus(ac.final.kind, ac.final.html, true); // e.g. the no-telemetry warning stays visible
      else hideAutoStatus();
      ac.force = false; // checked -> back to normal
      updateFrameInfo(st);
      updateLive(st);
    } finally {
      acTickBusy = false;
    }
  }

  function recheckNow() {
    ac.inexact = 0; ac.lastTotal = null; ac.sameTotal = 0;
    windowDeselected = false;
    setActiveWindowBtn(); updateHint();
    ac.dpDone = null;
    ac.doneN = null;
    ac.final = null;
    ac.paused = false;
    ac.slowFails = 0;
    ac.nextTry = 0;
    acStatusKey = "";
    autocheckTick();
  }

  /* "Run Speed Check" (context menu / panel-nudge from background.js): switch to the
   * calculator view, then run the check once, whatever mode is active — autocheck mode
   * reruns the check now, manual mode behaves exactly like clicking Fetch Both Speeds. */
  function runCtxSpeedCheck() {
    setCalcVisibility(true); // the autocheck monitor only runs while the calculator view is open
    if (AC.enabled) {
      recheckNow();
    } else {
      const btn = $("calc-fetch-both-btn");
      if (btn && !btn.disabled) btn.click();
    }
  }
  $("autocheck-status").addEventListener("click", (e) => { if (e.target.closest("#ac-recheck-btn")) recheckNow(); });

  setInterval(autocheckTick, AC_TICK_MS);
  autocheckTick();

  // A refresh of the annotation tab can be over faster than one monitor tick, so also react to the load itself
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== "loading" || !tab || !tab.active || !tab.url || isRestrictedUrl(tab.url)) return;
    if (ac.url && pageKey(tab.url) === ac.url) resetCheckForReload();
  });

  /* ---------- settings: the panel's Settings view (st-ac-*) and the options page share "autocheck_settings" ---------- */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.autocheck_settings) return;
    AC = normalizeAC(changes.autocheck_settings.newValue);
    if (AC.enabled) frameWindow = AC.frames;
    applyAutoUI(); setActiveWindowBtn(); updateHint();
    recheckNow();
  });

  const acEnabledBox = $("st-ac-enabled");
  const acFramesSel = $("st-ac-frames");
  if (acEnabledBox && acFramesSel) {
    acReady.then(() => {
      acEnabledBox.checked = AC.enabled;
      acFramesSel.value = String(AC.frames);
      const applyACSettings = () => {
        AC = { enabled: acEnabledBox.checked, frames: parseInt(acFramesSel.value, 10) || DEFAULT_AC.frames };
        // the storage.onChanged listener above picks it up and applies it live
        chrome.storage.local.set({ autocheck_settings: AC }).catch(() => {});
      };
      acEnabledBox.addEventListener("change", applyACSettings);
      acFramesSel.addEventListener("change", applyACSettings);
    }).catch(() => {});
  }

  /* "Disable speed check in review mode" — instant-save, key "vla_speed_check_review_off".
     Read by the audit: on read-only clips no speed is measured at all when this is on;
     when it is off (default) the reading comes from the clip's telemetry without seeking. */
  const acReviewOffBox = $("st-ac-review-off");
  if (acReviewOffBox) {
    acReviewOffBox.checked = state.speedCheckReviewOff;
    acReviewOffBox.addEventListener("change", () => {
      state.speedCheckReviewOff = acReviewOffBox.checked;
      chrome.storage.local.set({ vla_speed_check_review_off: acReviewOffBox.checked }).catch(() => {});
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.vla_speed_check_review_off) return;
    state.speedCheckReviewOff = changes.vla_speed_check_review_off.newValue === true;
    if (acReviewOffBox) acReviewOffBox.checked = state.speedCheckReviewOff;
  });

  /* Frame window selector (10/20/30/40/50 frames ahead of the action point).
     Autocheck mode: the pill picks the window for this clip and the check reruns by itself.
     Manual mode: clicking the active pill deselects it (no window = Fetch reads at the playhead). */
  function updateHint() {
    if (AC.enabled && windowDeselected) {
      $("calc-hint").textContent = "Autocheck is on — the playhead is away from the selected frame, so End Speed follows it live from the action point. Pick a frames-ahead value to jump back to one.";
      return;
    }
    if (AC.enabled && frameWindow) {
      $("calc-hint").textContent = "Autocheck is on — pick the frames ahead and the speeds are fetched automatically (" + frameWindow + " frames = " + (frameWindow / 10) + " seconds).";
      return;
    }
    $("calc-hint").textContent = frameWindow
      ? "Calculate speed changes over " + frameWindow + " frames (" + (frameWindow / 10) + " seconds)."
      : "No frames-ahead window selected — Fetch reads the speed at the current playhead position.";
  }

  function setActiveWindowBtn() {
    document.querySelectorAll(".window-btn").forEach((b) => {
      b.classList.toggle("active", !windowDeselected && parseInt(b.dataset.window, 10) === frameWindow);
    });
  }

  document.querySelectorAll(".window-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const val = parseInt(b.dataset.window, 10);
      if (AC.enabled) {
        // Autocheck mode: the pill picks the window for this clip and the check reruns by itself
        if (frameWindow === val && !windowDeselected) return;
        frameWindow = val;
        windowDeselected = false;
        ac.inexact = 0; ac.lastTotal = null; ac.sameTotal = 0;
        ac.force = true; // an explicit request: also fine when the action point has changed
        ac.doneN = null; // force a seek to action point + val, even when the same pill is re-clicked after the playhead was moved
        setActiveWindowBtn();
        updateHint();
        autocheckTick();
        return;
      }
      // Manual mode: clicking the active pill deselects it (no window = Fetch reads at the playhead)
      frameWindow = frameWindow === val ? null : val;
      setActiveWindowBtn();
      updateHint();
      chrome.storage.local.set({ calc_window: frameWindow }).catch(() => {});
    });
  });

  // Manual mode restores the last pill; with autocheck on, the pill starts from the Settings default instead
  Promise.all([chrome.storage.local.get("calc_window").catch(() => ({})), acReady])
    .then(([s]) => { if (!AC.enabled && s.calc_window !== undefined) frameWindow = s.calc_window; })
    .catch(() => {})
    .finally(() => { applyAutoUI(); setActiveWindowBtn(); updateHint(); });

  /* Adjustable thresholds (⚙ Thresholds in the calculator view) — persisted in chrome.storage */
  const syncThresholdInputs = () => {
    document.querySelectorAll(".thr-input").forEach((inp) => { inp.value = THR[inp.dataset.thr]; });
  };

  document.querySelectorAll(".thr-input").forEach((inp) => {
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (isNaN(v) || v < 0) { inp.style.borderColor = "var(--alert-warning-border)"; return; } // invalid → red border, no change
      inp.style.borderColor = "";
      THR[inp.dataset.thr] = v;
      chrome.storage.local.set({ calc_thresholds: THR }).catch(() => {});
      $("calc-diff").dispatchEvent(new Event("input", { bubbles: true })); // recompute with the new threshold
    });
  });

  /* Speed Calculator settings in the panel's Settings view. The threshold inputs share the
   * .thr-input wiring (same class + data-thr), so they populate, validate and save automatically —
   * only the reset button needs its own listener here. */
  const settingsThrResetBtn = $("st-thr-reset-btn");
  if (settingsThrResetBtn) {
    settingsThrResetBtn.addEventListener("click", () => {
      THR = { ...DEFAULT_THRESHOLDS };
      chrome.storage.local.set({ calc_thresholds: THR }).catch(() => {});
      syncThresholdInputs();
      $("calc-diff").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelectorAll(".thr-input").forEach((inp) => { inp.style.borderColor = ""; });
    });
  }

  /* Google Sheet link (instant-save, shared with the options page via storage key "sheet_url") */
  const sheetInput = $("st-sheet-url");
  if (sheetInput) {
    chrome.storage.local.get("sheet_url")
      .then((s) => { if (s.sheet_url) sheetInput.value = s.sheet_url; })
      .catch(() => {});
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
  }

  /* 🧠 Prompts editor (Settings view) — instant-save through the Prompts module
   * (chrome.storage.local key "vla_prompt_overrides"; text identical to the
   * default deletes the override automatically). "●" marks edited blocks.
   * The "📋 All blocks" entry lists every block in one scrollable text area,
   * each section under a ===== [KEY] label ===== header; saving parses the
   * headers and updates each block separately. */
  const promptBlockSelect = $("prompt-block-select");
  const promptBlockText = $("prompt-block-text");
  if (promptBlockSelect && promptBlockText && typeof Prompts === "object" && Prompts.listBlocks) {
    const statusEl = $("prompt-block-status");
    const resetBlockBtn = $("prompt-reset-block-btn");
    const resetAllBtn = $("prompt-reset-all-btn");
    const importBtn = $("prompt-import-btn");
    const exportBtn = $("prompt-export-btn");
    const importFile = $("prompt-import-file");
    const ALL_KEY = "__all__";
    let currentKey = null;
    let saveTimer = null;

    const isAll = () => currentKey === ALL_KEY;
    const HEADER_RX = /^===== \[([A-Z_]+)\]/;
    const composeAll = () => Prompts.listBlocks().map((b) =>
      "===== [" + b.key + "] " + b.label + (b.edited ? " — EDITED" : "") + " =====\n" + Prompts.getBlock(b.key)
    ).join("\n\n");
    const parseAll = (text) => {
      const valid = new Set(Prompts.listBlocks().map((b) => b.key));
      const out = {};
      let cur = null;
      let buf = [];
      const flush = () => { if (cur) out[cur] = buf.join("\n"); };
      for (const line of text.split("\n")) {
        const m = line.match(HEADER_RX);
        if (m && valid.has(m[1])) { flush(); cur = m[1]; buf = []; }
        else if (cur) buf.push(line);
      }
      flush();
      return out;
    };

    const rebuildOptions = () => {
      const sel = promptBlockSelect.value;
      const blocks = Prompts.listBlocks();
      const editedCount = blocks.filter((b) => b.edited).length;
      promptBlockSelect.innerHTML = "";
      const allOpt = document.createElement("option");
      allOpt.value = ALL_KEY;
      allOpt.textContent = "📋 All blocks" + (editedCount ? " — " + editedCount + " edited" : "");
      promptBlockSelect.appendChild(allOpt);
      for (const b of blocks) {
        const o = document.createElement("option");
        o.value = b.key;
        o.textContent = (b.edited ? "● " : "○ ") + b.label;
        promptBlockSelect.appendChild(o);
      }
      promptBlockSelect.value = sel;
    };
    const refreshStatus = (note) => {
      const blocks = Prompts.listBlocks();
      const editedCount = blocks.filter((b) => b.edited).length;
      if (isAll()) {
        statusEl.textContent = "📋 All " + blocks.length + " blocks — " + editedCount + " edited. " +
          "Edit any block between its ===== header and the next; each block saves on its own.";
      } else {
        const info = blocks.find((b) => b.key === currentKey);
        statusEl.textContent = info && info.edited
          ? "● Edited — this override is live for every AI feature."
          : "○ Default (built-in text)";
      }
      if (note) statusEl.textContent += "  " + note;
    };
    const showBlock = (key) => {
      currentKey = key;
      promptBlockText.value = isAll() ? composeAll() : Prompts.getBlock(key);
      if (resetBlockBtn) resetBlockBtn.disabled = isAll(); // "Restore this block" needs one block
      refreshStatus();
    };

    rebuildOptions();
    showBlock(promptBlockSelect.value || ALL_KEY);
    promptBlockSelect.addEventListener("change", () => showBlock(promptBlockSelect.value));

    promptBlockText.addEventListener("input", () => {
      clearTimeout(saveTimer);
      refreshStatus("… saving");
      saveTimer = setTimeout(async () => {
        if (isAll()) {
          for (const [k, v] of Object.entries(parseAll(promptBlockText.value))) {
            const cur = Prompts.getBlock(k) || "";
            if ((v || "").trim() !== cur.trim()) await Prompts.setBlock(k, v); // unchanged sections are skipped
          }
        } else {
          await Prompts.setBlock(currentKey, promptBlockText.value);
        }
        rebuildOptions();
        refreshStatus("✓ saved");
      }, 500);
    });

    if (resetBlockBtn) resetBlockBtn.addEventListener("click", async () => {
      if (isAll()) return;
      await Prompts.resetBlock(currentKey);
      rebuildOptions();
      showBlock(currentKey);
    });
    if (resetAllBtn) resetAllBtn.addEventListener("click", async () => {
      await Prompts.resetAll();
      rebuildOptions();
      showBlock(currentKey);
    });

    /* 📤 Export: downloads a readable .txt file in the exact "📋 All blocks" format
     * (===== [KEY] header + text), so what you see in the editor is what you get.
     * Import accepts this format back, plus the older JSON snapshot. */
    if (exportBtn) exportBtn.addEventListener("click", () => {
      const blob = new Blob([composeAll()], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      a.href = url;
      a.download = "vla-prompts-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      refreshStatus("✓ exported");
    });

    /* 📥 Import: accepts an Export .txt (===== [KEY] format), a JSON Export snapshot, or a
     * plain {BLOCK: "text"} object. Every known block in the file is applied — identical
     * text clears the override — and anything not in the file is left untouched. */
    const applyImported = async (raw) => {
      const text = String(raw || "");

      // JSON formats: { "blocks": {KEY: text} } snapshot, or a plain {KEY: text}
      if (text.trim().startsWith("{")) {
        let data = null;
        try { data = JSON.parse(text); } catch (_) { refreshStatus("✗ not a valid JSON file"); return; }
        const src = (data && typeof data === "object" && !Array.isArray(data) &&
          data.blocks && typeof data.blocks === "object" && !Array.isArray(data.blocks)) ? data.blocks : data;
        if (!src || typeof src !== "object" || Array.isArray(src)) { refreshStatus("✗ unknown file format"); return; }
        const valid = new Set(Prompts.listBlocks().map((b) => b.key));
        let n = 0;
        for (const [k, v] of Object.entries(src)) {
          if (!valid.has(k) || typeof v !== "string") continue;
          await Prompts.setBlock(k, v);
          n++;
        }
        rebuildOptions();
        showBlock(currentKey);
        refreshStatus(n ? "✓ imported " + n + " block(s)" : "✗ no known prompt blocks in that file");
        return;
      }

      // Readable "All blocks" text format (what Export downloads)
      const sections = parseAll(text);
      const keys = Object.keys(sections);
      if (!keys.length) { refreshStatus("✗ no known prompt blocks in that file"); return; }
      let n = 0;
      for (const k of keys) {
        const v = sections[k].endsWith("\n") ? sections[k].slice(0, -1) : sections[k]; // drop the blank line the format adds between sections
        const cur = Prompts.getBlock(k) || "";
        if (v.trim() !== cur.trim()) await Prompts.setBlock(k, v); // unchanged sections are skipped, so nothing gets marked edited by mistake
        n++;
      }
      rebuildOptions();
      showBlock(currentKey);
      refreshStatus("✓ imported " + n + " block(s)");
    };
    if (importBtn && importFile) {
      importBtn.addEventListener("click", () => importFile.click());
      importFile.addEventListener("change", () => {
        const file = importFile.files && importFile.files[0];
        importFile.value = ""; // allows picking the same file again later
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => applyImported(String(reader.result || ""));
        reader.onerror = () => refreshStatus("✗ could not read the file");
        reader.readAsText(file);
      });
    }

    // Another open panel edited a block → pick it up here without clobbering typing
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.vla_prompt_overrides) return;
      rebuildOptions();
      if (currentKey && document.activeElement !== promptBlockText) showBlock(currentKey);
      else refreshStatus();
    });
  }

  chrome.storage.local.get("calc_thresholds")
    .then((s) => { if (s.calc_thresholds) { THR = { ...THR, ...s.calc_thresholds }; delete THR.strongDrop; } })
    .catch(() => {})
    .finally(() => syncThresholdInputs());

  // Live-sync with the Speed Calculator section on the options page: changes made there while the
  // panel is open are picked up immediately. Own writes are skipped by the equality check.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.sheet_url) {
      if (sheetInput && document.activeElement !== sheetInput) sheetInput.value = changes.sheet_url.newValue || "";
      updateFooterButtons();
    }
    if (changes.calc_thresholds && changes.calc_thresholds.newValue) {
      const next = { ...DEFAULT_THRESHOLDS, ...changes.calc_thresholds.newValue };
      const unchanged = Object.keys(DEFAULT_THRESHOLDS).every((k) => Number(next[k]) === Number(THR[k]));
      if (!unchanged) {
        THR = next;
        syncThresholdInputs();
        $("calc-diff").dispatchEvent(new Event("input", { bubbles: true })); // recompute with the new thresholds
      }
    }
    if (changes.calc_window) {
      frameWindow = changes.calc_window.newValue === null ? null : changes.calc_window.newValue;
      setActiveWindowBtn();
      updateHint();
    }
  });

  /* Copy clip URL */
  $("calc-copy-url-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const DEFAULT = "Copy Clip URL";
    try {
      const tab = await getActiveTab();
      if (!tab || isRestrictedUrl(tab.url)) throw new Error("unsupported");
      const ok = await copyText(tab.url);
      calcFlash(btn, ok ? "Copied! ✓" : "Copy failed", ok ? COLOR.ok : COLOR.err, DEFAULT);
    } catch (_) {
      calcFlash(btn, "Error Copying", COLOR.err, DEFAULT);
    }
  });

  $("save-key-btn").addEventListener("click", async () => {
    const btn = $("save-key-btn");
    $("settings-notice").innerHTML = "";
    const typedKey = $("api-key").value.trim();
    const typedGroqKey = $("groq-api-key") ? $("groq-api-key").value.trim() : "";
    const typedKey2 = $("api-key-2") ? $("api-key-2").value.trim() : "";
    const typedGroqKey2 = $("groq-api-key-2") ? $("groq-api-key-2").value.trim() : "";
    const model = $("model-input").value.trim() || VLA.DEFAULT_MODEL;
    const chatModel = $("chat-model-input").value.trim() || VLA.DEFAULT_MODEL;

    const isModelGroq = isGroqModel(model);
    const isChatGroq = isGroqModel(chatModel);
    
    if ((isModelGroq || isChatGroq) && !typedGroqKey && !state.groqKey) {
        flash(btn, "Groq Key required!", COLOR.err, "Save settings");
        return;
    }
    
    if ((!isModelGroq || !isChatGroq) && !typedKey && !state.key) {
        flash(btn, "Gemini Key required!", COLOR.err, "Save settings");
        return;
    }

    const nextKey = typedKey || state.key;
    const nextGroqKey = typedGroqKey || state.groqKey;
    const nextKey2 = typedKey2;      // backup keys are optional — empty means none
    const nextGroqKey2 = typedGroqKey2;

    btn.textContent = "Verifying Key...";
    btn.disabled = true;

    // A rate-limited key (429 / quota / overload) is still valid — it just hit its limit for now.
    // Saving is allowed as long as at least one key of the provider works.
    const isLimitError = (status, msg) =>
      status === 429 || status === 503 ||
      /rate.?limit|quota|exhausted|overload|high demand|spikes in demand|too many requests/i.test(msg || "");

    const keyStatus = async (provider, key, pingModel) => {
      try {
        let resp;
        if (provider === "groq") {
          resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
            body: JSON.stringify({ model: pingModel, messages: [{ role: "user", content: "ping" }], max_tokens: 10 })
          });
        } else {
          resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pingModel)}:generateContent`, {
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

    // OK / LIMITED = usable. Only a provider with NO usable key blocks saving — and only if the
    // review model needs it. The chat model's provider just warns, so one broken provider
    // can't lock you out of saving entirely.
    const verifyProvider = async (provider, name, primary, backup, pingModel) => {
      const primaryStatus = await keyStatus(provider, primary, pingModel);
      const backupStatus = (backup && backup !== primary) ? await keyStatus(provider, backup, pingModel) : null;
      if (primaryStatus.startsWith("INVALID") && (!backupStatus || backupStatus.startsWith("INVALID"))) {
        return { fatal: primaryStatus };
      }
      const notes = [];
      if (primaryStatus.startsWith("INVALID")) notes.push(`⚠️ Primary ${name} key failed (${primaryStatus.slice(8)}) — saved anyway because the backup works. Fix the primary key.`);
      if (primaryStatus === "LIMITED") notes.push(`ℹ️ Primary ${name} key is at its rate limit right now — saved anyway.`);
      if (backupStatus === "LIMITED") notes.push(`ℹ️ Backup ${name} key is at its rate limit right now — saved anyway.`);
      if (backupStatus && backupStatus.startsWith("INVALID")) notes.push(`⚠️ Backup ${name} key could not be verified (${backupStatus.slice(8)}) — saved anyway. Check it when you can.`);
      return { notes };
    };

    const warnings = [];
    const providers = [];
    if (isModelGroq || isChatGroq) providers.push({ id: "groq", name: "Groq", primary: nextGroqKey, backup: nextGroqKey2, model: isModelGroq ? model : chatModel, critical: isModelGroq });
    if (!isModelGroq || !isChatGroq) providers.push({ id: "gemini", name: "Google", primary: nextKey, backup: nextKey2, model: !isModelGroq ? model : chatModel, critical: !isModelGroq });

    for (const p of providers) {
      const r = await verifyProvider(p.id, p.name, p.primary, p.backup, p.model);
      if (r.fatal && p.critical) {
        flash(btn, "Verification failed ❌", COLOR.err, "Save settings", 3500);
        $("settings-notice").innerHTML = `<div class="warning"><strong>Couldn't verify:</strong> ${escapeHTML(r.fatal.slice(8))}<br>Check the API key and model names.</div>`;
        btn.disabled = false;
        return;
      }
      if (r.fatal) warnings.push(`⚠️ Neither ${p.name} key works (${r.fatal.slice(8)}) — the AI Chat model may fail until you fix them.`);
      else warnings.push(...r.notes);
    }

    chrome.storage.local.set({
      vla_gemini_key: nextKey,
      vla_groq_key: nextGroqKey,
      vla_gemini_key2: nextKey2,
      vla_groq_key2: nextGroqKey2,
      vla_model: model,
      vla_chat_model: chatModel,
      vla_auto_fetch: $("auto-fetch").checked,
      vla_auto_audit: $("auto-audit").checked,
      vla_show_badge: $("show-badge").checked,
      vla_warn_page_change: $("warn-page-change").checked
    }, () => {
      state.key = nextKey;
      state.groqKey = nextGroqKey;
      state.key2 = nextKey2;
      state.groqKey2 = nextGroqKey2;
      state.model = model;
      state.chatModel = chatModel;
      state.autoFetch = $("auto-fetch").checked;
      state.autoAudit = $("auto-audit").checked;
      state.showBadge = $("show-badge").checked;
      state.warnPageChange = $("warn-page-change").checked;

      state.autoFetchFailed = false;
      state.badgeAlert = null;
      updateFetchVisibility();
      updateBadge();
      updateModelIndicator("model-input", true);
      updateModelIndicator("chat-model-input", true);
      refreshModelStatus(); // new keys may change which models are available

      btn.disabled = false;
      flash(btn, warnings.length ? "Saved with notes ⚠️" : "Saved & Verified ✓", COLOR.ok, "Save settings");

      if (warnings.length) {
        $("settings-notice").innerHTML = `<div class="warning"><strong>Saved with notes:</strong><br>${warnings.map(escapeHTML).join("<br>")}</div>`;
      }

      setTimeout(() => {
        setSettingsVisibility(false);
      }, warnings.length ? 3500 : 1000);
    });
  });

  ["box1-input", "box2-input"].forEach((id) =>
  $(id).addEventListener("input", () => { refreshInputLint(); persistSoon(); }));
  ["user-maneuver", "user-speed"].forEach((id) => $(id).addEventListener("change", persistSoon));

  // 🧮 Calculate next to the Speed change dropdown: measures the clip with the Speed
  // Calculator's own method (seek to the action point, read the speed, seek N frames
  // ahead, read again, same thresholds and recommendation logic) and fills the Speed
  // change dropdown with the measured option instead of only showing it.
  // The button keeps its gauge icon: flash() would replace the markup with plain text,
  // so this helper swaps the label and always restores the icon + text afterwards.
  const SPEED_CALC_HTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg><span>Calculate</span>';
  const flashCalc = (btn, text, bg, ms = 2000) => {
    btn.textContent = text;
    btn.style.background = bg || "";
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => { btn.innerHTML = SPEED_CALC_HTML; btn.style.background = ""; }, ms);
  };
  let speedCalcNoticeTimer = null; // the green result popup clears itself after 3 s
  $("speed-calc-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (state.busy) return;
    if (state.isReadOnly) { flashCalc(btn, "Clip is read only", COLOR.err, 3000); return; }
    if (typeof aiSpeedCheckRef !== "function") { flashCalc(btn, "Not ready yet", COLOR.err, 3000); return; }
    btn.disabled = true;
    btn.textContent = "⏳ Measuring…";
    try {
      const r = await aiSpeedCheckRef();
      if (!r || !r.ok) {
        flashCalc(btn, "Couldn't measure", COLOR.err, 4000);
        notify(escapeHTML((r && r.msg) || "The speed measurement failed. Try again."));
        return;
      }
      const sel = $("user-speed");
      if (![...sel.options].some((o) => o.value === r.suggestion)) {
        flashCalc(btn, "Unexpected result", COLOR.err, 4000);
        return;
      }
      sel.value = r.suggestion;
      persistSoon();
      flashCalc(btn, "✓ " + r.suggestion, COLOR.ok, 4000);
      const sign = r.delta > 0 ? "+" : "";
      notify(`🧮 Measured <strong>${r.startSpeed} → ${r.endSpeed} m/s</strong> over ${r.windowFrames} frames (Δ ${sign}${r.delta})${r.capped ? ", capped at the clip's last frame" : ""}. Speed change set to <strong>${escapeHTML(r.suggestion)}</strong>.`, "success");
      // Auto-dismiss the result popup after 3 seconds (a fresh measurement resets the timer;
      // notify("") keeps the read-only banner, if one is showing)
      if (speedCalcNoticeTimer) clearTimeout(speedCalcNoticeTimer);
      speedCalcNoticeTimer = setTimeout(() => notify(""), 3000);
    } catch (err) {
      flashCalc(btn, "Couldn't measure", COLOR.err, 4000);
      notify(escapeHTML(err && err.message ? err.message : String(err)));
    } finally {
      btn.disabled = false;
    }
  });

  $("fetch-btn").addEventListener("click", () => fetchFromPage());
  $("refresh-btn").addEventListener("click", () =>
  fetchFromPage({ ui: { btn: $("refresh-btn"), busy: "…", ok: "✓", idle: "↻", short: true } }));
  $("audit-btn").addEventListener("click", auditText);

  /* ---- Action Point section (main view) — read-only ---- */
  refreshActionPointUI();
  setInterval(refreshActionPointUI, 2000); // keeps the action point + cursor readout live while the panel is open

  $("copy-url-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const DEFAULT = "🔗 Copy Clip URL";
    try {
      const tab = await getActiveTab();
      if (isRestrictedUrl(tab?.url)) throw new Error("unsupported");
      await handleCopy(btn, tab.url, DEFAULT);
    } catch (_) {
      flash(btn, "Error Copying", COLOR.err, DEFAULT);
    }
  });

  $("open-sheet-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const DEFAULT = "📊 Google Sheets";
    try {
      const sheetUrl = await getSheetUrl();
      if (!sheetUrl) { // no link saved yet → open Settings and point at the field
        setSettingsVisibility(true);
        $("st-sheet-url")?.focus();
        flash(btn, "Add the URL in Settings", COLOR.err, DEFAULT, 3000);
        return;
      }
      const key = sheetKey(sheetUrl);
      const current = await getActiveTab().catch(() => null);
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter((t) => t.url && sheetKey(t.url) === key);
      // Reuse an already-open tab (prefer this window); otherwise open a new one
      const existing = matches.find((t) => current && t.windowId === current.windowId) || matches[0];

      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      } else {
        await chrome.tabs.create(current ? { url: sheetUrl, windowId: current.windowId } : { url: sheetUrl });
      }
    } catch (err) {
      console.error("Failed to switch or open tab", err);
      flash(btn, "Couldn't open sheet", COLOR.err, DEFAULT, 3000);
    }
  });

  $("return-tab-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const DEFAULT = "⬅️ Return to Clip";
    try {
      const clipTab = await findClipTab();
      if (!clipTab) { // closed, or navigated away from the annotation site
        flash(btn, "Clip tab not found", COLOR.err, DEFAULT);
        state.dataTab = null;
        persistSoon();
        updateFooterButtons();
        return;
      }
      await chrome.tabs.update(clipTab.id, { active: true });
      // A focus failure must not be reported as "tab closed" — the switch itself already worked
      await chrome.windows.update(clipTab.windowId, { focused: true }).catch(() => {});
    } catch (err) {
      flash(btn, "Couldn't switch", COLOR.err, DEFAULT);
    }
  });

  await restoreSession();
  await loadHistory();
  refreshInputLint();
  updateFooterButtons();
  updateHistoryButtons();

  chrome.tabs.onActivated.addListener(({ tabId }) => onTabChanged(tabId));
  // Footer buttons depend on the active tab, so refresh them directly too (onTabChanged skips while busy)
  chrome.tabs.onActivated.addListener(() => updateFooterButtons());
  chrome.tabs.onRemoved.addListener(() => updateFooterButtons());
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url) updateFooterButtons(); });
  chrome.windows.onFocusChanged.addListener(() => updateFooterButtons());
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!tab.active) return;
    if (info.status === "loading") {
      state.lastSeenPage = "";
      if (tab.url && tab.url.startsWith(ALLOWED_ORIGIN)) state.pendingReloadTab = tabId;
    }
    if (info.url || info.status === "complete") onTabChanged(tabId);
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "TRIGGER_AUDIT") {
      fetchFromPage({ triggerAudit: true });
      sendResponse({ handled: true });
    }
    if (request.action === "TRIGGER_SPEED_CHECK") {
      runCtxSpeedCheck(); // "Run Speed Check" was clicked in the page's context menu
      sendResponse({ handled: true });
    }
  });

  chrome.runtime.sendMessage({ action: "SIDEPANEL_READY" }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && resp.pendingAudit) fetchFromPage({ triggerAudit: true });
    if (resp && resp.pendingSpeedCheck) runCtxSpeedCheck();
  });

  if ((isGroqModel(state.model) && !state.groqKey && !state.groqKey2) || (!isGroqModel(state.model) && !state.key && !state.key2)) {
    setSettingsVisibility(true);
  } else if (state.autoFetch) {
    fetchFromPage({ silent: true, triggerAudit: state.autoAudit, withSpeed: state.autoAudit });
  } else {
    updateBadge();
  }
}

/* ====================================================================
 * Model status dots
 * The old checker sent a real generateContent request to EVERY model every 3 minutes, which burned
 * the free-tier quota (and the backup key's) and made audits hit rate limits. This asks each provider
 * for its model LIST once (a free metadata call that uses no generation quota) and marks every model
 * as available (🟢), not offered / key rejected (🔴) or unknown because the API was unreachable (🟡).
 * It runs when the panel opens and after settings are saved — never on a timer.
 * ==================================================================== */
let modelStatusRunning = false;

async function listProviderModels(isGroq) {
  const keys = providerKeys(isGroq);
  if (!keys.length) return { ids: new Set(), reason: "nokey" };

  for (const key of keys) {
    try {
      const ids = new Set();
      if (isGroq) {
        const resp = await fetchRetry("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
        if (resp.status === 400 || resp.status === 401 || resp.status === 403) continue; // this key is rejected → try the backup
        if (!resp.ok) return null;
        const data = await resp.json();
        (data.data || []).forEach((m) => ids.add(m.id));
      } else {
        let pageToken = "";
        for (let page = 0; page < 5; page++) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
          const resp = await fetchRetry(url, { headers: { "x-goog-api-key": key } });
          if (resp.status === 400 || resp.status === 401 || resp.status === 403) { ids.clear(); pageToken = null; break; }
          if (!resp.ok) return null;
          const data = await resp.json();
          (data.models || []).forEach((m) => ids.add(String(m.name || "").replace(/^models\//, "")));
          pageToken = data.nextPageToken || "";
          if (!pageToken) break;
        }
        if (pageToken === null) continue; // key rejected → try the backup
      }
      return { ids };
    } catch (_) {
      return null; // unreachable
    }
  }
  return { ids: new Set(), reason: "rejected" }; // every key was rejected
}

async function refreshModelStatus() {
  if (modelStatusRunning) return;
  modelStatusRunning = true;
  try {
    const byProvider = { gemini: await listProviderModels(false), groq: await listProviderModels(true) };
    for (const { id } of VLA.FREE_MODELS) {
      const res = byProvider[isGroqModel(id) ? "groq" : "gemini"];
      updateDropdownOptionStatus(id, res === null ? "🟡" : res.ids.has(id) ? "🟢" : "🔴");
    }
  } finally {
    modelStatusRunning = false;
  }
}

function updateDropdownOptionStatus(modelId, statusEmoji) {
  ["model-select", "chat-model-select", "vision-model-select"].forEach(selectId => {
    const selectEl = $(selectId);
    if (!selectEl) return;
    for (const opt of selectEl.options) {
      if (opt.value === modelId) {
        // Remember the label without its status dot, once.
        if (opt.dataset.baseText === undefined) {
          opt.dataset.baseText = opt.textContent
            .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "") 
            .replace(/^[🟢🔴🟡]\s*/u, "");
        }
        opt.textContent = `${statusEmoji} ${opt.dataset.baseText}`;
      }
    }
  });
}

// Statuses need the saved keys, which init() loads first
init().finally(() => refreshModelStatus());