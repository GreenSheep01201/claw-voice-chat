from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path


class MacSayTTS:
    """TTS using macOS `say` + `ffmpeg` to WAV.

    Produces a WAV byte string suitable for browser playback.
    """

    @property
    def enabled(self) -> bool:
        return True

    def __init__(self, voice: str | None = None, rate: int | None = None) -> None:
        self._voice = voice
        self._rate = rate

    async def synthesize_wav(self, text: str) -> bytes | None:
        text = (text or "").strip()
        if not text:
            return None

        with tempfile.TemporaryDirectory(prefix="vcb-say-") as td:
            aiff_path = Path(td) / "out.aiff"
            wav_path = Path(td) / "out.wav"

            say_cmd = ["say", "-o", str(aiff_path)]
            if self._voice:
                say_cmd.extend(["-v", self._voice])
            if self._rate:
                say_cmd.extend(["-r", str(self._rate)])
            say_cmd.append(text)

            ffmpeg_cmd = [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(aiff_path),
                "-ac",
                "1",
                "-ar",
                "16000",
                str(wav_path),
            ]

            proc1 = await asyncio.create_subprocess_exec(*say_cmd)
            rc1 = await proc1.wait()
            if rc1 != 0 or not aiff_path.exists():
                return None

            proc2 = await asyncio.create_subprocess_exec(*ffmpeg_cmd)
            rc2 = await proc2.wait()
            if rc2 != 0 or not wav_path.exists():
                return None

            return wav_path.read_bytes()
