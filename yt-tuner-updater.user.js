// ==UserScript==
// @name         YouTube-Tuner Updater
// @version      1.0
// @description  Fetches latest YouTube Tuner from dev branch and writes to localStorage
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function() {
    'use strict';
    const STORAGE_KEY = 'yt-tuner-code';
    const SCRIPT_URL  = 'https://raw.githubusercontent.com/magnusribsskog/YouTube-Tuner/dev/YouTube-Tuner-3.8.js';

    GM_xmlhttpRequest({
        method: "GET",
        url: SCRIPT_URL,
        onload: function(r) {
            if (r.status === 200 && r.responseText.length > 0) {
                localStorage.setItem(STORAGE_KEY, r.responseText);
                console.log("[Updater] localStorage updated");
            } else {
                console.warn("[Updater] Fetch returned unexpected status:", r.status);
            }
        },
        onerror: function(e) {
            console.error("[Updater] Fetch failed", e);
        }
    });
})();
