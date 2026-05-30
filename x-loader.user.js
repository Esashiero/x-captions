// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      2.0
// @description  AI captions for X videos using Mistral Voxtral, fully automatic.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @downloadURL  https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @updateURL    https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    var CAPTION_SERVER = 'http://127.0.0.1:9876';

    var CC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186zm7.602 0c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"></path></g></svg>';

    var captionsData = null;
    var captionInterval = null;
    var currentJobId = null;

    function makeBtn() {
        var wrapper = document.createElement('div');
        wrapper.className = 'css-175oi2r';
        wrapper.setAttribute('data-x-feature', 'ai-captions');
        wrapper.setAttribute('data-active', 'false');

        var btn = document.createElement('button');
        btn.setAttribute('aria-label', 'AI Captions');
        btn.setAttribute('role', 'button');
        btn.className = 'css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        btn.style.cssText = 'background-color:rgba(0,0,0,0);border-color:rgba(0,0,0,0);opacity:0.5;';

        var inner = document.createElement('div');
        inner.dir = 'ltr';
        inner.className = 'css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        inner.style.cssText = 'color:rgb(255,255,255);';
        inner.innerHTML = CC_SVG;

        btn.appendChild(inner);
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleCaptions(wrapper);
        });
        wrapper.appendChild(btn);
        return wrapper;
    }

    function getTweetUrl() {
        var canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) return canonical.href;
        return window.location.href.split('?')[0].split('#')[0];
    }

    function getVideoElement(wrapper) {
        var player = wrapper.closest('[data-testid="videoPlayer"]');
        if (!player) return null;
        return player.querySelector('video');
    }

    function toggleCaptions(wrapper) {
        var active = wrapper.getAttribute('data-active') === 'true';
        if (active) {
            deactivate(wrapper);
            return;
        }
        activate(wrapper);
    }

    function deactivate(wrapper) {
        wrapper.setAttribute('data-active', 'false');
        wrapper.querySelector('button').style.opacity = '0.5';
        hideOverlay(wrapper);
        if (captionInterval) { clearInterval(captionInterval); captionInterval = null; }
    }

    function activate(wrapper) {
        wrapper.setAttribute('data-active', 'true');
        wrapper.querySelector('button').style.opacity = '1';

        // Already have captions loaded?
        if (captionsData) {
            startCaptionDisplay(wrapper);
            return;
        }

        // Check if the video has native captions embedded
        var video = getVideoElement(wrapper);
        if (video && video.textTracks && video.textTracks.length > 0) {
            showStatus(wrapper, 'Native captions available');
            return;
        }

        // Start transcription
        var tweetUrl = getTweetUrl();
        showStatus(wrapper, 'Transcribing...');
        console.log('[X Captions] Requesting transcription for:', tweetUrl);

        GM_xmlhttpRequest({
            method: 'POST',
            url: CAPTION_SERVER + '/captions',
            data: JSON.stringify({url: tweetUrl}),
            headers: {'Content-Type': 'application/json'},
            onload: function(r) {
                try {
                    var resp = JSON.parse(r.responseText);
                    currentJobId = resp.job_id;
                    console.log('[X Captions] Job started:', currentJobId);
                    pollJob(wrapper, currentJobId);
                } catch(e) {
                    showStatus(wrapper, 'Server error');
                    console.error('[X Captions] Parse error:', e);
                }
            },
            onerror: function() {
                showStatus(wrapper, 'Server unavailable');
                console.error('[X Captions] Cannot reach caption server');
            }
        });
    }

    function pollJob(wrapper, jobId) {
        var attempts = 0;
        function poll() {
            if (wrapper.getAttribute('data-active') !== 'true') return;
            attempts++;
            GM_xmlhttpRequest({
                method: 'POST',
                url: CAPTION_SERVER + '/status',
                data: JSON.stringify({job_id: jobId}),
                headers: {'Content-Type': 'application/json'},
                onload: function(r) {
                    if (wrapper.getAttribute('data-active') !== 'true') return;
                    try {
                        var resp = JSON.parse(r.responseText);
                        if (resp.status === 'done') {
                            captionsData = resp.segments;
                            console.log('[X Captions] Got ' + captionsData.length + ' segments');
                            hideOverlay(wrapper);
                            startCaptionDisplay(wrapper);
                        } else if (resp.status === 'error') {
                            showStatus(wrapper, 'Error: ' + (resp.error || 'unknown'));
                        } else {
                            showStatus(wrapper, 'Transcribing... (' + attempts + 's)');
                            if (attempts < 180) setTimeout(poll, 1000);
                            else showStatus(wrapper, 'Timed out');
                        }
                    } catch(e) {
                        if (attempts < 5) setTimeout(poll, 1000);
                    }
                },
                onerror: function() {
                    if (attempts < 5) setTimeout(poll, 1000);
                }
            });
        }
        setTimeout(poll, 1000);
    }

    function showStatus(wrapper, msg) {
        hideOverlay(wrapper);
        var player = wrapper.closest('[data-testid="videoPlayer"]');
        if (!player) return;
        var overlay = document.createElement('div');
        overlay.setAttribute('data-x-feature', 'caption-overlay');
        overlay.style.cssText = 'position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var text = document.createElement('div');
        text.style.cssText = 'display:inline-block;background:rgba(0,0,0,0.75);color:white;padding:6px 14px;border-radius:6px;font:14px/1.4 sans-serif;max-width:80%;';
        text.textContent = msg;
        overlay.appendChild(text);
        var vc = player.querySelector('[data-testid="videoComponent"]');
        if (vc) vc.appendChild(overlay);
    }

    function startCaptionDisplay(wrapper) {
        hideOverlay(wrapper);
        if (!captionsData) return;

        var player = wrapper.closest('[data-testid="videoPlayer"]');
        if (!player) return;
        var video = player.querySelector('video');
        if (!video) return;

        var overlay = document.createElement('div');
        overlay.setAttribute('data-x-feature', 'caption-overlay');
        overlay.style.cssText = 'position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';

        var text = document.createElement('div');
        text.style.cssText = 'display:inline-block;background:rgba(0,0,0,0.85);color:white;padding:8px 16px;border-radius:6px;font:15px/1.5 sans-serif;max-width:85%;text-align:center;';
        text.id = 'caption-text';
        overlay.appendChild(text);

        var vc = player.querySelector('[data-testid="videoComponent"]');
        if (vc) vc.appendChild(overlay);

        if (captionInterval) clearInterval(captionInterval);
        captionInterval = setInterval(function() {
            if (!video) return;
            var t = video.currentTime;
            var found = '';
            for (var i = 0; i < captionsData.length; i++) {
                if (t >= captionsData[i].start && t < captionsData[i].end) {
                    found = captionsData[i].text;
                    break;
                }
            }
            text.textContent = found;
        }, 200);
    }

    function hideOverlay(wrapper) {
        var player = wrapper.closest('[data-testid="videoPlayer"]');
        if (!player) return;
        var els = player.querySelectorAll('[data-x-feature="caption-overlay"]');
        for (var i = 0; i < els.length; i++) els[i].remove();
    }

    function processPlayer(player) {
        if (player.querySelector('[data-x-feature="ai-captions"]')) return;
        if (player.querySelector('[data-testid="captions"]')) return;

        var unmute = player.querySelector('[aria-label="Unmute"]') || player.querySelector('[aria-label="Mute"]');
        if (!unmute) return;

        var btnWrapper = unmute.parentElement;
        if (!btnWrapper) return;
        var controlsBar = btnWrapper.parentElement;
        if (!controlsBar) return;

        controlsBar.insertBefore(makeBtn(), btnWrapper);
    }

    var retries = 0;
    function tryProcess() {
        var ps = document.querySelectorAll('[data-testid="videoPlayer"]');
        var ok = false;
        for (var i = 0; i < ps.length; i++) {
            processPlayer(ps[i]);
            if (ps[i].querySelector('[data-x-feature="ai-captions"]')) ok = true;
        }
        if (!ok && retries < 40) {
            retries++;
            setTimeout(tryProcess, 500);
        } else {
            console.log('[X Captions] ' + (ok ? 'Active after ' + retries + ' retries' : 'No players'));
        }
    }

    function init() {
        console.log('[X Captions] Starting...');
        new MutationObserver(function() {
            var ps = document.querySelectorAll('[data-testid="videoPlayer"]');
            for (var i = 0; i < ps.length; i++) processPlayer(ps[i]);
        }).observe(document.body, { childList: true, subtree: true });
        tryProcess();
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();
})();
