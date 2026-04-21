# YouTube Tuner

A minimalist UserScript to reclaim the YouTube homepage from clickbait heuristics and algorithmic flooding.

## The Gist
YouTube Tuner acts as a silent filter layer that refuses video suggestions based on textual red flags and severly punishes terrible grammar. (CAPS-lock abuse, clickbait grammar, and channel-flooding) before the videos are rendered in your browser. The filtering logic toggles are accessible through the HUD. The side panel is very powerful, so be careful. If you put too broad terms into the persistant hud, nothing will render. Single term filters are possible, and probably not a good idea.

* **Static Heuristics:** Automatically hides videos using regex-based phrase matching, "slop" grammar detection, and high-ratio uppercase titles.
* **Channel Deduplication:** Prevents a single channel from hijacking your feed by limiting appearances per scroll-batch.
* **Zero-Flicker HUD:** A low-profile, draggable Shadow DOM interface to monitor what’s being "nuked" in real-time.
* **Context-Aware:** High-performance filtering that stays active on the Homepage and Search results but stays out of your way on Watch and Channel pages.

---

YouTube Tuner v3.1 — stable
The Gist

YouTube Tuner is a minimalist defensive layer for your browser. It doesn't try to "fix" the YouTube UI; it simply nukes low-quality recommendations based on behavioral red flags before they reach your eyes.

If the algorithm tries to flood your feed with "SLOP" or "CAPS-LOCK" engagement bait, this script identifies the patterns and suppresses the entire video container in real-time.
Core Features

    Heuristic Nuke Engine:

        PHRASE: Targets high-intensity clickbait triggers (e.g., INSANE, GONE WRONG, SECRET).

        SLOP: Detects common "low-effort" linguistic markers and grammar patterns.

        CAPS: Ratio-based detection (shouting). If 50% or more of the title is uppercase, it's filtered.

    Persistent HUD: A draggable, minimizable, Shadow DOM interface that logs every suppressed video.

        v3.1 Improvement: The HUD host remains in the document at all times to prevent observer interruption. The "Collapse" (▲/▼) toggle shrinks the UI to a minimal title bar without killing the process.

    Non-Invasive Logic: Uses a MutationObserver to scan for new content as you scroll, applying display: none !important to ensure suppressed videos stay hidden even if YouTube tries to re-render them.

🛠️ Technical Breakdown

The script targets the top-level YTD renderers directly, ensuring that not just the title, but the entire thumbnail and metadata block are removed from the grid.
Suppression Thresholds
JavaScript

    capsThreshold: 0.5,      // 50% uppercase letters triggers a CAPS nuke
    minTitleLength: 10,      // Ignores ultra-short titles to prevent false positives
    logLimit: 200            // Keeps the HUD log pipe performant


    
