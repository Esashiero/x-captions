// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      2.2
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
    var captionsData = null;   // persists even if React wipes our DOM
    var activeJobId = null;    // current transcription job (survives re-renders)
    var captionInterval = null;

    var CC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186zm7.602 0c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"></path></g></svg>';

    function makeBtn() {
        var w = document.createElement('div');
        w.className = 'css-175oi2r';
        w.setAttribute('data-x-feature', 'ai-captions');
        w.setAttribute('data-active', 'false');

        var b = document.createElement('button');
        b.setAttribute('aria-label', 'AI Captions');
        b.setAttribute('role', 'button');
        b.className = 'css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        b.style.cssText = 'background-color:rgba(0,0,0,0);border-color:rgba(0,0,0,0);opacity:0.5;';

        var n = document.createElement('div');
        n.dir = 'ltr';
        n.className = 'css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        n.style.cssText = 'color:rgb(255,255,255);';
        n.innerHTML = CC_SVG;

        b.appendChild(n);
        b.addEventListener('click', function(e) {
            e.stopPropagation();
            handleClick(w);
        });
        w.appendChild(b);
        return w;
    }

    function getPlayer() {
        var w = document.querySelector('[data-x-feature="ai-captions"][data-active="true"]')
              || document.querySelector('[data-x-feature="ai-captions"]');
        if (!w) {
            var p = document.querySelector('[data-testid="videoPlayer"]');
            return p;
        }
        return w.closest('[data-testid="videoPlayer"]');
    }

    function handleClick(w) {
        var active = w.getAttribute('data-active') === 'true';
        if (active) { deactivate(w); return; }
        activate(w);
    }

    function deactivate(w) {
        w.setAttribute('data-active', 'false');
        var btn = w.querySelector('button');
        if (btn) btn.style.opacity = '0.5';
        hideOverlay();
        if (captionInterval) { clearInterval(captionInterval); captionInterval = null; }
    }

    function activate(w) {
        w.setAttribute('data-active', 'true');
        var btn = w.querySelector('button');
        if (btn) btn.style.opacity = '1';

        // Already have captions?
        if (captionsData) { startCaptionDisplay(); return; }

        // Already have a job running?
        if (activeJobId) { showStatus('Transcribing...'); return; }

        var tweetUrl = (document.querySelector('link[rel="canonical"]') || {}).href
                       || location.href.split('?')[0].split('#')[0];

        showStatus('Transcribing...');
        console.log('[X] Request:', tweetUrl);

        GM_xmlhttpRequest({
            method: 'POST',
            url: CAPTION_SERVER + '/captions',
            data: JSON.stringify({url: tweetUrl}),
            headers: {'Content-Type': 'application/json'},
            onload: function(r) {
                try {
                    var resp = JSON.parse(r.responseText);
                    activeJobId = resp.job_id;
                    console.log('[X] Job:', activeJobId);
                    startPolling();
                } catch(e) { console.error('[X] Parse:', e); }
            },
            onerror: function() { console.error('[X] Server unreachable'); }
        });
    }

    // ─── Poll uses global state, NOT DOM references ───
    function startPolling() {
        var attempts = 0;
        function poll() {
            attempts++;
            GM_xmlhttpRequest({
                method: 'POST',
                url: CAPTION_SERVER + '/status',
                data: JSON.stringify({job_id: activeJobId}),
                headers: {'Content-Type': 'application/json'},
                onload: function(r) {
                    try {
                        var resp = JSON.parse(r.responseText);
                        if (resp.status === 'done') {
                            captionsData = resp.segments;
                            activeJobId = null;
                            console.log('[X] Got ' + captionsData.length + ' segs');
                            hideOverlay();
                            startCaptionDisplay();
                        } else if (resp.status === 'error') {
                            showStatus('Error');
                            activeJobId = null;
                        } else {
                            showStatus('Transcribing... (' + attempts + 's)');
                            if (attempts < 180) setTimeout(poll, 1000);
                        }
                    } catch(e) { if (attempts < 5) setTimeout(poll, 1000); }
                },
                onerror: function() { if (attempts < 5) setTimeout(poll, 1000); }
            });
        }
        setTimeout(poll, 1000);
    }

    // ─── Overlay ───
    function showStatus(msg) {
        var p = getPlayer();
        if (!p) return;
        removeOverlays(p);
        var o = document.createElement('div');
        o.setAttribute('data-x-feature', 'caption-overlay');
        o.style.cssText = 'position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t = document.createElement('div');
        t.style.cssText = 'display:inline-block;background:rgba(0,0,0,0.75);color:white;padding:6px 14px;border-radius:6px;font:14px/1.4 sans-serif;max-width:80%;';
        t.textContent = msg;
        o.appendChild(t);
        var vc = p.querySelector('[data-testid="videoComponent"]');
        if (vc) vc.appendChild(o);
    }

    function startCaptionDisplay() {
        if (!captionsData) return;
        var p = getPlayer();
        if (!p) return;
        var v = p.querySelector('video');
        if (!v) { console.log('[X] No video'); return; }

        removeOverlays(p);
        var o = document.createElement('div');
        o.setAttribute('data-x-feature', 'caption-overlay');
        o.style.cssText = 'position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t = document.createElement('div');
        t.id = 'caption-text';
        t.style.cssText = 'display:inline-block;background:rgba(0,0,0,0.85);color:white;padding:8px 16px;border-radius:6px;font:15px/1.5 sans-serif;max-width:85%;text-align:center;';
        o.appendChild(t);
        var vc = p.querySelector('[data-testid="videoComponent"]');
        if (vc) vc.appendChild(o);

        if (captionInterval) clearInterval(captionInterval);
        captionInterval = setInterval(function() {
            if (!v) return;
            var c = v.currentTime;
            var f = '';
            for (var i = 0; i < captionsData.length; i++) {
                if (c >= captionsData[i].start && c < captionsData[i].end) {
                    f = captionsData[i].text; break;
                }
            }
            t.textContent = f;
        }, 200);
    }

    function hideOverlay() {
        var p = getPlayer();
        if (p) removeOverlays(p);
    }

    function removeOverlays(p) {
        var els = p.querySelectorAll('[data-x-feature="caption-overlay"]');
        for (var i = 0; i < els.length; i++) els[i].remove();
    }

    // ─── Player detection ───
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
        if (!ok && retries < 60) { retries++; setTimeout(tryProcess, 500); }
        else console.log('[X] ' + (ok ? 'OK ' + retries : 'No players'));
    }

    function init() {
        console.log('[X] Start v2.2');
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
