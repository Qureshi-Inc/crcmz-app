#!/usr/bin/env python3
"""OAuth token lifecycle, PKCE, rate-limiting, and write-tool registration.

Plain asserts, no pytest.  The module-level tests run on the host (sqlite3 +
stdlib only).  The write-tool tests need the app image:

    docker build -t psn-messenger:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" psn-messenger:test \
      python tests/test_mcp_oauth.py
"""

import base64
import hashlib
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN",    "test-npsso")
os.environ.setdefault("GROUP_ID",       "test-group")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mcp_oauth as oauth  # noqa: E402

FAILED: list[str] = []
PASSED = 0


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


# ── Use a temp DB for all tests ───────────────────────────────────────────────
oauth.DB_PATH = Path(tempfile.mkdtemp(prefix="mcp-oauth-test-")) / "mcp_user_tokens.db"
oauth.init()

ZID = "zitadel-test-user-001"
REDIRECT = "http://localhost:54321/callback"


def _pkce_pair() -> tuple[str, str]:
    verifier  = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


# ── Auth code ─────────────────────────────────────────────────────────────────

def t_generate_and_exchange_code():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code(ZID, challenge, REDIRECT)
    assert code.startswith("mcpc-"), code
    access, refresh = oauth.exchange_code(code, verifier, REDIRECT)
    assert access.startswith("mcpa-"),  access
    assert refresh.startswith("mcpr-"), refresh


def t_code_cannot_be_used_twice():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code(ZID, challenge, REDIRECT)
    oauth.exchange_code(code, verifier, REDIRECT)
    try:
        oauth.exchange_code(code, verifier, REDIRECT)
        assert False, "should have raised ValueError"
    except ValueError as e:
        assert "invalid_grant" in str(e)


def t_wrong_verifier_rejected():
    _, challenge = _pkce_pair()
    code = oauth.generate_auth_code(ZID, challenge, REDIRECT)
    try:
        oauth.exchange_code(code, "wrong-verifier", REDIRECT)
        assert False, "should have raised ValueError"
    except ValueError:
        pass


def t_wrong_redirect_uri_rejected():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code(ZID, challenge, REDIRECT)
    try:
        oauth.exchange_code(code, verifier, "http://evil.example.com/cb")
        assert False, "should have raised ValueError"
    except ValueError:
        pass


def t_expired_code_rejected():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code(ZID, challenge, REDIRECT)
    # Force expiry by patching the row directly.
    import sqlite3
    with sqlite3.connect(oauth.DB_PATH) as db:
        db.execute("UPDATE auth_codes SET expires_at=1 WHERE code=?", (code,))
    try:
        oauth.exchange_code(code, verifier, REDIRECT)
        assert False, "should have raised ValueError"
    except ValueError:
        pass


# ── Access token lookup ───────────────────────────────────────────────────────

def t_valid_access_token_resolves():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code(ZID, challenge, REDIRECT)
    access, _ = oauth.exchange_code(code, verifier, REDIRECT)
    assert oauth.lookup_access_token(access) == ZID


def t_garbage_token_returns_none():
    assert oauth.lookup_access_token("garbage") is None
    assert oauth.lookup_access_token("") is None
    assert oauth.lookup_access_token(None) is None   # type: ignore[arg-type]


def t_wrong_prefix_returns_none():
    # Must not look up refresh or auth-code tokens as access tokens.
    assert oauth.lookup_access_token("mcpr-" + "x" * 40) is None
    assert oauth.lookup_access_token("mcpc-" + "x" * 40) is None


# ── Refresh ───────────────────────────────────────────────────────────────────

def t_refresh_issues_new_token_pair():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code(ZID, challenge, REDIRECT)
    old_access, old_refresh = oauth.exchange_code(code, verifier, REDIRECT)

    new_access, new_refresh = oauth.refresh_access_token(old_refresh)
    assert new_access  != old_access
    assert new_refresh != old_refresh
    assert new_access.startswith("mcpa-")
    assert new_refresh.startswith("mcpr-")
    # Old access token is revoked after rotation.
    assert oauth.lookup_access_token(old_access) is None
    # New access token works.
    assert oauth.lookup_access_token(new_access) == ZID


def t_old_refresh_token_cannot_be_reused():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code(ZID, challenge, REDIRECT)
    _, old_refresh = oauth.exchange_code(code, verifier, REDIRECT)
    oauth.refresh_access_token(old_refresh)  # rotate
    try:
        oauth.refresh_access_token(old_refresh)
        assert False, "should have raised"
    except ValueError:
        pass


# ── Revocation ────────────────────────────────────────────────────────────────

def t_revoke_by_user_kills_all_tokens():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code("zid-revoke-test", challenge, REDIRECT)
    access, _ = oauth.exchange_code(code, verifier, REDIRECT)
    assert oauth.lookup_access_token(access) == "zid-revoke-test"

    oauth.revoke_by_zitadel_id("zid-revoke-test")
    assert oauth.lookup_access_token(access) is None


def t_revoke_single_token():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code("zid-single-rev", challenge, REDIRECT)
    access, _ = oauth.exchange_code(code, verifier, REDIRECT)
    oauth.revoke_token(access)
    assert oauth.lookup_access_token(access) is None


# ── User status ───────────────────────────────────────────────────────────────

def t_user_status_active_after_login():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code("zid-status-test", challenge, REDIRECT)
    oauth.exchange_code(code, verifier, REDIRECT)
    s = oauth.user_status("zid-status-test")
    assert s["active"] is True, s


def t_user_status_inactive_after_revoke():
    verifier, challenge = _pkce_pair()
    code = oauth.generate_auth_code("zid-status-rev", challenge, REDIRECT)
    oauth.exchange_code(code, verifier, REDIRECT)
    oauth.revoke_by_zitadel_id("zid-status-rev")
    s = oauth.user_status("zid-status-rev")
    assert s["active"] is False, s


def t_user_status_unknown_user():
    s = oauth.user_status("nobody")
    assert s["active"] is False


# ── Audit / rate-limit ────────────────────────────────────────────────────────

def t_audit_write_recorded():
    oauth.audit_write("zid-audit", "send_psn_group_message", '{"msg":"hi"}', "sent")
    # Should not raise and status should reflect it.


def t_rate_limit_allows_under_threshold():
    assert oauth.within_rate_limit("zid-rl", "tool_x", 3, 600) is True


def t_rate_limit_blocks_over_threshold():
    zid = "zid-rl-block"
    for _ in range(3):
        oauth.audit_write(zid, "tool_y", "{}", "sent")
    # 3 calls used; limit is 3 → next one is over.
    assert oauth.within_rate_limit(zid, "tool_y", 3, 600) is False


def t_rate_limit_resets_outside_window():
    zid = "zid-rl-old"
    import sqlite3
    # Insert a call far in the past.
    old_time = int(time.time()) - 700
    with sqlite3.connect(oauth.DB_PATH) as db:
        db.execute(
            "INSERT INTO write_audit(zitadel_id,tool,args_json,result,called_at) "
            "VALUES(?,?,?,?,?)",
            (zid, "tool_z", "{}", "sent", old_time),
        )
    # Only one old call outside the 600s window → still within limit of 1.
    assert oauth.within_rate_limit(zid, "tool_z", 1, 600) is True


# ── Missing-DB degrades gracefully ────────────────────────────────────────────

def t_missing_db_returns_none_not_exception():
    saved = oauth.DB_PATH
    oauth.DB_PATH = Path("/nope/no/mcp_user_tokens.db")
    try:
        assert oauth.lookup_access_token("mcpa-" + "x" * 40) is None
        s = oauth.user_status("someone")
        assert s["active"] is False
        assert oauth.within_rate_limit("x", "t", 3, 60) is True  # fail-open
    finally:
        oauth.DB_PATH = saved


# ── Write-tool registration (needs app image) ─────────────────────────────────

def tool_tests():
    import assistant

    def t_write_tools_registered():
        wt = assistant.write_tool_names()
        for expected in ("send_psn_group_message", "send_whatsapp_group_message",
                         "send_whatsapp_dm", "send_mattermost_dm"):
            assert expected in wt, f"{expected} not in write tools: {wt}"

    def t_write_tools_not_in_read_registry():
        read_names = set(assistant.tool_names())
        for wt in assistant.write_tool_names():
            assert wt not in read_names, f"{wt} leaked into read-only registry"

    def t_write_tool_names_are_clean():
        banned = ("delete", "remove", "drop", "truncate")
        for n in assistant.write_tool_names():
            for b in banned:
                assert b not in n, f"suspicious write tool name: {n}"

    def t_write_tools_absent_from_mcp_read_list():
        import mcp_server
        read_mcp = {t["name"] for t in mcp_server._tools()}
        for wt in assistant.write_tool_names():
            assert wt not in read_mcp, f"{wt} leaked into MCP read tools"

    def t_write_tools_have_required_params():
        for spec in assistant.write_tool_specs():
            fn = spec.get("function", {})
            params = fn.get("parameters", {})
            assert params.get("type") == "object", fn["name"]
            assert "message" in params.get("properties", {}), \
                f"{fn['name']} has no 'message' param"

    def t_no_credentials_in_write_tool_specs():
        import json
        for spec in assistant.write_tool_specs():
            blob = json.dumps(spec).lower()
            for bad in ("npsso", "access_token", "refresh_token", "authorization"):
                assert bad not in blob, f"{bad} found in write tool spec"

    def t_write_tools_visible_in_mcp_with_caller():
        import mcp_server
        # Simulate a user-token tools/list request.
        resp = mcp_server.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            caller={"zitadel_id": "test-zid"},
        )
        names = {t["name"] for t in resp["result"]["tools"]}
        for wt in assistant.write_tool_names():
            assert wt in names, f"{wt} missing from user-token tools/list"

    def t_write_tools_hidden_without_caller():
        import mcp_server
        resp = mcp_server.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            caller=None,
        )
        names = {t["name"] for t in resp["result"]["tools"]}
        for wt in assistant.write_tool_names():
            assert wt not in names, f"{wt} visible without a user token"

    def t_write_tool_call_blocked_without_caller():
        import mcp_server
        resp = mcp_server.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": "send_psn_group_message",
                        "arguments": {"message": "hi"}}},
            caller=None,
        )
        assert resp["result"]["isError"] is True

    def t_mcp_coverage_db_entry_is_none():
        # The token DB must never be accessible through a tool.
        import importlib.util, pathlib
        spec = importlib.util.spec_from_file_location(
            "test_mcp_coverage",
            pathlib.Path(__file__).parent / "test_mcp_coverage.py",
        )
        cov = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cov)
        assert cov.STORES.get("/data/mcp_user_tokens.db") is None, \
            "/data/mcp_user_tokens.db must be mapped to None in STORES"

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check("tools/" + name[2:], fn)


# ── Run ───────────────────────────────────────────────────────────────────────

print("OAuth token lifecycle tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("\nWrite-tool registration tests")
try:
    tool_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"tool_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not load the assistant: {type(e).__name__}: {e}")

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
