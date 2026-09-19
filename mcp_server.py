"""MCP (Model Context Protocol) surface over the existing assistant tools.

The point of this module is that it holds no data of its own. Every tool the
WhatsApp bot can call is already registered in `assistant._TOOLS`; this just
re-serves that registry as JSON-RPC so an external FastAPI app, openclaw, or
Claude Desktop sees exactly what the bot sees. Add an `@tool(...)` in
`assistant.py` and it appears here with no edit to this file -- which is the
whole convention in `.claude/skills/crcmz-mcp-tool/SKILL.md`.

Transport is the Streamable HTTP one: a single POST endpoint taking JSON-RPC 2.0.
Requests carrying an `id` get a response; notifications (no `id`) get 202 and no
body, which the spec requires and clients enforce.

**Authentication is this module's job, not the middleware's.** `server.py`'s auth
gate only challenges requests whose Host matches PORTAL_PUBLIC_HOST, so anything
arriving over the tailnet or LAN IP skips it entirely -- and the tools behind
this endpoint read ~10k private group messages. So:

* `/mcp` is in `_OPEN_PATHS` (same as `/api/whatsapp/ingest`, a machine caller
  with no session cookie) and does its own check on every single request.
* With `MCP_TOKEN` unset the endpoint refuses everything. Failing closed matters
  more than convenience here: the alternative default is an open read of the
  group's entire history.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

MCP_TOKEN = os.environ.get("MCP_TOKEN", "")

# ── Caller identity (per-request, set for user tokens only) ───────────────────
# The write tools read this to know who is calling.  It is set in handle_body()
# and cleared automatically when the context exits (contextvars semantics).
import contextvars as _cv
_caller: _cv.ContextVar[dict | None] = _cv.ContextVar("_mcp_caller", default=None)

SERVER_NAME = "crcmz"
SERVER_VERSION = "1.0.0"

# Versions whose wire format this implementation matches. A client asking for
# something else still gets the newest one we speak, which is what the spec says
# to do -- it can then decide whether to continue.
SUPPORTED_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
PROTOCOL_VERSION = SUPPORTED_PROTOCOLS[0]

# JSON-RPC 2.0 error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


def configured() -> bool:
    """True — the endpoint is always active; either a shared token or OAuth works."""
    return True  # per-user OAuth is always available; shared MCP_TOKEN is optional


def authorised(header: str) -> bool:
    """Constant-time check of an `Authorization: Bearer <token>` header.

    Compared with hmac.compare_digest rather than `==` so the comparison does not
    leak the token's length or prefix through timing.
    """
    if not configured():
        return False
    value = (header or "").strip()
    if value.lower().startswith("bearer "):
        value = value[7:].strip()
    if not value:
        return False
    return hmac.compare_digest(value, MCP_TOKEN)


def resolve_caller(header: str) -> dict | None:
    """Return a caller dict for a valid user access token, or None to reject.

    A caller dict has at minimum {"zitadel_id": str}.  Used by the /mcp
    endpoint after the shared MCP_TOKEN check has already failed.
    """
    value = (header or "").strip()
    if value.lower().startswith("bearer "):
        value = value[7:].strip()
    if not value:
        return None
    try:
        import mcp_oauth
        zid = mcp_oauth.lookup_access_token(value)
        if not zid:
            return None
        return {"zitadel_id": zid}
    except Exception as e:  # noqa: BLE001
        logger.debug("mcp: resolve_caller failed: %s", e)
        return None


def _tools() -> list[dict]:
    """The assistant read registry in MCP's shape (`inputSchema`, not `parameters`)."""
    import assistant
    out = []
    for spec in assistant.tool_specs():
        fn = spec.get("function", {})
        out.append({
            "name": fn.get("name", ""),
            "description": fn.get("description", ""),
            "inputSchema": fn.get("parameters")
                           or {"type": "object", "properties": {}},
        })
    return out


def _write_tools() -> list[dict]:
    """Write-capable tools, only served to user-token callers."""
    import assistant
    out = []
    for spec in assistant.write_tool_specs():
        fn = spec.get("function", {})
        out.append({
            "name": fn.get("name", ""),
            "description": fn.get("description", ""),
            "inputSchema": fn.get("parameters")
                           or {"type": "object", "properties": {}},
        })
    return out


def _result(rid: Any, payload: dict) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "result": payload}


def _error(rid: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def handle(message: dict, caller: dict | None = None) -> dict | None:
    """Dispatch one JSON-RPC message. Returns None for a notification.

    `caller` is None for the shared read-only token, or a dict with at least
    {"zitadel_id": str} for a per-user token.  Write tools are only reachable
    when caller is not None.

    Never raises: a tool blowing up comes back as an MCP tool error (`isError`)
    so the model can see what went wrong and try something else, while a protocol
    problem comes back as a JSON-RPC error.
    """
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return _error(None, INVALID_REQUEST, "expected a JSON-RPC 2.0 object")

    method = message.get("method") or ""
    rid = message.get("id")
    params = message.get("params") or {}

    # A message with no `id` is a notification, and the spec is absolute: never
    # reply to one, not even to report an unknown method. This has to come before
    # the dispatch below, or `{"method": "ping"}` with no id would get a response
    # and a strict client would drop the connection.
    if "id" not in message or method.startswith("notifications/"):
        return None

    if method == "initialize":
        asked = (params.get("protocolVersion") or "").strip()
        instructions = (
            "CRCMZ squad data: WhatsApp group history and analytics, PSN "
            "presence and clips, the dashboard soundboard buttons, and the "
            "identity graph tying each person's PSN / Mattermost / WhatsApp "
            "names together. Call squad_roster first when a question names a "
            "person, then person_profile for everything about them."
        )
        if caller:
            instructions += (
                " You are authenticated as a squad member and have write access: "
                "you can send messages to the PSN group, the WhatsApp group, "
                "WhatsApp DMs, and Mattermost. All writes are prefixed [via Claude] "
                "and logged. Always confirm with the user before sending."
            )
        return _result(rid, {
            "protocolVersion": asked if asked in SUPPORTED_PROTOCOLS else PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": instructions,
        })

    if method == "ping":
        return _result(rid, {})

    if method == "tools/list":
        tools = _tools()
        if caller:
            tools = tools + _write_tools()
        return _result(rid, {"tools": tools})

    if method == "tools/call":
        import assistant
        name = params.get("name") or ""
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            return _error(rid, INVALID_REQUEST, "arguments must be an object")

        # Write tools: only available with a user token.
        write_names = {t["name"] for t in _write_tools()}
        if name in write_names:
            if not caller:
                return _result(rid, {
                    "content": [{"type": "text", "text":
                                 f"'{name}' is a write tool and requires a personal "
                                 "user token. Connect via OAuth at app.crcmz.me/mcp "
                                 "to get write access."}],
                    "isError": True,
                })
            tok = _caller.set(caller)
            try:
                text, ok = assistant.call_write_tool(name, args, caller)
            finally:
                _caller.reset(tok)
        else:
            text, ok = assistant.call_tool(name, args)

        # A failed tool is a *result* with isError, not a JSON-RPC error: the
        # model is meant to read the message and recover, not see a dead channel.
        return _result(rid, {
            "content": [{"type": "text", "text": text}],
            "isError": not ok,
        })

    return _error(rid, METHOD_NOT_FOUND, f"unknown method: {method}")


def handle_body(
    raw: bytes | str, caller: dict | None = None
) -> tuple[Any, int]:
    """Parse and dispatch a raw request body. Returns (json_body_or_None, status).

    `caller` is None for the shared read-only token and a dict for user tokens.
    Handles the batch form too, since the 2025-03-26 spec allows an array.  A
    batch of nothing but notifications yields 202 with no body.
    """
    try:
        payload = json.loads(raw or b"{}")
    except (ValueError, TypeError):
        return _error(None, PARSE_ERROR, "invalid JSON"), 400

    try:
        if isinstance(payload, list):
            if not payload:
                return _error(None, INVALID_REQUEST, "empty batch"), 400
            replies = [
                r for r in (handle(m, caller) for m in payload) if r is not None
            ]
            return (replies, 200) if replies else (None, 202)
        reply = handle(payload, caller)
        return (reply, 200) if reply is not None else (None, 202)
    except Exception as e:  # noqa: BLE001 - a bug here must not 500 the app
        logger.exception("mcp: dispatch failed")
        return _error(None, INTERNAL_ERROR, str(e)), 500
