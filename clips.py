"""Persistent clip catalog and job state for PSN → WhatsApp video pipeline."""

import logging
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/clips.db")
_lock = threading.Lock()

# Processing stages
DISCOVERED    = "discovered"
RESOLVING     = "resolving"
WAITING_MEDIA = "waiting_media"
DOWNLOADING   = "downloading"
PROCESSING    = "processing"
ARCHIVED      = "archived"
SENDING       = "sending"
DELIVERED     = "delivered"
FAILED        = "failed"
TERMINAL      = {DELIVERED, FAILED}

# Aliases kept for compat with any callers that used video_jobs constants
PENDING = DISCOVERED


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS clips (
                message_uid             TEXT PRIMARY KEY,
                ugc_id                  TEXT NOT NULL,
                psn_group_id            TEXT NOT NULL,
                psn_group_name          TEXT,
                sender_online_id        TEXT NOT NULL,
                psn_created_at          REAL,
                discovered_at           REAL NOT NULL,

                status                  TEXT NOT NULL DEFAULT 'discovered',
                attempts                INTEGER NOT NULL DEFAULT 0,
                next_attempt_at         REAL NOT NULL DEFAULT 0.0,
                last_error              TEXT,

                storage_key_original    TEXT,
                archived_at             REAL,
                archive_status          TEXT NOT NULL DEFAULT 'not_archived',

                duration_seconds        REAL,
                width                   INTEGER,
                height                  INTEGER,
                fps                     REAL,
                video_codec             TEXT,
                audio_codec             TEXT,
                audio_sample_rate       INTEGER,
                file_size               INTEGER,
                sha256                  TEXT,

                storage_key_normalized  TEXT,
                normalization_status    TEXT NOT NULL DEFAULT 'not_requested',

                body                    TEXT,

                wa_message_id           TEXT,
                whatsapp_delivered_at   REAL,

                montage_eligible        INTEGER NOT NULL DEFAULT 1,
                montage_id              TEXT,

                created_at              REAL NOT NULL,
                updated_at              REAL NOT NULL
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS psn_group_cursors (
                group_id                TEXT PRIMARY KEY,
                last_seen_message_uid   TEXT,
                last_seen_at            REAL,
                updated_at              REAL NOT NULL
            )
        """)
        db.commit()
        # Migrations
        cols = {r[1] for r in db.execute("PRAGMA table_info(clips)")}
        if "body" not in cols:
            db.execute("ALTER TABLE clips ADD COLUMN body TEXT")
            db.commit()
        if "message_source" not in cols:
            db.execute("ALTER TABLE clips ADD COLUMN message_source TEXT")
            db.commit()
        if "game_name" not in cols:
            db.execute("ALTER TABLE clips ADD COLUMN game_name TEXT")
            db.commit()
        if "title_id" not in cols:
            db.execute("ALTER TABLE clips ADD COLUMN title_id TEXT")
            db.commit()
        # One-time backfill: clips inserted before message_source was added have a
        # non-null body but no source label. They all came from the poller's
        # _adjacent_caption window, so they are clip_caption.
        db.execute(
            "UPDATE clips SET message_source='clip_caption'"
            " WHERE message_source IS NULL AND body IS NOT NULL AND body != ''")
        db.commit()
    logger.info("clips: DB ready at %s", _DB_PATH)


def claim(
    message_uid: str,
    ugc_id: str,
    group_id: str,
    group_name: str,
    sender: str,
    psn_created_ms: int | None = None,
    body: str = "",
    body_source: str | None = None,
) -> bool:
    """Insert clip if not already known. Returns True if this is a new clip.

    body_source overrides the auto-derived message_source when the body did not
    come from the clip's own caption (e.g. 'text_before_clip' for a pending
    console-style trigger that was matched at clip-arrival time).
    """
    now = time.time()
    psn_created_at = (psn_created_ms / 1000.0) if psn_created_ms else None
    if body:
        source = body_source or "clip_caption"
    else:
        source = None
    with _lock, _conn() as db:
        db.execute(
            """INSERT OR IGNORE INTO clips
               (message_uid, ugc_id, psn_group_id, psn_group_name,
                sender_online_id, psn_created_at, discovered_at,
                body, message_source, next_attempt_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?)""",
            (message_uid, ugc_id, group_id, group_name,
             sender, psn_created_at, now, body or None,
             source, now, now),
        )
        db.commit()
        return db.execute("SELECT changes()").fetchone()[0] > 0


def get(message_uid: str) -> dict | None:
    with _conn() as db:
        row = db.execute(
            "SELECT * FROM clips WHERE message_uid=?", (message_uid,)
        ).fetchone()
    return dict(row) if row else None


def mark(
    message_uid: str,
    status: str,
    error: str | None = None,
    next_attempt_at: float | None = None,
) -> None:
    now = time.time()
    with _lock, _conn() as db:
        if next_attempt_at is not None:
            db.execute(
                """UPDATE clips
                   SET status=?, last_error=?, attempts=attempts+1,
                       next_attempt_at=?, updated_at=?
                   WHERE message_uid=?""",
                (status, error, next_attempt_at, now, message_uid),
            )
        else:
            db.execute(
                """UPDATE clips
                   SET status=?, last_error=?, updated_at=?
                   WHERE message_uid=?""",
                (status, error, now, message_uid),
            )
        db.commit()


def set_archived(
    message_uid: str,
    storage_key: str,
    sha256: str | None = None,
    file_size: int | None = None,
    duration_seconds: float | None = None,
    width: int | None = None,
    height: int | None = None,
    fps: float | None = None,
    video_codec: str | None = None,
    audio_codec: str | None = None,
    audio_sample_rate: int | None = None,
) -> None:
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            """UPDATE clips SET
               status='archived', archive_status='archived',
               storage_key_original=?, archived_at=?,
               sha256=?, file_size=?, duration_seconds=?,
               width=?, height=?, fps=?,
               video_codec=?, audio_codec=?, audio_sample_rate=?,
               updated_at=?
               WHERE message_uid=?""",
            (storage_key, now, sha256, file_size,
             duration_seconds, width, height, fps,
             video_codec, audio_codec, audio_sample_rate,
             now, message_uid),
        )
        db.commit()


def set_coaching_only(message_uid: str) -> None:
    """Mark a clip as coaching-only: kept out of the monthly montage.

    A clip the sender tagged "rev" is a request for analysis, not something they
    are sharing for the highlight reel, so it must not be swept into a montage.
    """
    with _lock, _conn() as db:
        db.execute("UPDATE clips SET montage_eligible = 0, updated_at = ? "
                   "WHERE message_uid = ?", (time.time(), message_uid))
        db.commit()


def set_coaching_done(message_uid: str) -> None:
    """Terminal state for a coaching-only clip: archived, deliberately not sent.

    Uses the 'delivered' status because that is what TERMINAL contains, and a clip
    left in a non-terminal state is requeued forever. But wa_message_id and
    whatsapp_delivered_at stay NULL — this clip never went to WhatsApp, and
    recording a delivery timestamp would be a lie the UI and recent_clips repeat.
    """
    now = time.time()
    with _lock, _conn() as db:
        db.execute("UPDATE clips SET status='delivered', updated_at=? "
                   "WHERE message_uid=?", (now, message_uid))
        db.commit()


def set_message(message_uid: str, text: str,
                source: str = "text_after_clip") -> bool:
    """Backfill a caption from a standalone trigger text.

    source values:
      'text_after_clip'  — text sent after the clip (PS-app style, send clip then type emoji)
      'text_before_clip' — text sent before the clip (PS-console style, type emoji then post)

    Only writes when body is currently NULL or empty — never overwrites an
    existing caption. Returns True if the update was actually applied.
    """
    text = (text or "").strip()
    if not text:
        return False
    source = source or "text_after_clip"
    now = time.time()
    with _lock, _conn() as db:
        cur = db.execute(
            "UPDATE clips SET body=?, message_source=?, updated_at=?"
            " WHERE message_uid=? AND (body IS NULL OR body='')",
            (text, source, now, message_uid))
        db.commit()
        return cur.rowcount > 0


def recent_untagged_by_sender(sender: str, group_id: str, since_ts: float) -> dict | None:
    """Most recent clip from sender in group with no caption, created at or after since_ts.

    Used to match a follow-up "rev" or "🔥" text back to the clip it refers to.
    """
    with _conn() as db:
        row = db.execute(
            "SELECT * FROM clips"
            " WHERE sender_online_id=? AND psn_group_id=?"
            "   AND (body IS NULL OR body='')"
            "   AND COALESCE(psn_created_at, created_at) >= ?"
            " ORDER BY COALESCE(psn_created_at, created_at) DESC"
            " LIMIT 1",
            (sender, group_id, since_ts)).fetchone()
    return dict(row) if row else None


def set_game(message_uid: str, game_name: str, title_id: str = "") -> None:
    """Record the game a clip was captured from. No-op if already set."""
    game_name = (game_name or "").strip()
    if not game_name or not message_uid:
        return
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            "UPDATE clips SET game_name=?, title_id=?, updated_at=?"
            " WHERE message_uid=? AND (game_name IS NULL OR game_name='')",
            (game_name, (title_id or "").strip() or None, now, message_uid))
        db.commit()


def untagged_game_clips(since_ts: float, limit: int = 200) -> list[dict]:
    """Recent clips with no game_name, for startup backfill."""
    with _conn() as db:
        rows = db.execute(
            "SELECT message_uid, sender_online_id, psn_created_at, created_at"
            " FROM clips WHERE (game_name IS NULL OR game_name='')"
            "   AND COALESCE(psn_created_at, created_at) >= ?"
            " ORDER BY COALESCE(psn_created_at, created_at) DESC"
            " LIMIT ?",
            (since_ts, limit)).fetchall()
    return [dict(r) for r in rows]


def non_archived_recent(since_ts: float, limit: int = 200) -> list[dict]:
    """Recent clips whose archive_status is not 'archived', for startup healing."""
    with _conn() as db:
        rows = db.execute(
            "SELECT message_uid, psn_created_at, sender_online_id FROM clips"
            " WHERE archive_status != 'archived'"
            "   AND COALESCE(psn_created_at, created_at) >= ?"
            " ORDER BY COALESCE(psn_created_at, created_at) DESC LIMIT ?",
            (since_ts, limit)).fetchall()
    return [dict(r) for r in rows]


def set_ig_done(message_uid: str) -> None:
    """Terminal state for an IG-posted clip: archived, not sent via WA bridge.

    montage_eligible stays 1 — a fire clip IS a highlight and belongs in the montage.
    whatsapp_delivered_at stays NULL — Muse shares the IG link, not the raw clip.
    """
    now = time.time()
    with _lock, _conn() as db:
        db.execute("UPDATE clips SET status='delivered', updated_at=? "
                   "WHERE message_uid=?", (now, message_uid))
        db.commit()


def set_delivered(message_uid: str, wa_message_id: str | None = None) -> None:
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            """UPDATE clips
               SET status='delivered', wa_message_id=?,
                   whatsapp_delivered_at=?, updated_at=?
               WHERE message_uid=?""",
            (wa_message_id, now, now, message_uid),
        )
        db.commit()


def recoverable_jobs() -> list[dict]:
    """Non-terminal jobs past their next_attempt_at, ordered by discovery time."""
    now = time.time()
    with _conn() as db:
        rows = db.execute(
            """SELECT * FROM clips
               WHERE status NOT IN ('delivered', 'failed')
                 AND next_attempt_at <= ?
               ORDER BY created_at""",
            (now,),
        ).fetchall()
    return [dict(r) for r in rows]


def stats() -> dict:
    with _conn() as db:
        row = db.execute(
            """SELECT
               COUNT(*)                                   AS total,
               SUM(status='delivered')                    AS delivered,
               SUM(status='failed')                       AS failed,
               SUM(archive_status='archived')             AS archived,
               SUM(status NOT IN ('delivered','failed'))  AS active
               FROM clips"""
        ).fetchone()
    return dict(row) if row else {}


def list_clips(
    month: str | None = None,
    sender: str | None = None,
    group_id: str | None = None,
    status: str | None = None,
    montage_eligible: bool | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Return clip records with optional filters. month='2026-08'."""
    import calendar
    import datetime

    clauses: list[str] = []
    params: list = []

    if month:
        try:
            year, mon = int(month[:4]), int(month[5:7])
            start = datetime.datetime(year, mon, 1,
                                      tzinfo=datetime.timezone.utc).timestamp()
            last_day = calendar.monthrange(year, mon)[1]
            end = datetime.datetime(year, mon, last_day, 23, 59, 59,
                                    tzinfo=datetime.timezone.utc).timestamp()
            clauses.append("psn_created_at BETWEEN ? AND ?")
            params.extend([start, end])
        except Exception:
            pass

    if sender:
        clauses.append("sender_online_id = ?")
        params.append(sender)
    if group_id:
        clauses.append("psn_group_id = ?")
        params.append(group_id)
    if status:
        clauses.append("status = ?")
        params.append(status)
    if montage_eligible is not None:
        clauses.append("montage_eligible = ?")
        params.append(1 if montage_eligible else 0)

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.extend([limit, offset])
    with _conn() as db:
        rows = db.execute(
            f"""SELECT * FROM clips {where}
                ORDER BY COALESCE(psn_created_at, created_at) DESC
                LIMIT ? OFFSET ?""",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def update_cursor(group_id: str, message_uid: str, seen_at: float | None = None) -> None:
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            """INSERT INTO psn_group_cursors
                   (group_id, last_seen_message_uid, last_seen_at, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(group_id) DO UPDATE SET
                   last_seen_message_uid = excluded.last_seen_message_uid,
                   last_seen_at          = excluded.last_seen_at,
                   updated_at            = excluded.updated_at""",
            (group_id, message_uid, seen_at or now, now),
        )
        db.commit()


def get_cursor(group_id: str) -> dict | None:
    with _conn() as db:
        row = db.execute(
            "SELECT * FROM psn_group_cursors WHERE group_id=?", (group_id,)
        ).fetchone()
    return dict(row) if row else None
