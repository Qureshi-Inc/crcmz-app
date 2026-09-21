"""Call log for the MCP endpoint — who called what, and when.

Writes were already audited in `write_audit`, but reads were recorded nowhere, so
there was no way to answer "what is hitting MCP in the background". This records
every dispatched message: reads, writes, tools/list, initialize.

Argument VALUES are deliberately not stored, only their keys. A `whatsapp_search`
or `memory_search` query is message content, and a call log is the wrong place to
accumulate it. Set MCP_AUDIT_ARGS=1 if you need values while debugging — it is off
by default because it turns this table into a second copy of what people searched
for.

Recording must never break a call: every failure here is swallowed.

DB: /data/mcp_calls.db
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("MCP_AUDIT_PATH", "/data/mcp_calls.db"))
_lock = threading.Lock()
_ready = False
STORE_ARGS = os.environ.get("MCP_AUDIT_ARGS", "") == "1"
RETAIN_DAYS = int(os.environ.get("MCP_AUDIT_RETAIN_DAYS", "30"))


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    global _ready
    try:
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _lock, _conn() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS mcp_calls (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    called_at   REAL NOT NULL,
                    source      TEXT NOT NULL,
                    source_kind TEXT NOT NULL,
                    method      TEXT NOT NULL,
                    tool        TEXT,
                    tool_kind   TEXT,
                    ok          INTEGER NOT NULL DEFAULT 1,
                    duration_ms INTEGER,
                    arg_keys    TEXT,
                    args_json   TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_calls_at ON mcp_calls(called_at);
                CREATE INDEX IF NOT EXISTS idx_calls_src ON mcp_calls(source, called_at);
                CREATE INDEX IF NOT EXISTS idx_calls_tool ON mcp_calls(tool, called_at);
            """)
            db.commit()
        _ready = True
        logger.info("mcp_audit: DB ready at %s (args stored: %s)",
                    _DB_PATH, STORE_ARGS)
    except Exception as e:  # noqa: BLE001
        logger.warning("mcp_audit: init failed, call logging disabled: %s", e)


def describe_caller(caller: dict | None) -> tuple[str, str]:
    """(source, source_kind) for a caller dict.

    None means the shared read-only token — there is no identity behind it, which is
    itself worth seeing in the log.
    """
    if not caller:
        return "shared-token", "shared"
    label = caller.get("label")
    if label:
        return str(label), "service"
    zid = str(caller.get("zitadel_id") or "unknown")
    return zid, "user"


def record(caller: dict | None, method: str, tool: str = "", tool_kind: str = "",
           ok: bool = True, duration_ms: int | None = None,
           args: dict | None = None) -> None:
    if not _ready:
        return
    source, source_kind = describe_caller(caller)
    keys = ",".join(sorted(args.keys())) if isinstance(args, dict) else None
    blob = None
    if STORE_ARGS and isinstance(args, dict):
        try:
            import json as _json
            blob = _json.dumps(args, default=str)[:2000]
        except Exception:  # noqa: BLE001
            blob = None
    try:
        with _lock, _conn() as db:
            db.execute(
                "INSERT INTO mcp_calls (called_at, source, source_kind, method, tool,"
                " tool_kind, ok, duration_ms, arg_keys, args_json)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (time.time(), source, source_kind, method, tool or None,
                 tool_kind or None, 1 if ok else 0, duration_ms, keys, blob))
            db.commit()
    except Exception as e:  # noqa: BLE001 - logging must never break a call
        logger.debug("mcp_audit: record failed: %s", e)


def recent(limit: int = 200, since_s: float | None = None,
           source: str = "", tool: str = "") -> list[dict]:
    if not _ready:
        return []
    limit = max(1, min(int(limit or 200), 2000))
    sql = "SELECT * FROM mcp_calls WHERE 1=1"
    params: list = []
    if since_s:
        sql += " AND called_at >= ?"
        params.append(since_s)
    if source:
        sql += " AND source = ?"
        params.append(source)
    if tool:
        sql += " AND tool = ?"
        params.append(tool)
    sql += " ORDER BY called_at DESC LIMIT ?"
    params.append(limit)
    try:
        with _lock, _conn() as db:
            return [dict(r) for r in db.execute(sql, params)]
    except Exception:  # noqa: BLE001
        return []


def summary(since_s: float) -> dict:
    """Counts by source, by tool, and per hour — the shape a dashboard wants."""
    if not _ready:
        return {"sources": [], "tools": [], "per_hour": [], "total": 0}
    try:
        with _lock, _conn() as db:
            tot = db.execute("SELECT COUNT(*) FROM mcp_calls WHERE called_at >= ?",
                             (since_s,)).fetchone()[0]
            srcs = [dict(r) for r in db.execute(
                "SELECT source, source_kind, COUNT(*) n, MAX(called_at) last,"
                " SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) errors"
                " FROM mcp_calls WHERE called_at >= ?"
                " GROUP BY source ORDER BY n DESC", (since_s,))]
            tools = [dict(r) for r in db.execute(
                "SELECT COALESCE(tool, method) AS tool, tool_kind, COUNT(*) n,"
                " MAX(called_at) last FROM mcp_calls WHERE called_at >= ?"
                " GROUP BY COALESCE(tool, method) ORDER BY n DESC LIMIT 40",
                (since_s,))]
            hours = [dict(r) for r in db.execute(
                "SELECT CAST(called_at/3600 AS INTEGER) AS h, COUNT(*) n"
                " FROM mcp_calls WHERE called_at >= ?"
                " GROUP BY h ORDER BY h", (since_s,))]
        return {"sources": srcs, "tools": tools, "per_hour": hours, "total": tot}
    except Exception:  # noqa: BLE001
        return {"sources": [], "tools": [], "per_hour": [], "total": 0}


def prune() -> int:
    """Drop records older than the retention window. Returns rows removed."""
    if not _ready or RETAIN_DAYS <= 0:
        return 0
    cutoff = time.time() - RETAIN_DAYS * 86400
    try:
        with _lock, _conn() as db:
            cur = db.execute("DELETE FROM mcp_calls WHERE called_at < ?", (cutoff,))
            db.commit()
            return cur.rowcount or 0
    except Exception:  # noqa: BLE001
        return 0
