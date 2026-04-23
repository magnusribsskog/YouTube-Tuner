# External Consultations

This document records formal consultations with Gemini Pro on questions where
architectural or ethical decisions require expert input. Each entry captures
the exact query sent, the full response received, and the conclusions drawn.

Numbered consultations are Gemini Pro only. The thinking model is not Pro and
does not carry the same weight — responses from it are not recorded here.

Entries are append-only. Do not edit past entries.

---

## Consultation 1 — YouTube engagement signal architecture

**Date:** pending — awaiting Gemini Pro availability
**Model consulted:** Gemini Pro
**Subject:** How YouTube's feed pipeline detects and responds to third-party
filtering; what safe filtering behaviour looks like from the backend's perspective;
what ceiling percentage keeps engagement signals within a human-plausible range
**Status:** Query ready to send

### Query to send

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

_Pending._

### Conclusions for the project

_Pending._

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
