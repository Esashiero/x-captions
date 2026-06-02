# X.com AI Captions

AI-powered captions for X/Twitter videos. Click the CC button, get real-time captions — no server needed, runs entirely in your browser via Mistral AI.

**Latest version**: v7.7 — GraphQL fallback for Chrome timing + URL-encoding fix

## Features

- **CC button** in the video controls bar — click to transcribe any video
- **Real-time captions** synced to video playback
- **Gear menu integration** — "Captions" item appears in the native Video Settings dropdown
- **Translation** to English, French, Spanish, German, Japanese, or original language
- **Customizable** background color, opacity, font size
- **Multiple AI providers** — built-in Mistral AI, plus support for custom providers
- **No server** — everything runs in-browser via API calls

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Open the userscript install link: [x-loader.user.js](https://raw.githubusercontent.com/Esashiero/x-captions/main/x-loader.user.js)
3. Tampermonkey will detect it — click **Install**
4. Reload X.com and hover over any video

The script auto-updates from GitHub. Tampermonkey checks for updates periodically.

## Usage

1. Hover over any video on X.com
2. Click the **CC** button in the video controls bar
3. Wait a few seconds — captions appear in the video overlay
4. Click the **gear icon** → **Captions** to open settings

### Settings

| Setting | Description |
|---------|-------------|
| AI Provider | Mistral AI (built-in) or custom providers |
| Model | Select the model for transcription |
| API Key | Your API key (pre-filled for built-in providers) |
| Background | Color + opacity for the caption overlay |
| Font Size | Caption text size (10-30px) |
| Language | Target language for translation (or Original) |

### Custom Providers

You can add any OpenAI-compatible transcription API:

1. Open the Captions settings from the gear menu
2. Pick any built-in provider to use it directly
3. Use the API Key field to set your own key

For a completely custom endpoint, the provider config is stored in `localStorage` under `x_captions_custom_providers` — you can edit it directly in the browser console. The expected format:

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

## How It Works

1. **Video URL capture**: Intercepts X.com's GraphQL API response to get the direct MP4 URL
2. **Transcription**: Sends the MP4 URL to Mistral's API (uses `file_url`, no download needed)
3. **Translation**: If a target language is selected, translates via Mistral's chat API
4. **Display**: Shows captions overlaid on the video, synced to playback time

## Development

```bash
# Clone
git clone https://github.com/Esashiero/x-captions.git
cd x-captions

# Edit
vim x-loader.user.js

# The script is a single-file Tampermonkey userscript.
# No build step needed — just edit and reload X.com.
```

To test changes, either:
- Paste the script into Tampermonkey's editor
- Or install via the GitHub raw URL (auto-update enabled)

## File Structure

```
x-captions/
├── x-loader.user.js   # Main userscript (single file, ~670 lines)
├── README.md          # End-user docs
└── AGENTS.md          # Dev reference (X.com DOM, fixes, architecture)
```

## License

MIT
