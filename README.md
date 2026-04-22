# YouTube Tuner

Reduce visual clutter on YouTube’s homepage and search results — without blocking channels or watch pages.

**YouTube Tuner** is a browser userscript that automatically hides video cards you’d likely skip anyway: clickbait phrases, grammar slop, excessive caps, already-watched videos, and duplicate channels in a single scroll batch.

It works only on the **homepage** and **search results**. Channel pages and watch pages are untouched — your intent to explore a specific creator is never interrupted.

---

## Why use it?
YouTube’s algorithm surfaces relevant content but often fails to filter out "annoying" content. You’ve likely seen:
* **"DONT CLICK THIS 🔥🔥🔥"**
* **"I UNALIVED MY PC (GONE WRONG)"**
* The same channel filling your feed with 6 nearly identical videos.
* Videos you already watched 95% of, still being recommended.

YouTube Tuner quietly removes these cards. Nothing is deleted or reported; the card simply becomes invisible (`display: none`). You can still find the video by searching for it directly.

---

## What it filters (and why)

| Filter | What it catches | Example |
| :--- | :--- | :--- |
| **Phrase** | Clickbait regex + your own custom phrases | "OMG", "GONE WRONG", "BREAKS REALITY" |
| **Slop** | Missing apostrophes, repeated punctuation | "dont do this!!", "WOW???" |
| **Caps** | >50% caps (short words like "OK" are ignored) | "THIS IS INSANE" |
| **Watched** | Videos you’ve watched >90% (red progress bar) | Any video at 95% watched |
| **Duplicate** | Only 1 video per channel per scroll batch | 2nd or 3rd video from the same channel |

*All filters are on by default but can be toggled off individually for the current session via the on‑screen panel.*

---

## Installation (Non-Technical)

1.  **Install a userscript manager** extension:
    * [Tampermonkey](https://www.tampermonkey.net/)
    * [Violentmonkey](https://violentmonkey.github.io/)
2.  **Create a new script** in your manager dashboard.
3.  **Copy and paste** the entire script content into the editor.
4.  **Save** (`Ctrl+S` / `Cmd+S`).
5.  **Reload YouTube.**

> **Note:** Firefox is fully supported. Chromium support is on the roadmap but not yet implemented.

---

## How to use

### The HUD (Heads‑Up Display)
Located in the top-right corner of YouTube:
* **NUKED counter:** Total videos hidden since page load.
* **Log area:** Scrollable list of hidden videos with reason codes.
* **📸 button:** Downloads a snapshot of the current page (for debugging).
* **▲/▼ button:** Collapses or expands the log.

### The Filter Panel (Click ⚡)
* **Toggle filters:** Turn specific logic on/off (resets on page reload).
* **Custom phrases:** Add or remove words like "sponsored" or "reaction." These are **persistent** and saved in your browser.

---

## For Developers & Technical Users

### Architecture Overview
YouTube Tuner uses a narrow `MutationObserver` attached to the active browse results renderer rather than the entire document. Navigation is driven by YouTube’s native `yt-navigate-finish` event to avoid "ghost-renderer" issues.

### Key Components
| Component | Purpose |
| :--- | :--- |
| `heuristics` | Object containing filter toggles and session counters. |
| `customPhrases` | Array persisted in `localStorage` (`yt-purge-phrases`). |
| `attachNarrowObserver()` | Targets `ytd-two-column-browse-results-renderer`. |
| `runHealthCheck()` | Validates DOM structure; triggers capture on failure. |
| `runAnchorSearch()` | Uses the last 5 nuked titles to identify new container tags after a layout change. |

### Hydration Gate
To prevent false negatives, containers are only processed when:
1.  Title text length is >= 3 characters.
2.  A thumbnail image is present.

Processed containers are stamped with `dataset.ytPurgeProcessed`. If YouTube recycles the DOM node, the stamp is updated and the video is re-evaluated.

### Heuristic Logic
* **Caps:** `letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.5` (only for titles > 10 chars).
* **Watched:** Parses `#progress` element’s `style.width` integer.
* **Duplicate:** Map of `channelName` → `count` per `processPage()` batch.

---

## Known Limitations & License
* **Shadow DOM:** Closed shadow roots are not serialized in DOM captures.
* **Layout Changes:** Channel name extraction may fail if YouTube updates its CSS selectors; the script falls back gracefully.
* **License:** Unlicense / Public Domain. Use at your own risk.

**Version:** 3.8 (Stable) | **Authors:** Magnus Ribsskog, Claude
