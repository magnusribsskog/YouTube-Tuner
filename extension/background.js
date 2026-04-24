/*
 * YouTube Tuner — Background Service Worker
 * =========================================
 *
 * Owns the thematic intelligence layer: title classification, local lookup
 * table, and master list sync. Communicates with the content script via
 * chrome.runtime.onMessage.
 *
 * Message contract:
 *   Request:  { type: "CLASSIFY_TITLE", title: string }
 *   Response: { theme: string[], format: string[], cached: boolean }
 *
 * The content script treats a null or absent response identically to
 * { theme: [], format: [], cached: false } — the thematic layer is additive
 * and its absence must never affect filtering behaviour.
 *
 * Implementation sequence (see docs/INTELLIGENCE.md):
 *   [x] Step 1 — Stub: receives messages, returns empty label arrays
 *   [ ] Step 2 — Diagnostic HUD panel wired to this worker
 *   [ ] Step 3 — Local LLM classification on cache miss
 *   [ ] Step 4 — Master list sync and polling protocol
 *   [ ] Step 5 — Density throttle (gated on validated taxonomy data)
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "CLASSIFY_TITLE") return false;
    console.log(`[YT-INTELLIGENCE] classify: "${message.title}"`);
    sendResponse({ theme: [], format: [], cached: false });
    return false;
});
