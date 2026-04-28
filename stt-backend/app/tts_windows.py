from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from app.config import settings


class WindowsSapiTTS:
    """TTS using Windows System.Speech SAPI voices.

    Produces a WAV byte string suitable for browser playback.
    Honors VCB_SAPI_VOICE_NAME and falls back to any pt-BR voice installed.
    """

    @property
    def enabled(self) -> bool:
        return True

    async def synthesize_wav(self, text: str) -> bytes | None:
        text = (text or "").strip()
        if not text:
            return None

        voice_name = (settings.sapi_voice_name or "").strip().replace("'", "''")

        with tempfile.TemporaryDirectory(prefix="vcb-sapi-") as td:
            temp_dir = Path(td)
            text_path = temp_dir / "input.txt"
            wav_path = temp_dir / "out.wav"
            script_path = temp_dir / "speak.ps1"

            text_path.write_text(text, encoding="utf-8")
            script_path.write_text(
                "\n".join(
                    [
                        "$ErrorActionPreference = 'Stop'",
                        "Add-Type -AssemblyName System.Speech",
                        f"$text = Get-Content -Raw -LiteralPath '{str(text_path)}'",
                        "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
                        f"$voiceName = '{voice_name}'",
                        "$selected = $false",
                        "if ($voiceName) {",
                        "    try { $synth.SelectVoice($voiceName); $selected = $true } catch { $selected = $false }",
                        "}",
                        "if (-not $selected) {",
                        "    try {",
                        "        $ptCulture = New-Object System.Globalization.CultureInfo 'pt-BR'",
                        "        $synth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, $ptCulture)",
                        "    } catch {}",
                        "}",
                        f"$synth.SetOutputToWaveFile('{str(wav_path)}')",
                        "$synth.Speak($text)",
                        "$synth.Dispose()",
                    ]
                ),
                encoding="utf-8",
            )

            proc = await asyncio.create_subprocess_exec(
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(stderr.decode("utf-8", errors="ignore").strip() or "Windows SAPI failed")

            if not wav_path.exists():
                return None

            return wav_path.read_bytes()
