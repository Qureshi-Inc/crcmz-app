"""WatchParty semantic events store.

Stores meaningful human-readable WatchParty events: user feedback,
playback problems, WebRTC/ICE errors, room descriptions, feature notices.
NOT participant counts, durations, room state, or current playback position —
those remain structured DB queries.

DB: /data/watchparty_events.db
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/watchparty_events.db")
_lock = threading.Lock()

VALID_EVENT_TYPES = {
    "comment", "feedback", "playback_error", "screen_share_failure",
    "webrtc_error", "room_description", "feature_notice",
    "identity_decision", "sync_issue", "incident",
}


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS watchparty_events (
                event_id      TEXT PRIMARY KEY,
                room_id       TEXT,
                user_id       TEXT,
                event_type    TEXT NOT NULL,
                text          TEXT NOT NULL,
                created_at    REAL NOT NULL,
                session_ref   TEXT,
                metadata_json TEXT,
                content_hash  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_wp_events_room
                ON watchparty_events(room_id, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_wp_events_hash
                ON watchparty_events(content_hash);
        """)
        db.commit()
    logger.info("watchparty_events: DB ready at %s", _DB_PATH)


def record(
    event_type: str,
    text: str,
    room_id: str | None = None,
    user_id: str | None = None,
    session_ref: str | None = None,
    metadata: dict | None = None,
) -> str | None:
    """Record a semantic WatchParty event.  Returns event_id, or None if duplicate."""
    content_hash = hashlib.sha256(f"{event_type}|{text}".encode()).hexdigest()
    with _lock, _conn() as db:
        existing = db.execute(
            "SELECT event_id FROM watchparty_events WHERE content_hash = ?",
            (content_hash,),
        ).fetchone()
        if existing:
            return None
        event_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO watchparty_events
               (event_id, room_id, user_id, event_type, text, created_at,
                session_ref, metadata_json, content_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event_id,
                room_id,
                user_id,
                event_type,
                text,
                time.time(),
                session_ref,
                json.dumps(metadata) if metadata else None,
                content_hash,
            ),
        )
        db.commit()
    return event_id


def list_events(
    limit: int = 20,
    event_type: str | None = None,
    room_id: str | None = None,
    since_ts: float | None = None,
) -> list[dict]:
    limit = max(1, min(int(limit or 20), 500))
    sql = "SELECT * FROM watchparty_events WHERE 1=1"
    params: list = []
    if event_type:
        sql += " AND event_type = ?"
        params.append(event_type)
    if room_id:
        sql += " AND room_id = ?"
        params.append(room_id)
    if since_ts:
        sql += " AND created_at > ?"
        params.append(since_ts)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    with _lock, _conn() as db:
        rows = db.execute(sql, params).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("metadata_json"):
            try:
                d["metadata"] = json.loads(d["metadata_json"])
            except Exception:  # noqa: BLE001
                pass
        out.append(d)
    return out


def get(event_id: str) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT * FROM watchparty_events WHERE event_id = ?", (event_id,)
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    if d.get("metadata_json"):
        try:
            d["metadata"] = json.loads(d["metadata_json"])
        except Exception:  # noqa: BLE001
            pass
    return d


def count() -> int:
    with _lock, _conn() as db:
        return db.execute("SELECT COUNT(*) n FROM watchparty_events").fetchone()["n"]


def scan_existing_data() -> dict:
    """Inspect /data/watch/ for any historically persisted semantic content.

    Returns a dict describing what was found (without auto-inserting anything).
    Callers decide whether to record() what's found.
    """
    watch_dir = Path("/data/watch")
    if not watch_dir.exists() or not watch_dir.is_dir():
        return {"found": False, "reason": "no persistent watch data found"}

    files = list(watch_dir.iterdir())
    if not files:
        return {"found": False, "reason": "watch directory exists but is empty"}

    findings: list[dict] = []
    skipped: list[str] = []

    for f in sorted(files):
        if f.name.startswith("."):
            continue
        if f.suffix not in (".json", ".log", ".txt", ".md"):
            skipped.append(f.name)
            continue
        try:
            content = f.read_text(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            skipped.append(f.name)
            continue

        if f.suffix == ".json":
            try:
                data = json.loads(content)
            except Exception:  # noqa: BLE001
                skipped.append(f.name)
                continue
            # Identify meaningful fields — skip pure state/keys/counters
            if isinstance(data, dict):
                # nicknames.json, room state, signing keys — not indexable
                has_credentials = any(k in data for k in (
                    "key", "secret", "token", "password", "privateKey",
                ))
                if has_credentials:
                    skipped.append(f"{f.name} (credentials/keys — skip)")
                    continue
                # Look for any string values longer than 30 chars (possible descriptions)
                interesting = {k: v for k, v in data.items()
                               if isinstance(v, str) and len(v) > 30}
                if interesting:
                    findings.append({
                        "file": f.name,
                        "type": "json_fields",
                        "fields": list(interesting.keys()),
                        "preview": {k: v[:80] for k, v in list(interesting.items())[:3]},
                    })
                else:
                    skipped.append(f"{f.name} (no meaningful text content)")
            else:
                skipped.append(f"{f.name} (non-dict JSON)")
        else:
            # log/txt/md — scan for non-trivial lines
            lines = [l.strip() for l in content.splitlines()
                     if len(l.strip()) > 40 and not l.strip().startswith("#")]
            if lines:
                findings.append({
                    "file": f.name,
                    "type": "text",
                    "line_count": len(lines),
                    "sample": lines[:3],
                })
            else:
                skipped.append(f.name)

    if not findings:
        return {
            "found": False,
            "reason": "watch directory has files but none contain indexable semantic content",
            "files_checked": [f.name for f in files],
            "skipped": skipped,
        }

    return {
        "found": True,
        "findings": findings,
        "skipped": skipped,
        "note": "call watchparty_events.record() to persist any of the above",
    }
