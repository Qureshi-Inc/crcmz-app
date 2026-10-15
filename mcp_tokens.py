"""Personal bearer tokens for the MCP endpoint.

Each CRCMZ user can generate one long-lived bearer token that authenticates them
at /mcp without going through the OAuth flow. The raw token is stored and always
retrievable via the authenticated settings API — the session cookie is the only
gate, so only the owner can read their own token.
"""

from __future__ import annotations

import hmac
import secrets
import sqlite3

DB = "/data/mcp_tokens.db"


def init() -> None:
    with sqlite3.connect(DB) as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS personal_tokens (
                sub        TEXT PRIMARY KEY,
                token      TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)


def generate(sub: str) -> str:
    """Generate (or replace) a personal bearer token for *sub*. Returns the raw token."""
    token = "crcmz_" + secrets.token_urlsafe(32)
    with sqlite3.connect(DB) as c:
        c.execute(
            "INSERT OR REPLACE INTO personal_tokens (sub, token) VALUES (?,?)",
            (sub, token),
        )
    return token


def get_token(sub: str) -> str | None:
    """Return the raw token for *sub*, or None if they have none."""
    with sqlite3.connect(DB) as c:
        row = c.execute(
            "SELECT token FROM personal_tokens WHERE sub = ?", (sub,)
        ).fetchone()
    return row[0] if row else None


def verify(token: str) -> str | None:
    """Return the sub whose token matches, or None.

    Fetches all rows (bounded by squad size, ~10-20) and uses constant-time
    comparison so no timing oracle leaks token content.
    """
    if not token:
        return None
    with sqlite3.connect(DB) as c:
        rows = c.execute("SELECT sub, token FROM personal_tokens").fetchall()
    for sub, stored in rows:
        if hmac.compare_digest(stored, token):
            return sub
    return None


def revoke(sub: str) -> None:
    with sqlite3.connect(DB) as c:
        c.execute("DELETE FROM personal_tokens WHERE sub = ?", (sub,))
