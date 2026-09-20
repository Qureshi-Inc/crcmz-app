"""App semantic events store.

Stores meaningful human-readable events about this application:
features shipped, decisions made, deployments, migrations, incidents.
NOT general telemetry, health checks, or request logs.

DB: /data/app_events.db
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import subprocess
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/app_events.db")
_lock = threading.Lock()

VALID_EVENT_TYPES = {
    "feature_shipped", "feature_changed", "release", "decision",
    "admin_note", "support_issue", "error", "migration",
    "config_change", "incident",
}

# Commit subject prefixes that map to semantic event types
_PREFIX_MAP = {
    "feat":      "feature_shipped",
    "fix":       "error",
    "docs":      "admin_note",
    "refactor":  "feature_changed",
    "migration": "migration",
    "chore":     "config_change",
    "perf":      "feature_changed",
    "build":     "release",
    "ci":        "config_change",
    "deploy":    "release",
}


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS app_events (
                event_id      TEXT PRIMARY KEY,
                event_type    TEXT NOT NULL,
                title         TEXT NOT NULL,
                text          TEXT NOT NULL,
                created_at    REAL NOT NULL,
                actor         TEXT,
                feature       TEXT,
                reference     TEXT,
                metadata_json TEXT,
                content_hash  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_app_events_type
                ON app_events(event_type, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_app_events_hash
                ON app_events(content_hash);
        """)
        db.commit()
    logger.info("app_events: DB ready at %s", _DB_PATH)


def record(
    event_type: str,
    title: str,
    text: str,
    actor: str | None = None,
    feature: str | None = None,
    reference: str | None = None,
    metadata: dict | None = None,
    _created_at: float | None = None,
) -> str | None:
    """Record a semantic event.  Returns the new event_id, or None if duplicate.

    _created_at: override the creation timestamp (epoch-seconds).  Used by
    backfill_from_git() to preserve the original commit date.
    """
    content_hash = hashlib.sha256(f"{title}|{text}".encode()).hexdigest()
    with _lock, _conn() as db:
        existing = db.execute(
            "SELECT event_id FROM app_events WHERE content_hash = ?",
            (content_hash,),
        ).fetchone()
        if existing:
            return None  # idempotent — already recorded
        event_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO app_events
               (event_id, event_type, title, text, created_at,
                actor, feature, reference, metadata_json, content_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event_id,
                event_type,
                title,
                text,
                _created_at if _created_at is not None else time.time(),
                actor,
                feature,
                reference,
                json.dumps(metadata) if metadata else None,
                content_hash,
            ),
        )
        db.commit()
    return event_id


def list_events(
    limit: int = 20,
    event_type: str | None = None,
    feature: str | None = None,
    since_ts: float | None = None,
) -> list[dict]:
    limit = max(1, min(int(limit or 20), 500))
    sql = "SELECT * FROM app_events WHERE 1=1"
    params: list = []
    if event_type:
        sql += " AND event_type = ?"
        params.append(event_type)
    if feature:
        sql += " AND feature = ?"
        params.append(feature)
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
                d["metadata"] = None
        out.append(d)
    return out


def get(event_id: str) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT * FROM app_events WHERE event_id = ?", (event_id,)
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
        return db.execute("SELECT COUNT(*) n FROM app_events").fetchone()["n"]


def _classify_commit(subject: str) -> str:
    """Map a conventional commit subject prefix to an event_type."""
    lower = subject.lower()
    for prefix, event_type in _PREFIX_MAP.items():
        if lower.startswith(prefix + "(") or lower.startswith(prefix + ":"):
            return event_type
    for keyword in ("deploy", "release", "breaking"):
        if keyword in lower:
            return "release" if keyword in ("deploy", "release") else "feature_changed"
    return "admin_note"


def _load_commit_manifest(repo_path: str) -> list[dict]:
    """Try to load the pre-built git commit manifest from the Docker image."""
    manifest = Path(repo_path) / "git_commits.json"
    if not manifest.exists():
        return []
    try:
        with open(manifest) as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except Exception:  # noqa: BLE001
        pass
    return []


def backfill_from_git(repo_path: str = "/app", limit: int = 10) -> int:
    """Backfill semantic events from git commit history.

    Tries a pre-built manifest file (git_commits.json, generated at Docker
    build time) before shelling out to live git.  The manifest is the
    production path since .git is not present in the container image.

    Only includes commits whose subjects look like meaningful events
    (feat/fix/docs/refactor/migration/deploy/release/breaking).
    Idempotent (content_hash dedup).  Returns count of newly inserted events.
    """
    commits = _load_commit_manifest(repo_path)

    if not commits:
        # Fall back to live git (dev / test environments)
        try:
            result = subprocess.run(
                ["git", "log", "--format=%H|%aI|%an|%s", "--no-merges",
                 f"-n{limit * 3}"],
                cwd=repo_path,
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode == 0:
                for line in result.stdout.strip().splitlines():
                    parts = line.split("|", 3)
                    if len(parts) == 4:
                        commits.append({
                            "hash": parts[0], "date": parts[1],
                            "author": parts[2], "subject": parts[3],
                        })
        except Exception as e:  # noqa: BLE001
            logger.warning("app_events.backfill_from_git: git unavailable: %s", e)
            return 0

    if not commits:
        logger.debug("app_events.backfill_from_git: no commits found")
        return 0

    import datetime as _dt
    inserted = 0
    for c in commits:
        subject = c.get("subject", "")
        if not subject:
            continue
        lower = subject.lower()
        is_semantic = any(
            lower.startswith(p + "(") or lower.startswith(p + ":")
            for p in _PREFIX_MAP
        ) or any(kw in lower for kw in ("deploy", "release", "breaking", "decision"))
        if not is_semantic:
            continue

        commit_hash = c.get("hash", "")
        date_str = c.get("date", "")
        author = c.get("author", "")
        body = c.get("body", "")
        event_type = _classify_commit(subject)
        text = body.strip() if body and body.strip() else subject

        try:
            ts = _dt.datetime.fromisoformat(date_str.replace("Z", "+00:00")).timestamp()
        except Exception:  # noqa: BLE001
            ts = time.time()

        # Use commit hash in content_hash so each commit is uniquely deduped
        content_hash = hashlib.sha256(f"{subject}|{commit_hash}".encode()).hexdigest()
        with _lock, _conn() as db:
            existing = db.execute(
                "SELECT event_id FROM app_events WHERE content_hash = ?",
                (content_hash,),
            ).fetchone()
            if existing:
                continue
            event_id = str(uuid.uuid4())
            db.execute(
                """INSERT INTO app_events
                   (event_id, event_type, title, text, created_at,
                    actor, reference, metadata_json, content_hash)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    event_id, event_type, subject, text, ts,
                    author, commit_hash,
                    json.dumps({"commit": commit_hash, "date": date_str}),
                    content_hash,
                ),
            )
            db.commit()
        inserted += 1
        if inserted >= limit:
            break

    logger.info("app_events.backfill_from_git: inserted %d events", inserted)
    return inserted
