"""The notification centre: every alert in the app goes through route().

    route() ──> inbox            always; the bell and /app/notifications
            └─> Web Push         webpush.py, per-category switches
            └─> Android ring     fcm.py, Huddle / Watch Party starts only
            └─> WhatsApp DM      personal alerts only, per-person switch
            └─> Mattermost DM    personal alerts only, per-person switch

A broadcast (a rally, a Watch Party starting) lands in everyone's inbox and on
their phones. The WhatsApp group and the Mattermost channel already hear about
those from their own bots, so nobody is DMed for them. A personal alert (someone
@mentions you on Slap) goes to your inbox, your phone and, unless you switch them
off, a DM on WhatsApp and Mattermost. Movie alerts ("Zubair added Dune", "Dune is
ready to watch") are sent to each member by name, so they DM too; switching the
"movies" category off in Settings stops their push and their DMs.

DB: /data/notifications.db
  items     one row per alert; audience is '*' (everyone) or one Zitadel sub
  reads     (sub, item_id) for alerts opened one at a time
  cursors   sub -> every item at or below this id counts as read ("Mark all read")
  channels  sub -> {"whatsapp": bool, "mattermost": bool}, default on (personal alerts' DMs)
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable

import apns
import fcm
import webpush

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/notifications.db")
_lock = threading.Lock()

PUBLIC_URL = os.environ.get("APP_PUBLIC_URL", "https://app.crcmz.me").rstrip("/")
KEEP_DAYS = 30
KEEP_ROWS = 5000

# Where each category came from, for the inbox's filter chips and icons.
SOURCES: dict[str, str] = {
    "squad": "squad", "watch": "watch", "huddle": "huddle", "giveaway": "giveaway",
    "clips": "clips", "mentions": "slap", "movies": "watch",
}
# Personal categories: these can also DM the person on WhatsApp and Mattermost.
DIRECT = {"mentions", "movies"}
# Categories whose DMs also obey the person's push switch for that category (Settings):
# a movie alert goes to everyone, so "off" there has to mean off everywhere but the inbox.
DM_FOLLOWS_PUSH = {"movies"}
CHANNELS: dict[str, str] = {
    "whatsapp": "WhatsApp DM for @mentions and new movies",
    "mattermost": "Mattermost DM for @mentions and new movies",
}

# The senders are wired by server.py (which knows the bridge's address); tests swap
# them for fakes. Each returns True when the message was accepted.
wa_send: Callable[[str, str], bool] | None = None
mm_dm: Callable[..., bool] | None = None  # (username, message, email=)

# Five mentions in a row from one thread should not buzz someone's WhatsApp five times.
_dm_quiet = webpush.Debounce(90)


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS items (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          REAL NOT NULL,
                category    TEXT NOT NULL,
                source      TEXT NOT NULL,
                audience    TEXT NOT NULL,
                actor_sub   TEXT NOT NULL DEFAULT '',
                title       TEXT NOT NULL,
                body        TEXT NOT NULL,
                url         TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS items_audience ON items(audience, id);
            CREATE TABLE IF NOT EXISTS reads (
                sub      TEXT NOT NULL,
                item_id  INTEGER NOT NULL,
                PRIMARY KEY (sub, item_id)
            );
            CREATE TABLE IF NOT EXISTS cursors (
                sub      TEXT PRIMARY KEY,
                item_id  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS channels (
                sub   TEXT PRIMARY KEY,
                json  TEXT NOT NULL
            );
        """)


def _clean_url(url: str) -> str:
    return url if isinstance(url, str) and url.startswith("/app") and "//" not in url else "/app"


# ── Writing ──────────────────────────────────────────────────────────────────
def record(category: str, title: str, body: str = "", url: str = "/app", *,
           only: list[str] | None = None, exclude: str = "") -> list[int]:
    """Put one alert in the inbox: everyone's (``only`` is None) or these people's."""
    if category not in SOURCES:
        raise ValueError(f"unknown notification category {category!r}")
    audience = ["*"] if only is None else sorted({s for s in only if s and s != exclude})
    now = time.time()
    ids = []
    with _lock, _conn() as db:
        for a in audience:
            cur = db.execute(
                "INSERT INTO items(ts, category, source, audience, actor_sub, title, body, url) VALUES (?,?,?,?,?,?,?,?)",
                (now, category, SOURCES[category], a, exclude or "", title[:120], body[:300], _clean_url(url)))
            ids.append(cur.lastrowid)
        # Prune: a month of alerts, and never more than a few thousand rows.
        db.execute("DELETE FROM items WHERE ts < ?", (now - KEEP_DAYS * 86400,))
        db.execute("DELETE FROM items WHERE id <= (SELECT MAX(id) FROM items) - ?", (KEEP_ROWS,))
        db.execute("DELETE FROM reads WHERE item_id NOT IN (SELECT id FROM items)")
    return ids


def route(category: str, title: str, body: str = "", url: str = "/app", *,
          exclude: str = "", only: list[str] | None = None, tag: str = "",
          ttl: int = 3600, urgency: str = "normal", dm_text: str = "", dms: bool = True,
          caller: str = "") -> dict:
    """Send one alert everywhere it should go. Same arguments as webpush.notify.

    ``dm_text`` is the WhatsApp/Mattermost wording for a personal alert; the
    title and body are used when it is empty. ``dms=False`` keeps a personal
    category's alert to the inbox and push (squad news, not a message to you).
    ``caller`` names who rings, for the categories that ring the Android app.
    """
    url = _clean_url(url)
    out: dict = {"category": category, "inbox": len(record(category, title, body, url, only=only, exclude=exclude))}
    rang: set[str] = set()
    rang_android: set[str] = set()
    rang_ios: set[str] = set()
    if category in fcm.RING:
        try:
            r = fcm.ring(category, title, body, url, exclude=exclude, only=only, tag=tag, caller=caller)
            rang = r.pop("endpoints")
            rang_android = r.pop("subs")
            out["ring"] = r
        except Exception:  # noqa: BLE001 - a failed ring falls back to plain push
            logger.exception("notifications: ring failed")
        try:
            r = apns.ring(category, title, body, url, exclude=exclude, only=only, tag=tag, caller=caller)
            rang_ios = r.pop("subs")
            out["ring_ios"] = r
        except Exception:  # noqa: BLE001
            logger.exception("notifications: iPhone ring failed")
    try:
        # The iOS app is a web view with no Web Push: iPhones get every alert through APNs
        # (those that just rang excepted).
        out["ios"] = apns.alert(category, title, body, url, exclude=exclude, only=only, tag=tag, skip=rang_ios)
    except Exception:  # noqa: BLE001
        logger.exception("notifications: iPhone alert failed")
    try:
        # The native Android app is a web view too: every alert through FCM.
        out["android"] = fcm.alert(category, title, body, url, exclude=exclude, only=only, tag=tag, skip=rang_android)
    except Exception:  # noqa: BLE001
        logger.exception("notifications: Android alert failed")
    try:
        out["push"] = webpush.notify(category, title, body, url, exclude=exclude, only=only,
                                     tag=tag, ttl=ttl, urgency=urgency, skip=rang)
    except Exception:  # noqa: BLE001 - push failing must not lose the DMs
        logger.exception("notifications: push failed")
        out["push"] = None
    if dms and category in DIRECT and only:
        out["dms"] = _direct(only, exclude, dm_text or f"{title}\n{body}".strip(), url, tag or category, category)
    return out


def route_in_background(*args, **kwargs) -> None:
    """route() on a daemon thread: callers are request handlers and pollers."""
    def run():
        try:
            out = route(*args, **kwargs)
            logger.info("notifications: %s -> inbox %s, push %s, dms %s", out["category"], out["inbox"],
                        (out.get("push") or {}).get("delivered"), out.get("dms"))
        except Exception:  # noqa: BLE001
            logger.exception("notifications: route failed")
    threading.Thread(target=run, name="notify", daemon=True).start()


RING_COOLDOWN_S = 60
_rang_by: dict[str, float] = {}


RING_ONE_COOLDOWN_S = 30


def ring_squad(kind: str, caller_sub: str, caller_name: str, room: str = "",
               only: list[str] | None = None) -> dict:
    """Someone pressed Ring: call everyone else's phone into a Huddle or the Watch Party,
    or just the people in `only` (Zitadel ids: the ring list's per-person buttons).

    Everyone: one ring a minute per person per kind, whoever asks (the app's button or a
    tool). One person: once every 30 s each. People who switched that category off
    aren't rung (same switches as push).
    """
    if only is not None:
        only = sorted({str(x) for x in only if str(x) and str(x) != caller_sub})[:20]
        if not only:
            return {"error": "nobody to ring"}
    if kind not in fcm.RING:
        return {"error": "kind must be huddle or watch"}
    if not caller_sub:
        return {"error": "no caller"}
    room = re.sub(r"[^a-z0-9\-]", "", (room or "crcmz").lower())[:64] or "crcmz"
    who = (caller_name or "Someone").strip()[:60] or "Someone"
    now = time.time()
    key = f"{caller_sub}:{kind}" + (f":{','.join(only)}" if only else "")
    wait = RING_ONE_COOLDOWN_S if only else RING_COOLDOWN_S
    with _lock:
        last = _rang_by.get(key)
        if last is not None and now - last < wait:
            return {"error": "cooldown", "retry_in": int(wait - (now - last)) + 1}
        _rang_by[key] = now
    if kind == "huddle":
        out = route("huddle", f"📞 {who} is calling you to a Huddle", f"Room {room}. Tap to jump in.",
                    f"/app/huddle?room={room}", exclude=caller_sub, only=only, tag=f"huddle-{room}",
                    urgency="high", ttl=600, caller=who)
    else:
        out = route("watch", f"📞 {who} is calling you to the Watch Party", "Tap to join.",
                    "/app/watch/party", exclude=caller_sub, only=only, tag="watch-ring", urgency="high", ttl=600, caller=who)
    ring = out.get("ring") or {}
    push = out.get("push") or {}
    ios = out.get("ring_ios") or {}
    return {"ok": True, "kind": kind, "room": room if kind == "huddle" else "",
            "phones_rang": ring.get("delivered", 0) + ios.get("delivered", 0), "pushed": push.get("delivered", 0),
            **({"only": only} if only else {})}


def ring_people(caller_sub: str) -> list[dict]:
    """The ring list: everyone in the squad but the caller (and the App Store reviewer),
    by name, and whether a ring can reach them (a phone app or push set up). No ids of
    devices, no contact details."""
    import crcmz_identity
    import movies
    out = []
    for p in crcmz_identity.people():
        sub = p.get("zitadel_id") or ""
        if not sub or sub == caller_sub or movies.is_review(p):
            continue
        name = (p.get("display_name") or "").strip()
        if not name or "@" in name:
            name = (p.get("mm_username") or p.get("username") or "").split("@")[0]
        if not name:
            continue
        reach = fcm.device_count(sub) + webpush.device_count(sub)
        out.append({"id": sub, "name": name[:40], "reachable": reach > 0})
    out.sort(key=lambda x: (not x["reachable"], x["name"].lower()))
    return out


def wa_jid_for(person: dict) -> str:
    """A JID the bridge can DM: the phone tag first (it never changes), then wa_jid."""
    digits = re.sub(r"\D", "", person.get("wa_phone") or "")
    if 7 <= len(digits) <= 15:
        return f"{digits}@s.whatsapp.net"
    jid = re.sub(r":\d+@", "@", (person.get("wa_jid") or "").strip())
    return jid if re.fullmatch(r"\d{7,20}@(s\.whatsapp\.net|lid)", jid) else ""


def _direct(subs: list[str], exclude: str, text: str, url: str, tag: str, category: str = "") -> dict:
    import crcmz_identity
    people = crcmz_identity.by_zitadel_id()
    link = f"{PUBLIC_URL}{url}"
    sent = {"whatsapp": 0, "mattermost": 0, "quiet": 0, "off": 0}
    for sub in sorted(set(subs)):
        if not sub or sub == exclude or not (p := people.get(sub)):
            continue
        if category in DM_FOLLOWS_PUSH and not webpush.get_prefs(sub).get(category, True):
            sent["off"] += 1
            continue
        if not _dm_quiet.first(f"{sub}:{tag}"):
            sent["quiet"] += 1
            continue
        ch = get_channels(sub)
        msg = f"{text}\n{link}"
        who = p.get("username") or sub
        if ch["whatsapp"] and wa_send and (jid := wa_jid_for(p)):
            try:
                ok = bool(wa_send(jid, msg))
            except Exception as e:  # noqa: BLE001
                ok = False
                logger.warning("notifications: WhatsApp DM to %s failed: %s", who, e)
            sent["whatsapp"] += ok
            logger.info("notifications: WhatsApp DM to %s %s", who, "sent" if ok else "not sent")
        # The tag first; the email finds them when the tag is missing or wrong.
        if ch["mattermost"] and mm_dm and (p.get("mm_username") or p.get("email")):
            try:
                ok = bool(mm_dm(p.get("mm_username") or "", msg, email=p.get("email") or ""))
            except Exception as e:  # noqa: BLE001
                ok = False
                logger.warning("notifications: Mattermost DM to %s failed: %s", who, e)
            sent["mattermost"] += ok
            logger.info("notifications: Mattermost DM to %s %s", who, "sent" if ok else "not sent")
    return sent


def reachable(person: dict) -> dict[str, bool]:
    """Which DM channels can find this person at all (for settings and the test button)."""
    return {"whatsapp": bool(wa_jid_for(person)), "mattermost": bool(person.get("mm_username") or person.get("email"))}


def test_dm(sub: str) -> dict:
    """Send the caller a test DM on each channel they have switched on. Bypasses the quiet window."""
    import crcmz_identity
    p = crcmz_identity.by_zitadel_id().get(sub)
    if not p:
        return {"whatsapp": None, "mattermost": None}
    ch = get_channels(sub)
    msg = f"🔔 Test from CRCMZ: this is how @mentions and new movies reach you.\n{PUBLIC_URL}/app/notifications"
    out: dict[str, bool | None] = {}
    if not ch["whatsapp"] or not wa_send or not (jid := wa_jid_for(p)):
        out["whatsapp"] = None
    else:
        try:
            out["whatsapp"] = bool(wa_send(jid, msg))
        except Exception as e:  # noqa: BLE001
            logger.warning("notifications: test WhatsApp DM failed: %s", e)
            out["whatsapp"] = False
    if not ch["mattermost"] or not mm_dm or not (p.get("mm_username") or p.get("email")):
        out["mattermost"] = None
    else:
        try:
            out["mattermost"] = bool(mm_dm(p.get("mm_username") or "", msg, email=p.get("email") or ""))
        except Exception as e:  # noqa: BLE001
            logger.warning("notifications: test Mattermost DM failed: %s", e)
            out["mattermost"] = False
    return out


# ── Reading (the inbox) ──────────────────────────────────────────────────────
def _cursor(db: sqlite3.Connection, sub: str) -> int:
    row = db.execute("SELECT item_id FROM cursors WHERE sub=?", (sub,)).fetchone()
    return row["item_id"] if row else 0


_MINE = "(audience='*' OR audience=?) AND actor_sub != ?"


def inbox(sub: str, *, limit: int = 50, before: int | None = None, source: str = "") -> dict:
    """This person's alerts, newest first, each marked read or not."""
    limit = max(1, min(int(limit or 50), 100))
    q = f"SELECT * FROM items WHERE {_MINE}"
    args: list = [sub, sub]
    if before:
        q += " AND id < ?"
        args.append(int(before))
    if source:
        q += " AND source = ?"
        args.append(source)
    q += " ORDER BY id DESC LIMIT ?"
    args.append(limit + 1)
    with _conn() as db:
        rows = db.execute(q, args).fetchall()
        cur = _cursor(db, sub)
        opened = {r["item_id"] for r in db.execute("SELECT item_id FROM reads WHERE sub=?", (sub,))}
    items = [{
        "id": r["id"], "at": int(r["ts"] * 1000), "category": r["category"], "source": r["source"],
        "title": r["title"], "body": r["body"], "url": r["url"], "personal": r["audience"] != "*",
        "read": r["id"] <= cur or r["id"] in opened,
    } for r in rows[:limit]]
    return {"items": items, "more": len(rows) > limit, "unread": unread_count(sub)}


def unread_count(sub: str) -> int:
    with _conn() as db:
        cur = _cursor(db, sub)
        return db.execute(
            f"SELECT COUNT(*) FROM items WHERE {_MINE} AND id > ? "
            "AND id NOT IN (SELECT item_id FROM reads WHERE sub=?)", (sub, sub, cur, sub)).fetchone()[0]


def mark_read(sub: str, ids: list[int] | None = None) -> int:
    """Mark these alerts read, or all of them (``ids`` None). Returns the unread count."""
    with _lock, _conn() as db:
        if ids is None:
            top = db.execute(f"SELECT MAX(id) FROM items WHERE {_MINE}", (sub, sub)).fetchone()[0] or 0
            db.execute("INSERT INTO cursors(sub, item_id) VALUES (?,?) ON CONFLICT(sub) DO UPDATE SET "
                       "item_id=MAX(item_id, excluded.item_id)", (sub, top))
            db.execute("DELETE FROM reads WHERE sub=? AND item_id <= ?", (sub, top))
        else:
            for i in ids[:200]:
                if isinstance(i, int) and not isinstance(i, bool):
                    db.execute("INSERT OR IGNORE INTO reads(sub, item_id) SELECT ?, id FROM items "
                               f"WHERE id=? AND {_MINE}", (sub, i, sub, sub))
    return unread_count(sub)


# ── Channel switches ─────────────────────────────────────────────────────────
def get_channels(sub: str) -> dict[str, bool]:
    with _conn() as db:
        row = db.execute("SELECT json FROM channels WHERE sub=?", (sub,)).fetchone()
    saved = json.loads(row["json"]) if row else {}
    return {k: bool(saved.get(k, True)) for k in CHANNELS}


def save_channels(sub: str, changes: dict) -> dict[str, bool]:
    ch = get_channels(sub)
    for k, v in (changes or {}).items():
        if k in CHANNELS:
            ch[k] = bool(v)
    with _lock, _conn() as db:
        db.execute("INSERT INTO channels(sub, json) VALUES (?,?) ON CONFLICT(sub) DO UPDATE SET json=excluded.json",
                   (sub, json.dumps(ch)))
    return ch


# ── Read side (assistant tool) ───────────────────────────────────────────────
def overview(person: str = "", limit: int = 20) -> dict:
    """Recent alerts across the app, or one person's inbox. No ids, no contact details."""
    limit = max(1, min(int(limit or 20), 100))
    if person:
        import crcmz_identity
        p = crcmz_identity.resolve(person)
        if not p:
            return {"error": f"no one called {person!r} in the identity graph"}
        box = inbox(p["zitadel_id"], limit=limit)
        return {"person": p.get("display_name") or p.get("username"), "unread": box["unread"],
                "channels": get_channels(p["zitadel_id"]),
                "items": [{k: v for k, v in i.items() if k != "id"} for i in box["items"]]}
    with _conn() as db:
        rows = db.execute("SELECT * FROM items ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return {"recent": [{
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"])), "category": r["category"],
        "title": r["title"], "body": r["body"],
        "to": "everyone" if r["audience"] == "*" else webpush._name(r["audience"]),
    } for r in rows], "categories": SOURCES, "channels": CHANNELS}
