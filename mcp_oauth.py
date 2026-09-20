"""OAuth 2.0 Authorization Server — per-user MCP tokens.

Authorization Code flow + PKCE (RFC 7636).  The browser-facing consent page is
in server.py at /oauth/authorize; this module owns the token lifecycle only.

DB: /data/mcp_user_tokens.db

Token prefixes
  mcpc-  authorization code  (60 s, single-use)
  mcpa-  access token        (1 h)
  mcpr-  refresh token       (30 days, rotated on every use)
  mcp-client-  dynamic client registration (RFC 7591)
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import sqlite3
import time
from pathlib import Path

logger = logging.getLogger(__name__)

DB_PATH            = Path("/data/mcp_user_tokens.db")
ACCESS_TOKEN_TTL   = 3600          # 1 hour
REFRESH_TOKEN_TTL  = 30 * 86400    # 30 days
AUTH_CODE_TTL      = 60            # 60 seconds


# ── DB ────────────────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init() -> None:
    """Create tables if the data directory exists."""
    if not DB_PATH.parent.exists():
        return
    with _connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS auth_codes (
                code            TEXT PRIMARY KEY,
                zitadel_id      TEXT NOT NULL,
                code_challenge  TEXT NOT NULL,
                redirect_uri    TEXT NOT NULL,
                expires_at      INTEGER NOT NULL,
                used            INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS access_tokens (
                token           TEXT PRIMARY KEY,
                zitadel_id      TEXT NOT NULL,
                refresh_token   TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                expires_at      INTEGER NOT NULL,
                revoked_at      INTEGER
            );
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                token           TEXT PRIMARY KEY,
                zitadel_id      TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                last_used_at    INTEGER,
                revoked_at      INTEGER
            );
            CREATE TABLE IF NOT EXISTS write_audit (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                zitadel_id      TEXT NOT NULL,
                tool            TEXT NOT NULL,
                args_json       TEXT NOT NULL,
                result          TEXT,
                called_at       INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS client_registrations (
                client_id       TEXT PRIMARY KEY,
                redirect_uris   TEXT NOT NULL,
                client_name     TEXT DEFAULT '',
                registered_at   INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dm_threads (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                initiator_zid       TEXT NOT NULL,
                initiator_name      TEXT NOT NULL,
                initiator_wa_jid    TEXT NOT NULL,
                recipient_wa_jid    TEXT NOT NULL,
                created_at          INTEGER NOT NULL,
                last_activity_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_at_zid    ON access_tokens(zitadel_id);
            CREATE INDEX IF NOT EXISTS idx_rt_zid    ON refresh_tokens(zitadel_id);
            CREATE INDEX IF NOT EXISTS idx_aud_zid   ON write_audit(zitadel_id);
            CREATE INDEX IF NOT EXISTS idx_dm_recip  ON dm_threads(recipient_wa_jid);
        """)


def _tok(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


# ── Dynamic client registration (RFC 7591) ────────────────────────────────────

def register_client(redirect_uris: list[str], client_name: str = "") -> str:
    """Store a client registration and return the client_id."""
    client_id = "mcp-client-" + secrets.token_urlsafe(16)
    with _connect() as db:
        db.execute(
            "INSERT INTO client_registrations(client_id,redirect_uris,client_name,registered_at) "
            "VALUES(?,?,?,?)",
            (client_id, json.dumps(redirect_uris), client_name, int(time.time())),
        )
    return client_id


def get_client_redirect_uris(client_id: str) -> list[str] | None:
    """Return registered redirect_uris for a client_id, or None if unknown."""
    if not client_id:
        return None
    try:
        with _connect() as db:
            row = db.execute(
                "SELECT redirect_uris FROM client_registrations WHERE client_id=?",
                (client_id,),
            ).fetchone()
        return json.loads(row["redirect_uris"]) if row else None
    except Exception as e:  # noqa: BLE001
        logger.debug("mcp_oauth: get_client_redirect_uris: %s", e)
        return None


# ── Authorization codes ───────────────────────────────────────────────────────

def generate_auth_code(
    zitadel_id: str, code_challenge: str, redirect_uri: str
) -> str:
    """Store and return a one-time auth code."""
    code = _tok("mcpc-")
    now  = int(time.time())
    with _connect() as db:
        db.execute(
            "INSERT INTO auth_codes VALUES (?,?,?,?,?,0)",
            (code, zitadel_id, code_challenge, redirect_uri, now + AUTH_CODE_TTL),
        )
    return code


def _verify_pkce(code_challenge: str, code_verifier: str) -> bool:
    """S256: challenge == base64url(sha256(verifier)), no padding."""
    digest   = hashlib.sha256(code_verifier.encode()).digest()
    computed = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return secrets.compare_digest(computed, code_challenge)


def exchange_code(
    code: str, code_verifier: str, redirect_uri: str
) -> tuple[str, str]:
    """Exchange an auth code for (access_token, refresh_token).

    Raises ValueError with the OAuth error string on any failure.
    """
    now = int(time.time())
    with _connect() as db:
        row = db.execute(
            "SELECT * FROM auth_codes WHERE code=? AND used=0", (code,)
        ).fetchone()
        if not row:
            raise ValueError("invalid_grant")
        if row["expires_at"] < now:
            raise ValueError("invalid_grant")
        if row["redirect_uri"] != redirect_uri:
            raise ValueError("invalid_grant")
        if not _verify_pkce(row["code_challenge"], code_verifier):
            raise ValueError("invalid_grant")
        # Mark used immediately so a duplicate request cannot race in.
        db.execute("UPDATE auth_codes SET used=1 WHERE code=?", (code,))
        return _issue_tokens(db, row["zitadel_id"], now)


def _issue_tokens(
    db: sqlite3.Connection, zid: str, now: int
) -> tuple[str, str]:
    """Insert a fresh (access, refresh) pair.  db must already be in a txn."""
    refresh = _tok("mcpr-")
    access  = _tok("mcpa-")
    db.execute(
        "INSERT INTO refresh_tokens VALUES (?,?,?,NULL,NULL)",
        (refresh, zid, now),
    )
    db.execute(
        "INSERT INTO access_tokens VALUES (?,?,?,?,?,NULL)",
        (access, zid, refresh, now, now + ACCESS_TOKEN_TTL),
    )
    return access, refresh


# ── Refresh ───────────────────────────────────────────────────────────────────

def refresh_access_token(refresh_token: str) -> tuple[str, str]:
    """Rotate refresh_token into a new (access, refresh) pair.

    The old refresh token is revoked atomically.  Raises ValueError on failure.
    """
    now = int(time.time())
    with _connect() as db:
        row = db.execute(
            "SELECT * FROM refresh_tokens WHERE token=? AND revoked_at IS NULL",
            (refresh_token,),
        ).fetchone()
        if not row:
            raise ValueError("invalid_grant")
        if row["created_at"] + REFRESH_TOKEN_TTL < now:
            raise ValueError("invalid_grant")
        zid = row["zitadel_id"]
        db.execute(
            "UPDATE refresh_tokens SET revoked_at=? WHERE token=?",
            (now, refresh_token),
        )
        db.execute(
            "UPDATE access_tokens SET revoked_at=? WHERE refresh_token=?",
            (now, refresh_token),
        )
        access, new_rt = _issue_tokens(db, zid, now)
        db.execute(
            "UPDATE refresh_tokens SET last_used_at=? WHERE token=?",
            (now, new_rt),
        )
    return access, new_rt


# ── Lookup ────────────────────────────────────────────────────────────────────

def lookup_access_token(token: str) -> str | None:
    """zitadel_id for a valid, non-expired, non-revoked access token, or None."""
    if not (token or "").startswith("mcpa-"):
        return None
    now = int(time.time())
    try:
        with _connect() as db:
            row = db.execute(
                "SELECT zitadel_id FROM access_tokens "
                "WHERE token=? AND revoked_at IS NULL AND expires_at>?",
                (token, now),
            ).fetchone()
            return row["zitadel_id"] if row else None
    except Exception as e:  # noqa: BLE001
        logger.debug("mcp_oauth: lookup_access_token: %s", e)
        return None


def user_status(zitadel_id: str) -> dict:
    """MCP connection status for one user — powers the settings widget."""
    if not zitadel_id:
        return {"active": False, "last_used_at": None}
    now = int(time.time())
    try:
        with _connect() as db:
            active = db.execute(
                "SELECT 1 FROM refresh_tokens "
                "WHERE zitadel_id=? AND revoked_at IS NULL "
                "AND created_at+? > ? LIMIT 1",
                (zitadel_id, REFRESH_TOKEN_TTL, now),
            ).fetchone()
            audit_t = db.execute(
                "SELECT MAX(called_at) AS t FROM write_audit WHERE zitadel_id=?",
                (zitadel_id,),
            ).fetchone()
            at_t = db.execute(
                "SELECT MAX(expires_at) AS t FROM access_tokens "
                "WHERE zitadel_id=? AND revoked_at IS NULL",
                (zitadel_id,),
            ).fetchone()
            last_used = max(
                audit_t["t"] or 0,
                at_t["t"] or 0,
            ) or None
    except Exception as e:  # noqa: BLE001
        logger.debug("mcp_oauth: user_status: %s", e)
        return {"active": False, "last_used_at": None}
    return {"active": bool(active), "last_used_at": last_used}


# ── Revocation ────────────────────────────────────────────────────────────────

def revoke_by_zitadel_id(zitadel_id: str) -> None:
    """Revoke all active tokens for a user (settings 'Revoke access')."""
    now = int(time.time())
    try:
        with _connect() as db:
            db.execute(
                "UPDATE refresh_tokens SET revoked_at=? "
                "WHERE zitadel_id=? AND revoked_at IS NULL",
                (now, zitadel_id),
            )
            db.execute(
                "UPDATE access_tokens SET revoked_at=? "
                "WHERE zitadel_id=? AND revoked_at IS NULL",
                (now, zitadel_id),
            )
    except Exception as e:  # noqa: BLE001
        logger.error("mcp_oauth: revoke_by_zitadel_id: %s", e)


def revoke_token(token: str) -> None:
    """Revoke a single access or refresh token (OAuth revocation endpoint)."""
    now = int(time.time())
    try:
        with _connect() as db:
            if token.startswith("mcpa-"):
                db.execute(
                    "UPDATE access_tokens SET revoked_at=? WHERE token=?",
                    (now, token),
                )
            elif token.startswith("mcpr-"):
                # Revoke the refresh token + all its access tokens.
                db.execute(
                    "UPDATE refresh_tokens SET revoked_at=? WHERE token=?",
                    (now, token),
                )
                db.execute(
                    "UPDATE access_tokens SET revoked_at=? WHERE refresh_token=?",
                    (now, token),
                )
    except Exception as e:  # noqa: BLE001
        logger.error("mcp_oauth: revoke_token: %s", e)


# ── Audit / rate-limiting ─────────────────────────────────────────────────────

def audit_write(
    zitadel_id: str, tool: str, args_json: str, result: str
) -> None:
    """Append a row to the write audit log.  Fire-and-forget."""
    try:
        with _connect() as db:
            db.execute(
                "INSERT INTO write_audit(zitadel_id,tool,args_json,result,called_at) "
                "VALUES (?,?,?,?,?)",
                (zitadel_id, tool, args_json, result, int(time.time())),
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("mcp_oauth: audit_write: %s", e)


def within_rate_limit(
    zitadel_id: str, tool: str, limit: int, window_seconds: int
) -> bool:
    """True if the user hasn't exhausted their rate allowance for this tool."""
    since = int(time.time()) - window_seconds
    try:
        with _connect() as db:
            row = db.execute(
                "SELECT COUNT(*) AS n FROM write_audit "
                "WHERE zitadel_id=? AND tool=? AND called_at>?",
                (zitadel_id, tool, since),
            ).fetchone()
            return (row["n"] if row else 0) < limit
    except Exception as e:  # noqa: BLE001
        logger.debug("mcp_oauth: within_rate_limit: %s", e)
        return True  # fail-open: a DB blip should not silently drop sends


# ── DM relay threads ──────────────────────────────────────────────────────────

DM_THREAD_TTL = 24 * 3600  # threads expire after 24 h of inactivity


def open_dm_thread(
    initiator_zid: str,
    initiator_name: str,
    initiator_wa_jid: str,
    recipient_wa_jid: str,
) -> None:
    """Record or refresh a relay thread when a DM is sent via MCP."""
    now = int(time.time())
    try:
        with _connect() as db:
            # Upsert: same pair → just refresh last_activity_at
            existing = db.execute(
                "SELECT id FROM dm_threads WHERE initiator_zid=? AND recipient_wa_jid=?",
                (initiator_zid, recipient_wa_jid),
            ).fetchone()
            if existing:
                db.execute(
                    "UPDATE dm_threads SET last_activity_at=?, initiator_wa_jid=?, initiator_name=? WHERE id=?",
                    (now, initiator_wa_jid, initiator_name, existing["id"]),
                )
            else:
                db.execute(
                    "INSERT INTO dm_threads(initiator_zid,initiator_name,initiator_wa_jid,recipient_wa_jid,created_at,last_activity_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (initiator_zid, initiator_name, initiator_wa_jid, recipient_wa_jid, now, now),
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("mcp_oauth: open_dm_thread: %s", e)


def find_dm_thread(recipient_wa_jid: str) -> dict | None:
    """Return active thread for a recipient JID, or None if none/expired."""
    if not recipient_wa_jid:
        return None
    cutoff = int(time.time()) - DM_THREAD_TTL
    try:
        with _connect() as db:
            row = db.execute(
                "SELECT * FROM dm_threads "
                "WHERE recipient_wa_jid=? AND last_activity_at>? "
                "ORDER BY last_activity_at DESC LIMIT 1",
                (recipient_wa_jid, cutoff),
            ).fetchone()
            if not row:
                return None
            return dict(row)
    except Exception as e:  # noqa: BLE001
        logger.debug("mcp_oauth: find_dm_thread: %s", e)
        return None


def touch_dm_thread(recipient_wa_jid: str) -> None:
    """Update last_activity_at when a reply arrives, keeping thread alive."""
    now = int(time.time())
    try:
        with _connect() as db:
            db.execute(
                "UPDATE dm_threads SET last_activity_at=? WHERE recipient_wa_jid=?",
                (now, recipient_wa_jid),
            )
    except Exception as e:  # noqa: BLE001
        logger.debug("mcp_oauth: touch_dm_thread: %s", e)
