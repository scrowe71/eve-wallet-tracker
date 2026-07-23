from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _data_root() -> Path:
    configured = os.getenv("EVEWALLET_DATA_DIR", "").strip()
    if configured:
        path = Path(configured).expanduser().resolve()
    elif os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        path = base / "EVEWalletTracker"
    else:
        path = Path.home() / ".local" / "share" / "EVEWalletTracker"
    path.mkdir(parents=True, exist_ok=True)
    (path / "data").mkdir(parents=True, exist_ok=True)
    (path / "logs").mkdir(parents=True, exist_ok=True)
    return path


APP_ROOT = _app_root()
DATA_ROOT = _data_root()
ENV_FILE = DATA_ROOT / ".env"
DEFAULT_DATABASE_URL = f"sqlite:///{(DATA_ROOT / 'data' / 'evewallet.db').as_posix()}"
DEFAULT_SECRET = secrets.token_urlsafe(48)


class Settings(BaseSettings):
    APP_NAME: str = "EVE Wallet Tracker Desktop"
    APP_BASE_URL: str = "http://127.0.0.1:8765"
    SECRET_KEY: str = DEFAULT_SECRET
    DATABASE_URL: str = DEFAULT_DATABASE_URL
    EVE_CLIENT_ID: str = ""
    EVE_CLIENT_SECRET: str = ""
    EVE_CALLBACK_URL: str = "http://127.0.0.1:8765/auth/callback"
    SESSION_TIMEOUT_HOURS: int = 3
    ESI_SYNC_COOLDOWN_MINUTES: int = 60
    DEFAULT_LOOT_PRICE_SOURCE: str = "Jita Buy"
    DEFAULT_LOOT_PERCENTAGE: float = 95.0
    JANICE_API_KEY: str = ""
    DESKTOP_MODE: bool = True

    model_config = SettingsConfigDict(env_file=str(ENV_FILE), extra="ignore")


settings = Settings()
