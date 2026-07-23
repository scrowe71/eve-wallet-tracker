from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, Tuple

import requests

THE_FORGE_REGION_ID = 10000002
JITA_SYSTEM_ID = 30000142
JITA_44_STATION_ID = 60003760
ESI_BASE = "https://esi.evetech.net/latest"
USER_AGENT = "EVEWalletTracker/1.0 (evewallet.crankyape.space)"


class PricingError(Exception):
    pass


@dataclass
class ResolvedItem:
    item_name: str
    type_id: int


@dataclass
class JitaPrice:
    type_id: int
    price_source: str
    price: float
    order_count: int
    location_note: str


_type_cache: Dict[str, ResolvedItem] = {}
_price_cache: Dict[Tuple[int, str], Tuple[float, JitaPrice]] = {}
CACHE_SECONDS = 20 * 60


def _headers() -> dict:
    return {"User-Agent": USER_AGENT, "Accept": "application/json"}


def resolve_inventory_type(item_name: str) -> ResolvedItem:
    """Resolve an EVE inventory type name to a type_id using public ESI.

    Primary path uses /universe/ids/, which is better for exact item names
    pasted from inventory/contracts. If that fails, fall back to strict search.
    The display item_name is kept as pasted by the user so the UI remains familiar.
    """
    clean = (item_name or "").strip()
    if not clean:
        raise PricingError("item name is blank")
    key = clean.casefold()
    cached = _type_cache.get(key)
    if cached:
        return cached

    # ESI's universe IDs endpoint accepts exact names and returns category-aware
    # matches. This handles item names with quotes, roman numerals, and embedded
    # numbers more reliably than /search/?strict=true.
    try:
        resp = requests.post(
            f"{ESI_BASE}/universe/ids/",
            params={"datasource": "tranquility", "language": "en"},
            json=[clean],
            headers=_headers(),
            timeout=20,
        )
        if resp.status_code not in (400, 404):
            resp.raise_for_status()
            data = resp.json() or {}
            matches = data.get("inventory_types") or []
            for match in matches:
                name = str(match.get("name") or "").strip()
                type_id = match.get("id")
                if type_id and name.casefold() == key:
                    resolved = ResolvedItem(item_name=name, type_id=int(type_id))
                    _type_cache[key] = resolved
                    return resolved
            if matches:
                match = matches[0]
                type_id = match.get("id")
                name = str(match.get("name") or clean).strip()
                if type_id:
                    resolved = ResolvedItem(item_name=name, type_id=int(type_id))
                    _type_cache[key] = resolved
                    return resolved
    except requests.RequestException:
        # Fall through to search so temporary endpoint quirks still get a chance.
        pass

    params = {
        "datasource": "tranquility",
        "categories": "inventory_type",
        "search": clean,
        "strict": "true",
    }
    resp = requests.get(f"{ESI_BASE}/search/", params=params, headers=_headers(), timeout=20)
    if resp.status_code == 404:
        raise PricingError(f"could not resolve item name: {clean}")
    resp.raise_for_status()
    data = resp.json() or {}
    ids = data.get("inventory_type") or []
    if not ids:
        raise PricingError(f"could not resolve item name: {clean}")

    resolved = ResolvedItem(item_name=clean, type_id=int(ids[0]))
    _type_cache[key] = resolved
    return resolved


def _fetch_market_orders(type_id: int, order_type: str) -> list[dict]:
    orders: list[dict] = []
    page = 1
    while True:
        params = {
            "datasource": "tranquility",
            "order_type": order_type,
            "type_id": int(type_id),
            "page": page,
        }
        resp = requests.get(
            f"{ESI_BASE}/markets/{THE_FORGE_REGION_ID}/orders/",
            params=params,
            headers=_headers(),
            timeout=30,
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        batch = resp.json() or []
        orders.extend(batch)
        pages = int(resp.headers.get("X-Pages", "1") or "1")
        if page >= pages:
            break
        page += 1
    return orders


def get_jita_price(type_id: int, price_source: str) -> JitaPrice:
    """Return highest Jita buy or lowest Jita sell price for a type.

    Preferred source is Jita 4-4 station orders. If none exist, falls back to
    all Jita solar system orders. If still none, falls back to the best order in
    The Forge so unusual items still price when possible.
    """
    source = (price_source or "Jita Buy").strip()
    if source not in ("Jita Buy", "Jita Sell"):
        source = "Jita Buy"

    cache_key = (int(type_id), source)
    cached = _price_cache.get(cache_key)
    now = time.time()
    if cached and now - cached[0] < CACHE_SECONDS:
        return cached[1]

    order_type = "buy" if source == "Jita Buy" else "sell"
    orders = _fetch_market_orders(type_id, order_type)
    if not orders:
        raise PricingError(f"no {source.lower()} market orders found")

    station_orders = [o for o in orders if int(o.get("location_id") or 0) == JITA_44_STATION_ID]
    jita_orders = [o for o in orders if int(o.get("system_id") or 0) == JITA_SYSTEM_ID]

    candidate_orders = station_orders or jita_orders or orders
    location_note = "Jita 4-4" if station_orders else ("Jita system" if jita_orders else "The Forge fallback")

    if source == "Jita Buy":
        best = max(candidate_orders, key=lambda o: float(o.get("price") or 0))
    else:
        best = min(candidate_orders, key=lambda o: float(o.get("price") or 0))

    price = float(best.get("price") or 0)
    result = JitaPrice(
        type_id=int(type_id),
        price_source=source,
        price=price,
        order_count=len(candidate_orders),
        location_note=location_note,
    )
    _price_cache[cache_key] = (now, result)
    return result
