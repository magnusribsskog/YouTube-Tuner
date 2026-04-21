YouTube Tuner

Reduce visual clutter on YouTube’s homepage and search results — without blocking channels or watch pages.

YouTube Tuner is a browser userscript that automatically hides video cards you’d likely skip anyway: clickbait phrases, grammar slop, excessive caps, already-watched videos (over 90%), and duplicate channels in a single scroll batch.

It works only on the homepage and search results. Channel pages and watch pages are untouched — your intent to watch or explore a creator is never interrupted.
Why this exists

YouTube’s algorithm is good at surfacing relevant content, but not always good at filtering out annoying content. You’ve probably seen:

    "DONT CLICK THIS 🔥🔥🔥"

    "I UNALIVED MY PC (GONE WRONG)"

    The same channel filling your feed with 6 nearly identical videos

    Videos you already watched 95% of, still being recommended

YouTube Tuner quietly removes those cards from view. Nothing is deleted or reported — the card simply becomes invisible to you. You can still find the video by searching for it directly.
What it filters (and why)
Filter	What it catches	Example
Phrase	Clickbait regex + your own custom phrases	"OMG", "GONE WRONG", "BREAKS REALITY"
Slop	Missing apostrophes, repeated punctuation	"dont do this!!", "WOW???"
Caps	>50% capital letters after removing non‑letters	"THIS IS INSANE" (short words like "OK" are ignored)
Watched	Videos you’ve watched >90% of (red progress bar)	Any video at 95% watched
Duplicate	Only 1 video per channel per scroll batch	Second, third video from same channel hidden

All filters are on by default but can be toggled off individually (session only) from the on‑screen panel.
How to install (non‑technical)

    Install a userscript manager extension in Firefox

        Tampermonkey 

        Violentmonkey 

    Create a new script.

    Copy the entire script content into the editor.

    Save (Ctrl+S / Cmd+S).

    Reload YouTube.
    (Chromium support is on the roadmap, but not implemented)

You’ll see a dark panel in the top‑right corner of YouTube with:

    A counter of how many videos have been hidden this session

    A log of why each video was hidden

    An ⚡ button to open the filter controls panel

How to use
The HUD (Heads‑Up Display)

    NUKED counter – total videos hidden since page load

    Log area – scrollable list of hidden videos, with reason codes

    📸 button – downloads a snapshot of the current page (for debugging)

    ▲/▼ button – collapses/expands the log

The filter panel (click ⚡)

    Toggle filters on/off (session only – resets on page reload)

    Add / remove custom phrases (persistent – saved in your browser)

        Example: add "sponsored" or "reaction" to hide any title containing that word

    Each filter shows how many videos it has caught

What happens to hidden videos

They are not deleted, only hidden via display: none. YouTube still loads them, but you don’t see them. Refreshing the page or scrolling loads new videos, and the filter runs again.
For developers / technical users
Architecture overview

YouTube Tuner uses a narrow MutationObserver attached to the active browse results renderer, not the entire document. Navigation lifecycle is driven by YouTube’s native yt-navigate-finish event, avoiding the ghost‑renderer and scroll‑storm issues of earlier versions.

Key files / components inside the script:
Component	Purpose
heuristics object	Filter toggles + counters (session only)
customPhrases array	Persisted in localStorage under yt-purge-phrases
nukeLog array	Last 5 nuked titles stored in yt-purge-nuke-log (anchor search)
HUD / Word Panel	Shadow DOM UI elements (draggable, collapsible)
attachNarrowObserver()	Primary mutation observer target: ytd-two-column-browse-results-renderer inside the active page
runHealthCheck()	Validates structural elements (ytd-rich-grid-renderer, etc.) — triggers DOM capture on failure
captureAndDownloadDOM()	Downloads documentElement.outerHTML for offline diagnosis
runAnchorSearch()	On structural failure, searches DOM for last 5 nuked titles to identify new container tags
Scope rules

    Active filtering: only when window.location.pathname is / (homepage) or starts with /results (search)

    Never filters: watch pages (/watch), channel pages (/@username, /c/, /channel/), or settings pages

Hydration gate

Containers are not processed until both:

    Title text length ≥ 3 characters

    A thumbnail image (img[src*='ytimg.com'] or yt-img-shadow) is present

This prevents false negatives from partially hydrated cards. Processed containers get a stamp:
dataset.ytPurgeProcessed = "${sessionId}:${title}"

If YouTube recycles the same DOM node for a new video, the stamp changes and the container is re‑evaluated.
Deduplication logic

getChannelName() attempts channel extraction in two phases:

    Standard selectors (ytd-channel-name #text, etc.) in the regular DOM

    Shadow root traversal (one level deep) — for container types that might shadow channel names

If no channel name is found, the DUPE filter does nothing (pass‑through, not a failure).
Heuristic details
Heuristic	Implementation
Slop	Regex: \b(dont|doesnt|...)\b|([.!?,]){2,}
Phrase	CONFIG.clickbait regex + customPhrases array (case‑insensitive)
Caps	letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.5 (title length > 10)
Watched	Parses #progress element’s style.width integer — nuke if > 90
Duplicate	Map of channelName → count per processPage() batch — nuke if count > 1
UI persistence

    Filter toggles: session only (reset on page load)

    Custom phrases: persisted via localStorage (yt-purge-phrases)

    Nuke log: last 5 titles stored in localStorage (yt-purge-nuke-log) for anchor search

Diagnostic features

    Console output prefixed with [DIAG] (always enabled in this stable release)

    HUD logs [INFO], [WARN], [CRIT] messages

    Health check runs on homepage boot — if structural elements are missing, a DOM capture is automatically downloaded and anchor search is attempted

    Manual 📸 button downloads a snapshot at any time

Build / packaging

The script is self‑contained (no external dependencies, @grant none). To modify:

    Edit the CONFIG object for thresholds or regex patterns.

    Add new heuristics inside the processPage() loop.

    Run through Tampermonkey’s built‑in editor — no build step.

Known limitations

    Shadow DOM content is not serialised in DOM captures (closed shadow roots). Captures are still useful for container hierarchy and class names.

    Channel name extraction may fail on future YouTube layout changes — the script logs [DIAG] getChannelName FAILED and falls back gracefully.

    Health check may fire false [CRIT] during slow page loads (skeleton screens) — deferred by 1.5 seconds on homepage.

License

Unlicense / public domain (implied by @author Anonymous and lack of explicit license). Use at your own risk.
Credits & version

Current version: 3.7 (stable)
Former name: YouTube Purge
Author: Anonymous

Based on field diagnostics from v3.6.x series. Retains full diagnostic logging, DOM capture framework, and anchor search for structural failure analysis.
