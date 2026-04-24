# YouTube Tuner — Thematic Intelligence Layer

## Purpose

The existing heuristics (PHRASE, SLOP, CAPS, DUPE, WATCHED) are reactive and
manual. PHRASE requires a named pattern before it can act. DUPE suppresses
channel repetition within a batch but has no concept of thematic repetition
across channels.

The result is that novel thematic flooding — five videos about home renovation
from five different channels the user has never seen — passes through the filter
entirely. No rule has been written for it. No channel has been seen twice. But
the user's attention is still being saturated with a single theme.

Thematic intelligence addresses this by classifying video titles against a fixed
label taxonomy and enforcing per-theme density limits within a batch. The system
catches flooding you have not named yet.

---

## Design Principles

**This layer is strictly additive.**
The content script filtering pipeline must work identically whether the thematic
intelligence layer is present or not. The label data is consumed by the pipeline
as an enhancement, never as a dependency. Removing the entire layer leaves v3.9
behaviour intact. This is the test: if the layer can be deleted without touching
content.js, the boundary is correct.

**Observation before action.**
The first implementation is a diagnostic tool only. It classifies titles,
accumulates label counts, and displays them in the HUD. It does not filter.
The taxonomy and thresholds are validated against real feed data before density
throttling is introduced. No throttle is written before the data justifies it.

**The LLM is a heuristic factory, not a runtime filter.**
Classification by LLM happens once per title. The result is persisted to a local
lookup table. At query time the pipeline consults the lookup first; the LLM is
called only for titles not yet in the table. Over time LLM calls become rare.
The goal is a lookup table dense enough that the LLM is the exception, not the
rule.

**Coarseness is a feature, not a gap.**
The label taxonomy does not attempt to accurately describe content — it buckets
attention cost. A title that fits two labels is assigned both and counts against
both density limits. This is intentional. The system is a noise reducer. A
borderline classification that is occasionally wrong causes a missed suppression
or an unnecessary one; neither is catastrophic. Consistency matters more than
precision.

**Server communication is never in the critical path.**
The filtering pipeline never waits for a network response. The background service
worker syncs the master list on a slow polling interval. The content script
consumes whatever is cached locally. A session that begins before the latest list
arrives is filtered against the previous version — this is acceptable and
expected.

---

## Architecture

Three layers, cleanly separated:

```
content script            — filtering pipeline (unchanged from v3.9)
background service worker — local cache, polling, LLM calls, message passing
remote service            — master list hosting, versioning (future)
```

The content script has no knowledge of classification. It sends each hydrated
title to the background worker via `chrome.runtime.sendMessage` and receives a
label array back. If the worker is slow or unavailable the content script
proceeds without labels — the existing heuristics run as normal.

The background worker owns:
- The local lookup table (`chrome.storage.local`)
- The cached master list with timestamp and version
- The polling protocol for the remote service
- LLM API calls for titles absent from the lookup

The remote service is future work. Until it exists, the worker classifies via
LLM only and maintains a local-only lookup table.

---

## The Label Taxonomy

Two-tier. Tier 1 covers broad thematic categories. Tier 2 adds sub-labels within
categories where the distinction is meaningful for density throttling — not every
tier 1 category needs sub-labels.

**The taxonomy is designed from observed feed data, not a priori.** The
diagnostic tool (see below) is the instrument for this. The tier 1 list is
finalised after at least one week of observation on a clean account. Sub-labels
are added where the observed data shows a tier 1 bucket is too broad to be
useful.

The taxonomy is explicitly unstable at this stage. The label sets below are a
starting hypothesis. `other` on both axes is the most important label in the
system — every title that lands there is evidence of a gap in the taxonomy.
Revision is expected and should be driven by what accumulates in `other` during
diagnostic observation, not by intuition.

Changing an existing label definition requires reclassifying the full corpus.
Adding a new label does not — uncategorised titles simply get classified against
the extended set going forward.

Density throttling operates on both axes independently:
- Theme catches content saturation (`gaming` flooding regardless of format)
- Format catches packaging saturation (`reaction` flooding regardless of subject)

Thresholds on each axis are calibrated independently from observed data.

### Axis 1 — Theme (what the video is about)

Neutral categories ensure the classifier always has a valid label for benign
content. High-signal-noise categories are where flooding most commonly occurs.

**Neutral:**
`music_performance`, `standup_comedy`, `cooking`, `travel`, `history`,
`science`, `animals`, `automotive`, `art_craft`, `sports_event`

**High-signal-noise:**
`politics`, `conspiracy`, `celebrity_gossip`, `drama_outrage`, `true_crime`,
`financial_advice`, `crypto`, `real_estate`, `tech_news`, `gaming`, `movie_tv`,
`health_fitness`, `climate_environment`, `war_conflict`, `ai_ml`, `self_help`

**Catch-all:**
`other` — titles that do not fit any theme label; primary signal for taxonomy gaps

### Axis 2 — Format (how the video is packaged)

`reaction`, `tutorial`, `review`, `highlight_clip`, `vlog`, `unboxing`,
`prank`, `challenge`, `live_performance`, `documentary`, `news_summary`,
`podcast_clip`, `longform_interview`, `trailer`, `recap`, `analysis_essay`,
`compilation`, `speedpaint`, `asmr`

**Catch-all:**
`other` — formats that do not fit any label; primary signal for taxonomy gaps

---

## The Master List

The master list is the accumulated output of LLM classification across all
contributing sessions. It is the primary commercial asset of the hosted service.

**Format** — a JSON object:

```json
{
  "version": "2026-04-24T00:00:00Z",
  "entries": {
    "louis ck garden": ["standup_comedy"],
    "gilfoyle hillarios silicon valley": ["standup_comedy"],
    "home renovation bathroom tile": ["art_craft"],
    ...
  }
}
```

Keys are normalised title strings (lowercased, punctuation stripped, stopwords
removed) — the same normalisation the existing `tokenise()` function produces,
joined back to a single string. This ensures that typographic variations of the
same title resolve to the same key.

**Local storage keys:**

| Key | Contents |
|-----|----------|
| `yt-tuner-master-list` | Full list payload |
| `yt-tuner-master-list-meta` | `{ version, fetched_at, last_attempted }` |
| `yt-tuner-label-cache` | Locally classified titles not yet in master list |

---

## Polling Protocol

The background worker checks on each wake:

1. Read `last_attempted` from meta storage
2. If less than 24 hours ago (UTC) — do nothing
3. Otherwise: write `last_attempted = now`, attempt fetch
4. Send current `version` as a request header
5. On 304 Not Modified: do nothing further
6. On 200: write payload to `yt-tuner-master-list`, write `fetched_at = now`,
   update `version` in meta
7. On any failure: log to console, retain stale cache, do not update `fetched_at`

`fetched_at` and `last_attempted` are kept separate. `last_attempted` gates the
next attempt — a server outage does not cause the extension to hammer the
endpoint on every browser session. `fetched_at` records when the cached data was
last actually refreshed and is shown in the diagnostic panel.

The server returns 304 if the client's `version` matches current. This keeps
successful polls cheap — a version string comparison, no payload transfer.

---

## The Diagnostic Tool

The first implementation. Pure observation — no filtering, no side effects on
the feed, no connection to the nuke path.

**What it does:**
- Intercepts each hydrated title after the hydration gate passes
- Sends the title to the background worker
- Worker returns a label array (lookup hit, LLM classification, or empty on
  failure)
- Session label counts are accumulated in memory
- A new HUD panel displays a live sorted frequency table: label → count

**What it does not do:**
- It does not call `nuke()` or set any style on any container
- It does not affect what the user sees
- It does not affect the nuke counter
- It cannot cause throttling, signal vacuum, or account-level feature changes

**What it measures:**

On the developer account (known to be adversarially skewed by deliberate
engagement poisoning): the diagnostic reveals how dominated the feed is by
specific themes and confirms that the existing PHRASE heuristics are catching
the right signals.

On a clean account: the diagnostic produces a representative picture of what
YouTube actually serves to a neutral user. This is the baseline for taxonomy
validation and threshold calibration. The developer account is not a valid
baseline for this purpose.

The two observations are kept separate. Conclusions drawn from the developer
account apply only to that account unless confirmed on the clean account.

---

## Commercial Layer

The remote service hosts and distributes the master list. The extension
architecture supports this layer without changes to the content script or the
filtering pipeline.

Access control, client tracking, and abuse handling are deferred to a dedicated
design phase. The polling protocol's `version` and `last_attempted` fields
provide the necessary hooks.

*This section is intentionally brief. Commercial layer design begins after the
local diagnostic and classification pipeline are validated.*

---

## Implementation Sequence

Each step is independently deployable. Steps 1–4 have no effect on filtering
behaviour — they are observable only.

| Step | What | Gate |
|------|------|------|
| 1 | Background service worker stub — receives title messages, returns empty arrays | Branch created |
| 2 | Diagnostic HUD panel — label frequency table, wired to worker | Worker stub live |
| 3 | Local LLM classification — Haiku, temp 0, constrained enum output, cache miss only | Panel showing data |
| 4 | Master list sync — polling protocol, local cache, version management | LLM classification stable |
| 5 | Density throttle — per-theme limits wired into processPage() | Taxonomy validated, thresholds calibrated from data |
| 6 | Remote service | Throttle validated on developer account |

**The gate for step 5 is real data, not a calendar.** The density throttle is
not written until the diagnostic panel has produced enough observations to
justify specific threshold values. A throttle written before that data exists
is speculation.
