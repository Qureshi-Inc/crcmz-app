"""Stream analysis plumbing: an on/off switch, a sample log, and Muse's analysis records.

The MacBook proxy that sees the PS5 stream posts samples (frames, chat, game events)
only while the streamer's switch is on; off means nothing is accepted or stored.
Muse reads the samples and writes analysis records back. Nothing here analyses
anything.

DB: /data/stream_analysis.db
  state          one row per person (Zitadel id): analysis on/off
  samples        append-only log; rows are never updated or deleted
  sample_media   frame bytes, kept apart so listing samples never loads images
  analysis       Muse's records: moments (append) and one summary per session
"""

from __future__ import annotations

import base64
import binascii
import collections
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

_DB_PATH = Path(os.environ.get("STREAM_ANALYSIS_DB", "/data/stream_analysis.db"))
_lock = threading.Lock()

SAMPLE_TYPES = ("frame", "chat", "event")
RECORD_KINDS = ("moment", "summary")
MAX_IMAGE_BYTES = 1_500_000
MAX_TEXT_CHARS = 4000
MAX_EVENT_BYTES = 16_384
MAX_FIELD_CHARS = 2000
MAX_ROAST_CHARS = 280
RATE_LIMIT = 120          # accepted samples per person per window
RATE_WINDOW = 60.0
_SESSION_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_MAGIC = ((b"\xff\xd8\xff", "image/jpeg"), (b"\x89PNG\r\n\x1a\n", "image/png"))

_hits: dict[str, collections.deque] = {}
_hits_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS state (
                user_sub   TEXT PRIMARY KEY,
                enabled    INTEGER NOT NULL DEFAULT 0,
                updated_at REAL,
                updated_by TEXT
            );
            CREATE TABLE IF NOT EXISTS samples (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_sub    TEXT NOT NULL,
                session_id  TEXT NOT NULL,
                ts          REAL NOT NULL,
                type        TEXT NOT NULL,
                text        TEXT,
                event_json  TEXT,
                mime        TEXT,
                bytes       INTEGER,
                received_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS samples_session ON samples(session_id, id);
            CREATE TABLE IF NOT EXISTS sample_media (
                sample_id INTEGER PRIMARY KEY,
                data      BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analysis (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                user_sub           TEXT NOT NULL,
                session_id         TEXT NOT NULL,
                kind               TEXT NOT NULL,
                at                 REAL,
                good               TEXT,
                bad                TEXT,
                next_time          TEXT,
                funny_death_roast  TEXT,
                roast_subject_sub  TEXT,
                roast_subject_name TEXT,
                note               TEXT,
                upto_sample_id     INTEGER,
                author             TEXT,
                created_at         REAL NOT NULL,
                updated_at         REAL
            );
            CREATE INDEX IF NOT EXISTS analysis_session ON analysis(session_id, id);
            CREATE TRIGGER IF NOT EXISTS samples_no_update BEFORE UPDATE ON samples
                BEGIN SELECT RAISE(ABORT, 'samples are append-only'); END;
            CREATE TRIGGER IF NOT EXISTS samples_no_delete BEFORE DELETE ON samples
                BEGIN SELECT RAISE(ABORT, 'samples are append-only'); END;
        """)


# ── Switch ───────────────────────────────────────────────────────────────────

def status(user_sub: str) -> dict:
    with _conn() as db:
        row = db.execute("SELECT enabled, updated_at FROM state WHERE user_sub=?",
                         (user_sub,)).fetchone()
    return {"enabled": bool(row and row["enabled"]),
            "updated_at": row["updated_at"] if row else None}


def statuses() -> list[dict]:
    with _conn() as db:
        rows = db.execute("SELECT user_sub, enabled, updated_at FROM state "
                          "ORDER BY updated_at DESC").fetchall()
    return [{"user_sub": r["user_sub"], "enabled": bool(r["enabled"]),
             "updated_at": r["updated_at"]} for r in rows]


def set_enabled(user_sub: str, enabled: bool | None, by: str = "") -> dict:
    """Set the switch; enabled=None flips it. Returns the new state."""
    now = time.time()
    with _lock, _conn() as db:
        row = db.execute("SELECT enabled FROM state WHERE user_sub=?", (user_sub,)).fetchone()
        new = (not (row and row["enabled"])) if enabled is None else bool(enabled)
        db.execute("INSERT INTO state(user_sub, enabled, updated_at, updated_by) VALUES (?,?,?,?) "
                   "ON CONFLICT(user_sub) DO UPDATE SET enabled=excluded.enabled, "
                   "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                   (user_sub, int(new), now, by[:64]))
    return {"enabled": new, "updated_at": now}


# ── Samples ──────────────────────────────────────────────────────────────────

def parse_ts(value) -> float | None:
    """Epoch seconds (or ms) or ISO 8601 *with* a timezone. None when invalid."""
    if isinstance(value, bool) or value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        v = v / 1000 if v > 1e12 else v
        return v if v > 0 else None
    s = str(value).strip()
    try:
        return parse_ts(float(s))
    except ValueError:
        pass
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        return None
    return dt.timestamp() if dt.tzinfo is not None else None


def _within_rate(user_sub: str) -> bool:
    now = time.monotonic()
    with _hits_lock:
        q = _hits.setdefault(user_sub, collections.deque())
        while q and now - q[0] >= RATE_WINDOW:
            q.popleft()
        if len(q) >= RATE_LIMIT:
            return False
        q.append(now)
        return True


def _decode_image(image_base64: str, mime: str) -> tuple[bytes, str] | str:
    s = (image_base64 or "").strip()
    if s.startswith("data:") and "," in s:
        s = s.split(",", 1)[1]
    if len(s) > (MAX_IMAGE_BYTES * 4) // 3 + 8:
        return f"image is over {MAX_IMAGE_BYTES} bytes"
    try:
        data = base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        return "image_base64 is not valid base64"
    if not data:
        return "image is empty"
    if len(data) > MAX_IMAGE_BYTES:
        return f"image is over {MAX_IMAGE_BYTES} bytes"
    real = next((m for magic, m in _MAGIC if data.startswith(magic)), None)
    if not real:
        return "image must be JPEG or PNG"
    claimed = (mime or "").strip().lower().replace("image/jpg", "image/jpeg")
    if claimed and claimed != real:
        return f"mime says {claimed} but the bytes are {real}"
    return data, real


def add_sample(user_sub: str, session_id: str, type: str, timestamp,  # noqa: A002
               image_base64: str = "", mime: str = "", text: str = "",
               event=None) -> dict:
    """Store one sample if this person's analysis is on. Never stores anything when off."""
    if not status(user_sub)["enabled"]:
        return {"ok": False, "error": "analysis is off", "enabled": False}
    session_id = (session_id or "").strip()
    if not _SESSION_RE.match(session_id):
        return {"ok": False, "error": "session_id must be 1-64 of A-Z a-z 0-9 . _ : -"}
    if type not in SAMPLE_TYPES:
        return {"ok": False, "error": f"type must be one of {', '.join(SAMPLE_TYPES)}"}
    ts = parse_ts(timestamp)
    if ts is None:
        return {"ok": False, "error": "timestamp must be epoch seconds or ISO 8601 with a timezone"}
    text = text or ""
    if len(text) > MAX_TEXT_CHARS:
        return {"ok": False, "error": f"text is over {MAX_TEXT_CHARS} characters"}

    data, real_mime, event_json = None, None, None
    if type == "frame":
        got = _decode_image(image_base64, mime)
        if isinstance(got, str):
            return {"ok": False, "error": got}
        data, real_mime = got
    elif type == "chat":
        if not text.strip():
            return {"ok": False, "error": "a chat sample needs text"}
    else:
        if isinstance(event, str):
            try:
                event = json.loads(event)
            except ValueError:
                return {"ok": False, "error": "event must be a JSON object"}
        if not isinstance(event, dict) or not event:
            return {"ok": False, "error": "an event sample needs an event object"}
        event_json = json.dumps(event, separators=(",", ":"), default=str)
        if len(event_json.encode()) > MAX_EVENT_BYTES:
            return {"ok": False, "error": f"event is over {MAX_EVENT_BYTES} bytes"}

    with _conn() as db:
        owner = db.execute("SELECT user_sub FROM samples WHERE session_id=? LIMIT 1",
                           (session_id,)).fetchone()
    if owner and owner["user_sub"] != user_sub:
        return {"ok": False, "error": "that session_id belongs to someone else; pick a new one"}
    if not _within_rate(user_sub):
        return {"ok": False, "error": f"rate limit: {RATE_LIMIT} samples per minute"}

    now = time.time()
    with _lock, _conn() as db:
        cur = db.execute(
            "INSERT INTO samples(user_sub, session_id, ts, type, text, event_json, mime, bytes, received_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (user_sub, session_id, ts, type, text or None, event_json, real_mime,
             len(data) if data else None, now))
        sid = cur.lastrowid
        if data:
            db.execute("INSERT INTO sample_media(sample_id, data) VALUES (?,?)", (sid, data))
    return {"ok": True, "sample_id": sid, "session_id": session_id, "type": type, "ts": ts}


def _sample_out(r: sqlite3.Row) -> dict:
    out = {"sample_id": r["id"], "session_id": r["session_id"], "ts": r["ts"],
           "type": r["type"], "received_at": r["received_at"]}
    if r["text"]:
        out["text"] = r["text"]
    if r["event_json"]:
        out["event"] = json.loads(r["event_json"])
    if r["mime"]:
        out["image"] = {"mime": r["mime"], "bytes": r["bytes"]}
    return out


def cursor(session_id: str) -> int:
    """Highest sample id an analysis record says it has covered (0 = none)."""
    with _conn() as db:
        row = db.execute("SELECT MAX(upto_sample_id) AS m FROM analysis WHERE session_id=?",
                         (session_id,)).fetchone()
    return int(row["m"] or 0)


def list_samples(session_id: str, after_id: int = 0, unprocessed_only: bool = True,
                 limit: int = 50) -> dict:
    after = max(int(after_id or 0), cursor(session_id) if unprocessed_only else 0)
    with _conn() as db:
        rows = db.execute("SELECT * FROM samples WHERE session_id=? AND id>? ORDER BY id LIMIT ?",
                          (session_id, after, limit)).fetchall()
        total = db.execute("SELECT COUNT(*) AS n FROM samples WHERE session_id=? AND id>?",
                           (session_id, after)).fetchone()["n"]
    return {"session_id": session_id, "after_id": after, "samples": [_sample_out(r) for r in rows],
            "remaining": max(0, total - len(rows))}


def get_sample(sample_id: int) -> dict | None:
    with _conn() as db:
        r = db.execute("SELECT * FROM samples WHERE id=?", (sample_id,)).fetchone()
    return _sample_out(r) if r else None


def get_image(sample_id: int) -> tuple[str, bytes] | None:
    with _conn() as db:
        r = db.execute("SELECT s.mime, m.data FROM samples s JOIN sample_media m ON m.sample_id=s.id "
                       "WHERE s.id=?", (sample_id,)).fetchone()
    return (r["mime"], bytes(r["data"])) if r else None


def sessions(limit: int = 20) -> list[dict]:
    with _conn() as db:
        rows = db.execute(
            "SELECT session_id, user_sub, COUNT(*) AS n, MIN(ts) AS started, MAX(ts) AS last, "
            "SUM(type='frame') AS frames, SUM(type='chat') AS chats, SUM(type='event') AS events "
            "FROM samples GROUP BY session_id ORDER BY MAX(id) DESC LIMIT ?", (limit,)).fetchall()
        done = {r["session_id"] for r in db.execute(
            "SELECT DISTINCT session_id FROM analysis WHERE kind='summary'")}
    return [{"session_id": r["session_id"], "user_sub": r["user_sub"], "samples": r["n"],
             "frames": r["frames"], "chats": r["chats"], "events": r["events"],
             "started": r["started"], "last": r["last"], "unprocessed": _unprocessed(r["session_id"]),
             "has_summary": r["session_id"] in done} for r in rows]


def _unprocessed(session_id: str) -> int:
    with _conn() as db:
        return db.execute("SELECT COUNT(*) AS n FROM samples WHERE session_id=? AND id>?",
                          (session_id, cursor(session_id))).fetchone()["n"]


# ── Analysis records ─────────────────────────────────────────────────────────

_RECORD_FIELDS = ("id", "session_id", "kind", "at", "good", "bad", "next_time",
                  "funny_death_roast", "roast_subject_sub", "roast_subject_name", "note",
                  "upto_sample_id", "author", "created_at", "updated_at")


def _record_out(r: sqlite3.Row) -> dict:
    return {k: r[k] for k in _RECORD_FIELDS if r[k] is not None}


def add_record(session_id: str, kind: str, author: str, *, good: str = "", bad: str = "",
               next_time: str = "", funny_death_roast: str = "", roast_subject_sub: str = "",
               roast_subject_name: str = "", note: str = "", at=None,
               upto_sample_id: int | None = None) -> dict:
    """Moments append; a summary replaces the session's previous summary."""
    session_id = (session_id or "").strip()
    if not _SESSION_RE.match(session_id):
        return {"ok": False, "error": "session_id must be 1-64 of A-Z a-z 0-9 . _ : -"}
    if kind not in RECORD_KINDS:
        return {"ok": False, "error": f"kind must be one of {', '.join(RECORD_KINDS)}"}
    fields = {"good": good, "bad": bad, "next_time": next_time, "note": note}
    for k, v in fields.items():
        if len(v or "") > MAX_FIELD_CHARS:
            return {"ok": False, "error": f"{k} is over {MAX_FIELD_CHARS} characters"}
    if len(funny_death_roast or "") > MAX_ROAST_CHARS:
        return {"ok": False, "error": f"funny_death_roast is over {MAX_ROAST_CHARS} characters"}
    if not any((v or "").strip() for v in (*fields.values(), funny_death_roast)):
        return {"ok": False, "error": "give at least one of good, bad, next_time, funny_death_roast, note"}
    at_ts = None
    if at not in (None, ""):
        at_ts = parse_ts(at)
        if at_ts is None:
            return {"ok": False, "error": "at must be epoch seconds or ISO 8601 with a timezone"}
    with _conn() as db:
        sess = db.execute("SELECT user_sub, MAX(id) AS top FROM samples WHERE session_id=?",
                          (session_id,)).fetchone()
    if not sess or sess["user_sub"] is None:
        return {"ok": False, "error": "no samples for that session_id"}
    upto = None
    if upto_sample_id not in (None, ""):
        try:
            upto = int(upto_sample_id)
        except (TypeError, ValueError):
            return {"ok": False, "error": "upto_sample_id must be a sample id"}
        if upto < 0 or upto > sess["top"]:
            return {"ok": False, "error": f"upto_sample_id must be between 0 and {sess['top']}"}

    vals = {k: (v or "").strip() or None for k, v in fields.items()}
    row = (sess["user_sub"], session_id, kind, at_ts, vals["good"], vals["bad"], vals["next_time"],
           (funny_death_roast or "").strip() or None, roast_subject_sub or None,
           roast_subject_name or None, vals["note"], upto, author[:64])
    now = time.time()
    with _lock, _conn() as db:
        existing = None
        if kind == "summary":
            existing = db.execute("SELECT id FROM analysis WHERE session_id=? AND kind='summary'",
                                  (session_id,)).fetchone()
        if existing:
            db.execute("UPDATE analysis SET user_sub=?, session_id=?, kind=?, at=?, good=?, bad=?, "
                       "next_time=?, funny_death_roast=?, roast_subject_sub=?, roast_subject_name=?, "
                       "note=?, upto_sample_id=?, author=?, updated_at=? WHERE id=?",
                       (*row, now, existing["id"]))
            rid, created = existing["id"], False
        else:
            cur = db.execute("INSERT INTO analysis(user_sub, session_id, kind, at, good, bad, next_time, "
                             "funny_death_roast, roast_subject_sub, roast_subject_name, note, "
                             "upto_sample_id, author, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                             (*row, now))
            rid, created = cur.lastrowid, True
        r = db.execute("SELECT * FROM analysis WHERE id=?", (rid,)).fetchone()
    return {"ok": True, "created": created, "record": _record_out(r)}


def list_records(session_id: str = "", kind: str = "", has_roast: bool = False,
                 limit: int = 50) -> list[dict]:
    sql, args = "SELECT * FROM analysis WHERE 1=1", []
    if session_id:
        sql += " AND session_id=?"
        args.append(session_id)
    if kind:
        sql += " AND kind=?"
        args.append(kind)
    if has_roast:
        sql += " AND funny_death_roast IS NOT NULL"
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    with _conn() as db:
        return [_record_out(r) for r in db.execute(sql, args)]


def summary(session_id: str) -> dict | None:
    with _conn() as db:
        r = db.execute("SELECT * FROM analysis WHERE session_id=? AND kind='summary'",
                       (session_id,)).fetchone()
    return _record_out(r) if r else None
