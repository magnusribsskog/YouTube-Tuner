/*
 * YouTube Tuner v3.9 — Chrome Extension Content Script
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
 *   - yt-navigate-finish event drives SPA navigation lifecycle
 *   - Hydration gate: containers not processed until title + thumbnail present
 *   - sessionId stamps: invalidate stale stamps across SPA navigations
 *   - Recycled container re-evaluation via ytPurgeProcessed stamp
 *   - Shadow DOM HUD + Word Panel (draggable, collapsible)
 *
 * Self-Healing:
 *   - CONTAINER_TAGS_BASELINE: hardcoded known-good tag set, never modified
 *   - chrome.storage.local corrections: discovered tags merged with baseline at startup
 *   - On structural failure, anchor search finds pivot candidates
 *   - Unknown tag with ≥2 beacon confirmations → persisted to storage
 *     and added to active tag set for this session; observer reattached
 *   - No time-based expiry; corrections are valid until replaced by a
 *     subsequent anchor search
 *
 * Diagnostics:
 *   - Health check on homepage boot with three gates (context, skeleton,
 *     video item presence). Reports [CRIT] if structural elements missing.
 *   - DOM capture framework: 📸 button + automatic capture on CRIT states
 *   - Anchor search: last 5 nuked titles as DOM beacons on structural failure
 *   - Console [DIAG] logging throughout; HUD levels [INFO]/[WARN]/[CRIT]
 *
 * chrome.storage.local keys:
 *   "yt-purge-phrases"              — array of user-managed custom phrase strings
 *   "yt-purge-nuke-log"             — last 5 confirmed-nuked titles for anchor search
 *   "yt-tuner-selector-corrections" — discovered container tag corrections
 */

(function() {
    "use strict";

    // ======================== STORAGE ========================
    // Thin wrapper over chrome.storage.local. Values are stored as native
    // objects — no JSON.stringify/parse needed (the extension API handles
    // serialisation internally).
    const Storage = {
        get: key => chrome.storage.local.get([key]).then(r => r[key] ?? null),
        set: (key, val) => chrome.storage.local.set({ [key]: val }),
    };

    // Container tags that the h3 DOM walk legitimately reaches but which
    // host section headers and navigation entries rather than video cards.
    // These are skipped before any heuristic evaluates them.
    const NON_VIDEO_CONTAINERS = new Set([
        "YTD-GUIDE-SECTION-RENDERER",
        "YTD-GUIDE-ENTRY-RENDERER",
    ]);

    // ======================== CONTAINER TAG BASELINE ========================
    // Hardcoded known-good tag set. Never modified at runtime. Stored
    // corrections are merged on top via buildActiveTagSet() to produce
    // activeContainerTags. If storage is cleared, cold start falls back
    // here identically to pre-self-healing behaviour.
    //
    // Self-healing design:
    //   When the health check fires a CRIT and anchor search finds pivot
    //   candidates, the code validates the candidate (≥2 beacon matches),
    //   writes the discovered tag to storage with a timestamp and hit count,
    //   adds it to activeContainerTags for the current session, reattaches
    //   the observer, and re-runs processPage(). No time-based expiry —
    //   corrections are valid until a subsequent anchor search replaces them.
    //
    // Storage entry format (per correction):
    //   { tag, discovered: ISO8601, hits: number, last_confirmed: ISO8601 }
    //
    // Known selector mutations (maintained manually as corrections are
    // discovered in the field — see git log for history):
    //   none recorded yet
    const CONTAINER_TAGS_BASELINE = new Set([
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

    // Active set used at runtime — baseline + corrections. Rebuilt on startup
    // and after each correction is committed.
    let activeContainerTags = new Set(CONTAINER_TAGS_BASELINE);

    // ======================== SELECTOR CORRECTIONS ========================
    const CORRECTIONS_KEY = "yt-tuner-selector-corrections";

    async function loadSelectorCorrections() {
        try {
            const val = await Storage.get(CORRECTIONS_KEY);
            return Array.isArray(val) ? val : [];
        } catch (e) { return []; }
    }

    async function saveSelectorCorrections(corrections) {
        try {
            await Storage.set(CORRECTIONS_KEY, corrections);
        } catch (e) {
            console.warn("[YT-PURGE] Selector corrections save failed:", e.message);
        }
    }

    async function buildActiveTagSet() {
        activeContainerTags = new Set(CONTAINER_TAGS_BASELINE);
        const corrections = await loadSelectorCorrections();
        corrections.forEach(c => activeContainerTags.add(c.tag));
        console.log(`[YT-PURGE] Active tag set: ${[...activeContainerTags].join(", ")}`);
        if (corrections.length > 0) {
            console.log(`[YT-PURGE] Loaded ${corrections.length} correction(s) from storage`);
        }
        return activeContainerTags;
    }

    async function commitCorrection(tag) {
        const now = new Date().toISOString();
        const corrections = await loadSelectorCorrections();
        const existing = corrections.find(c => c.tag === tag);
        if (existing) {
            existing.hits++;
            existing.last_confirmed = now;
        } else {
            corrections.push({ tag, discovered: now, hits: 1, last_confirmed: now });
        }
        await saveSelectorCorrections(corrections);
        await buildActiveTagSet();
        logToHUD("INFO", `Selector correction committed: <${tag.toLowerCase()}>`);
        console.log(`[YT-PURGE] Correction committed: ${tag}`);
    }

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
    async function loadPhrases() {
        try {
            const val = await Storage.get(CONFIG.PHRASES_KEY);
            if (!val) return [];
            if (!Array.isArray(val)) return [];
            return val.map(p => String(p).toLowerCase().trim()).filter(Boolean);
        } catch (e) {
            console.warn("[YT-PURGE] Phrase list load failed:", e.message);
            return [];
        }
    }

    async function savePhrases() {
        try {
            await Storage.set(CONFIG.PHRASES_KEY, customPhrases);
        } catch (e) {
            console.warn("[YT-PURGE] Phrase list save failed:", e.message);
        }
    }

    let customPhrases = []; // populated during init()

    // ── Nuke log: persists last N nuked titles for anchor search ─────────
    async function loadNukeLog() {
        try {
            const val = await Storage.get(CONFIG.NUKE_LOG_KEY);
            if (!val) return [];
            if (!Array.isArray(val)) return [];
            return val.map(e => typeof e === "string" ? { reason: "?", label: e } : e);
        } catch (e) { return []; }
    }

    async function saveNukeLog(log) {
        try { await Storage.set(CONFIG.NUKE_LOG_KEY, log); }
        catch (e) { console.warn("[YT-PURGE] Nuke log save failed:", e.message); }
    }

    async function recordNuke(reason, label) {
        const log = await loadNukeLog();
        const updated = [{ reason, label }, ...log.filter(e => e.label !== label)].slice(0, CONFIG.NUKE_LOG_SIZE);
        await saveNukeLog(updated);
    }

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
        const { version } = chrome.runtime.getManifest();
        mainTitle.textContent = `☢️ YouTube Tuner v${version} [ext]`;
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
        if (!isCrit) {
            while (logPipeDiv.children.length > CONFIG.logLimit) {
                logPipeDiv.removeChild(logPipeDiv.lastChild);
            }
        }
    }

    // ======================== WORD PANEL ========================
    let panelHost    = null;
    let panelContent = null;

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

        panelContent = document.createElement("div");
        panelContent.style.cssText = "padding: 12px; display: flex; flex-direction: column; gap: 12px;";

        const toggleSection = document.createElement("div");

        const toggleHeading = document.createElement("div");
        toggleHeading.textContent = "FILTERS  (session only)";
        toggleHeading.style.cssText = "font-size: 9px; color: #555; font-family: monospace; font-weight: 700; margin-bottom: 8px; letter-spacing: 1px;";
        toggleSection.appendChild(toggleHeading);

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
            h.countEl = countEl;

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

        const phraseSection = document.createElement("div");
        phraseSection.style.cssText = "border-top: 1px solid #1a1a1a; padding-top: 12px;";

        const phraseHeading = document.createElement("div");
        phraseHeading.textContent = "CUSTOM PHRASES  (persistent)";
        phraseHeading.style.cssText = "font-size: 9px; color: #555; font-family: monospace; font-weight: 700; margin-bottom: 8px; letter-spacing: 1px;";
        phraseSection.appendChild(phraseHeading);

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
        while (node && node !== document.body) {
            if (activeContainerTags.has(node.tagName)) return node;
            node = node.parentElement;
        }
        // Fallback: find the YTD-* element that is a direct child of a div#contents.
        // YouTube's grid and list layouts consistently place the video card element
        // (ytd-rich-item-renderer, ytd-video-renderer, etc.) as a direct child of
        // div#contents inside the row or section renderer. This correctly resolves
        // to the outermost card container without knowing its tag name, ensuring
        // the grid space collapses when the container is hidden.
        // div#contents (plural) is the grid row's child list; div#content (singular)
        // is an inner layout div within a single card — these are reliably distinct.
        node = element.parentElement;
        while (node && node !== document.body) {
            if (node.tagName?.startsWith("YTD-") && node.parentElement?.id === "contents") {
                return node;
            }
            node = node.parentElement;
        }
        return element.parentElement;
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
        for (const sel of CHANNEL_SELECTORS) {
            const el = container.querySelector(sel);
            const name = el?.textContent?.trim();
            if (name) {
                console.log(`[DIAG] selector OK: "${sel}" → "${name}" in <${container.tagName.toLowerCase()}>`);
                return name.toLowerCase();
            }
        }

        const tag = container.tagName.toLowerCase();
        const descendants = container.querySelectorAll("*");
        const shadowRootsFound = [];

        for (const el of descendants) {
            if (!el.shadowRoot) continue;
            shadowRootsFound.push(el.tagName.toLowerCase());
            console.log(`[DIAG] shadow root found on <${el.tagName.toLowerCase()}> inside <${tag}>`);
            for (const sel of CHANNEL_SELECTORS) {
                const target = el.shadowRoot.querySelector(sel);
                const name = target?.textContent?.trim();
                if (name) {
                    console.log(`[DIAG] SHADOW selector OK: "${sel}" → "${name}" on <${el.tagName.toLowerCase()}> in <${tag}>`);
                    return name.toLowerCase();
                } else if (target) {
                    console.log(`[DIAG] SHADOW selector matched but empty: "${sel}" on <${el.tagName.toLowerCase()}>`);
                }
            }
        }

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
    const containerCreatedAt = new WeakMap();

    function isContainerLive(container, title) {
        if (!containerCreatedAt.has(container)) {
            containerCreatedAt.set(container, performance.now());
        }
        if (!title || title.length < 3) return false;
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
    function nuke(container, reason, label) {
        const isFirstNuke = !container.dataset.ytPurgeNuked;
        container.dataset.ytPurgeNuked = "1";
        if (isFirstNuke) {
            const h = heuristics[reason];
            if (h) {
                h.count++;
                if (h.countEl) h.countEl.textContent = `caught: ${h.count}`;
            }
            logToHUD(reason, label);
            recordNuke(reason, label);
        }
        container.style.setProperty("display", "none", "important");
    }

    // ======================== PROCESSING ========================
    let scanCount = 0;

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

        const hasNew = Array.from(titles).some(h3 => {
            const title = h3.textContent?.trim();
            if (!title || title.length < 3) return false;
            const container = findVideoContainerFromElement(h3);
            if (!container) return false;
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

            if (NON_VIDEO_CONTAINERS.has(container.tagName)) {
                console.log(`[DIAG] skip non-video container: <${container.tagName.toLowerCase()}> — "${title}"`);
                return;
            }

            if (container.dataset.ytPurgeProcessed === `${sessionId}:${title}`) return;

            if (!isContainerLive(container, title)) {
                container.dataset.ytPurgePending = "1";
                console.log(`[DIAG] hydration pending: <${container.tagName.toLowerCase()}> — "${title}"`);
                return;
            }

            logHydrationDelta(container, title);
            delete container.dataset.ytPurgePending;

            container.dataset.ytPurgeProcessed = `${sessionId}:${title}`;
            console.log(`[DIAG] container: <${container.tagName.toLowerCase()}> — "${title}"`);

            classifyTitle(title);

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

    // ======================== THEMATIC INTELLIGENCE ========================
    // Interface to the background service worker. Fire-and-forget during the
    // diagnostic phase — the resolved value is not yet used by the filter pipeline.
    function classifyTitle(title) {
        return new Promise(resolve => {
            const t = setTimeout(() => resolve(null), 500);
            try {
                chrome.runtime.sendMessage({ type: "CLASSIFY_TITLE", title }, response => {
                    clearTimeout(t);
                    if (chrome.runtime.lastError) { resolve(null); return; }
                    resolve(response ?? null);
                });
            } catch (e) {
                clearTimeout(t);
                resolve(null);
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

    const HEALTH_CHECK_ELEMENTS = [
        { selector: "ytd-app",                                  label: "YouTube root (ytd-app)" },
        { selector: "ytd-two-column-browse-results-renderer",   label: "Browse results renderer — primary observer target" },
        { selector: "ytd-rich-grid-renderer",                   label: "Feed grid (ytd-rich-grid-renderer)" },
        { selector: "ytd-rich-item-renderer",                   label: "Video card (ytd-rich-item-renderer)" },
    ];

    function runHealthCheck() {
        if (!filteringActive()) return true;

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
    // Exported via the ✱ button. Downloaded as yt-tuner-diag-<ctx>-<ts>.md.
    //
    // Format:
    //   ## Header
    //   session_id, exported_at, page_context, scan_count, nuke_count
    //
    //   ## Filters
    //   One row per heuristic: filter | enabled | caught
    //
    //   ## Custom Phrases
    //   Persistent phrase list, or "_none_"
    //
    //   ## Selector Corrections
    //   Active corrections from storage, or "_none_"
    //
    //   ## Nuke Log
    //   Last 5 nuked titles (most recent first): [REASON] title
    //
    //   ## System Events
    //   All WARN and CRIT entries this session. "none" if clean.
    //   INFO entries are omitted — noise at this level.
    async function exportDiagnostic() {
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

        const nukeLogEntries = await loadNukeLog();
        const nukeLogText = nukeLogEntries.length > 0
            ? nukeLogEntries.map((e, i) => `${i + 1}. [${e.reason}] ${e.label}`).join("\n")
            : "_empty_";

        const events = systemEvents.length > 0
            ? systemEvents.map(e => `[${e.level}] ${e.message}`).join("\n")
            : "none";

        const corrections = await loadSelectorCorrections();
        const correctionsText = corrections.length > 0
            ? corrections.map(c => `- ${c.tag} (hits: ${c.hits}, discovered: ${c.discovered})`).join("\n")
            : "_none_";

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
            `## Selector Corrections`,
            ``,
            correctionsText,
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
    // On structural failure ([CRIT]), identifies container tag names by finding
    // known titles in the DOM and walking up to the YTD-* child of div#contents.
    //
    // Two beacon sources:
    //   Normal path  — nuke log: confirmed-rendered titles from prior nukes.
    //   Cold start   — synthetic: h3s currently visible in the DOM that resolve
    //                  to a YTD-* child of div#contents via the same heuristic
    //                  used by findVideoContainerFromElement. No prior nuke
    //                  history required; the structural filter provides the same
    //                  quality guarantee as nuke log confirmation.
    //
    // Validation before committing a correction:
    //   - Tag name starts with "YTD-"
    //   - Not already in CONTAINER_TAGS_BASELINE
    //   - ≥2 independent beacons confirmed the tag as pivot
    //
    // Failure modes:
    //   Bad pivot persisted    → health check re-runs next page load and
    //                            re-evaluates; hardcoded baseline continues
    //   No beacons found       → no correction attempted; CRIT remains in HUD
    //   YouTube reverts rename → old tag reappears; baseline already covers it
    //   Storage cleared        → cold start; baseline takes over immediately

    async function runAnchorSearch() {
        const anchors = await loadNukeLog();
        const isColdStart = anchors.length === 0;

        setTimeout(async () => {
            const candidates = new Map(); // tag → beacon count
            let beaconCount  = 0;

            if (isColdStart) {
                // Synthesize beacons from h3s currently visible in the DOM.
                // Only h3s whose parent chain contains a YTD-* child of div#contents
                // are counted — this is the same structural filter used by
                // findVideoContainerFromElement, so it only matches real video cards.
                document.querySelectorAll("h3").forEach(h3 => {
                    const title = h3.textContent?.trim();
                    if (!title || title.length < 3) return;
                    let node = h3.parentElement;
                    while (node && node !== document.body) {
                        if (node.tagName?.startsWith("YTD-") && node.parentElement?.id === "contents") {
                            candidates.set(node.tagName, (candidates.get(node.tagName) || 0) + 1);
                            beaconCount++;
                            break;
                        }
                        node = node.parentElement;
                    }
                });
                console.log(`[YT-PURGE] Anchor search (cold start): ${beaconCount} synthetic beacons`);
                if (beaconCount < 2) {
                    logToHUD("WARN", `Cold start anchor search inconclusive — only ${beaconCount} synthetic beacon(s) found`);
                    return;
                }
            } else {
                // Normal path: search DOM for confirmed-nuked titles as beacons.
                const allText = document.querySelectorAll("h3, yt-formatted-string, span");
                const found   = [];

                anchors.forEach(anchor => {
                    const anchorLabel = typeof anchor === "string" ? anchor : anchor.label;
                    for (const el of allText) {
                        if (el.textContent?.trim() === anchorLabel) {
                            found.push(anchor);
                            let node = el.parentElement;
                            while (node && node !== document.body) {
                                if (node.tagName?.startsWith("YTD-") && node.parentElement?.id === "contents") {
                                    candidates.set(node.tagName, (candidates.get(node.tagName) || 0) + 1);
                                    break;
                                }
                                node = node.parentElement;
                            }
                            break;
                        }
                    }
                });

                beaconCount = found.length;
                console.log(`[YT-PURGE] Anchor search: ${found.length}/${anchors.length} anchors found`);
                if (found.length < 2) {
                    logToHUD("WARN", `Anchor search inconclusive — only ${found.length}/${anchors.length} anchors found`);
                    return;
                }
            }

            if (!candidates.size) {
                logToHUD("CRIT", "Pivot failed — no YTD container found in parent chain");
                return;
            }

            let recovered = false;

            for (const [tag, count] of candidates) {
                const isKnown = CONTAINER_TAGS_BASELINE.has(tag) || activeContainerTags.has(tag);
                if (isKnown) {
                    logToHUD("INFO", `Pivot confirmed known container: <${tag.toLowerCase()}> (${count} beacons)`);
                    console.log(`[YT-PURGE] Pivot confirmed known: ${tag} (${count} beacons)`);
                    continue;
                }

                if (!tag.startsWith("YTD-")) {
                    logToHUD("WARN", `Pivot candidate rejected — not a YTD element: <${tag.toLowerCase()}>`);
                    continue;
                }

                if (count < 2) {
                    logToHUD("WARN", `Pivot candidate below threshold: <${tag.toLowerCase()}> (${count} beacon)`);
                    continue;
                }

                await commitCorrection(tag);
                logToHUD("WARN", `Self-healed: <${tag.toLowerCase()}> (${count} beacons) — reattaching observer`);
                console.log(`[YT-PURGE] Self-heal: committed ${tag}, reattaching observer`);
                recovered = true;
            }

            captureAndDownloadDOM("anchor-search");

            if (recovered) {
                requestAnimationFrame(() => {
                    if (attachNarrowObserver()) {
                        logToHUD("INFO", "Observer reattached after self-heal");
                        processPage();
                    } else {
                        logToHUD("CRIT", "Observer reattach failed after self-heal — check DOM structure");
                    }
                });
            }

        }, 500);
    }

    // ── PRIMARY OBSERVER ─────────────────────────────────────────────────
    const ACTIVE_BROWSE_RENDERER_SELECTOR =
        "ytd-page-manager > *:not([hidden]) ytd-two-column-browse-results-renderer";

    let observer = null;
    let currentBrowseTarget = null;

    function attachNarrowObserver() {
        const target = document.querySelector(ACTIVE_BROWSE_RENDERER_SELECTOR);
        if (!target) return false;
        if (observer) observer.disconnect();
        currentBrowseTarget = target;
        observer = new MutationObserver(schedulePage);
        observer.observe(target, { childList: true, subtree: true });
        return true;
    }

    let booted    = false;
    let booting   = false;
    let sessionId = 0;

    function createUIOnce() {
        if (!hudHost)   hudHost   = createHUD();
        if (!panelHost) panelHost = createWordPanel();
    }

    function injectUIIfNeeded() {
        if (!filteringActive()) return;
        createUIOnce();
        if (!document.documentElement.contains(hudHost))
            document.documentElement.appendChild(hudHost);
        if (!document.documentElement.contains(panelHost))
            document.documentElement.appendChild(panelHost);
    }

    function bootOnce() {
        if (booting || booted || !filteringActive()) return;
        booting = true;

        injectUIIfNeeded();
        console.log(`[YT-PURGE] v3.9 booting. Context: ${getPageContext()}. Custom phrases: ${customPhrases.length}. Active tags: ${activeContainerTags.size}.`);

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
                // Retained as resilience measure. Activation is always [CRIT].
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

    async function init() {
        await buildActiveTagSet();
        customPhrases = await loadPhrases();

        window.addEventListener("yt-navigate-finish", () => {
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

        const waitForBody = () => {
            if (!document.body) { setTimeout(waitForBody, 10); return; }
            bootOnce();
        };
        waitForBody();
    }

    init();
})();
