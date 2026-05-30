// ==UserScript==
// @name         X.com AI Captions (Browser-Only)
// @namespace    local.x-features
// @version      3.0
// @description  AI captions for X videos via Mistral Voxtral — no server needed.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      api.mistral.ai
// @connect      video.twimg.com
// @downloadURL  https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @updateURL    https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ── CONFIG ────────────────────────────────────────────
    var MISTRAL_API_KEY = '';  // <-- PASTE YOUR MISTRAL API KEY HERE
    var MISTRAL_MODEL = 'voxtral-mini-latest';

    // ── STATE ─────────────────────────────────────────────
    var captionsData = null;   // [{start, end, text}, ...]
    var captionInterval = null;
    var isTranscribing = false;

    // ── SVG ICON ──────────────────────────────────────────
    var CC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186zm7.602 0c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"></path></g></svg>';

    // ── UI ────────────────────────────────────────────────
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
        if (!MISTRAL_API_KEY) {
            showStatus('Set MISTRAL_API_KEY in script');
            return;
        }

        w.setAttribute('data-active', 'true');
        var btn = w.querySelector('button');
        if (btn) btn.style.opacity = '1';

        // Already have captions cached?
        if (captionsData) { startCaptionDisplay(); return; }
        if (isTranscribing) { showStatus('Transcribing...'); return; }

        // Extract video URL from the tweet page or video element
        var videoUrl = getVideoUrl();
        if (!videoUrl) {
            showStatus('No video URL found');
            console.log('[X] Failed to extract video URL');
            return;
        }
        console.log('[X] Video URL:', videoUrl);

        showStatus('Transcribing...');
        isTranscribing = true;
        transcribe(videoUrl, w);
    }

    // ── VIDEO URL EXTRACTION ─────────────────────────────
    function getVideoUrl() {
        // Method 1: From the video element's src
        var video = document.querySelector('[data-testid="videoPlayer"] video');
        if (video && video.currentSrc) return video.currentSrc;
        if (video && video.src && video.src !== location.href) return video.src;

        // Method 2: From tweet data embedded in the page
        // X.com embeds tweet data in a script with type "application/ld+json" or __NEXT_DATA__
        try {
            // Try JSON-LD first
            var ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (var i = 0; i < ldScripts.length; i++) {
                var data = JSON.parse(ldScripts[i].textContent);
                if (data && data.video && data.video.contentUrl) {
                    return data.video.contentUrl;
                }
            }
        } catch(e) { /* ignore */ }

        // Method 3: Try __NEXT_DATA__ (Next.js)
        try {
            var nextData = document.getElementById('__NEXT_DATA__');
            if (nextData) {
                var parsed = JSON.parse(nextData.textContent);
                // Navigate the props tree to find video info
                var props = parsed.props || {};
                var pageProps = props.pageProps || {};
                var tweet = pageProps.tweet || pageProps.status || {};
                var media = tweet.media || tweet.extended_entities?.media || [];
                for (var i = 0; i < media.length; i++) {
                    if (media[i].type === 'video' || media[i].type === 'animated_gif') {
                        var variants = media[i].video_info?.variants || [];
                        // Pick the highest bitrate MP4
                        var best = null;
                        for (var j = 0; j < variants.length; j++) {
                            if (variants[j].content_type === 'video/mp4' &&
                                (!best || variants[j].bitrate > best.bitrate)) {
                                best = variants[j];
                            }
                        }
                        if (best) return best.url;
                    }
                }
            }
        } catch(e) { /* ignore */ }

        // Method 4: From the page's canonical URL (we have the tweet URL, fetch the API from browser)
        // This is a last resort — the video element should already have the URL
        return null;
    }

    // ── MISTRAL TRANSCRIPTION ────────────────────────────
    function transcribe(videoUrl, btnWrapper) {
        // Build multipart form-data manually (GM_xmlhttpRequest doesn't support FormData)
        var boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

        var parts = [];
        function addField(name, value) {
            parts.push('--' + boundary);
            parts.push('Content-Disposition: form-data; name="' + name + '"');
            parts.push('');
            parts.push(String(value));
        }

        addField('model', MISTRAL_MODEL);
        addField('file_url', videoUrl);
        addField('timestamp_granularities', 'segment');

        parts.push('--' + boundary + '--');
        var body = parts.join('\r\n');

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://api.mistral.ai/v1/audio/transcriptions',
            headers: {
                'Authorization': 'Bearer ' + MISTRAL_API_KEY,
                'Content-Type': 'multipart/form-data; boundary=' + boundary
            },
            data: body,
            onload: function(r) {
                isTranscribing = false;
                try {
                    var resp = JSON.parse(r.responseText);
                    console.log('[X] Mistral response:', resp);

                    if (resp.segments && resp.segments.length > 0) {
                        // Map Mistral segments: {start, end, text}
                        captionsData = resp.segments.map(function(s) {
                            return {
                                start: s.start,
                                end: s.end,
                                text: s.text.trim()
                            };
                        });
                        console.log('[X] Got', captionsData.length, 'segments');
                        hideOverlay();
                        startCaptionDisplay();
                    } else if (resp.text) {
                        // No segments but has text — create a single segment
                        // Estimate duration from usage or use a default
                        var duration = resp.usage ? (resp.usage.prompt_audio_seconds || 60) : 60;
                        captionsData = [{start: 0, end: duration, text: resp.text.trim()}];
                        hideOverlay();
                        startCaptionDisplay();
                    } else if (resp.error || resp.message) {
                        showStatus('API Error');
                        console.error('[X] Mistral error:', resp);
                    } else {
                        showStatus('Empty response');
                        console.error('[X] Unexpected response:', resp);
                    }
                } catch(e) {
                    showStatus('Parse error');
                    console.error('[X] Parse error:', e, r.responseText.slice(0, 300));
                }
            },
            onerror: function() {
                isTranscribing = false;
                showStatus('API unreachable');
                console.error('[X] Mistral API unreachable');
            },
            ontimeout: function() {
                isTranscribing = false;
                showStatus('API timeout');
                console.error('[X] Mistral API timeout');
            }
        });
    }

    // ── CAPTION DISPLAY ──────────────────────────────────
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

        // Show first caption immediately if video is playing
        var c = v.currentTime;
        for (var i = 0; i < captionsData.length; i++) {
            if (c >= captionsData[i].start && c < captionsData[i].end) {
                t.textContent = captionsData[i].text; break;
            }
        }

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

    // ── PLAYER DETECTION ─────────────────────────────────
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
        console.log('[X] Start v3.0 (browser-only)');
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
