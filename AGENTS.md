# AGENTS.md — X.com AI Captions (x-loader.user.js)

Comprehensive reference for AI agents working on this userscript. Contains all X.com DOM structure, solutions to past issues, and the full feature landscape — no browser needed.

## Project Overview

- **File**: `/home/shiro/projects/x-captions/x-loader.user.js`
- **Version**: 7.7 (fetch interceptor + GraphQL fallback + URL-encoding fix)
- **GitHub**: `github.com/Esashiero/x-captions` (public, auto-update enabled)
- **Auto-update URLs**:
  - `@downloadURL`: `https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js`
  - `@updateURL`: `https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js`
- **Namespace**: `local.x-features`
- **Run-at**: `document-start` (must be early to patch XHR before X.com makes API calls)

### File Structure

```
x-captions/
├── x-loader.user.js   # Single-file userscript (~670 lines)
├── README.md          # End-user docs
└── AGENTS.md          # This file (AI reference)
```

### Key @grant Dependencies

| Permission | Reason |
|------------|--------|
| `@grant GM_xmlhttpRequest` | Bypass X.com's CSP for Mistral API calls |
| `@connect api.mistral.ai` | Allow Mistral API origin |
| `@connect *` | Allow custom provider origins |
| `@run-at document-start` | Intercept XHR before X.com makes GraphQL calls |

Other Tampermonkey features: uses `unsafeWindow` (via `typeof unsafeWindow !== 'undefined' ? unsafeWindow : window`) for XHR monkey-patching.

---

## X.com DOM Structure Reference

All CSS selectors and DOM patterns below have been empirically verified on X.com.

### Video Player Container

```
[data-testid="videoPlayer"]          # Root video player container
  └── [data-testid="videoComponent"]  # Inner component (caption overlay target)
      └── <video>                     # Native HTML5 video element
```

- **Relative positioning**: Both containers use `position: relative` or `position: absolute` — captions (`[data-x-feature="co"]`) are positioned absolutely inside `[data-testid="videoComponent"]`.

### Controls Bar (Bottom of Player)

```
[data-testid="videoPlayer"]
  └── div (controls bar - last child, flexbox)
      ├── div (scrubber / timeline bar)
      ├── div (button row - flexbox with css-175oi2r classes)
      │   ├── [aria-label="Play"] / [aria-label="Pause"]
      │   ├── [aria-label="Unmute"] / [aria-label="Mute"]   # <-- CC button inserted BEFORE this
      │   ├── [aria-label="Volume"]
      │   ├── [aria-label="Captions"]                        # Native captions button (if present)
      │   └── [aria-label="Video Settings"]                  # Gear icon (opens [role="dialog"])
      └── ...
```

**CC button injection point:**
```js
var u = pl.querySelector('[aria-label="Unmute"]') || pl.querySelector('[aria-label="Mute"]');
var w = u.parentElement;   // flexbox button container
var c = w.parentElement;    // controls bar
c.insertBefore(mkCC(), w); // Insert CC button before mute button
```

**Insertion priority**: We look for `Unmute` first (video currently muted), then `Mute` (video has audio). The CC button is placed just before the mute button in the controls bar.

**Native captions guard**: Check `pl.querySelector('[data-testid="captions"]')` — if native captions exist, we skip injection to avoid duplicates.

### Caption Overlay Positioning

Captions are positioned absolutely inside `[data-testid="videoComponent"]` with `bottom: Npx`.

| State | bottom value |
|-------|-------------|
| Controls visible (`ctrlVis=true`) | `52px` |
| Controls hidden (`ctrlVis=false`) | `8px` |
| Video paused (`paused=true`) | `52px` (always show higher on pause) |

**Controls visibility tracking** (via `hoverSetup`):
- `mouseenter` → `ctrlVis = true`
- `mouseleave` → `ctrlVis = false`
- `mousemove` → `ctrlVis = true`, reset 3s hide timer
- Video `pause` → `paused = true`
- Video `play` → `paused = false`

### Gear Menu (Video Settings)

```
[role="dialog"].r-tskmnb   # Logged-in state
or
[role="menu"].r-tskmnb     # Logged-out state
  └── mc.children[0]       # First menu item (template for cloning)
      ├── <svg>            # Icon
      ├── <span><span/>    # Label text (used for "Captions")
      └── .r-16dba41 span  # Value text (cleared to empty)
```

**Selectors**:
| State | Selector |
|-------|----------|
| Dialog (logged-in) | `[role="dialog"].r-tskmnb` |
| Menu (logged-out) | `[role="menu"].r-tskmnb` |
| Combined | `[role="dialog"].r-tskmnb, [role="menu"].r-tskmnb` |

**Injection method**:
1. Clone `mc.children[0]` (always a `<div>`, not `<a>`)
2. Overwrite `svg` innerHTML with captions icon path
3. Set `span span` textContent to `'Captions'`
4. Clear `.r-16dba41 span` textContent (value display)
5. Set `onclick` to `openSett()`
6. Append to menu container

**Hover effect**: Injected via dynamic `<style>`:
```css
[data-x-gc] { background-color: transparent; transition: background-color .2s; }
[data-x-gc]:hover { background-color: rgba(255,255,255,0.03); }
```
The `[data-x-gc]` attribute is set on the cloned menu item (`ci.setAttribute('data-x-gc','1')`).

### Button Styling (X.com Native Classes)

The CC button uses the same class structure as native controls bar buttons:

```js
// Wrapper div
className = 'css-175oi2r'
// Button element
className = 'css-175oi2r r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-2yi16 r-1qi8awa r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l'
style = 'background:transparent;border-color:transparent;opacity:.5'  // .5 = off, 1.0 = on
// Icon container (inside button)
className = 'css-146c3p1 r-qvutc0 r-1qd0xha r-q4m81j r-a023e6 r-rjixqe r-b88u0q r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci'
style = 'color:#fff'
```

### Settings Panel (Custom DOM)

Located via `[data-x-feature="xcs"]`. Positioned as `position:fixed` near the video player's top-right corner.

Has click-outside-to-close via `document.addEventListener('mousedown', ..., true)` on capture phase.

---

## Architecture & Data Flow

### Step 1: Video URL Capture (XHR Interception)

```
X.com GraphQL API (XMLHttpRequest)
  → intercept in XHR.prototype.send
  → filter: URL contains 'TweetResultByRestId'
  → on load: parse JSON response
  → extract: data.tweetResult.result → legacy.extended_entities.media[]
  → select: highest bitrate video/mp4 variant
  → store: global _videoUrl
```

**GraphQL response path:**
```js
var d = JSON.parse(xhr.responseText);
var r = d.data.tweetResult.result;
// Handle TweetWithVisibilityResults wrapper:
if (r.__typename === 'TweetWithVisibilityResults') r = r.tweet;
var media = r.legacy.extended_entities.media;
// For each media item of type 'video' or 'animated_gif':
//   video_info.variants[].filter(v => v.content_type === 'video/mp4')
//   select highest .bitrate
```

### Step 2: Transcription (Mistral API)

```
GM_xmlhttpRequest
  → POST to provider's transcribe URL
  → multipart/form-data with boundary
  → fields: model, file_url (the MP4 URL from step 1), timestamp_granularities=segment
  → Authorization: Bearer <api_key>
```

**Key**: Mistral's API accepts `file_url` — no need to download the video client-side. Just send the public MP4 URL.

### Step 3: Translation (Optional)

```
If target language != 'original':
  → extract all segment texts
  → join with \n
  → send to chat API with translation prompt:
    "Translate these sentences to {target}. Return ONLY the translations,
     one per line, preserving the exact number of lines:\n{txts}"
  → split response by \n, map back to segments
```

**Fallback**: If chat API call fails or missing, use original text.

### Step 4: Caption Display

```js
// caps format: [{start: float_seconds, end: float_seconds, text: string}, ...]
// Update loop: setInterval at 200ms
// For each tick: find caps[i] where currentTime >= start && currentTime < end
```

---

## Settings & LocalStorage

### Storage Keys

| Key | Format | Purpose |
|-----|--------|---------|
| `x_captions_settings` | JSON | Main settings (bg, bgOp, size, lang, provider, model) |
| `x_captions_custom_providers` | JSON | Custom provider configs |

### Settings Schema

```js
// x_captions_settings defaults:
var DEF = {
  bg: '#000000',       // Background color hex
  bgOp: 85,            // Background opacity (10-100)
  size: '15',          // Font size in px
  lang: 'en',          // Target language code
  provider: 'mistral', // Provider key
  model: 'voxtral-mini-latest' // Model key
};
```

```js
// x_captions_custom_providers format:
{
  "myprovider": {
    "name": "My Provider",
    "key": "sk-...",
    "transcribe_url": "https://api.example.com/v1/audio/transcriptions",
    "chat_url": "https://api.example.com/v1/chat/completions",
    "model": "my-model-name"
  }
}
```

### Language Map

```js
LANG_MAP = {
  'en': 'English', 'fr': 'French', 'es': 'Spanish',
  'de': 'German', 'ja': 'Japanese', 'original': 'Original'
};
```

### Built-in Provider

```js
PROVIDERS.mistral = {
  name: 'Mistral AI',
  key: 'dGjgnYE6kcY5aTFjExd5lD5DAMN1U1ld',  // hardcoded Mistral key
  models: {
    'voxtral-mini-latest': 'Voxtral Mini',
    'voxtral-latest': 'Voxtral'
  },
  transcribe: 'https://api.mistral.ai/v1/audio/transcriptions',
  chat: 'https://api.mistral.ai/v1/chat/completions'
};
```

### Provider Config Reload

`buildProviders()` is called on page load and after saving a custom provider. It:
1. Builds the built-in providers (Mistral)
2. Loads `x_captions_custom_providers` from localStorage
3. Maps each custom provider to a `cust_<id>` key in PROVIDERS

---

## Issues & Solutions (History)

### Issue 1: Button Disappearing After React Re-renders
**Problem**: X.com re-renders the video player DOM when scrolling, wiping our injected CC button.
**Solution**: MutationObserver watches `document.body` for new `[data-testid="videoPlayer"]` elements. When found, inject the CC button. Also a retry loop (`tryGo`) polls every 500ms for up to 30s on page load.

### Issue 2: Stale DOM References in Poll
**Problem**: The setInterval closure held a stale reference to the original overlay element, causing it to write to a detached DOM node.
**Solution**: Store `caps` data globally. On each tick, find the current `#ct` element fresh from the DOM.

### Issue 3: HLS Binary Data Corruption
**Problem**: Initially tried to download HLS segments via `GM_xmlhttpRequest`, but `responseText` corrupts binary data (it's Unicode-decoded).
**Solution**: Abandoned HLS approach entirely. Now intercept the GraphQL API response to get a direct MP4 URL, which Mistral can fetch itself via `file_url`.

### Issue 4: GraphQL API Auth Headers
**Problem**: Initially tried to call X.com's GraphQL API directly from the userscript, but it required auth tokens, query IDs, and feature flags that change frequently.
**Solution**: Intercept X.com's *own* XHR requests instead. Our script just reads the response, it doesn't make the API call. This bypasses all auth concerns.

### Issue 5: CSP Blocking API Calls
**Problem**: X.com's Content Security Policy blocks inline fetch/XHR to `api.mistral.ai`.
**Solution**: Use `GM_xmlhttpRequest` (Tampermonkey API) which runs outside page CSP. Added `@connect api.mistral.ai` and `@connect *` to allowlist.

### Issue 6: Gear Menu Different in Logged-in vs Logged-out
**Problem**: Logged-in X.com uses `role="dialog"` for the settings menu; logged-out uses `role="menu"`. The CSS classes (.r-tskmnb) are the same.
**Solution**: Combined selector: `[role="dialog"].r-tskmnb, [role="menu"].r-tskmnb`

### Issue 7: Setting Panel Opening on Wrong Video
**Problem**: `openSett()` was called in response to any settings button, but on multi-video pages the settings panel would position itself relative to the wrong video player.
**Solution**: Replaced the `videoPlayer()` function to find the correct player by walking up from `[data-x-feature="cc"][data-on="1"]` first, then falling back to `[data-x-feature="cc"]`, then fallback to any `[data-testid="videoPlayer"]`.

### Issue 8: Binary Audio Recording (Deprecated Approaches)
**Problem**: Earlier versions tried to:
- Download HLS audio segments and re-encode (corruption)
- Use the browser's MediaRecorder API to capture audio from `<video>` → base64 → Mistral (worked but slow, complex)
- Fetch the MP4 from `video.twimg.com` directly and pass to Mistral (CORS worked from x.com)

**Solution**: Intercept GraphQL response for the video URL. This is the cleanest approach — no client-side audio handling needed at all.

### Issue 9: tweetId Extraction Fails on URL-Encoded GET Query Params (v7.6)
**Problem**: X.com switched from POST to GET for `TweetResultByRestId`, using URL-encoded `variables` in query params:
```
...?variables=%7B%22tweetId%22%3A%222061876992514126153%22%2C...
```
The old regex `/tweetId[%22:]+(\d+)/` failed because `%3A` (URL-encoded `:`) contains `3`, which isn't in the character class `[%22:]` — it captured only `3` instead of the full tweet ID.

**Solution**: New `extractTweetIdFromUrl()` helper (lines 74-87):
1. Parse the query string for `variables=` parameter
2. `decodeURIComponent` to get the JSON string
3. `JSON.parse` to extract `tweetId` from the variables object
This is robust against any URL-encoding format.

### Issue 10: Chrome Timing — Interceptors Miss First API Call (v7.7)
**Problem**: On Chrome, `@run-at document-start` doesn't guarantee our code runs before ESM module scripts. X.com's framework stores a reference to the real `fetch` at module init time, so our `Object.defineProperty` interceptor installs after X.com already has its reference. The first `TweetResultByRestId` call is never seen by our interceptor.

**Solution**: Two-pronged approach:
1. **Fetch interceptor** (lines 170-222): Uses `Object.defineProperty` on `unsafeWindow` to wrap `window.fetch`. Also adds a `XHR.prototype.open`/`send` interceptor for XHR-based API calls. These catch subsequent API calls (e.g., `TweetDetail`).
2. **On-demand fallback** `fetchVideoUrlDirect()` (lines 120-168): When the user clicks AI Captions and `_videoUrls[tweetId]` is empty (interceptor missed it), makes a direct GraphQL call using `origFetch` (the original page fetch) with the X.com auth bearer token, cookies, and proper headers.

### Issue 11: Duplicated Interceptor Response Handling (Optimization — pre-7.8)
**Problem**: The `Object.defineProperty` fetch wrapper and the direct-assignment fallback contain identical ~20-line response processing logic (clone response → parse JSON → extract tweetId → store URL).
**Suggested Fix**: Extract into a shared `handleFetchResponse(url, promise)` function to eliminate duplication.

---

## Known Bugs

### Bug 1: Global `_videoUrl` Doesn't Track Per-Video
**Severity**: Fixed in v7.7
**Description**: Was a single `_videoUrl` variable. Now uses `_videoUrls = {}` map keyed by tweet ID (line 21).
**Resolution**: Each video URL is stored under its tweet ID. Clicking CC on any video looks up the correct URL.

### Bug 2: No Retry on Transcription Failure
**Severity**: Fixed in v7.7
**Description**: `retryTranscribe()` (lines 539-550) now retries up to 3 attempts with 1.5s delay. Shows progress messages ("Retrying (attempt 2)...", "API failed after 3 attempts").
**Resolution**: Implemented exponential retry with 3 max attempts.

### Bug 3: Translation Model Hardcoded to `mistral-small-latest`
**Severity**: Fixed in v7.0, refined in v7.7
**Description**: The translation step now uses the selected model first (line 574). Falls back to `mistral-small-latest` only if the selected model fails (lines 586-601), then falls back to original text.
**Resolution**: Uses user's selected model for translation; falls back gracefully.

### Bug 4: Settings Panel Can Overlap Player Container
**Severity**: Fixed in v7.0
**Description**: Bounds-checking against `window.innerWidth` and `window.innerHeight` with `Math.max(10, ...)` clamping (lines 441-446).
**Resolution**: Panel position is clamped to viewport on all sides.

### Bug 5: Data-busy State Stuck on Error
**Severity**: Medium
**Description**: If `fetchVideoUrlDirect` callback receives null, the `data-busy` attribute is removed and `busy` is set to false (lines 329-330). But if the GraphQL API call throws synchronously before reaching `.catch()`, the button could stay stuck in busy state.
**Status**: Partially mitigated — `.catch(function() { cb(null); })` handles async errors in the fetch promise chain.
**Suggested Fix**: Add a `try/catch` wrapper around the entire `toggleCC` flow, or add a timeout that resets `busy` after 30s.

---

## Feature Status

### Implemented (v7.7)

| Feature | Details |
|---------|---------|
| CC button in video controls | Injected before mute button, uses native X.com class structure |
| GraphQL video URL capture | Intercepts `TweetResultByRestId` XHR, extracts best MP4 variant |
| Mistral transcription | Multipart POST with `file_url, model, timestamp_granularities=segment` |
| Translation | Language-specific via chat API. Falls back to original on error. |
| Real-time caption sync | 200ms setInterval, matches video.currentTime to segment timestamps |
| Caption positioning | Follows controls bar visibility (52px/8px bottom, always up on pause) |
| Gear menu integration | "Captions" item in native Video Settings. Opens settings panel. |
| Settings panel | Positioned panel with: provider, model, API key, background color, opacity, font size, language |
| Custom providers | Add/remove custom AI providers via `x_captions_custom_providers` in localStorage |
| API key editing | Password field in settings, saves to provider config in-memory |
| Background opacity | Slider (10-100%), combined with hex color → rgba |
| Click-outside-to-close | Settings panel closes when clicking outside (capture phase) |
| Controls bar hover detection | mouseenter/leave + 3s mousemove timeout for auto-hide |
| Auto-update from GitHub | `@downloadURL` and `@updateURL` headers set |
| Dynamic video injection | MutationObserver + retry loop for dynamically loaded videos |
| `data-x-feature` attributes | Custom data attributes for DOM queries: `cc` (button), `co` (caption overlay), `xcs` (settings panel), `x-gc` (gear menu item), `x-gc-s` (hover style) |
| URL-encoded query param parsing | `extractTweetIdFromUrl` robustly handles URL-encoded `variables` GET params for tweetId extraction |
| Fetch API interceptor | `Object.defineProperty` on `unsafeWindow.fetch` + direct-assignment fallback for Firefox |
| On-demand GraphQL fallback | `fetchVideoUrlDirect` makes a direct API call when interceptors miss the initial graphql request |
| Per-video URL tracking via `_videoUrls{}` | Video URLs stored in a dict keyed by tweet ID instead of a single global variable |
| Transcription retry with fallback model | 3 attempts with 1.5s delay + model fallback to `mistral-small-latest` on chat API failure |

### Proposed / Not Implemented

| Feature | Status | Notes |
|---------|--------|-------|
| Loading spinner on CC button | Proposed | CSS animation on button when `busy=true` — partially implemented (pulse/spin on `[data-busy]`) |
| Separate translation model | Proposed | Let user select a different model for translation vs transcription |
| "Copy Transcript" button | Proposed | Export captions as TXT/SRT from settings panel |
| Custom translation prompts | Proposed | Let user customize the translation instruction |
| Multi-segment preview | Proposed | Show current line + faded next line for reading flow |
| Text shadow on captions | Proposed | Better readability against light video backgrounds |
| Auto-detect video in viewport | Proposed | Pre-fetch transcription for visible video without clicking |
| Debug mode toggle | Proposed | Show console logs + `data-x-feature` state on hover |
| Keyboard shortcuts | Proposed | `Ctrl+Shift+C` to toggle captions on active video |
| Fetch interceptor dedup | Proposed | Extract shared response handling in fetch wrappers |

---

## Design Decisions

### Why XHR Interception Instead of Fetch API
X.com uses `XMLHttpRequest` for its GraphQL calls, not `fetch`. We patch `XMLHttpRequest.prototype.send` to read the response. The key insight: we patch `open` to store the URL, then in `send` we add a `load` event listener if the URL contains `TweetResultByRestId`.

### Why @grant none is NOT Used for API Calls
With `@grant none`, the script runs in the page's JavaScript context, which lets us monkey-patch XHR (no need for `unsafeWindow`). However, for Mistral API calls we *must* use `GM_xmlhttpRequest` to bypass CSP. So the script uses `@grant GM_xmlhttpRequest` and checks `typeof unsafeWindow !== 'undefined'` for the XHR patch.

### Why `file_url` Instead of File Upload
Mistral's `/v1/audio/transcriptions` accepts a `file_url` field — just a public URL to the audio/video file. This eliminates the need to download anything client-side. The MP4 URL from `video.twimg.com` is publicly accessible.

### Why Run at document-start
We need to intercept X.com's GraphQL XHR calls before they happen. If the script starts later (e.g., `document-idle`), some video URLs may have already loaded. `document-start` lets us patch `XMLHttpRequest.prototype.send` before X.com's boot script runs.

### Why `MutationObserver` + poll instead of just one
- `MutationObserver` catches new video players being added to the DOM
- `tryGo` polling (500ms intervals, 30s max) handles the case where the video player exists but the controls bar (with mute button) hasn't rendered yet

### Why LocalStorage for Settings Instead of GM_setValue
- `GM_setValue`/`GM_getValue` requires additional `@grant` permissions
- X.com's CSP doesn't block `localStorage`
- Settings persist across script updates
- Custom providers stored separately for clean migration

---

## Settings Panel HTML Structure

The settings panel is built as raw `innerHTML` strings for compactness. Key element IDs:

| ID | Type | Purpose |
|----|------|---------|
| `xcs-provider` | `<select>` | AI provider dropdown |
| `xcs-custom-fields` | `<div>` | Container for custom provider fields (hidden for built-in) |
| `xcs-cust-name` | `<input>` | Custom provider name |
| `xcs-cust-trans` | `<input>` | Custom transcribe URL |
| `xcs-cust-chat` | `<input>` | Custom chat URL |
| `xcs-cust-model` | `<input>` | Custom model name |
| `xcs-model` | `<select>` | Model dropdown |
| `xcs-key` | `<input type="password">` | API key |
| `xcs-bg-picker` | `<input type="color">` | Background color picker |
| `xcs-bg` | `<input>` | Background hex text input |
| `xcs-op` | `<input type="range">` | Opacity slider (10-100) |
| `xcs-op-val` | `<span>` | Opacity percentage display |
| `xcs-size` | `<input type="range">` | Font size slider (10-30) |
| `xcs-size-val` | `<span>` | Font size display |
| `xcs-lang` | `<select>` | Language dropdown |
| `xcs-save` | `<button>` | Save button |
| `xcs-close` | `<button>` | Cancel button |

---

## Testing & Debugging

### Test Video
- **URL**: `https://x.com/PAGE4163929/status/2059432898370167120`
- **Duration**: ~80 seconds (Zakharova press conference)
- **Language**: Japanese (good for testing translation)
- **Result**: 16 segments transcribed, 80.2s, translates to English cleanly

### Debugging Approaches

1. **Console**: Check `[X]` prefixed messages (v6.x had them; v7.0 removed most. Add back in dev.)
2. **DOM Inspection**: Look for `data-x-feature` attributes on injected elements
3. **Network tab**: Filter by `api.mistral.ai` to see API calls
4. **CDP**: Use `browser_cdp` to inspect X.com state:
   ```js
   // Check button presence
   document.querySelectorAll('[data-x-feature="cc"]').length
   // Check video URL
   // Check settings
   JSON.parse(localStorage.getItem('x_captions_settings'))
   ```

### What a Successful GraphQL Interception Looks Like

Check `_videoUrl` in console:
```js
// Should contain something like:
// "https://video.twimg.com/ext_tw_video/1234567890/pu/vid/avc1/720x1280/abc.mp4?tag=12"
```

---

## Current Code Structure

|| Lines | Section | Description |
||-------|---------|-------------|
|| 17-21 | IIFE setup | Strict mode, globals: `_videoUrls`, `caps`, `intv`, `busy`, `SKEY` |
|| 23-58 | Providers | `PROVIDERS` object, `loadCustomProv`, `saveCustomProv`, `buildProviders` |
|| 60-76 | Settings | Defaults, migration from old format, `bgCSS` helper |
|| 78-87 | Helper | `extractTweetIdFromUrl` — URL-encoded query param parsing for tweetId |
|| 107-108 | GraphQL constants | `GRAPHQL_TWEET_RESULT_ID`, `X_AUTH_BEARER` |
|| 110-168 | Fetch interceptor + fallback | `getCookie`, `fetchVideoUrlDirect`, `installFetchInterceptor` |
|| 170-223 | Fetch override | `Object.defineProperty` on `unsafeWindow.fetch` + direct-assignment fallback |
|| 225-248 | XHR override | Monkey-patches `XMLHttpRequest.prototype.open`/`send` for XHR-style API calls |
|| 250-273 | Video URL capture | `captureVideoUrl` — extract best MP4 from GraphQL data |
|| 275-285 | Tweet ID from DOM | `getTweetId` — walks up from video player to find tweet status link |
|| 287-337 | CC Button + Toggle | `mkCC`, `videoPlayer`, `toggleCC` — creates button and handles on/off + fallback |
|| 339-360 | Caption positioning | `hoverSetup`, `updPos` — tracks controls bar visibility |
|| 362-384 | Gear Menu | `injMenu`, `watchMenu` — MutationObserver for settings menu |
|| 386-513 | Settings Panel | `openSett` — full settings UI with all controls |
|| 515-616 | Transcription | `transcribe`, `retryTranscribe`, `handleTranscribe` — API calls + response parsing |
|| 618-645 | Display | `statusMsg`, `showCaps`, `hideCaps`, `ripCaps` — caption overlay |
|| 647-670 | Injection + Init | `inject`, `tryGo`, `init` — bootstrap + MutationObserver |

---

## Git History (HEAD)

Commit `c824409` — v7.7 (Jun 2 2026):
- Added `fetchVideoUrlDirect` — on-demand GraphQL fallback when interceptors miss initial API call
- Added Fetch API interceptor via `Object.defineProperty` on `unsafeWindow.fetch`
- Refactored `toggleCC` to use fallback path when `_videoUrls[tweetId]` is empty
- Added transcription retry with model fallback to `mistral-small-latest`
- Fixed `_videoUrls` global — now a map keyed by tweet ID (was single var)
- Version: 7.7

Commit `9a909bb` — v7.6 (Jun 2 2026):
- Fixed tweetId extraction from URL-encoded GET query params
- Added `extractTweetIdFromUrl()` helper using `decodeURIComponent` + `JSON.parse`
- Updated all 3 interceptor paths (fetch defineProperty, fetch direct-assign, XHR) to use the new helper
- Version: 7.6

Commit `0405510` — v7.0 production cleanup:
- Added editable API Key field in settings
- Added Custom Provider support (name, transcribe URL, chat URL, model)
- Restructured PROVIDERS to rebuild from built-in + custom config
- Refactored `transcribe()` for multi-provider compatibility
- Removed console.log noise
- Renamed functions for clarity
- Removed old artifacts: `SESSION_SUMMARY.md`, `x-debug-captions.user.js`
- Added README.md

Repo URL: `git@github.com:Esashiero/x-captions.git`

---

## Session Review Findings

The following was recovered by systematically searching session `20260530_043515_ef7435` (112 messages, May 30 2026, 04:35-05:39) — the primary development session. The session DB indexed compacted data, so some details were reconstructed from the bootstrapping phase.

### Session Bootstrapping (Messages 33649-33684)

The session started with debugging Chrome CDP connectivity to use a browser profile with Tampermonkey installed.

**CDP Connection Setup:**
- Chrome was running at `/home/shiro/.hermes/chrome-debug/Default` with `--remote-debugging-port=9222`
- The default `browser_navigate` tool spawned a *separate* headless Chromium — it did NOT use the user's debug instance
- Fix: `hermes config set browser.cdp_url "http://127.0.0.1:9222"` (then `/reset` the session)
- Tampermonkey extension ID observed via CDP: `dhdgffkkebhmkfjojejmpbldmpobfkfo`

**DDOM Bridge Debugging Technique:**
Tampermonkey scripts run in an isolated world where `console.log` is invisible to the host page. To bridge this gap, the session created a "DOM Bridge":
```js
const debug = (msg, data) => {
    const fullMsg = `[X-Captions] ${msg}`;
    console.log(fullMsg);  // Tampermonkey can see this locally
    if (document.body) {
        const existing = document.body.getAttribute('data-hermes-log') || '';
        document.body.setAttribute('data-hermes-log',
            (existing + '\n' + fullMsg).slice(-2000));
    }
};
```
The agent then reads via CDP:
```js
browser_cdp({ method: 'Runtime.evaluate',
    params: { expression: 'document.body.getAttribute("data-hermes-log")', returnByValue: true },
    target_id: '<pageId>' });
```
**Status**: This was a development-only tool. The production v7.0 removed it. Not currently present in the script.

### Initial Architecture: Two-File Loader

The script originally had a two-file architecture:
1. **`x-loader.user.js`** — A small Tampermonkey script that:
   - Runs at `document-end`
   - Fetches `x-userscript.js` from `http://localhost:8765/x-userscript.js` (a local Python server)
   - Executes it via `new Function(resp.responseText)`
   - Provides a startup error DOM bridge
2. **`x-userscript.js`** — The actual feature code served from a local dev server

This was eventually consolidated into the single self-contained userscript when we switched to GraphQL XHR interception (which requires `@run-at document-start`).

### Button Placement Evolution

**Early approach (two-file era):** Used `findButtonRow()` — a generic div search:
```js
function findButtonRow(videoPlayer) {
    var divs = videoPlayer.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
        var d = divs[i];
        var btns = d.querySelectorAll(':scope > [role="button"]');
        if (btns.length >= 4 && btns.length <= 8) return d;
    }
    return null;
}
```
**Switched to**: Direct targeting via `[aria-label="Unmute"]` / `[aria-label="Mute"]` and `insertBefore`, which is more reliable.

### Chrome Target ID Volatility

Observed that X.com causes Chrome page target IDs to change frequently (page reloads, React SPA navigation). The CDP `target_id` is not stable — the agent must call `Target.getTargets` fresh before each interaction.

### Model Switching During Session

The session experienced model/provider switches:
- Started with `deepseek/deepseek-v4-flash` via OpenRouter
- Switched to `gemma-4-31b-it` via Google mid-session
- Switched back to `deepseek:deepseek-v4-flash` via Google

**Impact**: Each model switch caused context loss / recalibration. Important to capture critical information before a model switch.

### Skills Discovery

The user discovered the `tampermonkey` skill late in the session (message 33855). Available skills relevant to this project:
- `tampermonkey` (category: software-development, listed as `userscript-dev` internally)
- `browser-live-cdp` (browser-devtools) — interacting with live user-managed Chromium
- `browser-network-intercept` (browser-devtools) — JS monkey-patching for API interception
- `video-caption-injection` (software-development) — HTML5 caption injection patterns for React SPAs

### Gaps in Session DB

- The FTS5 search returned results for only ~1 match per query across the session, suggesting the session DB has compacted/indexed data, not full raw transcripts
- The bulk of development after message 33864 (setting up caption_server.py, switching to single-file architecture, GraphQL interception, gear menu injection) is captured in the compaction summary at the top of the conversation that built this AGENTS.md, but was not directly retrievable via session_search
- Many specific details (settings panel evolution, gear menu mutation observer tuning, video URL mapping attempts) could only be reconstructed from the compaction summary, not from raw session queries
