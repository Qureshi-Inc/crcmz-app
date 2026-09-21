import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SESSION_SECRET","t"); os.environ.setdefault("MCP_TOKEN","shared-tok")
os.environ.setdefault("CRCMZ_SERVICE_TOKENS","muse:muse-token-abcdefghij:coach_review_record")
FAILED=[]
def check(n,f):
    try: f(); print("  ✓ %s"%n)
    except Exception as e: FAILED.append(n); print("  ✗ %s -> %s: %s"%(n,type(e).__name__,e))

def test_arg_values_are_not_stored_by_default():
    """A search query is message content; the call log must not become a copy of it."""
    import mcp_audit
    mcp_audit.init()
    assert mcp_audit.STORE_ARGS is False, "MCP_AUDIT_ARGS must default to off"
    mcp_audit.record(None, "tools/call", "whatsapp_search", "read", True, 5,
                     {"query": "something private", "limit": 5})
    row = mcp_audit.recent(limit=1)[0]
    assert row["arg_keys"] == "limit,query", "keys should be recorded"
    assert row["args_json"] is None, "values must NOT be stored"
    assert "something private" not in str(row), "the query text leaked into the log"

def test_source_attribution():
    import mcp_audit, mcp_server
    assert mcp_audit.describe_caller(None) == ("shared-token", "shared")
    svc = mcp_server.resolve_service("Bearer muse-token-abcdefghij")
    assert mcp_audit.describe_caller(svc) == ("muse", "service")
    assert mcp_audit.describe_caller({"zitadel_id": "z1"}) == ("z1", "user")

def test_failed_calls_are_marked_not_ok():
    import mcp_server, mcp_audit, json
    mcp_audit.init()
    svc = mcp_server.resolve_service("Bearer muse-token-abcdefghij")
    mcp_server.handle_body(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call",
        "params":{"name":"send_whatsapp_dm","arguments":{"to":"x","message":"y"}}}).encode(),
        caller=svc)
    row = mcp_audit.recent(limit=1)[0]
    assert row["tool"] == "send_whatsapp_dm"
    assert row["ok"] == 0, "a refused call must be recorded as not ok"
    assert row["tool_kind"] == "write"

def test_recording_never_breaks_a_call():
    """If the log is broken the endpoint must still answer."""
    import mcp_server, mcp_audit, json
    orig = mcp_audit.record
    mcp_audit.record = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk full"))
    try:
        body, status = mcp_server.handle_body(json.dumps(
            {"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}).encode(), caller=None)
        assert status == 200 and body.get("result"), "call must survive a logging failure"
    finally:
        mcp_audit.record = orig

def test_summary_shape():
    import mcp_audit, time
    s = mcp_audit.summary(time.time()-3600)
    for k in ("sources","tools","per_hour","total"):
        assert k in s, "summary missing %s" % k

if __name__ == "__main__":
    print("mcp call audit")
    for n,f in sorted(globals().items()):
        if n.startswith("test_") and callable(f): check(n[5:].replace("_"," "), f)
    print()
    print("%d failed"%len(FAILED) if FAILED else "all passed")
    sys.exit(1 if FAILED else 0)
