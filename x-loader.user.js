// ==UserScript==
// @name         X.com AI Captions (Browser-Only)
// @namespace    local.x-features
// @version      3.1
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
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ── CONFIG ────────────────────────────────────────────
    var MISTRAL_API_KEY = '';  // <-- PASTE YOUR MISTRAL API KEY HERE
    var MISTRAL_MODEL = 'voxtral-mini-latest';

    // ── STATE ─────────────────────────────────────────────
    var captionsData = null;
    var captionInterval = null;
    var isTranscribing = false;

    // ── HLS URL CATCHER ───────────────────────────────────
    // Intercept XHR requests for HLS playlists and cache the URL
    var _capturedMasterUrl = null;
    var _capturedAudioUrl = null;

    (function() {
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string') {
                // Master playlist
                if (url.indexOf('/pu/pl/') > 0 && url.indexOf('m3u8') > 0 && url.indexOf('mp4a') < 0 && url.indexOf('avc1') < 0) {
                    _capturedMasterUrl = url;
                }
                // Audio playlist
                if (url.indexOf('/pu/pl/mp4a/') > 0 && url.indexOf('.m3u8') > 0) {
                    _capturedAudioUrl = url;
                }
            }
            return origOpen.apply(this, arguments);
        };
    })();

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
            return document.querySelector('[data-testid="videoPlayer"]');
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

        if (captionsData) { startCaptionDisplay(); return; }
        if (isTranscribing) { showStatus('Transcribing...'); return; }

        showStatus('Starting...');
        isTranscribing = true;
        startTranscription(w);
    }

    // ── GET HLS PLAYLIST URL ─────────────────────────────
    function findPlaylistUrl() {
        // Method 1: Use captured URL from XHR interceptor
        if (_capturedMasterUrl) return _capturedMasterUrl;

        // Method 2: Use performance entries
        try {
            var entries = performance.getEntriesByType('resource');
            for (var i = entries.length - 1; i >= 0; i--) {
                var name = entries[i].name;
                if (name.indexOf('/pu/pl/') > 0 && name.indexOf('.m3u8') > 0
                    && name.indexOf('mp4a') < 0 && name.indexOf('avc1') < 0) {
                    return name;
                }
            }
        } catch(e) {}

        return null;
    }

    // ── HLS PARSING & AUDIO DOWNLOAD ─────────────────────
    function startTranscription() {
        var masterUrl = findPlaylistUrl();
        if (!masterUrl) {
            showStatus('Waiting for video...');
            // Retry after a short delay (video may still be loading)
            setTimeout(function() {
                masterUrl = findPlaylistUrl();
                if (!masterUrl) {
                    showStatus('No video data');
                    isTranscribing = false;
                    return;
                }
                fetchAudioFromMaster(masterUrl);
            }, 2000);
            return;
        }
        fetchAudioFromMaster(masterUrl);
    }

    function fetchAudioFromMaster(masterUrl) {
        showStatus('Loading audio...');

        fetch(masterUrl).then(function(r) { return r.text(); }).then(function(masterText) {
            // Parse master playlist for audio playlists
            // Look for audio groups: TYPE=AUDIO,GROUP-ID="audio-128000"
            var audioGroups = [];
            var lines = masterText.split('\n');
            var baseUrl = masterUrl.split('/pu/pl/')[0];

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line.indexOf('TYPE=AUDIO') > 0 && line.indexOf('#EXT-X-MEDIA') >= 0) {
                    var match = line.match(/GROUP-ID="([^"]+)"/);
                    var uriMatch = line.match(/URI="([^"]+)"/);
                    if (match && uriMatch) {
                        var groupId = match[1];
                        var bitrate = parseInt(groupId.split('-')[1] || '0', 10);
                        var uri = uriMatch[1];
                        // Full URL: baseUrl + uri
                        var fullUrl = uri.indexOf('http') === 0 ? uri : (baseUrl + uri);
                        audioGroups.push({ groupId: groupId, bitrate: bitrate, url: fullUrl });
                    }
                }
            }

            // Pick the highest bitrate audio
            audioGroups.sort(function(a, b) { return b.bitrate - a.bitrate; });
            var bestAudio = audioGroups[0];
            if (!bestAudio) {
                showStatus('No audio found');
                isTranscribing = false;
                return;
            }

            console.log('[X] Audio playlist:', bestAudio.url);
            fetchAudioPlaylist(bestAudio.url, baseUrl);
        })['catch'](function(err) {
            console.error('[X] Master fetch failed:', err);
            showStatus('Network error');
            isTranscribing = false;
        });
    }

    function fetchAudioPlaylist(audioPlaylistUrl, baseUrl) {
        fetch(audioPlaylistUrl).then(function(r) { return r.text(); }).then(function(playlistText) {
            var lines = playlistText.split('\n');
            var initUrl = null;
            var segmentUrls = [];

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                // Init segment: #EXT-X-MAP:URI="..."
                if (line.indexOf('#EXT-X-MAP:URI="') === 0) {
                    var match = line.match(/URI="([^"]+)"/);
                    if (match) {
                        initUrl = match[1].indexOf('http') === 0 ? match[1] : ('https://video.twimg.com' + match[1]);
                    }
                }
                // Segment: /ext_tw_video/...m4s (not a comment or directive)
                if (line.indexOf('/ext_tw_video/') === 0 && line.indexOf('.m4s') > 0) {
                    var segUrl = 'https://video.twimg.com' + line;
                    segmentUrls.push(segUrl);
                }
            }

            if (!initUrl || segmentUrls.length === 0) {
                showStatus('Empty audio playlist');
                isTranscribing = false;
                return;
            }

            console.log('[X] Audio init:', initUrl);
            console.log('[X] Audio segments:', segmentUrls.length);

            // Download init segment
            showStatus('Downloading audio (' + segmentUrls.length + ' segments)...');
            downloadAllAudio(initUrl, segmentUrls);
        })['catch'](function(err) {
            console.error('[X] Playlist fetch failed:', err);
            showStatus('Network error');
            isTranscribing = false;
        });
    }

    function downloadAllAudio(initUrl, segmentUrls) {
        var allUrls = [initUrl].concat(segmentUrls);
        var blobs = [];
        var downloaded = 0;
        var totalSize = 0;

        allUrls.forEach(function(url, idx) {
            fetch(url).then(function(r) { return r.blob(); }).then(function(blob) {
                blobs[idx] = blob;
                totalSize += blob.size;
                downloaded++;
                if (downloaded % 10 === 0 || downloaded === allUrls.length) {
                    showStatus('Downloading audio (' + downloaded + '/' + allUrls.length + ', ' + Math.round(totalSize / 1024) + 'KB)');
                }
                if (downloaded === allUrls.length) {
                    console.log('[X] Downloaded ' + totalSize + ' bytes');
                    sendToMistral(blobs, totalSize);
                }
            })['catch'](function(err) {
                console.error('[X] Segment ' + idx + ' failed:', err);
                showStatus('Download error');
                isTranscribing = false;
            });
        });
    }

    // ── MISTRAL TRANSCRIPTION ────────────────────────────
    function sendToMistral(blobs, totalSize) {
        showStatus('Transcribing... (' + Math.round(totalSize / 1024) + 'KB)');

        // Concatenate all blobs into one fragmented MP4
        var audioBlob = new Blob(blobs, { type: 'audio/mp4' });

        // Build multipart form-data manually
        var boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
        var parts = [];

        function addField(name, value) {
            parts.push('--' + boundary);
            parts.push('Content-Disposition: form-data; name="' + name + '"');
            parts.push('');
            parts.push(String(value));
        }

        function addFile(name, filename, blob) {
            parts.push('--' + boundary);
            parts.push('Content-Disposition: form-data; name="' + name + '"; filename="' + filename + '"');
            parts.push('Content-Type: ' + blob.type);
            parts.push('');
            // Binary data will be appended below
        }

        addField('model', MISTRAL_MODEL);
        addField('timestamp_granularities', 'segment');
        addFile('file', 'audio.mp4', audioBlob);

        parts.push('--' + boundary + '--');

        // Build the body: text parts as strings, binary as ArrayBuffer
        var textBody = parts.slice(0, -1).join('\r\n');
        var closing = '\r\n--' + boundary + '--';

        // Convert text body to Uint8Array, then insert the audio blob, then add closing
        var encoder = new TextEncoder();
        var textPrefix = encoder.encode(textBody + '\r\n');
        var textSuffix = encoder.encode('\r\n' + closing);

        return audioBlob.arrayBuffer().then(function(audioBuffer) {
            var totalLength = textPrefix.length + audioBuffer.byteLength + textSuffix.length;
            var combined = new Uint8Array(totalLength);
            combined.set(textPrefix, 0);
            combined.set(new Uint8Array(audioBuffer), textPrefix.length);
            combined.set(textSuffix, textPrefix.length + audioBuffer.byteLength);

            // Convert binary to string safely (avoids stack limit)
            var binaryStr = '';
            var chunkSize = 65536;
            for (var i = 0; i < combined.length; i += chunkSize) {
                var end = Math.min(i + chunkSize, combined.length);
                var chunk = combined.subarray(i, end);
                for (var j = 0; j < chunk.length; j++) {
                    binaryStr += String.fromCharCode(chunk[j]);
                }
            }

            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.mistral.ai/v1/audio/transcriptions',
                headers: {
                    'Authorization': 'Bearer ' + MISTRAL_API_KEY,
                    'Content-Type': 'multipart/form-data; boundary=' + boundary
                },
                data: binaryStr,
                onload: function(r) {
                    isTranscribing = false;
                    try {
                        var resp = JSON.parse(r.responseText);
                        console.log('[X] Mistral response:', resp);

                        if (resp.segments && resp.segments.length > 0) {
                            captionsData = resp.segments.map(function(s) {
                                return { start: s.start, end: s.end, text: (s.text || '').trim() };
                            });
                            console.log('[X] Got', captionsData.length, 'segments');
                            hideOverlay();
                            startCaptionDisplay();
                        } else if (resp.text) {
                            var duration = resp.usage ? (resp.usage.prompt_audio_seconds || 60) : 60;
                            captionsData = [{start: 0, end: duration, text: resp.text.trim()}];
                            hideOverlay();
                            startCaptionDisplay();
                        } else {
                            showStatus('API Error');
                            console.error('[X] Mistral error:', resp);
                        }
                    } catch(e) {
                        showStatus('Parse error');
                        console.error('[X] Parse:', e, (r.responseText || '').slice(0, 300));
                    }
                },
                onerror: function() {
                    isTranscribing = false;
                    showStatus('API unreachable');
                },
                ontimeout: function() {
                    isTranscribing = false;
                    showStatus('API timeout');
                }
            });
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
        console.log('[X] Start v3.1 (HLS audio capture)');
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
