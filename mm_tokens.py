"""Per-user Mattermost OAuth token store.

Tokens are obtained via the Mattermost OAuth 2.0 flow and stored in
/data/mm_tokens.db, keyed by Zitadel user id (sub).
"""

from __future__ import annotations

import os
import sqlite3
import time
from typing import Optional

DB_PATH = os.environ.get("MM_TOKENS_DB", "/data/mm_tokens.db")


def init() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS mm_tokens (
                zitadel_id    TEXT PRIMARY KEY,
                access_token  TEXT NOT NULL,
                refresh_token TEXT NOT NULL DEFAULT '',
                expires_at    INTEGER NOT NULL,
                linked_at     INTEGER NOT NULL
            )
        """)
        conn.commit()


def store(zitadel_id: str, access_token: str, refresh_token: str,
          expires_in: int) -> None:
    expires_at = int(time.time()) + max(int(expires_in), 0)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            INSERT INTO mm_tokens
                (zitadel_id, access_token, refresh_token, expires_at, linked_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(zitadel_id) DO UPDATE SET
                access_token  = excluded.access_token,
                refresh_token = excluded.refresh_token,
                expires_at    = excluded.expires_at
        """, (zitadel_id, access_token, refresh_token, expires_at, int(time.time())))
        conn.commit()


def get_token(zitadel_id: str) -> Optional[str]:
    """Return a valid access token or None if missing or within 5 min of expiry."""
    if not zitadel_id:
        return None
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT access_token, expires_at FROM mm_tokens WHERE zitadel_id = ?",
                (zitadel_id,),
            ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    access_token, expires_at = row
    if expires_at and expires_at - time.time() < 300:
        return None
    return access_token


def is_linked(zitadel_id: str) -> bool:
    if not zitadel_id:
        return False
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT expires_at FROM mm_tokens WHERE zitadel_id = ?",
                (zitadel_id,),
            ).fetchone()
    except Exception:
        return False
    return row is not None


def linked_at(zitadel_id: str) -> Optional[int]:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT linked_at FROM mm_tokens WHERE zitadel_id = ?",
                (zitadel_id,),
            ).fetchone()
    except Exception:
        return None
    return row[0] if row else None


def unlink(zitadel_id: str) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM mm_tokens WHERE zitadel_id = ?", (zitadel_id,))
        conn.commit()
