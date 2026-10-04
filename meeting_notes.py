"""Huddle meeting notes: the transcript of a Huddle, and the AI's notes once it ends.

Every transcribed line (POST /api/huddle/transcribe) lands in the room's live meeting;
one is opened by the first line. Who was there comes from the Huddle tokens and the
call's participant list, keyed by Zitadel id. When the call empties (server.py polls
LiveKit), the meeting is closed and the AI writes markdown notes; their first heading
becomes the title, which any attendee can rename.

Everyone who was in the call sees the notes in their list; a link to one works for any
signed-in squad member (that's how notes are shared). The assistant and MCP read them
through the `huddle_meeting_notes` / `huddle_meeting_get` tools.

Transcript text is UNTRUSTED (it is whatever people said, and it is fed to a model):
control characters are stripped and lengths capped on the way in.
"""

from __future__ import annotations

import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

_DB_PATH = Path("/data/meeting_notes.db")
_lock = threading.Lock()

MAX_LINE = 2000
MAX_TITLE = 80
MIN_WORDS = 25          # fewer than this said in the whole call: nothing worth notes
STALE_S = 3 * 3600      # a "live" meeting with no line for this long is over, call or not

_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS meetings (
                id         TEXT PRIMARY KEY,
                room       TEXT NOT NULL,
                started    INTEGER NOT NULL,
                last_line  INTEGER NOT NULL,
                ended      INTEGER,
                status     TEXT NOT NULL DEFAULT 'live',   -- live | writing | ready | empty | failed
                title      TEXT NOT NULL DEFAULT '',
                notes      TEXT NOT NULL DEFAULT '',
                renamed_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_meetings_room ON meetings(room, status);
            CREATE TABLE IF NOT EXISTS people (
                meeting_id TEXT NOT NULL,
                sub        TEXT NOT NULL,
                name       TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (meeting_id, sub)
            );
            CREATE INDEX IF NOT EXISTS idx_people_sub ON people(sub);
            CREATE TABLE IF NOT EXISTS lines (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL,
                ts         INTEGER NOT NULL,
                sub        TEXT NOT NULL,
                name       TEXT NOT NULL DEFAULT '',
                text       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lines_meeting ON lines(meeting_id, ts);
            """
        )


_ALNUM = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_id() -> str:
    """Letters and digits only: a link ending in '_' or '-' loses it in chat apps and Markdown."""
    return "".join(secrets.choice(_ALNUM) for _ in range(12))


def _find(db: sqlite3.Connection, meeting_id: str) -> sqlite3.Row | None:
    """A meeting by id; an older id whose last '_' / '-' a chat app dropped still opens."""
    mid = str(meeting_id or "")[:40]
    r = db.execute("SELECT * FROM meetings WHERE id = ?", (mid,)).fetchone()
    if r or len(mid) < 8 or not re.fullmatch(r"[\w-]+", mid):
        return r
    near = db.execute("SELECT * FROM meetings WHERE id IN (?, ?, ?, ?)",
                      (mid + "_", mid + "-", "_" + mid, "-" + mid)).fetchall()
    return near[0] if len(near) == 1 else None


def _clean(s: str, n: int) -> str:
    return _CTRL.sub(" ", str(s or "")).strip()[:n]


def _live_id(db: sqlite3.Connection, room: str) -> str | None:
    r = db.execute("SELECT id FROM meetings WHERE room = ? AND status = 'live' ORDER BY started DESC LIMIT 1",
                   (room,)).fetchone()
    return r["id"] if r else None


def add_line(room: str, sub: str, name: str, text: str, *, now: float | None = None) -> str | None:
    """One transcribed line from someone in `room`. Opens the room's meeting if none is live."""
    text = _clean(text, MAX_LINE)
    if not room or not sub or not text:
        return None
    ts = int(now or time.time())
    with _lock, _conn() as db:
        mid = _live_id(db, room)
        if not mid:
            mid = new_id()
            db.execute("INSERT INTO meetings (id, room, started, last_line) VALUES (?, ?, ?, ?)", (mid, room, ts, ts))
        db.execute("INSERT INTO lines (meeting_id, ts, sub, name, text) VALUES (?, ?, ?, ?, ?)",
                   (mid, ts, sub, _clean(name, 80), text))
        db.execute("UPDATE meetings SET last_line = ? WHERE id = ?", (ts, mid))
        db.execute("INSERT OR IGNORE INTO people (meeting_id, sub, name) VALUES (?, ?, ?)", (mid, sub, _clean(name, 80)))
    return mid


def add_people(room: str, people: dict[str, str]) -> None:
    """Whoever is in the call right now (identity -> name) was at the room's live meeting."""
    with _lock, _conn() as db:
        mid = _live_id(db, room)
        if not mid:
            return
        for sub, name in people.items():
            if sub:
                db.execute("INSERT OR IGNORE INTO people (meeting_id, sub, name) VALUES (?, ?, ?)",
                           (mid, _clean(sub, 120), _clean(name, 80)))


def live_meetings() -> list[dict]:
    with _lock, _conn() as db:
        return [dict(r) for r in db.execute("SELECT id, room, started, last_line FROM meetings WHERE status = 'live'")]


def transcript(meeting_id: str) -> list[dict]:
    with _lock, _conn() as db:
        return [dict(r) for r in db.execute(
            "SELECT ts, sub, name, text FROM lines WHERE meeting_id = ? ORDER BY ts, id", (meeting_id,))]


def transcript_text(meeting_id: str, limit: int = 60_000) -> str:
    out = "\n".join(f"{l['name'] or 'Someone'}: {l['text']}" for l in transcript(meeting_id))
    return out[-limit:]


def word_count(meeting_id: str) -> int:
    return sum(len(l["text"].split()) for l in transcript(meeting_id))


def claim_for_writing(meeting_id: str) -> bool:
    """live -> writing, once: two pollers never write the same notes."""
    with _lock, _conn() as db:
        n = db.execute("UPDATE meetings SET status = 'writing', ended = ? WHERE id = ? AND status = 'live'",
                       (int(time.time()), meeting_id)).rowcount
    return n == 1


def title_from(notes: str) -> str:
    """The notes' first heading (or first line), as a short title."""
    for line in (notes or "").splitlines():
        t = line.strip().lstrip("#").strip().strip("*_ ").strip()
        if t:
            t = re.sub(r"^(meeting notes|notes)\s*[:\-–—]\s*", "", t, flags=re.I) or t
            return t[:MAX_TITLE]
    return ""


def finish(meeting_id: str, status: str, notes: str = "", title: str = "") -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE meetings SET status = ?, notes = ?, title = CASE WHEN renamed_by = '' THEN ? ELSE title END "
                   "WHERE id = ?", (status, notes or "", _clean(title, MAX_TITLE), meeting_id))


def rename(meeting_id: str, sub: str, title: str) -> bool:
    title = _clean(title, MAX_TITLE)
    if not title or not is_attendee(meeting_id, sub):
        return False
    with _lock, _conn() as db:
        db.execute("UPDATE meetings SET title = ?, renamed_by = ? WHERE id = ?", (title, sub, meeting_id))
    return True


def is_attendee(meeting_id: str, sub: str) -> bool:
    with _lock, _conn() as db:
        return db.execute("SELECT 1 FROM people WHERE meeting_id = ? AND sub = ?", (meeting_id, sub)).fetchone() is not None


def attendees(meeting_id: str) -> list[dict]:
    with _lock, _conn() as db:
        return [{"sub": r["sub"], "name": r["name"]} for r in db.execute(
            "SELECT sub, name FROM people WHERE meeting_id = ? ORDER BY name", (meeting_id,))]


def _summary(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "room": r["room"], "started": r["started"], "ended": r["ended"], "status": r["status"],
            "title": r["title"] or f"Huddle · {r['room']}"}


def list_meetings(*, sub: str | None = None, query: str = "", limit: int = 30) -> list[dict]:
    """Newest first. `sub`: only meetings that person was at. `query`: in the title or the notes."""
    limit = max(1, min(int(limit or 30), 100))
    sql = "SELECT m.* FROM meetings m"
    args: list = []
    where = ["m.status != 'empty'"]
    if sub:
        sql += " JOIN people p ON p.meeting_id = m.id AND p.sub = ?"
        args.append(sub)
    if query:
        where.append("(m.title LIKE ? OR m.notes LIKE ?)")
        args += [f"%{query[:80]}%"] * 2
    sql += " WHERE " + " AND ".join(where) + " ORDER BY m.started DESC LIMIT ?"
    args.append(limit)
    with _lock, _conn() as db:
        rows = db.execute(sql, args).fetchall()
    out = [_summary(r) for r in rows]
    for m in out:
        m["people"] = [p["name"] for p in attendees(m["id"])]
    return out


def get(meeting_id: str, *, with_transcript: bool = True) -> dict | None:
    with _lock, _conn() as db:
        r = _find(db, meeting_id)
    if not r:
        return None
    out = _summary(r) | {"notes": r["notes"], "people": attendees(r["id"])}
    if with_transcript:
        out["transcript"] = [{"ts": l["ts"], "name": l["name"], "text": l["text"]} for l in transcript(r["id"])]
    return out


def live_meeting(room: str) -> dict | None:
    """The room's meeting while the call is on: its id and the transcript so far (for
    someone who joins, or rejoins, partway through)."""
    with _lock, _conn() as db:
        mid = _live_id(db, room)
    if not mid:
        return None
    return {"id": mid, "lines": [{"ts": l["ts"], "name": l["name"], "text": l["text"]} for l in transcript(mid)]}


def delete(meeting_id: str, sub: str) -> list[str] | None:
    """Delete a meeting for everyone (anyone who was in it may). Returns the memory record
    ids it had, so the squad memory forgets it too; None if not allowed."""
    m = get(meeting_id, with_transcript=False)
    if not m or not is_attendee(m["id"], sub):
        return None
    mid = m["id"]
    with _lock, _conn() as db:
        n = db.execute("SELECT COUNT(*) FROM lines WHERE meeting_id=?", (mid,)).fetchone()[0]
        for t in ("lines", "people"):
            db.execute(f"DELETE FROM {t} WHERE meeting_id=?", (mid,))
        db.execute("DELETE FROM meetings WHERE id=?", (mid,))
    return [f"{mid}:notes"] + [f"{mid}:t{i}" for i in range((n + 39) // 40 or 1)]
