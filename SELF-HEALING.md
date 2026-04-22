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
A correction that has not been confirmed in 7 days is treated as stale and
dropped from the active set (but retained in the table below for reference).

### Confidence threshold

A candidate tag is only persisted if:
- It appeared as the pivot in ≥2 independent anchor searches
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
| — | — |

This table is populated as test cases are written.

---

## Failure modes

| Scenario | Behaviour |
|----------|-----------|
| Bad pivot candidate persisted | Stale tag expires after 7 days; hardcoded baseline continues to function |
| Anchor search finds no beacons | No correction attempted; CRIT remains in HUD |
| YouTube reverts a rename | Old tag reappears; hardcoded baseline already covers it |
| localStorage cleared | Cold start; hardcoded baseline takes over immediately |
