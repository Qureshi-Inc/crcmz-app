"""Watch Party client diagnostics: what each viewer's page saw, as it happened.

Every browser in the Watch tab keeps a small ring of events — socket connects
and drops, play/pause/seek sent and received, video changes, camera/peer
connection states, autoplay blocks, JS errors, plus a heartbeat snapshot — and
ships them here in batches. The point is to reconstruct "the video paused on
one person" or "cams went black" after the fact.

Semantic, human-written events still belong in ``watchparty_events``; this is
the raw timeline.

DB: /data/watch_diag.db   (rows older than RETAIN_DAYS are pruned)
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/watch_diag.db")
_lock = threading.Lock()

RETAIN_DAYS = 14
MAX_BATCH = 200
_MAX_DATA = 2000
_LEVELS = {"debug", "info", "warn", "error"}
_last_prune = 0.0


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS watch_diag (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ts         REAL NOT NULL,      -- client time (epoch s)
                received   REAL NOT NULL,      -- server time (epoch s)
                room       TEXT,
                user_id    TEXT,               -- Zitadel sub
                name       TEXT,
                client_id  TEXT,               -- WatchParty clientId (per tab)
                session    TEXT,               -- per page load
                level      TEXT NOT NULL,
                type       TEXT NOT NULL,
                data_json  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_wdiag_ts   ON watch_diag(ts);
            CREATE INDEX IF NOT EXISTS idx_wdiag_room ON watch_diag(room, ts);
            CREATE INDEX IF NOT EXISTS idx_wdiag_user ON watch_diag(user_id, ts);
        """)
        db.commit()
    logger.info("watch_diag: DB ready at %s", _DB_PATH)


def record_batch(*, user_id: str, name: str, room: str, client_id: str,
                 session: str, events: list) -> int:
    """Store a batch from one page. Returns how many rows were kept."""
    global _last_prune
    now = time.time()
    rows = []
    for ev in (events or [])[:MAX_BATCH]:
        if not isinstance(ev, dict):
            continue
        typ = str(ev.get("type") or "")[:48]
        if not typ:
            continue
        level = str(ev.get("level") or "info")
        if level not in _LEVELS:
            level = "info"
        try:
            ts = float(ev.get("ts") or now)
        except (TypeError, ValueError):
            ts = now
        if abs(ts - now) > 86400:          # a wildly wrong client clock
            ts = now
        data = ev.get("data")
        data_json = json.dumps(data, separators=(",", ":"), default=str)[:_MAX_DATA] if data is not None else None
        rows.append((ts, now, room[:64], user_id, name[:64], client_id[:64],
                     session[:64], level, typ, data_json))
    if not rows:
        return 0
    with _lock, _conn() as db:
        db.executemany(
            """INSERT INTO watch_diag (ts, received, room, user_id, name, client_id,
                 session, level, type, data_json) VALUES (?,?,?,?,?,?,?,?,?,?)""",
            rows,
        )
        if now - _last_prune > 3600:
            db.execute("DELETE FROM watch_diag WHERE ts < ?", (now - RETAIN_DAYS * 86400,))
            _last_prune = now
        db.commit()
    return len(rows)


def list_events(*, room: str | None = None, user_id: str | None = None,
                since_minutes: int = 60, until_ts: float | None = None,
                level: str | None = None, types: list[str] | None = None,
                limit: int = 200) -> list[dict]:
    """Timeline, oldest first, within the window. All filters optional."""
    limit = max(1, min(int(limit or 200), 1000))
    since_minutes = max(1, min(int(since_minutes or 60), RETAIN_DAYS * 1440))
    end = float(until_ts) if until_ts else time.time()
    where, args = ["ts >= ?", "ts <= ?"], [end - since_minutes * 60, end]
    if room:
        where.append("room = ?")
        args.append(room)
    if user_id:
        where.append("user_id = ?")
        args.append(user_id)
    if level == "warn":
        where.append("level IN ('warn','error')")
    elif level in _LEVELS:
        where.append("level = ?")
        args.append(level)
    if types:
        where.append("type IN (%s)" % ",".join("?" * len(types)))
        args.extend(types)
    with _lock, _conn() as db:
        rows = db.execute(
            f"""SELECT ts, room, name, client_id, session, level, type, data_json
                FROM watch_diag WHERE {' AND '.join(where)}
                ORDER BY ts DESC LIMIT ?""",
            (*args, limit),
        ).fetchall()
    out = []
    for r in reversed(rows):
        try:
            data = json.loads(r["data_json"]) if r["data_json"] else None
        except ValueError:
            data = r["data_json"]
        out.append({
            "ts": r["ts"],
            "at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(r["ts"])) + "Z",
            "room": r["room"], "name": r["name"], "client": (r["client_id"] or "")[:8],
            "session": (r["session"] or "")[:8], "level": r["level"],
            "type": r["type"], "data": data,
        })
    return out


def summary(*, room: str | None = None, since_minutes: int = 60) -> dict:
    """Counts by type and level, and who reported, for a quick health read."""
    since_minutes = max(1, min(int(since_minutes or 60), RETAIN_DAYS * 1440))
    where, args = ["ts >= ?"], [time.time() - since_minutes * 60]
    if room:
        where.append("room = ?")
        args.append(room)
    w = " AND ".join(where)
    with _lock, _conn() as db:
        by_type = db.execute(
            f"SELECT type, level, COUNT(*) n FROM watch_diag WHERE {w} "
            "GROUP BY type, level ORDER BY n DESC LIMIT 60", args).fetchall()
        people = db.execute(
            f"SELECT name, COUNT(DISTINCT session) sessions, COUNT(*) n, MAX(ts) last "
            f"FROM watch_diag WHERE {w} GROUP BY name ORDER BY last DESC LIMIT 30", args).fetchall()
    return {
        "since_minutes": since_minutes,
        "by_type": [dict(r) for r in by_type],
        "reporters": [dict(r) for r in people],
    }
