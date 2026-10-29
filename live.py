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
             token (also handed over) carries its updates and its end. An iPhone that
             can't show one (older iOS, Live Activities off) gets one ordinary
             notification per session instead.

The shared state (_state, both phones): session (key@start, one per party), title,
poster, count, people ("Moiz, Noor +1"), status (playing | paused | stale | ended),
elapsed / duration / rate as of `at` (the phones run their own clocks from these), rev
(newer wins), url, and per person: joined (you're in it: "Open party") and private
(no film or names on the lock screen).

Off by default: a person opts in (all of it, then per kind) in Settings. Updates are
throttled: a change that matters (who's there, what's on, paused, a seek) goes at once,
progress alone at most every PROGRESS_S, and every HEARTBEAT_S regardless, so a phone
that stops hearing (STALE_S) knows the data is old and stops calling it live.
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
HEARTBEAT_S = 10 * 60      # unchanged for this long: sent again anyway, so phones know it's current
STALE_S = 15 * 60          # a phone shows an activity we stopped updating as stale after this
ENDED_S = 5 * 60           # an ended session stays on the lock screen (as ended) this long
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
            CREATE TABLE IF NOT EXISTS hidden (sub TEXT NOT NULL, session TEXT NOT NULL, at REAL NOT NULL,
                                               PRIMARY KEY (sub, session));
        """)
        # Older databases: whether that iPhone has Live Activities switched on.
        try:
            c.execute("ALTER TABLE ios_start ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
        except sqlite3.OperationalError:
            pass
        _ready = True
    return c


# ── Who wants it ────────────────────────────────────────────────────────────
def get_prefs(sub: str) -> dict:
    with _conn() as db:
        row = db.execute("SELECT json FROM prefs WHERE sub=?", (sub,)).fetchone()
    saved = json.loads(row["json"]) if row else {}
    return {"on": bool(saved.get("on", False)), **{k: bool(saved.get(k, True)) for k in KINDS},
            "private": bool(saved.get("private", False))}


def save_prefs(sub: str, changes: dict) -> dict:
    p = get_prefs(sub)
    before = dict(p)
    for k, v in (changes or {}).items():
        if k in ("on", "private") or k in KINDS:
            p[k] = bool(v)
    with _lock, _conn() as db:
        db.execute("INSERT INTO prefs(sub, json) VALUES (?,?) ON CONFLICT(sub) DO UPDATE SET json=excluded.json",
                   (sub, json.dumps(p)))
    # Switched something off: take what's showing for it off this person's phones now.
    # Switched it on: show what's already going on, rather than waiting for its next change.
    # Privacy changed: redraw what's showing with (or without) the film and names.
    _load()
    for key, item in _last.items():
        if not wants(p, item["kind"]):
            _end_for(sub, key, item)
        elif not wants(before, item["kind"]):
            _start_for(sub, item)
        elif p["private"] != before["private"]:
            _send_for(sub, "update", item)
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


# ── Hide: this session off this person's lock screen ────────────────────────
def hide(sub: str, session: str) -> None:
    """Hide pressed on an iPhone. The phone ended its own activity; this keeps a push from
    starting it again for the rest of that session. Leaves the party alone."""
    session = str(session or "")[:120]
    if not sub or "@" not in session:
        return
    with _lock, _conn() as db:
        db.execute("INSERT OR REPLACE INTO hidden(sub, session, at) VALUES (?,?,?)", (sub, session, time.time()))
        db.execute("DELETE FROM hidden WHERE at < ?", (time.time() - 7 * 86400,))


def _hidden(sub: str, session: str) -> bool:
    with _conn() as db:
        return db.execute("SELECT 1 FROM hidden WHERE sub=? AND session=?", (sub, session)).fetchone() is not None


# ── iPhone tokens ───────────────────────────────────────────────────────────
def _hex(token) -> str:
    return "".join(ch for ch in str(token or "") if ch in "0123456789abcdefABCDEF")[:200]


def register_ios_start(sub: str, token: str, enabled: bool = True) -> None:
    token = _hex(token)
    if not token or not sub:
        return
    with _lock, _conn() as db:
        db.execute("INSERT INTO ios_start(token, sub, updated, enabled) VALUES (?,?,?,?) "
                   "ON CONFLICT(token) DO UPDATE SET sub=excluded.sub, updated=excluded.updated, enabled=excluded.enabled",
                   (token, sub, time.time(), int(bool(enabled))))


def set_ios_enabled(sub: str, enabled: bool, token: str = "") -> None:
    """The phone says whether Live Activities are on for the app (Settings › CRCMZ). Off:
    no push-to-start for it, and the ordinary notification takes over."""
    token = _hex(token)
    if token:
        register_ios_start(sub, token, enabled)
    elif sub:
        with _lock, _conn() as db:
            db.execute("UPDATE ios_start SET enabled=?, updated=? WHERE sub=?", (int(bool(enabled)), time.time(), sub))


def register_ios_activity(sub: str, key: str, token: str) -> None:
    token = _hex(token)
    key = str(key or "")[:80]
    if not token or not sub or not key:
        return
    with _lock, _conn() as db:
        db.execute("INSERT INTO ios_activity(token, sub, key, updated) VALUES (?,?,?,?) "
                   "ON CONFLICT(token) DO UPDATE SET sub=excluded.sub, key=excluded.key, updated=excluded.updated",
                   (token, sub, key, time.time()))
    # It may have started from a push that's already out of date: bring it up to now
    # (or end it: that session is over, or this person hid it).
    item = _last.get(key)
    if item is None or _hidden(sub, item.get("session", "")):
        _ios_send(token, "end", {}, sub=sub)
    else:
        _ios_send(token, "update", item, sub=sub)


def forget_ios_activity(token: str) -> None:
    with _lock, _conn() as db:
        db.execute("DELETE FROM ios_activity WHERE token=?", (token,))


# ── The snapshot and what changed ───────────────────────────────────────────
_last: dict[str, dict] = {}
_sent_at: dict[str, float] = {}     # key -> when it was last pushed
_loaded = False
_rev_last = 0


def _rev() -> int:
    """A revision for each push: newer is bigger, so a phone can drop one that arrives late."""
    global _rev_last
    _rev_last = max(int(time.time() * 1000), _rev_last + 1)
    return _rev_last


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
    # A new play / pause / seek stamp (anchor_*) is a seek or a pause: phones' clocks need it now.
    keys = ("title", "subtitle", "count", "names", "paused", "progressLabel", "poster", "status", "subs",
            "duration", "anchor_pos", "anchor_at")
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
        started = float((prev or {}).get("started") or it.get("started") or now)
        it = {**it, "started": started, "session": f"{key}@{int(started)}", "rev": (prev or {}).get("rev", 0)}
        cur[key] = it
    out = {"start": [], "update": [], "end": []}
    for key, it in cur.items():
        prev = _last.get(key)
        if prev is None:
            out["start"].append(key)
            it["rev"] = _rev()
            _deliver("start", it)
            _sent_at[key] = now
        elif ((big := _matters(prev, it))
              or (abs(float(it.get("progress", -1)) - float(prev.get("progress", -1))) >= 0.01 and now - _sent_at.get(key, 0) >= PROGRESS_S)
              or now - _sent_at.get(key, 0) >= HEARTBEAT_S):
            out["update"].append(key)
            it["rev"] = _rev()
            _deliver("update", it, urgent=big)
            _sent_at[key] = now
        else:
            it = {**it, "progress": prev.get("progress", it.get("progress"))}   # unchanged on phones
            cur[key] = it
    for key, prev in _last.items():
        if key not in cur:
            out["end"].append(key)
            _deliver("end", {**prev, "status": "ended", "rev": _rev()})
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
def _status(it: dict) -> str:
    s = str(it.get("status") or "")
    if s in ("playing", "paused", "stale", "ended"):
        return s
    return "paused" if it.get("paused") else "playing"


def _compact(n: int) -> str:
    """1238 -> 1.2K, 25000 -> 25K: a count that fits a lock screen line."""
    if n < 1000:
        return str(n)
    if n < 10_000:
        return f"{n / 1000:.1f}".rstrip("0").rstrip(".") + "K"
    return f"{n // 1000}K"


def _people(names: list[str], count: int) -> str:
    """"Moiz, Noor +1": up to two names, then how many more of the count."""
    shown = [n for n in names if n][:2]
    more = max(0, count - len(shown))
    return ", ".join(shown) + (f" +{_compact(more)}" if shown and more else "")


def _state(it: dict, sub: str = "") -> dict:
    """The shared state both phones draw from: ios/Shared/LiveAttributes.swift decodes
    exactly this (the first block is what builds before 20 read: keep it), Android gets
    the same as strings (_android). `sub`: whose phone, for joined and private."""
    kind = it.get("kind") or ""
    status = _status(it)
    count = int(it.get("count") or 0)
    names = [str(n)[:24] for n in (it.get("names") or [])][:6]
    private = bool(sub) and get_prefs(sub).get("private", False)
    title = str(it.get("title") or "")[:80]
    subtitle = str(it.get("subtitle") or "")[:120]
    poster = str(it.get("poster") or "")[:400]
    if private:
        # Nothing that says what's on or who's there: the kind and the head count.
        title, names, poster = KIND_LABELS.get(kind, "Live").split(" · ")[0], [], ""
        subtitle = f"{count} watching" if kind == "watch" else (f"{count} there" if count else "")
    return {
        "title": title, "subtitle": subtitle, "count": count, "names": names,
        "started": float(it.get("started") or time.time()), "progress": float(it.get("progress", -1)),
        "progressLabel": str(it.get("progressLabel") or "")[:40],
        # Builds before 20 only know paused: reconnecting or ended mustn't look like it's playing.
        "paused": bool(it.get("paused")) or status in ("stale", "ended"),
        "url": str(it.get("url") or "/app"),
        # A Watch Party's film, in seconds, as of `at`, at `rate`: the phones run the clock
        # and bar themselves. The poster is a signed link.
        "elapsed": int(it.get("elapsed") or 0), "duration": int(it.get("duration") or 0),
        "at": float(it.get("pos_at") or time.time()), "poster": poster,
        "session": str(it.get("session") or it.get("key") or ""), "status": status,
        "rate": float(it.get("rate") or 1.0), "rev": int(it.get("rev") or 0),
        "people": _people(names, count), "joined": bool(sub) and sub in (it.get("subs") or []),
        "private": private,
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
    # Switched off, not over: it goes at once (`gone`) instead of staying up as ended.
    threading.Thread(target=_deliver_now, args=("end", {**it, "status": "ended", "gone": True, "rev": _rev()}, {sub}),
                     name="live-push", daemon=True).start()


def _start_for(sub: str, it: dict) -> None:
    threading.Thread(target=_deliver_now, args=("start", it, {sub}), name="live-push", daemon=True).start()


def _send_for(sub: str, event: str, it: dict) -> None:
    threading.Thread(target=_deliver_now, args=(event, {**it, "rev": _rev()}, {sub}), name="live-push", daemon=True).start()


def _android_data(event: str, it: dict, sub: str) -> dict:
    """The FCM data message: every value a string. The first block is what 2.0.19 reads."""
    s = _state(it, sub)
    return {"type": "live", "event": event, "key": it["key"], "kind": it["kind"], "title": s["title"], "body": s["subtitle"],
            "count": str(s["count"]), "names": ", ".join(s["names"]), "started": str(int(s["started"] * 1000)),
            "progress": f"{s['progress']:.4f}", "progressLabel": s["progressLabel"], "paused": "1" if s["paused"] else "0",
            "url": s["url"], "segments": json.dumps(it.get("segments") or []),
            "elapsed": str(s["elapsed"]), "duration": str(s["duration"]), "poster": s["poster"],
            "session": s["session"], "status": s["status"], "rev": str(s["rev"]), "people": s["people"],
            "at": str(int(s["at"] * 1000)), "rate": f"{s['rate']:.2f}", "joined": "1" if s["joined"] else "0",
            "private": "1" if s["private"] else "0", "stale": str(STALE_S), "keep": "0" if it.get("gone") else str(ENDED_S)}


def _android(event: str, it: dict, subs: set[str]) -> None:
    import fcm
    creds = fcm._credentials()
    if not creds:
        return
    with fcm._conn() as db:
        rows = [r for r in db.execute("SELECT sub, token FROM devices WHERE platform='android-app'") if r["sub"] in subs]
    for r in rows:
        status, err = fcm._send_one(creds, r["token"], _android_data(event, it, r["sub"]))
        if fcm._gone(status, err):
            fcm.unregister(r["token"])


def _ios(event: str, it: dict, subs: set[str], urgent: bool = True) -> None:
    import apns
    if not apns.configured():
        return
    session = it.get("session", "")
    with _conn() as db:
        if event == "start":
            rows = [r for r in db.execute("SELECT token, sub FROM ios_start WHERE enabled != 0") if r["sub"] in subs]
        else:
            rows = [r for r in db.execute("SELECT token, sub FROM ios_activity WHERE key=?", (it["key"],)) if r["sub"] in subs]
    rows = [r for r in rows if event == "end" or not _hidden(r["sub"], session)]
    for r in rows:
        _ios_send(r["token"], event, it, sub=r["sub"], start_token=event == "start", urgent=urgent)
    if event == "start":
        _ios_fallback(it, subs - {r["sub"] for r in rows})


def _ios_fallback(it: dict, subs: set[str]) -> None:
    """People whose iPhones can't show a Live Activity (iOS before 17.2 can't start one by
    push; Live Activities switched off; a build before 17): one ordinary notification for
    the session instead. Its collapse id is the session, so it's replaced, never repeated.
    Straight to apns (not notifications.route): it stands in for the Live Activity on
    iPhones only, it isn't an inbox, Web Push or Android alert."""
    import apns
    with _conn() as db:
        capable = {r["sub"] for r in db.execute("SELECT sub FROM ios_start WHERE enabled != 0")}
    for sub in sorted(s for s in subs if s not in capable and not _hidden(s, it.get("session", ""))):
        s = _state(it, sub)
        label = KIND_LABELS.get(it["kind"], "Live").split(" · ")[0]
        who = f"{s['count']} watching" if it["kind"] == "watch" else s["subtitle"]
        body = who if s["private"] else " · ".join(x for x in (s["title"], who) if x)
        apns.alert("live", f"{label} is live", body, s["url"], only=[sub], tag=s["session"], quiet=True)


def _ios_send(token: str, event: str, it: dict, *, sub: str = "", start_token: bool = False, urgent: bool = True) -> None:
    import apns
    now = int(time.time())
    aps: dict = {"timestamp": now, "event": event}
    if it:
        aps["content-state"] = _state(it, sub)
    if event == "start":
        s = aps["content-state"]
        aps["attributes-type"] = ATTRIBUTES_TYPE
        aps["attributes"] = {"key": it["key"], "kind": it["kind"]}
        aps["alert"] = {"title": f"{KIND_LABELS[it['kind']]} is live", "body": "" if s["private"] else s["title"]}
    if event in ("start", "update"):
        aps["stale-date"] = now + STALE_S
        aps["relevance-score"] = 100 if it.get("kind") == "watch" else 50
    if event == "end":
        # Ended stays up a few minutes, so "it's over" is what you see, then goes.
        aps["dismissal-date"] = now + (ENDED_S if it and not it.get("gone") else 5)
    # A moving progress bar is low priority (Apple budgets the high ones); anything else isn't.
    status, reason = apns.send_live(token, {"aps": aps}, priority=10 if urgent or event != "update" else 5)
    if status == 410 or reason in ("BadDeviceToken", "Unregistered", "ExpiredToken"):
        with _lock, _conn() as db:
            db.execute("DELETE FROM ios_start WHERE token=?", (token,)) if start_token else \
                db.execute("DELETE FROM ios_activity WHERE token=?", (token,))
