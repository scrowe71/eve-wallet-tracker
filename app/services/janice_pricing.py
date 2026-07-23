from __future__ import annotations

from dataclasses import dataclass
import requests

from app.config import settings

JANICE_URL = "https://janice.e-351.com/api/rest/v2/pricer"


class JanicePricingError(RuntimeError):
    pass


@dataclass(frozen=True)
class JanicePrice:
    type_id: int | None
    name: str
    buy_price: float


def price_items(item_names: list[str]) -> dict[str, JanicePrice]:
    api_key = (settings.JANICE_API_KEY or "").strip()
    if not api_key:
        raise JanicePricingError("JANICE_API_KEY is not configured in /opt/evewallet/.env.")
    clean = [str(name).strip() for name in item_names if str(name).strip()]
    if not clean:
        return {}
    try:
        response = requests.post(
            JANICE_URL,
            params={"market": 2},
            headers={"X-ApiKey": api_key, "Content-Type": "text/plain", "Accept": "application/json"},
            data="\n".join(clean).encode("utf-8"),
            timeout=30,
        )
    except requests.RequestException as exc:
        raise JanicePricingError(f"Janice request failed: {exc}") from exc
    if response.status_code >= 400:
        detail = response.text.strip()[:300]
        raise JanicePricingError(f"Janice returned HTTP {response.status_code}: {detail or 'no response details'}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise JanicePricingError(f"Janice returned {response.headers.get('content-type', 'non-JSON data')} instead of JSON.") from exc
    if not isinstance(payload, list):
        raise JanicePricingError("Janice returned an unexpected response format.")

    result: dict[str, JanicePrice] = {}
    for row in payload:
        if not isinstance(row, dict):
            continue
        item = row.get("itemType") or {}
        immediate = row.get("immediatePrices") or {}
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        try:
            buy = float(immediate.get("buyPrice") or 0)
        except (TypeError, ValueError):
            buy = 0.0
        type_id = item.get("eid")
        try:
            type_id = int(type_id) if type_id is not None else None
        except (TypeError, ValueError):
            type_id = None
        result[name.casefold()] = JanicePrice(type_id=type_id, name=name, buy_price=max(buy, 0.0))
    return result
