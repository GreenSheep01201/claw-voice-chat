"""
Local TTS server — OpenAI-compatible /v1/audio/speech endpoint.

Backends:
  edge-tts  (default)  — Microsoft Edge online TTS, no API key, high quality
  cosyvoice           — Alibaba CosyVoice, fully local (requires extra setup)

Usage:
  pip install -r requirements.txt
  python server.py                          # edge-tts on :5050
  python server.py --port 5050 --backend edge
  python server.py --backend cosyvoice --model-dir pretrained_models/CosyVoice2-0.5B

Then set Custom TTS in voice-chat UI:
  URL:  http://localhost:5050/v1/audio/speech
  API Key: (leave empty)
"""

from __future__ import annotations

import argparse
import asyncio
import io
import struct
import sys
from typing import Optional

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

app = FastAPI()

# ---------------------------------------------------------------------------
# Backend: edge-tts
# ---------------------------------------------------------------------------

# voice mapping: short name -> edge-tts voice id
EDGE_VOICE_MAP: dict[str, str] = {
    # Korean
    "sunhi": "ko-KR-SunHiNeural",
    "inwoo": "ko-KR-InJoonNeural",
    "hyunsu": "ko-KR-HyunsuNeural",
    # English
    "alloy": "en-US-AriaNeural",
    "nova": "en-US-JennyNeural",
    "echo": "en-US-GuyNeural",
    "onyx": "en-US-DavisNeural",
    "shimmer": "en-US-AmberNeural",
    # Japanese
    "nanami": "ja-JP-NanamiNeural",
    "keita": "ja-JP-KeitaNeural",
    # Chinese
    "xiaoxiao": "zh-CN-XiaoxiaoNeural",
    "yunxi": "zh-CN-YunxiNeural",
    "xiaoyi": "zh-CN-XiaoyiNeural",
}

# Default per-language fallbacks
EDGE_LANG_DEFAULT: dict[str, str] = {
    "ko": "ko-KR-SunHiNeural",
    "en": "en-US-AriaNeural",
    "ja": "ja-JP-NanamiNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
}


def _detect_lang(text: str) -> str:
    """Simple heuristic language detection from text."""
    for ch in text:
        cp = ord(ch)
        if 0xAC00 <= cp <= 0xD7AF:
            return "ko"
        if 0x3040 <= cp <= 0x30FF:
            return "ja"
        if 0x4E00 <= cp <= 0x9FFF:
            return "zh"
    return "en"


async def tts_edge(text: str, voice: str | None) -> bytes:
    """Generate audio via edge-tts, return mp3 bytes."""
    import edge_tts  # type: ignore

    # Resolve voice
    voice_id = EDGE_VOICE_MAP.get(voice or "", "")
    if not voice_id:
        lang = _detect_lang(text)
        voice_id = EDGE_LANG_DEFAULT.get(lang, "en-US-AriaNeural")

    communicate = edge_tts.Communicate(text, voice_id)
    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Backend: CosyVoice (optional)
# ---------------------------------------------------------------------------

_cosyvoice_model = None


def _load_cosyvoice(model_dir: str):
    global _cosyvoice_model
    if _cosyvoice_model is not None:
        return _cosyvoice_model

    try:
        sys.path.insert(0, ".")
        from cosyvoice.cli.cosyvoice import CosyVoice  # type: ignore
        _cosyvoice_model = CosyVoice(model_dir)
        print(f"[tts-local] CosyVoice loaded from {model_dir}")
        return _cosyvoice_model
    except Exception as e:
        print(f"[tts-local] Failed to load CosyVoice: {e}")
        raise


def _pcm_to_wav(pcm_samples: list[float], sample_rate: int = 22050) -> bytes:
    """Convert float32 PCM samples to WAV bytes."""
    buf = io.BytesIO()
    n = len(pcm_samples)
    data_size = n * 2  # 16-bit
    # WAV header
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))  # chunk size
    buf.write(struct.pack("<H", 1))  # PCM
    buf.write(struct.pack("<H", 1))  # mono
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 2))  # byte rate
    buf.write(struct.pack("<H", 2))  # block align
    buf.write(struct.pack("<H", 16))  # bits per sample
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    for s in pcm_samples:
        clamped = max(-1.0, min(1.0, s))
        buf.write(struct.pack("<h", int(clamped * 32767)))
    return buf.getvalue()


async def tts_cosyvoice(text: str, voice: str | None, model_dir: str) -> bytes:
    """Generate audio via CosyVoice, return WAV bytes."""
    model = _load_cosyvoice(model_dir)
    spk = voice or "中文女"
    # Run in thread to avoid blocking the event loop
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: list(model.inference_sft(text, spk)))
    if not result:
        raise RuntimeError("CosyVoice returned no audio")
    # result is list of dicts with 'tts_speech' tensor
    audio = result[0]["tts_speech"].numpy().flatten().tolist()
    return _pcm_to_wav(audio, sample_rate=22050)


# ---------------------------------------------------------------------------
# OpenAI-compatible endpoint
# ---------------------------------------------------------------------------

_backend = "edge"
_cosyvoice_model_dir = ""


@app.post("/v1/audio/speech")
async def audio_speech(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    text = body.get("input", "") or body.get("text", "")
    if not text:
        return JSONResponse({"error": "input/text required"}, status_code=400)

    voice = body.get("voice", "")

    try:
        if _backend == "cosyvoice":
            audio_bytes = await tts_cosyvoice(text, voice, _cosyvoice_model_dir)
            media_type = "audio/wav"
        else:
            audio_bytes = await tts_edge(text, voice)
            media_type = "audio/mpeg"

        return Response(content=audio_bytes, media_type=media_type)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/v1/voices")
async def list_voices():
    """List available voice names."""
    if _backend == "cosyvoice":
        model = _cosyvoice_model
        voices = list(model.list_available_spks()) if model else []
    else:
        voices = list(EDGE_VOICE_MAP.keys())
    return {"voices": voices}


@app.get("/health")
async def health():
    return {"ok": True, "backend": _backend}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    global _backend, _cosyvoice_model_dir

    parser = argparse.ArgumentParser(description="Local TTS server (OpenAI-compatible)")
    parser.add_argument("--port", type=int, default=5050)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--backend", choices=["edge", "cosyvoice"], default="edge")
    parser.add_argument("--model-dir", default="pretrained_models/CosyVoice2-0.5B",
                        help="CosyVoice model directory (only for cosyvoice backend)")
    args = parser.parse_args()

    _backend = args.backend
    _cosyvoice_model_dir = args.model_dir

    if _backend == "cosyvoice":
        _load_cosyvoice(args.model_dir)

    print(f"[tts-local] Starting on http://{args.host}:{args.port} (backend={_backend})")
    print(f"[tts-local] Endpoint: http://{args.host}:{args.port}/v1/audio/speech")
    print(f"[tts-local] Set in voice-chat UI -> Custom TTS -> URL: http://localhost:{args.port}/v1/audio/speech")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
