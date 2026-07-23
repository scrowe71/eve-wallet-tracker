import base64
import json
import time
from datetime import datetime, timedelta
from urllib.parse import urlencode
import requests
from app.config import settings

AUTHORIZE_URL = "https://login.eveonline.com/v2/oauth/authorize/"
TOKEN_URL = "https://login.eveonline.com/v2/oauth/token"
SCOPES = ["esi-wallet.read_character_wallet.v1"]

def build_authorize_url(state: str) -> str:
    params = {
        "response_type": "code",
        "redirect_uri": settings.EVE_CALLBACK_URL,
        "client_id": settings.EVE_CLIENT_ID,
        "scope": " ".join(SCOPES),
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"

def exchange_code_for_token(code: str) -> dict:
    response = requests.post(
        TOKEN_URL,
        auth=(settings.EVE_CLIENT_ID, settings.EVE_CLIENT_SECRET),
        data={"grant_type": "authorization_code", "code": code},
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "EVEWalletTracker/1.0"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()

def refresh_access_token(refresh_token: str) -> dict:
    response = requests.post(
        TOKEN_URL,
        auth=(settings.EVE_CLIENT_ID, settings.EVE_CLIENT_SECRET),
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "EVEWalletTracker/1.0"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()

def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)

def decode_jwt_payload_unverified(access_token: str) -> dict:
    parts = access_token.split(".")
    if len(parts) < 2:
        raise ValueError("Access token is not a JWT")
    return json.loads(_b64url_decode(parts[1]))

def character_info_from_token(access_token: str) -> dict:
    payload = decode_jwt_payload_unverified(access_token)
    sub = payload.get("sub", "")
    # Typical sub: CHARACTER:EVE:123456789
    character_id = int(sub.split(":")[-1]) if ":" in sub else int(sub)
    return {
        "character_id": character_id,
        "character_name": payload.get("name") or payload.get("preferred_username") or f"Character {character_id}",
        "owner_hash": payload.get("owner"),
        "expires_at": datetime.utcnow() + timedelta(seconds=int(payload.get("exp", int(time.time()) + 1200) - int(time.time()))),
        "scopes": payload.get("scp", []),
    }

def token_expires_at(token_response: dict) -> datetime:
    return datetime.utcnow() + timedelta(seconds=int(token_response.get("expires_in", 1200)))
