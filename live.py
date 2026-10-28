"""Live Activities (iPhone) and Live Updates (Android): what the squad is doing right now,
on the lock screen, for whoever switches it on.

Four kinds, each one live item with a stable key:
    watch:<room>      a Watch Party: the film, who's watching, how far in
    huddle:<room>     a Huddle: who's in it, for how long
    slap:together     Slap's Listen Together: the song, who's listening, how far in
    tourney:<id>      a tournament: matches played of all

server.py builds the snapshot every LOOP_S seconds (it has the call server, Slap and the
tournaments) and hands it to tick(), which compares it with the last one and sends
start / update / end:
    Android  an FCM data message {type: "live", …} to the person's "android-app" phones;
             the app shows it as an ongoing notification (Live Update on Android 16).
    iPhone   an APNs Live Activity push. A "push-to-start" token (iOS 17.2+, one per phone,
             the app hands it over) starts one with the app closed; the activity's own
             token (also handed over) carries its updates and its end.

Off by default: a person opts in (all of it, then per kind) in Settings. Updates are
throttled: a change that matters (who's there, what's on, paused) goes at once, progress
alone at most every PROGRESS_S, so Apple's update budget isn't spent on a moving bar.
DB: /data/live.db
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/live.db")
_lock = threading.Lock()
_ready = False

KINDS = ("watch", "huddle", "slap", "tourney")
KIND_LABELS = {"watch": "Watch Party", "huddle": "Huddle", "slap": "Slap · Listen Together", "tourney": "Tournaments"}
LOOP_S = 20
PROGRESS_S = 60
STALE_S = 15 * 60          # an iPhone shows an activity we stopped updating as stale after this
ATTRIBUTES_TYPE = "CRCMZLiveAttributes"   # the Swift ActivityAttributes type name (ios/Shared)


def _conn() -> sqlite3.Connection:
    global _ready
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    if not _ready:
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        c.executescript("""
            CREATE TABLE IF NOT EXISTS prefs (sub TEXT PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ios_start (token TEXT PRIMARY KEY, sub TEXT NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS ios_activity (token TEXT PRIMARY KEY, sub TEXT NOT NULL, key TEXT NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS shown (key TEXT PRIMARY KEY, item TEXT NOT NULL, started REAL NOT NULL);
        """)
        _ready = True
    return c


# ── Who wants it ────────────────────────────────────────────────────────────
def get_prefs(sub: str) -> dict:
    with _conn() as db:
        row = db.execute("SELECT json FROM prefs WHERE sub=?", (sub,)).fetchone()
    saved = json.loads(row["json"]) if row else {}
    return {"on": bool(saved.get("on", False)), **{k: bool(saved.get(k, True)) for k in KINDS}}


def save_prefs(sub: str, changes: dict) -> dict:
    p = get_prefs(sub)
    before = dict(p)
    for k, v in (changes or {}).items():
        if k == "on" or k in KINDS:
            p[k] = bool(v)
    with _lock, _conn() as db:
        db.execute("INSERT INTO prefs(sub, json) VALUES (?,?) ON CONFLICT(sub) DO UPDATE SET json=excluded.json",
                   (sub, json.dumps(p)))
    # Switched something off: take what's showing for it off this person's phones now.
    # Switched it on: show what's already going on, rather than waiting for its next change.
    _load()
    for key, item in _last.items():
        if not wants(p, item["kind"]):
            _end_for(sub, key, item)
        elif not wants(before, item["kind"]):
            _start_for(sub, item)
    return p


def wants(p: dict, kind: str) -> bool:
    return bool(p.get("on")) and bool(p.get(kind, True))


def _opted_in(kind: str) -> set[str]:
    with _conn() as db:
        rows = db.execute("SELECT sub, json FROM prefs").fetchall()
    out = set()
    for r in rows:
        p = json.loads(r["json"] or "{}")
        if p.get("on") and p.get(kind, True):
            out.add(r["sub"])
    return out


# ── iPhone tokens ───────────────────────────────────────────────────────────
def register_ios_start(sub: str, token: str) -> None:
    token = "".join(ch for ch in str(token or "") if ch in "0123456789abcdefABCDEF")[:200]
    if not token or not sub:
        return
    with _lock, _conn() as db:
        db.execute("INSERT INTO ios_start(token, sub, updated) VALUES (?,?,?) "
                   "ON CONFLICT(token) DO UPDATE SET sub=excluded.sub, updated=excluded.updated", (token, sub, time.time()))


def register_ios_activity(sub: str, key: str, token: str) -> None:
    token = "".join(ch for ch in str(token or "") if ch in "0123456789abcdefABCDEF")[:200]
    key = str(key or "")[:80]
    if not token or not sub or not key:
        return
    with _lock, _conn() as db:
        db.execute("INSERT INTO ios_activity(token, sub, key, updated) VALUES (?,?,?,?) "
                   "ON CONFLICT(token) DO UPDATE SET sub=excluded.sub, key=excluded.key, updated=excluded.updated",
                   (token, sub, key, time.time()))
    # It may have started from a push that's already out of date: bring it up to now.
    item = _last.get(key)
    if item is None:
        _ios_send(token, "end", {}, sub=sub)
    else:
        _ios_send(token, "update", item)


def forget_ios_activity(token: str) -> None:
    with _lock, _conn() as db:
        db.execute("DELETE FROM ios_activity WHERE token=?", (token,))


# ── The snapshot and what changed ───────────────────────────────────────────
_last: dict[str, dict] = {}
_sent_at: dict[str, float] = {}     # key -> when progress was last pushed
_loaded = False


def _load() -> None:
    """After a restart: what was showing, so what has ended since still gets its end."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    with _conn() as db:
        for r in db.execute("SELECT key, item FROM shown"):
            try:
                _last[r["key"]] = json.loads(r["item"])
            except ValueError:
                pass


def _save(items: dict[str, dict]) -> None:
    with _lock, _conn() as db:
        db.execute("DELETE FROM shown")
        db.executemany("INSERT INTO shown(key, item, started) VALUES (?,?,?)",
                       [(k, json.dumps(v), float(v.get("started") or 0)) for k, v in items.items()])


def _matters(a: dict, b: dict) -> bool:
    keys = ("title", "subtitle", "count", "names", "paused", "progressLabel", "poster")
    return any(a.get(k) != b.get(k) for k in keys)


def tick(items: list[dict]) -> dict:
    """One pass: items are this moment's live sessions. Returns what was sent (for logs/tests)."""
    _load()
    now = time.time()
    cur = {}
    for it in items:
        key = str(it.get("key") or "")
        if not key or it.get("kind") not in KINDS:
            continue
        prev = _last.get(key)
        it = {**it, "started": float((prev or {}).get("started") or it.get("started") or now)}
        cur[key] = it
    out = {"start": [], "update": [], "end": []}
    for key, it in cur.items():
        prev = _last.get(key)
        if prev is None:
            out["start"].append(key)
            _deliver("start", it)
            _sent_at[key] = now
        elif (big := _matters(prev, it)) or (abs(float(it.get("progress", -1)) - float(prev.get("progress", -1))) >= 0.01
                                             and now - _sent_at.get(key, 0) >= PROGRESS_S):
            out["update"].append(key)
            _deliver("update", it, urgent=big)
            _sent_at[key] = now
        else:
            it = {**it, "progress": prev.get("progress", it.get("progress"))}   # unchanged on phones
            cur[key] = it
    for key, prev in _last.items():
        if key not in cur:
            out["end"].append(key)
            _deliver("end", prev)
            _sent_at.pop(key, None)
    _last.clear()
    _last.update(cur)
    if out["start"] or out["end"] or out["update"]:
        _save(cur)
        logger.info("live: start=%s update=%s end=%s", out["start"], out["update"], out["end"])
    return out


def current() -> list[dict]:
    """What's live right now (the widgets show it)."""
    _load()
    return list(_last.values())


# ── Delivery ────────────────────────────────────────────────────────────────
def _state(it: dict) -> dict:
    """The Live Activity's content state: ios/Shared/LiveAttributes.swift decodes exactly this."""
    return {
        "title": str(it.get("title") or "")[:80], "subtitle": str(it.get("subtitle") or "")[:120],
        "count": int(it.get("count") or 0), "names": [str(n)[:24] for n in (it.get("names") or [])][:6],
        "started": float(it.get("started") or time.time()), "progress": float(it.get("progress", -1)),
        "progressLabel": str(it.get("progressLabel") or "")[:40], "paused": bool(it.get("paused")),
        "url": str(it.get("url") or "/app"),
    }


def _deliver(event: str, it: dict, urgent: bool = True) -> None:
    subs = _opted_in(it["kind"])
    if not subs:
        return
    threading.Thread(target=_deliver_now, args=(event, it, subs, urgent), name="live-push", daemon=True).start()


def _deliver_now(event: str, it: dict, subs: set[str], urgent: bool = True) -> None:
    try:
        _android(event, it, subs)
    except Exception:  # noqa: BLE001
        logger.exception("live: android delivery failed")
    try:
        _ios(event, it, subs, urgent)
    except Exception:  # noqa: BLE001
        logger.exception("live: iphone delivery failed")


def _end_for(sub: str, key: str, it: dict) -> None:
    threading.Thread(target=_deliver_now, args=("end", it, {sub}), name="live-push", daemon=True).start()


def _start_for(sub: str, it: dict) -> None:
    threading.Thread(target=_deliver_now, args=("start", it, {sub}), name="live-push", daemon=True).start()


def _android(event: str, it: dict, subs: set[str]) -> None:
    import fcm
    creds = fcm._credentials()
    if not creds:
        return
    with fcm._conn() as db:
        rows = [r for r in db.execute("SELECT sub, token FROM devices WHERE platform='android-app'") if r["sub"] in subs]
    s = _state(it)
    data = {"type": "live", "event": event, "key": it["key"], "kind": it["kind"], "title": s["title"], "body": s["subtitle"],
            "count": str(s["count"]), "names": ", ".join(s["names"]), "started": str(int(s["started"] * 1000)),
            "progress": f"{s['progress']:.4f}", "progressLabel": s["progressLabel"], "paused": "1" if s["paused"] else "0",
            "url": s["url"], "segments": json.dumps(it.get("segments") or []),
            # A Watch Party's own numbers (seconds), so the phone writes "23:00 / 1:53:00" and
            # "1h 30m left" itself; and the film's poster (a signed link) for the artwork.
            "elapsed": str(int(it.get("elapsed") or 0)), "duration": str(int(it.get("duration") or 0)),
            "poster": str(it.get("poster") or "")}
    for r in rows:
        status, err = fcm._send_one(creds, r["token"], data)
        if fcm._gone(status, err):
            fcm.unregister(r["token"])


def _ios(event: str, it: dict, subs: set[str], urgent: bool = True) -> None:
    import apns
    if not apns.configured():
        return
    with _conn() as db:
        if event == "start":
            rows = [r for r in db.execute("SELECT token, sub FROM ios_start") if r["sub"] in subs]
        else:
            rows = [r for r in db.execute("SELECT token, sub FROM ios_activity WHERE key=?", (it["key"],)) if r["sub"] in subs]
    for r in rows:
        _ios_send(r["token"], event, it, sub=r["sub"], start_token=event == "start", urgent=urgent)


def _ios_send(token: str, event: str, it: dict, *, sub: str = "", start_token: bool = False, urgent: bool = True) -> None:
    import apns
    now = int(time.time())
    aps: dict = {"timestamp": now, "event": event}
    if it:
        aps["content-state"] = _state(it)
    if event == "start":
        aps["attributes-type"] = ATTRIBUTES_TYPE
        aps["attributes"] = {"key": it["key"], "kind": it["kind"]}
        aps["alert"] = {"title": f"{KIND_LABELS[it['kind']]} is live", "body": str(it.get("title") or "")}
    if event in ("start", "update"):
        aps["stale-date"] = now + STALE_S
        aps["relevance-score"] = 100 if it.get("kind") == "watch" else 50
    if event == "end":
        aps["dismissal-date"] = now + 5
    # A moving progress bar is low priority (Apple budgets the high ones); anything else isn't.
    status, reason = apns.send_live(token, {"aps": aps}, priority=10 if urgent or event != "update" else 5)
    if status == 410 or reason in ("BadDeviceToken", "Unregistered", "ExpiredToken"):
        with _lock, _conn() as db:
            db.execute("DELETE FROM ios_start WHERE token=?", (token,)) if start_token else \
                db.execute("DELETE FROM ios_activity WHERE token=?", (token,))
