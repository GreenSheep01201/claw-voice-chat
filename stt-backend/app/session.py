from __future__ import annotations

import asyncio
import base64
from typing import Any, Callable

from fastapi import WebSocket

from app.command_router import CommandRouter
from app.config import settings
from app.hooks import HookEmitter
from app.llm import OpenClawClient
from app.stt import StreamingVadStt
from app.tts import PiperTTS, SentenceChunker
from app.tts_say import MacSayTTS
from app.tts_windows import WindowsSapiTTS


class VoiceSession:
    def __init__(
        self,
        websocket: WebSocket,
        *,
        mcp_session_factory: Callable[[], object] | None = None,
        model: str | None = None,
        profile: str | None = None,
        engine: str | None = None,
        language: str | None = None,
        model_size: str | None = None,
    ) -> None:
        self._ws = websocket
        self._audio_frames_seen = 0
        self._hooks = HookEmitter()
        self._router = CommandRouter(self._hooks)
        if mcp_session_factory:
            self._llm = OpenClawClient(
                mcp_session_factory=mcp_session_factory,
                own_mcp_session=False,
                model=model,
                profile=profile,
                engine=engine,
            )
        else:
            self._llm = OpenClawClient(model=model, profile=profile, engine=engine)

        # Prefer Piper when truly available; fall back to the OS TTS engine.
        # Allow disabling TTS for latency testing.
        mode = (settings.tts_mode or "auto").strip().lower()
        if mode == "off":
            self._tts = None
        elif mode == "sapi":
            self._tts = WindowsSapiTTS()
        elif mode == "say":
            self._tts = MacSayTTS()
        elif mode == "piper":
            self._tts = PiperTTS()
        else:
            piper = PiperTTS()
            if piper.enabled:
                self._tts = piper
            else:
                import os

                self._tts = WindowsSapiTTS() if os.name == "nt" else MacSayTTS()

        self._history: list[dict[str, str]] = [
            {"role": "system", "content": settings.system_prompt},
        ]

        # Keep history small for latency.
        if settings.max_history_messages > 8:
            settings.max_history_messages = 8

        self._send_lock = asyncio.Lock()
        self._turn_queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._turn_worker: asyncio.Task[None] | None = None

        effective_language = language or (settings.stt_language.strip() or None)
        self._stt = StreamingVadStt(
            on_partial=self._on_stt_partial,
            on_final=self._on_stt_final,
            language=effective_language,
            model_size=model_size,
        )

    async def start(self) -> None:
        self._turn_worker = asyncio.create_task(self._turn_loop())
        await self._send(
            {
                "type": "ready",
                "stt": "faster-whisper+vad",
                "llm": self._llm.model_label,
                "tts_enabled": bool(self._tts),
            }
        )

    async def close(self) -> None:
        await self._stt.flush()
        await self._turn_queue.put(None)
        if self._turn_worker:
            try:
                await asyncio.wait_for(self._turn_worker, timeout=2.0)
            except Exception:
                self._turn_worker.cancel()
        await self._llm.close()

    async def handle_message(self, payload: dict[str, Any]) -> None:
        msg_type = str(payload.get("type") or "").strip().lower()
        if not msg_type:
            return

        if msg_type == "audio":
            encoded = payload.get("pcm16")
            if not isinstance(encoded, str):
                return
            try:
                frame = base64.b64decode(encoded)
            except Exception:
                return

            self._audio_frames_seen += 1
            # Lightweight visibility to debug mobile mic streaming.
            if self._audio_frames_seen in (1, 10, 50, 100) or self._audio_frames_seen % 250 == 0:
                await self._send({"type": "info", "message": f"audio frames received: {self._audio_frames_seen}"})

            await self._stt.push_frame(frame)
            return

        if msg_type == "flush":
            await self._send({"type": "info", "message": "flush requested"})
            await self._stt.flush()
            await self._send({"type": "flush_complete"})
            return

        if msg_type == "text":
            text = str(payload.get("text") or "").strip()
            if text:
                await self._turn_queue.put(text)
            return

        if msg_type == "reset":
            self._history = [{"role": "system", "content": settings.system_prompt}]
            await self._llm.reset()
            await self._send({"type": "info", "message": "Conversation reset"})
            return

        if msg_type == "ping":
            await self._send({"type": "pong"})
            return

    async def _on_stt_partial(self, text: str) -> None:
        await self._send({"type": "stt_partial", "text": text})

    async def _on_stt_final(self, text: str) -> None:
        await self._send({"type": "stt_final", "text": text})
        await self._turn_queue.put(text)

    async def _turn_loop(self) -> None:
        while True:
            text = await self._turn_queue.get()
            if text is None:
                return
            try:
                await self._process_turn(text)
            except Exception as exc:
                await self._send({"type": "error", "message": f"Turn failed: {exc}"})

    async def _process_turn(self, user_text: str) -> None:
        cleaned_user = user_text.strip()
        if not cleaned_user:
            return

        await self._send({"type": "user_text", "text": cleaned_user})

        command_result = await self._router.route(cleaned_user)
        if command_result.handled:
            await self._send(
                {
                    "type": "command_result",
                    "kind": command_result.kind,
                    "text": command_result.response,
                    "metadata": command_result.metadata,
                }
            )
            await self._speak_text(command_result.response)
            return

        self._history.append({"role": "user", "content": cleaned_user})

        assistant_text = ""
        chunker = SentenceChunker()
        tts_queue: asyncio.Queue[str | None] = asyncio.Queue()
        tts_worker = asyncio.create_task(self._tts_loop(tts_queue))

        loop = asyncio.get_running_loop()
        llm_start = loop.time()
        first_delta_at: float | None = None

        try:
            async for delta in self._llm.stream_chat(self._history):
                if first_delta_at is None:
                    first_delta_at = loop.time()
                assistant_text += delta
                await self._send({"type": "assistant_delta", "text": delta})
                for sentence in chunker.push(delta):
                    await tts_queue.put(sentence)

            for sentence in chunker.flush():
                await tts_queue.put(sentence)
        except Exception as exc:
            await self._send({"type": "error", "message": f"LLM stream failed: {exc}"})
            await tts_queue.put(None)
            await tts_worker
            return
        finally:
            llm_end = loop.time()
            ttfb_ms = int(((first_delta_at or llm_end) - llm_start) * 1000)
            total_ms = int((llm_end - llm_start) * 1000)
            transport = self._llm.last_transport
            startup_ms = self._llm.last_mcp_startup_ms
            if transport == "mcp" and startup_ms is not None:
                timing_text = (
                    f"timing llm[{transport}]: "
                    f"ttfb={ttfb_ms}ms total={total_ms}ms mcp_init={startup_ms}ms"
                )
            else:
                timing_text = f"timing llm[{transport}]: ttfb={ttfb_ms}ms total={total_ms}ms"
            await self._send({"type": "info", "message": timing_text})

        await tts_queue.put(None)
        await tts_worker

        assistant_text = assistant_text.strip()
        if assistant_text:
            await self._send({"type": "assistant_final", "text": assistant_text})
            self._history.append({"role": "assistant", "content": assistant_text})
            self._trim_history()

    async def _tts_loop(self, queue: asyncio.Queue[str | None]) -> None:
        if not self._tts:
            while await queue.get() is not None:
                pass
            return

        seq = 0
        while True:
            sentence = await queue.get()
            if sentence is None:
                return

            wav = await self._tts.synthesize_wav(sentence) if self._tts else None
            if not wav:
                continue

            encoded = base64.b64encode(wav).decode("ascii")
            await self._send(
                {
                    "type": "tts_audio",
                    "format": "wav",
                    "seq": seq,
                    "text": sentence,
                    "audio": encoded,
                }
            )
            seq += 1

    async def _speak_text(self, text: str) -> None:
        if not self._tts:
            await self._send({"type": "assistant_final", "text": text})
            return

        wav = await self._tts.synthesize_wav(text)
        if wav:
            encoded = base64.b64encode(wav).decode("ascii")
            await self._send({"type": "tts_audio", "format": "wav", "seq": 0, "text": text, "audio": encoded})

        await self._send({"type": "assistant_final", "text": text})

    def _trim_history(self) -> None:
        max_messages = max(settings.max_history_messages, 2)
        if len(self._history) <= max_messages:
            return

        system = self._history[0]
        tail = self._history[-(max_messages - 1) :]
        self._history = [system, *tail]

    async def _send(self, payload: dict[str, Any]) -> None:
        async with self._send_lock:
            try:
                await self._ws.send_json(payload)
            except RuntimeError:
                # Client may have disconnected; ignore send-after-close.
                return
