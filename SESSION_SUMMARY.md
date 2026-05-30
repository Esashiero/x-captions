# X.com AI Captions (x-captions) — Full Project Journal

## Overview

Browser userscript that adds AI-generated captions to X.com video players using Mistral Voxtral for transcription. The goal is fully automatic, zero-infrastructure captioning — click a CC button on any X.com video and get real-time synced captions.

---

## Repository

- **Location:** `/home/shiro/projects/x-captions/`
- **GitHub:** `github.com/Esashiero/x-captions`
- **Userscript:** `x-loader.user.js`
- **GitHub raw URL (auto-update):** `https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js`

---

## Architecture History

### v1.0–v2.2: Server-based approach

**Architecture:**
```
Userscript → local caption_server.py (port 9876) → subtitle.py (yt-dlp + ffmpeg + Mistral SDK) → transcription
```

- `caption_server.py`: HTTP server with `/captions` (submit job) and `/status` (poll results) endpoints
- `subtitle.py`: Uses yt-dlp to extract audio from X.com tweet URL, pipes through ffmpeg to WAV, sends binary to Mistral SDK
- Userscript: Polls server every 1s for up to 180s

**Key files (under `/home/shiro/projects/data-collector/`):**
- `caption_server.py` — 155 lines
- Reference: `subtitle.py` at `~/.hermes/skills/media/mistral-subtitle/scripts/subtitle.py`

**What worked:** End-to-end transcription pipeline was reliable (~5s for 80s video, 16 segments)

**What failed:** Required running `python3 caption_server.py --port 9876` on the user's PC. User wanted zero-infrastructure solution.

### v3.0–v3.5: HLS audio capture (browser-only)

**Architecture:**
```
Userscript → intercept XHR/fetch for HLS playlist URLs → parse audio playlist → download init MP4 + .m4s segments via GM_xmlhttpRequest → concatenate into fMP4 → upload to Mistral transcription API via multipart/form-data → captions
```

**Key changes by version:**

| Version | Change |
|---------|--------|
| v3.0   | Initial browser-only attempt. Extracted video URL from `<video>` element → sent to Mistral `file_url`. Failed because X.com uses blob URLs (MediaSource/HLS), not direct MP4 URLs. |
| v3.1   | Added XHR interceptor to catch HLS playlist URLs. Used `fetch()` for segment downloads (CORS issues). Failed with "No audio found" or "Net error". |
| v3.1.1 | Fixed master playlist parsing — `line.indexOf('#EXT-X-MEDIA:TYPE=AUDIO')` at index 0 failed because actual line starts with `NAME="Audio"`. Changed to `TYPE=AUDIO` anywhere. |
| v3.2   | Swapped `fetch()` for `GM_xmlhttpRequest` via `@connect video.twimg.com`. Fixed `findPlaylistUrl()` to look for audio playlists (`mp4a`) instead of master. BUT: introduced new bug — `text.length` in for loop instead of `text.split('\n').length`. |
| v3.3   | Added `fetch()` interceptor alongside XHR. Fixed text.split bug. BUT: interceptor caught VIDEO playlist (`avc1/1920x1080`) first, uploaded video-only data to Mistral → "Audio input could not be decoded". |
| v3.4   | Tracked 3 playlist types separately: `_audioM3u8`, `_masterM3u8`, `_videoM3u8`. Priority: audio > master > video. Correctly found `mp4a/128000` audio playlist. Mistral still said "Audio input could not be decoded" — binary data corruption in GM_xmlhttpRequest. |
| v3.5   | Added `overrideMimeType: 'text/plain; charset=x-user-defined'` to all GM_xmlhttpRequest calls. Still failed — the multipart body string conversion (`String.fromCharCode`) was corrupting binary data during the POST, not just the GET. |

**Root cause of v3.x failure:**
1. X.com uses HLS streaming with separate video-only (`avc1/`) and audio-only (`mp4a/`) streams
2. Audio segments are `.m4s` files (fragmented MP4 with AAC audio)
3. Concatenating init + segments produces a valid fMP4 — **confirmed working from terminal** (curl → Mistral = success)
4. BUT: `GM_xmlhttpRequest` can't reliably transmit binary data. The `responseText` is a UTF-8 string. Converting back via `charCodeAt() & 0xFF` loses or corrupts bytes > 127. Custom multipart body construction adds another layer of potential corruption.

### v4.0: MediaRecorder audio capture (current, UNTESTED)

**Architecture:**
```
Userscript → create AudioContext from <video> element → MediaRecorder captures audio stream → video plays muted → convert recorded WebM blob to base64 via FileReader → send JSON to Mistral chat completions with input_audio type → captions
```

**Key changes from v3.x:**
- No HLS parsing at all (removed XHR/fetch interceptor, playlist parsing, segment download)
- Records audio directly from the browser's video element
- Uses `input_audio` (base64) content type in the chat completions endpoint — **no binary data in the HTTP request**, just JSON with a base64 string
- Video must play through once at 1x speed (84s video ≈ 84s recording)
- Reverted to `@run-at document-end` (no need for document-start interception)

**Known potential issues in v4.0 (UNTESTED):**
1. `ctx.createMediaElementSource(video)` can only be called once per video element lifetime. If the user has already interacted with the video (played/paused), subsequent clicks may throw an error.
2. X.com's video player has a custom React-based UI — might conflict with AudioContext creation (autoplay policies, audio focus).
3. The Mistral chat completions API's response format for `input_audio` might differ from the transcription API. It may return `choices[0].message.content` instead of `segments`. The v4.0 code handles both formats.
4. Base64 encoding inflates the audio size by ~33%. A 1.5MB WebM becomes ~2MB base64.
5. GM_xmlhttpRequest `data` field accepts a string — the JSON body shouldn't have binary issues, but very large requests (>10MB) might hit limits.

**How the Mistral chat API input_audio works:**
- Endpoint: `POST /v1/chat/completions`
- Model: `voxtral-mini-latest`
- The `input_audio` field accepts base64-encoded audio data
- Supported formats: mp3, wav, m4a, flac, ogg (Ostensibly. WebM/Opus is unlisted but FFmpeg on their end might handle it.)
- Returns: transcription text in `choices[0].message.content`, plus `segments` array if available

---

## How X.com Video Delivery Works

When a video tweet loads on x.com:

1. **Page renders** the tweet with an embedded video element
2. **Video player component** (`PlayerHls1.5`) initializes — this is X.com's custom HLS.js wrapper
3. **Master playlist** requested via XHR:
   `https://video.twimg.com/ext_tw_video/{VIDEO_ID}/pu/pl/{HASH}.m3u8?tag=25`
   Contains references to video and audio variants
4. **Audio playlist** requested:
   `https://video.twimg.com/ext_tw_video/{VIDEO_ID}/pu/pl/mp4a/{BITRATE}/{HASH}.m3u8`
   Contains init segment URL + .m4s segment URLs
5. **Video playlist** requested:
   `https://video.twimg.com/ext_tw_video/{VIDEO_ID}/pu/pl/avc1/{RES}/{HASH}.m3u8`
6. **Segments streamed** in chunks:
   - Audio init: `/pu/aud/mp4a/0/0/{BITRATE}/{HASH}.mp4` (~786 bytes, header only)
   - Audio segments: `/pu/aud/mp4a/{START}/{END}/{BITRATE}/{HASH}.m4s` (~48KB each, 3s intervals)
   - Video init: `/pu/vid/avc1/0/0/{RES}/{HASH}.mp4`
   - Video segments: `/pu/vid/avc1/{START}/{END}/{RES}/{HASH}.m4s`
7. **Video element** gets a blob URL via MediaSource — direct MP4 URL is NOT exposed

**Audio bitrates available:** 32000, 64000, 128000 (highest quality)
**Direct MP4 URLs** (non-HLS): `http-{BITRATE}` formats via `pu/vid/avc1/{RES}/{HASH}.mp4?tag=25` — these DO contain both video + AAC audio. Mistral accepted one via `file_url` in terminal tests.

**Direct MP4 URLs tested (terminal, works):**
```bash
# 720p version, sent to Mistral via file_url:
curl -X POST https://api.mistral.ai/v1/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F 'model=voxtral-mini-latest' \
  -F 'file_url=https://video.twimg.com/ext_tw_video/2059431104462139392/pu/vid/avc1/1280x720/mzRRfZchbdaU5C4R.mp4?tag=25' \
  -F 'timestamp_granularities=segment'
# Result: 16 segments, 83s audio, 3.2s response time
```

---

## What Works (Terminal/Server-Side)

These are **confirmed working** from the terminal, proving the backend pipeline is correct:

```bash
# 1. yt-dlp extracts video info
yt-dlp --dump-json "https://x.com/PAGE4163929/status/2059432898370167120"

# 2. Audio playlist fetched successfully
curl -s "https://video.twimg.com/ext_tw_video/2059431104462139392/pu/pl/mp4a/128000/yGozT61OsApQaEO9.m3u8"

# 3. HLS audio segments concatenated into fMP4
python3 /tmp/test_hls_pipeline.py
# Result: 29 segments → 1.3MB fMP4 → Mistral → 16 segments in 2.7s

# 4. Direct MP4 URL works via file_url
curl -X POST https://api.mistral.ai/v1/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F 'model=voxtral-mini-latest' \
  -F 'file_url=https://video.twimg.com/ext_tw_video/2059431104462139392/pu/vid/avc1/1280x720/mzRRfZchbdaU5C4R.mp4?tag=25' \
  -F 'timestamp_granularities=segment'
# Result: 16 segments, 83s
```

---

## What's Broken (Browser-Side)

| Issue | Why | Status in v4.0 |
|-------|-----|-----------------|
| X.com video URLs are blob (MediaSource) | HLS streaming, not direct MP4 | ✅ Avoided (records audio instead) |
| XHR interceptor catches video playlist before audio | `avc1/` loads before `mp4a/` | ✅ Avoided (no HLS at all) |
| `fetch()` to video.twimg.com blocked by CORS | Cross-origin restrictions | ✅ Avoided (uses MediaRecorder on same-origin video element) |
| `GM_xmlhttpRequest` corrupts binary data | UTF-8 string conversion mangles bytes > 127 | ✅ Avoided (base64 encodes audio, JSON body is pure text) |
| `overrideMimeType` doesn't fix upload corruption | The upload string conversion (not the download) was the issue | ✅ Avoided (no binary in the request) |
| fMP4 (init + .m4s segments) not valid audio | Mistral's backend may not handle fragmented MP4 | ✅ Avoided (MediaRecorder produces standard WebM/Opus) |

---

## Open Questions for v4.0

1. **Does MediaRecorder + AudioContext work on X.com's video player?** The `createMediaElementSource()` call can only be made once per video element. X.com's React component may create/destroy video elements. If the video was already played, this will throw.

2. **Does Mistral's chat completions API accept WebM/Opus via input_audio?** Known supported formats are mp3, wav, m4a, flac, ogg. WebM uses Opus codec which FFmpeg handles, but the API might reject the container format.

3. **What if `createMediaElementSource` fails?** Fallback: use `captureStream()` on the video element (HTMLMediaElement.captureStream() returns a MediaStream with both video and audio tracks). Filter audio tracks only.

4. **What about very long videos?** >10min would require 10+ min of real-time playback. v4.0 plays at 1x. Could add 2x-4x speed option.

5. **What if the audio context is suspended?** Browsers require user gesture to create AudioContext. Since the CC button click IS a user gesture, this should work. But some browsers suspend AudioContext by default.

---

## Alternative Approach NOT Yet Tried

### Direct MP4 URL via Mistral file_url

This is the cleanest approach that we KNOW works (tested from terminal):

1. Get the X.com video's direct MP4 URL from the tweet's video_info (`http-2176` format: `pu/vid/avc1/1280x720/{HASH}.mp4?tag=25`)
2. Pass it to Mistral's `file_url` parameter
3. No binary data handling, no multipart upload, no recording needed
4. Mistral accepts MP4 with AAC audio (confirmed working)

The challenge: getting the direct MP4 URL from the browser. Options:
- **Intercept the GraphQL API response** that contains `video_info.variants` — the URL is there
- **Extract from X.com's React state** — find the tweet data in React internals
- **Call the X.com guest API** — use the public bearer token to fetch tweet data
- **Parse from the page's `<script>` tags** — tweet data might be embedded as JSON-LD

The X.com API bearer token is static: `AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`

The API endpoint for tweet details:
```
GET https://api.x.com/2/tweets/{id}?expansions=attachments.media_keys&media.fields=variants
```

But this requires OAuth bearer token (app-only auth), not the public client token.

---

## Configuration

- **Mistral API key:** `dGjgnYE6kcY5aTFjExd5lD5DAMN1U1ld` (in userscript)
- **Model:** `voxtral-mini-latest`
- **Test video:** `https://x.com/PAGE4163929/status/2059432898370167120` (Zakharova press conference, 84s, Japanese)
- **Audio bitrate:** 128kbps AAC

---

## How to Test (v4.0)

1. Install/update the userscript at the Tampermonkey editor URL:
   `chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=77ba56fb-2b88-46ce-bcdf-f52a8ccd7b49+editor`

2. Navigate to `https://x.com/PAGE4163929/status/2059432898370167120`

3. Let the video player load. The CC button ("AI Captions") should appear next to the volume/mute button.

4. Click the CC button. The script will:
   - Show "Starting..." then "Recording..."
   - Play the video muted at 1x speed
   - Record audio via MediaRecorder
   - Show progress percentage (0-100%)
   - Show "Encoding..." then "Transcribing..."
   - Show captions when done

5. Check browser console (`F12 → Console`) for `[X]` prefixed logs

## Console Log Reference

| Log | Meaning |
|-----|---------|
| `[X] v4.0` | Script loaded |
| `[X] recording audio...` | MediaRecorder started |
| `[X] mime: audio/webm;codecs=opus` | Recording format |
| `[X] recorded: X bytes` | Recording complete |
| `[X] base64: X KB` | Base64 encoding complete |
| `[X] Mistral: {...}` | Mistral API response |
| `[X] OK X` | Transcription succeeded, X segments |
| `[X] {object: "error", ...}` | Mistral API error |
