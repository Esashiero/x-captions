// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      6.2
// @description  AI captions for X videos via Mistral. No server.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.mistral.ai
// @downloadURL  https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @updateURL    https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    var KEY = 'dGjgnYE6kcY5aTFjExd5lD5DAMN1U1ld';
    var _videoUrl = null;
    var caps = null, intv = null, busy = false;

    // ── Intercept page's XHR via unsafeWindow ────────────
    var W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    var ox = W.XMLHttpRequest.prototype.open;
    W.XMLHttpRequest.prototype.open = function(m, u) {
        this._xurl = typeof u === 'string' ? u : '';
        return ox.apply(this, arguments);
    };
    var os = W.XMLHttpRequest.prototype.send;
    W.XMLHttpRequest.prototype.send = function(b) {
        var xhr = this;
        if (xhr._xurl && xhr._xurl.indexOf('TweetResultByRestId') > -1) {
            xhr.addEventListener('load', function() {
                try {
                    var d = JSON.parse(xhr.responseText);
                    var r = d.data && d.data.tweetResult && d.data.tweetResult.result;
                    if (!r) return;
                    if (r.__typename === 'TweetWithVisibilityResults') r = r.tweet;
                    var m = r.legacy && r.legacy.extended_entities && r.legacy.extended_entities.media;
                    if (!m) return;
                    var best = null, br = -1;
                    for (var i=0; i<m.length; i++) {
                        if (m[i].type !== 'video' && m[i].type !== 'animated_gif') continue;
                        var v = m[i].video_info && m[i].video_info.variants;
                        if (!v) continue;
                        for (var j=0; j<v.length; j++) {
                            if (v[j].content_type === 'video/mp4' && (v[j].bitrate||0) > br) {
                                best = v[j].url; br = v[j].bitrate||0;
                            }
                        }
                    }
                    if (best) { _videoUrl = best; console.log('[X] MP4:', best.slice(0,100)); }
                } catch(e) {}
            });
        }
        return os.apply(this, arguments);
    };

    // ── UI ────────────────────────────────────────────────
    var SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186zm7.602 0c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"></path></g></svg>';

    // Settings (persisted in localStorage)
    var SETTINGS_KEY = 'x_captions_settings';
    var settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{"bg":"rgba(0,0,0,0.85)","size":"15","lang":"en"}');

    // Controls hover state
    var _controlsVisible = true;
    var _hideTimer = null;

    function setupHoverTracking(player) {
        player.addEventListener('mouseenter', function() {
            _controlsVisible = true;
            if (_hideTimer) clearTimeout(_hideTimer);
            updateCaptionPosition();
        });
        player.addEventListener('mouseleave', function() {
            _controlsVisible = false;
            updateCaptionPosition();
        });
        // Also reset on mousemove
        player.addEventListener('mousemove', function() {
            _controlsVisible = true;
            if (_hideTimer) clearTimeout(_hideTimer);
            _hideTimer = setTimeout(function() { _controlsVisible = false; updateCaptionPosition(); }, 3000);
            updateCaptionPosition();
        });
    }

    function updateCaptionPosition() {
        var els = document.querySelectorAll('[data-x-feature="co"]');
        for (var i=0; i<els.length; i++) {
            els[i].style.bottom = _controlsVisible ? '52px' : '8px';
        }
    }

    function openSettings(e) {
        e.stopPropagation();
        e.preventDefault();
        var p = vp(); if (!p) return;
        // Build settings panel
        var panel = document.createElement('div');
        panel.setAttribute('data-x-feature','settings');
        panel.style.cssText = 'position:absolute;bottom:60px;right:10px;background:rgba(0,0,0,0.9);color:#fff;padding:12px;border-radius:8px;z-index:99999;font:13px/1.5 sans-serif;min-width:200px;';
        panel.innerHTML = '<div style="font-weight:bold;margin-bottom:8px;font-size:14px;">Caption Settings</div>'+
            '<label style="display:block;margin:4px 0;">BG Color: <input id="xcs-bg" value="'+settings.bg+'" style="width:80px;background:#333;color:#fff;border:1px solid #555;border-radius:3px;padding:2px 4px;"></label>'+
            '<label style="display:block;margin:4px 0;">Size: <input id="xcs-size" type="number" value="'+settings.size+'" min="10" max="30" style="width:50px;background:#333;color:#fff;border:1px solid #555;border-radius:3px;padding:2px 4px;">px</label>'+
            '<label style="display:block;margin:4px 0;">Language: <select id="xcs-lang" style="background:#333;color:#fff;border:1px solid #555;border-radius:3px;padding:2px 4px;">'+
            '<option value="en"'+(settings.lang==='en'?' selected':'')+'>English</option>'+
            '<option value="fr"'+(settings.lang==='fr'?' selected':'')+'>French</option>'+
            '<option value="es"'+(settings.lang==='es'?' selected':'')+'>Spanish</option>'+
            '<option value="de"'+(settings.lang==='de'?' selected':'')+'>German</option>'+
            '<option value="ja"'+(settings.lang==='ja'?' selected':'')+'>Japanese</option>'+
            '<option value="original"'+(settings.lang==='original'?' selected':'')+'>Original</option>'+
            '</select></label>'+
            '<div style="margin-top:8px;display:flex;gap:4px;">'+
            '<button id="xcs-save" style="flex:1;background:#1d9bf0;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;">Save</button>'+
            '<button id="xcs-close" style="background:#555;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;">Close</button></div>';
        var vc = p.querySelector('[data-testid="videoComponent"]');
        if (vc) vc.appendChild(panel);

        document.getElementById('xcs-save').onclick = function() {
            settings.bg = document.getElementById('xcs-bg').value;
            settings.size = document.getElementById('xcs-size').value;
            settings.lang = document.getElementById('xcs-lang').value;
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
            // Update existing captions
            var ct = document.getElementById('ct');
            if (ct) ct.style.cssText = 'display:inline-block;background:'+settings.bg+';color:#fff;padding:8px 16px;border-radius:6px;font:'+settings.size+'px/1.5 sans-serif;max-width:85%;text-align:center;';
            panel.remove();
        };
        document.getElementById('xcs-close').onclick = function() { panel.remove(); };
    }

    function mk() {
        var w = document.createElement('div'); w.className='css-175oi2r'; w.setAttribute('data-x-feature','cc'); w.setAttribute('data-on','0');
        var b = document.createElement('button'); b.setAttribute('aria-label','AI Captions'); b.setAttribute('role','button');
        b.className='css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        b.style.cssText='background:transparent;border-color:transparent;opacity:.5';
        var n=document.createElement('div'); n.dir='ltr'; n.className='css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        n.style.cssText='color:#fff'; n.innerHTML=SVG;
        b.appendChild(n);
        b.onclick=function(e){e.stopPropagation();on(w);};
        b.ondblclick=function(e){openSettings(e);};
        w.appendChild(b); return w;
    }
    function vp(){var w=document.querySelector('[data-x-feature="cc"][data-on="1"]')||document.querySelector('[data-x-feature="cc"]');if(!w)return document.querySelector('[data-testid="videoPlayer"]');return w.closest('[data-testid="videoPlayer"]');}
    function on(w){
        if(w.getAttribute('data-on')==='1'){w.setAttribute('data-on','0');var b=w.querySelector('button');if(b)b.style.opacity='.5';hide();if(intv){clearInterval(intv);intv=null;}return;}
        w.setAttribute('data-on','1');var b=w.querySelector('button');if(b)b.style.opacity='1';
        if(caps){showCaps();return;}if(busy){sts('Working...');return;}
        if (!_videoUrl) { sts('No video data yet'); busy=false; return; }
        busy=true; sts('Transcribing...'); transcribe(_videoUrl);
    }

    function transcribe(videoUrl) {
        var bd = '----FB'+Math.random().toString(36).slice(2);
        var p = [];
        p.push('--'+bd); p.push('Content-Disposition: form-data; name="model"'); p.push(''); p.push('voxtral-mini-latest');
        p.push('--'+bd); p.push('Content-Disposition: form-data; name="file_url"'); p.push(''); p.push(videoUrl);
        p.push('--'+bd); p.push('Content-Disposition: form-data; name="timestamp_granularities"'); p.push(''); p.push('segment');
        p.push('--'+bd+'--');
        GM_xmlhttpRequest({
            method:'POST', url:'https://api.mistral.ai/v1/audio/transcriptions',
            headers:{'Authorization':'Bearer '+KEY,'Content-Type':'multipart/form-data; boundary='+bd},
            data:p.join('\r\n'),
            onload:function(r){
                busy=false;
                try{
                    var j=JSON.parse(r.responseText);
                    console.log('[X] Mistral:', JSON.stringify(j).slice(0,300));
                    if(j.segments&&j.segments.length){
                        var rawSegs = j.segments;
                        sts('Translating...');
                        // Translate all segment text to English
                        var texts = rawSegs.map(function(s){return s.text;}).join('\n');
                        GM_xmlhttpRequest({
                            method:'POST', url:'https://api.mistral.ai/v1/chat/completions',
                            headers:{'Authorization':'Bearer '+KEY,'Content-Type':'application/json'},
                            data:JSON.stringify({
                                model:'mistral-small-latest',
                                messages:[{role:'user',content:'Translate these sentences to English. Return ONLY the translations, one per line, preserving the exact number of lines:\n'+texts}]
                            }),
                            onload:function(r2){
                                try{
                                    var t = JSON.parse(r2.responseText);
                                    var translated = t.choices[0].message.content.trim().split('\n');
                                    caps = rawSegs.map(function(s,i){return{start:s.start,end:s.end,text:(translated[i]||s.text).trim()};});
                                }catch(e){caps=rawSegs.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});}
                                console.log('[X] OK',caps.length);hide();showCaps();
                            },
                            onerror:function(){
                                caps=rawSegs.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});
                                hide();showCaps();
                            }
                        });
                    } else if(j.text){
                        caps=[{start:0,end:120,text:j.text.trim()}];hide();showCaps();
                    } else { sts('API err'); console.error('[X]',j); }
                }catch(e){sts('Parse err');console.error('[X]',e);}
            },
            onerror:function(){busy=false;sts('API down');},
            ontimeout:function(){busy=false;sts('Timeout');}
        });
    }

    // ── Display ───────────────────────────────────────────
    function sts(msg){
        var p=vp();if(!p)return;rip(p);
        var o=document.createElement('div');o.setAttribute('data-x-feature','co');
        o.style.cssText='position:absolute;bottom:'+(_controlsVisible?'52px':'8px')+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t=document.createElement('div');
        t.style.cssText='display:inline-block;background:rgba(0,0,0,.75);color:#fff;padding:6px 14px;border-radius:6px;font:14px/1.4 sans-serif;max-width:80%;';
        t.textContent=msg;o.appendChild(t);
        var vc=p.querySelector('[data-testid="videoComponent"]');if(vc)vc.appendChild(o);
    }
    function showCaps(){
        if(!caps)return;var p=vp();if(!p)return;var v=p.querySelector('video');if(!v)return;
        rip(p);var o=document.createElement('div');o.setAttribute('data-x-feature','co');
        o.style.cssText='position:absolute;bottom:'+(_controlsVisible?'52px':'8px')+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t=document.createElement('div');t.id='ct';
        t.style.cssText='display:inline-block;background:'+settings.bg+';color:#fff;padding:8px 16px;border-radius:6px;font:'+settings.size+'px/1.5 sans-serif;max-width:85%;text-align:center;';
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
        setupHoverTracking(pl);
        c.insertBefore(mk(),w);
    }
    var rt=0;
    function tryGo(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');var ok=false;for(var i=0;i<ps.length;i++){inj(ps[i]);if(ps[i].querySelector('[data-x-feature="cc"]'))ok=true;}if(!ok&&rt<60){rt++;setTimeout(tryGo,500);}}
    function init(){console.log('[X] v6.2');new MutationObserver(function(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');for(var i=0;i<ps.length;i++)inj(ps[i]);}).observe(document.body,{childList:true,subtree:true});tryGo();}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
