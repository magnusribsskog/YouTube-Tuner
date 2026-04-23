# External Consultations

This document records formal consultations with Gemini Pro on questions where
architectural or ethical decisions require expert input. Each entry captures
the exact query sent, the full response received, and the conclusions drawn.

Numbered consultations are Gemini Pro only. The thinking model is not Pro and
does not carry the same weight — responses from it are not recorded here.

Entries are append-only. Do not edit past entries.

---

## Consultation 1 — YouTube engagement signal architecture

**Date:** 2026-04-23
**Model consulted:** Gemini Pro
**Subject:** How YouTube's feed pipeline detects and responds to third-party
filtering; what safe filtering behaviour looks like from the backend's perspective
**Status:** Response received — see below

### Query sent

> Hi Gemini,
>
> I'm working on a YouTube content filter with a developer — a Chrome extension
> that hides videos matching certain heuristics (clickbait patterns, grammar
> signals, excessive caps). We've been building it carefully and responsibly,
> and we've hit something we want to understand better before we recommend it
> to other users.
>
> The developer's account lost infinite scroll after a period of aggressive
> filtering. Our best guess is that YouTube's backend saw a pattern that looked
> like a scraper — lots of scroll events requesting new content, but no
> impression or click signals coming back from the previous batch, because we
> were hiding content before it registered as seen. We'd like to understand
> that mechanism well enough to set a responsible ceiling on how much we filter
> per batch.
>
> Specifically we're curious about: how does YouTube's impression system work —
> is it IntersectionObserver based, and does hiding an element before it enters
> the viewport suppress the impression entirely? And is there a rough sense of
> what engagement-to-scroll ratio looks like for a real human who's just picky,
> versus one that looks like something automated?
>
> We're not trying to game the system — we're trying to calibrate so we don't
> accidentally look like we are.
>
> — Magnus and Claude

### Response received

**Impression tracking mechanics:**
IntersectionObserver confirmed as the industry standard for impression tracking
in SPAs. An impression is logged and dispatched only when a specific percentage
of the element enters the viewport for a minimum duration. Hiding with
`display: none` before the element crosses the intersection threshold suppresses
the impression entirely — the observer does not fire and no telemetry ping is
sent to the server.

**The infinite scroll anomaly — two distinct mechanisms:**

1. *API request velocity:* Hiding a large percentage of a batch shrinks the
   visible page height. The scroll position hits the trigger threshold almost
   immediately, causing rapid sequential pagination requests — a tight cluster
   of API calls that no human generates.

2. *Telemetry mismatch:* The backend receives high data request volume but
   near-zero corresponding engagement telemetry (impressions, hovers, clicks).
   To automated defense heuristics this is indistinguishable from a scraper
   harvesting data. The standard response is rate-limiting, throttling, or
   temporarily disabling pagination for that session.

**Human vs. automated engagement ratios:**
Specific numerical thresholds cannot be provided — anti-abuse systems are
proprietary and use dynamic ML models rather than static rules. The systems
evaluate behavioural signals beyond simple click/scroll ratios:

- *Pacing and dwell time:* Human users take several seconds to visually
  evaluate a batch before scrolling. An automated filter evaluates and hides
  in milliseconds.
- *Micro-interactions:* Non-linear mouse movements, varying scroll velocities,
  brief pauses over elements that trigger preview playbacks.
- *Request rhythms:* Human pagination has variable, drawn-out timing. Extension
  filtering produces tight, immediate request clusters.

**Suggested mitigation (Pro's recommendation):**
Implement an artificial delay or throttling mechanism on the client side to
restrict pagination request velocity — ensuring the time between network calls
mimics human scrolling limitations regardless of how much content is hidden.

### Conclusions for the project

1. **Two problems, not one.** The filter ceiling (limiting hidden content per
   batch) addresses the telemetry mismatch. It does not address the API velocity
   problem. Both require solutions. These are complementary, not alternatives.

2. **Pagination throttle is the primary recommended fix.** Pro's explicit
   suggestion: artificially delay client-side pagination requests to match
   human scroll rhythms. This is a different lever than the content ceiling
   and may be more effective at resolving the infinite scroll removal.

3. **IntersectionObserver confirmed.** Our RAF-based hiding suppresses
   impressions correctly — elements hidden before entering the viewport do not
   generate telemetry. This is the right implementation.

4. **No specific threshold available.** The 40% ceiling figure from the thinking
   model exchange is not confirmed by Pro. Specific ratios are proprietary ML.
   The ceiling is still worth implementing as a reasonable precaution, but it
   should not be treated as a known-safe number.

5. **Micro-interactions are a detection vector.** Brief pauses and non-linear
   cursor movement over elements are part of the behavioural fingerprint.
   This is relevant context for the soft-nuke consultation (Consultation 2)
   — suppressing passive mouse events on ceiling-overflow content may affect
   this signal and warrants its own query.

---

## Consultation 2 — Passive event suppression (soft-nuke architecture)

**Date:** pending — after Consultation 1 is complete
**Model consulted:** Gemini Pro
**Subject:** Whether capture-phase passive mouse event suppression on
ceiling-overflow elements constitutes adversarial behaviour from YouTube's
perspective
**Status:** Query to be drafted after Consultation 1 conclusions are in hand

### Query to send

_To be drafted. Core question: we intend to suppress passive mouse event
propagation — mouseover, mouseenter, mousemove, mouseleave — on content that
has been scored as low-quality but spared from full removal by the filter
ceiling. Deliberate interaction events — click, pointerdown, pointerup — are
explicitly preserved. Is this architecture, in Pro's assessment, something
YouTube would consider adversarial behaviour, or does it fall within the space
of a user making deliberate choices about what they interact with?_

### Response received

_Pending._

### Conclusions for the project

_Pending._

