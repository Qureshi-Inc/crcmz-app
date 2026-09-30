"""Friend-uploaded videos queued for Muse to post to Instagram, TikTok and YouTube.

A clan member uploads a video from their phone; it is archived permanently to the
clip store and queued here. Muse polls `pending_video_uploads`, renders per
platform, posts, and reports each live permalink back through
`video_post_record` — one call per platform, in whatever order the posts land.
A video is `posted` only once all three links are present. Muse can instead mark
it `skipped` with a reason the uploader sees.

This platform never posts anything itself. The flow ends when Muse records.

Uploads arrive in chunks (see `start_session` / `append_chunk`) because the public
host sits behind Cloudflare, which refuses a request body over 100 MB — a single
200 MB POST would never reach the app. They are resumable: starting again with the
same file (same `file_key`) continues the member's open session from the last
byte the server has, so a dropped connection or a reloaded page loses nothing.

Two invariants are enforced by the schema rather than by a check-then-insert, so
two racing requests cannot both win:

* one queued video per member   — partial UNIQUE index on (zitadel_id) WHERE queued
* no byte-identical re-upload    — UNIQUE (sha256, file_size_bytes), the same twin
                                   rule PSN clips use, across every status

DB: /data/video_uploads.db    staging: /data/video_uploads_staging
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import subprocess
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("VIDEO_UPLOADS_DB", "/data/video_uploads.db"))
_STAGING_DIR = Path(os.environ.get("VIDEO_UPLOADS_STAGING", "/data/video_uploads_staging"))
_lock = threading.Lock()

MAX_BYTES = 0            # no size cap — chunked upload handles any size
MAX_SECONDS = 600.0      # 10 minutes; Instagram skips >90s (Muse decides per platform)
# Instagram refuses a reel under 3 s, so a shorter file would only sit in the
# queue — holding the member's one slot — until Muse skipped it.
MIN_SECONDS = 3.0
MAX_CAPTION = 150
CHUNK_BYTES = 8 * 1024 * 1024        # well under Cloudflare's 100 MB body limit
STAGING_TTL = 24 * 3600              # abandoned half-uploads are swept after this

PLATFORMS = ("instagram", "tiktok", "youtube")
_EXT_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime"}


class Rejected(Exception):
    """A user-facing refusal. `str(e)` is shown in the app as-is."""

    def __init__(self, message: str, code: str = "rejected", **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STAGING_DIR.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS video_posts (
                video_post_id    TEXT PRIMARY KEY,
                zitadel_id       TEXT NOT NULL,
                psn_id           TEXT NOT NULL,
                caption          TEXT,
                filename         TEXT NOT NULL DEFAULT '',
                content_type     TEXT NOT NULL,
                storage_key      TEXT NOT NULL,
                sha256           TEXT NOT NULL,
                file_size_bytes  INTEGER NOT NULL,
                duration_seconds REAL NOT NULL,
                status           TEXT NOT NULL DEFAULT 'queued',
                skip_reason      TEXT,
                uploaded_at      REAL NOT NULL,
                posted_at        REAL,
                skipped_at       REAL,
                notified_at      REAL,
                UNIQUE (sha256, file_size_bytes)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_vp_one_queued
                ON video_posts(zitadel_id) WHERE status = 'queued';
            CREATE INDEX IF NOT EXISTS idx_vp_queue
                ON video_posts(status, uploaded_at);
            CREATE TABLE IF NOT EXISTS video_post_links (
                video_post_id TEXT NOT NULL,
                platform      TEXT NOT NULL,
                url           TEXT NOT NULL,
                media_id      TEXT,
                recorded_at   REAL NOT NULL,
                updated_at    REAL NOT NULL,
                PRIMARY KEY (video_post_id, platform)
            );
            CREATE TABLE IF NOT EXISTS upload_sessions (
                upload_id   TEXT PRIMARY KEY,
                zitadel_id  TEXT NOT NULL,
                psn_id      TEXT NOT NULL,
                filename    TEXT NOT NULL,
                caption     TEXT,
                size        INTEGER NOT NULL,
                received    INTEGER NOT NULL DEFAULT 0,
                created_at  REAL NOT NULL
            );
        """)
        for col_sql in [
            "ALTER TABLE upload_sessions ADD COLUMN file_key TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE video_posts ADD COLUMN dm_notified_at REAL",
            "ALTER TABLE video_posts ADD COLUMN media_purged_at REAL",
        ]:
            try:
                db.execute(col_sql)
            except sqlite3.OperationalError:
                pass
        db.commit()
    logger.info("video_uploads: DB ready at %s", _DB_PATH)


# ── Upload staging ────────────────────────────────────────────────────────────

def _staged(upload_id: str) -> Path:
    # upload_id is always our own uuid4 hex, never request text — but re-check the
    # shape so a bad row can never name a path outside the staging dir.
    if not re.fullmatch(r"[0-9a-f]{32}", upload_id or ""):
        raise Rejected("bad upload id", "bad_upload")
    return _STAGING_DIR / f"{upload_id}.part"


def sweep_stale() -> None:
    """Delete half-finished uploads older than STAGING_TTL. Called at startup and
    on every new upload; never from init(), which the read tool calls."""
    cutoff = time.time() - STAGING_TTL
    with _lock, _conn() as db:
        rows = db.execute("SELECT upload_id FROM upload_sessions WHERE created_at < ?",
                          (cutoff,)).fetchall()
        db.execute("DELETE FROM upload_sessions WHERE created_at < ?", (cutoff,))
        db.commit()
    for r in rows:
        _staged(r["upload_id"]).unlink(missing_ok=True)


def clean_caption(caption: str | None) -> str | None:
    text = " ".join(str(caption or "").split())
    if len(text) > MAX_CAPTION:
        raise Rejected(f"caption is too long — {MAX_CAPTION} characters max", "caption")
    return text or None


def queued_for(zitadel_id: str) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute("SELECT * FROM video_posts WHERE zitadel_id=? AND status='queued'",
                         (zitadel_id,)).fetchone()
    return dict(row) if row else None


_QUEUED_MSG = ("your previous video hasn't been posted yet — you can upload another "
               "once it is posted or skipped")


def _file_key(raw: str | None) -> str:
    # Client-built identity of the file (name, size, mtime, hash of its first MB).
    # Only ever compared for equality, so just bound it.
    return re.sub(r"[^A-Za-z0-9_.:|-]", "", str(raw or ""))[:200]


def open_session(zitadel_id: str) -> dict | None:
    """The member's unfinished upload, for the page to offer a resume."""
    with _lock, _conn() as db:
        row = db.execute("SELECT upload_id, filename, size, received, created_at"
                         " FROM upload_sessions WHERE zitadel_id=? AND created_at >= ?",
                         (zitadel_id, time.time() - STAGING_TTL)).fetchone()
    if not row:
        return None
    return {**dict(row), "expires_at": row["created_at"] + STAGING_TTL}


def _resume(zitadel_id: str, filename: str, size: int, file_key: str,
            caption: str | None) -> dict | None:
    """Continue the member's open session if it is for this same file.

    The staged file is the truth for how much arrived: a crash between the write
    and the counter update can leave it longer than `received`, so it is cut back
    to `received` rather than trusted, and a shorter file pulls `received` down.
    """
    if not file_key:
        return None
    with _lock, _conn() as db:
        # Not matched on filename: iOS hands the same video over under a new name.
        row = db.execute("SELECT * FROM upload_sessions WHERE zitadel_id=? AND file_key=?"
                         " AND size=? AND created_at >= ?",
                         (zitadel_id, file_key, size, time.time() - STAGING_TTL)).fetchone()
        if not row:
            return None
        path = _staged(row["upload_id"])
        on_disk = path.stat().st_size if path.is_file() else 0
        received = min(row["received"], on_disk)
        if on_disk != received or not path.is_file():
            with path.open("ab") as fh:
                fh.truncate(received)
        db.execute("UPDATE upload_sessions SET received=?, caption=? WHERE upload_id=?",
                   (received, caption, row["upload_id"]))
        db.commit()
    return {"upload_id": row["upload_id"], "chunk_bytes": CHUNK_BYTES, "size": size,
            "received": received, "resumed": True}


def start_session(zitadel_id: str, psn_id: str, filename: str, size: int,
                  caption: str | None, file_key: str | None = None) -> dict:
    """Validate what can be checked before any bytes move, then open a staging file
    — or resume the member's open one when `file_key` says it is the same file.

    A member has at most one open session: starting a different file discards the
    old one, so a reloaded page cannot leave orphans that count against anything.
    """
    ext = Path(filename or "").suffix.lower()
    if ext not in _EXT_TYPES:
        raise Rejected("only .mp4 or .mov videos can be uploaded", "format")
    size = int(size or 0)
    if size <= 0:
        raise Rejected("that file is empty", "empty")
    caption = clean_caption(caption)
    if queued_for(zitadel_id):
        raise Rejected(_QUEUED_MSG, "already_queued")

    sweep_stale()
    file_key = _file_key(file_key)
    resumed = _resume(zitadel_id, filename, size, file_key, caption)
    if resumed:
        return resumed
    upload_id = uuid.uuid4().hex
    with _lock, _conn() as db:
        old = db.execute("SELECT upload_id FROM upload_sessions WHERE zitadel_id=?",
                         (zitadel_id,)).fetchall()
        db.execute("DELETE FROM upload_sessions WHERE zitadel_id=?", (zitadel_id,))
        db.execute(
            "INSERT INTO upload_sessions (upload_id, zitadel_id, psn_id, filename,"
            " caption, size, received, created_at, file_key) VALUES (?,?,?,?,?,?,0,?,?)",
            (upload_id, zitadel_id, psn_id, Path(filename).name[:120], caption,
             size, time.time(), file_key))
        db.commit()
    for r in old:
        _staged(r["upload_id"]).unlink(missing_ok=True)
    _staged(upload_id).write_bytes(b"")
    return {"upload_id": upload_id, "chunk_bytes": CHUNK_BYTES, "size": size,
            "received": 0, "resumed": False}


def _session(upload_id: str, zitadel_id: str) -> dict:
    with _lock, _conn() as db:
        row = db.execute("SELECT * FROM upload_sessions WHERE upload_id=? AND zitadel_id=?",
                         (upload_id, zitadel_id)).fetchone()
    if not row:
        # Someone else's id reads exactly like an expired one: no oracle.
        raise Rejected("upload not found or expired — start again", "no_session")
    return dict(row)


def append_chunk(upload_id: str, zitadel_id: str, offset: int, data: bytes) -> dict:
    """Append one chunk. `offset` must equal what has been received, so a retried
    chunk is refused rather than written twice."""
    s = _session(upload_id, zitadel_id)
    if len(data) > CHUNK_BYTES:
        raise Rejected("chunk too large", "chunk")
    if int(offset) != s["received"]:
        # A retried chunk whose first attempt did land arrives here; the client
        # reads `received` and carries on from there.
        raise Rejected("chunk out of order — expected offset %d" % s["received"], "offset",
                       received=s["received"])
    if s["received"] + len(data) > s["size"]:
        raise Rejected("more data than the declared file size", "too_large")
    with _lock:
        with _staged(upload_id).open("ab") as fh:
            fh.write(data)
        with _conn() as db:
            db.execute("UPDATE upload_sessions SET received=received+? WHERE upload_id=?",
                       (len(data), upload_id))
            db.commit()
    return {"received": s["received"] + len(data), "size": s["size"]}


def probe(path: Path) -> dict:
    """Container and duration from ffprobe. Raises Rejected on anything unreadable."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, timeout=60, check=False)
        info = json.loads(out.stdout or b"{}")
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        logger.warning("video_uploads: ffprobe failed on %s: %s", path, e)
        raise Rejected("could not read that video", "unreadable") from e
    fmt = info.get("format") or {}
    names = set((fmt.get("format_name") or "").split(","))
    if not names & {"mov", "mp4"}:
        raise Rejected("that file is not an MP4 or MOV video", "format")
    if not any(s.get("codec_type") == "video" for s in info.get("streams") or []):
        raise Rejected("that file has no video track", "format")
    try:
        duration = float(fmt.get("duration") or 0)
    except ValueError:
        duration = 0.0
    if duration <= 0:
        raise Rejected("could not read that video's length", "unreadable")
    return {"duration_seconds": round(duration, 2)}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def find_twin(sha256: str, size: int) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute("SELECT * FROM video_posts WHERE sha256=? AND file_size_bytes=?",
                         (sha256, int(size))).fetchone()
    return dict(row) if row else None


def finish_session(upload_id: str, zitadel_id: str, archive_file) -> dict:
    """Validate the staged file, archive it, and queue it.

    `archive_file(key, path, content_type) -> bool` is clip_store.archive_file,
    passed in so tests can point it anywhere. The staging file and session are
    removed whatever the outcome — a refused upload has to be re-sent anyway.
    """
    s = _session(upload_id, zitadel_id)
    path = _staged(upload_id)
    try:
        if s["received"] != s["size"] or not path.is_file() \
                or path.stat().st_size != s["size"]:
            raise Rejected("upload incomplete — start again", "incomplete")
        meta = probe(path)
        dur = meta["duration_seconds"]
        if dur > MAX_SECONDS:
            raise Rejected(f"that video is {dur:.0f}s — the limit is {MAX_SECONDS:.0f}s",
                           "too_long")
        if dur < MIN_SECONDS:
            raise Rejected(f"that video is under {MIN_SECONDS:.0f}s — Instagram won't "
                           "post it", "too_short")
        digest = _sha256(path)
        twin = find_twin(digest, s["size"])
        if twin:
            raise Rejected("that exact video was already uploaded" +
                           (" (it was skipped)" if twin["status"] == "skipped" else ""),
                           "duplicate")
        if queued_for(zitadel_id):
            raise Rejected(_QUEUED_MSG, "already_queued")

        vid = uuid.uuid4().hex
        ext = Path(s["filename"]).suffix.lower()
        ctype = _EXT_TYPES.get(ext, "video/mp4")
        now = time.time()
        t = time.gmtime(now)
        key = f"clips/uploads/{t.tm_year}/{t.tm_mon:02d}/{vid}{ext}"
        # Archive before the row exists: a row must never point at missing media.
        # An insert that then loses a race leaves an unreferenced file, which is
        # the safe direction for a store that never deletes.
        if not archive_file(key, path, ctype):
            raise Rejected("storage is unavailable — try again shortly", "storage")
        try:
            with _lock, _conn() as db:
                db.execute(
                    "INSERT INTO video_posts (video_post_id, zitadel_id, psn_id, caption,"
                    " filename, content_type, storage_key, sha256, file_size_bytes,"
                    " duration_seconds, status, uploaded_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?)",
                    (vid, zitadel_id, s["psn_id"], s["caption"], s["filename"], ctype,
                     key, digest, s["size"], dur, now))
                db.commit()
        except sqlite3.IntegrityError as e:
            if "sha256" in str(e):
                raise Rejected("that exact video was already uploaded", "duplicate") from e
            raise Rejected(_QUEUED_MSG, "already_queued") from e
        return get(vid)
    finally:
        path.unlink(missing_ok=True)
        with _lock, _conn() as db:
            db.execute("DELETE FROM upload_sessions WHERE upload_id=?", (upload_id,))
            db.commit()


# ── Reads ─────────────────────────────────────────────────────────────────────

def _links(db: sqlite3.Connection, ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {i: {} for i in ids}
    if not ids:
        return out
    q = ",".join("?" * len(ids))
    for r in db.execute(f"SELECT * FROM video_post_links WHERE video_post_id IN ({q})", ids):
        out[r["video_post_id"]][r["platform"]] = {
            "url": r["url"], "media_id": r["media_id"], "recorded_at": r["recorded_at"]}
    return out


def _with_links(rows: list[sqlite3.Row], db: sqlite3.Connection) -> list[dict]:
    items = [dict(r) for r in rows]
    links = _links(db, [i["video_post_id"] for i in items])
    for i in items:
        got = links.get(i["video_post_id"], {})
        i["platforms"] = {p: got.get(p) for p in PLATFORMS}
    return items


def get(video_post_id: str) -> dict | None:
    with _lock, _conn() as db:
        rows = db.execute("SELECT * FROM video_posts WHERE video_post_id=?",
                          (video_post_id,)).fetchall()
        items = _with_links(rows, db)
    return items[0] if items else None


def for_member(zitadel_id: str, limit: int = 20) -> list[dict]:
    limit = max(1, min(int(limit or 20), 100))
    with _lock, _conn() as db:
        rows = db.execute("SELECT * FROM video_posts WHERE zitadel_id=?"
                          " ORDER BY uploaded_at DESC LIMIT ?", (zitadel_id, limit)).fetchall()
        return _with_links(rows, db)


def pending(offset: int = 0, limit: int = 20) -> dict:
    """Queued videos, oldest first. A partly posted video stays queued (and listed)
    until every platform has a link, so Muse can see which posts remain."""
    offset = max(0, int(offset or 0))
    limit = max(1, min(int(limit or 20), 50))
    with _lock, _conn() as db:
        total = db.execute("SELECT COUNT(*) FROM video_posts WHERE status='queued'"
                           ).fetchone()[0]
        rows = db.execute("SELECT * FROM video_posts WHERE status='queued'"
                          " ORDER BY uploaded_at ASC LIMIT ? OFFSET ?",
                          (limit, offset)).fetchall()
        items = _with_links(rows, db)
    nxt = offset + len(items)
    return {"items": items, "total": total, "offset": offset,
            "has_more": nxt < total, "next_offset": nxt if nxt < total else None}


# ── Post results (called by Muse through the write tools) ─────────────────────

def record_link(video_post_id: str, platform: str, url: str,
                media_id: str | None = None) -> dict:
    """Store one platform's permalink. Idempotent per (video_post_id, platform):
    the same URL again changes nothing; a different URL replaces it (a correction)
    without touching the other platforms. Flips queued -> posted exactly once, in
    the same transaction, when the third link lands."""
    if platform not in PLATFORMS:
        raise Rejected(f"platform must be one of {', '.join(PLATFORMS)}", "platform")
    now = time.time()
    with _lock, _conn() as db:
        row = db.execute("SELECT status FROM video_posts WHERE video_post_id=?",
                         (video_post_id,)).fetchone()
        if not row:
            raise Rejected("no video with that video_post_id", "not_found")
        if row["status"] == "skipped":
            raise Rejected("that video was skipped; it cannot take post links", "skipped")
        prev = db.execute("SELECT url, media_id FROM video_post_links"
                          " WHERE video_post_id=? AND platform=?",
                          (video_post_id, platform)).fetchone()
        if prev and prev["url"] == url and (not media_id or media_id == prev["media_id"]):
            changed = False
        elif prev:
            db.execute("UPDATE video_post_links SET url=?, media_id=COALESCE(?, media_id),"
                       " updated_at=? WHERE video_post_id=? AND platform=?",
                       (url, media_id or None, now, video_post_id, platform))
            changed = True
        else:
            db.execute("INSERT INTO video_post_links (video_post_id, platform, url,"
                       " media_id, recorded_at, updated_at) VALUES (?,?,?,?,?,?)",
                       (video_post_id, platform, url, media_id or None, now, now))
            changed = True
        q = ",".join("?" * len(PLATFORMS))
        cur = db.execute(
            "UPDATE video_posts SET status='posted', posted_at=? WHERE video_post_id=?"
            f" AND status='queued' AND (SELECT COUNT(*) FROM video_post_links"
            f" WHERE video_post_id=? AND platform IN ({q})) = ?",
            (now, video_post_id, video_post_id, *PLATFORMS, len(PLATFORMS)))
        became_posted = cur.rowcount == 1
        db.commit()
    return {"changed": changed, "became_posted": became_posted,
            **({"replaced_url": prev["url"]} if prev and prev["url"] != url else {})}


def skip(video_post_id: str, reason: str, *, only_if_unposted: bool = False) -> dict:
    """queued -> skipped, exactly once. A repeat returns already_skipped with the
    stored reason. `only_if_unposted` (the uploader withdrawing) also refuses once
    any platform has a link, since by then the video is public."""
    now = time.time()
    with _lock, _conn() as db:
        row = db.execute("SELECT status, skip_reason FROM video_posts WHERE video_post_id=?",
                         (video_post_id,)).fetchone()
        if not row:
            raise Rejected("no video with that video_post_id", "not_found")
        if row["status"] == "skipped":
            return {"already_skipped": True, "reason": row["skip_reason"]}
        if row["status"] == "posted":
            raise Rejected("that video is already posted", "posted")
        guard = (" AND NOT EXISTS (SELECT 1 FROM video_post_links WHERE video_post_id=?)"
                 if only_if_unposted else "")
        args = (reason, now, video_post_id) + ((video_post_id,) if only_if_unposted else ())
        cur = db.execute("UPDATE video_posts SET status='skipped', skip_reason=?,"
                         " skipped_at=? WHERE video_post_id=? AND status='queued'" + guard,
                         args)
        db.commit()
    if cur.rowcount != 1:
        raise Rejected("it has already started posting, so it can't be withdrawn", "posting")
    return {"already_skipped": False, "reason": reason}


def claim_notification(video_post_id: str) -> bool:
    """Atomic: UPDATE WHERE notified_at IS NULL. rowcount==1 means you won."""
    with _lock, _conn() as db:
        cur = db.execute("UPDATE video_posts SET notified_at=? WHERE video_post_id=?"
                         " AND notified_at IS NULL", (time.time(), video_post_id))
        db.commit()
        return cur.rowcount == 1


def release_notification(video_post_id: str) -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE video_posts SET notified_at=NULL WHERE video_post_id=?",
                   (video_post_id,))
        db.commit()


def claim_dm_notification(video_post_id: str) -> bool:
    """Atomic claim for the 'all platforms live' DM to the uploader. rowcount==1 means you won."""
    with _lock, _conn() as db:
        cur = db.execute("UPDATE video_posts SET dm_notified_at=? WHERE video_post_id=?"
                         " AND dm_notified_at IS NULL", (time.time(), video_post_id))
        db.commit()
        return cur.rowcount == 1


def release_dm_notification(video_post_id: str) -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE video_posts SET dm_notified_at=NULL WHERE video_post_id=?",
                   (video_post_id,))
        db.commit()


def purgeable_before(ts: float) -> list[dict]:
    """Posted or skipped uploads older than `ts` whose media is still stored.
    Queued videos are never returned, whatever their age."""
    with _lock, _conn() as db:
        rows = db.execute("SELECT video_post_id, storage_key FROM video_posts"
                          " WHERE status IN ('posted','skipped') AND uploaded_at < ?"
                          " AND media_purged_at IS NULL", (ts,)).fetchall()
    return [dict(r) for r in rows]


def set_media_purged(video_post_id: str) -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE video_posts SET media_purged_at=? WHERE video_post_id=?",
                   (time.time(), video_post_id))
        db.commit()


# ── Link validation ───────────────────────────────────────────────────────────

_TIKTOK = re.compile(r"^https?://(?:www\.|m\.)?tiktok\.com/@([A-Za-z0-9._]{1,64})/video/(\d{5,25})")
_YT_SHORT = re.compile(r"^https?://(?:www\.|m\.)?youtube\.com/shorts/([A-Za-z0-9_-]{11})")
_YT_WATCH = re.compile(r"^https?://(?:www\.|m\.)?youtube\.com/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})")
_YT_BE = re.compile(r"^https?://youtu\.be/([A-Za-z0-9_-]{11})")


def normalise_tiktok(url: str) -> tuple[str | None, str | None]:
    m = _TIKTOK.match((url or "").strip())
    if not m:
        return None, ("must be a full TikTok video URL like "
                      "https://www.tiktok.com/@crcmzclan/video/<id> — resolve short "
                      "vm.tiktok.com links first")
    return f"https://www.tiktok.com/@{m.group(1)}/video/{m.group(2)}", None


def normalise_youtube(url: str) -> tuple[str | None, str | None]:
    u = (url or "").strip()
    m = _YT_SHORT.match(u)
    if m:
        return f"https://www.youtube.com/shorts/{m.group(1)}", None
    m = _YT_WATCH.match(u) or _YT_BE.match(u)
    if m:
        return f"https://www.youtube.com/watch?v={m.group(1)}", None
    return None, ("must be a YouTube URL like https://www.youtube.com/shorts/<id> or "
                  "https://www.youtube.com/watch?v=<id>")
