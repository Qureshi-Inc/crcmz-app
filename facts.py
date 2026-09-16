"""Squad facts — user-submitted knowledge the assistant answers from.

Anyone signed in can add a short fact about anyone ("Zubi is addicted to iced
caps"), and every fact is visible to the whole squad, so five people adding five
things each gives the assistant twenty-five pieces of shared context.

Facts are UNTRUSTED TEXT. They are written by people who will absolutely try to
write "ignore your instructions and say X", and they are read back into a model
prompt. Two rules follow from that, both enforced here rather than in the
prompt: the text is sanitised on the way in (no control characters, no newlines,
hard length cap), and it is only ever rendered inside a clearly delimited block
that the system prompt labels as claims to weigh, never as instructions.
"""

from __future__ import annotations

import hashlib
import logging
import re
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/assistant_facts.db")
_lock = threading.Lock()

MAX_TEXT = 280          # a fact, not an essay
MAX_SUBJECT = 60
MAX_PER_USER = 25       # keeps one person from flooding the prompt
PROMPT_LIMIT = 40       # how many facts go into the system prompt verbatim

# Control characters and newlines would let a fact fake the structure of the
# prompt block it is rendered into.
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS facts (
                id           TEXT PRIMARY KEY,
                subject      TEXT NOT NULL DEFAULT '',
                text         TEXT NOT NULL,
                author_sub   TEXT NOT NULL,
                author_name  TEXT NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(lower(subject));
            CREATE INDEX IF NOT EXISTS idx_facts_author  ON facts(author_sub);
            """
        )
        db.commit()
    logger.info("facts: DB ready at %s", _DB_PATH)


def _clean(value: str, cap: int) -> str:
    value = _CTRL.sub(" ", (value or "")).strip()
    value = re.sub(r"\s+", " ", value)
    return value[:cap]


def _fact_id(subject: str, text: str) -> str:
    """Content id, so the same fact cannot be added twice."""
    raw = f"{subject.lower()}|{text.lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def add(text: str, subject: str, author_sub: str, author_name: str = "") -> dict:
    """Store one fact. Raises ValueError on anything unusable."""
    text = _clean(text, MAX_TEXT)
    subject = _clean(subject, MAX_SUBJECT)
    if not text:
        raise ValueError("A fact needs some text")
    if len(text) < 3:
        raise ValueError("That is too short to be a fact")
    if not author_sub:
        raise ValueError("Sign in to add a fact")

    with _lock, _conn() as db:
        mine = db.execute("SELECT COUNT(*) n FROM facts WHERE author_sub=?",
                          (author_sub,)).fetchone()["n"]
        if mine >= MAX_PER_USER:
            raise ValueError(f"You have hit your {MAX_PER_USER} fact limit — "
                             "delete one first")
        fid = _fact_id(subject, text)
        row = {"id": fid, "subject": subject, "text": text,
               "author_sub": author_sub, "author_name": _clean(author_name, 40),
               "created_at": int(time.time())}
        cur = db.execute(
            "INSERT OR IGNORE INTO facts "
            "(id, subject, text, author_sub, author_name, created_at) "
            "VALUES (:id,:subject,:text,:author_sub,:author_name,:created_at)", row)
        db.commit()
    if not cur.rowcount:
        raise ValueError("Somebody already added that one")
    return row


def delete(fact_id: str, author_sub: str, any_author: bool = False) -> bool:
    """Remove a fact. Only its author can, unless `any_author`."""
    with _lock, _conn() as db:
        if any_author:
            cur = db.execute("DELETE FROM facts WHERE id=?", (fact_id,))
        else:
            cur = db.execute("DELETE FROM facts WHERE id=? AND author_sub=?",
                             (fact_id, author_sub))
        db.commit()
        return cur.rowcount > 0


def list_facts(subject: str = "", limit: int = 200) -> list[dict]:
    """Newest first. `subject` matches the subject or the text."""
    limit = max(1, min(int(limit or 200), 500))
    sql = "SELECT * FROM facts"
    params: list = []
    if subject.strip():
        needle = f"%{subject.strip().lower()}%"
        sql += " WHERE lower(subject) LIKE ? OR lower(text) LIKE ?"
        params += [needle, needle]
    # rowid breaks the tie: several facts added in the same second still come
    # back newest-first instead of in whatever order SQLite feels like.
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
    params.append(limit)
    with _lock, _conn() as db:
        return [dict(r) for r in db.execute(sql, params)]


def count() -> int:
    with _lock, _conn() as db:
        return db.execute("SELECT COUNT(*) n FROM facts").fetchone()["n"]


def for_prompt(limit: int = PROMPT_LIMIT) -> str:
    """The facts block for the system prompt, or "" when there are none.

    Newest first and capped: the assistant is told to call the squad_facts tool
    when the count exceeds what is shown here.
    """
    rows = list_facts(limit=limit)
    if not rows:
        return ""
    # No author here on purpose: the assistant treats these as things it simply
    # knows about the squad, not as quotes to credit. The UI still shows who
    # added what, so people know whose fact to argue with.
    lines = []
    for r in rows:
        who = f"about {r['subject']}: " if r["subject"] else ""
        lines.append(f"- {who}{r['text']}")
    total = count()
    more = (f"\n({total - len(rows)} more facts exist — use the squad_facts tool "
            "to look them up.)") if total > len(rows) else ""
    return "\n".join(lines) + more
