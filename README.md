# VLA Reviewer

A Chrome (Manifest V3) side-panel extension that helps you check VLA annotation text against the required standards before you submit. It combines instant local rule checks, an AI audit and chat assistant (Google Gemini or Groq), a speed calculator driven by the clip's own telemetry, and personal statistics.

> **Disclaimer:** Independent tool, not affiliated with or endorsed by the annotation platform it works with. Use it in line with that platform's rules.

## Features

### Compliance checking
- **Fetch from page**: reads the Description, Causal Action, Maneuver, Speed change and Context tags from the annotation page (`content.js`, injected on demand).
- **Live local linter**: instant offline checks while you type: word limit (under 50), first-person words, raw metrics, hardware/observer/time words, vehicle terms and colors, lane counts, causal-action wording, and more. Word counter on each field.
- **AI audit ("Check Compliance")**: the model reviews both text boxes plus the selected labels, and returns violations with suggested rewrites and a word-level diff.
- **Telemetry cross-checks (no AI needed)**: compares your annotation with the clip's acceleration, steering and brake channels, for example flagging a lateral maneuver when steering never moved. Also includes an action-point check.
- **Per-violation tools**: 💬 discusses a violation in the AI chat, ✕ dismisses it and marks the text compliant.
- **Rephrase**: asks the model for a different wording of a suggested Description or Causal Action.
- **Apply to page + Undo/Redo**: applies suggested text to the annotation page, with per-clip undo/redo history.
- **Auto-fetch and auto-audit** when you switch clip or tab, an optional **violations badge** on the toolbar icon, and an optional warning when switching to a different clip.
- **Per-clip audit history** card showing earlier audits of the current clip.

### AI Chat ("VLA Assistant")
- Ask about the guidelines, edge cases and phrasing.
- **Check speed change** and **Describe ego's environment** one-tap tools.
- **📷 Camera analysis**: auto-screenshots the camera views and runs a two-stage scene review: an image model first *observes* what is in the scene, then a text model *writes* the Description from those observations only. The result is linted and uncertain points are listed.
- **AI rule editor**: the chat can *propose* edits to the rule blocks; nothing changes until you press **Apply rule** (with an undo for each change).
- **AI panel editor**: the chat can *propose* values for the Description, Causal Action, Maneuver, Speed change and Contexts, applied to the panel and the page only after you confirm.
- Suggestion bubbles and separate model selection for review/audit, chat, and image analysis.

### Speed Calculator
- Reads the speed at the action point and N frames later (10-50 frames), then recommends one of: Stop, Decelerate, Maintain speed, Accelerate, Remain stopped, Resume motion.
- **Autocheck**: runs automatically when a clip loads and keeps tracking in real time; shows a status banner and a result popup.
- **Apply to Page**: opens the speed-change dropdown on the annotation page and picks the recommended option.
- Uses whole-clip telemetry from the site's own clip API, so most lookups don't move the playhead.
- Tunable thresholds (near-stop speed, stop drop, maintain band). Option to disable speed checks in review mode.
- A **Calculate** button next to the Speed change dropdown fills it from the measured speed.

### Statistics (📊)
- Time ranges: Today, 7 days, 30 days, All time.
- Category filter: Description, Causal Action, Maneuver tag, Speed change tag, Context tags, Grammar errors.
- Tracks clips opened (counted when a clip URL is navigated to, even when the panel is closed), clips audited, audit attempts, and **first-pass compliance** (attempts that were clean immediately).
- Includes playful progress nudges based on unaudited clips and your first-pass score.
- Stored locally in `chrome.storage.local` only; can be reset at any time.

### Bookmarks (🔖)
- Save any Description, Causal Action or AI reply with ☆; add bookmarks manually.
- Filter by type (Description / Causal / Chat) and by maneuver, plus text search.
- Shared across all clips.

### Prompts editor (🧠, in Settings)
- Every rule block (universal rules, description rules, causal rules, maneuver rules, examples, output format, vision rules, and more) can be viewed and edited, with restore-this-block, restore-all, and import/export.
- Edits apply to every AI feature: audit, chat, rephrase, validation and camera auto-description.

### Camera overview
- Double-click a camera image (Left / Front / Right / Rear left / Rear right) to open it large on the same tab. Left-click zooms in, right-click zooms out, drag pans, ← → keep stepping through the clip while the view follows live, ‹ › or ↑ ↓ switch camera, and the frame counter is mirrored at the top. The action-frame pill turns green for the 19-frame window ending at the action frame.

### Screenshot tool
- Drag a rectangle on the annotation page and the area is copied to the clipboard as a PNG (falls back to saving a file).

### Other
- Context-menu actions: Check VLA Compliance, Speed Check, Screenshot, Copy Clip URL.
- **Return to Clip** and **Google Sheets** shortcut buttons (the sheet URL is set in Settings).
- Light/dark theme, backup API keys that take over when the first hits a rate limit, and live model-availability indicators.

## Install (unpacked)

1. Clone or download this repo.
2. Create your working copies of the two guideline files (they are not committed, see [Guideline files](#guideline-files)):
   ```sh
   cp prompts.example.js prompts.js
   cp shared.example.js shared.js
   ```
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.
5. Open **Settings** (⚙) and paste an API key (see below).

## Guideline files

The rules the reviewer enforces live in two files. This repo ships **example** versions of them with the same API, so the extension runs out of the box:

| Example file | Copy to | What to put in it |
| --- | --- | --- |
| `prompts.example.js` | `prompts.js` | Your rule blocks (universal, description, causal, maneuver, vision, scene rules, examples). They can also be edited at runtime in **Settings → 🧠 Prompts**, with import/export. |
| `shared.example.js` | `shared.js` | The local linter rules in `lint()`. Keep `MANEUVERS`, `SPEEDS` and `CONTEXTS` identical to the option labels on the annotation page, because `content.js` clicks them by text. |

`prompts.js` and `shared.js` are listed in `.gitignore`, so your real guidelines stay on your machine.

Requires Chrome 116 or newer.

## API keys

The AI features need a key for at least one provider:

- **Gemini**: create a free key in [Google AI Studio](https://aistudio.google.com/apikey)
- **Groq**: create a free key in the [Groq console](https://console.groq.com/keys)

Keys are stored only in `chrome.storage.local` in your browser and are sent only to the provider's API. Free-tier requests may be used by the provider to improve its products, so don't send anything you aren't allowed to share. Image analysis requires a vision-capable model.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Fetch and check the current page | `Ctrl+Shift+K` (`Cmd+Shift+K` on Mac) |
| Screenshot to clipboard | `Alt+Shift+S` |

Change them at `chrome://extensions/shortcuts`.

## Project structure

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker: context menus, shortcuts, audit hand-off, clip-open tracking, screenshot capture |
| `sidepanel.html/js/css` | Main UI: audit, chat, calculator, statistics, bookmarks, settings |
| `options.html/js` | Full-page Settings |
| `shared.js` (from `shared.example.js`) | Maneuver/speed/context lists, local linter, word diff, model picker |
| `prompts.js` (from `prompts.example.js`) | Shared rule blocks and prompts for all AI features |
| `content.js` | Reads and writes the annotation page fields (injected on demand) |
| `zoom.js` | Camera overview (content script) |
| `snip.js` | Screenshot tool (injected on demand) |
| `offscreen.html/js` | Clipboard helper for the context menu |

## Permissions

`sidePanel`, `storage`, `activeTab`, `scripting`, `tabs`, `contextMenus`, `clipboardWrite`, `offscreen`, plus host access to the Gemini and Groq APIs. Access to the annotation site is requested as an optional permission.

## Privacy

All settings, keys, bookmarks, statistics and history stay in your browser (`chrome.storage`). The only data sent out is the text, labels and (for camera analysis) screenshots you choose to run through the AI features, sent to the model provider you configured.

## License

Add a license here, e.g. MIT (see `LICENSE`).
