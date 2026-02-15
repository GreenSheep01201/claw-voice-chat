# launchd templates (macOS)

These are **templates** for running:

1) STT/TTS FastAPI backend (HTTP+WS)
2) Express server (serves React build + proxies /api + /ws + bridge endpoints)

They are designed as **LaunchAgents** (run as your logged-in user).

## 0) Log directory

Logs go to `/tmp/claw-voice-chat-*.log` by default. Adjust paths in the plists if needed.

## 1) Backend (FastAPI) — port 8766

Template: `com.claw-voice-chat.backend.plist`

- Edit `WorkingDirectory` to point to your voice-chat-bridge backend directory
- Runs `./scripts/run_local.sh` (uvicorn)

### Install

```bash
cp com.claw-voice-chat.backend.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claw-voice-chat.backend.plist
```

### Verify

```bash
curl -s http://127.0.0.1:8766/api/runtime | python3 -m json.tool
```

## 2) Web front-door (Express) — port 8888

Template: `com.claw-voice-chat.web.plist`

- Edit `WorkingDirectory` to point to the `server/` directory of this project
- Edit `OPENCLAW_GATEWAY_TOKEN` with your gateway token
- Edit `OPENCLAW_CLI` to point to your `openclaw` binary or `openclaw.mjs`

### Build once

```bash
npm run build
```

### Install

```bash
cp com.claw-voice-chat.web.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claw-voice-chat.web.plist
```

### Verify

```bash
curl -s http://127.0.0.1:8888/healthz | python3 -m json.tool
open http://127.0.0.1:8888
```

## 3) Uninstall

```bash
launchctl bootout gui/$(id -u)/com.claw-voice-chat.backend 2>/dev/null || true
launchctl bootout gui/$(id -u)/com.claw-voice-chat.web 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.claw-voice-chat.backend.plist
rm -f ~/Library/LaunchAgents/com.claw-voice-chat.web.plist
```
