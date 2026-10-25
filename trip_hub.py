"""Read-only bridge to trip.crcmz.me, the CRCMZ BOYZ Calgary trip hub.

The trip app (TheMooseCompany/crcmz-trip) keeps its own store (flights, the Split
ledger, packing, polls, the itinerary/stay/food/buds content) and serves its Trip
AI's *read* tools to machine callers at GET /api/service/tool/<name>, behind a
bearer token. This module only ever GETs; the trip's propose_* (write) tools are
not reachable through that endpoint at all.

Env: TRIP_SERVICE_TOKEN (same value as in the trip app; unset = these tools say
so instead of failing), TRIP_URL (default https://trip.crcmz.me).
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

TRIP_URL = os.environ.get("TRIP_URL", "https://trip.crcmz.me").rstrip("/")
_TIMEOUT = httpx.Timeout(20.0, connect=5.0)


def configured() -> bool:
    return bool(os.environ.get("TRIP_SERVICE_TOKEN", "").strip())


def read(tool: str, args: dict | None = None) -> Any:
    """Run one trip read tool; returns its JSON result or {"error": ...}."""
    token = os.environ.get("TRIP_SERVICE_TOKEN", "").strip()
    if not token:
        return {"error": "the trip hub isn't connected (TRIP_SERVICE_TOKEN unset)"}
    params = {"args": json.dumps(args)} if args else None
    try:
        r = httpx.get(f"{TRIP_URL}/api/service/tool/{tool}", params=params,
                      headers={"Authorization": f"Bearer {token}"}, timeout=_TIMEOUT)
    except httpx.HTTPError as e:
        return {"error": f"trip.crcmz.me unreachable: {type(e).__name__}"}
    try:
        body = r.json()
    except ValueError:
        return {"error": f"trip.crcmz.me answered HTTP {r.status_code}"}
    if r.status_code != 200:
        return {"error": body.get("error") or f"HTTP {r.status_code}"}
    return body.get("result")
