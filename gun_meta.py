"""Read-only bridge to the gun meta API (InterestingSoup/warzone-gun-search-bot).

That app scrapes wzstats (MW4 every few hours; Warzone and BO6 from the older
scrape) and serves the result as JSON under /api. Its own 4xx errors list the
valid options or a "Did you mean" suggestion, so they're passed through for the
model to recover from.

Env: GUN_META_URL, the API's base URL (unset = these tools say so).
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


def configured() -> bool:
    return bool(os.environ.get("GUN_META_URL", "").strip())


def _seg(value: str) -> str:
    return quote(str(value or "").strip()[:60], safe="")


def read(path: str, params: dict | None = None) -> Any:
    """GET /api<path>; returns the JSON body or {"error": ...}."""
    base = os.environ.get("GUN_META_URL", "").strip().rstrip("/")
    if not base:
        return {"error": "the gun meta service isn't connected (GUN_META_URL unset)"}
    clean = {k: str(v)[:60] for k, v in (params or {}).items() if v not in (None, "")}
    try:
        r = httpx.get(f"{base}/api{path}", params=clean or None, timeout=_TIMEOUT)
    except httpx.HTTPError as e:
        return {"error": f"gun meta service unreachable: {type(e).__name__}"}
    try:
        body = r.json()
    except ValueError:
        return {"error": f"gun meta service answered HTTP {r.status_code}"}
    if r.status_code != 200:
        return {"error": (body or {}).get("error") or f"HTTP {r.status_code}"}
    return body


def games(game: str = "") -> Any:
    return read(f"/games/{_seg(game)}") if (game or "").strip() else read("/games")


def meta(game: str, mode: str = "", category: str = "", weapon_type: str = "",
         limit: int = 3) -> Any:
    return read(f"/games/{_seg(game)}/meta",
                {"mode": mode, "category": category, "type": weapon_type, "limit": limit})


def tier_list(game: str, mode: str = "", category: str = "", weapon_type: str = "",
              tier: str = "") -> Any:
    return read(f"/games/{_seg(game)}/tier-list",
                {"mode": mode, "category": category, "type": weapon_type, "tier": tier})


def weapon(game: str, name: str, mode: str = "") -> Any:
    return read(f"/games/{_seg(game)}/weapons/{_seg(name)}", {"mode": mode})


def search(q: str, game: str = "") -> Any:
    return read("/search", {"q": q, "game": game})
