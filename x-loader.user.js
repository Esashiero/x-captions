// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      2.5
// @description  AI captions for X/Twitter videos. Handles quoted tweets + translates existing native subtitles.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @grant        unsafeWindow
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
    var _activeTweetId = null, busyFor = null, _cleanups = {};
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
            _capsInfo.delete(oldestKey);
        }
        _videoCaps.set(tweetId, caps);
    }
    var _capsInfo = new Map();
    function setCapsInfo(key, ok) {
        _capsInfo.set(key, {translated: !!ok, failed: !ok, ts: Date.now()});
    }

    // ── Providers ────────────────────────────────────────
    var PROVIDERS = {};

    function loadCustomProv() {
        try {
            var v = GM_getValue('x_captions_custom_providers', null);
            if (v) return (typeof v === 'string' ? JSON.parse(v) : v) || {};
            var legacy = localStorage.getItem('x_captions_custom_providers');
            if (legacy) {
                var parsed = JSON.parse(legacy) || {};
                GM_setValue('x_captions_custom_providers', JSON.stringify(parsed));
                localStorage.removeItem('x_captions_custom_providers');
                return parsed;
            }
        } catch(e) {}
        return {};
    }
    function saveCustomProv(cp) { GM_setValue('x_captions_custom_providers', JSON.stringify(cp)); }

    function buildProviders() {
        PROVIDERS = {
            mistral: {name:'Mistral AI', key:'',  // Set your API key in Settings → AI Captions
                models:{'voxtral-mini-transcribe-3':'Voxtral Mini 3','voxtral-small-transcribe-3':'Voxtral Small 3'},
                transcribe:'https://api.mistral.ai/v1/audio/transcriptions',
                chat:'https://api.mistral.ai/v1/conversations',
                 chatMode:'conversations'}
        };
        var cp = loadCustomProv();
        for (var k in cp) {
            var p = cp[k], m = {};
            m[p.model || 'custom-model'] = p.model || 'Custom Model';
            PROVIDERS['cust_'+k] = {
                name: p.name || 'Custom', key: p.key || '', models: m,
                transcribe: p.transcribe_url || '', chat: p.chat_url || '',
                chatMode: p.chat_mode || 'chat'
            };
        }
    }
    buildProviders();

    // ── Settings ─────────────────────────────────────────
    var KKEY = 'x_captions_api_keys';
    var DEF = {bg:'#000000', bgOp:85, size:'15', lang:'en', provider:'mistral', model:'voxtral-mini-transcribe-3', translateModel:'mistral-small-latest', autoMute: false, autoCaption: false, skipLangs:''};
    var s;
    try { s = JSON.parse(localStorage.getItem(SKEY) || JSON.stringify(DEF)); }
    catch(e) { s = JSON.parse(JSON.stringify(DEF)); }
    if (!s.provider) s.provider = DEF.provider;
    if (!s.model || s.model === 'voxtral-mini-latest' || s.model === 'voxtral-latest') s.model = DEF.model;
    if (s.bgOp === undefined) s.bgOp = DEF.bgOp;
    if (s.autoMute === undefined) s.autoMute = DEF.autoMute;
    if (s.autoCaption === undefined) s.autoCaption = DEF.autoCaption;
    if (!s.translateModel) s.translateModel = DEF.translateModel;
    if (s.skipLangs === undefined) s.skipLangs = DEF.skipLangs;
    if (s.bg && s.bg.startsWith('rgba')) { s.bg = DEF.bg; s.bgOp = DEF.bgOp; }

    function loadKeys() {
        try {
            var v = GM_getValue(KKEY, null);
            if (v) return (typeof v === 'string' ? JSON.parse(v) : v) || {};
            var legacy = localStorage.getItem(KKEY);
            if (legacy) {
                var parsed = JSON.parse(legacy) || {};
                GM_setValue(KKEY, JSON.stringify(parsed));
                localStorage.removeItem(KKEY);
                return parsed;
            }
        } catch(e) { if (typeof console !== 'undefined') console.warn('[X-Captions] key load failed', e); }
        return {};
    }
    function saveKey(providerId, key) {
        var k = loadKeys();
        if (key) k[providerId] = key; else delete k[providerId];
        GM_setValue(KKEY, JSON.stringify(k));
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

    var GQL_CACHE_KEY = 'x_captions_gql_id';
    function readCachedGqlId() {
        try {
            var raw = localStorage.getItem(GQL_CACHE_KEY);
            if (!raw) return '';
            // Support both plain string and {id, ts} format
            if (raw.charAt(0) === '{') {
                var obj = JSON.parse(raw);
                if (obj && obj.id && obj.ts && (Date.now() - obj.ts < 86400000)) return obj.id;
                localStorage.removeItem(GQL_CACHE_KEY);
                return '';
            }
            return raw;
        } catch(e) { return ''; }
    }
    function writeCachedGqlId(id) {
        try { if (id) localStorage.setItem(GQL_CACHE_KEY, JSON.stringify({id: id, ts: Date.now()})); } catch(e) {}
    }


    // Seed from cache on load
    (function() { var c = readCachedGqlId(); if (c) GRAPHQL_TWEET_RESULT_ID = c; })();

    function discoverGraphQLId(cb) {
        var scripts = document.querySelectorAll('script[nonce]');
        for (var i = 0; i < scripts.length; i++) {
            var m = scripts[i].textContent.match(/TweetResultByRestId["']:\s*["']([a-zA-Z0-9_-]+)["']/);
            if (m) { setGraphQLId(m[1], 'inline map', cb); return; }
        }
        var mainSrc = null;
        var srcs = document.querySelectorAll('script[src]');
        for (var k = 0; k < srcs.length; k++) {
            if (/\/client-web\/main\.[a-f0-9]+\.js/.test(srcs[k].src)) { mainSrc = srcs[k].src; break; }
        }
        if (!mainSrc) { if (cb) cb(false); return; }
        GM_xmlhttpRequest({
            method: 'GET', url: mainSrc,
            onload: function(r) {
                if (r.status !== 200) { if (cb) cb(false); return; }
                var m2 = r.responseText.match(/operationName:"TweetResultByRestId",queryId:"([A-Za-z0-9_-]+)"/) ||
                         r.responseText.match(/queryId:"([A-Za-z0-9_-]+)"[^}]*operationName:"TweetResultByRestId"/) ||
                         r.responseText.match(/"operationName":"TweetResultByRestId","queryId":"([A-Za-z0-9_-]+)"/) ||
                         r.responseText.match(/"queryId":"([A-Za-z0-9_-]+)"[^}]*"operationName":"TweetResultByRestId"/);
                if (m2) { setGraphQLId(m2[1], 'bundle', cb); }
                else { if (cb) cb(false); }
            },
            onerror: function() { if (cb) cb(false); }
        });
    }
    function setGraphQLId(id, src, cb) {
        if (!id || id === GRAPHQL_TWEET_RESULT_ID) { if (cb) cb(!!id); return; }
        GRAPHQL_TWEET_RESULT_ID = id;
        writeCachedGqlId(id);
        console.log('[X-Captions] GraphQL ID from ' + src + ': ' + id);
        if (cb) cb(true);
    }

    function fetchVideoUrlDirect(tweetId, key, idx, cb, isRetry) {
        if (!isRetry && !readCachedGqlId()) {
            discoverGraphQLId(function(){ fetchVideoUrlDirect(tweetId, key, idx, cb, true); });
            return;
        }
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
                if (r.status === 400 || r.status === 404) {
                    // Cached GraphQL ID may be stale — invalidate and rediscover
                    localStorage.removeItem(GQL_CACHE_KEY);
                    if (!isRetry) {
                        discoverGraphQLId(function(){ fetchVideoUrlDirect(tweetId, key, idx, cb, true); });
                        return;
                    }
                    cb(null); return;
                }
                if (r.status !== 200) { cb(null); return; }
                try {
                    var d = JSON.parse(r.responseText);
                    captureVideoUrl(d, key, idx);
                    cb(_videoUrls.get(key) || null);
                } catch(e) { cb(null); }
            },
            onerror: function() { cb(null); }
        });
    }

    function captureVideoUrl(d, key, idx) {
        var tweetId = key ? key.split('#')[0] : null;
        if (!tweetId) return;
        try {
            var res = d.data && d.data.tweetResult && d.data.tweetResult.result;
            if (!res) return;
            if (res.__typename === 'TweetWithVisibilityResults') res = res.tweet;
            // Quoted tweets: the outer tweet has no media, but quoted_status_result does.
            var candidates = [res];
            if (res.quoted_status_result && res.quoted_status_result.result) {
                var q = res.quoted_status_result.result;
                if (q.__typename === 'TweetWithVisibilityResults') q = q.tweet;
                candidates.push(q);
            }
            var all = [];
            for (var ci = 0; ci < candidates.length; ci++) {
                var c = candidates[ci];
                if (!c || !c.legacy || !c.legacy.extended_entities) continue;
                var media = c.legacy.extended_entities.media || [];
                for (var i = 0; i < media.length; i++) {
                    if (media[i].type !== 'video' && media[i].type !== 'animated_gif') continue;
                    var v = media[i].video_info && media[i].video_info.variants, best = null, br = -1;
                    for (var j = 0; v && j < v.length; j++) {
                        if (v[j].content_type === 'video/mp4' && (v[j].bitrate || 0) > br) { best = v[j].url; br = v[j].bitrate || 0; }
                    }
                    if (best) all.push(best);
                }
            }
            var pick = all[idx] || all[0];
            if (pick) cacheVideoUrl(key, pick);
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

    function nativeTrackInfo(pl) {
        var vid = pl ? pl.querySelector('video') : null;
        if (!vid || !vid.textTracks || !vid.textTracks.length) return {hasNative:false, inTargetLang:false, trackLang:''};
        var track = null;
        for (var i = 0; i < vid.textTracks.length; i++) {
            if (vid.textTracks[i].cues && vid.textTracks[i].cues.length) { track = vid.textTracks[i]; break; }
            if (!track) track = vid.textTracks[i];
        }
        if (!track) return {hasNative:false, inTargetLang:false, trackLang:''};
        var tl = (track.language || '').toLowerCase().slice(0, 2);
        // Detect actual language from text content — X sometimes mislabels
        // (e.g. Russian audio labeled as 'en'). Check for Cyrillic.
        var sampleText = '';
        if (track.cues && track.cues.length) {
            for (var _ci = 0; _ci < Math.min(track.cues.length, 5); _ci++) {
                sampleText += (track.cues[_ci].text || '') + ' ';
            }
        }
        var hasCyrillic = /[\u0400-\u04FF]/.test(sampleText);
        if (hasCyrillic && tl === 'en') tl = 'ru';
        // Blacklist check: if native lang is in skipLangs, treat as in-target (don't translate)
        var skipList = (s.skipLangs || '').toLowerCase().split(/[,\s]+/).filter(function(x){return x;});
        var isSkipped = skipList.indexOf(tl) >= 0;
        var target = (s.lang === 'original') ? tl : s.lang;
        return {hasNative:true, inTargetLang: (tl === target || s.lang === 'original' || isSkipped), trackLang: tl, skipped: isSkipped};
    }

    function mediaKey(pl) {
        if (!pl) return null;
        var art = pl.closest('article[data-testid="tweet"]') || document.body;
        var players = art.querySelectorAll('[data-testid="videoPlayer"]'), idx = 0;
        for (var i = 0; i < players.length; i++) if (players[i] === pl) { idx = i; break; }
        var tid = getTweetIdForPlayer(pl);
        return tid ? tid + '#' + idx : null;
    }

    // ── CC button ────────────────────────────────────────
    var SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-z80fyv r-19wmn03"><g><path d="M14.1 2.5c1.103 0 1.991-.001 2.709.058.728.06 1.368.185 1.96.487.941.48 1.707 1.245 2.186 2.185.302.593.428 1.233.487 1.961.059.718.058 1.606.058 2.71V14.1c0 1.103.001 1.991-.058 2.709-.06.728-.185 1.368-.487 1.96-.48.941-1.245 1.707-2.185 2.186-.593.302-1.233.428-1.961.487-.718.059-1.606.058-2.71.058H9.9c-1.103 0-1.991.001-2.709-.058-.728-.06-1.368-.185-1.96-.487-.941-.48-1.707-1.245-2.186-2.185-.302-.593-.428-1.233-.487-1.961-.059-.718-.058-1.606-.058-2.71V9.9c0-1.103-.001-1.991.058-2.709.06-.728.185-1.368.487-1.96.48-.941 1.245-1.707 2.185-2.186.593-.302 1.233-.428 1.961-.487.718-.059 1.606-.058 2.71-.058H14.1zM9.007 8.785c-1.872 0-3.26 1.414-3.26 3.214v.02c0 1.846 1.42 3.196 3.187 3.196v-.003h.003c1.369 0 2.154-.592 2.737-1.394l-1.22-.87c-.304.443-.813.736-1.39.736-.93 0-1.685-.755-1.685-1.685s.754-1.684 1.684-1.684c.558 0 1.05.275 1.357.695l1.207-.935c-.545-.76-1.36-1.29-2.62-1.29zm6.582 0c-1.872 0-3.259 1.414-3.259 3.214v.02c0 1.846 1.422 3.196 3.186 3.196 1.368 0 2.154-.592 2.738-1.395l-1.22-.87c-.305.443-.813.736-1.39.736-.93 0-1.684-.756-1.684-1.686 0-.93.755-1.684 1.684-1.684.56 0 1.052.274 1.357.694l1.21-.935c-.547-.76-1.36-1.29-2.622-1.29z"/></g></svg>';

    function mkCC() {
        var w = document.createElement('div'); w.className='css-175oi2r'; w.setAttribute('data-x-feature','cc'); w.setAttribute('data-on','0');
        var b = document.createElement('button'); b.setAttribute('aria-label','AI Captions'); b.setAttribute('role','button');
        b.className='css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l';
        b.style.cssText='background:rgba(0,0,0,.55);border-color:transparent;border-radius:9999px;padding:4px;';
        var n=document.createElement('div'); n.dir='ltr'; n.className='css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci';
        n.style.cssText='color:#fff'; n.innerHTML=SVG;
        b.appendChild(n); b.onclick=function(e){e.stopPropagation();toggleCC(w);}; w.appendChild(b); return w;
    }

    var TRANSLATE_MODEL_DEF = 'mistral-small-latest';

    function translatePrompt(lines, target) {
        return 'Translate these ' + lines.length + ' sentences to ' + target +
               '. Return ONLY a JSON object with a "translations" array of exactly ' + lines.length +
               ' strings, in the same order. No other text, no markdown.\n' +
               lines.map(function(l, i) { return (i + 1) + '. ' + l; }).join('\n');
    }

    function httpErr(tag, r) {
        var msg = '';
        try {
            var j = JSON.parse(r.responseText);
            msg = j.message || (j.error && j.error.message) ||
                  (typeof j.error === 'string' ? j.error : '') || '';
        } catch(e) { msg = (r.responseText || '').slice(0, 120); }
        var e = new Error(tag + ' HTTP ' + r.status + (msg ? ': ' + msg : ''));
        e.status = r.status; e.body = msg; return e;
    }

    function translateLinesWithFeedback(pv, lines, target, model, feedback, useJsonMode) {
        if (useJsonMode === undefined) useJsonMode = true;
        var prompt = translatePrompt(lines, target) + '\n\n' + feedback;
        var conv = pv.chatMode === 'conversations';
        var body;
        if (useJsonMode) {
            var rf = {type: 'json_object'};
            body = conv
                ? {model:model, inputs:[{role:'user', content:prompt}], tools:[],
                   completion_args:{temperature:0, max_tokens:4096, top_p:1, response_format: rf}, instructions:''}
                : {model:model, messages:[{role:'user', content:prompt}], response_format: rf};
        } else {
            body = conv
                ? {model:model, inputs:[{role:'user', content:prompt}], tools:[],
                   completion_args:{temperature:0, max_tokens:4096, top_p:1}, instructions:''}
                : {model:model, messages:[{role:'user', content:prompt}]};
        }
        return gmFetch({
            method:'POST', url:pv.chat,
            headers:{'Authorization':'Bearer '+pv.key, 'Content-Type':'application/json'},
            data:JSON.stringify(body)
        }).then(function(r) {
            if (r.status < 200 || r.status >= 300) throw httpErr('translate', r);
            var j = JSON.parse(r.responseText), text = null;
            if (conv) text = j.outputs && j.outputs[0] && j.outputs[0].content;
            else text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            if (!text) throw new Error('translate: empty response');
            var translations = null;
            try {
                var parsed = JSON.parse(text.trim());
                if (parsed && Array.isArray(parsed.translations)) {
                    translations = parsed.translations.map(function(x, _i) { var t = String(x).trim(); return t || (lines[_i] || ''); });
                }
            } catch(e) {}
            if (!translations) {
                translations = text.trim().split('\n').map(function(x) { return x.trim(); })
                    .filter(function(x) { return x.length > 0; });
            }
            return translations;
        });
    }

    function translateLines(pv, lines, target, model, useJsonMode) {
        if (useJsonMode === undefined) useJsonMode = true;
        var prompt = translatePrompt(lines, target);
        var conv = pv.chatMode === 'conversations';
        var body;
        if (useJsonMode) {
            var rf = {type: 'json_object'};
            body = conv
                ? {model:model, inputs:[{role:'user', content:prompt}], tools:[],
                   completion_args:{temperature:0, max_tokens:4096, top_p:1, response_format: rf}, instructions:''}
                : {model:model, messages:[{role:'user', content:prompt}], response_format: rf};
        } else {
            body = conv
                ? {model:model, inputs:[{role:'user', content:prompt}], tools:[],
                   completion_args:{temperature:0, max_tokens:4096, top_p:1}, instructions:''}
                : {model:model, messages:[{role:'user', content:prompt}]};
        }
        return gmFetch({
            method:'POST', url:pv.chat,
            headers:{'Authorization':'Bearer '+pv.key, 'Content-Type':'application/json'},
            data:JSON.stringify(body)
        }).then(function(r) {
            if (r.status < 200 || r.status >= 300) throw httpErr('translate', r);
            var j = JSON.parse(r.responseText), text = null;
            if (conv) text = j.outputs && j.outputs[0] && j.outputs[0].content;
            else text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            if (!text) throw new Error('translate: empty response');
            // Try JSON parse first
            var translations = null;
            try {
                var parsed = JSON.parse(text.trim());
                if (parsed && Array.isArray(parsed.translations)) {
                    translations = parsed.translations.map(function(x, _i) { var t = String(x).trim(); return t || (lines[_i] || ''); });
                }
            } catch(e) {}
            // Fallback to plain text line parsing
            if (!translations) {
                translations = text.trim().split('\n').map(function(x) { return x.trim(); })
                    .filter(function(x) { return x.length > 0; });
            }
            return translations;
        });
    }

    function translateCaps(rawCaps, pv, done) {
        var target = LANG_MAP[s.lang] || 'English';
        var model = s.translateModel || TRANSLATE_MODEL_DEF;
        var lines = rawCaps.map(function(c){ return c.text; });
        var attempt = function(m, isRetry, feedback, useJsonMode) {
            if (useJsonMode === undefined) useJsonMode = true;
            var promptLines = lines;
            var trPromise = feedback
                ? translateLinesWithFeedback(pv, lines, target, m, feedback, useJsonMode)
                : translateLines(pv, lines, target, m, useJsonMode);
            trPromise.then(function(tr) {
                // Don't require exact line count match — pad with original or truncate
                var fixed = [];
                for (var fi = 0; fi < lines.length; fi++) {
                    if (tr[fi] && String(tr[fi]).trim()) { fixed.push(String(tr[fi]).trim()); }
                    else { fixed.push(rawCaps[fi].text); }
                }
                // Always usable — we have captions with at least original text
                return done({caps: rawCaps.map(function(c,i){
                    return {start:c.start, end:c.end, text:fixed[i]}; }), ok:true, error: null});
            }).catch(function(err) {
                var badModel = err.status === 400 && /model/i.test(err.body || '');
                if (!isRetry && badModel && m !== TRANSLATE_MODEL_DEF) {
                    statusMsg('Model rejected, retrying with ' + TRANSLATE_MODEL_DEF + '…');
                    return attempt(TRANSLATE_MODEL_DEF, true);
                }
                // If response_format not supported, retry without it
                if (!isRetry && err.status === 400 && /response_format/i.test(err.body || '')) {
                    statusMsg('Retrying without JSON mode…');
                    return attempt(m, true, undefined, false);
                }
                done({caps: rawCaps, ok:false, error:err});
            });
        };
        attempt(model, false);
    }

    function errMsg(msg) {
        var p = videoPlayer(); if (!p) return;
        var o = p.querySelector('[data-x-feature="co-err"]');
        if (!o) { o = document.createElement('div'); o.setAttribute('data-x-feature','co-err');
                  var vc = p.querySelector('[data-testid="videoComponent"]'); if (vc) vc.appendChild(o); }
        o.style.cssText = 'position:absolute;bottom:'+ctrlBottom()+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
        o.textContent = '';
        var t = document.createElement('div');
        t.style.cssText = 'display:inline-block;background:rgba(127,29,29,.85);color:#fff;padding:6px 14px;border-radius:6px;font:13px/1.4 sans-serif;max-width:80%;';
        t.textContent = msg; o.appendChild(t);
        noteErr(msg);
    }
    function clearErr() { var els = document.querySelectorAll('[data-x-feature="co-err"]'); for (var i=0;i<els.length;i++) els[i].remove(); }

    // ── Native subtitle translation (shared with transcription path) ──
    function translateSegments(rawCaps, key, done) {
        var pv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
        if (!pv.key || !pv.chat) { cacheVideoCaps(key, rawCaps); done(rawCaps); return; }
        translateCaps(rawCaps, pv, function(res) {
            cacheVideoCaps(key, res.caps);
            setCapsInfo(key, res.ok);
            if (!res.ok) errMsg('Translation failed — showing original text (' +
                                (res.error && res.error.message || 'unknown') + ')');
            done(res.caps);
        });
    }

    function ccFail(w, msg) { if (w) { w.setAttribute('data-on','0'); w.style.opacity='.55'; } statusMsg(msg); noteErr(msg); }

    function toggleCC_done(w) {
        // native-subtitle path completes without the busy flag; keep button lit
        w.setAttribute('data-on','1');
    }

    function videoPlayer() {
        var w=document.querySelector('[data-x-feature="cc"][data-on="1"]')||document.querySelector('[data-x-feature="cc"]');
        if(!w) return document.querySelector('[data-testid="videoPlayer"]');
        return w.closest('[data-testid="videoPlayer"]');
    }

    // Refresh CC button colors based on whether captions are cached
    function refreshCCColors() {
        var ps = document.querySelectorAll('[data-testid="videoPlayer"]');
        for (var i = 0; i < ps.length; i++) {
            var pl = ps[i];
            var w = pl.querySelector('[data-x-feature="cc"]');
            if (!w) continue;
            var n = w.querySelector('div[dir="ltr"]');
            if (!n) continue;
            var tid = mediaKey(pl);
            var ci = _capsInfo.get(tid);
            if (ci && ci.failed) {
                n.style.color = '#f87171';
                w.setAttribute('data-cc-state', 'failed');
                var btn2 = w.querySelector('button'); if (btn2) btn2.setAttribute('title', 'Failed last time — click to retry');
            } else if (ci && ci.translated) {
                n.style.color = '#4ade80';
                w.setAttribute('data-cc-state', 'cached');
                var btn2 = w.querySelector('button'); if (btn2) btn2.setAttribute('title', 'Cached — click to show');
            } else {
                // Pre-click indication: what will happen when clicked
                var nti = nativeTrackInfo(pl);
                if (nti.hasNative && nti.inTargetLang) {
                    // Native subs already in target lang — just show, no API call
                    n.style.color = '#4ade80';
                    w.setAttribute('data-cc-state', 'native-ready');
                var btn2 = w.querySelector('button'); if (btn2) btn2.setAttribute('title', 'Show existing subtitles (no API call)');
                } else if (nti.hasNative) {
                    // Native subs need translation — 1 API call
                    n.style.color = '#60a5fa';
                    w.setAttribute('data-cc-state', 'will-translate');
                var btn2 = w.querySelector('button'); if (btn2) btn2.setAttribute('title', 'Translate existing subtitles (1 API call)');
                } else {
                    // No native subs — will transcribe (+ possibly translate)
                    n.style.color = '#f59e0b';
                    w.setAttribute('data-cc-state', 'will-transcribe');
                var btn2 = w.querySelector('button'); if (btn2) btn2.setAttribute('title', 'Transcribe audio (API call)');
                }
            }
        }
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
            w.style.opacity='.55';
            // Restore native track modes
            var _pl = w.closest('[data-testid="videoPlayer"]');
            var _vid = _pl ? _pl.querySelector('video') : null;
            if (_vid && _vid.textTracks) {
                for (var _ri = 0; _ri < _vid.textTracks.length; _ri++) {
                    if (_vid.textTracks[_ri]._xcsPrevMode) {
                        _vid.textTracks[_ri].mode = _vid.textTracks[_ri]._xcsPrevMode;
                        delete _vid.textTracks[_ri]._xcsPrevMode;
                    }
                }
            }
            hideCaps(); runCleanup(); return;
        }
        var active = document.querySelectorAll('[data-x-feature="cc"][data-on="1"]');
        for(var i=0;i<active.length;i++) {
            active[i].setAttribute('data-on','0');
            active[i].style.opacity='.55';
        }
        w.setAttribute('data-on','1');
        w.style.opacity='1';

        var pl = w.closest('[data-testid="videoPlayer"]');
        var key = mediaKey(pl);
        if(!key){w.setAttribute('data-on','0');return;}
        var tweetId = key.split('#')[0];
        _activeTweetId = key;

        if (_videoCaps.has(key)){ hideCaps(); showCaps(); return; }
        if(busyFor){statusMsg('Working...'); return;}

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
                busyFor = key; statusMsg('Reading native subtitles...');
                var _watchdog = setTimeout(function(){ if (busyFor === key) { busyFor = null; ccFail(w, 'Timed out'); } }, 120000);
                try {
                    for (var _ti = 0; _ti < vid.textTracks.length; _ti++) {
                        vid.textTracks[_ti]._xcsPrevMode = vid.textTracks[_ti].mode;
                        vid.textTracks[_ti].mode = 'hidden';
                    }
                    var rawCaps = [];
                    for (var ci2 = 0; ci2 < track.cues.length; ci2++) {
                        var cue = track.cues[ci2];
                        rawCaps.push({start: cue.startTime, end: cue.endTime, text: (cue.text||'').replace(/<[^>]*>/g,'').trim()});
                    }
                    rawCaps = rawCaps.filter(function(c){ return c.text; });
                    if (!rawCaps.length) { busyFor = null; }
                    else {
                        cacheVideoCaps(key, rawCaps);
                        _activeTweetId = key;
                        // If target lang is 'original' or native track is already in target lang, just show them
                        var nti = nativeTrackInfo(pl);
                        if (s.lang === 'original' || nti.inTargetLang) {
                            busyFor = null; hideCaps(); showCaps();
                            toggleCC_done(w);
                            return;
                        }
                        statusMsg('Translating native subtitles...');
                        translateSegments(rawCaps, key, function(finalCaps){
                            busyFor = null; hideCaps(); showCaps(); toggleCC_done(w);
                        });
                        return;
                    }
                } catch(e) { busyFor = null; /* fall through to transcription */ }
            }
        }

        var url = _videoUrls.get(key);
        if (!url) {
            busyFor = key; w.setAttribute('data-busy','1'); statusMsg('Fetching video data...');
            var _idx = parseInt(key.split('#')[1]) || 0;
            fetchVideoUrlDirect(tweetId, key, _idx, function(newUrl) {
                if (newUrl) {
                    cacheVideoUrl(key, newUrl);
                    statusMsg('Transcribing...');
                    transcribe(newUrl, key);
                } else {
                    busyFor = null;
                    w.removeAttribute('data-busy');
                    statusMsg('No video data yet. Try clicking the video to play it first, then click AI Captions.');
                }
            });
            return;
        }
        busyFor = key; w.setAttribute('data-busy','1'); statusMsg('Transcribing...');
        var _watchdog2 = setTimeout(function(){ if (busyFor === key) { busyFor = null; ccFail(w, 'Timed out'); } }, 120000);
        transcribe(url, key);
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
        var els=document.querySelectorAll('[data-x-feature="co"],[data-x-feature="co-err"]');
        for(var i=0;i<els.length;i++) els[i].style.bottom=show?'52px':'8px';
    }

    // Setup listener to automatically trigger captions if a video plays muted

    function setupAutoCaption(pl) {
        var vid = pl.querySelector('video');
        if (!vid) return;
        if (vid._autoCaptionSetup) return;
        vid._autoCaptionSetup = true;

        var checkCaption = function() {
            if (!s.autoCaption) return;
            if (vid.paused) return;
            var cc = pl.querySelector('[data-x-feature="cc"]');
            if (!cc || cc.getAttribute('data-on') === '1' || busyFor) return;
            // Only auto-enable if video has native subtitles
            if (vid.textTracks && vid.textTracks.length > 0) {
                var hasCues = false;
                for (var i = 0; i < vid.textTracks.length; i++) {
                    if (vid.textTracks[i].cues && vid.textTracks[i].cues.length > 0) { hasCues = true; break; }
                }
                if (hasCues) { toggleCC(cc); return; }
                // Cues not loaded yet — retry after delay
                setTimeout(checkCaption, 1000);
            }
        };
        vid.addEventListener('play', checkCaption);
        vid.addEventListener('loadeddata', checkCaption);
        vid.addEventListener('playing', checkCaption);
        // Also check periodically
        var _acInterval = setInterval(function() {
            if ((pl.querySelector('[data-x-feature="cc"]') || {}).getAttribute('data-on') === '1') {
                clearInterval(_acInterval);
                return;
            }
            checkCaption();
        }, 2000);
    }

    function setupAutoMute(pl) {
        var vid = pl.querySelector('video');
        if (!vid) return;
        if (vid._autoMuteSetup) return;
        vid._autoMuteSetup = true;

        var checkMute = function() {
            if (s.autoMute && vid.muted && !vid.paused) {
                var cc = pl.querySelector('[data-x-feature="cc"]');
                if (cc && cc.getAttribute('data-on') !== '1' && !busyFor) {
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
        if (svg) svg.innerHTML = '<text x="12" y="16" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">CC</text>';
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
        provs += '<option value="__add__">+ Add custom provider…</option>';
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
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">MODEL NAME</label><input id="xcs-cust-model" value="'+(s.model.indexOf('custom')>-1?s.model:'')+'" placeholder="my-model-name" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;"></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">CHAT STYLE</label>'+
            '<select id="xcs-cust-mode" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+
            '<option value="chat"'+(curProv.chatMode!=='conversations'?' selected':'')+'>OpenAI chat/completions (messages[])</option>'+
            '<option value="conversations"'+(curProv.chatMode==='conversations'?' selected':'')+'>Mistral conversations (inputs[])</option></select></div>'+
            '<button id="xcs-cust-del" style="background:#7f1d1d;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:11px;margin-top:4px;">Remove this provider</button></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">MODEL</label>'+
            '<select id="xcs-model" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+modelsHtml+'</select></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">TRANSLATE MODEL</label>'+
            '<input id="xcs-tmodel" value="'+(s.translateModel||'mistral-small-latest')+'" placeholder="mistral-small-latest" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;"></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">API KEY</label>'+
            '<input id="xcs-key" type="password" value="'+(curProv.key||'')+'" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;font-family:monospace;"></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">BACKGROUND</label>'+
            '<div style="display:flex;gap:6px;margin-top:2px;">'+
            '<input type="color" id="xcs-bg-picker" value="'+(s.bg.startsWith('#')?s.bg:'#000000')+'" style="width:36px;height:30px;padding:0;border:1px solid #555;border-radius:4px;background:transparent;cursor:pointer;">'+
            '<input id="xcs-bg" value="'+s.bg+'" style="flex:1;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;"></div></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">LANGUAGE</label>'+
'<select id="xcs-lang" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;margin-top:2px;">'+langs+'</select></div>'+
'<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">SKIP TRANSLATION FOR (comma-separated lang codes, e.g. fr,es)</label>'+
'<input id="xcs-skiplangs" value="'+(s.skipLangs||'')+'" placeholder="fr,es,de" style="width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font:12px monospace;margin-top:2px;"></div>'+
'<div style="margin:8px 0;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="xcs-automute" '+(s.autoMute?'checked':'')+' style="width:14px;height:14px;margin:0;cursor:pointer;"><label for="xcs-automute" style="color:#aaa;font-size:11px;cursor:pointer;user-select:none;">AUTO-CAPTION ON MUTE</label></div>'+
'<div style="margin:8px 0;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="xcs-autocaption" '+(s.autoCaption?'checked':'')+' style="width:14px;height:14px;margin:0;cursor:pointer;"><label for="xcs-autocaption" style="color:#aaa;font-size:11px;cursor:pointer;user-select:none;">AUTO-CAPTION ON VIDEOS WITH SUBS</label></div>'+
            '<div style="margin-top:10px;display:flex;gap:4px;">'+
            '<button id="xcs-save" style="flex:1;background:#1d9bf0;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Save</button>'+
            '<button id="xcs-close" style="background:#444;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Cancel</button></div>'+
            '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #444;">'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">OPACITY (live)</label>'+
            '<div style="display:flex;gap:6px;margin-top:2px;align-items:center;">'+
            '<input id="xcs-op" type="range" min="10" max="100" value="'+(s.bgOp||85)+'" style="flex:1;margin:0;">'+
            '<span id="xcs-op-val" style="font-size:11px;color:#aaa;min-width:28px;text-align:right;">'+(s.bgOp||85)+'%</span></div></div>'+
            '<div style="margin:6px 0;"><label style="display:block;color:#aaa;font-size:11px;">FONT SIZE (live)</label>'+
            '<input id="xcs-size" type="range" min="10" max="30" value="'+s.size+'" style="width:100%;margin:2px 0;">'+
            '<span id="xcs-size-val" style="font-size:11px;color:#aaa;">'+s.size+'px</span></div></div>'+
'<div style="margin-top:8px;display:flex;gap:4px;">'+
'<button id="xcs-reset" style="flex:1;background:#444;color:#fff;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Reset style</button>'+
'<button id="xcs-regen" style="flex:1;background:#f59e0b;color:#000;border:none;border-radius:4px;padding:6px 8px;cursor:pointer;font-size:12px;">Regenerate</button></div>';

        document.body.appendChild(pan);
        var rect = p.getBoundingClientRect();
        var panW = pan.offsetWidth || 270;
        var panH = pan.offsetHeight || 400;
        var left = rect.right + 8;
        if (left + panW > window.innerWidth - 10) left = rect.left - panW - 8;
        if (left < 10) left = 10;
        var top = rect.top;
        if (top + panH > window.innerHeight) top = window.innerHeight - panH - 10;
        pan.style.left = Math.max(10, left) + 'px';
        pan.style.top = Math.max(10, top) + 'px';

        var saveBtn = document.getElementById('xcs-save');
        saveBtn.disabled = true;
        saveBtn.style.opacity = '.4';
        saveBtn.style.cursor = 'not-allowed';
        var markDirty = function() {
            saveBtn.disabled = false;
            saveBtn.style.opacity = '1';
            saveBtn.style.cursor = 'pointer';
        };
        // also mark dirty on any other field edit
        ['xcs-provider','xcs-key','xcs-bg','xcs-lang','xcs-automute','xcs-autocaption','xcs-cust-name','xcs-cust-trans','xcs-cust-chat','xcs-cust-model','xcs-tmodel','xcs-cust-mode','xcs-skiplangs'].forEach(function(id){
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', markDirty);
        });
        // model select change marks dirty
        var ms = document.getElementById('xcs-model');
        if (ms) ms.addEventListener('change', markDirty);

        document.getElementById('xcs-provider').onchange = function() {
            var pk = this.value;
            if (pk === '__add__') {
                pk = 'cust_' + Date.now().toString(36);
                PROVIDERS[pk] = {name:'Custom', key:'', models:{'custom-model':'Custom Model'},
                                 transcribe:'', chat:'', chatMode:'chat'};
                var opt = document.createElement('option'); opt.value = pk; opt.textContent = 'Custom (new)';
                this.insertBefore(opt, this.querySelector('option[value="__add__"]'));
                this.value = pk;
            }
            var pv = PROVIDERS[pk];
            var custFields = document.getElementById('xcs-custom-fields');
            custFields.style.display = (pk.indexOf('cust_')===0) ? 'block' : 'none';
            if (!pv) return;
            var sel = document.getElementById('xcs-model');
            sel.innerHTML = '';
            for (var m in pv.models) {
                var opt = document.createElement('option');
                opt.value = m; opt.textContent = pv.models[m];
                if (m === s.model) opt.selected = true;
                sel.appendChild(opt);
            }
            document.getElementById('xcs-key').value = pv.key || '';
            if (pk.indexOf('cust_')===0) {
                document.getElementById('xcs-cust-name').value = pv.name || '';
                document.getElementById('xcs-cust-trans').value = pv.transcribe || '';
                document.getElementById('xcs-cust-chat').value = pv.chat || '';
            }
        };
        var cdel = document.getElementById('xcs-cust-del');
        if (cdel) cdel.onclick = function() {
            var cp = loadCustomProv();
            var pk2 = document.getElementById('xcs-provider').value;
            var cid2 = pk2.replace('cust_','');
            delete cp[cid2];
            saveCustomProv(cp);
            s.provider = DEF.provider;
            localStorage.setItem(SKEY, JSON.stringify(s));
            buildProviders();
            var pan2 = document.querySelector('[data-x-feature="xcs"]'); if (pan2) pan2.remove();
            openSett();
        };
        var cms = document.getElementById('xcs-cust-mode'); if (cms) cms.addEventListener('change', markDirty);

        document.getElementById('xcs-size').oninput = function() {
            document.getElementById('xcs-size-val').textContent = this.value + 'px';
            var ct = document.getElementById('ct') || document.getElementById('xcs-preview-cap');
            if (ct) ct.style.fontSize = this.value + 'px';
            markDirty();
        };
        document.getElementById('xcs-bg-picker').oninput = function() {
            document.getElementById('xcs-bg').value = this.value;
            markDirty();
        };
        document.getElementById('xcs-op').oninput = function() {
            document.getElementById('xcs-op-val').textContent = this.value + '%';
            var ct = document.getElementById('ct');
            if (ct) {
                var bg = (document.getElementById('xcs-bg').value || '#000000');
                var o = (parseInt(this.value)||85)/100;
                var r=parseInt(bg.slice(1,3),16)||0,g=parseInt(bg.slice(3,5),16)||0,b=parseInt(bg.slice(5,7),16)||0;
                ct.style.background = 'rgba('+r+','+g+','+b+','+o+')';
            }
            markDirty();
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
                cp[cid].chat_mode = document.getElementById('xcs-cust-mode').value || 'chat';
                saveCustomProv(cp);
                buildProviders();
            } else if (PROVIDERS[pk]) {
                saveKey(pk, document.getElementById('xcs-key').value.trim());
            }
            var prevLang = s.lang, prevProv = s.provider, prevTM = s.translateModel;
            s.provider = pk || DEF.provider;
            s.model = document.getElementById('xcs-model').value || DEF.model;
            s.bg = document.getElementById('xcs-bg').value || DEF.bg;
            s.bgOp = parseInt(document.getElementById('xcs-op').value) || DEF.bgOp;
            s.size = document.getElementById('xcs-size').value || DEF.size;
            s.lang = document.getElementById('xcs-lang').value || 'en';
            s.translateModel = (document.getElementById('xcs-tmodel').value || '').trim() || DEF.translateModel;
            s.skipLangs = (document.getElementById('xcs-skiplangs').value || '').trim();
            s.autoMute = document.getElementById('xcs-automute').checked;
            s.autoCaption = document.getElementById('xcs-autocaption').checked;
            if (s.lang !== prevLang || s.provider !== prevProv || s.translateModel !== prevTM) {
                _videoCaps.clear(); _capsInfo.clear();
                for (var k in _cleanups) { _cleanups[k](); } _cleanups = {};
            }
            localStorage.setItem(SKEY, JSON.stringify(s));
            var ct = document.getElementById('ct');
            if (ct) ct.style.cssText = 'display:inline-block;background:'+bgCSS()+';color:#fff;padding:8px 16px;border-radius:6px;font:'+s.size+'px/1.5 sans-serif;max-width:85%;text-align:center;text-shadow:0 0 3px #000,0 0 5px #000;';
            if (pan.parentNode) pan.remove();
        };
        document.getElementById('xcs-regen').onclick = function() {
            var tid = _activeTweetId;
            if (tid) { _videoCaps.delete(tid); _videoUrls.delete(tid); }
            if (pan.parentNode) pan.remove();
            var pl = videoPlayer(); if(!pl) return;
            var cc = pl.querySelector('[data-x-feature="cc"]'); if(cc){ cc.setAttribute('data-on','0'); toggleCC(cc); }
        };
        document.getElementById('xcs-reset').onclick = function() {
            s.bg = DEF.bg; s.bgOp = DEF.bgOp; s.size = DEF.size;
            var b = document.getElementById('xcs-bg'); if (b) b.value = s.bg;
            var bp = document.getElementById('xcs-bg-picker'); if (bp) bp.value = s.bg;
            var opEl = document.getElementById('xcs-op'); if(opEl){ opEl.value = s.bgOp; }
            var szEl = document.getElementById('xcs-size'); if(szEl){ szEl.value = s.size; }
            var ov = document.getElementById('xcs-op-val'); if(ov) ov.textContent = s.bgOp + '%';
            var sv = document.getElementById('xcs-size-val'); if(sv) sv.textContent = s.size + 'px';
            var ct = document.getElementById('ct') || document.getElementById('xcs-preview-cap');
            if(ct){ ct.style.fontSize = s.size + 'px'; ct.style.background = bgCSS(); }
            markDirty();
        };

        // Preview caption when no active captions
        var hadCaps = _activeTweetId && _videoCaps.has(_activeTweetId);
        if (!hadCaps) {
            var plpv = videoPlayer();
            if (plpv) {
                var ovp = document.createElement('div'); ovp.setAttribute('data-x-feature','co'); ovp.id='xcs-preview';
                ovp.style.cssText='position:absolute;bottom:'+ctrlBottom()+';left:0;right:0;text-align:center;padding:8px 16px;z-index:9999;pointer-events:none;';
                var tp=document.createElement('div'); tp.id='xcs-preview-cap'; tp.setAttribute('data-x-role','preview');
                tp.style.cssText='display:inline-block;background:'+bgCSS()+';color:#fff;padding:8px 16px;border-radius:6px;font:'+s.size+'px/1.5 sans-serif;max-width:85%;text-align:center;text-shadow:0 0 3px #000,0 0 5px #000;';
                tp.textContent='Preview captions';
                ovp.appendChild(tp); var vc=plpv.querySelector('[data-testid="videoComponent"]'); if(vc) vc.appendChild(ovp);
            }
        }

        document.getElementById('xcs-close').onclick = function() { var pv=document.getElementById('xcs-preview'); if(pv) pv.remove(); if (pan.parentNode) pan.remove(); };
        var _origSave = document.getElementById('xcs-save').onclick;
        document.getElementById('xcs-save').onclick = function() { var pv=document.getElementById('xcs-preview'); if(pv) pv.remove(); _origSave(); };
        var clkOutTimer = setTimeout(function() {
            function clkOut(e) {
                if (!pan.contains(e.target)) {
                    var pv = document.getElementById('xcs-preview'); if (pv) pv.remove();
                    if (pan.parentNode) pan.remove();
                    document.removeEventListener('mousedown', clkOut, true);
                    document.removeEventListener('keydown', escKey, true);
                    if (clkOutTimer) { clearTimeout(clkOutTimer); clkOutTimer = null; }
                }
            }
            var escKey = function(e) { if (e.key === 'Escape') { e.stopPropagation();
                var pv = document.getElementById('xcs-preview'); if (pv) pv.remove();
                if (pan.parentNode) pan.remove();
                document.removeEventListener('mousedown', clkOut, true);
                document.removeEventListener('keydown', escKey, true);
                if (clkOutTimer) { clearTimeout(clkOutTimer); clkOutTimer = null; }
            } };
            document.addEventListener('mousedown', clkOut, true);
            document.addEventListener('keydown', escKey, true);
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

    async function transcribe(url, capKey) {
        var pv = PROVIDERS[s.provider] || PROVIDERS[DEF.provider];
        var apiKey = pv.key, model = s.model || DEF.model;
        if (!apiKey) { busyFor = null; statusMsg('No API key set. Open Settings → AI Captions to set one.'); return; }
        if (!pv.transcribe) { busyFor = null; statusMsg('No transcribe URL'); return; }

        var bd = '----FB'+Math.random().toString(36).slice(2);
        var parts = [];
        parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="model"'); parts.push(''); parts.push(model);
        parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="file_url"'); parts.push(''); parts.push(url);
        parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="timestamp_granularities"'); parts.push(''); parts.push('segment');
        if (s.lang && s.lang !== 'original') {
            parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="language"'); parts.push(''); parts.push(s.lang);
        }
        parts.push('--'+bd); parts.push('Content-Disposition: form-data; name="return_language"'); parts.push(''); parts.push('true');
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
                    headers:{'Authorization':'Bearer '+apiKey,'Content-Type':'multipart/form-data; boundary='+bd},
                    data:parts.join('\r\n')
                });
                break;
            } catch(e) {
                if (attempt === 3) {
                    busyFor = null;
                    var w3 = document.querySelector('[data-x-feature="cc"][data-busy]');
                    if (w3) w3.removeAttribute('data-busy');
                    statusMsg('API failed after 3 attempts');
                    return;
                }
            }
        }

        busyFor = null;
        var w = document.querySelector('[data-x-feature="cc"][data-busy]');
        if (w) w.removeAttribute('data-busy');
        if (!capKey) { statusMsg('No tweet ID'); return; }

        try {
            var j = JSON.parse(r.responseText);
            if (j.segments && j.segments.length) {
                var raw = j.segments.map(function(s){ return {start:s.start, end:s.end, text:(s.text||'').trim()}; });
                // Blacklist check: if detected source lang is in skipLangs, skip translation
                var detectedLang = (j.language || '').toLowerCase().slice(0,2);
                var skipList2 = (s.skipLangs || '').toLowerCase().split(/[,\s]+/).filter(function(x){return x;});
                var isSkipped2 = detectedLang && skipList2.indexOf(detectedLang) >= 0;
                if (s.lang === 'original' || isSkipped2) {
                    cacheVideoCaps(capKey, raw);
                    setCapsInfo(capKey, true);
                    hideCaps(); _activeTweetId = capKey; showCaps();
                } else {
                    statusMsg('Translating...');
                    if (!pv.chat) {
                        cacheVideoCaps(capKey, raw);
                        setCapsInfo(capKey, true);
                        hideCaps(); _activeTweetId = capKey; showCaps();
                        return;
                    }
                    var res = await new Promise(function(r){ translateCaps(raw, pv, r); });
                    cacheVideoCaps(capKey, res.caps);
                    setCapsInfo(capKey, res.ok);
                    if (!res.ok) errMsg('Translation failed — showing original text (' +
                                        (res.error && res.error.message || 'unknown') + ')');
                    hideCaps(); _activeTweetId = capKey; showCaps();
                }
            } else if (j.text) {
                cacheVideoCaps(capKey, [{start:0,end:120,text:j.text.trim()}]);
                hideCaps(); _activeTweetId = capKey; showCaps();
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

    var _lastErr = null;
    function noteErr(msg) { _lastErr = {msg: msg, at: new Date().toISOString()}; if (typeof console !== 'undefined') console.warn('[X-Captions]', msg); }
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
        var ps=document.querySelectorAll('[data-testid="videoPlayer"]'); for(var _ri=0;_ri<ps.length;_ri++) ripCaps(ps[_ri]); var o=document.createElement('div'); o.setAttribute('data-x-feature','co');
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
    function hideCaps(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');for(var i=0;i<ps.length;i++) ripCaps(ps[i]);}
    function ripCaps(p){var els=p.querySelectorAll('[data-x-feature="co"]');for(var i=0;i<els.length;i++)els[i].remove();}
    function runCleanup(tweetId) {
        if (tweetId && _cleanups[tweetId]) { _cleanups[tweetId](); delete _cleanups[tweetId]; }
        else { for (var k in _cleanups) { _cleanups[k](); } _cleanups = {}; }
    }

    // ── Inject CC button into video players ─────────────
    function inject(pl) {
        if (!pl) return;
        if (pl.querySelector('[data-x-feature="cc"]')) return;
        var host = pl.querySelector('[data-testid="videoComponent"]') || pl;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        var w = mkCC();
        w.style.cssText = 'position:absolute;top:8px;right:8px;z-index:9998;opacity:.55;transition:opacity .15s;';
        w.addEventListener('mouseenter', function(){ w.style.opacity = '1'; });
        w.addEventListener('mouseleave', function(){
            if (w.getAttribute('data-on') !== '1') w.style.opacity = '.55';
        });
        host.appendChild(w);
        hoverSetup(pl);
        setupAutoMute(pl);
        setupAutoCaption(pl);
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
            refreshCCColors();
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
        var uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        uw.__xcs_open = openSett;
        uw.__xcs_diag = function() {
            return {version: VERSION, provider: s.provider, model: s.model,
                    translateModel: s.translateModel || 'mistral-small-latest',
                    lang: s.lang, skipLangs: s.skipLangs || '', keySet: !!(PROVIDERS[s.provider] || {}).key,
                    graphqlId: GRAPHQL_TWEET_RESULT_ID, lastError: _lastErr,
                    urls: _videoUrls.size, caps: _videoCaps.size, busy: busyFor};
        };
        var VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '2.1';
        console.log('[X-Captions] v' + VERSION + ' loaded — click the CC chip on any video, or Alt+Shift+C.');

    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
