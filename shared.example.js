// EXAMPLE VERSION of shared.js (sanitized). Same exports as the real file; the local linter below is a short
// generic stand-in. Copy to shared.js and add your own rules. MANEUVERS / SPEEDS / CONTEXTS must match the
// option labels on the annotation page, because content.js clicks them by text.
// Single source of truth for the maneuver / speed / context lists, the local
// rule linter and the word diff. Loaded by sidepanel.html AND injected into the
// page together with content.js, so both sides always agree on the labels.
(function (root) {
  const MANEUVERS = [
    "Start from stop", "Set speed tracking", "Lead obstacle following",
    "Speed adaptation (road events)", "Gap-searching (for LC/merge/zipper)",
    "Acceleration for passing/overtaking", "Yield (agent right-of-way)",
    "Stop for static constraints", "Lane keeping & centering",
    "Merge / split (facility change)", "Out-of-lane nudge (straddle avoidance)",
    "In-lane nudge", "Lane change left", "Lane change right",
    "Pull-over / curb approach left", "Pull-over / curb approach right",
    "Pull-out / rejoin road left", "Pull-out / rejoin road right",
    "Turn (intersection/roundabout/U-turn)", "Lateral maneuver abort",
    "Double lane change", "Nonstandard"
  ];

  const SPEEDS = [
    "Maintain speed", "Accelerate", "Decelerate", "Strong decelerate",
    "Stop", "Remain stopped", "Resume motion"
  ];

  // value = exact text used on the annotation page, label = shorter text shown in the pill
  const CONTEXTS = [
    { value: "Slow for the lead vehicle", label: "Slow for the lead vehicle" },
    { value: "Stop for the lead vehicle", label: "Stop for the lead vehicle" },
    { value: "Stop for traffic light / traffic sign", label: "Stop for traffic light / sign" },
    { value: "Resume at traffic light / traffic sign", label: "Resume at traffic light / sign" },
    { value: "Lane change", label: "Lane change" },
    { value: "Yield to VRUs", label: "Yield to VRUs" },
    { value: "Vehicle cut-in", label: "Vehicle cut-in" },
    { value: "Speed bump", label: "Speed bump" },
    { value: "Nudge", label: "Nudge" },
    { value: "Bypass construction objects", label: "Bypass construction objects" },
    { value: "Risky driving", label: "Risky driving" },
    { value: "Curvy road", label: "Curvy road" },
    { value: "Lane change preparation", label: "Lane change preparation" },
    { value: "Nudge preparation", label: "Nudge preparation" },
    { value: "Passing intersection", label: "Passing intersection" },
    { value: "No yield to VRUs", label: "No yield to VRUs" },
    { value: "Consistent driving", label: "Consistent driving" }
  ];

  // Gemini & Groq models that have a free tier (Added rating metrics out of 5)
  const FREE_MODELS = [
    // Gemini 3.1 Pro was removed: Google gives it a free-tier quota of 0, so every request fails (429).
    // Paid-tier users can still type its ID via "Custom model ID…".
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Vision & Text)", speed: 4, accuracy: 4, avail: 4 },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash (Vision & Text)", speed: 4, accuracy: 4, avail: 4 },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (Default)", speed: 5, accuracy: 3, avail: 5 },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite (Vision & Text)", speed: 5, accuracy: 3, avail: 5 },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", speed: 4, accuracy: 4, avail: 4 },
    { id: "llama-3.3-70b-versatile", label: "Groq LLaMA 3.3 70B (Text only)", speed: 5, accuracy: 4, avail: 4 },
    { id: "llama-3.1-8b-instant", label: "Groq LLaMA 3.1 8B Instant (Text only)", speed: 5, accuracy: 3, avail: 5 },
    { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Groq LLaMA 4 Scout (Text only)", speed: 5, accuracy: 4, avail: 5 },
    { id: "qwen/qwen3-32b", label: "Groq Qwen3 32B (Text only)", speed: 4, accuracy: 4, avail: 4 },
    { id: "openai/gpt-oss-120b", label: "Groq GPT-OSS 120B (Text only)", speed: 3, accuracy: 5, avail: 3 },
    { id: "openai/gpt-oss-20b", label: "Groq GPT-OSS 20B (Text only)", speed: 5, accuracy: 4, avail: 5 },
    { id: "llama-3.2-90b-vision-preview", label: "Groq LLaMA 3.2 90B (Vision & Text)", speed: 4, accuracy: 5, avail: 4 }
  ];
  
  const CUSTOM_MODEL = "__custom__";
  const DEFAULT_MODEL = "gemini-3.5-flash-lite";

  // Keeps <select> (presets) and the text input (source of truth for the saved model id) in step.
  function syncModelPicker(select, input) {
    if (!select || !input) return;
    const v = (input.value || "").trim();
    if (FREE_MODELS.some((m) => m.id === v)) {
      select.value = v;
      input.hidden = true;
    } else if (v) {
      select.value = CUSTOM_MODEL;
      input.hidden = false;
    } else {
      input.value = DEFAULT_MODEL;
      select.value = DEFAULT_MODEL;
      input.hidden = true;
    }
  }

  function setupModelPicker(select, input) {
    if (!select || !input) return;
    select.innerHTML = "";
    
    // Helper to generate star strings
    const getStars = (num) => "★".repeat(num) + "☆".repeat(5 - num);

    // Build options with status dots and appended star ratings
    const allModels = [...FREE_MODELS, { id: CUSTOM_MODEL, label: "Custom model ID…" }];
    for (const m of allModels) {
      const o = document.createElement("option");
      o.value = m.id;
      
      let ratingText = "";
      if (m.speed && m.accuracy && m.avail) {
        ratingText = `   |   ⚡${getStars(m.speed)}  🎯${getStars(m.accuracy)}  🟢${getStars(m.avail)}`;
      }

      o.textContent = `🟢 ${m.label}${ratingText}`; 
      o.dataset.modelId = m.id;
      select.appendChild(o);
    }

    select.addEventListener("change", () => {
      if (select.value === CUSTOM_MODEL) { input.hidden = false; input.focus(); }
      else { input.hidden = true; input.value = select.value; }
    });
    syncModelPicker(select, input);
  }

  const MAX_WORDS = 49; // rule: "under 50 words"

  const wordCount = (t) => ((t || "").trim().match(/\S+/g) || []).length;

  // EXAMPLE linter. The private shared.js has the full project rule set; these are generic stand-ins
  // that keep the same function signature, so the side panel runs unchanged.
  const RX = {
    firstPerson: /\b(?:i(?!-\d)|me|my|mine|we|our)\b/i,
    metric: /\b\d+(?:\.\d+)?\s*-?\s*(?:mph|km\/h|kph|m\/s|meters?|metres?|feet|ft|miles?|seconds?|secs?)\b/i,
    cause: /\bbecause\b|\bdue\s+to\b|\bto\s+(?!an?\b|the\b)/i,
    notImperative: /^\s*(?:ego|the|a|an|there|it|this|that)\b/i
  };

  // Deterministic checks. level "error" = firm rule, "hint" = heuristic / may be a false alarm.
  // Returns [{ level, msg, match }]. field is "box1" (Description) or "box2" (Causal Action).
  function lint(field, text) {
    const t = (text || "").trim();
    const out = [];
    if (!t) return out;
    const add = (level, msg, match) => out.push({ level, msg, match });
    let m;

    const n = wordCount(t);
    if (n > MAX_WORDS) add("error", `Too long: ${n} words (must be under 50)`);
    if ((m = t.match(RX.firstPerson))) add("error", `First-person word "${m[0]}" — use "ego" instead`, m[0]);
    if ((m = t.match(RX.metric))) add("error", `Raw metric "${m[0].trim()}" — remove numeric values`, m[0].trim());

    if (field === "box2") {
      if (!RX.cause.test(t)) add("hint", 'No visible cause — add "because …", "due to …" or "to …"');
      if (RX.notImperative.test(t)) add("hint", 'Start with an active verb, e.g. "Slow down because …"');
    }
    return out;
  }

  // Word-level diff (LCS). Returns [{t: "eq"|"del"|"ins", w}]
  function diffWords(a, b) {
    const x = (a || "").trim().split(/\s+/).filter(Boolean);
    const y = (b || "").trim().split(/\s+/).filter(Boolean);
    const n = x.length, m = y.length;
    if (n > 400 || m > 400) return [{ t: "del", w: a }, { t: "ins", w: b }];
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { out.push({ t: "eq", w: x[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "del", w: x[i++] });
      else out.push({ t: "ins", w: y[j++] });
    }
    while (i < n) out.push({ t: "del", w: x[i++] });
    while (j < m) out.push({ t: "ins", w: y[j++] });
    return out;
  }

  root.VLA = {
    MANEUVERS, SPEEDS, CONTEXTS, MAX_WORDS,
    DEFAULT_MODEL, FREE_MODELS, CUSTOM_MODEL, setupModelPicker, syncModelPicker,
    wordCount, lint, diffWords
  };
})(globalThis);