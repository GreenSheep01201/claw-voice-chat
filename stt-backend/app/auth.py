from __future__ import annotations

from fastapi import Header, HTTPException, Query

from app.config import settings


def is_token_valid(token: str | None) -> bool:
    if not settings.auth_token:
        return True
    return bool(token and token == settings.auth_token)


def require_bearer_auth(authorization: str | None = Header(default=None)) -> str:
    if not settings.auth_token:
        return ""

    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not is_token_valid(token):
        raise HTTPException(status_code=401, detail="Invalid token")

    return token


def require_ws_token(token: str | None = Query(default=None)) -> str:
    if not settings.auth_token:
        return ""
    if not is_token_valid(token):
        raise HTTPException(status_code=401, detail="Invalid websocket token")
    return token or ""
