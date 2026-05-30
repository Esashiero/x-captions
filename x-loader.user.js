// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      3.3
// @description  AI captions for X videos via Mistral. No server needed.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.mistral.ai
// @connect      video.twimg.com
// @downloadURL  https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @updateURL    https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    var KEY = 'dGjgnYE6kcY5aTFjExd5lD5DAMN1U1ld';
    var MODEL = 'voxtral-mini-latest';

    var caps = null, intv = null, busy = false;

    // ── Catch HLS playlist URLs from both XHR and fetch ──
    var _m3u8url = null;

    // Patch XMLHttpRequest
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
        if (typeof u === 'string' && u.indexOf('/pu/pl/') > -1 && u.indexOf('.m3u8') > -1) _m3u8url = u;
        return ox.apply(this, arguments);
    };

    // Patch fetch
    var of = window.fetch;
    window.fetch = function(u, o) {
        if (typeof u === 'string' && u.indexOf('/pu/pl/') > -1 && u.indexOf('.m3u8') > -1) _m3u8url = u;
        return of.call(this, u, o);
    };

    // ── Helpers ───────────────────────────────────────────
    function get(url) {
        return new Promise(function(ok, fail) {
            GM_xmlhttpRequest({
                method: 'GET', url: url,
                onload: function(r) { ok(r.responseText); },
                onerror: function() { fail('net'); },
                ontimeout: function() { fail('timeout'); }
            });
        });
    }
    function getBin(url) {
        return new Promise(function(ok, fail) {
            GM_xmlhttpRequest({
                method: 'GET', url: url,
                onload: function(r) { ok(r.response); },
                onerror: function() { fail('net'); },
                ontimeout: function() { fail('timeout'); }
            });
        });
    }

    // ── UI ────────────────────────────────────────────────
    var SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186zm7.602 0c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"></path></g></svg>';

    function mk() {
        var w = document.createElement('div');
        w.className = 'css-175oi2r';
        w.setAttribute('data-x-feature', 'cc');
        w.setAttribute('data-on', '0');
        var b = document.createElement('button');
        b.setAttribute('aria-label','AI Captions');
        b.setAttribute('role','button');
        b.className = 'css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        b.style.cssText = 'background:transparent;border-color:transparent;opacity:.5';
        var n = document.createElement('div');
        n.dir='ltr'; n.className='css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        n.style.cssText='color:#fff'; n.innerHTML=SVG;
        b.appendChild(n);
        b.onclick=function(e){e.stopPropagation();on(w);};
        w.appendChild(b); return w;
    }

    function vp() {
        var w = document.querySelector('[data-x-feature="cc"][data-on="1"]') || document.querySelector('[data-x-feature="cc"]');
        if (!w) return document.querySelector('[data-testid="videoPlayer"]');
        return w.closest('[data-testid="videoPlayer"]');
    }

    function on(w) {
        if (w.getAttribute('data-on') === '1') {
            w.setAttribute('data-on','0');
            var b=w.querySelector('button'); if(b)b.style.opacity='.5';
            hide(); if(intv){clearInterval(intv);intv=null;}
            return;
        }
        w.setAttribute('data-on','1');
        var b=w.querySelector('button'); if(b)b.style.opacity='1';
        if (caps) { showCaps(); return; }
        if (busy) { sts('Working...'); return; }
        busy = true;
        sts('Starting...');
        go();
    }

    // ── Find m3u8 ────────────────────────────────────────
    function find3u8() {
        if (_m3u8url) return _m3u8url;
        try {
            var ee = performance.getEntriesByType('resource');
            for (var i=ee.length-1; i>=0; i--) {
                var n = ee[i].name;
                if (n.indexOf('/pu/pl/') > -1 && n.indexOf('.m3u8') > -1) return n;
            }
        } catch(e) {}
        return null;
    }

    // ── Main transcription flow ───────────────────────────
    function go() {
        var url = find3u8();
        if (!url) {
            console.log('[X] no m3u8 captured, retrying...');
            sts('Waiting...');
            setTimeout(function(){
                url = find3u8();
                if (!url) { sts('No video'); busy=false; return; }
                load(url);
            }, 2000);
            return;
        }
        console.log('[X] m3u8:', url);
        load(url);
    }

    function load(url) {
        sts('Loading...');
        get(url).then(function(txt) {
            var lines = txt.split('\n');
            console.log('[X] playlist lines:', lines.length);

            // Check: master playlist or audio playlist?
            var isMaster = false;
            for (var i=0; i<lines.length; i++) {
                if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) { isMaster = true; break; }
            }

            if (isMaster) {
                // Master: find TYPE=AUDIO line, extract URI
                console.log('[X] master playlist');
                var base = url.split('/pu/pl/')[0];
                var audioUrl = null;
                for (var i=0; i<lines.length; i++) {
                    var l = lines[i].trim();
                    if (l.indexOf('TYPE=AUDIO') > -1 && l.indexOf('#EXT-X-MEDIA') > -1) {
                        var m = l.match(/URI="([^"]+)"/);
                        if (m) {
                            var u = m[1];
                            audioUrl = u.indexOf('http')===0 ? u : base+u;
                            // last one has highest bitrate
                        }
                    }
                }
                if (!audioUrl) { sts('No audio'); busy=false; return; }
                console.log('[X] audio playlist:', audioUrl);
                load(audioUrl); // recurse
                return;
            }

            // Audio playlist: extract init + segments
            console.log('[X] audio playlist');
            var init = null, segs = [];
            for (var i=0; i<lines.length; i++) {
                var l = lines[i].trim();
                if (l.indexOf('#EXT-X-MAP:URI=') > -1) {
                    var m = l.match(/URI="([^"]+)"/);
                    if (m) init = m[1].indexOf('http')===0 ? m[1] : 'https://video.twimg.com'+m[1];
                }
                if (l.indexOf('/ext_tw_video/') > -1 && l.indexOf('.m4s') > -1) {
                    segs.push('https://video.twimg.com'+l);
                }
            }
            if (!init || !segs.length) { sts('Empty'); busy=false; return; }
            console.log('[X] init:', init);
            console.log('[X] segs:', segs.length);
            sts('Download ('+segs.length+' segs)...');
            dl(init, segs);
        }).catch(function(e){ console.error('[X] fetch err:', e); sts('Net err'); busy=false; });
    }

    function dl(init, segs) {
        var all = [init].concat(segs);
        var blobs=[], done=0, total=0;
        all.forEach(function(url, idx) {
            getBin(url).then(function(bin) {
                var b = new Uint8Array(bin.length);
                for (var i=0; i<bin.length; i++) b[i] = bin.charCodeAt(i) & 0xFF;
                blobs[idx] = new Blob([b], {type:'audio/mp4'});
                total += blobs[idx].size;
                done++;
                if (done%10===0||done===all.length) sts('Dl ('+done+'/'+all.length+', '+Math.round(total/1024)+'KB)');
                if (done===all.length) send(blobs, total);
            }).catch(function(e){ console.error('[X] dl err:',e); sts('Dl err'); busy=false; });
        });
    }

    // ── Mistral upload ────────────────────────────────────
    function send(blobs, total) {
        sts('Transcribing ('+Math.round(total/1024)+'KB)...');
        var blob = new Blob(blobs, {type:'audio/mp4'});
        var b = '----FB'+Math.random().toString(36).slice(2);
        var p = [];
        function f(n,v){ p.push('--'+b); p.push('Content-Disposition: form-data; name="'+n+'"'); p.push(''); p.push(String(v)); }
        f('model', MODEL);
        f('timestamp_granularities', 'segment');
        p.push('--'+b);
        p.push('Content-Disposition: form-data; name="file"; filename="audio.mp4"');
        p.push('Content-Type: audio/mp4');
        p.push('');
        var head = p.join('\r\n') + '\r\n';
        var tail = '\r\n--' + b + '--';
        var enc = new TextEncoder();
        var hb = enc.encode(head);
        var tb = enc.encode(tail);
        blob.arrayBuffer().then(function(buf) {
            var L = hb.length + buf.byteLength + tb.length;
            var c = new Uint8Array(L);
            c.set(hb, 0);
            c.set(new Uint8Array(buf), hb.length);
            c.set(tb, hb.length + buf.byteLength);
            var s = '';
            for (var i=0; i<c.length; i++) s += String.fromCharCode(c[i]);
            GM_xmlhttpRequest({
                method:'POST', url:'https://api.mistral.ai/v1/audio/transcriptions',
                headers:{'Authorization':'Bearer '+KEY, 'Content-Type':'multipart/form-data; boundary='+b},
                data:s,
                onload:function(r){
                    busy=false;
                    try {
                        var j = JSON.parse(r.responseText);
                        if (j.segments && j.segments.length) {
                            caps = j.segments.map(function(s){ return {start:s.start, end:s.end, text:(s.text||'').trim()}; });
                            console.log('[X] OK', caps.length, 'segs');
                            hide(); showCaps();
                        } else if (j.text) {
                            caps = [{start:0, end:(j.usage?j.usage.prompt_audio_seconds:60)||60, text:j.text.trim()}];
                            hide(); showCaps();
                        } else { sts('API err'); console.error('[X]', j); }
                    } catch(e) { sts('Parse err'); console.error('[X]', e); }
                },
                onerror:function(){busy=false;sts('API down');},
                ontimeout:function(){busy=false;sts('Timeout');}
            });
        });
    }

    // ── Display ───────────────────────────────────────────
    function sts(msg) {
        var p = vp(); if (!p) return;
        rip(p);
        var o = document.createElement('div');
        o.setAttribute('data-x-feature','co');
        o.style.cssText = 'position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t = document.createElement('div');
        t.style.cssText = 'display:inline-block;background:rgba(0,0,0,.75);color:#fff;padding:6px 14px;border-radius:6px;font:14px/1.4 sans-serif;max-width:80%;';
        t.textContent = msg; o.appendChild(t);
        var vc = p.querySelector('[data-testid="videoComponent"]');
        if (vc) vc.appendChild(o);
    }

    function showCaps() {
        if (!caps) return;
        var p = vp(); if (!p) return;
        var v = p.querySelector('video'); if (!v) return;
        rip(p);
        var o = document.createElement('div');
        o.setAttribute('data-x-feature','co');
        o.style.cssText = 'position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t = document.createElement('div');
        t.id='ct'; t.style.cssText = 'display:inline-block;background:rgba(0,0,0,.85);color:#fff;padding:8px 16px;border-radius:6px;font:15px/1.5 sans-serif;max-width:85%;text-align:center;';
        var c = v.currentTime;
        for (var i=0; i<caps.length; i++) { if (c>=caps[i].start && c<caps[i].end) { t.textContent=caps[i].text; break; } }
        o.appendChild(t);
        var vc = p.querySelector('[data-testid="videoComponent"]');
        if (vc) vc.appendChild(o);
        if (intv) clearInterval(intv);
        intv = setInterval(function(){
            if (!v) return;
            var c=v.currentTime, f='';
            for (var i=0; i<caps.length; i++) { if (c>=caps[i].start && c<caps[i].end) { f=caps[i].text; break; } }
            t.textContent = f;
        }, 200);
    }

    function hide() { var p=vp(); if(p) rip(p); }
    function rip(p) { var els=p.querySelectorAll('[data-x-feature="co"]'); for(var i=0;i<els.length;i++)els[i].remove(); }

    // ── Video player injection ────────────────────────────
    function inj(pl) {
        if (pl.querySelector('[data-x-feature="cc"]')) return;
        if (pl.querySelector('[data-testid="captions"]')) return;
        var u = pl.querySelector('[aria-label="Unmute"]') || pl.querySelector('[aria-label="Mute"]');
        if (!u) return;
        var w = u.parentElement;
        if (!w) return;
        var c = w.parentElement;
        if (!c) return;
        c.insertBefore(mk(), w);
    }

    var rt=0;
    function tryGo() {
        var ps = document.querySelectorAll('[data-testid="videoPlayer"]');
        var ok = false;
        for (var i=0;i<ps.length;i++){ inj(ps[i]); if(ps[i].querySelector('[data-x-feature="cc"]')) ok=true; }
        if (!ok && rt<60) { rt++; setTimeout(tryGo,500); }
    }

    function init() {
        console.log('[X] v3.3');
        new MutationObserver(function(){
            var ps=document.querySelectorAll('[data-testid="videoPlayer"]');
            for(var i=0;i<ps.length;i++) inj(ps[i]);
        }).observe(document.body, {childList:true, subtree:true});
        tryGo();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
