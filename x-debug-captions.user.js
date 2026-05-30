// ==UserScript==
// @name         X Captions Debug — Hardcoded test captions
// @namespace    local.x-features
// @version      0.1
// @description  Injects hardcoded captions after 3s to test the display overlay. Remove after testing.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Hardcoded test captions — 16 segments matching the 80s Zakharova video
    var TEST_CAPTIONS = [
        {start: 0.8,  end: 3.9,   text: "Japanese TV company, my name is Watanabe, thank you."},
        {start: 4.6,  end: 7.2,   text: "I have a question about Japanese-Russian relations."},
        {start: 7.7,  end: 10.6,  text: "I have a question for you: why didn't you go to Starobelsk?"},
        {start: 10.9, end: 14.7,  text: "Why didn't any Japanese journalist go to Starobelsk?"},
        {start: 15.2, end: 19.7,  text: "Did you write your reports, did you write articles about what happened there?"},
        {start: 20.0, end: 22.1,  text: "If you didn't write them, don't ask me questions."},
        {start: 22.1, end: 25.9,  text: "I mainly make video news reports."},
        {start: 26.0, end: 27.5,  text: "Why didn't you go?"},
        {start: 27.9, end: 39.3,  text: "What kind of relations between our countries are you interested in if you're not interested in how the Kyiv regime, with Tokyo's support, is killing children?"},
        {start: 39.4, end: 41.7,  text: "What kind of relations can you even talk about?"},
        {start: 41.8, end: 47.3,  text: "Do you think we can build relations with Tokyo given such an attitude toward our people?"},
        {start: 48.0, end: 50.0,  text: "You are very much mistaken."},
        {start: 50.2, end: 52.3,  text: "And please convey this to your capital."},
        {start: 53.0, end: 60.7,  text: "And, by the way, if Japanese journalists do have any conscience left,"},
        {start: 60.7, end: 68.7,  text: "I think we'll find a way for them to have some separate familiarization visit."},
        {start: 68.8, end: 80.2,  text: "But, once again, this is not just outrageous — it's a disgrace and a shame that we saw a collective refusal from Japanese journalists to visit the site of the tragedy."}
    ];

    var interval = null;

    function showCaptions(video, captionsData) {
        // Find the video player container
        var player = video.closest('[data-testid="videoPlayer"]');
        if (!player) { console.log('[Debug] No player'); return; }

        // Remove existing overlay
        var old = player.querySelector('[data-x-feature="caption-overlay"]');
        if (old) old.remove();

        // Create overlay
        var overlay = document.createElement('div');
        overlay.setAttribute('data-x-feature', 'caption-overlay');
        overlay.style.cssText = 'position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';

        var text = document.createElement('div');
        text.id = 'debug-caption-text';
        text.style.cssText = 'display:inline-block;background:rgba(0,0,0,0.85);color:#00ff00;padding:8px 16px;border-radius:6px;font:bold 16px/1.5 sans-serif;max-width:85%;text-align:center;border:2px solid #00ff00;';
        text.textContent = 'DEBUG: waiting...';
        overlay.appendChild(text);

        var vc = player.querySelector('[data-testid="videoComponent"]');
        if (vc) vc.appendChild(overlay);
        console.log('[Debug] Overlay created');

        // Update captions in sync with video
        if (interval) clearInterval(interval);
        interval = setInterval(function() {
            var t = video.currentTime;
            var found = '';
            for (var i = 0; i < captionsData.length; i++) {
                if (t >= captionsData[i].start && t < captionsData[i].end) {
                    found = '(' + t.toFixed(1) + 's) ' + captionsData[i].text;
                    break;
                }
            }
            text.textContent = found || '(no caption at ' + t.toFixed(1) + 's)';
        }, 100);
        console.log('[Debug] Interval started, ' + captionsData.length + ' segments');
    }

    function init() {
        console.log('[Debug] Starting — will inject test captions in 3s');

        // Wait 3s for the page to settle, then find a video and inject
        setTimeout(function() {
            var video = document.querySelector('[data-testid="videoPlayer"] video');
            if (video) {
                console.log('[Debug] Found video, injecting test captions');
                showCaptions(video, TEST_CAPTIONS);
            } else {
                console.log('[Debug] No video found after 3s, retrying...');
                setTimeout(function() {
                    var video2 = document.querySelector('[data-testid="videoPlayer"] video');
                    if (video2) {
                        console.log('[Debug] Found video on retry');
                        showCaptions(video2, TEST_CAPTIONS);
                    } else {
                        console.log('[Debug] Still no video');
                    }
                }, 5000);
            }
        }, 3000);
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();
})();
