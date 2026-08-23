// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      1.4
// @description  AI captions for X/Twitter videos. Handles quoted tweets + translates existing native subtitles.
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

    // ES6 Maps with automatic cache pruning
    var _videoUrls = new Map();
    var _videoCaps = new Map();
    var _activeTweetId = null, busy = false, _cleanups = {};
    var SKEY = 'x_captions_settings';

    function cacheVideoUrl(tweetId, url) {
        if (_videoUrls.size >= 150) {
            var oldestKey = _videoUrls.keys().next().value;
            _videoUrls.delete(oldestKey);
        }
        _videoUrls.set(tweetId, url);
    }

    function cacheVideoCaps(tweetId, caps) {
        if (_videoCaps.size >= 50) {
            var oldestKey = _videoCaps.keys().next().value;
            _videoCaps.delete(oldestKey);
        }
        _videoCaps.set(tweetId, caps);
    }

    // ── Providers ────────────────────────────────────────
    var PROVIDERS = {};

    function loadCustomProv() {
        try { var raw = localStorage.getItem('x_captions_custom_providers'); return raw ? JSON.parse(raw) : {}; } catch(e) { return {}; }
    }
    function saveCustomProv(cp) { localStorage.setItem('x_captions_custom_providers', JSON.stringify(cp)); }

    function buildProviders() {
        PROVIDERS = {
            mistral: {name:'Mistral AI', key:'',  // Set your API key in Settings → AI Captions
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
    var KKEY = 'x_captions_api_keys';
    var DEF = {bg:'#000000', bgOp:85, size:'15', lang:'en', provider:'mistral', model:'voxtral-mini-latest', autoMute: false};
    var s = JSON.parse(localStorage.getItem(SKEY) || JSON.stringify(DEF));
    if (!s.provider) s.provider = DEF.provider;
    if (!s.model) s.model = DEF.model;
    if (s.bgOp === undefined) s.bgOp = DEF.bgOp;
    if (s.autoMute === undefined) s.autoMute = DEF.autoMute;
    if (s.bg && s.bg.startsWith('rgba')) { s.bg = DEF.bg; s.bgOp = DEF.bgOp; }

    function loadKeys() { try { return JSON.parse(localStorage.getItem(KKEY)) || {}; } catch(e) { return {}; } }
    function saveKey(providerId, key) {
        var k = loadKeys();
        if (key) k[providerId] = key; else delete k[providerId];
        localStorage.setItem(KKEY, JSON.stringify(k));
        if (PROVIDERS[providerId]) PROVIDERS[providerId].key = key || '';
    }
    // Restore persisted keys into providers at startup (built-ins + customs)
    (function restoreKeys() {
        var k = loadKeys();
        for (var pid in k) {
            if (PROVIDERS[pid]) PROVIDERS[pid].key = k[pid];
            else if (pid.indexOf('cust_') === 0 && PROVIDERS[pid]) PROVIDERS[pid].key = k[pid];
        }
    })();

    var LANG_MAP = {'en':'English','fr':'French','es':'Spanish','de':'German','ja':'Japanese','original':'Original'};

    function bgCSS() {
        var c = s.bg, o = (s.bgOp === undefined ? 85 : s.bgOp) / 100;
        var r = parseInt(c.slice(1,3),16) || 0;
        var g = parseInt(c.slice(3,5),16) || 0;
        var b = parseInt(c.slice(5,7),16) || 0;
        return 'rgba('+r+','+g+','+b+','+o+')';
    }

    // ── GraphQL video URL fetch (on-demand) ──────────────
    // WARNING: Do NOT use Object.defineProperty or unsafeWindow to wrap window.fetch.
    // Tampermonkey's cross-context sandbox causes "Permission denied to access property 'bind'"
    // errors in X.com's React bundle, breaking page load entirely.
    // Instead, we make a direct GraphQL call via GM_xmlhttpRequest when the user clicks CC.

    var GRAPHQL_TWEET_RESULT_ID = 'SgZWKwvBiOKrSC0QeOGvXw';
    var X_AUTH_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

    function getCookie(name) {
        var m = document.cookie.match(new RegExp('(?:^| )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    // Self-healing: read the current GraphQL Query ID from the page's scripts on each load
    function discoverGraphQLId() {
        // X.com embeds the GraphQL ID map in <script> tags with nonce
        var scripts = document.querySelectorAll('script[nonce]');
        for (var i = 0; i < scripts.length; i++) {
            var m = scripts[i].textContent.match(/TweetResultByRestId["']:\s*["']([a-zA-Z0-9_-]+)["']/);
            if (m) {
                GRAPHQL_TWEET_RESULT_ID = m[1];
                console.log('[X-Captions] Discovered GraphQL ID: ' + GRAPHQL_TWEET_RESULT_ID);
                return;
            }
        }
    }

    function fetchVideoUrlDirect(tweetId, cb) {
        var variables = {
            tweetId: tweetId,
            includePromotedContent: true,
            withBirdwatchNotes: true,
            withVoice: true,
            withCommunity: true
        };
        var features = {
            rweb_video_screen_enabled: false,
            rweb_cashtags_enabled: true,
            creator_subscriptions_tweet_preview_api_enabled: true,
            premium_content_api_read_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            responsive_web_grok_analyze_button_fetch_trends_enabled: false,
            responsive_web_grok_analyze_post_followups_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_grok_image_annotation_enabled: true,
            responsive_web_grok_imagine_annotation_enabled: true,
            responsive_web_grok_community_note_auto_translation_is_enabled: true,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            responsive_web_profile_redirect_enabled: false,
            rweb_tipjar_consumption_enabled: false,
            verified_phone_label_enabled: false,
            longform_notetweets_rich_text_read_enabled: true,
            view_counts_everywhere_api_enabled: true
        };
        var url = 'https://x.com/i/api/graphql/' + GRAPHQL_TWEET_RESULT_ID + '/TweetResultByRestId' +
            '?variables=' + encodeURIComponent(JSON.stringify(variables)) +
            '&features=' + encodeURIComponent(JSON.stringify(features));

        var ct0 = getCookie('ct0');
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
                'authorization': 'Bearer ' + X_AUTH_BEARER,
                'x-csrf-token': ct0,
                'x-twitter-auth-type': 'OAuth2Session',
                'x-twitter-client-language': 'en'
            },
            onload: function(r) {
                if (r.status !== 200) { cb(null); return; }
                try {
                    var d = JSON.parse(r.responseText);
                    captureVideoUrl(d, tweetId);
                    cb(_videoUrls.get(tweetId) || null);
                } catch(e) { cb(null); }
            },
            onerror: function() { cb(null); }
        });
    }

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
            if (best) cacheVideoUrl(tweetId, best);
        } catch(e) {}
    }

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

    // For quoted tweets: the video player sits inside the quote box, but the
    // first /status/ link found is often the OUTER tweet, not the one holding
    // the video. Walk up to the closest quoted-tweet container and read the
    // link inside it; fall back to any link in the article.
    function getTweetIdForPlayer(player) {
        // The player's own article-like ancestor that contains a status link
        var scope = player;
        while (scope && scope !== document.body) {
            var own = scope.querySelector ? scope.querySelectorAll('a[href*="/status/"]') : [];
            if (own.length) {
                for (var i = 0; i < own.length; i++) {
                    var m = own[i].href.match(/\/status\/(\d+)/);
                    if (m) return m[1];
                }
            }
            scope = scope.parentElement;
        }
        return getTweetId(player);
    }

    // ── CC button ────────────────────────────────────────
    var SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M14.1 2.5c1.103 0 1.991-.001 2.709.058.728.06 1.368.185 1.96.487.941.48 1.707 1.245 2.186 2.185.302.593.428 1.233.487 1.961.059.718.058 1.606.058 2.71V14.1c0 1.103.001 1.991-.058 2.709-.06.728-.185 1.368-.487 1.96-.48.941-1.245 1.707-2.185 2.186-.593.302-1.233.428-1.961.487-.718.059-1.606.058-2.71.058H9.9c-1.103 0-1.991.001-2.709-.058-.728-.06-1.368-.185-1.96-.487-.941-.48-1.707-1.245-2.186-2.185-.302-.593-.428-1.233-.487-1.961-.059-.718-.058-1.606-.058-2.71V9.9c0-1.103-.001-1.991.058-2.709.06-.728.185-1.368.487-1.96.48-.941 1.245-1.707 2.185-2.186.593-.302 1.233-.428 1.961-.487.718-.059 1.606-.058 2.71-.058H14.1zM9.007 8.785c-1.872 0-3.26 1.414-3.26 3.214v.02c0 1.846 1.42 3.196 3.187 3.196v-.003h.003c1.369 0 2.154-.592 2.737-1.394l-1.22-.87c-.304.443-.813.736-1.39.736-.93 0-1.685-.755-1.685-1.685s.754-1.684 1.684-1.684c.558 0 1.05.275 1.357.695l1.207-.935c-.545-.76-1.36-1.29-2.62-1.29zm6.582 0c-1.872 0-3.259 1.414-3.259 3.214v.02c0 1.846 1.422 3.196 3.186 3.196 1.368 0 2.154-.592 2.738-1.395l-1.22-.87c-.305.443-.813.736-1.39.736-.93 0-1.684-.756-1.684-1.686 0-.93.755-1.684 1.684-1.684.56 0 1.052.274 1.357.694l1.21-.935c-.547-.76-1.36-1.29-2.622-1.29z"/></g></svg>';

    function mkCC() {
        var w = document.createElement('div'); w.className='css-175oi2r'; w.setAttribute('data-x-feature','cc'); w.setAttribute('data-on','0');
        var b = document.createElement('button'); b.setAttribute('aria-label','AI Captions'); b.setAttribute('role','button');
        b.className='css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        b.style.cssText='background:transparent;border-color:transparent;';
        var n=document.createElement('div'); n.dir='ltr'; n.className='css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        n.style.cssText='color:#fff'; n.innerHTML=SVG;
        b.appendChild(n); b.onclick=function(e){e.stopPropagation();toggleCC(w);}; w.appendChild(b); return w;
    }

    // ── Native subtitle translation (shared with transcription path) ──
    function translateSegments(rawCaps, tweetId, done) {
        var pv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
        if (!pv.key || !pv.chat) { cacheVideoCaps(tweetId, rawCaps); done(rawCaps); return; }
        var txts = rawCaps.map(function(c){ return c.text; }).join('\n');
        var target = LANG_MAP[s.lang] || 'English';
        gmFetch({
            method:'POST', url:pv.chat,
            headers:{'Authorization':'Bearer '+pv.key,'Content-Type':'application/json'},
            data:JSON.stringify({model:'mistral-small-latest',messages:[{role:'user',content:'Translate these sentences to '+target+'. Return ONLY the translations, one per line, preserving the exact number of lines:\n'+txts}]})
        }).then(function(rt){
            try {
                var tj = JSON.parse(rt.responseText);
                var tr = tj.choices[0].message.content.trim().split('\n');
                cacheVideoCaps(tweetId, rawCaps.map(function(c,i){ return {start:c.start,end:c.end,text:(tr[i]||c.text).trim()}; }));
            } catch(e) { cacheVideoCaps(tweetId, rawCaps); }
            done();
        }).catch(function(){ cacheVideoCaps(tweetId, rawCaps); done(); });
    }

    function toggleCC_done(w) {
        // native-subtitle path completes without the busy flag; keep button lit
        w.setAttribute('data-on','1');
    }

    function videoPlayer() {
        var w=document.querySelector('[data-x-feature="cc"][data-on="1"]')||document.querySelector('[data-x-feature="cc"]');
        if(!w) return document.querySelector('[data-testid="videoPlayer"]');
        return w.closest('[data-testid="videoPlayer"]');
    }

    // Identifies the active playing/hovered video player in view
    function getFocusedVideoPlayer() {
        var vids = document.querySelectorAll('[data-testid="videoPlayer"] video');
        for (var i = 0; i < vids.length; i++) {
            if (!vids[i].paused) {
                return vids[i].closest('[data-testid="videoPlayer"]');
            }
        }
        return videoPlayer();
    }

    function toggleCC(w) {
        if (w.getAttribute('data-on') === '1') {
            w.setAttribute('data-on','0');
            var b=w.querySelector('button'); if(b) b.style.opacity='.5';
            hideCaps(); runCleanup(); return;
        }
        var active = document.querySelectorAll('[data-x-feature="cc"][data-on="1"]');
        for(var i=0;i<active.length;i++) {
            active[i].setAttribute('data-on','0');
            var b2=active[i].querySelector('button');
            if(b2) b2.style.opacity='.5';
        }
        w.setAttribute('data-on','1');
        var b=w.querySelector('button'); if(b) b.style.opacity='1';

        var pl = w.closest('[data-testid="videoPlayer"]');
        var tweetId = getTweetIdForPlayer(pl);
        if(!tweetId){w.setAttribute('data-on','0');return;}
        _activeTweetId = tweetId;

        if (_videoCaps.has(tweetId)){ hideCaps(); showCaps(); return; }
        if(busy){statusMsg('Working...'); return;}

        // Native captions present? Read them, translate to target language,
        // skip transcription entirely.
        var vid = pl.querySelector('video');
        if (vid && vid.textTracks && vid.textTracks.length > 0) {
            var track = null;
            for (var ti2 = 0; ti2 < vid.textTracks.length; ti2++) {
                if (vid.textTracks[ti2].cues && vid.textTracks[ti2].cues.length) { track = vid.textTracks[ti2]; break; }
                if (!track) track = vid.textTracks[ti2];
            }
            if (track && track.cues && track.cues.length) {
                busy = true; statusMsg('Reading native subtitles...');
                try {
                    track.mode = 'hidden';
                    var rawCaps = [];
                    for (var ci2 = 0; ci2 < track.cues.length; ci2++) {
                        var cue = track.cues[ci2];
                        rawCaps.push({start: cue.startTime, end: cue.endTime, text: (cue.text||'').replace(/<[^>]*>/g,'').trim()});
                    }
                    rawCaps = rawCaps.filter(function(c){ return c.text; });
                    if (!rawCaps.length) { busy=false; }
                    else {
                        cacheVideoCaps(tweetId, rawCaps);
                        _activeTweetId = tweetId;
                        // If target lang is 'original' just show them; else translate via chat API
                        if (s.lang === 'original') {
                            busy = false; hideCaps(); showCaps();
                            toggleCC_done(w);
                            return;
                        }
                        statusMsg('Translating native subtitles...');
                        translateSegments(rawCaps, tweetId, function(finalCaps){
                            busy = false; hideCaps(); showCaps(); toggleCC_done(w);
                        });
                        return;
                    }
                } catch(e) { busy = false; /* fall through to transcription */ }
            }
        }

        var url = _videoUrls.get(tweetId);
        if (!url) {
            busy=true; w.setAttribute('data-busy','1'); statusMsg('Fetching video data...');
            fetchVideoUrlDirect(tweetId, function(newUrl) {
                if (newUrl) {
                    cacheVideoUrl(tweetId, newUrl);
                    statusMsg('Transcribing...');
                    transcribe(newUrl, tweetId);
                } else {
                    busy=false;
                    w.removeAttribute('data-busy');
                    statusMsg('No video data yet. Try clicking the video to play it first, then click AI Captions.');
                }
            });
            return;
        }
        busy=true; w.setAttribute('data-busy','1'); statusMsg('Transcribing...'); transcribe(url, tweetId);
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

    // Setup listener to automatically trigger captions if a video plays muted
    function setupAutoMute(pl) {
        var vid = pl.querySelector('video');
        if (!vid) return;
        if (vid._autoMuteSetup) return;
        vid._autoMuteSetup = true;

        var checkMute = function() {
            if (s.autoMute && vid.muted && !vid.paused) {
                var cc = pl.querySelector('[data-x-feature="cc"]');
                if (cc && cc.getAttribute('data-on') !== '1' && !busy) {
                    toggleCC(cc);
                }
            }
        };
        vid.addEventListener('play', checkMute);
        vid.addEventListener('volumechange', checkMute);
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
        if (svg) svg.innerHTML = '<g><path d="M9.007 8.785c1.26 0 2.075.53 2.62 1.29l-1.207.935c-.306-.42-.799-.695-1.357-.695-.93 0-1.684.754-1.684 1.684 0 .93.755 1.684 1.684 1.684.578 0 1.087-.292 1.39-.735l1.22.87c-.582.802-1.367 1.394-2.736 1.394h-.002l-.002.003c-1.766 0-3.187-1.35-3.187-3.187s1.421-3.186 3.187-3.186z"/></g>';
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
            '<div style="margin:8px 0;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="xcs-automute" '+(s.autoMute?'checked':'')+' style="width:14px;height:14px;margin:0;cursor:pointer;"><label for="xcs-automute" style="color:#aaa;font-size:11px;cursor:pointer;user-select:none;">AUTO-CAPTION ON MUTE</label></div>'+
            '<div style="margin-top:10px;display:flex;gap:4px;">'+
            '<button id="xcs-save" style="flex:1;background:#1d9bf0;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Save</button>'+
            '<button id="xcs-close" style="background:#444;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Cancel</button></div>';

        document.body.appendChild(pan);
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
                saveKey(pk, document.getElementById('xcs-key').value.trim());
            }
            s.provider = pk || DEF.provider;
            s.model = document.getElementById('xcs-model').value || DEF.model;
            s.bg = document.getElementById('xcs-bg').value || DEF.bg;
            s.bgOp = parseInt(document.getElementById('xcs-op').value) || DEF.bgOp;
            s.size = document.getElementById('xcs-size').value || DEF.size;
            s.lang = document.getElementById('xcs-lang').value || 'en';
            s.autoMute = document.getElementById('xcs-automute').checked;
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

    function gmFetch(opts) {
        return new Promise(function(resolve, reject) {
            GM_xmlhttpRequest({
                method: opts.method || 'GET', url: opts.url,
                headers: opts.headers || {}, data: opts.data || null,
                onload: resolve, onerror: reject, ontimeout: reject
            });
        });
    }

    async function transcribe(url, tweetId) {
        var pv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
        var key = pv.key, model = s.model || DEF.model;
        if (!key) { busy=false; statusMsg('No API key set. Open Settings → AI Captions to set one.'); return; }
        if (!pv.transcribe) { busy=false; statusMsg('No transcribe URL'); return; }

        var bd = '----FB'+Math.random().toString(36).slice(2);
        var parts = [];
        parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="model"'); parts.push(''); parts.push(model);
        parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="file_url"'); parts.push(''); parts.push(url);
        parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="timestamp_granularities"'); parts.push(''); parts.push('segment');
        parts.push('--'+bd+'--');

        var r;
        for (var attempt = 1; attempt <= 3; attempt++) {
            if (attempt > 1) {
                statusMsg('Retrying (attempt ' + attempt + ')...');
                await new Promise(function(r2){ setTimeout(r2, 1500); });
            }
            try {
                r = await gmFetch({
                    method:'POST', url:pv.transcribe,
                    headers:{'Authorization':'Bearer '+key,'Content-Type':'multipart/form-data; boundary='+bd},
                    data:parts.join('\r\n')
                });
                break;
            } catch(e) {
                if (attempt === 3) {
                    busy=false;
                    var w3 = document.querySelector('[data-x-feature="cc"][data-busy]');
                    if (w3) w3.removeAttribute('data-busy');
                    statusMsg('API failed after 3 attempts');
                    return;
                }
            }
        }

        busy=false;
        var w = document.querySelector('[data-x-feature="cc"][data-busy]');
        if (w) w.removeAttribute('data-busy');
        if (!tweetId) { statusMsg('No tweet ID'); return; }

        try {
            var j = JSON.parse(r.responseText);
            if (j.segments && j.segments.length) {
                var raw = j.segments.map(function(s){ return {start:s.start, end:s.end, text:(s.text||'').trim()}; });
                if (s.lang === 'original') {
                    cacheVideoCaps(tweetId, raw);
                    hideCaps(); _activeTweetId = tweetId; showCaps();
                } else {
                    statusMsg('Translating...');
                    var txts = j.segments.map(function(s){ return s.text; }).join('\n');
                    var target = LANG_MAP[s.lang] || 'English';
                    if (!pv.chat) {
                        cacheVideoCaps(tweetId, raw);
                        hideCaps(); _activeTweetId = tweetId; showCaps();
                        return;
                    }
                    var didTranslate = false;
                    var translateModel = s.model || 'mistral-small-latest';
                    for (var ti = 0; ti < 2; ti++) {
                        try {
                            var rt = await gmFetch({
                                method:'POST', url:pv.chat,
                                headers:{'Authorization':'Bearer '+pv.key,'Content-Type':'application/json'},
                                data:JSON.stringify({model:translateModel,messages:[{role:'user',content:'Translate these sentences to '+target+'. Return ONLY the translations, one per line, preserving the exact number of lines:\n'+txts}]})
                            });
                            var tj = JSON.parse(rt.responseText);
                            var tr = tj.choices[0].message.content.trim().split('\n');
                            var translated = j.segments.map(function(s,i){ return {start:s.start, end:s.end, text:(tr[i]||s.text).trim()}; });
                            cacheVideoCaps(tweetId, translated);
                            didTranslate = true;
                            break;
                        } catch(e) {
                            if (ti === 0 && translateModel !== 'mistral-small-latest' && s.provider === 'mistral') {
                                statusMsg('Model failed, retrying with mistral-small-latest...');
                                translateModel = 'mistral-small-latest';
                            } else {
                                break;
                            }
                        }
                    }
                    if (!didTranslate) cacheVideoCaps(tweetId, raw);
                    hideCaps(); _activeTweetId = tweetId; showCaps();
                }
            } else if (j.text) {
                cacheVideoCaps(tweetId, [{start:0,end:120,text:j.text.trim()}]);
                hideCaps(); _activeTweetId = tweetId; showCaps();
            } else if (j.segments && j.segments.length === 0) {
                statusMsg('No speech detected');
            } else {
                statusMsg('API error');
            }
        } catch(e) {
            statusMsg('Parse error');
        }
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
        var caps = _videoCaps.get(_activeTweetId); if(!caps) return;
        var p=videoPlayer(); if(!p) return; var v=p.querySelector('video'); if(!v) return;
        ripCaps(p); var o=document.createElement('div'); o.setAttribute('data-x-feature','co');
        o.style.cssText='position:absolute;bottom:'+ctrlBottom()+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        var t=document.createElement('div'); t.id='ct';
        t.style.cssText='display:inline-block;background:'+bgCSS()+';color:#fff;padding:8px 16px;border-radius:6px;font:'+s.size+'px/1.5 sans-serif;max-width:85%;text-align:center;text-shadow:0 0 3px #000,0 0 5px #000;';
        var c=v.currentTime; for(var i=0;i<caps.length;i++){if(c>=caps[i].start&&c<caps[i].end){t.textContent=caps[i].text;break;}}
        o.appendChild(t); var vc=p.querySelector('[data-testid="videoComponent"]'); if(vc) vc.appendChild(o);
        runCleanup(_activeTweetId);
        var capFn = function() {
            var caps2 = _videoCaps.get(_activeTweetId); if(!caps2||!v) return;
            var c=v.currentTime,f='';
            for(var i=0;i<caps2.length;i++){if(c>=caps2[i].start&&c<caps2[i].end){f=caps2[i].text;break;}}
            t.textContent=f;
        };
        v.addEventListener('timeupdate', capFn);
        _cleanups[_activeTweetId] = function() { v.removeEventListener('timeupdate', capFn); };
    }
    function hideCaps(){var p=videoPlayer();if(p) ripCaps(p);}
    function ripCaps(p){var els=p.querySelectorAll('[data-x-feature="co"]');for(var i=0;i<els.length;i++)els[i].remove();}
    function runCleanup(tweetId) {
        if (tweetId && _cleanups[tweetId]) { _cleanups[tweetId](); delete _cleanups[tweetId]; }
        else { for (var k in _cleanups) { _cleanups[k](); } _cleanups = {}; }
    }

    // ── Inject CC button into video players ─────────────
    function inject(pl) {
        if (pl.querySelector('[data-x-feature="cc"]')) return;
        if (pl.querySelector('[data-testid="captions"]')) return;
        var u=pl.querySelector('[aria-label="Unmute"]')||pl.querySelector('[aria-label="Mute"]');
        if (!u) return;
        var w=u.parentElement; if(!w) return; var c=w.parentElement; if(!c) return;
        hoverSetup(pl);
        c.insertBefore(mkCC(), w);
        setupAutoMute(pl);
    }

    var rt=0, pollIntv=null;
    function tryGo(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');var ok=false;for(var i=0;i<ps.length;i++){inject(ps[i]);if(ps[i].querySelector('[data-x-feature="cc"]'))ok=true;}if(!ok&&rt<60){rt++;setTimeout(tryGo,500);}}
    function retryInject(pl, tries) {
        if (tries > 15 || pl.querySelector('[data-x-feature="cc"]')) return;
        inject(pl);
        if (!pl.querySelector('[data-x-feature="cc"]'))
            setTimeout(function(){ retryInject(pl, tries + 1); }, 800);
    }

    // Continuous poll: checks DOM once every 3 seconds for un-injected players
    function startPoll() {
        if (pollIntv) return;
        pollIntv = setInterval(function() {
            var ps = document.querySelectorAll('[data-testid="videoPlayer"]');
            for (var i = 0; i < ps.length; i++) {
                if (!ps[i].querySelector('[data-x-feature="cc"]'))
                    inject(ps[i]);
            }
        }, 3000);
    }

    // Debounced observer trigger to prevent UI lag on scroll
    var injectTimeout = null;
    function triggerDebouncedInjection() {
        if (injectTimeout) return;
        injectTimeout = setTimeout(function() {
            injectTimeout = null;
            var ps = document.querySelectorAll('[data-testid="videoPlayer"]');
            for(var i=0; i<ps.length; i++){
                if(!ps[i].querySelector('[data-x-feature="cc"]')) {
                    retryInject(ps[i], 0);
                }
            }
        }, 150);
    }

    // ── Keyboard shortcut Alt+Shift+C ───────────────────
    document.addEventListener('keydown', function(ke) {
        if (ke.altKey && ke.shiftKey && (ke.key === 'C' || ke.key === 'c' || ke.keyCode === 67)) {
            ke.preventDefault();
            ke.stopPropagation();
            var activePlayer = getFocusedVideoPlayer();
            if (activePlayer) {
                var cc = activePlayer.querySelector('[data-x-feature="cc"]');
                if (cc) toggleCC(cc);
            }
        }
    }, true);

    function init(){
        // Discover GraphQL ID from page scripts
        setTimeout(discoverGraphQLId, 100);

        if (!document.getElementById('x-cc-s')) {
            var st = document.createElement('style'); st.id = 'x-cc-s';
            st.textContent = '[data-x-feature="cc"][data-busy] button{animation:x-cc-pulse 1s ease-in-out infinite}[data-x-feature="cc"][data-busy] button svg{animation:x-cc-spin 2s linear infinite}@keyframes x-cc-pulse{0%,100%{opacity:.5}50%{opacity:1}}@keyframes x-cc-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}';
            document.head.appendChild(st);
        }
        watchMenu();

        // Optimized observer: only scans if DOM additions actually occurred
        new MutationObserver(function(mutations){
            var added = false;
            for (var i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes.length > 0) {
                    added = true;
                    break;
                }
            }
            if (added) {
                triggerDebouncedInjection();
            }
        }).observe(document.body,{childList:true,subtree:true});

        tryGo();
        startPoll();
        console.log('[X-Captions] v1.3 loaded — Use Alt+Shift+C to toggle captions on the active playing video.');
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
