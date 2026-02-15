from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import httpx

from app.config import settings
from app.hooks import HookEmitter
from app.obsidian import ObsidianCaptureError, append_capture, parse_obsidian_command

IMAGE_PREFIXES = ("/img", "/image", "!img", "!image")


@dataclass(slots=True)
class CommandResult:
    handled: bool
    kind: str | None = None
    response: str = ""
    metadata: dict[str, str] = field(default_factory=dict)


class CommandRouter:
    def __init__(self, hooks: HookEmitter) -> None:
        self._hooks = hooks

    async def route(self, text: str) -> CommandResult:
        stripped = text.strip()
        if not stripped:
            return CommandResult(handled=False)

        if stripped.startswith("#"):
            return await self._route_kanban(stripped)

        if stripped.startswith("*"):
            return await self._route_obsidian(stripped)

        lowered = stripped.lower()
        for prefix in IMAGE_PREFIXES:
            if lowered.startswith(prefix):
                prompt = stripped[len(prefix) :].strip()
                return await self._route_image(prompt)

        return CommandResult(handled=False)

    async def _route_kanban(self, text: str) -> CommandResult:
        body = text[1:].strip()
        if not body:
            return CommandResult(
                handled=True,
                kind="kanban",
                response="Kanban command is empty. Say `# <task>`.",
            )

        payload = {"source": "voice-chat-web", "text": body}
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(settings.kanban_inbox_url, json=payload)
            response.raise_for_status()

        await self._hooks.emit("kanban_added", body[:140])
        return CommandResult(
            handled=True,
            kind="kanban",
            response=f"Added to kanban: {body}",
            metadata={"target": settings.kanban_inbox_url},
        )

    async def _route_obsidian(self, text: str) -> CommandResult:
        try:
            capture = parse_obsidian_command(text)
            path = append_capture(capture)
        except ObsidianCaptureError as exc:
            return CommandResult(
                handled=True,
                kind="obsidian",
                response=f"Obsidian capture error: {exc}",
            )

        await self._hooks.emit("obsidian_capture", capture.body[:140])
        return CommandResult(
            handled=True,
            kind="obsidian",
            response=f"Captured to Obsidian: {path}",
            metadata={"path": str(path)},
        )

    async def _route_image(self, prompt: str) -> CommandResult:
        if not prompt:
            return CommandResult(
                handled=True,
                kind="image",
                response="Image prompt is empty. Say `/img <prompt>`.",
            )

        cmd = [
            settings.openclaw_bin,
            "gateway",
            "wake",
            "--text",
            f"Image generation request: {prompt}",
            "--mode",
            "now",
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
        except FileNotFoundError:
            return CommandResult(
                handled=True,
                kind="image",
                response="openclaw CLI not found. Install it or set OPENCLAW_BIN.",
            )

        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="ignore").strip() or "unknown error"
            return CommandResult(
                handled=True,
                kind="image",
                response=f"Image route failed: {err}",
            )

        await self._hooks.emit("image_requested", prompt[:140])
        return CommandResult(
            handled=True,
            kind="image",
            response=f"Image generation request sent: {prompt}",
        )
