// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      6.4
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

    var _videoUrl = null;
    var caps = null, intv = null, busy = false;

    // ── Providers ────────────────────────────────────────
    var PROVIDERS = {
        mistral: {name:'Mistral AI', key:'dGjgnYE6kcY5aTFjExd5lD5DAMN1U1ld',
            models:{'voxtral-mini-latest':'Voxtral Mini','voxtral-latest':'Voxtral'},
            transcribe:'https://api.mistral.ai/v1/audio/transcriptions',
            chat:'https://api.mistral.ai/v1/chat/completions'}
    };

    // ── Settings defaults ────────────────────────────────
    var SKEY = 'x_captions_settings';
    var DEF = {bg:'rgba(0,0,0,0.85)', size:'15', lang:'en', provider:'mistral', model:'voxtral-mini-latest'};
    var s = JSON.parse(localStorage.getItem(SKEY) || JSON.stringify(DEF));
    // Ensure new fields exist
    if (!s.provider) s.provider = DEF.provider;
    if (!s.model) s.model = DEF.model;

    var LANG_MAP = {'en':'English','fr':'French','es':'Spanish','de':'German','ja':'Japanese','original':'Original'};

    // ── Intercept XHR ────────────────────────────────────
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
    var GEAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px;fill:currentColor"><g><path d="M10.54 1.75h2.92l1.57 2.36c.11.17.32.25.53.21l2.53-.59 2.17 1.67-.38 2.55c-.04.26.11.5.37.61l2.37 1.05v3.38l-2.37 1.05c-.26.12-.41.36-.37.62l.38 2.55-2.17 1.67-2.53-.59c-.21-.05-.42.04-.53.2l-1.57 2.36h-2.92l-1.58-2.36c-.11-.16-.32-.25-.53-.21l-2.53.59-2.17-1.67.38-2.55c.04-.26-.11-.5-.37-.61L2 12.43V9.05l2.37-1.05c.26-.11.41-.35.37-.61l-.38-2.55L6.53 3.17l2.53.59c.21.04.42-.05.53-.2l1.58-2.36zm-1.4 10.56c.82.82 2.13.82 2.95 0 .82-.82.82-2.13 0-2.95-.82-.82-2.13-.82-2.95 0-.82.82-.82 2.13 0 2.95z"/></g></svg>';

    function mk() {
        var w = document.createElement('div'); w.className='css-175oi2r'; w.style.cssText='flex-direction:row;align-items:center;';
        var cc = document.createElement('div'); cc.className='css-175oi2r'; cc.setAttribute('data-x-feature','cc'); cc.setAttribute('data-on','0');
        var cb = document.createElement('button'); cb.setAttribute('aria-label','AI Captions'); cb.setAttribute('role','button');
        cb.className='css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        cb.style.cssText='background:transparent;border-color:transparent;opacity:.5';
        var cn=document.createElement('div'); cn.dir='ltr'; cn.className='css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        cn.style.cssText='color:#fff'; cn.innerHTML=SVG;
        cb.appendChild(cn); cb.onclick=function(e){e.stopPropagation();on(cc);}; cc.appendChild(cb); w.appendChild(cc);
        var sb = document.createElement('button'); sb.setAttribute('aria-label','Caption Settings'); sb.setAttribute('role','button');
        sb.className='css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        sb.style.cssText='background:transparent;border-color:transparent;opacity:0.5;margin-left:2px;padding:2px;';
        var sn=document.createElement('div'); sn.dir='ltr'; sn.className='css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        sn.style.cssText='color:#fff;display:flex;align-items:center;'; sn.innerHTML=GEAR_SVG;
        sb.appendChild(sn); sb.onclick=function(e){e.stopPropagation();openSett(cc);}; w.appendChild(sb);
        return w;
    }

    function mkVideo(pl) {
        return pl ? pl.querySelector('video') : (document.querySelector('[data-testid="videoPlayer"] video') || null);
    }

    function vp(){var w=document.querySelector('[data-x-feature="cc"][data-on="1"]')||document.querySelector('[data-x-feature="cc"]');if(!w)return document.querySelector('[data-testid="videoPlayer"]');return w.closest('[data-testid="videoPlayer"]');}

    // ── Caption button logic ─────────────────────────────
    function on(w){
        if(w.getAttribute('data-on')==='1'){w.setAttribute('data-on','0');var b=w.querySelector('button');if(b)b.style.opacity='.5';hide();if(intv){clearInterval(intv);intv=null;}return;}
        w.setAttribute('data-on','1');var b=w.querySelector('button');if(b)b.style.opacity='1';
        if(caps){showCaps();return;}if(busy){sts('Working...');return;}
        if (!_videoUrl) { sts('No video data yet'); busy=false; return; }
        busy=true; sts('Transcribing...'); transcribe(_videoUrl);
    }

    // ── Caption positioning ──────────────────────────────
    var ctrlVis = true, hideTimer = null, paused = false;

    function hoverSetup(pl) {
        if (pl._hoverSetup) return; pl._hoverSetup = true;
        var vid = pl.querySelector('video');
        if (vid) vid.addEventListener('pause', function(){paused=true;updPos();});
        if (vid) vid.addEventListener('play', function(){paused=false;updPos();});
        function showC(){ctrlVis=true;if(hideTimer)clearTimeout(hideTimer);updPos();}
        function hideC(){ctrlVis=false;updPos();}
        pl.addEventListener('mouseenter',showC);
        pl.addEventListener('mouseleave',hideC);
        pl.addEventListener('mousemove',function(){
            ctrlVis=true; if(hideTimer)clearTimeout(hideTimer);
            hideTimer=setTimeout(function(){ctrlVis=false;updPos();},3000); updPos();
        });
    }

    function updPos(){
        var show = ctrlVis || paused;
        var els=document.querySelectorAll('[data-x-feature="co"]');
        for(var i=0;i<els.length;i++)els[i].style.bottom=show?'52px':'8px';
    }

    // ── Settings panel ────────────────────────────────────
    function openSett(cc) {
        var p = vp(); if (!p) return;
        var old = document.querySelector('[data-x-feature="xcs"]'); if(old) old.remove();

        var pr = document.getElementById('xcs-picker');
        var pan = document.createElement('div');
        pan.setAttribute('data-x-feature','xcs');
        pan.style.cssText='position:fixed;z-index:999999;background:rgba(0,0,0,0.95);color:#fff;padding:18px;border-radius:10px;font:13px/1.6 sans-serif;min-width:250px;pointer-events:auto;box-shadow:0 6px 20px rgba(0,0,0,0.6);';

        var langs = '';
        for (var k in LANG_MAP) { langs += '<option value="'+k+'"'+(s.lang===k?' selected':'')+'>'+LANG_MAP[k]+'</option>'; }

        var provs = '', provModels = {};
        for (var pk in PROVIDERS) {
            provs += '<option value="'+pk+'"'+(s.provider===pk?' selected':'')+'>'+PROVIDERS[pk].name+'</option>';
            provModels[pk] = PROVIDERS[pk].models;
        }
        var curProv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
        var curModels = curProv.models || {};
        var modelsHtml = '';
        for (var mk in curModels) {
            modelsHtml += '<option value="'+mk+'"'+(s.model===mk?' selected':'')+'>'+curModels[mk]+'</option>';
        }
        var showKey = (s.provider==='mistral') ? '' : '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">API KEY</label><input id="xcs-key" value="'+curProv.key+'" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;"></div>';

        pan.innerHTML = '<div style="font-weight:bold;margin-bottom:12px;font-size:14px;border-bottom:1px solid #444;padding-bottom:6px;">Caption Settings</div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">AI PROVIDER</label>'+
            '<select id="xcs-provider" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+provs+'</select></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">MODEL</label>'+
            '<select id="xcs-model" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+modelsHtml+'</select></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">BACKGROUND</label>'+
            '<div style="display:flex;gap:6px;margin-top:2px;">'+
            '<input type="color" id="xcs-bg-picker" value="'+(s.bg.startsWith('#')?s.bg:'#000000')+'" style="width:36px;height:30px;padding:0;border:1px solid #555;border-radius:4px;background:transparent;cursor:pointer;">'+
            '<input id="xcs-bg" value="'+s.bg+'" style="flex:1;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;"></div></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">FONT SIZE</label>'+
            '<input id="xcs-size" type="range" min="10" max="30" value="'+s.size+'" style="width:100%;margin:2px 0;">'+
            '<span id="xcs-size-val" style="font-size:11px;color:#aaa;">'+s.size+'px</span></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">LANGUAGE</label>'+
            '<select id="xcs-lang" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+langs+'</select></div>'+
            '<div style="margin-top:10px;display:flex;gap:4px;">'+
            '<button id="xcs-save" style="flex:1;background:#1d9bf0;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Save</button>'+
            '<button id="xcs-close" style="background:#444;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Cancel</button></div>';

        // Position above the gear button, over the video
        var rect = p.getBoundingClientRect();
        pan.style.left = Math.max(10, rect.left + rect.width - 270) + 'px';
        pan.style.top = rect.top + 'px';

        document.body.appendChild(pan);

        // Provider change → update model options
        document.getElementById('xcs-provider').onchange = function() {
            var pk = this.value;
            var pv = PROVIDERS[pk];
            if (!pv) return;
            var sel = document.getElementById('xcs-model');
            sel.innerHTML = '';
            for (var m in pv.models) {
                var opt = document.createElement('option');
                opt.value = m; opt.textContent = pv.models[m];
                if (m === pv.models) opt.selected = true;
                sel.appendChild(opt);
            }
        };

        document.getElementById('xcs-size').oninput = function() {
            document.getElementById('xcs-size-val').textContent = this.value + 'px';
        };
        document.getElementById('xcs-bg-picker').oninput = function() {
            document.getElementById('xcs-bg').value = this.value;
        };

        document.getElementById('xcs-save').onclick = function() {
            s.provider = document.getElementById('xcs-provider').value || DEF.provider;
            s.model = document.getElementById('xcs-model').value || DEF.model;
            var keyEl = document.getElementById('xcs-key');
            if (keyEl && PROVIDERS[s.provider]) {
                PROVIDERS[s.provider].key = keyEl.value;
            }
            s.bg = document.getElementById('xcs-bg').value || DEF.bg;
            s.size = document.getElementById('xcs-size').value || DEF.size;
            s.lang = document.getElementById('xcs-lang').value || 'en';
            localStorage.setItem(SKEY, JSON.stringify(s));
            // Update current captions if visible
            var ct = document.getElementById('ct');
            if (ct) ct.style.cssText = 'display:inline-block;background:'+s.bg+';color:#fff;padding:8px 16px;border-radius:6px;font:'+s.size+'px/1.5 sans-serif;max-width:85%;text-align:center;';
            if (pan.parentNode) pan.remove();
        };
        document.getElementById('xcs-close').onclick = function() { if (pan.parentNode) pan.remove(); };
        // Close on click outside
        setTimeout(function() {
            function clkOut(e) {
                if (!pan.contains(e.target) && e.target.getAttribute('aria-label') !== 'Caption Settings') {
                    if (pan.parentNode) pan.remove();
                    document.removeEventListener('mousedown', clkOut, true);
                }
            }
            document.addEventListener('mousedown', clkOut, true);
        }, 100);
    }

    // ── Transcription ─────────────────────────────────────
    function transcribe(url) {
        var pv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
        var key = pv.key;
        var model = s.model || DEF.model;

        if (s.provider === 'mistral') {
            var bd = '----FB'+Math.random().toString(36).slice(2);
            var parts = [];
            parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="model"'); parts.push(''); parts.push(model);
            parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="file_url"'); parts.push(''); parts.push(url);
            parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="timestamp_granularities"'); parts.push(''); parts.push('segment');
            parts.push('--'+bd+'--');
            GM_xmlhttpRequest({
                method:'POST', url:pv.transcribe,
                headers:{'Authorization':'Bearer '+key,'Content-Type':'multipart/form-data; boundary='+bd},
                data:parts.join('\r\n'),
                onload:function(r){handleMistral(r);},
                onerror:function(){busy=false;sts('API down');},
                ontimeout:function(){busy=false;sts('Timeout');}
            });
        }
    }

    function handleMistral(r){
        busy=false;
        try{
            var j=JSON.parse(r.responseText);
            console.log('[X] Mistral:', JSON.stringify(j).slice(0,300));
            if(j.segments&&j.segments.length){
                var raw = j.segments;
                if (s.lang === 'original') {
                    caps = raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});
                    hide();showCaps();
                } else {
                    sts('Translating...');
                    var txts = raw.map(function(s){return s.text;}).join('\n');
                    var target = LANG_MAP[s.lang] || 'English';
                    var pv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
                    GM_xmlhttpRequest({
                        method:'POST', url:pv.chat,
                        headers:{'Authorization':'Bearer '+pv.key,'Content-Type':'application/json'},
                        data:JSON.stringify({model:'mistral-small-latest',messages:[{role:'user',content:'Translate these sentences to '+target+'. Return ONLY the translations, one per line, preserving the exact number of lines:\n'+txts}]}),
                        onload:function(r2){
                            try{
                                var t = JSON.parse(r2.responseText);
                                var tr = t.choices[0].message.content.trim().split('\n');
                                caps = raw.map(function(s,i){return{start:s.start,end:s.end,text:(tr[i]||s.text).trim()};});
                            }catch(e){caps=raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});}
                            console.log('[X] OK',caps.length);hide();showCaps();
                        },
                        onerror:function(){caps=raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});hide();showCaps();}
                    });
                }
            } else if(j.text){
                caps=[{start:0,end:120,text:j.text.trim()}];hide();showCaps();
            } else { sts('API err'); console.error('[X]',j); }
        }catch(e){sts('Parse err');console.error('[X]',e);}
    }

    // ── Display ───────────────────────────────────────────
    function ctrlBottom(){return ctrlVis||paused?'52px':'8px';}

    function sts(msg){
        var p=vp();if(!p)return;rip(p);
        var o=document.createElement('div');o.setAttribute('data-x-feature','co');
        o.style.cssText='position:absolute;bottom:'+ctrlBottom()+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t=document.createElement('div');
        t.style.cssText='display:inline-block;background:rgba(0,0,0,.75);color:#fff;padding:6px 14px;border-radius:6px;font:14px/1.4 sans-serif;max-width:80%;';
        t.textContent=msg;o.appendChild(t);
        var vc=p.querySelector('[data-testid="videoComponent"]');if(vc)vc.appendChild(o);
    }
    function showCaps(){
        if(!caps)return;var p=vp();if(!p)return;var v=p.querySelector('video');if(!v)return;
        rip(p);var o=document.createElement('div');o.setAttribute('data-x-feature','co');
        o.style.cssText='position:absolute;bottom:'+ctrlBottom()+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t=document.createElement('div');t.id='ct';
        t.style.cssText='display:inline-block;background:'+s.bg+';color:#fff;padding:8px 16px;border-radius:6px;font:'+s.size+'px/1.5 sans-serif;max-width:85%;text-align:center;';
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
        hoverSetup(pl);
        c.insertBefore(mk(), w);
    }
    var rt=0;
    function tryGo(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');var ok=false;for(var i=0;i<ps.length;i++){inj(ps[i]);if(ps[i].querySelector('[data-x-feature="cc"]'))ok=true;}if(!ok&&rt<60){rt++;setTimeout(tryGo,500);}}
    function init(){console.log('[X] v6.4');new MutationObserver(function(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');for(var i=0;i<ps.length;i++)inj(ps[i]);}).observe(document.body,{childList:true,subtree:true});tryGo();}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
