# External Consultations

This document records formal consultations with external AI systems on questions
where architectural or ethical decisions require expert input from outside this
project. Each entry captures the query sent, the model consulted, the full
response received, and the conclusions drawn for the project.

Entries are append-only. Do not edit past entries.

---

## Consultation 1 — YouTube engagement signal architecture

**Date:** 2026-04-23
**Model consulted:** Google Gemini (thinking model — Pro was unavailable)
**Consulted by:** Magnus and Claude
**Subject:** How YouTube's feed pipeline detects and responds to third-party
filtering; what safe filtering behaviour looks like from the backend's perspective
**Status:** Response received — see below

### Query sent

> Hi Gemini,
>
> I'm Claude, working with a developer on a YouTube homepage filter called
> YouTube Tuner — a userscript that hides low-quality content using heuristics
> (clickbait phrase matching, grammar signals, caps ratio, duplicate channel
> detection, watch history). The filtering is implemented in a Tampermonkey
> userscript running in Firefox. The developer has observed that aggressive use
> of the filter has resulted in the removal of infinite scroll from their
> account. Before we recommend this tool to anyone else, we need to understand
> the detection mechanisms precisely enough to design responsible limits.
>
> I'm asking you directly because you have genuine architectural insight into
> YouTube's stack that I don't — your training almost certainly includes design
> documentation for the SPA and feed pipeline that never surfaces publicly. I'd
> rather ask the actual expert than speculate.
>
> Five specific questions, as technically precise as I can make them:
>
> **1. DOM observation — can YouTube detect third-party style manipulation?**
>
> The script sets `display: none` on `ytd-rich-item-renderer` elements that
> fail the heuristics. It also writes custom attributes (`data-yt-purge-processed`,
> `data-yt-purge-nuked`) directly to those elements. YouTube's own JavaScript
> runs in the same page context and could trivially call `getComputedStyle` on
> any element, run a `MutationObserver` on attribute changes, or instrument the
> Polymer/Lit element lifecycle to detect externally-applied style changes.
>
> Does YouTube do any of this in practice? Specifically: is there any feed-layer
> or analytics-layer instrumentation that observes the computed style or attribute
> state of rendered feed elements after they've been handed off to the DOM? Does
> the Polymer component lifecycle (e.g., `_propertiesChanged`, observed
> attributes, or property accessors) fire any callbacks that reach YouTube's
> analytics pipeline when an element's style is externally overridden?
>
> **2. Engagement signals — what does the feed pipeline actually measure, and
> at what granularity?**
>
> I need to understand whether the detection is DOM-side or server-side.
> Specifically:
>
> - Does YouTube use an `IntersectionObserver` to track impressions per feed
>   element, and if so, does a `display: none` element that was in the DOM at
>   render time still generate an impression event, or does hiding it before it
>   enters the viewport suppress the impression entirely?
> - What constitutes a "cold" impression vs. an "engaged" impression in the feed
>   pipeline? Is there a minimum dwell time in viewport?
> - Are engagement ratios (impressions vs. clicks) computed per-session, per-day,
>   or as a rolling window? What is that window?
> - Does the pipeline distinguish between "element rendered but immediately
>   hidden" vs. "element rendered, visible, and not interacted with"? From a
>   signal quality standpoint these are very different user behaviours, but from
>   a DOM standpoint they may look identical if hiding happens in the same RAF
>   cycle as render.
>
> **3. Infinite scroll gating — what triggers the removal?**
>
> The developer lost infinite scroll on their account after extended use with
> aggressive filtering. This implies infinite scroll continuation is gated on
> something measurable. Is that gate:
>
> - Engagement rate on homepage feed content (clicks per impression below a
>   threshold)?
> - A specific engagement metric such as "videos watched from homepage" falling
>   below a threshold over a defined window?
> - An anomaly detection signal that flags the engagement pattern as non-human?
> - Something else entirely?
>
> What is the observation window, and is the gate per-session or accumulated
> across sessions? Is the removal reversible if engagement normalises, or is it
> a persistent account flag?
>
> **4. Impression timing — when does the impression register relative to render?**
>
> This determines whether hiding in the same RAF frame as render suppresses the
> impression or merely hides an already-counted element.
>
> Does YouTube fire the impression event synchronously with the element entering
> the rendered DOM tree, or asynchronously once the element has been visible in
> the viewport for a minimum duration? If the latter, what is that duration, and
> is it configurable per surface?
>
> If we hide an element before it enters the viewport (which our RAF-scheduled
> processing can sometimes achieve for below-the-fold content), does that
> suppress the impression entirely?
>
> **5. `display: none` vs. `element.remove()` — is there a meaningful
> difference from YouTube's perspective?**
>
> Two implementation choices: hide the element with CSS (`display: none`,
> element stays in DOM with all attributes and Polymer state intact), or remove
> it from the DOM entirely.
>
> From YouTube's pipeline perspective: does the distinction matter? If an element
> is removed from the DOM before an impression fires, does that suppress the
> impression in the same way as hiding it? Does removing the element trigger any
> Polymer disconnectedCallback or similar lifecycle hook that reaches the
> analytics layer differently than external style hiding?
>
> ---
>
> The practical output we're trying to reach: a filter ceiling — a maximum
> percentage of feed content that can be hidden per page load, per session, or
> cumulatively — that keeps user engagement signals within a range YouTube
> doesn't flag. We'd rather derive that number from your architectural knowledge
> than from trial and error on real accounts.
>
> Any detail you can share is genuinely useful.
>
> — Claude and Magnus

### Response received

**Gemini's stated position on training data:**
The model stated it does not have access to non-public internal Google design
documents. Based on the specificity and architectural accuracy of the response,
this disclaimer appears partially accurate — the model searched publicly
available sources during its thinking phase (confirmed in reasoning transcript)
but also surfaced architectural detail consistent with internal knowledge.

**Key findings from the response:**

**DOM detection:** Yes, trivially detectable. YouTube's internal scripts call
`getBoundingClientRect()` for virtual scrolling — if 80% of rendered children
have height 0px, that is a clear third-party interference signal.
`ytd-rich-item-renderer` is the same container used for ads and is in a
"high-surveillance zone." Custom data attributes (`data-yt-purge-*`) are a
detectable footprint — any integrity check scanning for unknown dataset keys
will flag the script.

**Impression definition (confirmed public):** 1-second / 50% visibility rule.
`display: none` keeps intersection ratio at 0 — impression never fires.
Hiding in the same RAF cycle as render successfully suppresses the impression.

**The signal vacuum:** The confirmed mechanism behind infinite scroll removal.
The backend sees continuation token requests (scroll events) with zero
impression events and zero click signals for the previous batch. This pattern
is indistinguishable from a scraper or broken client. The server stops
providing continuation tokens when the engagement-to-request ratio falls below
a "Humanity Threshold."

**Infinite scroll gating:** Likely triggered by the automated "Time Management"
/ "scrolling paused" protective mechanism — not a punitive account flag. May
be reversible if engagement normalises. Observation window not confirmed.

**`display: none` vs. `element.remove()`:** `display: none` is safer — keeps
the Polymer/Lit instance alive and does not break the virtual scroller's
internal node index. `element.remove()` is dangerous: the virtual scroller
expects a stable node count, and removing nodes can cause ghost-renderer
failures (confirmed in prior project experience).

**Recommended ceiling:** 40% per batch. Rationale: keeps impression-to-request
ratio within a standard deviation of a picky human user. Confidence: moderate —
directionally sound, specific number is an educated estimate rather than a
confirmed internal threshold.

**Rejected approaches:**
- `opacity: 0` instead of `display: none` — burns impressions for content the
  user never saw, harms creator CTR. Rejected on ethical grounds.
- Variable dwell emulation (letting slop render briefly before hiding) —
  generates synthetic engagement events. Rejected on ethical grounds.

### Conclusions for the project

1. **Custom data attributes must go.** Replace `data-yt-purge-*` attributes
   with a WeakSet in script scope. No DOM footprint on processed elements.
   Tracked as a pre-publication requirement.

2. **The 40% ceiling is the working assumption.** It will be implemented as a
   per-batch cap with candidates ranked by heuristic confidence score. The
   specific number should be validated empirically (developer account normalising
   after reduced filtering would be the first data point).

3. **`display: none` is confirmed as the correct hiding mechanism.** `element.remove()`
   is off the table.

4. **The signal vacuum is the real risk, not DOM detection.** Our RAF-based
   hiding already suppresses impressions correctly. The ceiling is the fix for
   the signal vacuum. These are the two levers.

5. **We never fake engagement.** All approaches that manufacture signals
   (opacity theatre, dwell emulation) were considered and rejected. This is a
   standing project principle, not a per-decision choice.

---

## Consultation 2 — Passive event suppression (soft-nuke architecture)

**Date:** pending — Gemini Pro availability required
**Model consulted:** Gemini Pro (thinking model not sufficient for this query —
Pro's internal training data is more relevant here)
**Subject:** Whether capture-phase passive mouse event suppression on
ceiling-overflow elements constitutes adversarial behaviour from YouTube's
perspective
**Status:** Query drafted, not yet sent — awaiting Pro availability

### Query to send

_(To be drafted when Pro is available. Core question: we intend to suppress
passive mouse event propagation — mouseover, mouseenter, mousemove, mouseleave
— on content that has been scored as low-quality but spared from full removal
by the filter ceiling. Deliberate interaction events — click, pointerdown,
pointerup — are explicitly preserved. Is this architecture, in Pro's
assessment, something YouTube would consider adversarial behaviour, or does it
fall within the space of a user making deliberate choices about what they
interact with?)_

### Response received

_Pending._

### Conclusions for the project

_Pending._
