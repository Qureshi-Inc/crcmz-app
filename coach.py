"""AI Coach reviews for PSN gaming clips.

Stores completed coaching reviews produced by the AI review pipeline.
The actual review call is not here — this module is the durable store only.

DB: /data/coach_reviews.db
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

_DB_PATH = Path("/data/coach_reviews.db")
_lock = threading.Lock()

VALID_STATUSES = {"pending", "processing", "complete", "failed"}


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS coach_reviews (
                review_id        TEXT PRIMARY KEY,
                clip_id          TEXT NOT NULL,
                psn_user         TEXT,
                game             TEXT,
                created_at       REAL NOT NULL,
                model            TEXT,
                prompt_version   TEXT,
                summary          TEXT,
                overall_assessment TEXT,
                strengths        TEXT,
                mistakes         TEXT,
                coaching_tips    TEXT,
                notable_moments  TEXT,
                tags             TEXT,
                review_json      TEXT,
                review_status    TEXT NOT NULL DEFAULT 'pending',
                source_checksum  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_coach_clip
                ON coach_reviews(clip_id);
            CREATE INDEX IF NOT EXISTS idx_coach_status
                ON coach_reviews(review_status, created_at);
        """)
        db.commit()
    logger.info("coach: DB ready at %s", _DB_PATH)


def _row_to_dict(row) -> dict:
    d = dict(row)
    for field in ("strengths", "mistakes", "coaching_tips", "notable_moments", "tags"):
        raw = d.get(field)
        if raw:
            try:
                d[field] = json.loads(raw)
            except Exception:  # noqa: BLE001
                pass
    return d


def get(review_id: str) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT * FROM coach_reviews WHERE review_id = ?", (review_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def get_by_clip(clip_id: str) -> dict | None:
    """Return the most recent complete review for a clip, or None."""
    with _lock, _conn() as db:
        row = db.execute(
            """SELECT * FROM coach_reviews
               WHERE clip_id = ? AND review_status = 'complete'
               ORDER BY created_at DESC LIMIT 1""",
            (clip_id,),
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_reviews(
    limit: int = 20,
    status: str | None = None,
    psn_user: str | None = None,
) -> list[dict]:
    limit = max(1, min(int(limit or 20), 500))
    sql = "SELECT * FROM coach_reviews WHERE 1=1"
    params: list = []
    if status:
        sql += " AND review_status = ?"
        params.append(status)
    if psn_user:
        sql += " AND psn_user = ?"
        params.append(psn_user)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    with _lock, _conn() as db:
        return [_row_to_dict(r) for r in db.execute(sql, params)]


def upsert(review_data: dict) -> str:
    """Insert or replace a review row.  Returns the review_id.

    Computes source_checksum from review_json when not provided.
    Generates review_id if absent.
    """
    d = dict(review_data)
    if not d.get("review_id"):
        d["review_id"] = str(uuid.uuid4())
    if not d.get("created_at"):
        d["created_at"] = time.time()
    if d.get("review_json") and not d.get("source_checksum"):
        rj = d["review_json"]
        raw = rj if isinstance(rj, str) else json.dumps(rj)
        d["source_checksum"] = hashlib.sha256(raw.encode()).hexdigest()

    # Serialise list fields to JSON strings.
    for field in ("strengths", "mistakes", "coaching_tips", "notable_moments", "tags"):
        if field in d and isinstance(d[field], list):
            d[field] = json.dumps(d[field])
    if "review_json" in d and not isinstance(d["review_json"], str):
        d["review_json"] = json.dumps(d["review_json"])

    cols = [
        "review_id", "clip_id", "psn_user", "game", "created_at",
        "model", "prompt_version", "summary", "overall_assessment",
        "strengths", "mistakes", "coaching_tips", "notable_moments",
        "tags", "review_json", "review_status", "source_checksum",
    ]
    vals = [d.get(c) for c in cols]
    placeholders = ", ".join("?" * len(cols))
    col_str = ", ".join(cols)
    with _lock, _conn() as db:
        db.execute(
            f"INSERT OR REPLACE INTO coach_reviews ({col_str}) VALUES ({placeholders})",
            vals,
        )
        db.commit()
    return d["review_id"]


def backfill_pending(limit: int = 5) -> list[dict]:
    """Return clips that have no completed coach review — candidates for review.

    Reads /data/clips.db directly.  Read-only; never creates reviews.
    Returns an empty list if clips.db is absent or the clips table is empty.
    """
    limit = max(1, min(int(limit or 5), 100))
    clips_db = Path("/data/clips.db")
    if not clips_db.exists():
        return []
    try:
        reviewed_ids: set[str] = set()
        with _lock, _conn() as db:
            rows = db.execute(
                "SELECT clip_id FROM coach_reviews WHERE review_status = 'complete'"
            ).fetchall()
            reviewed_ids = {r["clip_id"] for r in rows}

        import sqlite3 as _sq3
        with _sq3.connect(clips_db, check_same_thread=False) as cdb:
            cdb.row_factory = _sq3.Row
            clip_rows = cdb.execute(
                """SELECT message_uid, ugc_id, sender_online_id, psn_group_name,
                          psn_created_at, body, game_title_info_title_name,
                          duration_seconds, status
                   FROM clips
                   WHERE status = 'archived'
                   ORDER BY psn_created_at DESC
                   LIMIT ?""",
                (limit * 5,),  # fetch more so we can filter out already-reviewed
            ).fetchall()

        candidates = []
        for r in clip_rows:
            uid = r["message_uid"]
            if uid in reviewed_ids:
                continue
            candidates.append({
                "clip_id":       uid,
                "ugc_id":        r["ugc_id"],
                "psn_user":      r["sender_online_id"],
                "game":          r.get("game_title_info_title_name") or None,
                "group_name":    r["psn_group_name"],
                "created_at":    r["psn_created_at"],
                "duration_s":    r["duration_seconds"],
                "body":          r["body"],
            })
            if len(candidates) >= limit:
                break
        return candidates
    except Exception as e:  # noqa: BLE001
        logger.warning("coach.backfill_pending failed: %s", e)
        return []


def count_by_status() -> dict[str, int]:
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT review_status, COUNT(*) n FROM coach_reviews GROUP BY review_status"
        ).fetchall()
    return {r["review_status"]: r["n"] for r in rows}
