// ==UserScript==
// @name         YouTube Tuner
// @version      3.1
// @description  Hide low‑quality YouTube recommendations (phrases + caps). Watched detection removed due to shadow DOM restrictions.
// @author       Anonymous
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * v3.1 changes from v3.0:
 * - Close button now collapses the log pane rather than hiding the host element.
 *   Hiding the host was silently interrupting DOM writes and likely killing the
 *   observer's ability to report. Host stays in the document at all times.
 * - Button label toggles between ▲ (collapse) and ▼ (expand) to reflect state.
 * - All filtering logic unchanged from v3.0.
 */

(function() {
    "use strict";

    const CONFIG = {
        clickbait: /SIMULATOR|CARTMAN|OMG|BADASS|MINECRAFT|CHESS|UNALIVE|INSANE|COPS|SECRET|GONE WRONG|RUINED MY LIFE|LIFE\.\.\.|BREAKS REALITY|CARTMAN/i,
        grammarSlop: /\b(dont|doesnt|shes|cant|ive|wont|im|didnt|couldnt|shouldnt|isnt|wasnt|arent)\b/i,
        capsThreshold: 0.5,
        minTitleLength: 10,
        logLimit: 200
    };

    let hudHost = null;
    let nukeCountSpan = null;
    let logPipeDiv = null;
    let nukeCount = 0;

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
        `;
        const titleArea = document.createElement("div");
        titleArea.style.cssText = "display: flex; flex-direction: column;";
        const mainTitle = document.createElement("span");
        mainTitle.textContent = "☢️ YT PURGE v3.1";
        mainTitle.style.cssText = "font-size: 13px; font-weight: 800; color: #ff4757;";
        const countRow = document.createElement("div");
        countRow.style.cssText = "font-size: 10px; color: #888; margin-top: 2px;";
        countRow.textContent = "NUKED: ";
        nukeCountSpan = document.createElement("span");
        nukeCountSpan.textContent = "0";
        countRow.appendChild(nukeCountSpan);
        titleArea.appendChild(mainTitle);
        titleArea.appendChild(countRow);

        // Collapse/expand button — never hides the host, only the log pane
        const collapseBtn = document.createElement("span");
        collapseBtn.textContent = "▲";
        collapseBtn.title = "Collapse log";
        collapseBtn.style.cssText = "cursor: pointer; font-size: 14px; color: #555; line-height: 1;";
        collapseBtn.addEventListener("click", () => {
            const collapsed = logPipeDiv.style.display === "none";
            logPipeDiv.style.display = collapsed ? "block" : "none";
            collapseBtn.textContent = collapsed ? "▲" : "▼";
            collapseBtn.title = collapsed ? "Collapse log" : "Expand log";
            // Shrink host when collapsed so it's just a title bar
            host.style.height = collapsed ? "500px" : "42px";
        });

        header.appendChild(titleArea);
        header.appendChild(collapseBtn);

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
            host.style.top = (e.clientY - offsetY) + "px";
            host.style.right = "auto";
        });
        document.addEventListener("mouseup", () => { isDragging = false; });
        return host;
    }

    function logToHUD(reason, title) {
        nukeCount++;
        if (nukeCountSpan) nukeCountSpan.textContent = nukeCount;
        if (!logPipeDiv) return;
        const entry = document.createElement("div");
        entry.style.cssText = "margin-bottom: 5px; border-bottom: 1px solid #111; padding-bottom: 4px; display: flex; gap: 6px; flex-wrap: wrap;";
        const tag = document.createElement("span");
        tag.style.cssText = "color: #ff4757; font-weight: 700;";
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

    function processPage() {
        const titles = document.querySelectorAll("h3");
        if (titles.length === 0) return;

        titles.forEach(h3 => {
            const title = h3.textContent?.trim();
            if (!title || title.length < 3) return;

            const container = findVideoContainerFromElement(h3);
            if (!container || container.dataset.ytPurgeProcessed) return;
            container.dataset.ytPurgeProcessed = "1";

            let reason = null;
            if (CONFIG.clickbait.test(title)) reason = "PHRASE";
            else if (CONFIG.grammarSlop.test(title)) reason = "SLOP";
            else {
                const letters = title.replace(/[^a-zA-Z]/g, "");
                if (letters.length > CONFIG.minTitleLength) {
                    const upperCount = letters.replace(/[^A-Z]/g, "").length;
                    const ratio = upperCount / letters.length;
                    if (ratio >= CONFIG.capsThreshold) reason = "CAPS";
                }
            }
            if (reason) {
                logToHUD(reason, title);
                container.style.setProperty("display", "none", "important");
            }
        });
    }

    let observer = null;
    function init() {
        hudHost = createHUD();
        document.documentElement.appendChild(hudHost);
        const waitForBody = () => {
            if (document.body) {
                observer = new MutationObserver(() => processPage());
                observer.observe(document.body, { childList: true, subtree: true });
                processPage();
                console.log("[YT-PURGE] v3.1 active – phrase + caps filtering only");
            } else {
                setTimeout(waitForBody, 10);
            }
        };
        waitForBody();
        const htmlObserver = new MutationObserver(() => {
            if (!document.documentElement.contains(hudHost)) {
                document.documentElement.appendChild(hudHost);
            }
        });
        htmlObserver.observe(document.documentElement, { childList: true });
    }
    init();
})();
