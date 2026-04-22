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

---

## Planned

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

### v4.0 — Extension migration (Manifest V3 / Firefox WebExtensions)
- Replace localStorage with browser.storage.local
- Scope content script to www.youtube.com with page type detection
- HUD as injectable UI (same design, extension-managed)
- Userscript maintained alongside extension — both supported
- Extension skeleton already exists locally (YouTube Clickbait Remover codebase)

### v4.1 — Semantic heuristic pipeline
- Density throttling: limit videos per semantic cluster per batch
  (generalisation of channel dedup, uses existing tokeniser, no LLM needed)
- LLM cluster identification (optional external service): generates local
  heuristics from novel batches, never blocks filtering
- ClusterMap with half-life decay: persistent signatures expire over time
  score_new = score_old × 0.5^(t / t_half)
- Requires extension migration (v4.0) first

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
