// ==UserScript==
// @name         X.com AI Captions
// @namespace    local.x-features
// @version      5.0
// @description  AI captions for X videos via Mistral file_url. No server.
// @author       Hermes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.mistral.ai
// @downloadURL  https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @updateURL    https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    var KEY = 'dGjgnYE6kcY5aTFjExd5lD5DAMN1U1ld';

    var caps = null, intv = null, busy = false;

    // ── GraphQL endpoint ──────────────────────────────────
    var GQL = 'https://x.com/i/api/graphql/R4GaE7QczPF2R7wRxgu70w/TweetResultByRestId';
    var FTRS = {"creator_subscriptions_tweet_preview_api_enabled":true,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":true,"rweb_cashtags_enabled":true,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true};

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
        busy=true; sts('Starting...'); go();
    }

    // ── Core: get video URL from GraphQL, send to Mistral ─
    function go() {
        // Extract tweet ID from current URL
        var m = location.pathname.match(/\/status\/(\d+)/);
        if (!m) { sts('Not a tweet'); busy=false; return; }
        var tweetId = m[1];
        console.log('[X] tweet:', tweetId);

        sts('Fetching tweet data...');

        var vars = {"tweetId":tweetId,"includePromotedContent":true,"withBirdwatchNotes":true,"withVoice":true,"withCommunity":true};
        var params = 'variables='+encodeURIComponent(JSON.stringify(vars))+'&features='+encodeURIComponent(JSON.stringify(FTRS))+'&fieldToggles='+encodeURIComponent(JSON.stringify({"withArticlePlainText":false}));

        fetch(GQL+'?'+params).then(function(r){return r.json();}).then(function(data){
            console.log('[X] GraphQL response received');
            // Navigate to find video info
            var tweetResult = data;
            try {
                // Walk the response tree
                var result = data.data.tweetResult.result;
                if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
                var legacy = result.legacy;
                var media = legacy.extended_entities && legacy.extended_entities.media;
                if (!media) { sts('No media'); busy=false; return; }

                var bestUrl = null, bestBitrate = -1;
                for (var i=0; i<media.length; i++) {
                    if (media[i].type === 'video' || media[i].type === 'animated_gif') {
                        var variants = media[i].video_info && media[i].video_info.variants;
                        if (!variants) continue;
                        for (var j=0; j<variants.length; j++) {
                            var v = variants[j];
                            if (v.content_type === 'video/mp4' && (v.bitrate||0) > bestBitrate) {
                                bestUrl = v.url; bestBitrate = v.bitrate||0;
                            }
                        }
                    }
                }

                if (!bestUrl) { sts('No video URL'); busy=false; return; }
                console.log('[X] MP4 URL:', bestUrl.slice(0,100));
                sts('Transcribing...');
                transcribe(bestUrl);
            } catch(e) {
                console.error('[X] Parse error:', e);
                sts('Parse error'); busy=false;
            }
        }).catch(function(e){
            console.error('[X] Fetch error:', e);
            sts('API error'); busy=false;
        });
    }

    function transcribe(videoUrl) {
        // Send to Mistral via file_url — no binary data, just a URL
        var boundary = '----FB' + Math.random().toString(36).slice(2);
        var p = [];
        function add(n,v) { p.push('--'+boundary); p.push('Content-Disposition: form-data; name="'+n+'"'); p.push(''); p.push(String(v)); }
        add('model', 'voxtral-mini-latest');
        add('file_url', videoUrl);
        add('timestamp_granularities', 'segment');
        p.push('--'+boundary+'--');
        var body = p.join('\r\n');

        GM_xmlhttpRequest({
            method:'POST', url:'https://api.mistral.ai/v1/audio/transcriptions',
            headers:{'Authorization':'Bearer '+KEY, 'Content-Type':'multipart/form-data; boundary='+boundary},
            data:body,
            onload:function(r){
                busy=false;
                try{
                    var j=JSON.parse(r.responseText);
                    console.log('[X] Mistral:', JSON.stringify(j).slice(0,300));
                    if(j.segments&&j.segments.length){
                        caps=j.segments.map(function(s){return{start:s.start,end:s.end,text:(s.text||'').trim()};});
                        console.log('[X] OK',caps.length);hide();showCaps();
                    } else if(j.text){
                        caps=[{start:0,end:120,text:j.text.trim()}];
                        hide();showCaps();
                    } else { sts('API err'); console.error('[X]',j); }
                }catch(e){sts('Parse err');console.error('[X]',e);}
            },
            onerror:function(){busy=false;sts('API down');},
            ontimeout:function(){busy=false;sts('Timeout');}
        });
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
    function init(){console.log('[X] v5.0');new MutationObserver(function(){var ps=document.querySelectorAll('[data-testid="videoPlayer"]');for(var i=0;i<ps.length;i++)inj(ps[i]);}).observe(document.body,{childList:true,subtree:true});tryGo();}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
