# Self-Healing Selector Architecture

## What we're trying to do

YouTube periodically renames its custom element tags. When that happens, the
script's container detection breaks silently — cards stop being evaluated, the
HUD shows zero nukes, and there's no obvious error. The current architecture
detects this via the health check and anchor search, reports it, and stops
there. This branch explores pushing that one step further: automatic recovery.

## Design

### Cold start

The hardcoded container tag set in the script is the baseline. It ships with
known-good tag names and never goes empty. localStorage corrections augment
the baseline — they do not replace it. A cold start with empty localStorage
behaves identically to v3.8.

### Discovery

When the health check fires a CRIT and anchor search finds pivot candidates,
instead of only reporting them to the HUD, the code:

1. Validates the candidate — requires ≥2 beacon title matches before committing
2. Writes the discovered tag to localStorage with a timestamp and hit count
3. Adds it to the active container tag set for the current session
4. Reattaches the observer and re-runs processPage()

### Persistence

localStorage entry format:

```json
{
  "yt-tuner-selector-corrections": [
    {
      "tag": "YTD-NEW-ITEM-RENDERER",
      "discovered": "2026-04-22T10:00:00Z",
      "hits": 3,
      "last_confirmed": "2026-04-22T10:00:00Z"
    }
  ]
}
```

On startup, corrections are loaded and merged with the hardcoded baseline.
A correction is valid until the health check fires again — at which point the
anchor search re-runs and either reconfirms it or replaces it. There is no
time-based expiry. YouTube renames tags in deployments, not gradually.

### Beacon sources

Anchor search has two beacon sources depending on session state:

**Normal path — nuke log:** the last 5 confirmed-nuked titles. These are known to have been fully rendered (passed the hydration gate) before being hidden, making them reliable DOM search targets.

**Cold start — synthetic beacons:** when the nuke log is empty (fresh install, cleared localStorage), anchor search synthesizes beacons from h3 elements currently visible in the DOM. Only h3s whose parent chain contains a YTD-* element that is a direct child of `div#contents` are counted. This is the same structural filter used by `findVideoContainerFromElement`, so it exclusively matches real video card containers. The ≥2 threshold still applies.

### Confidence threshold

A candidate tag is only persisted if:
- It appeared as the pivot for ≥2 independent beacons in a single anchor search run
- It is a valid YTD- prefixed custom element name
- It is not already in the hardcoded baseline

---

## Known selector mutations

This table is maintained outside the code deliberately. It is the human-readable
record of what YouTube has changed, when, and what the script found.

| Date | Old tag | New tag | Discovered by | Confirmed |
|------|---------|---------|---------------|-----------|
| — | — | — | — | — |

As corrections are discovered in the field, they are recorded here manually.
This table is the ground truth. The localStorage cache is the runtime mirror.

---

## Test harness

The branch includes a deliberately broken selector set for local testing.
To simulate a YouTube rename, the following tags in the script have been
replaced with fictional names. The self-healing logic should discover and
correct them within one page load.

| Real tag | Broken tag used in test |
|----------|------------------------|
| YTD-RICH-ITEM-RENDERER | YTD-RICH-ITEM-RENDERER-BROKEN |
| YTD-VIDEO-RENDERER | YTD-VIDEO-RENDERER-BROKEN |

---

## Failure modes

| Scenario | Behaviour |
|----------|-----------|
| Bad pivot candidate persisted | Health check re-runs on next page load and re-evaluates via anchor search; hardcoded baseline continues to function |
| Anchor search finds no beacons | No correction attempted; CRIT remains in HUD |
| YouTube reverts a rename | Old tag reappears; hardcoded baseline already covers it |
| localStorage cleared | Cold start; hardcoded baseline takes over immediately |
