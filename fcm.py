"""Native rings for the CRCMZ Android app (android/), sent through Firebase Cloud Messaging.

Only a Huddle or a Watch Party starting rings: a full-screen call with Join /
Decline, drawn by the app itself (android/.../Ringer.kt). Everything else stays
Web Push (webpush.py), which works in the app unchanged because the app is Chrome.

A phone registers here from the app's first page load: the launcher puts its FCM
token on the URL and the signed-in page posts it to /api/push/native, together
with that phone's Web Push endpoint. A phone that rang isn't also sent the same
alert as Web Push (notifications.route skips those endpoints).

DB: /data/fcm.db, one row per phone (token), owned by a Zitadel ``sub``.
Credentials: a Firebase service-account JSON at /data/fcm_service_account.json,
or base64 in FCM_SERVICE_ACCOUNT_B64. Without one, rings are skipped and Web Push
carries the alert as before.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

import httpx
import jwt

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/fcm.db")
_CRED_PATH = Path(os.environ.get("FCM_SERVICE_ACCOUNT_PATH", "/data/fcm_service_account.json"))
_lock = threading.Lock()

# Push categories (webpush.CATEGORIES) that ring instead of buzzing once.
RING = {"huddle", "watch"}
_PLATFORMS = {"android", "ios", "ios-voip"}   # iPhones: apns.py sends to "ios" / "ios-voip"
_MAX_DEVICES = 10
_RING_TTL = "30s"  # a ring that can't arrive within half a minute is a missed call

_token_cache: dict = {}


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS devices (
                token         TEXT PRIMARY KEY,
                sub           TEXT NOT NULL,
                platform      TEXT NOT NULL,
                web_endpoint  TEXT NOT NULL DEFAULT '',
                created_at    REAL NOT NULL,
                seen_at       REAL NOT NULL,
                last_ok_at    REAL
            );
            CREATE INDEX IF NOT EXISTS devices_sub ON devices(sub);
        """)


# ── Credentials ──────────────────────────────────────────────────────────────
def _credentials() -> dict | None:
    raw = os.environ.get("FCM_SERVICE_ACCOUNT_B64", "")
    try:
        if raw:
            return json.loads(base64.b64decode(raw))
        if _CRED_PATH.exists():
            return json.loads(_CRED_PATH.read_text())
    except Exception:  # noqa: BLE001
        logger.exception("fcm: unreadable service account")
    return None


def configured() -> bool:
    return _credentials() is not None


def _access_token(creds: dict) -> str:
    """An OAuth token for the FCM v1 API, from a self-signed service-account JWT."""
    hit = _token_cache.get(creds["client_email"])
    if hit and hit[1] > time.time() + 60:
        return hit[0]
    now = int(time.time())
    assertion = jwt.encode({
        "iss": creds["client_email"],
        "scope": "https://www.googleapis.com/auth/firebase.messaging",
        "aud": creds["token_uri"], "iat": now, "exp": now + 3600,
    }, creds["private_key"], algorithm="RS256")
    r = httpx.post(creds["token_uri"], timeout=10, data={
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
    r.raise_for_status()
    body = r.json()
    _token_cache[creds["client_email"]] = (body["access_token"], now + int(body.get("expires_in", 3600)))
    return body["access_token"]


# ── Devices ──────────────────────────────────────────────────────────────────
def register(sub: str, token: str, platform: str = "android", web_endpoint: str = "") -> dict:
    token = (token or "").strip()
    if not sub or not (20 <= len(token) <= 4096) or any(c.isspace() for c in token):
        return {"error": "bad token"}
    if platform not in _PLATFORMS:
        return {"error": "unknown platform"}
    now = time.time()
    with _lock, _conn() as db:
        db.execute("""INSERT INTO devices(token, sub, platform, web_endpoint, created_at, seen_at)
                      VALUES (?,?,?,?,?,?)
                      ON CONFLICT(token) DO UPDATE SET sub=excluded.sub, platform=excluded.platform,
                        web_endpoint=CASE WHEN excluded.web_endpoint != '' THEN excluded.web_endpoint
                                          ELSE devices.web_endpoint END,
                        seen_at=excluded.seen_at""",
                   (token, sub, platform, (web_endpoint or "")[:2048], now, now))
        # A person's oldest phones go first past the cap (reinstalls leave dead tokens).
        db.execute("""DELETE FROM devices WHERE sub=? AND token NOT IN
                      (SELECT token FROM devices WHERE sub=? ORDER BY seen_at DESC LIMIT ?)""",
                   (sub, sub, _MAX_DEVICES))
    return {"ok": True}


def unregister(token: str) -> None:
    with _lock, _conn() as db:
        db.execute("DELETE FROM devices WHERE token=?", (token,))


def device_count(sub: str) -> int:
    with _conn() as db:
        return db.execute("SELECT COUNT(*) FROM devices WHERE sub=?", (sub,)).fetchone()[0]


# ── Sending ──────────────────────────────────────────────────────────────────
def _send_one(creds: dict, token: str, data: dict) -> tuple[int, str]:
    """POST one data message: (HTTP status, error text); status 0 when it never got there."""
    try:
        r = httpx.post(
            f"https://fcm.googleapis.com/v1/projects/{creds['project_id']}/messages:send",
            headers={"Authorization": f"Bearer {_access_token(creds)}"}, timeout=10,
            json={"message": {"token": token, "data": data,
                              "android": {"priority": "HIGH", "ttl": _RING_TTL}}})
        if r.status_code >= 400:
            logger.info("fcm: %s %s", r.status_code, r.text[:200])
            return r.status_code, r.text[:500]
        return r.status_code, ""
    except Exception:  # noqa: BLE001
        logger.exception("fcm: send failed")
        return 0, ""


def _gone(status: int, err: str) -> bool:
    """The app was uninstalled or the token rotated. A bad payload is also a 400, so look closer."""
    return status == 404 or "UNREGISTERED" in err or (status == 400 and "registration token" in err.lower())


def ring(category: str, title: str, body: str = "", url: str = "/app", *,
         exclude: str = "", only: list[str] | None = None, tag: str = "", caller: str = "") -> dict:
    """Ring every registered phone whose owner wants ``category``.

    Returns the Web Push endpoints of the phones that rang, so the caller can skip
    them for the same alert.
    """
    out = {"category": category, "recipients": 0, "delivered": 0, "gone": 0, "endpoints": set()}
    creds = _credentials()
    if category not in RING or creds is None:
        return out
    import webpush  # the same per-person switches decide both
    with _conn() as db:
        rows = db.execute("SELECT * FROM devices WHERE platform='android'").fetchall()
    wanted: dict[str, bool] = {}
    targets = []
    for r in rows:
        if r["sub"] == exclude or (only is not None and r["sub"] not in only):
            continue
        if r["sub"] not in wanted:
            wanted[r["sub"]] = webpush.get_prefs(r["sub"]).get(category, True)
        if wanted[r["sub"]]:
            targets.append(r)
    data = {"type": "ring", "category": category, "title": title[:120], "body": body[:300],
            "url": url if url.startswith("/app") else "/app", "tag": tag or category, "caller": caller[:80]}
    out["recipients"] = len(targets)
    for r in targets:
        status, err = _send_one(creds, r["token"], data)
        with _lock, _conn() as db:
            if 200 <= status < 300:
                out["delivered"] += 1
                if r["web_endpoint"]:
                    out["endpoints"].add(r["web_endpoint"])
                db.execute("UPDATE devices SET last_ok_at=? WHERE token=?", (time.time(), r["token"]))
            elif _gone(status, err):
                out["gone"] += 1
                db.execute("DELETE FROM devices WHERE token=?", (r["token"],))
    if targets:
        logger.info("fcm: ring %s -> %d/%d delivered, %d gone", category, out["delivered"], len(targets), out["gone"])
    return out


def stats() -> dict:
    """Who has the Android app registered for rings. No tokens."""
    import webpush
    with _conn() as db:
        rows = db.execute("""SELECT sub, COUNT(*) n, MAX(seen_at) seen, MAX(last_ok_at) rang
                             FROM devices GROUP BY sub""").fetchall()
    at = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None  # noqa: E731
    return {"configured": configured(), "rings_for": sorted(RING),
            "people": [{"zitadel_id": r["sub"], "name": webpush._name(r["sub"]), "phones": r["n"],
                        "last_opened": at(r["seen"]), "last_rang": at(r["rang"])} for r in rows]}
