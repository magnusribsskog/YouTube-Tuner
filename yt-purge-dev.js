// ==UserScript==
// @name         YouTube Purge v3.6
// @version      3.6
// @description  Stable release. Static + dedup filtering with word panel controls.
// @author       Anonymous
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * v3.6 changes from v3.5:
 * - Removed personal/overly-broad terms from CONFIG.clickbait:
 *   SIMULATOR, CARTMAN, MINECRAFT, CHESS, LIFE, LIFE...
 *   Remaining built-in phrases: OMG, BADASS, UNALIVE, INSANE, COPS, SECRET,
 *   GONE WRONG, RUINED MY LIFE, BREAKS REALITY
 *   Removed terms belong in each user's custom phrase list via the word panel.
 * - Added HUD warnings when channel name selectors all return null.
 *   Warns once per container tag type to avoid flooding — amber [WARN] entries
 *   in the log indicate YouTube has changed its DOM in a way that breaks dedup.
 * - WARN entries are amber (#ffa502) and do not increment the nuke counter.
 * - All v3.5 behaviours retained unchanged.
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
        grammarSlop:    /\b(dont|doesnt|shes|cant|ive|wont|im|didnt|couldnt|shouldnt|isnt|wasnt|arent)\b/i,
        clickbait:      /OMG|BADASS|UNALIVE|INSANE|COPS|SECRET|GONE WRONG|RUINED MY LIFE|BREAKS REALITY/i,
        capsThreshold:  0.5,
        minTitleLength: 10,
        logLimit:       200,
        PHRASES_KEY:    "yt-purge-phrases",
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
        SLOP:   { enabled: true, count: 0, label: "Grammar slop" },
        CAPS:   { enabled: true, count: 0, label: "Excessive caps" },
        PHRASE: { enabled: true, count: 0, label: "Phrase / custom list" },
        DUPE:   { enabled: true, count: 0, label: "Channel duplicate" },
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
        mainTitle.textContent = "☢️ YouTube Purge v3.6";
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
        if (!isWarn) {
            nukeCount++;
            if (nukeCountSpan) nukeCountSpan.textContent = nukeCount;
        }
        if (!logPipeDiv) return;
        const entry = document.createElement("div");
        entry.style.cssText = "margin-bottom: 5px; border-bottom: 1px solid #111; padding-bottom: 4px; display: flex; gap: 6px; flex-wrap: wrap;";
        const tag = document.createElement("span");
        tag.style.cssText = `color: ${isWarn ? "#ffa502" : "#ff4757"}; font-weight: 700;`;
        tag.textContent = `[${reason}]`;
        const msg = document.createElement("span");
        msg.style.cssText = "color: #ccc;";
        msg.textContent = title || "";
        entry.appendChild(tag);
        entry.appendChild(msg);
        logPipeDiv.prepend(entry);
        while (logPipeDiv.children.length > CONFIG.logLimit) {
            logPipeDiv.removeChild(logPipeDiv.lastChild);
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
    function getChannelName(container) {
        const candidates = [
            container.querySelector("ytd-channel-name #text"),
            container.querySelector("#channel-name #text"),
            container.querySelector("#channel-name"),
            container.querySelector("ytd-channel-name"),
            container.querySelector(".ytd-channel-name"),
        ];
        for (const el of candidates) {
            const name = el?.textContent?.trim();
            if (name) return name.toLowerCase();
        }
        // All channel name selectors failed — YouTube may have changed its DOM.
        // Log once per container tag type to avoid flooding the HUD.
        const tag = container.tagName || "UNKNOWN";
        if (!getChannelName._warned) getChannelName._warned = new Set();
        if (!getChannelName._warned.has(tag)) {
            getChannelName._warned.add(tag);
            logToHUD("WARN", `channel selector failed on <${tag.toLowerCase()}>`);
        }
        return null;
    }

    // ======================== NUKE HELPER ========================
    function nuke(container, reason, label) {
        const h = heuristics[reason];
        if (h) {
            h.count++;
            if (h.countEl) h.countEl.textContent = `caught: ${h.count}`;
        }
        logToHUD(reason, label);
        container.style.setProperty("display", "none", "important");
    }

    // ======================== PROCESSING ========================
    function processPage() {
        if (!filteringActive()) return;

        const titles = document.querySelectorAll("h3");
        if (titles.length === 0) return;

        const channelSeen = new Map();

        titles.forEach(h3 => {
            const title = h3.textContent?.trim();
            if (!title || title.length < 3) return;

            const container = findVideoContainerFromElement(h3);
            if (!container || container.dataset.ytPurgeProcessed) return;
            container.dataset.ytPurgeProcessed = "1";

            // ── Channel dedup ────────────────────────────────────────────────
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

    let observer = null;
    function init() {
        hudHost   = createHUD();
        panelHost = createWordPanel();
        document.documentElement.appendChild(hudHost);
        document.documentElement.appendChild(panelHost);

        const waitForBody = () => {
            if (document.body) {
                observer = new MutationObserver(schedulePage);
                observer.observe(document.body, { childList: true, subtree: true });
                processPage();
                console.log(`[YT-PURGE] v3.6 active. Context: ${getPageContext()}. Custom phrases: ${customPhrases.length}`);
            } else {
                setTimeout(waitForBody, 10);
            }
        };
        waitForBody();

        const htmlObserver = new MutationObserver(() => {
            if (!document.documentElement.contains(hudHost)) {
                document.documentElement.appendChild(hudHost);
            }
            if (!document.documentElement.contains(panelHost)) {
                document.documentElement.appendChild(panelHost);
            }
        });
        htmlObserver.observe(document.documentElement, { childList: true });
    }

    init();
})();
