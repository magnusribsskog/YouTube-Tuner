// ==UserScript==
// @name         YouTube Tuner v3.8
// @version      3.8
// @description  Adds session diagnostic export (*) to HUD — filters homepage and search video cards via PHRASE, SLOP, CAPS, DUPE, WATCHED heuristics
// @author       Anonymous
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * YouTube Tuner v3.7 — Stable
 * =====================================================================
 *
 * Filters YouTube homepage and search video cards against five heuristics:
 *   PHRASE   — regex clickbait patterns + user-managed custom phrase list
 *   SLOP     — missing apostrophes, grammar errors, punctuation repetition
 *   CAPS     — excessive uppercase ratio (>50% after filtering non-letters)
 *   DUPE     — channel duplicate suppression (one per channel per batch)
 *   WATCHED  — videos watched >90% (read from resume playback progress bar)
 *
 * Scope: homepage (/) and search (/results) only. Channel pages and watch
 * pages are explicitly out of scope — the user is already expressing intent.
 *
 * Architecture:
 *   - MutationObserver narrowed to ytd-two-column-browse-results-renderer
 *   - yt-navigate-finish event drives SPA navigation lifecycle (v3.6.93)
 *   - Hydration gate: containers not processed until title + thumbnail present
 *   - sessionId stamps: invalidate stale stamps across SPA navigations
 *   - Recycled container re-evaluation via ytPurgeProcessed stamp
 *   - Shadow DOM HUD + Word Panel (draggable, collapsible)
 *
 * Diagnostics:
 *   - Health check on homepage boot with three gates (context, skeleton,
 *     video item presence). Reports [CRIT] if structural elements missing.
 *   - DOM capture framework: 📸 button + automatic capture on CRIT states
 *   - Anchor search: last 5 nuked titles as DOM beacons on structural failure
 *   - Console [DIAG] logging throughout; HUD levels [INFO]/[WARN]/[CRIT]
 *
 * Diagnostic console output ([DIAG] prefix) is retained in this stable
 * release. Runtime cost is negligible and field diagnostics are valuable.
 *
 * localStorage keys:
 *   "yt-purge-phrases"  — JSON array of user-managed custom phrase strings
 *   "yt-purge-nuke-log" — last 5 confirmed-nuked titles for anchor search
 *
 * Heuristic toggle state: session-only, not persisted.
 * Custom phrase list: persisted via localStorage.
 * Nuke counter: increments only on first nuke of a container (ytPurgeNuked
 * flag) — rehydration and re-nuke of the same container do not inflate count.
 */

(function() {
    "use strict";

    // Container tags that the h3 DOM walk legitimately reaches but which
    // host section headers and navigation entries rather than video cards.
    // These are skipped before any heuristic evaluates them.
    const NON_VIDEO_CONTAINERS = new Set([
        "YTD-GUIDE-SECTION-RENDERER",
        "YTD-GUIDE-ENTRY-RENDERER",
    ]);

    // ======================== CONFIG ========================
    const CONFIG = {
        grammarSlop:    /\b(dont|doesnt|shes|cant|ive|wont|im|didnt|couldnt|shouldnt|isnt|wasnt|arent)\b|([.!?,]){2,}/i,
        clickbait:      /OMG|BADASS|UNALIVE|INSANE|COPS|SECRET|GONE WRONG|RUINED MY LIFE|BREAKS REALITY/i,
        capsThreshold:  0.5,
        minTitleLength: 10,
        logLimit:       200,
        PHRASES_KEY:    "yt-purge-phrases",
        NUKE_LOG_KEY:   "yt-purge-nuke-log",  // last N nuked titles for anchor search
        NUKE_LOG_SIZE:  5,                     // number of nuked titles to retain
    };

    // ======================== STOPWORDS ========================
    const STOPWORDS = new Set([
        "a","an","the","and","or","but","if","in","on","at","to","for","of","with",
        "by","from","as","is","it","its","be","was","are","were","been","have","has",
        "had","do","does","did","will","would","could","should","may","might","shall",
        "that","this","these","those","i","you","he","she","we","they","me","him","her",
        "us","them","my","your","his","our","their","what","which","who","when","where",
        "how","why","all","more","so","up","out","no","not","just","about","than","then",
        "them","some","can","into","over","after","before","between","through","during",
        "also","only","very","too","much","many","most","other","such","even","back",
        "still","here","there","now","get","got","go","went","make","made","know","like",
        "see","come","take","time","good","new","first","last","long","great","little",
        "own","right","big","high","old","same","another","because","while","both","each",
        "few","being","its","am","let","say","said","want","use","think","well","way",
        "down","off","again","further","once","any","few","more","most","other","above",
        "below","between","same","different","put","set","run","look","keep","going",
        "video","channel","watch","watching","new","official","full","part","episode",
        "ft","feat","vs","review","trailer","reaction","highlights","vlog","clip","clips",
        "day","week","month","year","best","top","update","live","stream","short","series",
        "show","ep","season","feat","music","song","cover","remix","version","extended"
    ]);

    // ======================== TOKENISER ========================
    function tokenise(title) {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOPWORDS.has(w));
    }

    // ======================== PAGE CONTEXT ========================
    function getPageContext() {
        const path = window.location.pathname;
        if (path === "/" || path === "")  return "home";
        if (path.startsWith("/results")) return "search";
        if (path.startsWith("/watch"))   return "watch";
        if (
            path.startsWith("/@")       ||
            path.startsWith("/c/")      ||
            path.startsWith("/channel/")
        )                                return "channel";
        return "other";
    }

    function filteringActive() {
        const ctx = getPageContext();
        return ctx === "home" || ctx === "search";
    }

    // ======================== HEURISTIC STATE ========================
    // Session-only toggles — reset on every page load, intentionally
    const heuristics = {
        SLOP:    { enabled: true, count: 0, label: "Grammar slop" },
        CAPS:    { enabled: true, count: 0, label: "Excessive caps" },
        PHRASE:  { enabled: true, count: 0, label: "Phrase / custom list" },
        DUPE:    { enabled: true, count: 0, label: "Channel duplicate" },
        WATCHED: { enabled: true, count: 0, label: "Watched > 90%" },
    };

    // ======================== CUSTOM PHRASE LIST ========================
    function loadPhrases() {
        try {
            const raw = localStorage.getItem(CONFIG.PHRASES_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.map(p => String(p).toLowerCase().trim()).filter(Boolean);
        } catch (e) {
            console.warn("[YT-PURGE] Phrase list load failed:", e.message);
            return [];
        }
    }

    function savePhrases() {
        try {
            localStorage.setItem(CONFIG.PHRASES_KEY, JSON.stringify(customPhrases));
        } catch (e) {
            console.warn("[YT-PURGE] Phrase list save failed:", e.message);
        }
    }

    let customPhrases = loadPhrases();

    // ── Nuke log: persists last N nuked titles for anchor search ─────────
    // Used by the anchor search framework to find confirmed-rendered titles
    // in the DOM after a structural failure. Only titles that passed the
    // hydration gate are stored — unhydrated titles are never logged.
    function loadNukeLog() {
        try {
            const raw = localStorage.getItem(CONFIG.NUKE_LOG_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            // Handle legacy string format from v3.7 and earlier
            return parsed.map(e => typeof e === "string" ? { reason: "?", label: e } : e);
        } catch (e) { return []; }
    }

    function saveNukeLog(log) {
        try { localStorage.setItem(CONFIG.NUKE_LOG_KEY, JSON.stringify(log)); }
        catch (e) { console.warn("[YT-PURGE] Nuke log save failed:", e.message); }
    }

    function recordNuke(reason, label) {
        const log = loadNukeLog();
        const updated = [{ reason, label }, ...log.filter(e => e.label !== label)].slice(0, CONFIG.NUKE_LOG_SIZE);
        saveNukeLog(updated);
    }

    let nukeLog = loadNukeLog();

    function matchesCustomPhrase(title) {
        const lower = title.toLowerCase();
        return customPhrases.some(p => lower.includes(p));
    }

    // ======================== HUD ========================
    let hudHost       = null;
    let nukeCountSpan = null;
    let logPipeDiv    = null;
    let nukeCount     = 0;
    const systemEvents = []; // WARN and CRIT entries captured for diagnostic export

    function createHUD() {
        const host = document.createElement("div");
        host.id = "yt-purge-hud";
        host.style.cssText = `
            position: fixed !important;
            top: 50px !important;
            right: 20px !important;
            width: 360px !important;
            height: 500px !important;
            z-index: 2147483647 !important;
            isolation: isolate !important;
            pointer-events: auto !important;
            visibility: visible !important;
            opacity: 1 !important;
        `;
        const shadow = host.attachShadow({ mode: "closed" });

        const container = document.createElement("div");
        container.style.cssText = `
            width: 100%; height: 100%;
            background: #0f0f0f;
            border: 2px solid #3b3b3b;
            border-radius: 12px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 50px rgba(0,0,0,0.9);
            color: white;
            overflow: hidden;
        `;

        const header = document.createElement("div");
        header.style.cssText = `
            padding: 12px 15px;
            background: #1a1a1a;
            cursor: move;
            border-bottom: 2px solid #ff4757;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
            flex-shrink: 0;
        `;

        const titleArea = document.createElement("div");
        titleArea.style.cssText = "display: flex; flex-direction: column; gap: 2px;";

        const mainTitle = document.createElement("span");
        mainTitle.textContent = "☢️ YouTube Tuner v3.8";
        mainTitle.style.cssText = "font-size: 13px; font-weight: 800; color: #ff4757;";

        const metaRow = document.createElement("div");
        metaRow.style.cssText = "display: flex; gap: 10px; align-items: center;";

        const countRow = document.createElement("span");
        countRow.style.cssText = "font-size: 10px; color: #888;";
        countRow.textContent = "NUKED: ";
        nukeCountSpan = document.createElement("span");
        nukeCountSpan.textContent = "0";
        nukeCountSpan.style.color = "white";
        countRow.appendChild(nukeCountSpan);
        metaRow.appendChild(countRow);

        titleArea.appendChild(mainTitle);
        titleArea.appendChild(metaRow);

        const btnGroup = document.createElement("div");
        btnGroup.style.cssText = "display: flex; gap: 10px; align-items: center;";

        // Word panel toggle button
        const panelBtn = document.createElement("span");
        panelBtn.textContent = "⚡";
        panelBtn.title = "Toggle filter panel";
        panelBtn.style.cssText = "cursor: pointer; font-size: 15px; color: #ffa502;";
        panelBtn.addEventListener("click", toggleWordPanel);
        btnGroup.appendChild(panelBtn);

        // DOM capture button — manual snapshot trigger
        const captureBtn = document.createElement("span");
        captureBtn.textContent = "📸";
        captureBtn.title = "Capture DOM snapshot";
        captureBtn.style.cssText = "cursor: pointer; font-size: 15px;";
        captureBtn.addEventListener("click", () => captureAndDownloadDOM("manual"));
        btnGroup.appendChild(captureBtn);

        // Diagnostic export button
        const diagBtn = document.createElement("span");
        diagBtn.textContent = "✱";
        diagBtn.title = "Export session diagnostic";
        diagBtn.style.cssText = "cursor: pointer; font-size: 15px; color: #2ed573; font-weight: 700;";
        diagBtn.addEventListener("click", exportDiagnostic);
        btnGroup.appendChild(diagBtn);

        // Collapse button
        const collapseBtn = document.createElement("span");
        collapseBtn.textContent = "▲";
        collapseBtn.title = "Collapse log";
        collapseBtn.style.cssText = "cursor: pointer; font-size: 14px; color: #555; line-height: 1;";
        collapseBtn.addEventListener("click", () => {
            const collapsed = logPipeDiv.style.display === "none";
            logPipeDiv.style.display = collapsed ? "block" : "none";
            collapseBtn.textContent = collapsed ? "▲" : "▼";
            collapseBtn.title = collapsed ? "Collapse log" : "Expand log";
            host.style.height = collapsed ? "500px" : "42px";
        });
        btnGroup.appendChild(collapseBtn);

        header.appendChild(titleArea);
        header.appendChild(btnGroup);

        logPipeDiv = document.createElement("div");
        logPipeDiv.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 10px 12px;
            background: #050505;
            font-family: monospace;
            font-size: 11px;
            line-height: 1.5;
        `;

        container.appendChild(header);
        container.appendChild(logPipeDiv);
        shadow.appendChild(container);

        let isDragging = false, offsetX = 0, offsetY = 0;
        header.addEventListener("mousedown", (e) => {
            e.preventDefault();
            isDragging = true;
            offsetX = e.clientX - host.offsetLeft;
            offsetY = e.clientY - host.offsetTop;
        });
        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            host.style.left = (e.clientX - offsetX) + "px";
            host.style.top  = (e.clientY - offsetY) + "px";
            host.style.right = "auto";
        });
        document.addEventListener("mouseup", () => { isDragging = false; });

        return host;
    }

    function logToHUD(reason, title) {
        const isWarn = reason === "WARN";
        const isCrit = reason === "CRIT";
        const isInfo = reason === "INFO";
        if (isWarn || isCrit) systemEvents.push({ level: reason, message: title || "" });
        // WARN, CRIT, and INFO are system messages — do not increment nuke counter
        if (!isWarn && !isCrit && !isInfo) {
            nukeCount++;
            if (nukeCountSpan) nukeCountSpan.textContent = nukeCount;
        }
        if (!logPipeDiv) return;
        const entry = document.createElement("div");
        entry.style.cssText = "margin-bottom: 5px; border-bottom: 1px solid #111; padding-bottom: 4px; display: flex; gap: 6px; flex-wrap: wrap;";
        const tag = document.createElement("span");
        // CRIT: red, larger, bold — must be impossible to miss
        // WARN: amber — informational degradation
        // INFO: green — successful state transition confirmation
        // default: red — filtered video entry
        tag.style.cssText = isCrit
            ? "color: #ff0000; font-weight: 900; font-size: 13px;"
            : isInfo
            ? "color: #2ed573; font-weight: 700;"
            : `color: ${isWarn ? "#ffa502" : "#ff4757"}; font-weight: 700;`;
        tag.textContent = `[${reason}]`;
        const msg = document.createElement("span");
        msg.style.cssText = isCrit ? "color: #ff6b6b; font-weight: 700;" : "color: #ccc;";
        msg.textContent = title || "";
        entry.appendChild(tag);
        entry.appendChild(msg);
        logPipeDiv.prepend(entry);
        // CRIT entries are exempt from logLimit — they must never be
        // pushed off the bottom of the log by subsequent entries
        if (!isCrit) {
            while (logPipeDiv.children.length > CONFIG.logLimit) {
                logPipeDiv.removeChild(logPipeDiv.lastChild);
            }
        }
    }

    // ======================== WORD PANEL ========================
    let panelHost    = null;
    let panelContent = null; // the collapsible pane inside the panel

    function createWordPanel() {
        const host = document.createElement("div");
        host.id = "yt-purge-panel";
        host.style.cssText = `
            position: fixed !important;
            top: 50px !important;
            right: 400px !important;
            width: 300px !important;
            z-index: 2147483646 !important;
            isolation: isolate !important;
            pointer-events: auto !important;
            visibility: visible !important;
            opacity: 1 !important;
            display: none;
        `;

        const shadow = host.attachShadow({ mode: "closed" });

        const container = document.createElement("div");
        container.style.cssText = `
            width: 100%;
            background: #0f0f0f;
            border: 2px solid #3b3b3b;
            border-radius: 12px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 50px rgba(0,0,0,0.9);
            color: white;
            overflow: hidden;
        `;

        // Header
        const header = document.createElement("div");
        header.style.cssText = `
            padding: 12px 15px;
            background: #1a1a1a;
            cursor: move;
            border-bottom: 2px solid #ffa502;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
            flex-shrink: 0;
        `;

        const panelTitle = document.createElement("span");
        panelTitle.textContent = "⚡ Filter Controls";
        panelTitle.style.cssText = "font-size: 13px; font-weight: 800; color: #ffa502;";

        const collapseBtn = document.createElement("span");
        collapseBtn.textContent = "▲";
        collapseBtn.title = "Collapse panel";
        collapseBtn.style.cssText = "cursor: pointer; font-size: 14px; color: #555;";
        collapseBtn.addEventListener("click", () => {
            const collapsed = panelContent.style.display === "none";
            panelContent.style.display = collapsed ? "block" : "none";
            collapseBtn.textContent = collapsed ? "▲" : "▼";
        });

        header.appendChild(panelTitle);
        header.appendChild(collapseBtn);

        // Content pane
        panelContent = document.createElement("div");
        panelContent.style.cssText = "padding: 12px; display: flex; flex-direction: column; gap: 12px;";

        // ── Section: Heuristic toggles ──────────────────────────────────────
        const toggleSection = document.createElement("div");

        const toggleHeading = document.createElement("div");
        toggleHeading.textContent = "FILTERS  (session only)";
        toggleHeading.style.cssText = "font-size: 9px; color: #555; font-family: monospace; font-weight: 700; margin-bottom: 8px; letter-spacing: 1px;";
        toggleSection.appendChild(toggleHeading);

        // Render one row per heuristic
        Object.entries(heuristics).forEach(([key, h]) => {
            const row = document.createElement("div");
            row.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;";

            const left = document.createElement("div");
            left.style.cssText = "display: flex; flex-direction: column;";

            const label = document.createElement("span");
            label.style.cssText = "font-size: 11px; color: #ccc; font-family: monospace;";
            label.textContent = `[${key}] ${h.label}`;

            const countEl = document.createElement("span");
            countEl.style.cssText = "font-size: 9px; color: #555; font-family: monospace;";
            countEl.textContent = `caught: ${h.count}`;
            h.countEl = countEl; // store reference for live updates

            left.appendChild(label);
            left.appendChild(countEl);

            const toggle = document.createElement("span");
            toggle.style.cssText = `
                cursor: pointer; font-size: 10px; padding: 2px 8px;
                border-radius: 4px; font-family: monospace; font-weight: 700;
                border: 1px solid; white-space: nowrap;
            `;
            const setToggleStyle = () => {
                toggle.textContent = h.enabled ? "ON" : "OFF";
                toggle.style.color = h.enabled ? "#2ed573" : "#555";
                toggle.style.borderColor = h.enabled ? "#2ed573" : "#555";
            };
            setToggleStyle();
            toggle.addEventListener("click", () => {
                h.enabled = !h.enabled;
                setToggleStyle();
            });

            row.appendChild(left);
            row.appendChild(toggle);
            toggleSection.appendChild(row);
        });

        // ── Section: Custom phrase list ─────────────────────────────────────
        const phraseSection = document.createElement("div");
        phraseSection.style.cssText = "border-top: 1px solid #1a1a1a; padding-top: 12px;";

        const phraseHeading = document.createElement("div");
        phraseHeading.textContent = "CUSTOM PHRASES  (persistent)";
        phraseHeading.style.cssText = "font-size: 9px; color: #555; font-family: monospace; font-weight: 700; margin-bottom: 8px; letter-spacing: 1px;";
        phraseSection.appendChild(phraseHeading);

        // Input row
        const inputRow = document.createElement("div");
        inputRow.style.cssText = "display: flex; gap: 6px; margin-bottom: 8px;";

        const phraseInput = document.createElement("input");
        phraseInput.type = "text";
        phraseInput.placeholder = "add phrase...";
        phraseInput.style.cssText = `
            flex: 1; background: #111; border: 1px solid #333; border-radius: 4px;
            color: #ccc; font-family: monospace; font-size: 11px; padding: 4px 8px;
            outline: none;
        `;

        const addBtn = document.createElement("span");
        addBtn.textContent = "ADD";
        addBtn.style.cssText = `
            cursor: pointer; font-size: 10px; padding: 4px 8px; border-radius: 4px;
            border: 1px solid #ffa502; color: #ffa502; font-family: monospace;
            font-weight: 700; white-space: nowrap;
        `;

        function addPhrase() {
            const val = phraseInput.value.toLowerCase().trim();
            if (!val || customPhrases.includes(val)) return;
            customPhrases.push(val);
            savePhrases();
            phraseInput.value = "";
            renderPhraseList();
        }

        addBtn.addEventListener("click", addPhrase);
        phraseInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") addPhrase();
        });

        inputRow.appendChild(phraseInput);
        inputRow.appendChild(addBtn);
        phraseSection.appendChild(inputRow);

        // Phrase list
        const phraseList = document.createElement("div");
        phraseList.style.cssText = "display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto;";

        function renderPhraseList() {
            phraseList.replaceChildren();
            if (customPhrases.length === 0) {
                const empty = document.createElement("span");
                empty.style.cssText = "font-size: 10px; color: #444; font-family: monospace;";
                empty.textContent = "no custom phrases";
                phraseList.appendChild(empty);
                return;
            }
            customPhrases.forEach((phrase, idx) => {
                const item = document.createElement("div");
                item.style.cssText = "display: flex; justify-content: space-between; align-items: center;";

                const text = document.createElement("span");
                text.style.cssText = "font-size: 11px; color: #ccc; font-family: monospace;";
                text.textContent = phrase;

                const removeBtn = document.createElement("span");
                removeBtn.textContent = "✕";
                removeBtn.style.cssText = "cursor: pointer; font-size: 11px; color: #555;";
                removeBtn.addEventListener("click", () => {
                    customPhrases.splice(idx, 1);
                    savePhrases();
                    renderPhraseList();
                });

                item.appendChild(text);
                item.appendChild(removeBtn);
                phraseList.appendChild(item);
            });
        }

        renderPhraseList();
        phraseSection.appendChild(phraseList);

        panelContent.appendChild(toggleSection);
        panelContent.appendChild(phraseSection);
        container.appendChild(header);
        container.appendChild(panelContent);
        shadow.appendChild(container);

        // Drag
        let isDragging = false, offsetX = 0, offsetY = 0;
        header.addEventListener("mousedown", (e) => {
            e.preventDefault();
            isDragging = true;
            offsetX = e.clientX - host.offsetLeft;
            offsetY = e.clientY - host.offsetTop;
        });
        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            host.style.left  = (e.clientX - offsetX) + "px";
            host.style.top   = (e.clientY - offsetY) + "px";
            host.style.right = "auto";
        });
        document.addEventListener("mouseup", () => { isDragging = false; });

        return host;
    }

    function toggleWordPanel() {
        if (!panelHost) return;
        panelHost.style.display = panelHost.style.display === "none" ? "block" : "none";
    }

    // ======================== CONTAINER DETECTION ========================
    function findVideoContainerFromElement(element) {
        let node = element;
        const containerTags = new Set([
            "YTD-RICH-ITEM-RENDERER",
            "YTD-COMPACT-VIDEO-RENDERER",
            "YTD-VIDEO-RENDERER",
            "YTD-GRID-VIDEO-RENDERER",
            "YTD-REEL-ITEM-RENDERER",
            "YTD-SHELF-RENDERER",
            "YTD-HORIZONTAL-LIST-RENDERER",
            "YTD-ITEM-SECTION-RENDERER",
            "YTD-COMPACT-RADIO-RENDERER",
            "YTD-RADIO-RENDERER"
        ]);
        while (node && node !== document.body) {
            if (containerTags.has(node.tagName)) return node;
            node = node.parentElement;
        }
        return element.closest("[class*='video'], [class*='item']") || element.parentElement;
    }

    // ======================== CHANNEL NAME EXTRACTION ========================
    const CHANNEL_SELECTORS = [
        "ytd-channel-name #text",
        "#channel-name #text",
        "#channel-name",
        "ytd-channel-name",
        ".ytd-channel-name",
    ];

    function getChannelName(container) {
        // ── Phase 1: Standard DOM query ──────────────────────────────────────
        // Try each known selector against the container's regular DOM tree.
        // This works for container types where YouTube renders channel names
        // in accessible DOM nodes (ytd-compact-video-renderer etc).
        for (const sel of CHANNEL_SELECTORS) {
            const el = container.querySelector(sel);
            const name = el?.textContent?.trim();
            if (name) {
                console.log(`[DIAG] selector OK: "${sel}" → "${name}" in <${container.tagName.toLowerCase()}>`);
                return name.toLowerCase();
            }
        }

        // ── Phase 2: Shadow root traversal ───────────────────────────────────
        // Fallback path: walks every descendant with a shadowRoot and tries
        // CHANNEL_SELECTORS inside each shadow tree.
        //
        // Settled finding: ytd-rich-item-renderer has no shadow roots in its
        // descendant tree. This traversal completes without finding anything
        // on that container type. The code remains in place as a defensive
        // measure for container types where shadow DOM may be used — the cost
        // is a single querySelectorAll("*") and a shadowRoot check per node.
        //
        // We do NOT recursively descend into nested shadow roots; one level
        // is sufficient for all container types currently observed.
        const tag = container.tagName.toLowerCase();
        const descendants = container.querySelectorAll("*");
        const shadowRootsFound = [];

        for (const el of descendants) {
            if (!el.shadowRoot) continue;

            // Record that we found a shadow root on this element type
            shadowRootsFound.push(el.tagName.toLowerCase());
            console.log(`[DIAG] shadow root found on <${el.tagName.toLowerCase()}> inside <${tag}>`);

            // Try all known selectors inside this shadow root
            for (const sel of CHANNEL_SELECTORS) {
                const target = el.shadowRoot.querySelector(sel);
                const name = target?.textContent?.trim();
                if (name) {
                    console.log(`[DIAG] SHADOW selector OK: "${sel}" → "${name}" on <${el.tagName.toLowerCase()}> in <${tag}>`);
                    return name.toLowerCase();
                } else if (target) {
                    // Selector matched a node but it had no text — still useful
                    console.log(`[DIAG] SHADOW selector matched but empty: "${sel}" on <${el.tagName.toLowerCase()}>`);
                }
            }
        }

        // ── Phase 3: Null result reporting ───────────────────────────────────
        // No channel name found via either phase. For container types where
        // this is the expected outcome (ytd-rich-item-renderer) the null is
        // passed up and dedup correctly takes no action. We still emit a WARN
        // once per container tag type so structural changes in new container
        // types are surfaced rather than silently absorbed.
        if (!getChannelName._warned) getChannelName._warned = new Set();
        if (!getChannelName._warned.has(tag)) {
            getChannelName._warned.add(tag);
            const shadowSummary = shadowRootsFound.length > 0
                ? `shadow roots on: ${[...new Set(shadowRootsFound)].join(", ")}`
                : "no shadow roots found";
            console.log(`[DIAG] getChannelName FAILED on <${tag}> — ${shadowSummary}`);
            logToHUD("WARN", `channel selector failed on <${tag}>`);
        }
        return null;
    }

    // ======================== HYDRATION GATE ========================
    // A container is "live" when it has both a non-empty title AND a valid
    // thumbnail URL. YouTube hydrates card content progressively — the
    // container element appears in the DOM before its children are populated.
    // Processing a container before it is live produces false negatives:
    // the title is incomplete, regex patterns may not match, and the stamp
    // locks out the fully-rendered title from ever being evaluated.
    //
    // Thumbnail URL check: we look for either an <img> with a src containing
    // "ytimg.com" or a <yt-img-shadow> element, both of which are injected
    // at the same time as the title text. A present thumbnail is the most
    // reliable proxy for "this card is fully rendered."
    //
    // containerCreatedAt: timestamp map for hydration timing instrumentation.
    // Records when we first saw a container so we can log the delta to
    // title hydration. Used to tune gate sensitivity — not used for filtering.
    const containerCreatedAt = new WeakMap();

    function isContainerLive(container, title) {
        // Record first-seen timestamp for timing instrumentation
        if (!containerCreatedAt.has(container)) {
            containerCreatedAt.set(container, performance.now());
        }
        if (!title || title.length < 3) return false;
        // Check for thumbnail presence as hydration signal
        const hasThumbnail = (
            container.querySelector("img[src*='ytimg.com']") ||
            container.querySelector("yt-img-shadow") ||
            container.querySelector("ytd-thumbnail img")
        );
        return !!hasThumbnail;
    }

    function logHydrationDelta(container, title) {
        const createdAt = containerCreatedAt.get(container);
        if (createdAt) {
            const delta = Math.round(performance.now() - createdAt);
            console.log(`[DIAG] hydration delta: ${delta}ms for "${title}"`);
        }
    }

    // ======================== NUKE HELPER ========================
    // Two dataset flags serve distinct purposes:
    //   ytPurgeProcessed — stores the last evaluated title. Cleared when
    //     YouTube rehydrates a container with new content so it can be
    //     re-evaluated. Drives the recycled container re-evaluation logic.
    //   ytPurgeNuked — set permanently on first nuke of a container.
    //     The HUD nuke counter and per-heuristic counts increment only when
    //     this flag is absent. Subsequent rehydration and re-nuke of the
    //     same container are suppressed from the counter — YouTube attempting
    //     to resurface filtered content is a separate concern from the count
    //     of unique filtered titles.
    function nuke(container, reason, label) {
        const isFirstNuke = !container.dataset.ytPurgeNuked;
        container.dataset.ytPurgeNuked = "1";
        // Only increment counters on first nuke — not on rehydration repeats
        if (isFirstNuke) {
            const h = heuristics[reason];
            if (h) {
                h.count++;
                if (h.countEl) h.countEl.textContent = `caught: ${h.count}`;
            }
            logToHUD(reason, label);
            // Persist to nuke log for anchor search framework
            recordNuke(reason, label);
        }
        container.style.setProperty("display", "none", "important");
    }

    // ======================== PROCESSING ========================
    let scanCount = 0; // diagnostic scan counter

    function processPage() {
        const ctx = getPageContext();
        if (!filteringActive()) {
            console.log(`[DIAG] context: ${ctx} — filtering inactive, skipping`);
            return;
        }

        const titles = document.querySelectorAll("h3");
        scanCount++;
        console.log(`[DIAG] scan ${scanCount} — context: ${ctx}, h3 count: ${titles.length}`);
        if (scanCount % 50 === 0) {
            console.log(`[DIAG] session milestone: ${scanCount} scans, ${nukeCount} nuked`);
        }
        if (titles.length === 0) return;

        // ── Static DOM early exit ────────────────────────────────────────────
        // YouTube fires DOM mutations on scroll for reasons unrelated to new
        // video cards appearing (thumbnail lazy-loading, visibility attribute
        // updates, etc.). Each mutation triggers a RAF-debounced processPage()
        // call. Without this gate, we do a full per-container evaluation pass
        // against a completely static set of already-processed nodes.
        //
        // This pass uses Array.some() which short-circuits on the first
        // unprocessed container found — in the common case of a fully-processed
        // page it exits after finding the first match (or exhausting the list),
        // which is far cheaper than the full evaluation loop below.
        //
        // A container is considered unprocessed if its ytPurgeProcessed stamp
        // does not match its current title — covers both genuinely new nodes
        // and recycled nodes that YouTube has repopulated with different content.
        const hasNew = Array.from(titles).some(h3 => {
            const title = h3.textContent?.trim();
            if (!title || title.length < 3) return false;
            const container = findVideoContainerFromElement(h3);
            if (!container) return false;
            // Treat pending (hydrating) containers as unprocessed so they
            // are retried even when all stamps otherwise match
            if (container.dataset.ytPurgePending) return true;
            return container.dataset.ytPurgeProcessed !== `${sessionId}:${title}`;
        });

        if (!hasNew) {
            console.log(`[DIAG] scan ${scanCount} — static DOM, nothing to evaluate`);
            return;
        }

        const channelSeen = new Map();

        titles.forEach(h3 => {
            const title = h3.textContent?.trim();
            if (!title || title.length < 3) return;

            const container = findVideoContainerFromElement(h3);
            if (!container) return;

            // Skip non-video containers that the DOM walk legitimately reaches
            // but that should never be filtered. These host navigation headings
            // and section labels, not video cards.
            if (NON_VIDEO_CONTAINERS.has(container.tagName)) {
                console.log(`[DIAG] skip non-video container: <${container.tagName.toLowerCase()}> — "${title}"`);
                return;
            }

            // Skip only if we have already evaluated this exact title on
            // this container. A recycled container with a new title will
            // have a mismatched stamp and be re-evaluated.
            if (container.dataset.ytPurgeProcessed === `${sessionId}:${title}`) return;

            // ── Hydration Gate ───────────────────────────────────────────
            // Do not process this container until it passes the liveness
            // check. If it fails, mark as pending and let the next RAF
            // cycle retry — do NOT stamp it as processed.
            if (!isContainerLive(container, title)) {
                container.dataset.ytPurgePending = "1";
                console.log(`[DIAG] hydration pending: <${container.tagName.toLowerCase()}> — "${title}"`);
                return;
            }

            // Container is live — log hydration delta and clear pending flag
            logHydrationDelta(container, title);
            delete container.dataset.ytPurgePending;

            // Stamp with current title — done after liveness confirmed
            container.dataset.ytPurgeProcessed = `${sessionId}:${title}`;
            console.log(`[DIAG] container: <${container.tagName.toLowerCase()}> — "${title}"`);

            // ── Channel dedup ────────────────────────────────────────────────
            // Reads the channel name from the container DOM, counts occurrences
            // within the current batch via channelSeen, and nukes any container
            // beyond the first match. One per channel per batch.
            //
            // When getChannelName() returns null, the container carries no
            // deduplication signal and is passed through to the remaining
            // heuristics. This is not a failure — it is the correct behaviour
            // when no channel name is present to deduplicate against.
            if (heuristics.DUPE.enabled) {
                const channelName = getChannelName(container);
                if (channelName) {
                    const count = (channelSeen.get(channelName) || 0) + 1;
                    channelSeen.set(channelName, count);
                    if (count > 1) {
                        nuke(container, "DUPE", `${channelName} — ${title}`);
                        return;
                    }
                }
            }

            // ── Watched time filter ──────────────────────────────────────────
            // ytd-thumbnail-overlay-resume-playback-renderer #progress is the
            // red resume bar YouTube renders at the bottom of a thumbnail once
            // a video has been partially watched. Its inline width style holds
            // the watch percentage. By the time a container passes the hydration
            // gate (title + thumbnail present), this element is also rendered.
            if (heuristics.WATCHED.enabled) {
                const progressBar = container.querySelector(
                    "ytd-thumbnail-overlay-resume-playback-renderer #progress"
                );
                if (progressBar && progressBar.style.width) {
                    const percent = parseInt(progressBar.style.width, 10);
                    if (!isNaN(percent) && percent > 90) {
                        nuke(container, "WATCHED", `[${percent}%] ${title}`);
                        return;
                    }
                }
            }

            // ── Static heuristics ────────────────────────────────────────────
            if (heuristics.PHRASE.enabled) {
                if (CONFIG.clickbait.test(title) || matchesCustomPhrase(title)) {
                    nuke(container, "PHRASE", title);
                    return;
                }
            }

            if (heuristics.SLOP.enabled) {
                if (CONFIG.grammarSlop.test(title)) {
                    nuke(container, "SLOP", title);
                    return;
                }
            }

            if (heuristics.CAPS.enabled) {
                const letters = title.replace(/[^a-zA-Z]/g, "");
                if (letters.length > CONFIG.minTitleLength) {
                    const upperCount = letters.replace(/[^A-Z]/g, "").length;
                    if (upperCount / letters.length >= CONFIG.capsThreshold) {
                        nuke(container, "CAPS", title);
                        return;
                    }
                }
            }
        });
    }

    // ======================== INIT ========================
    let rafPending = false;
    function schedulePage() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            processPage();
        });
    }

    // Elements we expect to be present on a healthy YouTube homepage.
    // Checked once at startup — absence means YouTube has changed its
    // structure in a way that may break core functionality.
    const HEALTH_CHECK_ELEMENTS = [
        { selector: "ytd-app",                                  label: "YouTube root (ytd-app)" },
        { selector: "ytd-two-column-browse-results-renderer",   label: "Browse results renderer — primary observer target" },
        { selector: "ytd-rich-grid-renderer",                   label: "Feed grid (ytd-rich-grid-renderer)" },
        { selector: "ytd-rich-item-renderer",                   label: "Video card (ytd-rich-item-renderer)" },
    ];

    function runHealthCheck() {
        // Gate 1: Context — health check is only meaningful when filtering
        // is active. On watch pages, channel pages, or settings, the
        // structural elements this check verifies are legitimately absent.
        // Returning true here means "no problem" — not "check passed".
        if (!filteringActive()) return true;

        // Gate 2: Skeleton detection — if YouTube is still rendering loading
        // skeletons, structural elements may be transiently absent. Avoid
        // false [CRIT] reports by waiting until real content is present.
        const isSkeleton = !!document.querySelector(
            "ytd-ghost-video-grid-renderer, #home-page-skeleton"
        );
        if (isSkeleton) {
            console.log("[YT-PURGE] Health check deferred — page skeleton detected");
            return true;
        }

        let allOk = true;
        HEALTH_CHECK_ELEMENTS.forEach(({ selector, label }) => {
            if (!document.querySelector(selector)) {
                allOk = false;
                console.error(`[YT-PURGE][CRIT] missing element: ${label}`);
            }
        });

        // Gate 3: Validate actual video items are present — distinguishes
        // a structural failure from an empty-but-valid page state.
        const hasItems = !!document.querySelector(
            "ytd-rich-item-renderer, ytd-video-renderer"
        );

        if (allOk && hasItems) {
            console.log("[YT-PURGE] Health check passed — all structural elements present");
            return true;
        } else {
            logToHUD("CRIT", "Structural failure detected — capturing DOM and running anchor search");
            console.log("[YT-PURGE] Health check failed — capturing DOM and initiating anchor search");
            captureAndDownloadDOM("health-failure");
            runAnchorSearch();
            return false;
        }
    }

    // ======================== DIAGNOSTIC EXPORT ========================
    function exportDiagnostic() {
        const ctx       = getPageContext();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename  = `yt-tuner-diag-${ctx}-${timestamp}.md`;

        const filterRows = Object.entries(heuristics)
            .map(([key, h]) =>
                `| ${key.padEnd(7)} | ${h.enabled ? "yes" : "no "}     | ${String(h.count).padStart(6)} |`
            ).join("\n");

        const phrases = customPhrases.length > 0
            ? customPhrases.map(p => `- ${p}`).join("\n")
            : "_none_";

        const nukeLogEntries = loadNukeLog();
        const nukeLogText = nukeLogEntries.length > 0
            ? nukeLogEntries.map((e, i) => `${i + 1}. [${e.reason}] ${e.label}`).join("\n")
            : "_empty_";

        const events = systemEvents.length > 0
            ? systemEvents.map(e => `[${e.level}] ${e.message}`).join("\n")
            : "none";

        const md = [
            `## Header`,
            ``,
            `\`\`\``,
            `session_id:   ${sessionId}`,
            `exported_at:  ${new Date().toISOString()}`,
            `page_context: ${ctx}`,
            `scan_count:   ${scanCount}`,
            `nuke_count:   ${nukeCount}`,
            `\`\`\``,
            ``,
            `## Filters`,
            ``,
            `| filter  | enabled | caught |`,
            `|---------|---------|--------|`,
            filterRows,
            ``,
            `## Custom Phrases`,
            ``,
            phrases,
            ``,
            `## Nuke Log`,
            ``,
            nukeLogText,
            ``,
            `## System Events`,
            ``,
            events,
        ].join("\n");

        try {
            const blob = new Blob([md], { type: "text/markdown" });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement("a");
            a.href     = url;
            a.download = filename;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            logToHUD("INFO", `Diagnostic exported: ${filename}`);
            console.log(`[YT-PURGE] Diagnostic exported: ${filename}`);
        } catch (e) {
            logToHUD("CRIT", `Diagnostic export failed: ${e.message}`);
            console.error("[YT-PURGE] Diagnostic export failed:", e.message);
        }
    }

    // ======================== DOM CAPTURE FRAMEWORK ========================
    // Captures document.documentElement.outerHTML and triggers a browser
    // download. Used for offline structural analysis and selector testing.
    //
    // Limitation: closed shadow roots are not serialised by outerHTML.
    // Content inside shadow boundaries (e.g. ytd-rich-item-renderer internals)
    // will appear as empty custom elements in the capture. The container
    // hierarchy, class names, and visible text above the shadow boundary
    // are captured and sufficient for structural diagnosis.
    //
    // reason: short label describing why the capture was taken.
    //   "manual"            — user pressed 📸 button
    //   "health-failure"    — health check returned false
    //   "observer-fallback" — legacy observer activated
    //   "anchor-search"     — anchor search completed

    function captureAndDownloadDOM(reason) {
        try {
            const ctx       = getPageContext();
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const filename  = `yt-purge-dom-capture-${reason}-${ctx}-${timestamp}.html`;
            const html      = document.documentElement.outerHTML;
            const blob      = new Blob([html], { type: "text/html" });
            const url       = URL.createObjectURL(blob);
            const a         = document.createElement("a");
            a.href          = url;
            a.download      = filename;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            const sizeKb = Math.round(html.length / 1024);
            logToHUD("INFO", `DOM captured: ${filename} (${sizeKb}KB)`);
            console.log(`[YT-PURGE] DOM captured: ${filename} (${sizeKb}KB)`);
        } catch (e) {
            logToHUD("CRIT", `DOM capture failed: ${e.message}`);
            console.error("[YT-PURGE] DOM capture failed:", e.message);
        }
    }

    // ======================== ANCHOR SEARCH FRAMEWORK ========================
    // On structural failure ([CRIT]), attempts to locate confirmed-rendered
    // titles in the current DOM using the nuke log as search beacons.
    // Purpose: identify new container tag names after a YouTube DOM rename.
    // Contract: observation and reporting only. Never auto-applies results.
    //
    // Known container tags — used to classify pivot candidates as known
    // renames vs genuinely new structures.
    const KNOWN_CONTAINER_TAGS = new Set([
        "YTD-RICH-ITEM-RENDERER", "YTD-COMPACT-VIDEO-RENDERER",
        "YTD-VIDEO-RENDERER", "YTD-GRID-VIDEO-RENDERER",
        "YTD-REEL-ITEM-RENDERER", "YTD-SHELF-RENDERER",
        "YTD-ITEM-SECTION-RENDERER", "YTD-COMPACT-RADIO-RENDERER",
    ]);

    function runAnchorSearch() {
        const anchors = loadNukeLog();
        if (!anchors.length) {
            console.log("[YT-PURGE] Anchor search: no nuke log entries available");
            logToHUD("WARN", "Anchor search inconclusive — no nuke log available");
            return;
        }

        // Delay 500ms to avoid searching during a mid-render skeleton state
        setTimeout(() => {
            const allText = document.querySelectorAll("h3, yt-formatted-string, span");
            const found = [];
            const candidates = new Map(); // tag → count

            anchors.forEach(anchor => {
                const anchorLabel = typeof anchor === "string" ? anchor : anchor.label;
                for (const el of allText) {
                    if (el.textContent?.trim() === anchorLabel) {
                        found.push(anchor);
                        // Walk up to find the atomic container
                        let node = el;
                        let levels = 0;
                        while (node && node !== document.body && levels < 10) {
                            node = node.parentElement;
                            levels++;
                            if (node && node.tagName && node.tagName.startsWith("YTD-")) {
                                const tag = node.tagName;
                                candidates.set(tag, (candidates.get(tag) || 0) + 1);
                                break;
                            }
                        }
                        break; // one match per anchor is sufficient
                    }
                }
            });

            console.log(`[YT-PURGE] Anchor search: ${found.length}/${anchors.length} anchors found`);

            if (found.length < 2) {
                logToHUD("WARN", `Anchor search inconclusive — only ${found.length}/${anchors.length} anchors found`);
                return;
            }

            // Report each candidate container tag
            if (!candidates.size) {
                logToHUD("CRIT", "Pivot failed — anchors found but no YTD container in parent chain");
                return;
            }

            candidates.forEach((count, tag) => {
                const isKnown = KNOWN_CONTAINER_TAGS.has(tag);
                const label = isKnown
                    ? `Pivot confirmed known container: <${tag.toLowerCase()}> (${found.length}/${anchors.length} anchors)`
                    : `Pivot candidate: <${tag.toLowerCase()}> (${found.length}/${anchors.length} anchors confirmed) — UNKNOWN TAG`;
                logToHUD(isKnown ? "INFO" : "WARN", label);
                console.log(`[YT-PURGE] ${label}`);
            });
            // Capture DOM after anchor search — provides snapshot at the
            // moment structural analysis completed, with pivot candidates known
            captureAndDownloadDOM("anchor-search");

        }, 500);
    }

    // ── PRIMARY OBSERVER ─────────────────────────────────────────────────
    // Targets ytd-two-column-browse-results-renderer — confirmed via console
    // inspection of the parent chain above ytd-rich-item-renderer.
    // Scoped narrowly enough to exclude sidebar, hover preview, and UI chrome
    // mutations. Handles SPA navigation by watching for the target element to
    // change and re-attaching when it does.
    //
    // HUD state reporting:
    //   [INFO] Narrowed observer active       — primary path running normally
    //   [INFO] Observer re-attached after SPA — re-attached after navigation
    //   [CRIT] Primary target not found       — fell through to legacy fallback

    let observer = null;
    let currentBrowseTarget = null;

    // Selector targets the browse renderer inside the currently active
    // (non-hidden) page context. YouTube uses ytd-page-manager to stack
    // pages rather than destroy them — old pages get the hidden attribute
    // and remain in the DOM. A bare "ytd-two-column-browse-results-renderer"
    // query returns the first match in document order, which is the oldest
    // (and usually hidden) page when the SPA entry point was not home.
    // Anchoring on `ytd-page-manager > *:not([hidden])` ensures the observer
    // attaches to the live renderer receiving current feed mutations.
    const ACTIVE_BROWSE_RENDERER_SELECTOR =
        "ytd-page-manager > *:not([hidden]) ytd-two-column-browse-results-renderer";

    function attachNarrowObserver() {
        const target = document.querySelector(ACTIVE_BROWSE_RENDERER_SELECTOR);
        if (!target) return false;
        if (observer) observer.disconnect();
        currentBrowseTarget = target;
        observer = new MutationObserver(schedulePage);
        observer.observe(target, { childList: true, subtree: true });
        return true;
    }

    // ======================== NAVIGATION-GATED LIFECYCLE ===================
    // Uses yt-navigate-finish event and ytd-page-manager active-child
    // selector. See historical notes below for the design rationale.
    // Second attempt at lazy, context-aware initialisation.
    //
    // v3.6.9 failure analysis (see roadmap):
    //   The SPA observer (subtree:true on documentElement) fires on every DOM
    //   mutation including scroll. Calling boot() from inside it caused the
    //   feed observer to be replaced hundreds of times per scroll before the
    //   booted flag was set, because boot() is async (setTimeout polling).
    //
    // v3.6.92 fix — strict responsibility separation:
    //   boot()              — called ONLY from bootOnce() below, never from
    //                         the high-frequency SPA observer.
    //   initialRenderObs    — one-shot observer on document.body. Fires when
    //                         the browse renderer first appears (direct load,
    //                         hard reload). Disconnects after first match.
    //                         Calls bootOnce().
    //   SPA observer        — watches ONLY for currentBrowseTarget to change.
    //                         Never calls boot(). Only calls attachNarrowObserver()
    //                         after boot is complete, and only on genuine
    //                         renderer replacement.
    //   bootOnce()          — synchronous gate. Sets booting = true immediately
    //                         (not after async polling). Prevents any re-entry.

    let booted    = false;
    let booting   = false;
    let sessionId = 0; // increments on each home/search navigation
                       // stamps include sessionId so stale stamps from
                       // previous navigations are detected and re-evaluated

    function createUIOnce() {
        if (!hudHost)   hudHost   = createHUD();
        if (!panelHost) panelHost = createWordPanel();
    }

    function injectUIIfNeeded() {
        // Always checks actual DOM state — no flag guard.
        // Safe to call from the SPA observer on every navigation.
        if (!filteringActive()) return;
        createUIOnce();
        if (!document.documentElement.contains(hudHost))
            document.documentElement.appendChild(hudHost);
        if (!document.documentElement.contains(panelHost))
            document.documentElement.appendChild(panelHost);
    }

    function bootOnce() {
        // Synchronous re-entry guard — set immediately, not after async polling.
        // This is the fix for v3.6.9: booting is true before any setTimeout
        // fires, so rapid repeated calls from any source are blocked immediately.
        if (booting || booted || !filteringActive()) return;
        booting = true;

        injectUIIfNeeded();
        console.log(`[YT-PURGE] v3.8 booting. Context: ${getPageContext()}. Custom phrases: ${customPhrases.length}. Nuke log: ${loadNukeLog().length} entries`);

        const waitForPrimaryTarget = (attempts = 0) => {
            if (attachNarrowObserver()) {
                booted = true;
                if (getPageContext() === "home") setTimeout(runHealthCheck, 1500);
                logToHUD("INFO", `Narrowed observer active after ${attempts * 250}ms`);
                console.log(`[YT-PURGE] Narrowed observer active after ${attempts * 250}ms`);
                processPage();
            } else if (attempts < 20) {
                setTimeout(() => waitForPrimaryTarget(attempts + 1), 250);
            } else {
                // ── LEGACY FALLBACK ───────────────────────────────────────────
                // PRIMARY TARGET NOT FOUND after 5 seconds.
                // Retained from v3.6.4 as resilience measure.
                // Activation is always [CRIT] — never silenced.
                booted = true;
                console.error("[YT-PURGE][LEGACY] Primary target not found after 5s — falling back to document.body");
                logToHUD("CRIT", "Primary observer target absent — legacy fallback active (document.body)");
                captureAndDownloadDOM("observer-fallback");
                if (observer) observer.disconnect();
                observer = new MutationObserver(schedulePage);
                observer.observe(document.body, { childList: true, subtree: true });
                if (getPageContext() === "home") runHealthCheck();
                // ── END LEGACY FALLBACK ───────────────────────────────────────
            }
        };
        waitForPrimaryTarget();
    }

    function init() {
        // ── yt-navigate-finish: YouTube native SPA navigation event ──────
        // Fires on window exactly when a client-side route change completes
        // and the new page structure is stable. This replaces the noisy
        // documentElement MutationObserver used in v3.6.9 and v3.6.92.
        //
        // Why previous attempts failed (confirmed by Gemini, trained on
        // internal Alphabet IP):
        //   Attempt 1 (v3.6.9): documentElement observer fires on every
        //     scroll mutation, causing boot() to be called hundreds of times
        //     before the async booted flag was set.
        //   Attempt 2 (v3.6.92): YouTube creates a transient
        //     ytd-two-column-browse-results-renderer during route change,
        //     destroys it milliseconds later, and replaces it with the final
        //     one. Our observer was attaching to the transient ghost element.
        //   yt-navigate-finish fires only once per navigation, after the
        //     final renderer is stable. requestAnimationFrame inside the
        //     handler gives YouTube one additional frame to finish stamping
        //     the final renderer into the active DOM.
        window.addEventListener("yt-navigate-finish", () => {
            // Increment sessionId on every navigation — stale stamps from
            // previous page load will no longer match and containers will
            // be re-evaluated even if YouTube reuses the same DOM nodes.
            sessionId++;
            console.log(`[YT-PURGE] yt-navigate-finish: sessionId now ${sessionId}`);
            if (!filteringActive()) {
                booted  = false;
                booting = false;
                console.log("[YT-PURGE] yt-navigate-finish: non-filterable context — boot flags reset");
                return;
            }
            requestAnimationFrame(() => {
                if (booted) {
                    // Already booted — check if the active renderer changed.
                    // Use the same active-page-only selector so we compare
                    // against the live renderer, not a stale hidden one.
                    const current = document.querySelector(ACTIVE_BROWSE_RENDERER_SELECTOR);
                    if (current && current !== currentBrowseTarget) {
                        if (attachNarrowObserver()) {
                            if (getPageContext() === "home") setTimeout(runHealthCheck, 1500);
                            logToHUD("INFO", "Observer re-attached after SPA navigation");
                            console.log("[YT-PURGE] Observer re-attached after SPA navigation");
                            processPage();
                        }
                    }
                } else {
                    bootOnce();
                }
                injectUIIfNeeded();
            });
        });

        // ── Direct load / hard reload ────────────────────────────────────
        // yt-navigate-finish does not fire on initial page load — only on
        // subsequent client-side navigations. waitForBody + bootOnce()
        // handles the direct load case. If yt-navigate-finish also fires
        // on this load, the synchronous booting flag inside bootOnce()
        // safely debounces the duplicate call.
        const waitForBody = () => {
            if (!document.body) { setTimeout(waitForBody, 10); return; }
            bootOnce();
        };
        waitForBody();
    }

    init();
})();
