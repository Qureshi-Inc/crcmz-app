"""Muse↔agent task queue.

Muse files tasks via task_submit; the AI agent claims, implements, and
completes them via task_claim / task_complete. task_release returns a
task to open so it can be retried.

Ordering: highest priority first, then oldest created_at within the same
priority level.

DB: /data/agent_tasks.db
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

_DB_PATH = Path(os.environ.get("AGENT_TASKS_DB", "/data/agent_tasks.db"))
_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS agent_tasks (
                id           TEXT PRIMARY KEY,
                title        TEXT NOT NULL,
                body         TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'open',
                priority     INTEGER NOT NULL DEFAULT 0,
                created_by   TEXT NOT NULL DEFAULT '',
                created_at   REAL NOT NULL,
                claimed_by   TEXT,
                claimed_at   REAL,
                completed_at REAL,
                result_notes TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_queue
                ON agent_tasks(status, priority DESC, created_at ASC);
        """)
        db.commit()
    logger.info("agent_tasks: DB ready at %s", _DB_PATH)


def submit(title: str, body: str, priority: int = 0,
           created_by: str = "") -> str:
    task_id = uuid.uuid4().hex
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO agent_tasks (id, title, body, priority, created_by, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (task_id, title, body, int(priority or 0), created_by or "", now))
        db.commit()
    return task_id


def list_tasks(status: str = "open", limit: int = 20) -> list[dict]:
    limit = max(1, min(int(limit or 20), 100))
    valid = ("open", "in_progress", "done", "failed", "all")
    if status not in valid:
        status = "open"
    with _lock, _conn() as db:
        if status == "all":
            rows = db.execute(
                "SELECT * FROM agent_tasks"
                " ORDER BY priority DESC, created_at ASC LIMIT ?",
                (limit,)).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM agent_tasks WHERE status=?"
                " ORDER BY priority DESC, created_at ASC LIMIT ?",
                (status, limit)).fetchall()
    return [dict(r) for r in rows]


def claim(task_id: str, agent_name: str) -> bool:
    """Atomic: succeeds only if status is 'open'. Returns True if this caller claimed it."""
    now = time.time()
    with _lock, _conn() as db:
        cur = db.execute(
            "UPDATE agent_tasks"
            " SET status='in_progress', claimed_by=?, claimed_at=?"
            " WHERE id=? AND status='open'",
            (agent_name, now, task_id))
        db.commit()
        return cur.rowcount == 1


def complete(task_id: str, result_notes: str = "") -> bool:
    """Mark as done. Only succeeds from in_progress."""
    now = time.time()
    with _lock, _conn() as db:
        cur = db.execute(
            "UPDATE agent_tasks SET status='done', completed_at=?, result_notes=?"
            " WHERE id=? AND status='in_progress'",
            (now, result_notes or None, task_id))
        db.commit()
        return cur.rowcount == 1


def release(task_id: str, note: str = "") -> bool:
    """Return an in-progress task to open, appending the note to result_notes."""
    with _lock, _conn() as db:
        row = db.execute("SELECT result_notes FROM agent_tasks WHERE id=? AND status='in_progress'",
                         (task_id,)).fetchone()
        if not row:
            return False
        prev = row["result_notes"] or ""
        new_notes = (prev + "\n" + note).strip() if note else prev
        cur = db.execute(
            "UPDATE agent_tasks"
            " SET status='open', claimed_by=NULL, claimed_at=NULL, result_notes=?"
            " WHERE id=? AND status='in_progress'",
            (new_notes or None, task_id))
        db.commit()
        return cur.rowcount == 1


def get(task_id: str) -> dict | None:
    with _lock, _conn() as db:
        row = db.execute("SELECT * FROM agent_tasks WHERE id=?",
                         (task_id,)).fetchone()
    return dict(row) if row else None
