from __future__ import annotations

import json
from pathlib import Path

from typing import Any

from fastapi import Depends, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.auth import is_token_valid, require_bearer_auth
from app.config import settings
from app.session import VoiceSession

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Claw-Voice-Chat", version="0.1.0")


@app.on_event("startup")
async def _startup_warmup() -> None:
    """Warm up Codex MCP so the first real user turn has lower TTFB.

    Key detail: keep the MCP process alive (do NOT start+close), otherwise the
    warmup work is wasted and can produce asyncio warnings.
    """

    if not settings.codex_warmup:
        return

    try:
        from app.llm import CodexMcpSession

        session = CodexMcpSession()
        await session.start()
        app.state.codex_mcp_session = session
    except Exception:
        # Warmup is best-effort; failures shouldn't block serving.
        return

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/runtime")
async def runtime() -> dict[str, str | bool]:
    # Intentionally unauthenticated so the frontend can decide whether to
    # show the token field before connecting.
    return {
        "llm_model": settings.llm_display_name,
        "stt_model": settings.stt_model_size,
        "tts_enabled": settings.tts_mode.strip().lower() != "off",
        "auth_enabled": bool(settings.auth_token),
    }


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.on_event("shutdown")
async def _shutdown_cleanup() -> None:
    session = getattr(app.state, "codex_mcp_session", None)
    if session is not None:
        try:
            await session.close()
        except Exception:
            pass


@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    model = websocket.query_params.get("model")
    profile = websocket.query_params.get("profile")
    engine = websocket.query_params.get("engine")
    language = websocket.query_params.get("language")
    model_size = websocket.query_params.get("model_size")

    if not is_token_valid(token):
        await websocket.close(code=4401)
        return

    await websocket.accept()

    shared_mcp = getattr(app.state, "codex_mcp_session", None)
    # If a profile is requested, we cannot use the shared session (which uses default profile).
    # Also, if a specific non-codex engine is requested, we cannot use the shared session.
    is_default_engine = (not engine) or (engine == "codex")
    use_shared = (shared_mcp is not None) and (not profile) and is_default_engine
    mcp_factory = (lambda: shared_mcp) if use_shared else None

    session = VoiceSession(
        websocket,
        mcp_session_factory=mcp_factory,
        model=model,
        profile=profile,
        engine=engine,
        language=language,
        model_size=model_size,
    )
    await session.start()

    try:
        while True:
            data = await websocket.receive_text()
            try:
                payload = json.loads(data)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON payload"})
                continue

            if not isinstance(payload, dict):
                await websocket.send_json({"type": "error", "message": "Message must be a JSON object"})
                continue

            await session.handle_message(payload)
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()


@app.get("/api/cli/status")
async def cli_status() -> dict[str, Any]:
    from app.cli import get_cli_status

    return await get_cli_status()


@app.get("/api/profiles")
async def profiles() -> list[dict[str, Any]]:
    from app.cli import get_profiles

    return await get_profiles()


@app.get("/api/models")
async def models(profile: str | None = None, engine: str | None = None) -> list[str]:
    from app.cli import get_models

    return await get_models(profile=profile, engine=engine)


@app.post("/api/flush")
async def flush(_: str = Depends(require_bearer_auth)) -> dict[str, str]:
    # Reserved endpoint for future orchestration hooks.
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)
