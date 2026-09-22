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


_FEEDBACK_TAGS = frozenset((
    "wrong-grade", "wrong-player", "missed-moment",
    "bad-tip", "transcript-wrong", "other",
))


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
        cols = {r[1] for r in db.execute("PRAGMA table_info(coach_reviews)")}
        if "grade" not in cols:
            # S/A/B/C/D, stored separately from overall_assessment. Charts and any
            # future player characterisation key off this, and deriving it by
            # string-splitting the prose breaks the first time the wording changes.
            db.execute("ALTER TABLE coach_reviews ADD COLUMN grade TEXT")
        if "zitadel_id" not in cols:
            # The durable person key. psn_user is kept for provenance, but Sony lets
            # a member rename their online ID, which would orphan their reviews — so
            # the dashboard joins on this.
            db.execute("ALTER TABLE coach_reviews ADD COLUMN zitadel_id TEXT")
            db.execute("CREATE INDEX IF NOT EXISTS idx_coach_zid "
                       "ON coach_reviews(zitadel_id, created_at)")
        if "notified_at" not in cols:
            # When the member was told their review is ready. The notification is
            # sent once, on the pending -> complete transition: the analyser retries
            # submits, and without this column every retry would DM again.
            db.execute("ALTER TABLE coach_reviews ADD COLUMN notified_at REAL")
        if "voice_comms" not in cols:
            db.execute("ALTER TABLE coach_reviews ADD COLUMN voice_comms TEXT")
        db.commit()
        db.executescript("""
            CREATE TABLE IF NOT EXISTS review_feedback (
                id             TEXT PRIMARY KEY,
                review_id      TEXT NOT NULL REFERENCES coach_reviews(review_id),
                player_zid     TEXT NOT NULL,
                squad_id       TEXT NOT NULL DEFAULT 'crcmz',
                rating         TEXT NOT NULL CHECK(rating IN ('up','down')),
                tags           TEXT NOT NULL DEFAULT '[]',
                comment        TEXT,
                created_at     REAL NOT NULL,
                updated_at     REAL NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_player_review
                ON review_feedback(review_id, player_zid);
            CREATE INDEX IF NOT EXISTS idx_feedback_review
                ON review_feedback(review_id);
        """)
        db.commit()
    logger.info("coach: DB ready at %s", _DB_PATH)


def mark_notified(review_id: str) -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE coach_reviews SET notified_at=? WHERE review_id=?",
                   (time.time(), review_id))
        db.commit()


def needs_notification(review_id: str) -> bool:
    """Whether this review still wants a notification. READ ONLY — do not gate a
    send on this. It is check-then-act: two concurrent submits both see True and
    both send. Use `claim_notification` to actually take the send."""
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT review_status, notified_at FROM coach_reviews WHERE review_id=?",
            (review_id,)).fetchone()
    return bool(row) and row["review_status"] == "complete" and row["notified_at"] is None


def claim_notification(review_id: str) -> bool:
    """Atomically take the right to notify. True for exactly one caller, ever.

    The condition lives in the UPDATE, so SQLite settles the race for us and this
    holds across processes too — an in-process lock would not, with more than one
    worker. Claim before sending rather than after: a crash mid-send then loses one
    notification, where the reverse order sends a duplicate, and for "your review is
    ready" a missed DM is far better than a repeated one.
    """
    with _lock, _conn() as db:
        cur = db.execute(
            "UPDATE coach_reviews SET notified_at=? "
            "WHERE review_id=? AND review_status='complete' AND notified_at IS NULL",
            (time.time(), review_id))
        db.commit()
        return cur.rowcount == 1


def release_notification(review_id: str) -> None:
    """Give a claim back after a failed send so a later submit can retry it."""
    with _lock, _conn() as db:
        db.execute("UPDATE coach_reviews SET notified_at=NULL WHERE review_id=?",
                   (review_id,))
        db.commit()


def patch_voice_comms(review_id: str, content: str) -> bool:
    """Add or replace the voice_comms section on an existing review. No-op on unknown id.

    Returns True if a row was updated. Does NOT touch notified_at or any other
    field — this is intentionally a narrow in-place patch so the WhatsApp
    notification flow is never re-triggered.
    """
    content = (content or "").strip()
    if not content or not review_id:
        return False
    with _lock, _conn() as db:
        cur = db.execute(
            "UPDATE coach_reviews SET voice_comms=? WHERE review_id=?",
            (content, review_id))
        db.commit()
        return cur.rowcount > 0


def claim_for_review(clip_id: str, psn_user: str = "", game: str = "",
                     zitadel_id: str = "") -> str | None:
    """Queue a clip for coaching. Returns the review_id, or None if already queued.

    Idempotent on clip_id so a poller that re-sees the same clip does not enqueue
    it twice."""
    if get_any_by_clip(clip_id):
        return None
    return upsert({"clip_id": clip_id, "psn_user": psn_user, "game": game,
                   "zitadel_id": zitadel_id, "review_status": "pending"})


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


def get_any_by_clip(clip_id: str) -> dict | None:
    """Most recent review for a clip at ANY status.

    `get_by_clip` deliberately returns only completed reviews — that is what the
    read tool wants. Queueing and updating need to see a pending row too: without
    this the poller re-queues the same clip on every tick, and a submitted review
    lands as a second row beside the pending one instead of replacing it.
    """
    with _lock, _conn() as db:
        row = db.execute(
            """SELECT * FROM coach_reviews
               WHERE clip_id = ?
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
        "tags", "review_json", "review_status", "source_checksum", "zitadel_id",
        "grade",
        # Must be persisted: this is INSERT OR REPLACE, so leaving it out of the
        # column list resets it to NULL on every resubmit, and the member gets
        # DM'd again each time the analyser retries.
        "notified_at",
        "voice_comms",
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


def submit_feedback(review_id: str, player_zid: str, rating: str,
                    tags: list[str], comment: str = "") -> str | None:
    """Upsert a feedback row. Returns the feedback id, or None on bad input.

    One row per (review_id, player_zid) — resubmitting updates rather than
    inserting a duplicate. Tags are validated against the fixed set.
    """
    if not review_id or not player_zid:
        return None
    if rating not in ("up", "down"):
        return None
    valid_tags = [t for t in (tags or []) if t in _FEEDBACK_TAGS]
    with _lock, _conn() as db:
        exists = db.execute(
            "SELECT id FROM review_feedback WHERE review_id=? AND player_zid=?",
            (review_id, player_zid)).fetchone()
        now = time.time()
        if exists:
            db.execute(
                "UPDATE review_feedback SET rating=?, tags=?, comment=?, updated_at=?"
                " WHERE review_id=? AND player_zid=?",
                (rating, json.dumps(valid_tags), (comment or "").strip() or None,
                 now, review_id, player_zid))
            db.commit()
            return exists["id"]
        fid = str(uuid.uuid4())
        db.execute(
            "INSERT INTO review_feedback (id, review_id, player_zid, rating, tags, comment,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (fid, review_id, player_zid, rating,
             json.dumps(valid_tags), (comment or "").strip() or None, now, now))
        db.commit()
        return fid


def list_my_feedback(player_zid: str) -> dict[str, dict]:
    """All feedback by this player, keyed by review_id."""
    if not player_zid:
        return {}
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT * FROM review_feedback WHERE player_zid=?", (player_zid,)
        ).fetchall()
    out = {}
    for row in rows:
        d = dict(row)
        try:
            d["tags"] = json.loads(d.get("tags") or "[]")
        except Exception:  # noqa: BLE001
            d["tags"] = []
        out[d["review_id"]] = d
    return out


def get_feedback(review_id: str, player_zid: str) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT * FROM review_feedback WHERE review_id=? AND player_zid=?",
            (review_id, player_zid)).fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["tags"] = json.loads(d.get("tags") or "[]")
    except Exception:  # noqa: BLE001
        d["tags"] = []
    return d


def feedback_patterns(since_ts: float, min_count: int = 2) -> list[dict]:
    """Aggregate feedback by game for the weekly digest.

    Returns per-game patterns where >= min_count players share a tag.
    Player ids are never included — only counts and example review_ids.
    """
    with _lock, _conn() as db:
        rows = db.execute(
            """SELECT rf.review_id, rf.tags, cr.game
               FROM review_feedback rf
               JOIN coach_reviews cr ON cr.review_id = rf.review_id
               WHERE rf.created_at >= ?""",
            (since_ts,)).fetchall()

    # (game, tag) -> {count, review_ids}
    buckets: dict[tuple[str, str], dict] = {}
    for row in rows:
        game = (row["game"] or "unknown").strip() or "unknown"
        try:
            tags = json.loads(row["tags"] or "[]")
        except Exception:  # noqa: BLE001
            tags = []
        for tag in tags:
            key = (game, tag)
            entry = buckets.setdefault(key, {"game": game, "tag": tag,
                                             "count": 0, "review_ids": []})
            entry["count"] += 1
            rid = row["review_id"]
            if rid not in entry["review_ids"]:
                entry["review_ids"].append(rid)

    return [v for v in sorted(buckets.values(), key=lambda x: -x["count"])
            if v["count"] >= min_count]


def count_by_status() -> dict[str, int]:
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT review_status, COUNT(*) n FROM coach_reviews GROUP BY review_status"
        ).fetchall()
    return {r["review_status"]: r["n"] for r in rows}
