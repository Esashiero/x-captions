// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      3.5
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

    // ── Track ALL m3u8 URLs, prefer audio ─────────────────
    var _audioM3u8 = null, _masterM3u8 = null, _videoM3u8 = null;

    function catchM3u8(url) {
        if (typeof url !== 'string') return;
        if (url.indexOf('/pu/pl/mp4a/') > -1 && url.indexOf('.m3u8') > -1) _audioM3u8 = url;
        else if (url.indexOf('/pu/pl/') > -1 && url.indexOf('.m3u8') > -1) {
            if (url.indexOf('/avc1/') > -1) _videoM3u8 = url;
            else _masterM3u8 = url;
        }
    }
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) { catchM3u8(u); return ox.apply(this, arguments); };
    var of = window.fetch;
    window.fetch = function(u, o) { catchM3u8(u); return of.call(this, u, o); };

    function pick3u8() {
        if (_audioM3u8) return _audioM3u8;
        if (_masterM3u8) return _masterM3u8;
        if (_videoM3u8) return _videoM3u8;
        try {
            var ee = performance.getEntriesByType('resource');
            for (var i=ee.length-1; i>=0; i--) { var n=ee[i].name; if (n.indexOf('/pu/pl/mp4a/')>-1&&n.indexOf('.m3u8')>-1) return n; }
            for (var i=ee.length-1; i>=0; i--) { var n=ee[i].name; if (n.indexOf('/pu/pl/')>-1&&n.indexOf('.m3u8')>-1&&n.indexOf('avc1')<0) return n; }
            for (var i=ee.length-1; i>=0; i--) { var n=ee[i].name; if (n.indexOf('/pu/pl/avc1/')>-1&&n.indexOf('.m3u8')>-1) return n; }
        } catch(e) {}
        return null;
    }

    // ── Helpers (with binary-safe overrideMimeType) ───────
    function get(url) {
        return new Promise(function(ok, fail) {
            GM_xmlhttpRequest({ method:'GET',url:url,
                overrideMimeType:'text/plain; charset=x-user-defined',
                onload:function(r){ok(r.responseText);},
                onerror:function(){fail('net');}, ontimeout:function(){fail('timeout');}
            });
        });
    }
    function getBin(url) {
        return new Promise(function(ok, fail) {
            GM_xmlhttpRequest({ method:'GET',url:url,
                overrideMimeType:'text/plain; charset=x-user-defined',
                onload:function(r){ok(r.responseText);},
                onerror:function(){fail('net');}, ontimeout:function(){fail('timeout');}
            });
        });
    }

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
        if(caps){showCaps();return;}if(busy){sts('Working...');return;}busy=true;sts('Starting...');go();
    }

    // ── Core ──────────────────────────────────────────────
    function go() {
        var url = pick3u8();
        if (!url) { sts('Waiting...'); setTimeout(function(){url=pick3u8();if(!url){sts('No video');busy=false;}else load(url);},2000); return; }
        console.log('[X] pick:', url.slice(0,100));
        load(url);
    }

    function load(url) {
        sts('Loading...');
        get(url).then(function(txt) {
            if (url.indexOf('mp4a/') > -1) return parseAudio(txt);
            var lines = txt.split('\n');
            var isMaster = lines.some(function(l){return l.indexOf('#EXT-X-STREAM-INF')===0;});
            if (isMaster) {
                console.log('[X] master');
                var base = url.split('/pu/pl/')[0], au = null;
                lines.forEach(function(l){
                    l=l.trim();
                    if(l.indexOf('TYPE=AUDIO')>-1&&l.indexOf('#EXT-X-MEDIA')>-1){
                        var m=l.match(/URI="([^"]+)"/);
                        if(m) au=m[1].indexOf('http')===0?m[1]:base+m[1];
                    }
                });
                if(!au){sts('No audio');busy=false;return;}
                console.log('[X] audio:', au.slice(0,100));
                return load(au);
            }
            parseAudio(txt);
        }).catch(function(e){console.error('[X] err:',e);sts('Net err');busy=false;});
    }

    function parseAudio(txt) {
        var lines=txt.split('\n'), init=null, segs=[];
        lines.forEach(function(l){
            l=l.trim();
            if(l.indexOf('#EXT-X-MAP:URI=')>-1){var m=l.match(/URI="([^"]+)"/);if(m)init=m[1].indexOf('http')===0?m[1]:'https://video.twimg.com'+m[1];}
            if(l.indexOf('/ext_tw_video/')>-1&&l.indexOf('.m4s')>-1) segs.push('https://video.twimg.com'+l);
        });
        if(!init||!segs.length){sts('Empty');busy=false;return;}
        if(init.indexOf('/pu/aud/')<0){
            console.log('[X] not audio, retry...');
            if(_audioM3u8) return load(_audioM3u8);
            try{var ee=performance.getEntriesByType('resource');for(var i=ee.length-1;i>=0;i--){if(ee[i].name.indexOf('/pu/pl/mp4a/')>-1&&ee[i].name.indexOf('.m3u8')>-1) return load(ee[i].name);}}catch(e){}
            sts('No audio');busy=false;return;
        }
        console.log('[X] audio init:',init.slice(0,80),'| segs:',segs.length);
        sts('Dl ('+segs.length+' segs)...');
        dl(init,segs);
    }

    // ── Download + Mistral ───────────────────────────────
    function dl(init,segs){
        var all=[init].concat(segs), blobs=[], done=0, total=0;
        all.forEach(function(url,idx){
            getBin(url).then(function(bin){
                // Convert binary-safe string to Uint8Array
                var len=bin.length, b=new Uint8Array(len);
                for(var i=0;i<len;i++) b[i]=bin.charCodeAt(i)&0xFF;
                blobs[idx]=new Blob([b],{type:'audio/mp4'}); total+=blobs[idx].size; done++;
                if(done%10===0||done===all.length) sts('Dl ('+done+'/'+all.length+', '+Math.round(total/1024)+'KB)');
                if(done===all.length) send(blobs,total);
            }).catch(function(e){console.error('[X] dl:',e);sts('Dl err');busy=false;});
        });
    }
    function send(blobs,total){
        sts('Tr ('+Math.round(total/1024)+'KB)...');
        var blob=new Blob(blobs,{type:'audio/mp4'}), b='----FB'+Math.random().toString(36).slice(2), p=[];
        function f(n,v){p.push('--'+b);p.push('Content-Disposition: form-data; name="'+n+'"');p.push('');p.push(String(v));}
        f('model',MODEL);f('timestamp_granularities','segment');
        p.push('--'+b);p.push('Content-Disposition: form-data; name="file"; filename="audio.mp4"');p.push('Content-Type: audio/mp4');p.push('');
        var hd=p.join('\r\n')+'\r\n', tl='\r\n--'+b+'--', enc=new TextEncoder(), hb=enc.encode(hd), tb=enc.encode(tl);
        blob.arrayBuffer().then(function(buf){
            var L=hb.length+buf.byteLength+tb.length, c=new Uint8Array(L);
            c.set(hb,0);c.set(new Uint8Array(buf),hb.length);c.set(tb,hb.length+buf.byteLength);
            // Convert to binary-safe string for GM_xmlhttpRequest
            var s='';for(var i=0;i<c.length;i++)s+=String.fromCharCode(c[i]);
            GM_xmlhttpRequest({
                method:'POST',url:'https://api.mistral.ai/v1/audio/transcriptions',
                overrideMimeType:'text/plain; charset=x-user-defined',
                headers:{'Authorization':'Bearer '+KEY,'Content-Type':'multipart/form-data; boundary='+b},
                data:s,
                onload:function(r){
                    busy=false;
                    try{
                        var j=JSON.parse(r.responseText);
                        if(j.segments&&j.segments.length){caps=j.segments.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});console.log('[X] OK',caps.length);hide();showCaps();}
                        else if(j.text){caps=[{start:0,end:(j.usage?j.usage.prompt_audio_seconds:60)||60,text:j.text.trim()}];hide();showCaps();}
                        else{sts('API err');console.error('[X]',j);}
                    }catch(e){sts('Parse err');console.error('[X]',e);}
                },
                onerror:function(){busy=false;sts('API down');},
                ontimeout:function(){busy=false;sts('Timeout');}
            });
        });
    }

    // ── Display ───────────────────────────────────────────
    function sts(msg){var p=vp();if(!p)return;rip(p);var o=document.createElement('div');o.setAttribute('data-x-feature','co');o.style.cssText='position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';var t=document.createElement('div');t.style.cssText='display:inline-block;background:rgba(0,0,0,.75);color:#fff;padding:6px 14px;border-radius:6px;font:14px/1.4 sans-serif;max-width:80%;';t.textContent=msg;o.appendChild(t);var vc=p.querySelector('[data-testid="videoComponent"]');if(vc)vc.appendChild(o);}
    function showCaps(){if(!caps)return;var p=vp();if(!p)return;var v=p.querySelector('video');if(!v)return;rip(p);var o=document.createElement('div');o.setAttribute('data-x-feature','co');o.style.cssText='position:absolute;bottom:60px;left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';var t=document.createElement('div');t.id='ct';t.style.cssText='display:inline-block;background:rgba(0,0,0,.85);color:#fff;padding:8px 16px;border-radius:6px;font:15px/1.5 sans-serif;max-width:85%;text-align:center;';var c=v.currentTime;for(var i=0;i<caps.length;i++){if(c>=caps[i].start&&c<caps[i].end){t.textContent=caps[i].text;break;}}o.appendChild(t);var vc=p.querySelector('[data-testid="videoComponent"]');if(vc)vc.appendChild(o);if(intv)clearInterval(intv);intv=setInterval(function(){if(!v)return;var c=v.currentTime,f='';for(var i=0;i<caps.length;i++){if(c>=caps[i].start&&c<caps[i].end){f=caps[i].text;break;}}t.textContent=f;},200);}
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
    function init(){console.log('[X] v3.5');new MutationObserver(function(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');for(var i=0;i<ps.length;i++)inj(ps[i]);}).observe(document.body,{childList:true,subtree:true});tryGo();}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
