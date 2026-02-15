<p align="center">
  <img src="client/public/claw-icon.svg" width="80" alt="Claw Voice Chat" />
</p>

<h1 align="center">Claw-Voice-Chat</h1>

<p align="center">
  <strong>OpenClaw 채널을 위한 푸시투톡 음성 채팅</strong><br>
  Telegram, Discord, Slack 등 <a href="https://github.com/openclaw/openclaw">OpenClaw</a> 채널에 음성 또는 텍스트로 대화하고,<br>
  AI 에이전트의 응답을 실시간 스트리밍으로 받아 TTS로 들을 수 있습니다.
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
  <a href="#ai-로-설치하기">AI로 설치하기</a> &middot;
  <a href="#주요-기능">기능</a> &middot;
  <a href="#빠른-시작">빠른 시작</a> &middot;
  <a href="#tts-프로바이더">TTS</a> &middot;
  <a href="#stt-백엔드-푸시투톡">STT</a> &middot;
  <a href="#환경-변수">설정</a> &middot;
  <a href="#ai-설치-가이드">AI 가이드</a> &middot;
  <a href="README.md">English</a>
</p>

---

## AI로 설치하기

> **AI 코딩 에이전트 (Claude Code, Codex, Cursor, Gemini CLI 등)에 아래 내용을 붙여넣기 하세요:**
>
> ```
> Install claw-voice-chat following the guide at:
> https://github.com/GreenSheep01201/claw-voice-chat
> ```
>
> AI가 이 README를 읽고 모든 설치를 자동으로 처리합니다.

---

## 목차

- [주요 기능](#주요-기능)
- [아키텍처](#아키텍처)
- [요구사항](#요구사항)
- [빠른 시작](#빠른-시작)
- [TTS 프로바이더](#tts-프로바이더)
  - [로컬 TTS 서버 (edge-tts)](#로컬-tts-서버-edge-tts)
  - [STT 백엔드 (푸시투톡)](#stt-백엔드-푸시투톡)
- [사용법](#사용법)
- [외부 접근 (모바일)](#외부-접근-모바일--다른-기기)
- [환경 변수](#환경-변수)
- [AI 설치 가이드](#ai-설치-가이드)
  - [서버 엔드포인트 참조](#서버-엔드포인트-참조)
  - [주요 파일](#주요-파일)
  - [WebSocket 프로토콜](#websocket-프로토콜-wschat)
  - [문제 해결](#문제-해결)
- [라이선스](#라이선스)

---

## 주요 기능

- **푸시투톡** 음성 입력 + 실시간 STT (faster-whisper)
- **채널 브릿지** — 활성 OpenClaw 세션(Telegram, Discord 등)을 선택하여 대화
- **스트리밍 트랜스크립트** — 에이전트 응답이 토큰 단위로 실시간 표시
- **TTS 프로바이더 선택** — 브라우저(Web Speech API), OpenAI, Qwen/DashScope, 커스텀 엔드포인트
- **STT 언어 선택** — faster-whisper용 언어 힌트 (한국어, 영어, 일본어, 중국어 등)
- **로컬 TTS 서버** — API 키 없이 고품질 TTS를 제공하는 edge-tts 래퍼 포함
- **음성 미리듣기** — 저장 전 TTS 음성 테스트
- **모델 카탈로그** — OAuth 연결된 프로바이더(GitHub Copilot, Google Antigravity 등)의 모델 목록
- **텍스트 입력** — `Ctrl+Enter` / `Cmd+Enter`로 텍스트 전송
- **독립 LLM 모드** — 채널 연결 없이 로컬 LLM 백엔드로 동작

## 아키텍처

```
브라우저 (React + Tailwind)
   |
   | 포트 8888 (HTTP + WebSocket)
   v
Express 서버 (Node.js)
   |
   |--- /bridge/*      --> OpenClaw 게이트웨이 (포트 18789)
   |--- /bridge/tts    --> TTS 프록시 (OpenAI / Qwen / Custom / Local)
   |--- /api/* /ws/*   --> STT/TTS 백엔드 (포트 8766) [선택]
   |
   v
OpenClaw 게이트웨이 --> Telegram, Discord, Slack, Signal, ...
```

### 동작 모드

| 모드 | 필요 조건 | 설명 |
|------|----------|------|
| **채널 브릿지** | Node.js + OpenClaw 게이트웨이 | 채널에 텍스트/음성 전송. 브라우저 또는 외부 TTS로 응답 출력. |
| **독립 LLM** | Node.js + Python STT/TTS 백엔드 | 풀 음성 파이프라인: 푸시투톡, 로컬 STT, LLM, 오디오 TTS. |

두 모드를 동시에 사용할 수 있습니다. Python 백엔드는 푸시투톡 STT에만 필요합니다.

## 요구사항

- **Node.js 22+** ([다운로드](https://nodejs.org/))
- **OpenClaw 게이트웨이** 로컬 실행 중 (채널 브릿지용)
- **Python 3.10+** (로컬 TTS 서버 또는 STT 백엔드용 — 선택)

## 빠른 시작

### 1. 클론 및 설치

```bash
git clone https://github.com/GreenSheep01201/claw-voice-chat.git
cd claw-voice-chat
npm install && cd client && npm install && cd ../server && npm install && cd ..
npm run stt:install   # Python STT 백엔드 의존성 설치
```

### 2. OpenClaw 게이트웨이 설정

```bash
npm install -g openclaw
openclaw setup          # 채널 연결, 설정 파일 생성
openclaw gateway run    # 포트 18789에서 시작
```

### 3. 환경 변수 설정

```bash
cp .env.example .env
```

`.env` 편집:

```env
PORT=8888
NODE_ENV=production
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=여기에-게이트웨이-토큰

# 모델 카탈로그 — openclaw CLI 바이너리 또는 openclaw.mjs 경로.
# OAuth 프로바이더 모델(GitHub Copilot, Google Antigravity 등)을
# Options 모델 선택기에 표시하려면 필수입니다.
OPENCLAW_CLI=openclaw
```

토큰 확인:
- **macOS/Linux:** `cat ~/.openclaw/openclaw.json | grep token`
- **Windows:** `type %USERPROFILE%\.openclaw\openclaw.json | findstr token`

프로그래밍 방식으로 추출:
```bash
python -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['gateway']['auth']['token'])"
```

### 4. 빌드 및 실행

```bash
npm run build
npm start       # Express (8888) + STT 백엔드 (8766) 동시 실행
```

http://127.0.0.1:8888 접속

> Express 서버만 실행하려면: `npm run start:server`

### 5. 개발 모드

```bash
npm run dev    # Vite (5173) + Express (8888) + STT (8766) 동시 실행
```

## TTS 프로바이더

**Options > TTS / STT** 탭에서 설정합니다.

| 프로바이더 | 설정 | 품질 | 지연 |
|-----------|------|------|------|
| **브라우저** | 내장, 설정 불필요 | OS에 따라 다름 | 즉시 |
| **OpenAI** | API 키 필요 | 우수 | ~1초 |
| **Qwen/DashScope** | API 키 필요 | 양호 | ~1초 |
| **커스텀** | OpenAI 호환 엔드포인트 | 다양 | 다양 |
| **로컬 (edge-tts)** | `pip install edge-tts` | 우수 | ~2초 |

### 로컬 TTS 서버 (edge-tts)

API 키 없이 고품질 TTS. **macOS, Linux, Windows** 모두 지원.

**설치:**

```bash
pip install edge-tts fastapi uvicorn
python tts-local/server.py
```

**UI 연결:**
1. Options > TTS / STT 탭
2. **Custom** 선택
3. URL: `http://localhost:5050/v1/audio/speech`
4. API Key는 비워둠
5. 음성: `sunhi` (한국어), `echo` (영어), `nanami` (일본어)
6. **Preview Voice** 클릭하여 테스트

**지원 음성:**

| 언어 | 음성 |
|------|------|
| 한국어 | `sunhi`, `inwoo`, `hyunsu` |
| 영어 | `alloy`, `nova`, `echo`, `onyx`, `shimmer` |
| 일본어 | `nanami`, `keita` |
| 중국어 | `xiaoxiao`, `yunxi`, `xiaoyi` |

**백그라운드 실행:**

```bash
# macOS/Linux
nohup python tts-local/server.py > /tmp/tts-local.log 2>&1 &

# Windows (PowerShell)
Start-Process -NoNewWindow python -ArgumentList "tts-local/server.py"
```

**확인:**

```bash
curl http://127.0.0.1:5050/health
# {"ok":true,"backend":"edge"}
```

### STT 백엔드 (푸시투톡)

포함된 `stt-backend/`는 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)를 사용한 실시간 음성 인식을 제공합니다. `npm start`로 Express 서버와 함께 자동으로 시작됩니다.

**수동 시작** (별도 실행 시):

```bash
npm run stt:install   # pip install -r stt-backend/requirements.txt
npm run stt:start     # 포트 8766에서 시작
```

**설정:**

STT 모델 크기와 언어는 UI의 **Options > TTS / STT** 탭에서 설정할 수 있습니다. 변경사항은 다음 WebSocket 연결 시 적용됩니다 (재연결 필요).

| 설정 | 옵션 | 기본값 | 설명 |
|------|------|--------|------|
| **모델 크기** | Tiny, Base, Small, Medium, Large v3 | Medium | 정확도 vs 속도 트레이드오프 |
| **언어** | 자동감지, 한국어, 영어, 일본어 + 12개 | 자동 (브라우저 로케일) | 음성 인식 언어 힌트 |

환경 변수(`.env`)는 서버 측 기본값을 설정합니다:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `STT_MODEL_SIZE` | `medium` | 클라이언트 미지정 시 기본 모델 |
| `STT_DEVICE` | `auto` | 디바이스: `auto`, `cpu`, `cuda` |
| `STT_COMPUTE_TYPE` | `int8` | 연산 타입: `int8`, `float16`, `float32` |

모델은 메모리에 캐시됩니다 — UI에서 크기를 변경하면 새 모델을 한 번 로드한 후 이후 연결에 재사용합니다.

## 사용법

1. **Connect** 클릭하여 WebSocket 연결
2. **Enable Audio** 클릭하여 브라우저 오디오 활성화
3. 드롭다운에서 채널 선택 (예: Telegram 봇 세션)
4. **Hold to Speak** — 버튼을 누르고, 말하고, 놓으면 전송
5. 또는 텍스트 박스에 입력 후 `Ctrl+Enter` / `Cmd+Enter`
6. **TTS On/Off** 토글로 음성 출력 제어

## 외부 접근 (모바일 / 다른 기기)

마이크는 **보안 컨텍스트**(HTTPS 또는 localhost)에서만 동작합니다. 휴대폰, 태블릿 등에서 일반 HTTP로 접근하면 브라우저가 마이크 입력을 차단합니다.

**권장: Tailscale HTTPS**

[Tailscale](https://tailscale.com/)은 tailnet 기기에 자동 HTTPS 인증서를 제공합니다.

```bash
# voice-chat 서버(포트 8888)를 Tailscale HTTPS로 노출
tailscale serve --bg 8888
```

모바일에서 접근: `https://your-machine.tail12345.ts.net/`

> **중요:** Tailscale URL 뒤에 `:8888`을 붙이지 마세요. Tailscale은 포트 443에서 HTTPS를 제공하고 내부적으로 8888로 프록시합니다. `http://your-machine:8888`로 직접 접근하면 HTTP이므로 마이크가 동작하지 않습니다.

**HTTPS 동작 확인:**

```bash
curl -sk https://your-machine.tail12345.ts.net/healthz
# 예상 결과: {"ok":true,"port":8888,...}
```

**Tailscale serve 중지:**

```bash
tailscale serve --https=443 off
```

## 환경 변수

| 변수 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `PORT` | 아니오 | `8888` | Express 서버 포트 |
| `NODE_ENV` | 아니오 | `development` | `production` 설정 시 빌드된 클라이언트 서빙 |
| `VCB_BACKEND_HTTP` | 아니오 | `http://127.0.0.1:8766` | STT/TTS 백엔드 URL |
| `OPENCLAW_GATEWAY_URL` | 브릿지용 | `http://127.0.0.1:18789` | OpenClaw 게이트웨이 URL |
| `OPENCLAW_GATEWAY_TOKEN` | 브릿지용 | — | 게이트웨이 인증 토큰 |
| `OPENCLAW_CLI` | 모델용 | — | `openclaw` 바이너리 또는 `openclaw.mjs` 경로. OAuth 모델(GitHub Copilot 등) 표시에 필수 |
| `STT_MODEL_SIZE` | 아니오 | `medium` | faster-whisper 모델 크기 (`tiny`/`base`/`small`/`medium`/`large-v3`) |
| `STT_DEVICE` | 아니오 | `auto` | STT 디바이스 (`auto`/`cpu`/`cuda`) |
| `STT_COMPUTE_TYPE` | 아니오 | `int8` | STT 연산 타입 (`int8`/`float16`/`float32`) |

모든 변수는 프로젝트 루트의 `.env` 파일에서 dotenv로 자동 로드됩니다.

## macOS LaunchAgent

[`launchd/README.md`](launchd/README.md)에서 백그라운드 서비스 템플릿을 확인하세요.

---

## AI 설치 가이드

> **AI 코딩 어시스턴트** (Claude, Cursor, Copilot 등)가 사용자 머신에 이 프로젝트를 설치할 때 참고하세요.
> 각 단계를 순서대로 실행하세요. 모든 커맨드는 복사-붙여넣기로 실행 가능합니다.
> 이 가이드는 **원샷 실행**을 위해 설계되었습니다 — 수동 편집이 필요 없습니다.

### 플랫폼 감지

먼저 플랫폼을 감지합니다. 이후 모든 단계에서 `$IS_WIN`을 사용해 분기합니다.

**macOS / Linux (bash/zsh):**
```bash
IS_WIN=false
```

**Windows (PowerShell):**
```powershell
$IS_WIN = $true
```

### Step 1: 사전 요구사항 확인

```bash
# macOS / Linux
node --version    # 22+ 필수. 없으면: https://nodejs.org/
python --version  # 3.10+ 필수. 없으면: https://www.python.org/downloads/
```

```powershell
# Windows PowerShell
node --version    # 22+ 필수. 없으면: https://nodejs.org/
python --version  # 3.10+ 필수. 없으면: https://www.python.org/downloads/
```

> `node` 또는 `python`이 없으면 먼저 설치하세요.
> Windows에서는 Microsoft Store가 아닌 python.org에서 Python을 설치해야 PATH 문제가 없습니다.

### Step 2: OpenClaw 게이트웨이 설치

채널 브릿지에는 실행 중인 OpenClaw 게이트웨이가 필요합니다. 이미 설치되어 실행 중이면 이 단계를 건너뛰세요.

```bash
# macOS / Linux
npm install -g openclaw
openclaw setup          # 대화형 — 채널 연결, 프로바이더 설정
openclaw gateway run &  # 포트 18789에서 백그라운드 실행
sleep 3                 # 게이트웨이 초기화 대기
```

```powershell
# Windows PowerShell
npm install -g openclaw
openclaw setup
Start-Process -NoNewWindow -FilePath "openclaw" -ArgumentList "gateway","run"
Start-Sleep -Seconds 3
```

> 이미 `openclaw`이 설치되어 있다면 게이트웨이 실행만 확인하세요:
> `curl -s http://127.0.0.1:18789/healthz`가 `{"ok":true,...}`를 반환해야 합니다.

### Step 3: 클론 및 설치

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

### Step 4: .env 설정 (자동)

```bash
# macOS / Linux — 완전 자동, 수동 편집 불필요
cp .env.example .env

# 게이트웨이 토큰 자동 감지
TOKEN=$(python -c "import json,os; print(json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))['gateway']['auth']['token'])" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  sed -i.bak "s/^OPENCLAW_GATEWAY_TOKEN=.*/OPENCLAW_GATEWAY_TOKEN=$TOKEN/" .env && rm -f .env.bak
  echo "OK: 토큰 설정 완료 (${TOKEN:0:8}...)"
else
  echo "WARNING: 게이트웨이 토큰을 찾을 수 없습니다. .env에서 OPENCLAW_GATEWAY_TOKEN을 수동으로 설정하세요."
  echo "  힌트: cat ~/.openclaw/openclaw.json | grep token"
fi

# openclaw CLI 경로 자동 감지
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
  echo "NOTE: openclaw CLI를 PATH에서 찾을 수 없습니다. 모델 카탈로그가 비어있을 수 있습니다."
fi
```

```powershell
# Windows PowerShell — 완전 자동
Copy-Item .env.example .env

# 게이트웨이 토큰 자동 감지
try {
  $config = Get-Content "$env:USERPROFILE\.openclaw\openclaw.json" | ConvertFrom-Json
  $token = $config.gateway.auth.token
  if ($token) {
    (Get-Content .env) -replace '^OPENCLAW_GATEWAY_TOKEN=.*', "OPENCLAW_GATEWAY_TOKEN=$token" | Set-Content .env
    Write-Host "OK: 토큰 설정 완료 ($($token.Substring(0,8))...)"
  }
} catch {
  Write-Host "WARNING: 게이트웨이 토큰을 찾을 수 없습니다. .env에서 OPENCLAW_GATEWAY_TOKEN을 수동으로 설정하세요."
}

# openclaw CLI 경로 자동 감지
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
  Write-Host "NOTE: openclaw CLI를 찾을 수 없습니다. 모델 카탈로그가 비어있을 수 있습니다."
}
```

### Step 5: 빌드 및 시작

```bash
# macOS / Linux
npm run build
npm start &    # Express (8888) + STT 백엔드 (8766) 동시 실행
sleep 5        # 서버 초기화 대기 (첫 실행 시 STT 모델 다운로드)
```

```powershell
# Windows PowerShell
npm run build
Start-Process -NoNewWindow npm -ArgumentList "start"
Start-Sleep -Seconds 5
```

> **첫 실행 참고:** STT 백엔드는 첫 실행 시 whisper 모델을 다운로드합니다.
> `medium` 모델은 약 1.5 GB — 네트워크 속도에 따라 1-3분 소요됩니다.
> 이후 실행은 즉시 시작됩니다 (모델이 로컬에 캐시됨).

### Step 6: 검증

```bash
# 상태 확인 — {"ok":true,"port":8888,...} 반환되어야 함
curl -s http://127.0.0.1:8888/healthz

# 채널 타겟 — {"ok":true,"targets":[...]} 반환되어야 함
curl -s 'http://127.0.0.1:8888/bridge/targets?limit=5'
# 토큰 에러 시: .env의 OPENCLAW_GATEWAY_TOKEN 확인

# 모델 카탈로그 — 사용 가능한 모델 수 표시
curl -s http://127.0.0.1:8888/bridge/models | python -c "import json,sys; d=json.load(sys.stdin); print(f'Models: {len(d.get(\"models\",[]))} available')"
```

```powershell
# Windows PowerShell
Invoke-RestMethod http://127.0.0.1:8888/healthz
Invoke-RestMethod 'http://127.0.0.1:8888/bridge/targets?limit=5'
```

모든 확인이 통과하면 브라우저에서 http://127.0.0.1:8888 을 여세요.

### Step 7: 로컬 TTS 서버 (선택)

API 키 없이 고품질 TTS — edge-tts 사용:

```bash
pip install edge-tts fastapi uvicorn
python tts-local/server.py &
sleep 2
curl -s http://127.0.0.1:5050/health
# 예상: {"ok":true,"backend":"edge"}
```

UI에서 설정: **Options > TTS/STT > Custom** > URL: `http://localhost:5050/v1/audio/speech`

### Step 8: 모바일 원격 접근 (선택)

마이크는 HTTPS가 필요합니다. Tailscale로 자동 HTTPS 인증서를 사용하세요:

```bash
tailscale serve --bg 8888
curl -sk https://your-machine.tail12345.ts.net/healthz
```

모바일에서 접근: `https://your-machine.tail12345.ts.net/`

> `http://your-machine:8888`로 접근하지 마세요 — 일반 HTTP는 마이크 접근을 차단합니다.

### 서버 엔드포인트 참조

| 엔드포인트 | 메서드 | 설명 |
|----------|--------|------|
| `/healthz` | GET | 서버 상태 |
| `/bridge/healthz` | GET | 브릿지 상태 |
| `/bridge/targets` | GET | 채널 세션 목록 |
| `/bridge/attach` | POST | 세션 연결 (bridgeId 반환) |
| `/bridge/stream` | GET | SSE 이벤트 스트림 |
| `/bridge/inject` | POST | 세션에 메시지 전송 (비동기 202) |
| `/bridge/models` | GET | 사용 가능한 모델 목록 |
| `/bridge/tts` | POST | TTS 프록시 (OpenAI/Qwen/Custom) |
| `/api/*` | * | STT/TTS 백엔드 프록시 |
| `/ws/chat` | WS | 음성 채팅 WebSocket |

### 주요 파일

```
client/src/App.tsx           # React UI (음성, 채팅, 브릿지, TTS/STT 설정)
client/src/lib/audio.ts      # PCM 오디오 인코딩 (다운샘플, base64)
client/src/types.ts           # TypeScript 인터페이스
server/src/index.ts           # Express 서버 (브릿지, TTS 프록시, 정적 파일)
server/src/openclaw.ts        # OpenClaw 게이트웨이 클라이언트
server/src/bridge-inject.ts   # 세션 해석 + 메시지 전달
stt-backend/                  # Python STT 백엔드 (faster-whisper)
stt-backend/app/stt.py        # Whisper 트랜스크라이버 + 스트리밍 VAD
stt-backend/app/main.py       # FastAPI + WebSocket 엔트리포인트
stt-backend/requirements.txt  # Python 의존성
tts-local/server.py           # 로컬 TTS 서버 (edge-tts / CosyVoice)
.env.example                  # 환경 변수 템플릿
```

### WebSocket 프로토콜 (/ws/chat)

```jsonc
// 클라이언트 -> 서버
{"type": "audio", "pcm16": "<base64 PCM16 mono 16kHz>"}
{"type": "text", "text": "안녕하세요"}
{"type": "flush"}   // 음성 세그먼트 종료
{"type": "reset"}   // 대화 초기화

// 서버 -> 클라이언트
{"type": "ready", "llm": "model-name", "tts_enabled": true}
{"type": "stt_partial", "text": "안녕..."}
{"type": "stt_final", "text": "안녕하세요"}
{"type": "user_text", "text": "안녕하세요"}
{"type": "assistant_delta", "text": "안녕"}
{"type": "assistant_final", "text": "안녕하세요!"}
{"type": "tts_audio", "audio": "<base64 WAV>"}
{"type": "info", "message": "..."}
{"type": "error", "message": "..."}
```

### 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| `Cannot POST /bridge/tts` | 서버가 이전 빌드로 실행 중 | `npm run build` 후 서버 재시작 |
| `OPENCLAW_GATEWAY_TOKEN is required` | .env 파일 또는 토큰 누락 | `.env` 파일이 존재하고 유효한 토큰이 있는지 확인 |
| `(no channel selected)` | 게이트웨이 미실행 또는 토큰 오류 | `openclaw gateway run` 실행, 토큰 확인 |
| Options에서 모델이 비어있음 | `.env`에 `OPENCLAW_CLI` 미설정 | `OPENCLAW_CLI=openclaw` (또는 `openclaw.mjs` 전체 경로) 설정 |
| 모바일에서 마이크 안됨 | HTTPS가 아닌 HTTP로 접근 | `tailscale serve --bg 8888` 사용, HTTPS URL로 접근 (`:8888` 붙이지 않기) |
| localhost에서 마이크 안됨 | 브라우저 권한 거부 | 브라우저 설정에서 마이크 허용 |
| TTS 미리듣기 무음 | 오디오 미활성화 | "Enable Audio" 먼저 클릭 |

## 라이선스

Apache-2.0
