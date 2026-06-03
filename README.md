# X.com AI Captions

AI-powered closed captions for X/Twitter videos. Click the CC button in the video controls bar, get real-time captions synced to playback.

No server needed — runs entirely in your browser via Mistral AI. One-click install with Tampermonkey.

## Features

- **CC button** in the native video controls bar — click to transcribe any video
- **Real-time captions** synced to video playback position
- **Translation** to English, French, Spanish, German, Japanese, or keep the original language
- **Customizable appearance** — background color, opacity, font size
- **Multiple AI providers** — Mistral AI (built-in) plus support for any OpenAI-compatible API
- **Gear menu integration** — "Captions" item in the native video settings dropdown
- **Auto-discovers videos** — works on the timeline, in quote tweets, embedded videos, and expanded media
- **No server infrastructure** — everything runs in-browser via API calls

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser (Chrome, Firefox, Edge, Safari)
2. Open the install link: [x-loader.user.js](https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js)
3. Tampermonkey will detect it — click **Install**
4. Reload X.com and hover over any video with audio

The script auto-updates from GitHub. Tampermonkey checks for updates periodically.

## Quick Start

After installing, open any video on X.com:

1. Hover over the video to reveal the controls bar
2. Click the **CC** button (closed caption icon in the controls)
3. The first time, you'll need to set an API key (see below)
4. Captions appear overlaid on the video within seconds

### Getting an API Key

The script needs an API key to transcribe audio. Mistral AI offers a generous free tier:

1. Go to [console.mistral.ai](https://console.mistral.ai/) and create an account
2. Navigate to **API Keys** and generate a new key
3. On X.com, click the gear icon on any video → **Captions** → paste your key in the API Key field
4. Click **Save**

The key is stored in your browser's localStorage — it never leaves your machine.

## Usage

### Basic Controls

| Action | Result |
|--------|--------|
| Hover video → click CC | Toggle captions on/off |
| Hover video → click gear → Captions | Open settings panel |
| Click CC while captions are active | Hide captions |

### Settings

| Setting | Description |
|---------|-------------|
| AI Provider | Mistral AI or custom providers |
| Model | Select the transcription model |
| API Key | Your API key (get one at console.mistral.ai) |
| Background | Caption overlay color |
| Opacity | Caption background transparency |
| Font Size | Caption text size (10–30px) |
| Language | Translation target (or "Original" for no translation) |

### Custom Providers

You can use any OpenAI-compatible transcription API:

1. Open Captions settings from the gear menu
2. Pick Mistral AI and enter your own key
3. Or use the browser console to add a custom provider via `localStorage`:

```json
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

Store it under `localStorage.x_captions_custom_providers` and reload the page.

## How It Works

1. **Video URL capture** — Intercepts X.com's GraphQL API responses to extract the direct MP4 URL for each video
2. **Transcription** — Sends the MP4 URL to Mistral's API (uses `file_url`, no download needed)
3. **Translation** — If a target language is selected, translates via Mistral's chat API
4. **Display** — Shows captions overlaid on the video, synced to playback time via a 200ms interval

All processing happens in your browser. No data is sent to any server other than the AI provider you configure.

## Development

```bash
git clone https://github.com/Esashiero/x-captions.git
cd x-captions
```

The script is a single Tampermonkey userscript — no build step, no dependencies. Edit `x-loader.user.js` and reload X.com to test.

To test changes:
- Paste the script directly into Tampermonkey's editor
- Or install via the GitHub raw URL (auto-update will pick up changes after commit)

## File Structure

```
x-captions/
├── x-loader.user.js   # Main userscript (single file, ~700 lines)
└── README.md          # This file
```

## Feature Ideas & Roadmap

These are features under consideration. Contributions welcome.

### High Priority

**Shared Caption Database** — A central, crowdsourced caption store so users don't need to generate their own captions for the same video twice. When a user transcribes a video, the captions are submitted to a shared DB. Anyone else watching the same video gets instant captions without an API call. Falls back to on-demand transcription for uncached videos.

This is the single highest-impact feature: it eliminates the API key requirement for the majority of popular videos and makes the script work out of the box for new users.

### Medium Priority

- **SRT/VTT export** — Download captions as standard subtitle files for offline use
- **Keyboard shortcut** — Ctrl+Shift+C to toggle captions (X.com is keyboard-heavy)
- **Auto-caption on mute** — X.com defaults videos to muted; show captions automatically when audio is off
- **Progress bar markers** — Subtle indicators on the video timeline showing where caption segments change
- **Multi-language overlay** — Show original + translation simultaneously (language learning mode)

### Lower Priority / Niche

- **Custom CSS themes** — Inject user-defined styles for caption appearance
- **Caption history scrollback** — Scrollable log of recent captions during playback
- **Timestamp links** — Click a caption to jump to that point in the video
- **Bookmark & annotate** — Add notes to specific timestamps

### Done

- v1.0 — CC button in native controls bar, real-time captions, translation, custom providers, per-video caption storage, auto-discovery of timeline videos

## License

MIT
