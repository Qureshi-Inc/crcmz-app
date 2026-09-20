#!/usr/bin/env python3
"""MCP surface: JSON-RPC dispatch, and the bearer gate on /mcp.

Plain asserts, no pytest -- run inside the app image where the deps live:

    docker build -t crcmz-app:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_mcp.py

The HTTP half matters as much as the protocol half: `/mcp` is in _OPEN_PATHS, so
the handler's own check is the only thing standing between a tailnet request and
10k private group messages.
"""

import json
import os
import sys

os.environ.setdefault("SESSION_SECRET", "test-secret-for-mcp")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mcp_server as mcp  # noqa: E402

FAILED: list[str] = []
PASSED = 0

TOKEN = "test-mcp-token-9f3a"


def check(name, fn):
    global PASSED
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        FAILED.append(f"{name}: {type(e).__name__}: {e}")
        print(f"  ✗ {name}\n      {type(e).__name__}: {e}")
    else:
        PASSED += 1
        print(f"  ✓ {name}")


def rpc(method, params=None, rid=1):
    msg = {"jsonrpc": "2.0", "method": method}
    if rid is not None:
        msg["id"] = rid
    if params is not None:
        msg["params"] = params
    return mcp.handle(msg)


def protocol_tests():
    print("mcp protocol")

    def fails_closed_without_token():
        mcp.MCP_TOKEN = ""
        # An unset token must not mean "open": the default has to be refuse-all.
        assert mcp.configured() is False
        assert mcp.authorised("Bearer anything") is False
        assert mcp.authorised("") is False
    check("no MCP_TOKEN means nothing is authorised", fails_closed_without_token)

    def bearer_checked():
        mcp.MCP_TOKEN = TOKEN
        assert mcp.authorised(f"Bearer {TOKEN}") is True
        assert mcp.authorised(f"bearer {TOKEN}") is True, "scheme is case-insensitive"
        assert mcp.authorised(TOKEN) is True, "bare token accepted"
        assert mcp.authorised(f"Bearer {TOKEN}x") is False
        assert mcp.authorised("Bearer ") is False
        assert mcp.authorised(f"Bearer {TOKEN[:10]}") is False, "prefix must not pass"
    check("bearer token is checked exactly", bearer_checked)

    def initialize_echoes_version():
        r = rpc("initialize", {"protocolVersion": "2024-11-05"})
        assert r["result"]["protocolVersion"] == "2024-11-05", r
        assert r["result"]["capabilities"]["tools"] is not None, r
        assert r["result"]["serverInfo"]["name"] == "crcmz", r
        assert "instructions" in r["result"], r
    check("initialize echoes a supported protocol version", initialize_echoes_version)

    def initialize_falls_back():
        r = rpc("initialize", {"protocolVersion": "1999-01-01"})
        assert r["result"]["protocolVersion"] == mcp.PROTOCOL_VERSION, r
    check("unknown protocol version falls back to ours", initialize_falls_back)

    def tools_listed():
        tools = rpc("tools/list")["result"]["tools"]
        names = {t["name"] for t in tools}
        # The registry is assistant.py's; these are the ones added for MCP.
        for expected in ("soundboard_buttons", "person_profile", "squad_roster",
                         "whatsapp_search", "recent_clips"):
            assert expected in names, (expected, sorted(names))
        for t in tools:
            # MCP calls it inputSchema, not parameters -- a client rejects the
            # tool outright if this key is missing.
            assert "inputSchema" in t, t
            assert t["inputSchema"].get("type") == "object", t
            assert t["description"], f"{t['name']} has no description"
    check("tools/list exposes the assistant registry as inputSchema", tools_listed)

    def registry_is_shared():
        import assistant
        assert len(rpc("tools/list")["result"]["tools"]) == len(assistant.tool_specs()), \
            "MCP must expose every assistant tool, with no hand-maintained list"
    check("no separate tool list to drift out of sync", registry_is_shared)

    def ping_works():
        assert rpc("ping")["result"] == {}
    check("ping responds", ping_works)

    def unknown_method():
        r = rpc("tools/nope")
        assert r["error"]["code"] == mcp.METHOD_NOT_FOUND, r
    check("unknown method is a JSON-RPC error", unknown_method)

    def notifications_get_no_reply():
        assert mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
        # A request with no id at all is a notification too.
        assert rpc("ping", rid=None) is None
    check("notifications produce no response", notifications_get_no_reply)

    def bad_envelope():
        r = mcp.handle({"method": "ping", "id": 1})
        assert r["error"]["code"] == mcp.INVALID_REQUEST, r
        assert mcp.handle("not a dict")["error"]["code"] == mcp.INVALID_REQUEST
    check("a non-JSON-RPC envelope is rejected", bad_envelope)

    def tool_error_is_a_result():
        r = rpc("tools/call", {"name": "no_such_tool", "arguments": {}})
        # Not a JSON-RPC error: the model should read this and pick another tool.
        assert "error" not in r, r
        assert r["result"]["isError"] is True, r
        payload = json.loads(r["result"]["content"][0]["text"])
        assert "available" in payload, payload
    check("an unknown tool is a tool error, not a transport error",
          tool_error_is_a_result)

    def bad_arguments_type():
        r = rpc("tools/call", {"name": "squad_roster", "arguments": "nope"})
        assert r["error"]["code"] == mcp.INVALID_REQUEST, r
    check("non-object arguments are rejected", bad_arguments_type)

    def tool_call_returns_text_content():
        r = rpc("tools/call", {"name": "soundboard_buttons", "arguments": {"limit": 2}})
        content = r["result"]["content"]
        assert content[0]["type"] == "text", content
        json.loads(content[0]["text"])          # must be valid JSON for the model
        assert r["result"]["isError"] is False, r
    check("tools/call returns JSON text content", tool_call_returns_text_content)

    def body_parsing():
        body, status = mcp.handle_body(b'{"jsonrpc":"2.0","id":7,"method":"ping"}')
        assert status == 200 and body["id"] == 7, (status, body)

        body, status = mcp.handle_body(b"{ broken")
        assert status == 400 and body["error"]["code"] == mcp.PARSE_ERROR, (status, body)

        # Notification-only: 202 and no body, which clients check for.
        body, status = mcp.handle_body(b'{"jsonrpc":"2.0","method":"notifications/x"}')
        assert status == 202 and body is None, (status, body)
    check("handle_body maps to the right status codes", body_parsing)

    def batches():
        batch = json.dumps([
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ])
        body, status = mcp.handle_body(batch)
        assert status == 200 and len(body) == 2, (status, body)
        assert [r["id"] for r in body] == [1, 2], body

        body, status = mcp.handle_body(b"[]")
        assert status == 400, (status, body)
    check("a batch drops notifications and keeps requests", batches)


def http_tests():
    print("\nmcp endpoint")
    from fastapi.testclient import TestClient
    import mcp_server
    import server

    client = TestClient(server.app, headers={"host": "app.crcmz.me"})
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}

    def disabled_returns_503():
        mcp_server.MCP_TOKEN = ""
        r = client.post("/mcp", json=ping)
        assert r.status_code == 503, (r.status_code, r.text)
    check("disabled MCP answers 503, never data", disabled_returns_503)

    def unauthenticated_is_401():
        mcp_server.MCP_TOKEN = TOKEN
        for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Basic x"}):
            r = client.post("/mcp", json=ping, headers=headers)
            assert r.status_code == 401, (headers, r.status_code, r.text)
            assert "crcmz" not in r.text or "tools" not in r.text, r.text
    check("a bad or missing token is 401", unauthenticated_is_401)

    def www_authenticate_header():
        r = client.post("/mcp", json=ping)
        assert "Bearer" in r.headers.get("www-authenticate", ""), r.headers
    check("401 says how to authenticate", www_authenticate_header)

    def authenticated_works():
        auth = {"Authorization": f"Bearer {TOKEN}"}
        r = client.post("/mcp", json=ping, headers=auth)
        assert r.status_code == 200 and r.json()["result"] == {}, r.text

        r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                        headers=auth)
        assert r.status_code == 200, r.text
        assert len(r.json()["result"]["tools"]) > 5, r.text
    check("a valid token gets the tool list", authenticated_works)

    def lan_request_still_needs_the_token():
        # This is the whole reason the check lives in the handler: the auth
        # middleware waves through anything whose Host is not the public host.
        lan = TestClient(server.app, headers={"host": "100.76.195.46:8000"})
        r = lan.post("/mcp", json=ping)
        assert r.status_code == 401, (r.status_code, r.text)
        r = lan.post("/mcp", json=ping, headers={"Authorization": f"Bearer {TOKEN}"})
        assert r.status_code == 200, r.text
    check("tailnet/LAN callers are not exempt", lan_request_still_needs_the_token)

    def notification_gets_202_empty():
        r = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                        headers={"Authorization": f"Bearer {TOKEN}"})
        assert r.status_code == 202, (r.status_code, r.text)
        assert r.content == b"", r.content
    check("a notification gets 202 with an empty body", notification_gets_202_empty)

    def probe_leaks_nothing():
        r = client.get("/mcp")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["enabled"] is True and body["protocol"] == "mcp", body
        # No token was sent, so no tool names may appear.
        assert "tools" not in r.text and "whatsapp" not in r.text, r.text
    check("GET /mcp reveals no tools without a token", probe_leaks_nothing)

    def no_credentials_in_a_tool_reply():
        auth = {"Authorization": f"Bearer {TOKEN}"}
        r = client.post("/mcp", headers=auth, json={
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "squad_roster", "arguments": {}}})
        for secret in ("npsso", "access_token", "refresh_token", TOKEN):
            assert secret not in r.text, f"{secret} leaked through MCP"
    check("tool output carries no credentials", no_credentials_in_a_tool_reply)


def main():
    protocol_tests()
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
