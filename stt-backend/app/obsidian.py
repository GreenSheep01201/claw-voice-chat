from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from app.config import settings

ROUTE_PATTERN = re.compile(
    r"^\*(?P<scope>[wp])?(?:\s+\[(?P<route>[^\]]+)\])?\s*(?P<body>.*)$",
    flags=re.IGNORECASE,
)
SAFE_COMPONENT_PATTERN = re.compile(r"[^\w\-.가-힣 ]+", flags=re.UNICODE)


@dataclass(slots=True)
class ObsidianCapture:
    scope: str
    route: str | None
    body: str


class ObsidianCaptureError(ValueError):
    pass


def parse_obsidian_command(text: str) -> ObsidianCapture:
    match = ROUTE_PATTERN.match(text.strip())
    if not match:
        raise ObsidianCaptureError("Invalid capture command")

    scope = (match.group("scope") or "").lower()
    scope = scope if scope in {"w", "p"} else "p"
    route = match.group("route")
    body = (match.group("body") or "").strip()

    if not body:
        raise ObsidianCaptureError("Capture text is empty")

    return ObsidianCapture(scope=scope, route=route, body=body)


def sanitize_component(name: str) -> str:
    cleaned = SAFE_COMPONENT_PATTERN.sub("_", name).strip().strip(".")
    return cleaned or "untitled"


def resolve_capture_path(capture: ObsidianCapture, now: datetime | None = None) -> Path:
    now = now or datetime.now()

    base_root = settings.work_vault_root if capture.scope == "w" else settings.personal_vault_root
    if capture.route:
        parts = [sanitize_component(part) for part in capture.route.split("/") if part.strip()]
        if not parts:
            raise ObsidianCaptureError("Invalid route path")
        return base_root / "Projects" / Path(*parts) / f"{now:%Y-%m-%d}.md"

    return base_root / "Inbox" / f"{now:%Y-%m}.md"


def append_capture(capture: ObsidianCapture, now: datetime | None = None) -> Path:
    now = now or datetime.now()
    file_path = resolve_capture_path(capture, now=now)
    file_path.parent.mkdir(parents=True, exist_ok=True)

    line = f"- {now:%Y-%m-%d %H:%M} {capture.body}\n"
    with file_path.open("a", encoding="utf-8") as handle:
        handle.write(line)

    return file_path
