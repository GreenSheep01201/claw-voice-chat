from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Awaitable, Callable

import numpy as np

from app.config import settings

SAMPLE_RATE = 16_000
FRAME_MS = 30
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = SAMPLES_PER_FRAME * 2


class VoiceActivityDetector:
    def __init__(self) -> None:
        self._impl = None
        try:
            import webrtcvad  # type: ignore

            self._impl = webrtcvad.Vad(2)
        except Exception:
            self._impl = None

    def is_speech(self, frame: bytes) -> bool:
        if len(frame) != FRAME_BYTES:
            return False

        # Always compute RMS as a sanity check; some mobile audio paths confuse webrtcvad.
        pcm = np.frombuffer(frame, dtype=np.int16).astype(np.float32)
        rms = float(np.sqrt(np.mean(np.square(pcm))))

        vad_says_speech = False
        if self._impl is not None:
            try:
                vad_says_speech = bool(self._impl.is_speech(frame, SAMPLE_RATE))
            except Exception:
                vad_says_speech = False

        # Combine: treat as speech if VAD OR RMS crosses a lower threshold.
        # Threshold lowered (was 200.0) so laptop mics with AGC/NS still trip the gate.
        return vad_says_speech or (rms > 80.0)


import threading

# Module-level model cache — shared across sessions, reloaded when size changes.
_model_cache: dict[str, object] = {}  # {size_key: WhisperModel}
_model_lock = threading.Lock()


def _get_whisper_model(size: str):
    """Return a cached WhisperModel, reloading if the requested size differs."""
    with _model_lock:
        if size in _model_cache:
            return _model_cache[size]

        try:
            from faster_whisper import WhisperModel  # type: ignore

            model = WhisperModel(
                size,
                device=settings.stt_device,
                compute_type=settings.stt_compute_type,
            )
            _model_cache[size] = model
            return model
        except Exception:
            return None


class WhisperTranscriber:
    def __init__(self, language: str | None = None, model_size: str | None = None) -> None:
        self._language = language
        self._size = model_size or settings.stt_model_size

    def transcribe_pcm16(self, pcm16: bytes) -> str:
        model = _get_whisper_model(self._size)
        if model is None or not pcm16:
            return ""

        audio = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0

        try:
            segments, _ = model.transcribe(
                audio,
                language=self._language,
                task="transcribe",
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = "".join(segment.text for segment in segments).strip()
            return text
        except Exception:
            return ""


class StreamingVadStt:
    def __init__(
        self,
        on_partial: Callable[[str], Awaitable[None]],
        on_final: Callable[[str], Awaitable[None]],
        language: str | None = None,
        model_size: str | None = None,
    ) -> None:
        self._vad = VoiceActivityDetector()
        self._transcriber = WhisperTranscriber(language=language, model_size=model_size)
        self._on_partial = on_partial
        self._on_final = on_final

        self._pre_roll: deque[bytes] = deque(maxlen=8)
        # Keep a rolling buffer of recent audio so Flush STT can work even if VAD never triggers.
        self._recent_frames: deque[bytes] = deque(maxlen=240)  # ~7.2s @ 30ms/frame
        self._speech_frames: list[bytes] = []

        self._speaking = False
        self._voiced_run = 0
        self._unvoiced_run = 0
        self._last_partial_ts = 0.0
        self._last_partial_text = ""
        self._partial_task: asyncio.Task[None] | None = None

    async def push_frame(self, frame: bytes) -> None:
        if len(frame) != FRAME_BYTES:
            return

        speech = self._vad.is_speech(frame)
        self._pre_roll.append(frame)
        self._recent_frames.append(frame)

        if not self._speaking:
            if speech:
                self._voiced_run += 1
            else:
                self._voiced_run = 0

            # Be more responsive for mobile mics: start speech after ~60ms voiced.
            if self._voiced_run >= 2:
                self._speaking = True
                self._speech_frames = list(self._pre_roll)
                self._unvoiced_run = 0
                self._last_partial_ts = time.monotonic()
                self._last_partial_text = ""
            return

        self._speech_frames.append(frame)

        if speech:
            self._unvoiced_run = 0
        else:
            self._unvoiced_run += 1

        now = time.monotonic()
        enough_audio = len(self._speech_frames) >= 20
        if enough_audio and now - self._last_partial_ts >= settings.stt_partial_interval_sec:
            self._last_partial_ts = now
            await self._schedule_partial()

        # End speech after ~240ms of silence (8 frames) for snappier turn-taking.
        if self._unvoiced_run >= 8:
            frames = self._speech_frames[:]
            self._reset_speech_state()
            if len(frames) >= 6:
                await self._emit_final(frames)

    async def flush(self) -> None:
        # Normal path: if we were in a speech segment, finalize it.
        if self._speaking and self._speech_frames:
            frames = self._speech_frames[:]
            self._reset_speech_state()
            await self._emit_final(frames)
        else:
            # Fallback: if VAD never triggered (common on some mobile audio paths),
            # still attempt a transcription over the most recent audio.
            recent = list(self._recent_frames)
            if len(recent) >= 10:  # ~300ms minimum
                text = await asyncio.to_thread(self._transcriber.transcribe_pcm16, b"".join(recent))
                text = text.strip()
                if text:
                    self._last_partial_text = ""
                    await self._on_final(text)
                else:
                    await self._on_partial("(flush: no transcription)")
            else:
                await self._on_partial(f"(flush: insufficient audio frames={len(recent)})")

        if self._partial_task and not self._partial_task.done():
            try:
                await asyncio.wait_for(self._partial_task, timeout=2.0)
            except Exception:
                self._partial_task.cancel()

    def _reset_speech_state(self) -> None:
        self._speaking = False
        self._voiced_run = 0
        self._unvoiced_run = 0
        self._speech_frames = []

    async def _schedule_partial(self) -> None:
        if self._partial_task and not self._partial_task.done():
            return

        frames_snapshot = b"".join(self._speech_frames)
        self._partial_task = asyncio.create_task(self._emit_partial(frames_snapshot))

    async def _emit_partial(self, frames: bytes) -> None:
        text = await asyncio.to_thread(self._transcriber.transcribe_pcm16, frames)
        if text and text != self._last_partial_text:
            self._last_partial_text = text
            await self._on_partial(text)

    async def _emit_final(self, frames: list[bytes]) -> None:
        text = await asyncio.to_thread(self._transcriber.transcribe_pcm16, b"".join(frames))
        text = text.strip()
        if text:
            self._last_partial_text = ""
            await self._on_final(text)
