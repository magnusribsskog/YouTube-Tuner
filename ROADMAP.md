# YouTube Tuner — Development Roadmap

## Guiding Philosophy
The goal is to make the YouTube homepage useful for discovering good content,
not to curate a perfect feed. We fight the algorithm's manipulation without
trying to replace its function entirely.

Filtering applies to **homepage and search only**. Channel pages and watch page
sidebars are explicitly out of scope — the user is already expressing intent
by being there.

---

## Design Principles

**Fallback code is legacy code, not safe code.**
Every fallback path represents a known failure state. Fallbacks are retained
for resilience but must always report their activation as [CRIT] to the HUD.
A silent fallback is indistinguishable from correct operation and is therefore
unacceptable. Legacy code blocks are clearly marked as such in the source and
carry a comment explaining what they are waiting to be replaced by.

**Server communication is strictly decoupled from real-time filtering.**
The filtering pipeline never blocks on a server response. A batch is always
evaluated against whatever local rules exist at the moment it renders.
The HUD is the control plane: it communicates with the server asynchronously
in the background, receives updated signatures and rules when they arrive,
and folds them into local storage. The filter code itself has no knowledge
of the server. A batch that renders before the latest rules arrive is
evaluated against the previous ruleset — this is acceptable and expected.
Forcing a batch to wait for a server response is explicitly not permitted.

**The LLM is a heuristic factory, not a runtime filter.**
Its role is to perform expensive semantic analysis once — identifying cluster
signatures, labelling themes, generating rules — and to produce durable local
heuristics that run at near-zero cost indefinitely. If the LLM is unavailable,
all locally derived heuristics continue to operate. The system degrades
gracefully. The goal over time is to reduce reliance on static regex and manual
phrase lists by replacing them with LLM-derived rules that the user never has
to write themselves.

**Two build tiers exist and must remain distinct.**
The public build (app stores) contains no automated navigation, no beacon
recovery, and no actions that fire impressions or shape recommendation history
without explicit user intent. The master build (Magnus and Claude only) permits
full automation — beacon recovery, automated search navigation, all diagnostic
and self-healing tooling. Any feature involving automated navigation or
impression-firing without user intent is master-build only by default. Promoting
such a feature to the public build requires an explicit, documented decision.

**Filtered elements must not be removed from the DOM before their telemetry lifecycle completes.**
The prohibition on "opacity theatre" was written against fake engagement — making
YouTube believe a user saw and considered content they never encountered. That
prohibition stands. But it was misapplied: using `display: none` to remove a
shell element before YouTube's IntersectionObserver has fired produces the
opposite problem — a telemetry black hole, not theatre. A user scrolling past a
video they choose not to click generates exactly this signal: impression beacon
fires, no engagement event follows. That is the honest signal. Filtered elements
must be visually collapsed, not DOM-removed, until their hydration lifecycle and
telemetry dispatch are complete.

---

## Released

### v3.0 — Stable
- Static heuristics: PHRASE (regex), SLOP (grammar), CAPS (ratio)
- MutationObserver batch-on-mutation strategy
- Shadow DOM HUD with nuke count and log pipe
- `h3` selector + `findVideoContainerFromElement` DOM walk

### v3.1 — Stable
- Collapse button replaces close button on HUD
- Host element stays in document at all times — fixes observer silently dying
  when HUD was hidden

### v3.2 — Stable
- Added STOPWORDS set (structural English + YouTube-register neutral vocabulary)
- Added `tokenise()` function — lowercases, strips punctuation, filters stopwords

### v3.3 — Superseded (tuning prototype)
- Added tuning mode and localStorage word frequency baseline
- **Finding:** baseline built from channel pages poisoned the data.
- **Decision:** tuning deferred to post-extension phase.

### v3.4 — Superseded by v3.4.1
- Page context detection, channel dedup, tuning removed
- **Finding:** resource usage too high without debounce.

### v3.4.1 — Stable
- requestAnimationFrame debounce on MutationObserver
- Context switching confirmed working

### v3.5 — Stable
- Word panel with heuristic toggles (session-only) and per-filter counts
- Custom PHRASE list persisted to localStorage
- CSP fix: replaceChildren() replaces innerHTML throughout

### v3.6 — Stable
- Personal/overly-broad terms removed from CONFIG.clickbait
- HUD WARN entries (amber) when channel name selectors fail
- WARN entries do not increment nuke counter

### v3.6.1 through v3.6.9 — Diagnostic series
All features from this series are present and confirmed working in v3.6.9.
Key confirmed findings and implementations:

**Filtering:**
- PHRASE, SLOP, CAPS, DUPE heuristics all functional
- grammarSlop expanded: punctuation repetition ({2,})
- Pipeline evaluation test token confirmed and removed
- All heuristic toggles and custom phrase list working end-to-end

**Observer architecture:**
- MutationObserver narrowed to ytd-two-column-browse-results-renderer
  (confirmed via console inspection of parent chain above ytd-rich-item-renderer:
  div#contents → ytd-rich-grid-renderer → div#primary →
  ytd-two-column-browse-results-renderer → ytd-browse →
  ytd-page-manager#page-manager → div#content → ytd-app)
- SPA re-attachment: watches documentElement for browse renderer change
- Legacy fallback to document.body retained, always reports [CRIT]

**Hydration and recycling:**
- Hydration gate: containers not processed until title + thumbnail present
- Pending retry: failed hydration marked and retried on next RAF cycle
- Recycled container handling: ytPurgeProcessed stores title text, not "1"
- Static DOM early exit: skips full scan when nothing new to evaluate
- Nuke counter: ytPurgeNuked flag prevents inflation from rehydration

**Diagnostics:**
- Health check: verifies ytd-app, ytd-two-column-browse-results-renderer,
  ytd-rich-grid-renderer, ytd-rich-item-renderer at startup on homepage only
- DOM capture: 📸 button + automatic capture on CRIT failure states
- Anchor search: uses last 5 nuked titles as DOM search beacons on failure;
  reports pivot candidates to HUD, never auto-applies
- [DIAG] console logging throughout; [INFO], [WARN], [CRIT] HUD levels

**Known limitations (documented in code):**
- Channel dedup confirmed working in practice across observed sessions.
  Technically, channel name extraction fails on ytd-rich-item-renderer via
  standard selectors and shadow root traversal (no shadow roots found).
  In practice, dedup fires correctly and consistently — the mechanism is
  not fully understood but the observable result is correct. No issues identified.
- Health check scoped to homepage context only — fires once per page load
  when context is "home", skipped silently on watch/channel pages.
  Prevents false [CRIT] entries during SPA navigation.

### v3.6.91 — Stable (lifecycle revert)
Navigation-gated lazy lifecycle attempted in v3.6.9 reverted. All genuine
improvements from v3.6.9 retained.

**Retained from v3.6.9:**
- WATCHED heuristic: filters videos watched >90% via resume playback progress bar
- Context-aware health check: three gates (filteringActive, skeleton detection,
  video item validation) — no longer fires false [CRIT] on non-home pages
- DOM capture framework: 📸 button + automatic capture on CRIT failure states
- Anchor search framework: uses last 5 nuked titles as DOM beacons on failure
- Hydration gate: containers not processed until title + thumbnail present
- Nuke counter: ytPurgeNuked flag prevents inflation from rehydration
- All v3.6.8 and earlier confirmed features

**Reverted: Navigation-Gated Lifecycle — do not attempt again without resolution**
Attempted to defer all script activity until context confirmed as home/search.
The approach failed in two distinct ways that compound each other:

1. The SPA navigation observer (document.documentElement, subtree:true) fires
   on every DOM mutation including scroll. With subtree:false it missed channel
   → home navigation. With subtree:true it fired hundreds of times per scroll,
   calling boot() repeatedly before the booted flag was set, each call
   replacing the feed observer via attachNarrowObserver(). The feed observer
   was being destroyed and recreated on every scroll mutation.

2. The async nature of waitForPrimaryTarget (setTimeout polling) means booted
   is not set synchronously. Any guard relying on booted to prevent re-entry
   has a race window between the first boot() call and when booted becomes true.
   Multiple competing waitForPrimaryTarget chains ran simultaneously, each
   replacing the observer the previous one had just attached.

3. Direct load and hard reload do not fire the SPA navigation observer at all.
   A separate initialRenderObserver was needed, adding a third observer and
   further complicating lifecycle reasoning.

**Root cause:** The navigation-gated model requires synchronous, single-fire
wakeup. YouTube's SPA mutation model is fundamentally incompatible with this.

**What would be needed to revisit:**
- yt-navigate-finish (YouTube's native SPA navigation event) — adopted in v3.8+
- Extension build with chrome.webNavigation API — provides genuine single-fire
  navigation events, available in v4.0

**Restored architecture:** Proven v3.6.7 init — eager HUD injection, single
waitForPrimaryTarget polling chain, SPA re-attachment on renderer change only.

### v3.8 — Stable
- Session diagnostic export via ✱ button in HUD
- Exports structured markdown per DIAGNOSTIC.md spec
- Nuke log entries now store {reason, label} objects (backward-compat with v3.7)
- systemEvents[] captures WARN/CRIT entries for export
- DIAGNOSTIC.md added to repo as stable format spec
- yt-navigate-finish replaces documentElement MutationObserver for SPA lifecycle

### v3.9 — Stable
- CONTAINER_TAGS_BASELINE: hardcoded tag set, never modified at runtime
- localStorage corrections: discovered tags merged with baseline at startup
- Anchor search extended: unknown YTD-* pivot with ≥2 beacon confirmations
  is committed to localStorage and added to active tag set for the session
- Observer reattaches and processPage() recovers filtering without reload
- Diagnostic export extended with Selector Corrections section
- Fallback container detection: div#contents heuristic replaces class-based
  selector — correctly resolves the outermost card container without knowing
  its tag name; grid space collapses correctly
- Confirmed stable: self-healing proven in field; boots correctly from
  channel page → Home SPA navigation entry point

### v3.9 extension build — Diagnostic session (2026-04-24)

**Finding: WATCHED and DUPE selectors broken — YouTube DOM change**
Both filters are silent across all legacy versions (3.7, 3.8, 3.9 Firefox)
and the current Chrome extension build. Confirmed pre-existing: regression
analysis shows the failure exists in legacy code before any extension work.
Root cause: YouTube changed their DOM structure for the watched-video progress
bar and/or channel name elements. Selectors hardcoded since v3.7.

Selectors to verify against live DOM tomorrow:
- WATCHED: `ytd-thumbnail-overlay-resume-playback-renderer #progress`
- DUPE: `ytd-channel-name #text`, `#channel-name #text`, `#channel-name`, etc.

**Diagnostic infrastructure added (to be stripped or gated before publication):**
- `watchForUnhide()` — MutationObserver on each nuked container watching
  `style` attribute; fires [WARN][UNHIDE] to HUD if YouTube restores display
- `getWatchedPercent()` — replaces inline progress bar query; adds shadow DOM
  piercing via `renderer.shadowRoot.querySelector("#progress")`; traces source
  (light-DOM / shadow-DOM / no-renderer) to console per evaluation
- `window.ytDiag.audit()` — callable from DevTools console; prints one row per
  video card: nuke status, display style, dupe-done stamp, watched %, channel
  name, session stamp prefix. Identifies culprits directly without guessing.
- `attributeFilter: ["src"]` added to MutationObserver — fires schedulePage
  when thumbnail src attributes change, reducing pending-container delay

**Architectural finding: self-healing blind spot**
Self-healing (v3.9) covers container tag renames — the skeleton of the card.
It does not cover internal selectors: WATCHED and DUPE break silently when
YouTube moves their target elements, producing no evidence trail and no
recovery path. Container renames leave beacons (nuked titles still in DOM);
internal selector failures produce silence.

This is the exact failure mode self-healing was designed to prevent, now
confirmed for a class of selectors outside its scope. Open question: can the
self-healing model be extended inward? No solution yet. See notes.org.

**DUPE architecture change:**
- Per-scan `channelSeen` Map replaced with session-level `seenChannels` Set
- Cleared on `yt-navigate-finish` alongside sessionId
- Deferred re-check: stamped containers without `ytPurgeDupeDone` retried on
  subsequent scans until channel name resolves

### Hardening phase addition — MetricsService (2026-04-26)

Shipped during human use observation. Additive and non-invasive — does not
touch filtering logic.

**What it does:** records one session record per navigation session to
`chrome.storage.local` under key `yt-purge-metrics`. Upserts every 10 cards
evaluated and on `yt-navigate-finish`. Capped at 30 sessions; oldest rotated
out automatically.

**Schema v1:**
```js
{ v, id, t0, t1, cards, nuked, counts: { PHRASE, SLOP, CAPS, DUPE, WATCHED } }
```
- `t0` / `t1` — session start and last-upsert timestamps; gap relative to
  `cards` detects stale open tabs
- `cards` — total cards stamped `ytPurgeProcessed` this session
- `nuked` — total cards hidden this session
- `counts` — per-heuristic nuke counts; `counts.X / nuked` gives composition,
  `counts.X / cards` gives absolute filtering rate

**What it does not do:** drift detection, confidence computation, and HUD
surface are not yet implemented. This is the data collection scaffolding only.
Those are planned — see HUD ratio drift indicators below.

**Confirmed working (2026-04-26):** four sessions observed in storage after
first use. WATCHED sitting at zero across all sessions is consistent with
account recovery — YouTube surfacing fewer re-watch candidates as the signal
vacuum clears. Worth monitoring as the account normalises.

---

## Planned

### Hardening phase — Human use observation (active, 2026-04-25)

**No new features until this phase is complete.**

Magnus uses YouTube as normally as possible for several days. Existing selectors
(WATCHED, DUPE) observed under real conditions. Any breakage documented and
fixed against main. Goal: a stable baseline before advancing the roadmap.

If WATCHED or DUPE goes silent during this period, the recovery path is the
reference video beacon — see Vision / Self-healing blind spot below.

v4.1 (thematic intelligence) is explicitly paused until this phase completes.

---

### HUD ratio drift indicators — Read side of MetricsService

**Depends on:** MetricsService (shipped), sufficient real-world sessions to
establish a baseline. Do not implement until hardening phase produces enough
data to reason about.

**What this is not:** an alarm system. Drift indicators are posture signals —
the HUD communicates that something looks unusual, not that something is broken.

**Baseline:** rolling per-category ratios computed from the last N sessions
with sufficient cards (threshold TBD from observed data). The baseline is
account-contextual and learned — not hardcoded. Sessions with fewer than ~30
cards are low-confidence and weighted accordingly. No baseline exists until
enough sessions accumulate; silence during warm-up is honest.

**Drift detection:** compare current session ratios against rolling baseline.
Surface an indicator in the HUD when a category diverges beyond a tolerance
band. The WATCHED metric is the primary signal — persistent zero output
across sessions with sufficient cards is the trigger for beacon recovery.

**Confidence display:** indicators carry their confidence level. "WATCHED has
been dark for N sessions (moderate confidence)" is more useful than a bare
alarm. Uncertainty is part of the information.

**Implementation note:** reads from `yt-purge-metrics` in Storage. All
computation happens at read time; nothing additional is written to storage.
The MetricsService schema is designed to support this without modification.

---

### Passive algorithmic signal mining

**Depends on:** HUD drift indicators (infrastructure to consume new signals).
**Precondition for:** v4.1 — thematic intelligence requires feedback to be meaningful.

Two signals, both passive and non-destructive. Observable from the DOM without
any interaction, navigation, or API access. Neither fires any event or shapes
any YouTube-side state.

**Autoplay target tracking:** YouTube's autoplay queue is the algorithm's
unmediated statement of intent — what it believes should follow, without any
user input. Readable from the player. Recorded per session. The most direct
signal of algorithmic position available without API access. A session where
autoplay consistently targets filtered categories is a session where the
algorithm has not absorbed the filtering signal.

**Re-appearance rate:** same channel or video surfacing more than once per
session. Extends DUPE from a defensive filter into a diagnostic. Repeated
surfacing after non-engagement is the algorithm's counter-move — it disagrees
with the filter's assessment and is pushing back. Tracked per-session by
channel. A rising re-appearance rate for a filtered category indicates
algorithmic insistence, not a filter failure. Distinguishes "the filter is
working" from "the filter is working and the algorithm is fighting it."

Schema extension to MetricsService or companion storage key — to be decided
at implementation time based on what the existing schema can accommodate.

---

### Pre-publication gate — Lifecycle integrity (blocking)

**This gate must be cleared before the extension is recommended to any user
other than the developer. It is not a feature. It is the precondition for
responsible publication.**

We have direct evidence that aggressive filtering produces a "signal vacuum" —
the YouTube backend sees continuation token requests with no corresponding
impression or click events, and responds by throttling features (confirmed:
infinite scroll removal on developer account).

**Finding from Gemini Pro consultation (2026-04-23 — see docs/CONSULTATIONS.md):**
The consultation confirmed that YouTube's anomaly detection is driven by dynamic
ML models rather than hardcoded thresholds. The safe filtering range is therefore
not a fixed number — it is account-contextual and session-contextual, and best
understood through observation rather than specification.

We already have one confirmed data point: aggressive filtering produced infinite
scroll removal on the developer account. That is the ceiling being enforced in
practice. What we do not yet know: where the boundary sits under normal
conditions, what triggers it precisely, and what conditions cause throttled
features to be reinstated. Both the upper and lower bounds are open questions.

The lifecycle integrity fix (collapse instead of DOM removal) is the necessary
precondition for any meaningful measurement — until telemetry is flowing
correctly, any throttling we observe is confounded by broken signals. Once the
collapse is in place, we can observe with a clean instrument.

The root cause of the current confirmed throttling is a lifecycle integrity
failure, not volume alone.

YouTube's video card lifecycle:
1. Shell allocated in DOM — skeleton element, no content
2. IntersectionObserver attached to the shell (with rootMargin — fires before
   the element enters the visible viewport)
3. Shell enters observer threshold → hydration triggered: thumbnail fetched,
   title parsed, inner DOM built
4. Hydrated element enters actual viewport → telemetry beacon dispatched
5. Engagement events (click, hover) propagate if the user interacts

Current `nuke()` fires after step 3 (hydration gate confirms thumbnail present),
then calls `display: none`. This removes the container from layout. An element
with no layout dimensions cannot intersect an IntersectionObserver — step 4
never fires. The backend dispatched 20 cards, expects 20 impression beacons,
receives zero, and sees the next continuation request arrive immediately.
This is the exact fingerprint of a headless scraper.

The scroll velocity dimension is a compounding factor: a heavily filtered page
empties quickly, triggering continuation requests faster than human reading
speed — even if impression volume were otherwise normal.

Required steps, in order:

1. **Lifecycle-respecting collapse** — replace `display: none` in `nuke()` with
   a visual collapse that maintains a nominal layout footprint: the container
   stays in the document, IntersectionObserver fires, telemetry dispatches, the
   user sees nothing meaningful. `display: none` is explicitly prohibited as a
   filter mechanism. Implementation detail in v4.0 amendment below.

2. **Scroll velocity review** — assess whether heavily filtered sessions reach
   continuation trigger speeds outside human range; if so, determine whether
   the collapse approach resolves this naturally (collapsed elements still
   occupy scroll space) or whether additional throttling is needed.

3. **Publication path** — icons (16×16, 48×48, 128×128), privacy disclosure
   (all data local, nothing transmitted), Chrome Web Store submission. Firefox
   support follows once Chrome build is stable.

### v3.6.11 — Targeted insertion observer (performance)
- Replace processPage() full h3 scan on every mutation
- Keep narrowed observer on ytd-two-column-browse-results-renderer
- Change observer callback to iterate addedNodes that are video containers
- Schedule only newly added containers for processing via RAF
- CPU cost scales with newly added cards, not total feed size

### v3.6.12 — Hydration gate tuning
- Analyse hydration delta logs from real usage
- Implement adaptive retry: if container stays pending >2 seconds,
  force-evaluate with whatever title exists (prevents permanent hang)
- Consider 50ms debounce when multiple containers added in rapid succession

### v4.0 amendment — Lifecycle-respecting collapse (publication blocker)

The `nuke()` function currently calls:
```js
container.style.setProperty("display", "none", "important");
```
This must be replaced before publication. `display: none` removes the element
from layout — it has no dimensions, so the browser cannot intersect it against
an IntersectionObserver threshold. YouTube's hydration trigger and telemetry
beacon both depend on this intersection. Setting `display: none` before the
element scrolls into view produces a telemetry black hole for every filtered
card in that batch.

Required replacement: visually collapse the container while keeping it in the
document and in layout flow. The collapsed element must retain enough height for
IntersectionObserver to fire as the user scrolls past it.

Candidate approaches (to be validated against YouTube's observer rootMargin):
- `visibility: hidden` — element invisible, layout fully preserved; IO fires normally
- `height: 1px; overflow: hidden; min-height: 0` — collapses visual space, IO fires
- Stripping inner HTML and collapsing height — leaves shell in flow, IO fires

`display: none` and `opacity: 0` with `pointer-events: none` are not equivalent
substitutes: `display: none` removes from layout entirely; `opacity: 0` alone
preserves layout but leaves the element interactive. The correct approach
depends on what YouTube's observer rootMargin is set to — a 1px footprint may
be sufficient, or the element may need to match the original card height to
guarantee intersection before the user has scrolled past.

The collapsed element should have `pointer-events: none` applied regardless of
the height strategy, so it does not intercept user scroll or click events.

Scroll velocity note: collapsed elements still occupy vertical space in the feed.
This naturally slows the rate at which a user reaches the continuation trigger
on a heavily filtered page — the problem may resolve without explicit throttling.
Observe in practice before adding artificial delays.

### v4.0 — Extension stabilisation (in progress)
- Chrome extension prototype running: manifest, content script, storage layer ported
- Remove dev tools (DOM capture 📸, diagnostic export ✱) from published build,
  or gate behind a developer flag
- Version displayed in HUD from manifest — no hardcoded strings
- Post-commit hook syncs extension/ to Windows filesystem automatically
- Firefox support: web-ext build after Chrome is stable

### v4.1 — Semantic heuristic pipeline [PAUSED]

**Depends on:** all of the following must be complete before implementation begins:
1. Hardening phase complete
2. Pre-publication gate cleared — lifecycle-respecting collapse in place
3. Autoplay target tracking implemented and producing data
4. Re-appearance rate tracking implemented and producing data

The third and fourth items are not bureaucratic gates. Thematic intelligence
without feedback is just tighter filtering by a different name. The passive
signal expansion gives v4.1 something to calibrate against — cluster density
throttling informed by how the algorithm is actually responding is a
categorically different thing from cluster density throttling in the dark.
This is why v4.1 was always the right direction and also why it was right
to pause it: it needs to see the board before it can play.

- Density throttling: limit videos per semantic cluster per batch
  (generalisation of channel dedup, uses existing tokeniser, no LLM needed)
- LLM cluster identification (optional external service): generates local
  heuristics from novel batches, never blocks filtering
- ClusterMap with half-life decay: persistent signatures expire over time
  score_new = score_old × 0.5^(t / t_half)
- Requires filter ceiling (pre-publication gate) to be in place first;
  a smarter filter that runs without a ceiling still risks signal vacuum

### Soft-nuke — Passive event suppression (gated, not yet sequenced)

**Do not implement until the gates below are cleared. Separate from the
filter ceiling — this is a distinct ethical question requiring its own sign-off.**

- Ceiling-overflow elements ("soft-nuked"): scored as slop but spared by ceiling
- Suppresses passive mouse event propagation on ceiling-overflow elements:
  mouseover, mouseenter, mouseleave, mouseout, mousemove swallowed via a single
  capture-phase listener registered on document at document-start
- Deliberate interaction events (click, pointerdown, pointerup) explicitly
  preserved — only intentional engagement propagates to the recommendation pipeline
- No DOM footprint: soft-nuked state tracked in WeakSet, no data attributes written
- No fake impressions — all impressions are honest

Required gates:
1. Gemini Pro sign-off on the specific event suppression architecture —
   retain full session transcript as due diligence artifact
2. Dedicated test branch — never merged to main until validated
3. Throwaway account test environment — clean profile, no fingerprint overlap
   with main account; test protocol designed before any code is written

---

## Vision / Pivot

These are not numbered releases. They represent a different class of work —
architectural directions that require their own design phase before any
implementation begins.

### Self-healing blind spot — internal card selectors

The v3.9 self-healing architecture covers container tag renames. It does not
cover selectors that reach *inside* the card for filter-specific data.

**Confirmed failure (2026-04-25):** YouTube migrated homepage cards from the
legacy element structure to `yt-lockup-view-model`. The channel name moved out
of `ytd-channel-name` into `yt-content-metadata-view-model a[href^="/@"]`.
DUPE went silent across all builds (Firefox 3.7–3.9, Chrome extension) with
no CRIT, no anchor search, no evidence trail — just silence.

**The repair is fragile.** The new selector `yt-content-metadata-view-model
a[href^="/@"]` is correct today. It will break again the next time YouTube
refactors the lockup structure. The fix was found by DOM capture analysis,
not by the system itself.

**What makes container healing possible but internal healing hard:**
Container renames leave beacons — nuked titles stay in the DOM and can be
searched. Internal selector failures produce no evidence. A broken channel
name selector looks identical to "no duplicates in this batch."

**What robust internal healing would require:**
- A known-good reference point inside the card (e.g. a watched video whose
  title is confirmed in the nuke log) to walk down from and discover the
  current progress bar path
- For channel names: a channel the user has visited recently whose name is
  known, used as a beacon to find the element that contains it
- Both require building a separate beacon corpus for internal selectors,
  distinct from the container-level nuke log

This is tractable but not trivial. Until it is built, internal selector
failures must be caught by the diagnostic infrastructure (HUD WARN on
getChannelName failure, ytDiag.audit() for manual inspection) and repaired
by DOM capture analysis as above. The LLM-assisted last-resort path below
is the long-term answer.

**Beacon recovery mechanism (formalized 2026-04-26):**

The concrete recovery path for silent internal selector failures is
content-addressed DOM discovery via a reference video.

Trigger condition: a monitored internal metric (WATCHED, DUPE) produces zero
output over a sufficient run of cards — silence indistinguishable from
"no matched content in this session."

Recovery path:
1. HUD surfaces a metric-dark warning (N cards processed, zero WATCHED or
   DUPE hits — anomalous given account history)
2. Developer searches YouTube for the reference video: owned channel, unique
   title, confirmed watched, public, boring, 3+ minutes
3. Search returns exactly one result card — a DOM subtree with known content
4. Walk that card to discover the current selector path for the affected
   metric: progress bar element for WATCHED, channel name element for DUPE
5. Commit the discovered selector as a correction; the observer self-heals
   without reload

Why this works: the reference video is an anchor with known content at a
known depth in the card. Because we know what should be there — specific
title, channel name, watched progress — we can locate those elements
regardless of what YouTube's engineers called them or where they moved them.
The selector name is irrelevant; the content is the handle.

The title selector self-heals today because titles are legible text — the
system can anchor semantically. WATCHED and DUPE are pure CSS structure with
no semantic handle. The reference video gives them the same anchor that text
gives the title selector. Same principle, different mechanism.

Build tier: master build only. The automated search navigation fires impressions
and shapes recommendation history without user intent — it is gated by design,
not disabled. It may run fully automatically in the master build. It must not
appear in the public build under any condition.

### LLM-assisted last-resort self-healing
- Triggered when in-page self-healing (v3.9) fails completely: CRIT persists
  after anchor search exhausts its candidates
- Extension saves DOM snapshot to a local temp file via native messaging host
- Native messaging host launches `claude` with the dump and a preflight prompt
  specifying the selector map format — output is always machine-readable JSON,
  never prose
- Claude updates `selectors.json` in the local repo and commits; push requires
  explicit auth (bot token in host config, or manual user push as approver)
- Extension polls `raw.githubusercontent.com` for the selector file on a slow
  interval while HUD shows "Self-healing engaged — awaiting updated definitions"
- On changed ETag or version field, extension applies new selectors and reports
  recovery; times out to a plain CRIT after a defined window if no update arrives
- Selector map format must be specced (like DIAGNOSTIC.md) before implementation
- Requires extension build and a native messaging host
- This is genuinely fun engineering and will happen — just not on a fixed schedule

### Clown Mode 🤡
- Hot pink HUD with polka dots, Comic Sans, every nuke a performance
- Nuke animations: violent shake, rotation, confetti canvas, BOING via Web Audio
- Reverse Polarity toggle: hide everything EXCEPT clickbait — a museum of cringe
- Laugh track per nuke (sine wave sweep, no external audio files)
- Circus tent HUD: striped border, emoji log levels, "SENT TO THE CIRCUS" counter
- Random chaos injection every 10 seconds while active
- "MAXIMUM CHAOS" toggle: all heuristic thresholds lowered to absurd levels
- Self-heal fanfare: three ascending beeps, confetti, "THE CIRCUS FIXED YOUTUBE AGAIN 🤡🎉"
- Ships when the serious work is done. Should probably include a safety valve that automatically turns it off after a hot minute.

---

## Deprecated / Removed

| Item | Reason |
|---|---|
| IntersectionObserver (was v3.6.8) | Not testable on account with pagination; not needed after targeted insertion observer |
| v3.6.4–v3.6.9 as individual roadmap items | All completed and absorbed into v3.6.9 release notes above |
| v3.6.10 — Diagnostic cleanup | Never shipped as a distinct version; improvements absorbed into v3.8 and v3.9 |
| v3.7 — Stable release candidate | Superseded by jumping directly to v3.8; its goals (log cleanup, stable label) are met by v3.9 |
| v3.7 as "Accordion nuke geometry" | Account-level scroll throttling confirmed — out of scope until fresh account |
| Legacy fallback removal | Retained but logs [CRIT] — acceptable resilience, not deprecated |
| Userscript auto-loader | Non-trivial and poorly understood. YouTube's CSP, Firefox's content script scheduling, and the document-start timing requirement make dynamic script loading via GM_xmlhttpRequest or fetch() unreliable. localStorage bridge pattern explored but unresolved. Deferred until extension migration makes it irrelevant. |

