"""Notifications and rings for the CRCMZ iOS app (ios/), through Apple Push Notifications.

The iOS app is a web view, and a web view gets no Web Push, so an iPhone needs APNs
for everything:

    alert   every category notifications.route() sends (mentions, movies, Squad Up, …):
            a normal iPhone notification; tapping it opens the page it names
    ring    huddle / watch: a VoIP push that shows the system call screen (CallKit,
            ios/CRCMZ/Calls.swift). Someone who was rung isn't also sent the alert.

Phones register like the Android app (fcm.py, the same devices table): the app hands
its tokens to the signed-in page, which posts them to /api/push/native as platform
"ios" (alerts) and "ios-voip" (rings).

Key: the "crcmz push" APNs key (Key ID APNS_KEY_ID, team APNS_TEAM_ID), as base64 in
APNS_KEY_B64 or a file at APNS_KEY_PATH. Without it iPhones get nothing and nothing
else changes. TestFlight and App Store builds use production APNs; APNS_SANDBOX=1 for a
debug build from Xcode.
"""

from __future__ import annotations

import base64
import logging
import os
import threading
import time
from pathlib import Path

import httpx
import jwt

logger = logging.getLogger(__name__)

TEAM_ID = os.environ.get("APNS_TEAM_ID", "CF6R3NUAP7")
KEY_ID = os.environ.get("APNS_KEY_ID", "6J4DUKY9AR")
TOPIC = os.environ.get("APNS_TOPIC", "me.crcmz.app")
_KEY_PATH = Path(os.environ.get("APNS_KEY_PATH", "/data/apns_key.p8"))
HOST = ("https://api.sandbox.push.apple.com" if os.environ.get("APNS_SANDBOX") == "1"
        else "https://api.push.apple.com")
RING_S = 30          # a ring that can't arrive within half a minute is a missed call
ALERT_TTL_S = 3600

_lock = threading.Lock()
_jwt: tuple[str, float] = ("", 0.0)
_client: httpx.Client | None = None


def _key() -> str | None:
    raw = os.environ.get("APNS_KEY_B64", "")
    try:
        if raw:
            return base64.b64decode(raw).decode()
        if _KEY_PATH.exists():
            return _KEY_PATH.read_text()
    except Exception:  # noqa: BLE001
        logger.exception("apns: unreadable key")
    return None


def configured() -> bool:
    return _key() is not None


def _token() -> str:
    """The provider JWT: Apple wants a fresh one at most hourly and at least every 20 minutes."""
    global _jwt
    with _lock:
        if _jwt[0] and time.time() - _jwt[1] < 40 * 60:
            return _jwt[0]
        key = _key()
        if not key:
            raise RuntimeError("no APNs key")
        now = time.time()
        tok = jwt.encode({"iss": TEAM_ID, "iat": int(now)}, key, algorithm="ES256", headers={"kid": KEY_ID})
        _jwt = (tok, now)
        return tok


def _http() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(http2=True, timeout=10)
    return _client


def send(device: str, payload: dict, *, voip: bool = False, collapse: str = "", ttl: int = ALERT_TTL_S) -> tuple[int, str]:
    """One push to one device token: (HTTP status, Apple's reason). 0 when it never got there."""
    headers = {
        "authorization": f"bearer {_token()}",
        "apns-topic": TOPIC + (".voip" if voip else ""),
        "apns-push-type": "voip" if voip else "alert",
        "apns-priority": "10",
        "apns-expiration": str(int(time.time()) + ttl),
    }
    if collapse:
        headers["apns-collapse-id"] = collapse[:64]
    try:
        r = _http().post(f"{HOST}/3/device/{device}", headers=headers, json=payload)
    except Exception:  # noqa: BLE001
        logger.exception("apns: send failed")
        return 0, ""
    reason = ""
    if r.status_code >= 400:
        try:
            reason = (r.json() or {}).get("reason", "")
        except ValueError:
            reason = r.text[:200]
        logger.info("apns: %s %s", r.status_code, reason)
    return r.status_code, reason


def _gone(status: int, reason: str) -> bool:
    """The app was deleted or the token belongs to another environment: forget the phone."""
    return status == 410 or reason in ("BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic")


def _targets(platform: str, category: str, exclude: str, only: list[str] | None, skip: set[str]) -> list:
    import fcm
    import webpush  # the same per-person switches as push
    with fcm._conn() as db:
        rows = db.execute("SELECT * FROM devices WHERE platform=?", (platform,)).fetchall()
    wanted: dict[str, bool] = {}
    out = []
    for r in rows:
        if r["sub"] == exclude or r["sub"] in skip or (only is not None and r["sub"] not in only):
            continue
        if r["sub"] not in wanted:
            wanted[r["sub"]] = webpush.get_prefs(r["sub"]).get(category, True)
        if wanted[r["sub"]]:
            out.append(r)
    return out


def _deliver(rows: list, payload: dict, *, voip: bool, collapse: str, ttl: int) -> dict:
    import fcm
    out = {"recipients": len(rows), "delivered": 0, "gone": 0, "subs": set()}
    for r in rows:
        status, reason = send(r["token"], payload, voip=voip, collapse=collapse, ttl=ttl)
        with fcm._lock, fcm._conn() as db:
            if 200 <= status < 300:
                out["delivered"] += 1
                out["subs"].add(r["sub"])
                db.execute("UPDATE devices SET last_ok_at=? WHERE token=?", (time.time(), r["token"]))
            elif _gone(status, reason):
                out["gone"] += 1
                db.execute("DELETE FROM devices WHERE token=?", (r["token"],))
    return out


def ring(category: str, title: str, body: str = "", url: str = "/app", *, exclude: str = "",
         only: list[str] | None = None, tag: str = "", caller: str = "") -> dict:
    """Huddle / Watch Party: the iPhone's call screen. Returns who rang (``subs``)."""
    import fcm
    if category not in fcm.RING or not configured():
        return {"recipients": 0, "delivered": 0, "gone": 0, "subs": set()}
    rows = _targets("ios-voip", category, exclude, only, set())
    payload = {"type": "ring", "category": category, "title": title[:120], "body": body[:300],
               "url": url if url.startswith("/app") else "/app", "tag": tag or category, "caller": caller[:80]}
    out = _deliver(rows, payload, voip=True, collapse="", ttl=RING_S)
    if rows:
        logger.info("apns: ring %s -> %d/%d, %d gone", category, out["delivered"], len(rows), out["gone"])
    return out


def alert(category: str, title: str, body: str = "", url: str = "/app", *, exclude: str = "",
          only: list[str] | None = None, tag: str = "", skip: set[str] | None = None) -> dict:
    """A normal iPhone notification for anyone with the app (``skip``: people already rung)."""
    if not configured():
        return {"recipients": 0, "delivered": 0, "gone": 0}
    rows = _targets("ios", category, exclude, only, skip or set())
    payload = {"aps": {"alert": {"title": title[:120], "body": body[:300]}, "sound": "default",
                       "thread-id": category},
               "url": url if url.startswith("/app") else "/app", "category": category}
    out = _deliver(rows, payload, voip=False, collapse=tag or "", ttl=ALERT_TTL_S)
    out.pop("subs", None)
    if rows:
        logger.info("apns: %s -> %d/%d, %d gone", category, out["delivered"], len(rows), out["gone"])
    return out
