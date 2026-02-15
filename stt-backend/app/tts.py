from __future__ import annotations

import asyncio
import re
import tempfile
from pathlib import Path
import shutil

from app.config import settings

SENTENCE_END_PATTERN = re.compile(r"([.!?。！？]|\n)")


class SentenceChunker:
    def __init__(self) -> None:
        self._buffer = ""

    def push(self, delta: str) -> list[str]:
        if not delta:
            return []

        self._buffer += delta
        sentences: list[str] = []

        while True:
            match = SENTENCE_END_PATTERN.search(self._buffer)
            if not match:
                break
            end = match.end()
            sentence = self._buffer[:end].strip()
            self._buffer = self._buffer[end:]
            if sentence:
                sentences.append(sentence)

        return sentences

    def flush(self) -> list[str]:
        rest = self._buffer.strip()
        self._buffer = ""
        return [rest] if rest else []


class PiperTTS:
    def __init__(self) -> None:
        # Piper requires a binary + a real model path.
        model = (settings.piper_model or "").strip()
        bin_name = (settings.piper_bin or "piper").strip()
        bin_ok = shutil.which(bin_name) is not None
        model_ok = bool(model) and Path(model).expanduser().exists()
        self._enabled = bool(bin_ok and model_ok)

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def synthesize_wav(self, text: str) -> bytes | None:
        if not self._enabled:
            return None

        text = text.strip()
        if not text:
            return None

        with tempfile.NamedTemporaryFile(prefix="vcb-", suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            cmd = [
                settings.piper_bin,
                "--model",
                settings.piper_model,
                "--output_file",
                str(tmp_path),
            ]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate(input=text.encode("utf-8"))
            if proc.returncode != 0:
                raise RuntimeError(stderr.decode("utf-8", errors="ignore").strip() or "piper failed")

            if not tmp_path.exists():
                return None

            return tmp_path.read_bytes()
        except FileNotFoundError:
            self._enabled = False
            return None
        except Exception:
            return None
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
