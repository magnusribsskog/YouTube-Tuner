// ==UserScript==
// @name         YouTube Purge v3.6.91 - Diagnostic
// @version      3.6.91
// @description  v3.6.9 + reverted navigation-gated lifecycle + restored proven init
// @author       Anonymous
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 *
 * v3.6.9 changes from v3.6.8:
 * - grammarSlop expanded: added punctuation repetition ([.!?,]{2,})
 * - Diagnostic console logging added throughout:
 *     [DIAG] scan N — fired on every processPage() call with title count
 *     [DIAG] container — logs each new container tag + title as it is processed
 *     [DIAG] selector OK/FAIL — logs each getChannelName() attempt with which
 *       selector succeeded or that all failed, per container
 *     [DIAG] session — logs cumulative scan count every 50 scans
 *     [DIAG] context — logs page context on every processPage() call
 * - All diagnostic logging prefixed [DIAG] for easy console filtering
 * - All v3.6 behaviours retained unchanged.
 *
 * localStorage keys:
 *   "yt-purge-phrases" → JSON array of strings (custom phrase list)
 *
 * Heuristic toggle state: session-only, not persisted
 * Channel dedup: unchanged — one per channel per batch, no persistence needed
 */

(function() {
    "use strict";

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
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    function saveNukeLog(log) {
        try { localStorage.setItem(CONFIG.NUKE_LOG_KEY, JSON.stringify(log)); }
        catch (e) { console.warn("[YT-PURGE] Nuke log save failed:", e.message); }
    }

    function recordNuke(title) {
        const log = loadNukeLog();
        // Prepend new title, keep only the last NUKE_LOG_SIZE unique entries
        const updated = [title, ...log.filter(t => t !== title)].slice(0, CONFIG.NUKE_LOG_SIZE);
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
        mainTitle.textContent = "☢️ YouTube Purge v3.6.91-diag";
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
        // If Phase 1 found nothing, the channel name may live inside a shadow
        // root on one of the container's descendant elements. This is suspected
        // for ytd-rich-item-renderer where all Phase 1 selectors return null.
        //
        // Strategy: walk every descendant of the container. For each node that
        // has a shadowRoot, try all CHANNEL_SELECTORS inside that shadow tree.
        // Log every shadow root encountered and every result — this is mapping
        // behaviour, not just error reporting. The output tells us exactly where
        // the channel name lives so we can hardcode the correct path in v3.6.3.
        //
        // Note: we walk container.querySelectorAll("*") which returns all
        // descendants in the regular DOM. Shadow roots are opt-in and each
        // element either has one or doesn't — we check el.shadowRoot on each.
        // We do NOT recursively descend into nested shadow roots for now;
        // one level is sufficient to map the immediate structure.
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

        // ── Phase 3: Failure reporting ───────────────────────────────────────
        // Both phases failed. Log the full picture once per container tag type
        // to avoid flooding — but include shadow root inventory so we know
        // what was searched. HUD gets an amber WARN; console gets the detail.
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
            recordNuke(label);
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
            return container.dataset.ytPurgeProcessed !== title;
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
            const NON_VIDEO_CONTAINERS = new Set([
                "YTD-GUIDE-SECTION-RENDERER",
                "YTD-GUIDE-ENTRY-RENDERER",
            ]);
            if (NON_VIDEO_CONTAINERS.has(container.tagName)) {
                console.log(`[DIAG] skip non-video container: <${container.tagName.toLowerCase()}> — "${title}"`);
                return;
            }

            // Skip only if we have already evaluated this exact title on
            // this container. A recycled container with a new title will
            // have a mismatched stamp and be re-evaluated.
            if (container.dataset.ytPurgeProcessed === title) return;

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
            container.dataset.ytPurgeProcessed = title;
            console.log(`[DIAG] container: <${container.tagName.toLowerCase()}> — "${title}"`);

            // ── Channel dedup ────────────────────────────────────────────────
            // We force each batch to never render more than one video per 
            // channel. This vastly improves the function of the Home page as
            // a place for content discovery, and solves one of YouTube's most
            // asinine algorithmic behaviours (channel flooding).
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

    // Healthcheck is fundamentally broken. Correct loading of the script still relies on navigating directly to the youtube home page
    
    
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
                for (const el of allText) {
                    if (el.textContent?.trim() === anchor) {
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

    function attachNarrowObserver() {
        const target = document.querySelector("ytd-two-column-browse-results-renderer");
        if (!target) return false;
        if (observer) observer.disconnect();
        currentBrowseTarget = target;
        observer = new MutationObserver(schedulePage);
        observer.observe(target, { childList: true, subtree: true });
        return true;
    }

    function init() {
        // Eager UI injection — HUD and panel always present in the DOM.
        // Navigation-gated lazy injection was attempted in v3.6.9 and
        // reverted in v3.6.91. See roadmap for findings. The lifecycle
        // complexity introduced by lazy injection caused the feed observer
        // to be replaced on every scroll mutation during SPA navigation,
        // resulting in filtering stopping after the first pass.
        hudHost   = createHUD();
        panelHost = createWordPanel();
        document.documentElement.appendChild(hudHost);
        document.documentElement.appendChild(panelHost);

        const waitForBody = () => {
            if (document.body) {
                processPage();
                console.log(`[YT-PURGE] v3.6.91-diagnostic active. Context: ${getPageContext()}. Custom phrases: ${customPhrases.length}. Nuke log: ${loadNukeLog().length} entries`);

                // Attempt to attach the primary narrowed observer.
                // Polls every 250ms for up to 5 seconds (20 attempts).
                const waitForPrimaryTarget = (attempts = 0) => {
                    if (attachNarrowObserver()) {
                        if (getPageContext() === "home") setTimeout(runHealthCheck, 1500);
                        logToHUD("INFO", `Narrowed observer active after ${attempts * 250}ms`);
                        console.log(`[YT-PURGE] Narrowed observer active after ${attempts * 250}ms`);
                    } else if (attempts < 20) {
                        setTimeout(() => waitForPrimaryTarget(attempts + 1), 250);
                    } else {
                        // ── LEGACY FALLBACK ───────────────────────────────────────────
                        // PRIMARY TARGET NOT FOUND after 5 seconds.
                        // This block is retained from v3.6.4 as a resilience measure.
                        // It is legacy code — its activation means the primary observer
                        // architecture has failed, not that the script is operating
                        // correctly in a degraded state.
                        //
                        // Waiting to be replaced by: a more robust primary target
                        // detection strategy once YouTube DOM structure is better
                        // understood across navigation patterns.
                        //
                        // Activation is always [CRIT] — never silenced.
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
            } else {
                setTimeout(waitForBody, 10);
            }
        };
        waitForBody();

        // SPA navigation re-attachment: watches for the browse results renderer
        // to change (YouTube replaces it on navigation) and re-attaches the
        // primary observer to the new element. Also re-injects HUD if YouTube
        // removes it. subtree: true required — SPA navigation mutates deeply
        // nested elements, not direct children of documentElement.
        new MutationObserver(() => {
            const current = document.querySelector("ytd-two-column-browse-results-renderer");
            if (current && current !== currentBrowseTarget) {
                if (attachNarrowObserver()) {
                    if (getPageContext() === "home") setTimeout(runHealthCheck, 1500);
                    logToHUD("INFO", "Observer re-attached after SPA navigation");
                    console.log("[YT-PURGE] Observer re-attached after SPA navigation");
                }
            }
            if (!document.documentElement.contains(hudHost)) {
                document.documentElement.appendChild(hudHost);
            }
            if (!document.documentElement.contains(panelHost)) {
                document.documentElement.appendChild(panelHost);
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    init();
})();
