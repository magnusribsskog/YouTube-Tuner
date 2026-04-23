# YouTube Tuner

A Chrome extension that quietly hides low-quality video cards from YouTube's
homepage and search results — without touching channel pages, watch pages, or
anything you're already intentionally looking at.

**Status:** Working and in daily use. Not yet published to the Chrome Web Store.
See [ROADMAP.md](ROADMAP.md) for what's blocking publication and what's next.

---

## What it filters

| Filter | What it catches |
| :--- | :--- |
| **Phrase** | Clickbait regex + your own custom phrases |
| **Slop** | Missing apostrophes, repeated punctuation |
| **Caps** | >50% uppercase ratio in title |
| **Watched** | Videos you've already watched >90% |
| **Duplicate** | More than one video per channel per scroll batch |

All filters are on by default and can be toggled per-session via the on-screen panel.

---

## Repository layout

```
extension/          ← active code (Chrome extension, MV3)
  manifest.json
  content.js

legacy/             ← userscript versions v3.7–v3.9 (reference only)

ROADMAP.md          ← development direction and design decisions
CONSULTATIONS.md    ← external consultations with Gemini Pro on ethical questions
SELF-HEALING.md     ← self-healing selector architecture
DIAGNOSTIC.md       ← diagnostic export format spec
```

---

## Installation (developer mode)

The extension is not yet on the Chrome Web Store. To run it:

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `extension/` folder
5. Open YouTube

The HUD appears in the top-right corner of the homepage and search results.

---

## The HUD

- **NUKED counter** — videos hidden since the page loaded
- **Log** — scrollable list of hidden titles with filter reason
- **⚡ button** — toggle the filter panel (per-session toggles + custom phrases)
- **📸 button** — download a DOM snapshot for debugging
- **✱ button** — export a structured session diagnostic
- **▲/▼ button** — collapse or expand the log

---

## Self-healing

YouTube periodically renames its custom element tags. When that happens,
the extension detects the structural failure, searches the DOM for known
video titles, identifies the new tag, and corrects its selector set — without
a page reload. See [SELF-HEALING.md](SELF-HEALING.md) for the full design.

---

## Design principles

Filtering applies to **homepage and search only**. Channel pages and watch
pages are explicitly out of scope.

The extension stores everything locally in `chrome.storage.local`. Nothing
is transmitted anywhere. No analytics, no telemetry, no external services.

---

## Authors

Magnus Ribsskog and Claude — [Unlicense](https://unlicense.org/) / Public Domain

