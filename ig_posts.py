"""Instagram post records — clips queued for IG via the 🔥 trigger.

When a clip arrives with 🔥 in the caption it is archived and registered here.
Muse sees it via recent_clips (the message field carries the caption), downloads
it via clip_media_url, posts to Instagram, then calls ig_post_record with the
resulting URL. This module records that and the platform sends the IG link to
the WhatsApp group.

DB: /data/ig_posts.db
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("IG_POSTS_DB", "/data/ig_posts.db"))
_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS ig_posts (
                post_id              TEXT PRIMARY KEY,
                clip_id              TEXT NOT NULL UNIQUE,
                psn_user             TEXT NOT NULL,
                zitadel_id           TEXT NOT NULL DEFAULT '',
                created_at           REAL NOT NULL,
                ig_url               TEXT,
                instagram_media_id   TEXT,
                ig_caption           TEXT,
                posted_at            REAL,
                notified_at          REAL
            );
            CREATE INDEX IF NOT EXISTS idx_ig_clip ON ig_posts(clip_id);
            CREATE INDEX IF NOT EXISTS idx_ig_at   ON ig_posts(created_at);
        """)
        # Migrations for DBs created before these columns were added
        for col, defn in (
            ("instagram_media_id", "TEXT"),
            ("ig_caption",         "TEXT"),
        ):
            try:
                db.execute(f"ALTER TABLE ig_posts ADD COLUMN {col} {defn}")
            except sqlite3.OperationalError:
                pass
        db.commit()
    logger.info("ig_posts: DB ready at %s", _DB_PATH)


def claim_for_post(clip_id: str, psn_user: str, zitadel_id: str = "") -> str | None:
    """Register a clip for IG posting. Idempotent: returns existing post_id if already registered."""
    existing = get_by_clip(clip_id)
    if existing:
        return existing["post_id"]
    post_id = uuid.uuid4().hex
    now = time.time()
    try:
        with _lock, _conn() as db:
            db.execute(
                "INSERT INTO ig_posts (post_id, clip_id, psn_user, zitadel_id, created_at)"
                " VALUES (?,?,?,?,?)",
                (post_id, clip_id, psn_user, zitadel_id or "", now))
            db.commit()
        return post_id
    except sqlite3.IntegrityError:
        row = get_by_clip(clip_id)
        return row["post_id"] if row else None


def get_by_clip(clip_id: str) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute("SELECT * FROM ig_posts WHERE clip_id = ?",
                         (clip_id,)).fetchone()
    return dict(row) if row else None


def get(post_id: str) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute("SELECT * FROM ig_posts WHERE post_id = ?",
                         (post_id,)).fetchone()
    return dict(row) if row else None


def submit_post(post_id: str, ig_url: str,
                instagram_media_id: str = "", caption: str = "") -> None:
    """Record the Instagram URL (and optional media ID / caption) once the post is live."""
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            "UPDATE ig_posts SET ig_url=?, instagram_media_id=?, ig_caption=?, posted_at=?"
            " WHERE post_id=?",
            (ig_url, instagram_media_id or None, caption or None, now, post_id))
        db.commit()


def claim_notification(post_id: str) -> bool:
    """Atomic: UPDATE WHERE notified_at IS NULL. rowcount==1 means you won."""
    with _lock, _conn() as db:
        cur = db.execute(
            "UPDATE ig_posts SET notified_at=? WHERE post_id=? AND notified_at IS NULL",
            (time.time(), post_id))
        db.commit()
        return cur.rowcount == 1


def release_notification(post_id: str) -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE ig_posts SET notified_at=NULL WHERE post_id=?",
                   (post_id,))
        db.commit()


def recent(limit: int = 50) -> list[dict]:
    limit = max(1, min(int(limit or 50), 200))
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT * FROM ig_posts ORDER BY created_at DESC LIMIT ?",
            (limit,)).fetchall()
    return [dict(r) for r in rows]
