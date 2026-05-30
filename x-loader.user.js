// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      4.0
// @description  AI captions for X videos via Mistral. No server needed.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      api.mistral.ai
// @downloadURL  https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @updateURL    https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    var KEY = 'dGjgnYE6kcY5aTFjExd5lD5DAMN1U1ld';
    var MODEL = 'voxtral-mini-latest';

    var caps = null, intv = null, busy = false;

    // ── UI ────────────────────────────────────────────────
    var SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186zm7.602 0c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"></path></g></svg>';

    function mk() {
        var w = document.createElement('div'); w.className='css-175oi2r'; w.setAttribute('data-x-feature','cc'); w.setAttribute('data-on','0');
        var b = document.createElement('button'); b.setAttribute('aria-label','AI Captions'); b.setAttribute('role','button');
        b.className='css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        b.style.cssText='background:transparent;border-color:transparent;opacity:.5';
        var n=document.createElement('div'); n.dir='ltr'; n.className='css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        n.style.cssText='color:#fff'; n.innerHTML=SVG;
        b.appendChild(n); b.onclick=function(e){e.stopPropagation();on(w);}; w.appendChild(b); return w;
    }
    function vp(){var w=document.querySelector('[data-x-feature="cc"][data-on="1"]')||document.querySelector('[data-x-feature="cc"]');if(!w)return document.querySelector('[data-testid="videoPlayer"]');return w.closest('[data-testid="videoPlayer"]');}
    function on(w){
        if(w.getAttribute('data-on')==='1'){w.setAttribute('data-on','0');var b=w.querySelector('button');if(b)b.style.opacity='.5';hide();if(intv){clearInterval(intv);intv=null;}return;}
        w.setAttribute('data-on','1');var b=w.querySelector('button');if(b)b.style.opacity='1';
        if(caps){showCaps();return;}if(busy){sts('Working...');return;}
        busy=true;sts('Starting...');
        recordAudio();
    }

    // ── Record audio from the video element ──────────────
    function recordAudio() {
        var p = document.querySelector('[data-testid="videoPlayer"]');
        if (!p) { sts('No player'); busy=false; return; }
        var video = p.querySelector('video');
        if (!video) { sts('No video'); busy=false; return; }

        console.log('[X] recording audio...');

        var AudioContext = window.AudioContext || window.webkitAudioContext;
        var ctx = new AudioContext();
        var src = ctx.createMediaElementSource(video);
        var dst = ctx.createMediaStreamDestination();
        src.connect(dst);

        var chunks = [];
        var mime = 'audio/webm;codecs=opus';
        if (!MediaRecorder.isTypeSupported(mime)) {
            mime = 'audio/webm';
            if (!MediaRecorder.isTypeSupported(mime)) {
                mime = 'audio/ogg;codecs=opus';
            }
        }
        console.log('[X] mime:', mime);
        var rec = new MediaRecorder(dst.stream, {mimeType: mime});
        rec.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };
        rec.onstop = function() {
            var blob = new Blob(chunks, {type: mime});
            console.log('[X] recorded:', blob.size, 'bytes');
            // Cleanup audio context
            src.disconnect();
            ctx.close();
            sendToMistral(blob);
        };

        rec.start(1000); // Collect data every second for progress
        sts('Recording...');

        // Play the video muted at 1x speed
        video.muted = true;
        video.playbackRate = 1;
        var playPromise = video.play();
        if (playPromise) {
            playPromise.catch(function(e) { console.error('[X] play fail:', e); });
        }

        // Stop recording when video ends, or after timeout
        var endTimer = null;
        function onEnded() {
            if (endTimer) clearTimeout(endTimer);
            rec.stop();
            video.removeEventListener('ended', onEnded);
            video.removeEventListener('timeupdate', onTime);
        }
        function onTime() {
            var dur = video.duration || 120;
            var pct = Math.round(video.currentTime / dur * 100);
            sts('Recording... ' + pct + '%');
            // Safety timeout: stop after duration + 5s
            if (!endTimer) {
                endTimer = setTimeout(function() {
                    console.log('[X] recording timeout');
                    rec.stop();
                    video.removeEventListener('ended', onEnded);
                    video.removeEventListener('timeupdate', onTime);
                }, (dur + 5) * 1000);
            }
        }
        video.addEventListener('ended', onEnded);
        video.addEventListener('timeupdate', onTime);
    }

    // ── Upload to Mistral via base64 chat completions ──
    function sendToMistral(blob) {
        var sz = Math.round(blob.size / 1024);
        sts('Encoding... (' + sz + 'KB)');

        // Convert blob to base64 (text-safe, no binary corruption)
        var reader = new FileReader();
        reader.onloadend = function() {
            var base64 = reader.result.split(',')[1];
            var b64sz = Math.round(base64.length / 1024);
            sts('Transcribing (' + b64sz + 'KB)...');
            console.log('[X] base64:', b64sz, 'KB');

            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.mistral.ai/v1/chat/completions',
                headers: {'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'},
                data: JSON.stringify({
                    model: 'voxtral-mini-latest',
                    messages: [{
                        role: 'user',
                        content: [
                            {type: 'input_audio', input_audio: base64},
                            {type: 'text', text: 'Transcribe this audio. Return the transcription text and segments with start/end timestamps.'}
                        ]
                    }]
                }),
                onload: function(r) {
                    busy = false;
                    try {
                        var j = JSON.parse(r.responseText);
                        console.log('[X] Mistral:', JSON.stringify(j).slice(0, 500));
                        // Check for segments in the response
                        if (j.segments && j.segments.length) {
                            caps = j.segments.map(function(s) { return {start: s.start, end: s.end, text: (s.text || '').trim()}; });
                            console.log('[X] OK', caps.length);
                            hide(); showCaps();
                        } else if (j.choices && j.choices.length && j.choices[0].message && j.choices[0].message.content) {
                            // Chat API returns text in choices[0].message.content
                            var text = j.choices[0].message.content;
                            // If no segments, create one big segment
                            caps = [{start: 0, end: 120, text: text.trim()}];
                            hide(); showCaps();
                        } else if (j.text) {
                            caps = [{start: 0, end: (j.usage ? j.usage.prompt_audio_seconds : 60) || 60, text: j.text.trim()}];
                            hide(); showCaps();
                        } else {
                            sts('API err');
                            console.error('[X]', j);
                        }
                    } catch(e) { sts('Parse err'); console.error('[X]', e, (r.responseText || '').slice(0, 300)); }
                },
                onerror: function() { busy = false; sts('API down'); },
                ontimeout: function() { busy = false; sts('Timeout'); }
            });
        };
        reader.readAsDataURL(blob);
    }

    // ── Display ───────────────────────────────────────────
    function sts(msg){var p=vp();if(!p)return;rip(p);var o=document.createElement('div');o.setAttribute('data-x-feature','co');o.style.cssText='position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';var t=document.createElement('div');t.style.cssText='display:inline-block;background:rgba(0,0,0,.75);color:#fff;padding:6px 14px;border-radius:6px;font:14px/1.4 sans-serif;max-width:80%;';t.textContent=msg;o.appendChild(t);var vc=p.querySelector('[data-testid="videoComponent"]');if(vc)vc.appendChild(o);}
    function showCaps(){
        if(!caps)return;var p=vp();if(!p)return;var v=p.querySelector('video');if(!v)return;
        rip(p);var o=document.createElement('div');o.setAttribute('data-x-feature','co');o.style.cssText='position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t=document.createElement('div');t.id='ct';t.style.cssText='display:inline-block;background:rgba(0,0,0,.85);color:#fff;padding:8px 16px;border-radius:6px;font:15px/1.5 sans-serif;max-width:85%;text-align:center;';
        var c=v.currentTime;for(var i=0;i<caps.length;i++){if(c>=caps[i].start&&c<caps[i].end){t.textContent=caps[i].text;break;}}
        o.appendChild(t);var vc=p.querySelector('[data-testid="videoComponent"]');if(vc)vc.appendChild(o);
        if(intv)clearInterval(intv);intv=setInterval(function(){if(!v)return;var c=v.currentTime,f='';for(var i=0;i<caps.length;i++){if(c>=caps[i].start&&c<caps[i].end){f=caps[i].text;break;}}t.textContent=f;},200);
    }
    function hide(){var p=vp();if(p)rip(p);}
    function rip(p){var els=p.querySelectorAll('[data-x-feature="co"]');for(var i=0;i<els.length;i++)els[i].remove();}

    // ── Player injection ─────────────────────────────────
    function inj(pl){
        if(pl.querySelector('[data-x-feature="cc"]'))return;
        if(pl.querySelector('[data-testid="captions"]'))return;
        var u=pl.querySelector('[aria-label="Unmute"]')||pl.querySelector('[aria-label="Mute"]');
        if(!u)return;var w=u.parentElement;if(!w)return;var c=w.parentElement;if(!c)return;
        c.insertBefore(mk(),w);
    }
    var rt=0;
    function tryGo(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');var ok=false;for(var i=0;i<ps.length;i++){inj(ps[i]);if(ps[i].querySelector('[data-x-feature="cc"]'))ok=true;}if(!ok&&rt<60){rt++;setTimeout(tryGo,500);}}
    function init(){console.log('[X] v4.0');new MutationObserver(function(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');for(var i=0;i<ps.length;i++)inj(ps[i]);}).observe(document.body,{childList:true,subtree:true});tryGo();}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
