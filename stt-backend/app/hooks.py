from __future__ import annotations

import asyncio
import shlex

from app.config import settings


class HookEmitter:
    async def emit(self, event: str, summary: str) -> None:
        if not settings.hook_wake_enabled:
            return

        text = f"{event}: {summary}".strip()
        cmd = [settings.openclaw_bin, "gateway", "wake", "--text", text, "--mode", "now"]

        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await process.wait()
        except FileNotFoundError:
            # If openclaw is unavailable, keep runtime flow intact.
            return
        except Exception:
            return


def shell_quote_command(argv: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in argv)
