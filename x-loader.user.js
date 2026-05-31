// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      7.4
// @description  AI captions for X/Twitter videos. No server needed.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.mistral.ai
// @connect      *
// @downloadURL  https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @updateURL    https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    var _videoUrls = {}, caps = null, intv = null, busy = false;
    var SKEY = 'x_captions_settings';

    // ── Providers ────────────────────────────────────────
    var PROVIDERS = {};

    function loadCustomProv() {
        try { var raw = localStorage.getItem('x_captions_custom_providers'); return raw ? JSON.parse(raw) : {}; } catch(e) { return {}; }
    }
    function saveCustomProv(cp) { localStorage.setItem('x_captions_custom_providers', JSON.stringify(cp)); }

    function buildProviders() {
        PROVIDERS = {
            mistral: {name:'Mistral AI', key:'dGjgnYE6kcY5aTFjExd5lD5DAMN1U1ld',
                models:{'voxtral-mini-latest':'Voxtral Mini','voxtral-latest':'Voxtral'},
                transcribe:'https://api.mistral.ai/v1/audio/transcriptions',
                chat:'https://api.mistral.ai/v1/chat/completions'}
        };
        var cp = loadCustomProv();
        for (var k in cp) {
            var p = cp[k], m = {};
            m[p.model || 'custom-model'] = p.model || 'Custom Model';
            PROVIDERS['cust_'+k] = {
                name: p.name || 'Custom', key: p.key || '', models: m,
                transcribe: p.transcribe_url || '', chat: p.chat_url || ''
            };
        }
    }
    buildProviders();

    // ── Settings ─────────────────────────────────────────
    var DEF = {bg:'#000000', bgOp:85, size:'15', lang:'en', provider:'mistral', model:'voxtral-mini-latest'};
    var s = JSON.parse(localStorage.getItem(SKEY) || JSON.stringify(DEF));
    if (!s.provider) s.provider = DEF.provider;
    if (!s.model) s.model = DEF.model;
    if (s.bgOp === undefined) s.bgOp = DEF.bgOp;
    if (s.bg && s.bg.startsWith('rgba')) { s.bg = DEF.bg; s.bgOp = DEF.bgOp; }

    var LANG_MAP = {'en':'English','fr':'French','es':'Spanish','de':'German','ja':'Japanese','original':'Original'};

    function bgCSS() {
        var c = s.bg, o = (s.bgOp === undefined ? 85 : s.bgOp) / 100;
        var r = parseInt(c.slice(1,3),16) || 0;
        var g = parseInt(c.slice(3,5),16) || 0;
        var b = parseInt(c.slice(5,7),16) || 0;
        return 'rgba('+r+','+g+','+b+','+o+')';
    }

    // ── Capture video URL from <video> elements in the DOM ──
    // This is the only CSP-safe approach: X.com's CSP has a nonce directive
    // which ignores 'unsafe-inline', blocking all injected JS (scripts, eval,
    // javascript: links, unsafeWindow.fetch assignment).
    // Instead we observe <video> elements and read their src/currentSrc.

    function watchVideoElement(video) {
        if (video._xcv) return;
        video._xcv = true;

        function extractUrl() {
            var url = video.currentSrc || video.src || '';
            // twimg video URLs: https://video.twimg.com/...
            if (!url || url.indexOf('http') !== 0) return;
            var tweetId = getTweetIdFromChild(video);
            if (tweetId && !_videoUrls[tweetId]) {
                _videoUrls[tweetId] = url;
            }
        }

        video.addEventListener('loadedmetadata', extractUrl);
        video.addEventListener('canplay', extractUrl);
        // Poll src for 5s in case events don't fire (attribute-based setting)
        var checkInt = setInterval(extractUrl, 300);
        setTimeout(function() { clearInterval(checkInt); }, 5000);
        // Fire immediately if video is already loaded
        if (video.readyState >= 1) setTimeout(extractUrl, 100);
    }

    // Walk UP from the video element to find the tweet ID
    function getTweetIdFromChild(el) {
        var art = el.closest('article[data-testid="tweet"]');
        if (!art) {
            // Some videos are in overlay/lightbox — try a broader search
            art = el.closest('[data-testid="tweet"]');
        }
        if (!art) return null;
        var links = art.querySelectorAll('a[href*="/status/"]');
        for (var i = 0; i < links.length; i++) {
            var m = links[i].href.match(/\/status\/(\d+)/);
            if (m) return m[1];
        }
        return null;
    }

    // Watch for <video> elements appearing in the DOM
    function startVideoWatcher() {
        var obs = new MutationObserver(function(muts) {
            for (var m = 0; m < muts.length; m++) {
                var nodes = muts[m].addedNodes;
                for (var n = 0; n < nodes.length; n++) {
                    var node = nodes[n];
                    if (node.nodeName === 'VIDEO') {
                        watchVideoElement(node);
                    } else if (node.querySelectorAll) {
                        var vids = node.querySelectorAll('video');
                        for (var v = 0; v < vids.length; v++) watchVideoElement(vids[v]);
                    }
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        // Background scan every 3s to catch lazy-loaded video src changes
        setInterval(function() {
            var vids = document.querySelectorAll('video');
            for (var v = 0; v < vids.length; v++) {
                var url = vids[v].currentSrc || vids[v].src || '';
                if (url && url.indexOf('http') === 0) {
                    var tid = getTweetIdFromChild(vids[v]);
                    if (tid && !_videoUrls[tid]) {
                        _videoUrls[tid] = url;
                    }
                }
            }
        }, 3000);
    }

    // Also keep the XHR interceptor as a secondary path (some X.com parts still use XHR)
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
            var tweetId = null;
            var tm = xhr._xurl.match(/tweetId[%22:]+(\d+)/);
            if (tm) tweetId = tm[1];
            xhr.addEventListener('load', function() {
                try {
                    var d = JSON.parse(xhr.responseText);
                    var r = d.data && d.data.tweetResult && d.data.tweetResult.result;
                    if (!r) return;
                    if (r.__typename === 'TweetWithVisibilityResults') r = r.tweet;
                    if (!tweetId && r.legacy && r.legacy.conversation_id_str) tweetId = r.legacy.conversation_id_str;
                    captureVideoUrl(d, tweetId);
                } catch(e) {}
            });
        }
        return os.apply(this, arguments);
    };

    // captureVideoUrl: extract best MP4 from GraphQL data, store in _videoUrls
    function captureVideoUrl(d, tweetId) {
        if (!tweetId) return;
        try {
            var res = d.data && d.data.tweetResult && d.data.tweetResult.result;
            if (!res) return;
            if (res.__typename === 'TweetWithVisibilityResults') res = res.tweet;
            if (!res.legacy || !res.legacy.extended_entities) return;
            var media = res.legacy.extended_entities.media;
            if (!media) return;
            var best = null, br = -1;
            for (var i = 0; i < media.length; i++) {
                if (media[i].type !== 'video' && media[i].type !== 'animated_gif') continue;
                var v = media[i].video_info && media[i].video_info.variants;
                if (!v) continue;
                for (var j = 0; j < v.length; j++) {
                    if (v[j].content_type === 'video/mp4' && (v[j].bitrate || 0) > br) {
                        best = v[j].url; br = v[j].bitrate || 0;
                    }
                }
            }
            if (best) _videoUrls[tweetId] = best;
        } catch(e) {}
    }

    // ── Get tweet ID from DOM for a video player ────────
    function getTweetId(player) {
        var art = player.closest('article[data-testid="tweet"]');
        if (!art) return null;
        var links = art.querySelectorAll('a[href*="/status/"]');
        for (var i = 0; i < links.length; i++) {
            var m = links[i].href.match(/\/status\/(\d+)/);
            if (m) return m[1];
        }
        return null;
    }

    // ── CC button (injects into video controls) ─────────
    var SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186zm7.602 0c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"/></g></svg>';

    function mkCC() {
        var w = document.createElement('div'); w.className='css-175oi2r'; w.setAttribute('data-x-feature','cc'); w.setAttribute('data-on','0');
        var b = document.createElement('button'); b.setAttribute('aria-label','AI Captions'); b.setAttribute('role','button');
        b.className='css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        b.style.cssText='background:transparent;border-color:transparent;opacity:.5';
        var n=document.createElement('div'); n.dir='ltr'; n.className='css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        n.style.cssText='color:#fff'; n.innerHTML=SVG;
        b.appendChild(n); b.onclick=function(e){e.stopPropagation();toggleCC(w);}; w.appendChild(b); return w;
    }

    function videoPlayer() {
        var w=document.querySelector('[data-x-feature="cc"][data-on="1"]')||document.querySelector('[data-x-feature="cc"]');
        if(!w) return document.querySelector('[data-testid="videoPlayer"]');
        return w.closest('[data-testid="videoPlayer"]');
    }

    function toggleCC(w) {
        if (w.getAttribute('data-on') === '1') {
            w.setAttribute('data-on','0');
            var b=w.querySelector('button'); if(b) b.style.opacity='.5';
            hideCaps(); if(intv){clearInterval(intv);intv=null;} return;
        }
        w.setAttribute('data-on','1');
        var b=w.querySelector('button'); if(b) b.style.opacity='1';
        if(caps){showCaps();return;} if(busy){statusMsg('Working...');return;}

        // Look up video URL for this specific player
        var pl = w.closest('[data-testid="videoPlayer"]');
        var url = _videoUrls[getTweetId(pl)];
        if (!url) { statusMsg('No video data yet'); busy=false; return; }
        busy=true; w.setAttribute('data-busy','1'); statusMsg('Transcribing...'); transcribe(url);
    }

    // ── Caption positioning (follows controls bar) ──────
    var ctrlVis = true, hideTimer = null, paused = false;

    function hoverSetup(pl) {
        if (pl._hoverSetup) return; pl._hoverSetup = true;
        var vid = pl.querySelector('video');
        if (vid) vid.addEventListener('pause', function(){paused=true;updPos();});
        if (vid) vid.addEventListener('play', function(){paused=false;updPos();});
        function sc(){ctrlVis=true;if(hideTimer)clearTimeout(hideTimer);updPos();}
        function hc(){ctrlVis=false;updPos();}
        pl.addEventListener('mouseenter',sc);
        pl.addEventListener('mouseleave',hc);
        pl.addEventListener('mousemove',function(){
            ctrlVis=true; if(hideTimer)clearTimeout(hideTimer);
            hideTimer=setTimeout(function(){ctrlVis=false;updPos();},3000); updPos();
        });
    }
    function updPos() {
        var show = ctrlVis || paused;
        var els=document.querySelectorAll('[data-x-feature="co"]');
        for(var i=0;i<els.length;i++) els[i].style.bottom=show?'52px':'8px';
    }

    // ── Inject "Captions" item into gear menu ───────────
    function injMenu() {
        var mc = document.querySelector('[role="dialog"].r-tskmnb, [role="menu"].r-tskmnb');
        if (!mc || mc.querySelector('[data-x-gc]')) return;
        var ref = mc.children[0]; if (!ref) return;
        var ci = ref.cloneNode(true);
        ci.setAttribute('data-x-gc','1');
        if (!document.getElementById('x-gc-s')) {
            var st = document.createElement('style'); st.id = 'x-gc-s';
            st.textContent = '[data-x-gc]{background-color:transparent;transition:background-color .2s}[data-x-gc]:hover{background-color:rgba(255,255,255,0.03)}';
            document.head.appendChild(st);
        }
        var svg = ci.querySelector('svg');
        if (svg) svg.innerHTML = '<g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186zm7.602 0c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"/></g>';
        var ts = ci.querySelector('span span'); if (ts) ts.textContent = 'Captions';
        var vs = ci.querySelector('.r-16dba41 span'); if (vs) vs.textContent = '';
        ci.onclick = function(e) { e.stopPropagation(); e.preventDefault(); openSett(); };
        mc.appendChild(ci);
    }
    function watchMenu() {
        new MutationObserver(function(){injMenu();}).observe(document.body,{childList:true,subtree:true});
        injMenu();
    }

    // ── Settings panel ──────────────────────────────────
    function openSett() {
        var p = videoPlayer(); if (!p) return;
        var old = document.querySelector('[data-x-feature="xcs"]'); if(old) old.remove();
        var pan = document.createElement('div');
        pan.setAttribute('data-x-feature','xcs');
        pan.style.cssText='position:fixed;z-index:999999;background:rgba(0,0,0,0.95);color:#fff;padding:18px;border-radius:10px;font:13px/1.6 sans-serif;min-width:250px;pointer-events:auto;box-shadow:0 6px 20px rgba(0,0,0,0.6);';

        var langs = '';
        for (var k in LANG_MAP) langs += '<option value="'+k+'"'+(s.lang===k?' selected':'')+'>'+LANG_MAP[k]+'</option>';

        var provs = '';
        for (var pk in PROVIDERS)
            provs += '<option value="'+pk+'"'+(s.provider===pk?' selected':'')+'>'+PROVIDERS[pk].name+'</option>';
        var curProv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
        var curModels = curProv.models || {};
        var modelsHtml = '';
        for (var mk in curModels)
            modelsHtml += '<option value="'+mk+'"'+(s.model===mk?' selected':'')+'>'+curModels[mk]+'</option>';

        pan.innerHTML = '<div style="font-weight:bold;margin-bottom:12px;font-size:14px;border-bottom:1px solid #444;padding-bottom:6px;">Caption Settings</div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">AI PROVIDER</label>'+
            '<select id="xcs-provider" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+provs+'</select></div>'+
            '<div id="xcs-custom-fields" style="display:'+(s.provider.indexOf('cust_')===0?'block':'none')+';">'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">PROVIDER NAME</label><input id="xcs-cust-name" value="'+(curProv.name||'')+'" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;"></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">TRANSCRIBE URL</label><input id="xcs-cust-trans" value="'+(curProv.transcribe||'')+'" placeholder="https://api.example.com/v1/audio/transcriptions" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;"></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">CHAT URL</label><input id="xcs-cust-chat" value="'+(curProv.chat||'')+'" placeholder="https://api.example.com/v1/chat/completions" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;"></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">MODEL NAME</label><input id="xcs-cust-model" value="'+(s.model.indexOf('custom')>-1?s.model:'')+'" placeholder="my-model-name" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;"></div></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">MODEL</label>'+
            '<select id="xcs-model" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+modelsHtml+'</select></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">API KEY</label>'+
            '<input id="xcs-key" type="password" value="'+(curProv.key||'')+'" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;font-family:monospace;"></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">BACKGROUND</label>'+
            '<div style="display:flex;gap:6px;margin-top:2px;">'+
            '<input type="color" id="xcs-bg-picker" value="'+(s.bg.startsWith('#')?s.bg:'#000000')+'" style="width:36px;height:30px;padding:0;border:1px solid #555;border-radius:4px;background:transparent;cursor:pointer;">'+
            '<input id="xcs-bg" value="'+s.bg+'" style="flex:1;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;"></div></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">OPACITY</label>'+
            '<div style="display:flex;gap:6px;margin-top:2px;align-items:center;">'+
            '<input id="xcs-op" type="range" min="10" max="100" value="'+(s.bgOp||85)+'" style="flex:1;margin:0;">'+
            '<span id="xcs-op-val" style="font-size:11px;color:#aaa;min-width:28px;text-align:right;">'+(s.bgOp||85)+'%</span></div></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">FONT SIZE</label>'+
            '<input id="xcs-size" type="range" min="10" max="30" value="'+s.size+'" style="width:100%;margin:2px 0;">'+
            '<span id="xcs-size-val" style="font-size:11px;color:#aaa;">'+s.size+'px</span></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">LANGUAGE</label>'+
            '<select id="xcs-lang" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+langs+'</select></div>'+
            '<div style="margin-top:10px;display:flex;gap:4px;">'+
            '<button id="xcs-save" style="flex:1;background:#1d9bf0;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Save</button>'+
            '<button id="xcs-close" style="background:#444;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Cancel</button></div>';

        // Append to DOM first so we can measure dimensions
        document.body.appendChild(pan);
        // Now clamp position to viewport bounds
        var rect = p.getBoundingClientRect();
        var panW = pan.offsetWidth || 270;
        var panH = pan.offsetHeight || 400;
        var left = Math.max(10, rect.left + rect.width - panW);
        var top = rect.top;
        if (left + panW > window.innerWidth) left = window.innerWidth - panW - 10;
        if (top + panH > window.innerHeight) top = window.innerHeight - panH - 10;
        pan.style.left = Math.max(10, left) + 'px';
        pan.style.top = Math.max(10, top) + 'px';

        document.getElementById('xcs-provider').onchange = function() {
            var pk = this.value;
            var pv = PROVIDERS[pk];
            var custFields = document.getElementById('xcs-custom-fields');
            custFields.style.display = (pk.indexOf('cust_')===0) ? 'block' : 'none';
            if (!pv) return;
            var sel = document.getElementById('xcs-model');
            sel.innerHTML = '';
            for (var m in pv.models) {
                var opt = document.createElement('option');
                opt.value = m; opt.textContent = pv.models[m];
                if (m === pv.models) opt.selected = true;
                sel.appendChild(opt);
            }
            document.getElementById('xcs-key').value = pv.key || '';
            if (pk.indexOf('cust_')===0) {
                document.getElementById('xcs-cust-name').value = pv.name || '';
                document.getElementById('xcs-cust-trans').value = pv.transcribe || '';
                document.getElementById('xcs-cust-chat').value = pv.chat || '';
            }
        };
        document.getElementById('xcs-size').oninput = function() {
            document.getElementById('xcs-size-val').textContent = this.value + 'px';
        };
        document.getElementById('xcs-bg-picker').oninput = function() {
            document.getElementById('xcs-bg').value = this.value;
        };
        document.getElementById('xcs-op').oninput = function() {
            document.getElementById('xcs-op-val').textContent = this.value + '%';
        };

        document.getElementById('xcs-save').onclick = function() {
            var pk = document.getElementById('xcs-provider').value;
            if (pk.indexOf('cust_')===0) {
                var cp = loadCustomProv();
                var cid = pk.replace('cust_','');
                cp[cid] = cp[cid] || {};
                cp[cid].name = document.getElementById('xcs-cust-name').value || 'Custom';
                cp[cid].key = document.getElementById('xcs-key').value || '';
                cp[cid].transcribe_url = document.getElementById('xcs-cust-trans').value || '';
                cp[cid].chat_url = document.getElementById('xcs-cust-chat').value || '';
                cp[cid].model = document.getElementById('xcs-cust-model').value || 'custom-model';
                saveCustomProv(cp);
                buildProviders();
            } else if (PROVIDERS[pk]) {
                PROVIDERS[pk].key = document.getElementById('xcs-key').value || PROVIDERS[pk].key;
            }
            s.provider = pk || DEF.provider;
            s.model = document.getElementById('xcs-model').value || DEF.model;
            s.bg = document.getElementById('xcs-bg').value || DEF.bg;
            s.bgOp = parseInt(document.getElementById('xcs-op').value) || DEF.bgOp;
            s.size = document.getElementById('xcs-size').value || DEF.size;
            s.lang = document.getElementById('xcs-lang').value || 'en';
            localStorage.setItem(SKEY, JSON.stringify(s));
            var ct = document.getElementById('ct');
            if (ct) ct.style.cssText = 'display:inline-block;background:'+bgCSS()+';color:#fff;padding:8px 16px;border-radius:6px;font:'+s.size+'px/1.5 sans-serif;max-width:85%;text-align:center;text-shadow:0 0 3px #000,0 0 5px #000;';
            if (pan.parentNode) pan.remove();
        };
        document.getElementById('xcs-close').onclick = function() { if (pan.parentNode) pan.remove(); };
        setTimeout(function() {
            function clkOut(e) {
                if (!pan.contains(e.target)) { if (pan.parentNode) pan.remove(); document.removeEventListener('mousedown',clkOut,true); }
            }
            document.addEventListener('mousedown', clkOut, true);
        }, 100);
    }

    // ── Transcription (with retry) ──────────────────────
    function transcribe(url, attempt) {
        attempt = attempt || 1;
        var pv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
        var key = pv.key, model = s.model || DEF.model;
        if (!key) { busy=false; statusMsg('No API key set'); return; }
        if (!pv.transcribe) { busy=false; statusMsg('No transcribe URL'); return; }

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
            onload:function(r){ handleTranscribe(r); },
            onerror:function(){ retryTranscribe(url, attempt); },
            ontimeout:function(){ retryTranscribe(url, attempt); }
        });
    }

    function retryTranscribe(url, attempt) {
        if (!busy) return; // user toggled CC off
        if (attempt < 3) {
            statusMsg('Retrying (attempt ' + (attempt + 1) + ')...');
            setTimeout(function(){ transcribe(url, attempt + 1); }, 1500);
        } else {
            busy = false;
            var w = document.querySelector('[data-x-feature="cc"][data-busy]');
            if (w) w.removeAttribute('data-busy');
            statusMsg('API failed after 3 attempts');
        }
    }

    function handleTranscribe(r) {
        busy=false;
        var w = document.querySelector('[data-x-feature="cc"][data-busy]');
        if (w) w.removeAttribute('data-busy');
        try {
            var j=JSON.parse(r.responseText);
            if (j.segments && j.segments.length) {
                var raw = j.segments;
                if (s.lang === 'original') {
                    caps = raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});
                    hideCaps(); showCaps();
                } else {
                    statusMsg('Translating...');
                    var txts = raw.map(function(s){return s.text;}).join('\n');
                    var target = LANG_MAP[s.lang] || 'English';
                    var pv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
                    if (!pv.chat) {
                        caps = raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});
                        hideCaps(); showCaps();
                        return;
                    }
                    // Try the selected model first; on failure, the catch falls back to original text
                    var translateModel = s.model || 'mistral-small-latest';
                    GM_xmlhttpRequest({
                        method:'POST', url:pv.chat,
                        headers:{'Authorization':'Bearer '+pv.key,'Content-Type':'application/json'},
                        data:JSON.stringify({model:translateModel,messages:[{role:'user',content:'Translate these sentences to '+target+'. Return ONLY the translations, one per line, preserving the exact number of lines:\n'+txts}]}),
                        onload:function(r2) {
                            try {
                                var t = JSON.parse(r2.responseText);
                                var tr = t.choices[0].message.content.trim().split('\n');
                                caps = raw.map(function(s,i){return{start:s.start,end:s.end,text:(tr[i]||s.text).trim()};});
                            } catch(e) {
                                // Translation failed with selected model; retry with mistral-small-latest as fallback
                                if (translateModel !== 'mistral-small-latest' && s.provider === 'mistral') {
                                    statusMsg('Model failed, retrying with mistral-small-latest...');
                                    GM_xmlhttpRequest({
                                        method:'POST', url:pv.chat,
                                        headers:{'Authorization':'Bearer '+pv.key,'Content-Type':'application/json'},
                                        data:JSON.stringify({model:'mistral-small-latest',messages:[{role:'user',content:'Translate these sentences to '+target+'. Return ONLY the translations, one per line, preserving the exact number of lines:\n'+txts}]}),
                                        onload:function(r3) {
                                            try {
                                                var t2 = JSON.parse(r3.responseText);
                                                var tr2 = t2.choices[0].message.content.trim().split('\n');
                                                caps = raw.map(function(s,i){return{start:s.start,end:s.end,text:(tr2[i]||s.text).trim()};});
                                            } catch(e2) { caps = raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};}); }
                                            hideCaps(); showCaps();
                                        },
                                        onerror:function(){caps=raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});hideCaps();showCaps();}
                                    });
                                } else {
                                    caps = raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});
                                    hideCaps(); showCaps();
                                }
                            }
                            hideCaps(); showCaps();
                        },
                        onerror:function(){caps=raw.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});hideCaps();showCaps();}
                    });
                }
            } else if (j.text) {
                caps = [{start:0,end:120,text:j.text.trim()}]; hideCaps(); showCaps();
            } else { statusMsg('API error'); }
        } catch(e) { statusMsg('Parse error'); }
    }

    // ── Display ─────────────────────────────────────────
    function ctrlBottom(){return ctrlVis||paused?'52px':'8px';}

    function statusMsg(msg) {
        var p=videoPlayer(); if(!p) return; ripCaps(p);
        var o=document.createElement('div'); o.setAttribute('data-x-feature','co');
        o.style.cssText='position:absolute;bottom:'+ctrlBottom()+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t=document.createElement('div');
        t.style.cssText='display:inline-block;background:rgba(0,0,0,.75);color:#fff;padding:6px 14px;border-radius:6px;font:14px/1.4 sans-serif;max-width:80%;';
        t.textContent=msg; o.appendChild(t);
        var vc=p.querySelector('[data-testid="videoComponent"]'); if(vc) vc.appendChild(o);
    }
    function showCaps() {
        if(!caps) return; var p=videoPlayer(); if(!p) return; var v=p.querySelector('video'); if(!v) return;
        ripCaps(p); var o=document.createElement('div'); o.setAttribute('data-x-feature','co');
        o.style.cssText='position:absolute;bottom:'+ctrlBottom()+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t=document.createElement('div'); t.id='ct';
        t.style.cssText='display:inline-block;background:'+bgCSS()+';color:#fff;padding:8px 16px;border-radius:6px;font:'+s.size+'px/1.5 sans-serif;max-width:85%;text-align:center;text-shadow:0 0 3px #000,0 0 5px #000;';
        var c=v.currentTime; for(var i=0;i<caps.length;i++){if(c>=caps[i].start&&c<caps[i].end){t.textContent=caps[i].text;break;}}
        o.appendChild(t); var vc=p.querySelector('[data-testid="videoComponent"]'); if(vc) vc.appendChild(o);
        if(intv) clearInterval(intv); intv=setInterval(function(){
            if(!v) return; var c=v.currentTime,f='';
            for(var i=0;i<caps.length;i++){if(c>=caps[i].start&&c<caps[i].end){f=caps[i].text;break;}}
            t.textContent=f;
        },200);
    }
    function hideCaps(){var p=videoPlayer();if(p) ripCaps(p);}
    function ripCaps(p){var els=p.querySelectorAll('[data-x-feature="co"]');for(var i=0;i<els.length;i++)els[i].remove();}

    // ── Inject CC button into video players ─────────────
    function inject(pl) {
        if (pl.querySelector('[data-x-feature="cc"]')) return;
        if (pl.querySelector('[data-testid="captions"]')) return;
        var u=pl.querySelector('[aria-label="Unmute"]')||pl.querySelector('[aria-label="Mute"]');
        if (!u) return; var w=u.parentElement; if(!w) return; var c=w.parentElement; if(!c) return;
        hoverSetup(pl);
        c.insertBefore(mkCC(), w);
    }
    var rt=0;
    function tryGo(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');var ok=false;for(var i=0;i<ps.length;i++){inject(ps[i]);if(ps[i].querySelector('[data-x-feature="cc"]'))ok=true;}if(!ok&&rt<60){rt++;setTimeout(tryGo,500);}}
    function init(){
        // Inject loading animation styles
        if (!document.getElementById('x-cc-s')) {
            var st = document.createElement('style'); st.id = 'x-cc-s';
            st.textContent = '[data-x-feature="cc"][data-busy] button{animation:x-cc-pulse 1s ease-in-out infinite}[data-x-feature="cc"][data-busy] button svg{animation:x-cc-spin 2s linear infinite}@keyframes x-cc-pulse{0%,100%{opacity:.5}50%{opacity:1}}@keyframes x-cc-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}';
            document.head.appendChild(st);
        }
        watchMenu();
        startVideoWatcher();
        // Also catch any videos already in the DOM
        var existingVids = document.querySelectorAll('video');
        for (var v = 0; v < existingVids.length; v++) watchVideoElement(existingVids[v]);
        new MutationObserver(function(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');for(var i=0;i<ps.length;i++)inject(ps[i]);}).observe(document.body,{childList:true,subtree:true});
        tryGo();
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
