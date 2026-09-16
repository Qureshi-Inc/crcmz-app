"""Ask AI chat history — one thread per person, stored server-side.

Two reasons this lives on the server instead of in the browser:

1. The thread is the same on the phone and the desktop, and /api/assistant/ask
   feeds the model the real previous turns instead of trusting what the browser
   sends back.
2. A question takes seconds to answer, and a phone that locks or a tab that gets
   backgrounded kills the in-flight request -- the answer was simply lost. So the
   reply row is written as `pending` the moment the question is asked, the model
   runs in a background task, and the row is filled in when it finishes. Walking
   away no longer cancels anything: the answer is waiting in the thread.

Each person only sees their own thread. Squad facts are shared knowledge;
conversations are not.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/assistant_chat.db")
_lock = threading.Lock()

MAX_KEPT = 120          # messages retained per person; older ones are trimmed
CONTEXT_TURNS = 8       # how many messages are replayed to the model
MAX_CONTENT = 4000      # a single stored message
STALE_PENDING_SEC = 600  # a reply still pending after this is considered dead

INTERRUPTED = "(that one got interrupted — ask me again)"


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_sub   TEXT NOT NULL,
                role       TEXT NOT NULL,
                content    TEXT NOT NULL DEFAULT '',
                status     TEXT NOT NULL DEFAULT 'done',
                tools      TEXT NOT NULL DEFAULT '[]',
                elapsed_ms INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_user ON messages(user_sub, id);
            """
        )
        # A reply left pending by a restart would spin forever in the UI.
        stuck = db.execute(
            "UPDATE messages SET status='error', content=? "
            "WHERE status='pending' AND content=''", (INTERRUPTED,)).rowcount
        db.commit()
    if stuck:
        logger.info("chat history: released %d interrupted repl%s",
                    stuck, "y" if stuck == 1 else "ies")
    logger.info("chat history: DB ready at %s", _DB_PATH)


def _trim(db, user_sub: str) -> None:
    db.execute(
        "DELETE FROM messages WHERE user_sub=? AND id NOT IN "
        "(SELECT id FROM messages WHERE user_sub=? ORDER BY id DESC LIMIT ?)",
        (user_sub, user_sub, MAX_KEPT),
    )


def start_turn(user_sub: str, question: str) -> int:
    """Record the question plus a pending reply. Returns the reply's row id."""
    if not user_sub or not (question or "").strip():
        raise ValueError("need a user and a question")
    now = int(time.time())
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO messages (user_sub, role, content, status, created_at) "
            "VALUES (?,?,?,'done',?)",
            (user_sub, "user", question[:MAX_CONTENT], now))
        cur = db.execute(
            "INSERT INTO messages (user_sub, role, content, status, created_at) "
            "VALUES (?,?,'','pending',?)", (user_sub, "assistant", now))
        _trim(db, user_sub)
        db.commit()
        return int(cur.lastrowid)


def finish_turn(reply_id: int, content: str, tools: list[str] | None = None,
                elapsed_ms: int = 0, status: str = "done") -> None:
    with _lock, _conn() as db:
        db.execute(
            "UPDATE messages SET content=?, status=?, tools=?, elapsed_ms=? WHERE id=?",
            ((content or "")[:MAX_CONTENT], status, json.dumps(tools or []),
             int(elapsed_ms), int(reply_id)))
        db.commit()


def fail_turn(reply_id: int, message: str) -> None:
    finish_turn(reply_id, message, status="error")


def pending(user_sub: str) -> dict | None:
    """The person's in-flight reply, if any and if it is not stale."""
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT id, created_at FROM messages "
            "WHERE user_sub=? AND status='pending' ORDER BY id DESC LIMIT 1",
            (user_sub,)).fetchone()
    if not row:
        return None
    if time.time() - row["created_at"] > STALE_PENDING_SEC:
        fail_turn(row["id"], INTERRUPTED)
        return None
    return {"id": row["id"], "created_at": row["created_at"]}


def recent(user_sub: str, limit: int = MAX_KEPT) -> list[dict]:
    """The thread in reading order (oldest first)."""
    if not user_sub:
        return []
    limit = max(1, min(int(limit or MAX_KEPT), MAX_KEPT))
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT id, role, content, status, tools, elapsed_ms, created_at "
            "FROM messages WHERE user_sub=? ORDER BY id DESC LIMIT ?",
            (user_sub, limit)).fetchall()
    out = []
    for r in reversed(rows):
        try:
            tools = json.loads(r["tools"] or "[]")
        except ValueError:
            tools = []
        out.append({"id": r["id"], "role": r["role"], "content": r["content"],
                    "status": r["status"], "tools": tools,
                    "elapsed_ms": r["elapsed_ms"], "created_at": r["created_at"]})
    return out


def context(user_sub: str, turns: int = CONTEXT_TURNS) -> list[dict]:
    """The tail of the thread for the model: finished turns, role + content.

    The question being asked right now is already stored (start_turn writes it
    before the model runs) and is passed to the model separately, so a trailing
    user message is dropped -- otherwise every question arrives twice.
    """
    msgs = [m for m in recent(user_sub, limit=MAX_KEPT)
            if m["status"] == "done" and m["content"]]
    while msgs and msgs[-1]["role"] == "user":
        msgs.pop()
    return [{"role": m["role"], "content": m["content"]} for m in msgs[-turns:]]


def clear(user_sub: str) -> int:
    if not user_sub:
        return 0
    with _lock, _conn() as db:
        cur = db.execute("DELETE FROM messages WHERE user_sub=?", (user_sub,))
        db.commit()
        return cur.rowcount


def count(user_sub: str) -> int:
    with _lock, _conn() as db:
        return db.execute("SELECT COUNT(*) n FROM messages WHERE user_sub=?",
                          (user_sub,)).fetchone()["n"]
