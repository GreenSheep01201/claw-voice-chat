<p align="center">
  <img src="client/public/claw-icon.svg" width="80" alt="Claw Voice Chat" />
</p>

<h1 align="center">Claw-Voice-Chat</h1>

<p align="center">
  <strong>Push-to-Talk Voice Chat for OpenClaw Channels</strong><br>
  Connect to Telegram, Discord, Slack, or any <a href="https://github.com/openclaw/openclaw">OpenClaw</a> channel and interact using voice or text.<br>
  Messages are transcribed via STT, sent to the AI agent, and responses stream back with configurable TTS.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/python-%3E%3D3.10-blue" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-orange" alt="License" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="Platform" />
  <img src="https://img.shields.io/badge/STT-faster--whisper-blueviolet" alt="STT" />
  <img src="https://img.shields.io/badge/TTS-Browser%20%7C%20OpenAI%20%7C%20edge--tts-blueviolet" alt="TTS" />
</p>

<p align="center">
  <a href="#install-with-ai">Install with AI</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#tts-providers">TTS</a> &middot;
  <a href="#stt-backend-push-to-talk">STT</a> &middot;
  <a href="#environment-variables">Config</a> &middot;
  <a href="#ai-setup-guide">AI Guide</a> &middot;
  <a href="README.ko.md">한국어</a>
</p>

---

## Install with AI

> **Just paste this to your AI coding agent (Claude Code, Codex, Cursor, Gemini CLI, etc.):**
>
> ```
> Install claw-voice-chat following the guide at:
> https://github.com/GreenSheep01201/claw-voice-chat
> ```
>
> The AI will read this README and handle everything automatically.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [TTS Providers](#tts-providers)
  - [Local TTS Server (edge-tts)](#local-tts-server-edge-tts)
  - [STT Backend (Push-to-Talk)](#stt-backend-push-to-talk)
- [Usage](#usage)
- [Remote Access (Mobile)](#remote-access-mobile--other-devices)
- [Environment Variables](#environment-variables)
- [AI Setup Guide](#ai-setup-guide)
  - [Server Endpoints Reference](#server-endpoints-reference)
  - [Key Files](#key-files)
  - [WebSocket Protocol](#websocket-protocol-wschat)
  - [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- **Push-to-talk** voice input with real-time STT (faster-whisper)
- **Channel bridge** — select any active OpenClaw session and talk to it
- **Streaming transcript** — agent responses arrive token by token
- **Configurable TTS** — Browser (Web Speech API), OpenAI, Qwen/DashScope, or Custom endpoint
- **STT language selection** — language hint for faster-whisper (Korean, English, Japanese, Chinese, etc.)
- **Local TTS server** — included edge-tts wrapper for high-quality TTS without API keys
- **Voice preview** — test TTS voices before saving
- **Model catalog** — browse models from connected providers
- **Text input** — type messages with `Ctrl+Enter` / `Cmd+Enter`
- **Standalone LLM mode** — works without channel connection using a local LLM backend

## Architecture

```
Browser (React + Tailwind)
   |
   | port 8888 (HTTP + WebSocket)
   v
Express Server (Node.js)
   |
   |--- /bridge/*      --> OpenClaw Gateway (port 18789)
   |--- /bridge/tts    --> TTS Proxy (OpenAI / Qwen / Custom / Local)
   |--- /api/* /ws/*   --> STT/TTS Backend (port 8766) [optional]
   |
   v
OpenClaw Gateway --> Telegram, Discord, Slack, Signal, ...
```

### Operating Modes

| Mode | Requirements | Description |
|------|-------------|-------------|
| **Channel Bridge** | Node.js + OpenClaw Gateway | Text/voice to channels. Browser or external TTS for responses. |
| **Standalone LLM** | Node.js + Python STT/TTS backend | Full voice pipeline: push-to-talk, local STT, LLM, audio TTS. |

Both modes can run simultaneously. The Python backend is only needed for push-to-talk STT.

## Requirements

- **Node.js 22+** ([download](https://nodejs.org/))
- **OpenClaw Gateway** running locally (for channel bridge)
- **Python 3.10+** (only for local TTS server or STT backend — optional)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/GreenSheep01201/claw-voice-chat.git
cd claw-voice-chat
npm install && cd client && npm install && cd ../server && npm install && cd ..
npm run stt:install   # Python STT backend dependencies
```

### 2. Set up OpenClaw Gateway

```bash
npm install -g openclaw
openclaw setup          # connect channels, create config
openclaw gateway run    # starts on port 18789
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=8888
NODE_ENV=production
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-token-here

# Model catalog — path to openclaw CLI binary or openclaw.mjs entry point.
# Required for OAuth provider models (GitHub Copilot, Google Antigravity, etc.)
# to appear in the Options model picker.
OPENCLAW_CLI=openclaw
```

Get your token:
- **macOS/Linux:** `cat ~/.openclaw/openclaw.json | grep token`
- **Windows:** `type %USERPROFILE%\.openclaw\openclaw.json | findstr token`

Or extract it programmatically:
```bash
python -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['gateway']['auth']['token'])"
```

### 4. Build and run

```bash
npm run build
npm start       # starts Express (8888) + STT backend (8766) concurrently
```

Open http://127.0.0.1:8888

> To run only the Express server without STT: `npm run start:server`

### 5. Development mode

```bash
npm run dev    # Vite (5173) + Express (8888) + STT (8766) concurrently
```

## TTS Providers

Configure in **Options > TTS / STT** tab.

| Provider | Setup | Quality | Latency |
|----------|-------|---------|---------|
| **Browser** | Built-in, no setup | Varies by OS | Instant |
| **OpenAI** | API key required | Excellent | ~1s |
| **Qwen/DashScope** | API key required | Good | ~1s |
| **Custom** | Any OpenAI-compatible endpoint | Varies | Varies |
| **Local (edge-tts)** | `pip install edge-tts` | Excellent | ~2s |

### Local TTS Server (edge-tts)

High-quality TTS without API keys. Works on **macOS, Linux, and Windows**.

**Setup:**

```bash
pip install edge-tts fastapi uvicorn
python tts-local/server.py
```

**Connect in UI:**
1. Options > TTS / STT tab
2. Select **Custom**
3. URL: `http://localhost:5050/v1/audio/speech`
4. Leave API Key empty
5. Voice: `sunhi` (Korean), `echo` (English), `nanami` (Japanese)
6. Click **Preview Voice** to test

**Available voices:**

| Language | Voices |
|----------|--------|
| Korean | `sunhi`, `inwoo`, `hyunsu` |
| English | `alloy`, `nova`, `echo`, `onyx`, `shimmer` |
| Japanese | `nanami`, `keita` |
| Chinese | `xiaoxiao`, `yunxi`, `xiaoyi` |

**Run in background:**

```bash
# macOS/Linux
nohup python tts-local/server.py > /tmp/tts-local.log 2>&1 &

# Windows (PowerShell)
Start-Process -NoNewWindow python -ArgumentList "tts-local/server.py"
```

**Verify:**

```bash
curl http://127.0.0.1:5050/health
# {"ok":true,"backend":"edge"}
```

### STT Backend (Push-to-Talk)

The included `stt-backend/` provides real-time speech-to-text using [faster-whisper](https://github.com/SYSTRAN/faster-whisper). It starts automatically with `npm start`.

**Manual startup** (if running separately):

```bash
npm run stt:install   # pip install -r stt-backend/requirements.txt
npm run stt:start     # starts on port 8766
```

**Configuration:**

STT model size and language can be configured in the **Options > TTS / STT** tab in the UI. Changes take effect on the next WebSocket connection (reconnect).

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| **Model Size** | Tiny, Base, Small, Medium, Large v3 | Medium | Accuracy vs speed trade-off |
| **Language** | Auto-detect, Korean, English, Japanese, + 12 more | Auto (browser locale) | Language hint for recognition |

Environment variables (`.env`) set the server-side defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `STT_MODEL_SIZE` | `medium` | Default model when client doesn't specify |
| `STT_DEVICE` | `auto` | Device: `auto`, `cpu`, `cuda` |
| `STT_COMPUTE_TYPE` | `int8` | Compute type: `int8`, `float16`, `float32` |

Models are cached in memory — switching sizes in the UI loads the new model once and reuses it for subsequent connections.

## Usage

1. Click **Connect** to establish the WebSocket connection
2. Click **Enable Audio** to unlock browser audio
3. Select a channel from the dropdown (e.g., Telegram bot session)
4. **Hold to Speak** — hold the button, speak, release to send
5. Or type in the text box and press `Ctrl+Enter` / `Cmd+Enter`
6. Toggle **TTS On/Off** to control voice output

## Remote Access (Mobile / Other Devices)

Microphone access requires a **secure context** (HTTPS or localhost). When accessing from a phone, tablet, or another machine over plain HTTP, the browser blocks microphone input silently.

**Recommended: Tailscale HTTPS**

[Tailscale](https://tailscale.com/) provides automatic HTTPS certificates for devices on your tailnet.

```bash
# Expose the voice-chat server (port 8888) over Tailscale HTTPS
tailscale serve --bg 8888
```

Access from mobile: `https://your-machine.tail12345.ts.net/`

> **Important:** Do NOT append `:8888` to the Tailscale URL. Tailscale serves HTTPS on port 443 and proxies internally to 8888. Accessing `http://your-machine:8888` directly is plain HTTP and microphone will not work.

**Verify HTTPS is active:**

```bash
curl -sk https://your-machine.tail12345.ts.net/healthz
# Expected: {"ok":true,"port":8888,...}
```

**Stop Tailscale serve:**

```bash
tailscale serve --https=443 off
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8888` | Express server port |
| `NODE_ENV` | No | `development` | `production` serves built client |
| `VCB_BACKEND_HTTP` | No | `http://127.0.0.1:8766` | STT/TTS backend URL |
| `OPENCLAW_GATEWAY_URL` | For bridge | `http://127.0.0.1:18789` | OpenClaw gateway URL |
| `OPENCLAW_GATEWAY_TOKEN` | For bridge | — | Gateway auth token |
| `OPENCLAW_CLI` | For models | — | Path to `openclaw` binary or `openclaw.mjs`. Required for OAuth models (GitHub Copilot, etc.) |
| `STT_MODEL_SIZE` | No | `medium` | faster-whisper model size (`tiny`/`base`/`small`/`medium`/`large-v3`) |
| `STT_DEVICE` | No | `auto` | STT device (`auto`/`cpu`/`cuda`) |
| `STT_COMPUTE_TYPE` | No | `int8` | STT compute type (`int8`/`float16`/`float32`) |

All variables are loaded from `.env` at project root via dotenv.

## macOS LaunchAgent

See [`launchd/README.md`](launchd/README.md) for background service templates.

---

## AI Setup Guide

> **For AI coding assistants** (Claude, Cursor, Copilot, etc.) setting up this project on a user's machine.
> Run each step sequentially. All commands are copy-paste ready.
> This guide is designed for **one-shot execution** — no manual editing required.

### Platform Detection

Detect the platform first. All subsequent steps use `$IS_WIN` to branch.

**macOS / Linux (bash/zsh):**
```bash
IS_WIN=false
```

**Windows (PowerShell):**
```powershell
$IS_WIN = $true
```

### Step 1: Check Prerequisites

```bash
# macOS / Linux
node --version    # Must be 22+. If missing: https://nodejs.org/
python --version  # Must be 3.10+. If missing: https://www.python.org/downloads/
```

```powershell
# Windows PowerShell
node --version    # Must be 22+. If missing: https://nodejs.org/
python --version  # Must be 3.10+. If missing: https://www.python.org/downloads/
```

> If `node` or `python` is not found, install them before proceeding.
> On Windows, install Python from python.org (not Microsoft Store) to avoid PATH issues.

### Step 2: Install OpenClaw Gateway

The channel bridge requires a running OpenClaw gateway. Skip this step if the gateway is already installed and running.

```bash
# macOS / Linux
npm install -g openclaw
openclaw setup          # interactive — connect channels, configure providers
openclaw gateway run &  # starts gateway on port 18789 in background
sleep 3                 # wait for gateway to initialize
```

```powershell
# Windows PowerShell
npm install -g openclaw
openclaw setup
Start-Process -NoNewWindow -FilePath "openclaw" -ArgumentList "gateway","run"
Start-Sleep -Seconds 3
```

> If you already have `openclaw` installed, just ensure the gateway is running:
> `curl -s http://127.0.0.1:18789/healthz` should return `{"ok":true,...}`

### Step 3: Clone and Install

```bash
# macOS / Linux
git clone https://github.com/GreenSheep01201/claw-voice-chat.git
cd claw-voice-chat
npm install && cd client && npm install && cd ../server && npm install && cd ..
pip install -r stt-backend/requirements.txt
```

```powershell
# Windows PowerShell
git clone https://github.com/GreenSheep01201/claw-voice-chat.git
cd claw-voice-chat
npm install; cd client; npm install; cd ..\server; npm install; cd ..
pip install -r stt-backend\requirements.txt
```

### Step 4: Configure .env (Auto)

```bash
# macOS / Linux — fully automatic, no manual editing needed
cp .env.example .env

# Auto-detect gateway token
TOKEN=$(python -c "import json,os; print(json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))['gateway']['auth']['token'])" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  sed -i.bak "s/^OPENCLAW_GATEWAY_TOKEN=.*/OPENCLAW_GATEWAY_TOKEN=$TOKEN/" .env && rm -f .env.bak
  echo "OK: Token configured (${TOKEN:0:8}...)"
else
  echo "WARNING: Gateway token not found. Set OPENCLAW_GATEWAY_TOKEN in .env manually."
  echo "  Hint: cat ~/.openclaw/openclaw.json | grep token"
fi

# Auto-detect openclaw CLI path
CLI_PATH=$(which openclaw 2>/dev/null || echo "")
if [ -z "$CLI_PATH" ]; then
  for p in ../openclaw/openclaw.mjs ../../openclaw/openclaw.mjs /usr/local/lib/node_modules/openclaw/openclaw.mjs; do
    if [ -f "$p" ]; then CLI_PATH=$(cd "$(dirname "$p")" && pwd)/$(basename "$p"); break; fi
  done
fi
if [ -n "$CLI_PATH" ]; then
  sed -i.bak "s|^OPENCLAW_CLI=.*|OPENCLAW_CLI=$CLI_PATH|" .env && rm -f .env.bak
  echo "OK: OPENCLAW_CLI=$CLI_PATH"
else
  echo "NOTE: openclaw CLI not found in PATH. Model catalog will be empty."
fi
```

```powershell
# Windows PowerShell — fully automatic
Copy-Item .env.example .env

# Auto-detect gateway token
try {
  $config = Get-Content "$env:USERPROFILE\.openclaw\openclaw.json" | ConvertFrom-Json
  $token = $config.gateway.auth.token
  if ($token) {
    (Get-Content .env) -replace '^OPENCLAW_GATEWAY_TOKEN=.*', "OPENCLAW_GATEWAY_TOKEN=$token" | Set-Content .env
    Write-Host "OK: Token configured ($($token.Substring(0,8))...)"
  }
} catch {
  Write-Host "WARNING: Gateway token not found. Set OPENCLAW_GATEWAY_TOKEN in .env manually."
}

# Auto-detect openclaw CLI path
$cliPath = (Get-Command openclaw -ErrorAction SilentlyContinue).Source
if (-not $cliPath) {
  foreach ($p in "..\openclaw\openclaw.mjs", "..\..\openclaw\openclaw.mjs") {
    if (Test-Path $p) { $cliPath = (Resolve-Path $p).Path; break }
  }
}
if ($cliPath) {
  (Get-Content .env) -replace '^OPENCLAW_CLI=.*', "OPENCLAW_CLI=$cliPath" | Set-Content .env
  Write-Host "OK: OPENCLAW_CLI=$cliPath"
} else {
  Write-Host "NOTE: openclaw CLI not found. Model catalog will be empty."
}
```

### Step 5: Build and Start

```bash
# macOS / Linux
npm run build
npm start &    # starts Express (8888) + STT backend (8766) concurrently
sleep 5        # wait for servers to initialize (STT model downloads on first run)
```

```powershell
# Windows PowerShell
npm run build
Start-Process -NoNewWindow npm -ArgumentList "start"
Start-Sleep -Seconds 5
```

> **First-run note:** The STT backend downloads the whisper model on first launch.
> The `medium` model is ~1.5 GB — download may take 1-3 minutes depending on bandwidth.
> Subsequent starts are instant (model is cached locally).

### Step 6: Verify

```bash
# Health check — should return {"ok":true,"port":8888,...}
curl -s http://127.0.0.1:8888/healthz

# Channel targets — should return {"ok":true,"targets":[...]}
curl -s 'http://127.0.0.1:8888/bridge/targets?limit=5'
# If token error: check OPENCLAW_GATEWAY_TOKEN in .env

# Model catalog — should show available model count
curl -s http://127.0.0.1:8888/bridge/models | python -c "import json,sys; d=json.load(sys.stdin); print(f'Models: {len(d.get(\"models\",[]))} available')"
```

```powershell
# Windows PowerShell
Invoke-RestMethod http://127.0.0.1:8888/healthz
Invoke-RestMethod 'http://127.0.0.1:8888/bridge/targets?limit=5'
```

If all checks pass, open http://127.0.0.1:8888 in a browser.

### Step 7: Local TTS Server (Optional)

High-quality TTS without API keys using edge-tts:

```bash
pip install edge-tts fastapi uvicorn
python tts-local/server.py &
sleep 2
curl -s http://127.0.0.1:5050/health
# Expected: {"ok":true,"backend":"edge"}
```

Then configure in the UI: **Options > TTS/STT > Custom** > URL: `http://localhost:5050/v1/audio/speech`

### Step 8: Remote Access for Mobile (Optional)

Microphone requires HTTPS. Use Tailscale for automatic HTTPS certificates:

```bash
tailscale serve --bg 8888
curl -sk https://your-machine.tail12345.ts.net/healthz
```

Access from mobile: `https://your-machine.tail12345.ts.net/`

> Do NOT use `http://your-machine:8888` — plain HTTP blocks microphone access.

### Server Endpoints Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Server health |
| `/bridge/healthz` | GET | Bridge health |
| `/bridge/targets` | GET | List channel sessions |
| `/bridge/attach` | POST | Attach to session (returns bridgeId) |
| `/bridge/stream` | GET | SSE event stream |
| `/bridge/inject` | POST | Send message to session (async 202) |
| `/bridge/models` | GET | List available models |
| `/bridge/tts` | POST | TTS proxy (OpenAI/Qwen/Custom) |
| `/api/*` | * | Proxy to STT/TTS backend |
| `/ws/chat` | WS | Voice chat WebSocket |

### Key Files

```
client/src/App.tsx           # React UI (voice, chat, bridge, TTS/STT settings)
client/src/lib/audio.ts      # PCM audio encoding (downsample, base64)
client/src/types.ts           # TypeScript interfaces
server/src/index.ts           # Express server (bridge, TTS proxy, static)
server/src/openclaw.ts        # OpenClaw gateway client
server/src/bridge-inject.ts   # Session resolution + message delivery
stt-backend/                  # Python STT backend (faster-whisper)
stt-backend/app/stt.py        # Whisper transcriber + streaming VAD
stt-backend/app/main.py       # FastAPI + WebSocket entry point
stt-backend/requirements.txt  # Python dependencies
tts-local/server.py           # Local TTS server (edge-tts / CosyVoice)
.env.example                  # Environment template
```

### WebSocket Protocol (/ws/chat)

```jsonc
// Client -> Server
{"type": "audio", "pcm16": "<base64 PCM16 mono 16kHz>"}
{"type": "text", "text": "hello"}
{"type": "flush"}   // end of speech segment
{"type": "reset"}   // clear conversation

// Server -> Client
{"type": "ready", "llm": "model-name", "tts_enabled": true}
{"type": "stt_partial", "text": "hel..."}
{"type": "stt_final", "text": "hello"}
{"type": "user_text", "text": "hello"}
{"type": "assistant_delta", "text": "Hi"}
{"type": "assistant_final", "text": "Hi there!"}
{"type": "tts_audio", "audio": "<base64 WAV>"}
{"type": "info", "message": "..."}
{"type": "error", "message": "..."}
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot POST /bridge/tts` | Server running old build | `npm run build` then restart server |
| `OPENCLAW_GATEWAY_TOKEN is required` | Missing .env or token | Check `.env` file exists with valid token |
| `(no channel selected)` | Gateway not running or token wrong | Run `openclaw gateway run`, verify token |
| Models empty in Options | `OPENCLAW_CLI` not set in `.env` | Set `OPENCLAW_CLI=openclaw` (or full path to `openclaw.mjs`) |
| Mic not working on mobile | Accessing via HTTP, not HTTPS | Use `tailscale serve --bg 8888` and access via the HTTPS URL (no `:8888` suffix) |
| Mic not working on localhost | Browser permission denied | Allow microphone in browser settings |
| TTS preview silent | Audio not unlocked | Click "Enable Audio" first |

## License

Apache-2.0
