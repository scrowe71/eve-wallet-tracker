from __future__ import annotations

from fastapi import Request


def current_user_id(request: Request) -> int | None:
    value = request.session.get("user_id")
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        request.session.clear()
        return None


def is_public_path(path: str) -> bool:
    return (
        path.startswith("/auth/")
        or path.startswith("/static/")
        or path == "/favicon.ico"
        or path == "/timezone"
    )
