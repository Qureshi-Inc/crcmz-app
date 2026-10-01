"""Web Push notifications for the installed CRCMZ app (the PWA at /app).

Standard Web Push (RFC 8030/8291) with VAPID: the browser hands us a
subscription (an endpoint on Apple's, Google's or Mozilla's push service plus
two keys) and we POST encrypted payloads to it. No third-party account, no
extra container. iOS delivers these only to the app once it is added to the
Home Screen (iOS 16.4+); Android and desktop deliver in the browser too.

DB: /data/push.db
  subscriptions  one row per device (endpoint), owned by a Zitadel ``sub``
  prefs          per-person category toggles (JSON), default all on
  sent           one row per notification fanned out, for the assistant tool
Key: /data/vapid_private.pem, made on first use (0600). Losing it only means
every device has to turn notifications on again.
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
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/push.db")
_KEY_PATH = Path("/data/vapid_private.pem")
_lock = threading.Lock()

VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "https://app.crcmz.me")

# What a person can switch on or off, in the order Settings shows them.
CATEGORIES: dict[str, str] = {
    "squad": "Squad Up rallies",
    "watch": "A Watch Party starts",
    "huddle": "A Huddle starts",
    "giveaway": "Giveaways open and winners",
    "clips": "New clips from the squad",
    "mentions": "Someone @mentions you",
    "movies": "A movie is added to the library, and when it's ready to watch",
}

# We POST to whatever endpoint a browser gives us, so only real push services:
# anything else would let a signed-in person point the server at internal URLs.
_PUSH_HOSTS = (
    "web.push.apple.com",           # Safari / iOS
    "fcm.googleapis.com",           # Chrome, Edge (some), Android
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    ".notify.windows.com",          # Edge on Windows
)
_MAX_DEVICES = 10


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS subscriptions (
                endpoint    TEXT PRIMARY KEY,
                sub         TEXT NOT NULL,
                p256dh      TEXT NOT NULL,
                auth        TEXT NOT NULL,
                ua          TEXT NOT NULL DEFAULT '',
                created_at  REAL NOT NULL,
                last_ok_at  REAL,
                fails       INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS subscriptions_sub ON subscriptions(sub);
            CREATE TABLE IF NOT EXISTS prefs (
                sub   TEXT PRIMARY KEY,
                json  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sent (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          REAL NOT NULL,
                category    TEXT NOT NULL,
                title       TEXT NOT NULL,
                body        TEXT NOT NULL,
                url         TEXT NOT NULL,
                actor_sub   TEXT NOT NULL DEFAULT '',
                recipients  INTEGER NOT NULL,
                delivered   INTEGER NOT NULL,
                gone        INTEGER NOT NULL DEFAULT 0
            );
        """)


# ── VAPID key ────────────────────────────────────────────────────────────────
def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _private_key():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    with _lock:
        if _KEY_PATH.is_file():
            return serialization.load_pem_private_key(_KEY_PATH.read_bytes(), password=None)
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
        _KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(_KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
        logger.info("push: made a new VAPID key")
        return key


def public_key() -> str:
    """The applicationServerKey browsers subscribe with (base64url, uncompressed P-256)."""
    from cryptography.hazmat.primitives import serialization
    pub = _private_key().public_key().public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint)
    return _b64url(pub)


# ── Subscriptions ────────────────────────────────────────────────────────────
def endpoint_allowed(endpoint: str) -> bool:
    try:
        u = urlsplit(endpoint)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    if u.scheme != "https" or not host or u.port not in (None, 443):
        return False
    return any(host == h.lstrip(".") or (h.startswith(".") and host.endswith(h)) for h in _PUSH_HOSTS)


def subscribe(sub: str, subscription: dict, *, ua: str = "", replaces: str = "") -> dict:
    """Save one device's subscription for ``sub``. Re-subscribing moves the device."""
    if not sub:
        return {"error": "no user"}
    endpoint = str((subscription or {}).get("endpoint") or "")
    keys = (subscription or {}).get("keys") or {}
    p256dh, auth = str(keys.get("p256dh") or ""), str(keys.get("auth") or "")
    if not endpoint_allowed(endpoint) or len(endpoint) > 1024:
        return {"error": "not a push service endpoint"}
    if not (20 < len(p256dh) < 200 and 8 < len(auth) < 100):
        return {"error": "subscription keys missing"}
    with _lock, _conn() as db:
        if replaces and replaces != endpoint:
            db.execute("DELETE FROM subscriptions WHERE endpoint=? AND sub=?", (replaces, sub))
        db.execute("""INSERT INTO subscriptions(endpoint, sub, p256dh, auth, ua, created_at)
                      VALUES (?,?,?,?,?,?)
                      ON CONFLICT(endpoint) DO UPDATE SET sub=excluded.sub, p256dh=excluded.p256dh,
                        auth=excluded.auth, ua=excluded.ua, fails=0""",
                   (endpoint, sub, p256dh, auth, (ua or "")[:200], time.time()))
        # Old phones pile up; keep the newest few per person.
        db.execute("""DELETE FROM subscriptions WHERE sub=? AND endpoint NOT IN (
                        SELECT endpoint FROM subscriptions WHERE sub=? ORDER BY created_at DESC LIMIT ?)""",
                   (sub, sub, _MAX_DEVICES))
    return {"ok": True, "devices": device_count(sub)}


def unsubscribe(sub: str, endpoint: str) -> dict:
    with _lock, _conn() as db:
        n = db.execute("DELETE FROM subscriptions WHERE sub=? AND endpoint=?", (sub, endpoint)).rowcount
    return {"ok": True, "removed": n, "devices": device_count(sub)}


def device_count(sub: str) -> int:
    with _conn() as db:
        return db.execute("SELECT COUNT(*) FROM subscriptions WHERE sub=?", (sub,)).fetchone()[0]


def is_subscribed(sub: str, endpoint: str) -> bool:
    with _conn() as db:
        return db.execute("SELECT 1 FROM subscriptions WHERE sub=? AND endpoint=?",
                          (sub, endpoint)).fetchone() is not None


# ── Preferences ──────────────────────────────────────────────────────────────
def get_prefs(sub: str) -> dict[str, bool]:
    with _conn() as db:
        row = db.execute("SELECT json FROM prefs WHERE sub=?", (sub,)).fetchone()
    saved = json.loads(row["json"]) if row else {}
    return {k: bool(saved.get(k, True)) for k in CATEGORIES}


def save_prefs(sub: str, changes: dict) -> dict[str, bool]:
    prefs = get_prefs(sub)
    for k, v in (changes or {}).items():
        if k in CATEGORIES:
            prefs[k] = bool(v)
    with _lock, _conn() as db:
        db.execute("INSERT INTO prefs(sub, json) VALUES (?,?) ON CONFLICT(sub) DO UPDATE SET json=excluded.json",
                   (sub, json.dumps(prefs)))
    return prefs


# ── Sending ──────────────────────────────────────────────────────────────────
def _send_one(row: sqlite3.Row, payload: str, *, ttl: int, urgency: str) -> int:
    """POST one encrypted payload. Returns the push service's HTTP status (0 = no answer)."""
    from pywebpush import WebPushException, webpush
    from py_vapid import Vapid
    try:
        r = webpush(
            subscription_info={"endpoint": row["endpoint"], "keys": {"p256dh": row["p256dh"], "auth": row["auth"]}},
            data=payload, vapid_private_key=Vapid(private_key=_private_key()),
            vapid_claims={"sub": VAPID_SUBJECT}, ttl=ttl, headers={"Urgency": urgency}, timeout=10,
        )
        return getattr(r, "status_code", 201)
    except WebPushException as e:
        return getattr(e.response, "status_code", 0) or 0
    except Exception as e:  # noqa: BLE001 — one dead device must not stop the rest
        logger.info("push: send failed (%s)", type(e).__name__)
        return 0


def notify(category: str, title: str, body: str = "", url: str = "/app", *,
           exclude: str = "", only: list[str] | None = None, tag: str = "",
           ttl: int = 3600, urgency: str = "normal") -> dict:
    """Fan one notification out to everyone who wants ``category``.

    ``exclude`` is the person who caused it (nobody is told about their own rally);
    ``only`` limits it to these subs. Dead subscriptions (404/410) are dropped.
    """
    if category not in CATEGORIES and category != "test":  # "test": a person's own check
        raise ValueError(f"unknown push category {category!r}")
    if not url.startswith("/app"):
        url = "/app"
    with _conn() as db:
        rows = db.execute("SELECT * FROM subscriptions").fetchall()
    wanted = {}
    for r in rows:
        if r["sub"] == exclude or (only is not None and r["sub"] not in only):
            continue
        if r["sub"] not in wanted:
            wanted[r["sub"]] = get_prefs(r["sub"]).get(category, True)
    targets = [r for r in rows if wanted.get(r["sub"])]
    payload = json.dumps({"title": title[:120], "body": body[:300], "url": url,
                          "tag": tag or category, "category": category})
    delivered, gone = 0, []
    for r in targets:
        status = _send_one(r, payload, ttl=ttl, urgency=urgency)
        if 200 <= status < 300:
            delivered += 1
        elif status in (404, 410):
            gone.append(r["endpoint"])
        with _lock, _conn() as db:
            if 200 <= status < 300:
                db.execute("UPDATE subscriptions SET last_ok_at=?, fails=0 WHERE endpoint=?", (time.time(), r["endpoint"]))
            elif status in (404, 410):
                db.execute("DELETE FROM subscriptions WHERE endpoint=?", (r["endpoint"],))
            else:
                db.execute("UPDATE subscriptions SET fails=fails+1 WHERE endpoint=?", (r["endpoint"],))
    with _lock, _conn() as db:
        db.execute("""INSERT INTO sent(ts, category, title, body, url, actor_sub, recipients, delivered, gone)
                      VALUES (?,?,?,?,?,?,?,?,?)""",
                   (time.time(), category, title[:120], body[:300], url, exclude, len(targets), delivered, len(gone)))
    if targets:
        logger.info("push: %s -> %d/%d delivered, %d gone", category, delivered, len(targets), len(gone))
    return {"category": category, "recipients": len(targets), "delivered": delivered, "gone": len(gone)}


def notify_in_background(*args, **kwargs) -> None:
    """notify() on a daemon thread: callers are request handlers and pollers."""
    def run():
        try:
            notify(*args, **kwargs)
        except Exception:  # noqa: BLE001
            logger.exception("push: notify failed")
    threading.Thread(target=run, name="webpush", daemon=True).start()


class Debounce:
    """True the first time a key is seen, then False until it has been quiet for ``quiet_s``.

    "Someone joined room X" fires on every join; a room *starting* is the first join
    after a quiet spell.
    """

    def __init__(self, quiet_s: float):
        self.quiet_s = quiet_s
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def first(self, key: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            last = self._seen.get(key)
            self._seen[key] = now
            return last is None or now - last > self.quiet_s


# ── Read side (assistant tool) ───────────────────────────────────────────────
def stats(limit: int = 20) -> dict:
    """Who can be reached and what went out lately. No endpoints, no keys."""
    with _conn() as db:
        people = db.execute("SELECT COUNT(DISTINCT sub) FROM subscriptions").fetchone()[0]
        devices = db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0]
        per = {r["sub"]: r["n"] for r in db.execute("SELECT sub, COUNT(*) n FROM subscriptions GROUP BY sub")}
        recent = [dict(r) for r in db.execute(
            "SELECT ts, category, title, body, url, recipients, delivered, gone FROM sent ORDER BY id DESC LIMIT ?",
            (max(1, min(int(limit), 100)),))]
    opted_in = {k: 0 for k in CATEGORIES}
    people_rows = []
    for s, n in per.items():
        prefs = get_prefs(s)
        for k, on in prefs.items():
            opted_in[k] += int(on)
        people_rows.append({"zitadel_id": s, "name": _name(s), "devices": n,
                            "off": [k for k, on in prefs.items() if not on]})
    for r in recent:
        r["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r.pop("ts")))
    return {"people_with_push": people, "devices": devices, "opted_in_by_category": opted_in,
            "people": people_rows, "categories": CATEGORIES, "recent": recent}


def _name(sub: str) -> str:
    """Display name through the identity graph; the id itself when unknown."""
    try:
        import crcmz_identity
        p = crcmz_identity.resolve(sub) or {}
        return p.get("display_name") or p.get("name") or sub
    except Exception:  # noqa: BLE001 - a name must never sink the stats
        return sub
