from __future__ import annotations

import os
import secrets
from pathlib import Path


def root() -> Path:
    base = Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    path = base / "EVEWalletTracker"
    path.mkdir(parents=True, exist_ok=True)
    return path


def ask(label: str, existing: str = "") -> str:
    suffix = " [leave blank to keep current]" if existing else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or existing


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def main() -> None:
    env_path = root() / ".env"
    current = read_env(env_path)

    client_id = ask("EVE Client ID", current.get("EVE_CLIENT_ID", ""))
    client_secret = ask("EVE Client Secret", current.get("EVE_CLIENT_SECRET", ""))
    janice_key = ask("Janice API key", current.get("JANICE_API_KEY", ""))
    secret_key = current.get("SECRET_KEY") or secrets.token_urlsafe(48)

    content = "\n".join([
        f"SECRET_KEY={secret_key}",
        f"EVE_CLIENT_ID={client_id}",
        f"EVE_CLIENT_SECRET={client_secret}",
        "EVE_CALLBACK_URL=http://127.0.0.1:8765/auth/callback",
        "APP_BASE_URL=http://127.0.0.1:8765",
        f"JANICE_API_KEY={janice_key}",
        "SESSION_TIMEOUT_HOURS=3",
        "ESI_SYNC_COOLDOWN_MINUTES=60",
        "DEFAULT_LOOT_PRICE_SOURCE=Jita Buy",
        "DEFAULT_LOOT_PERCENTAGE=95",
        "",
    ])
    env_path.write_text(content, encoding="utf-8")
    print(f"Saved desktop settings to {env_path}")
    print("Register this exact EVE SSO callback URL: http://127.0.0.1:8765/auth/callback")


if __name__ == "__main__":
    main()
