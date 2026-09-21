#!/usr/bin/env python3
"""Agent task queue: submit, claim, complete, release, and scope enforcement.

The property that matters most: Muse's token can file tasks and list them,
but it cannot claim or complete them — it must not be able to mark the
agent's work done or hijack an in-progress task.

  docker run --rm -e SESSION_SECRET=test -e NPSSO_TOKEN=t -e GROUP_ID=g \
    -e MCP_TOKEN=shared \
    -e CRCMZ_SERVICE_TOKENS='muse:muse-token-abcdefghij:coach_review_record,ig_post_record,ig_reel_share,task_submit;agent:agent-token-abcdefghij:task_claim,task_complete,task_release' \
    -e AGENT_TASKS_DB=/tmp/test_agent_tasks.db \
    -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_agent_tasks.py
"""
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("MCP_TOKEN", "shared-read-token")
os.environ.setdefault("AGENT_TASKS_DB", "/tmp/test_agent_tasks_%s.db" % uuid.uuid4().hex[:8])
os.environ.setdefault(
    "CRCMZ_SERVICE_TOKENS",
    "muse:muse-token-abcdefghij:coach_review_record,ig_post_record,ig_reel_share,task_submit"
    ";agent:agent-token-abcdefghij:task_claim,task_complete,task_release")

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


MUSE_TOKEN  = "muse-token-abcdefghij"
AGENT_TOKEN = "agent-token-abcdefghij"


def _rpc(body, token):
    import json
    import mcp_server
    caller = (mcp_server.resolve_caller("Bearer " + token)
              or mcp_server.resolve_service("Bearer " + token))
    out, _status = mcp_server.handle_body(json.dumps(body).encode(), caller=caller)
    return out


def _submit(title, body, token=MUSE_TOKEN, priority=0):
    r = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": "task_submit",
                         "arguments": {"title": title, "body": body,
                                       "priority": priority}}}, token)
    import json
    return json.loads(r["result"]["content"][0]["text"])


def _call(tool, args, token):
    import json
    r = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": tool, "arguments": args}}, token)
    content = r.get("result", {}).get("content", [{}])
    return json.loads(content[0].get("text", "{}"))


# ── basic lifecycle ──────────────────────────────────────────────────────────

def test_submit_and_list():
    run = uuid.uuid4().hex[:6]
    res = _submit("Test task %s" % run, "Do the thing.", priority=5)
    assert res.get("ok"), res
    task_id = res["task_id"]

    listed = _call("task_list", {"status": "open"}, MUSE_TOKEN)
    assert isinstance(listed, list), listed
    ids = [t["id"] for t in listed]
    assert task_id in ids, "submitted task must appear in open queue"

    # body is present for open tasks
    task = next(t for t in listed if t["id"] == task_id)
    assert task["body"] == "Do the thing."
    assert task["priority"] == 5


def test_claim_is_atomic():
    run = uuid.uuid4().hex[:6]
    res = _submit("Atomic claim %s" % run, "Implement X.")
    task_id = res["task_id"]

    # First claim wins
    r1 = _call("task_claim", {"task_id": task_id, "agent_name": "agent-1"}, AGENT_TOKEN)
    assert r1.get("ok"), "first claim must succeed"

    # Second claim on the same task loses
    r2 = _call("task_claim", {"task_id": task_id, "agent_name": "agent-2"}, AGENT_TOKEN)
    assert not r2.get("ok"), "second claim must fail — task already in_progress"


def test_complete_lifecycle():
    run = uuid.uuid4().hex[:6]
    task_id = _submit("Complete test %s" % run, "Do it.")["task_id"]
    _call("task_claim", {"task_id": task_id, "agent_name": "ci"}, AGENT_TOKEN)
    r = _call("task_complete",
              {"task_id": task_id, "result_notes": "sha:abc123, touched: foo.py"},
              AGENT_TOKEN)
    assert r.get("ok"), r

    listed_done = _call("task_list", {"status": "done"}, MUSE_TOKEN)
    done_ids = [t["id"] for t in listed_done]
    assert task_id in done_ids


def test_release_returns_to_open():
    run = uuid.uuid4().hex[:6]
    task_id = _submit("Release test %s" % run, "Try and fail.")["task_id"]
    _call("task_claim", {"task_id": task_id, "agent_name": "agent-1"}, AGENT_TOKEN)
    r = _call("task_release",
              {"task_id": task_id, "note": "blocked: missing env var"},
              AGENT_TOKEN)
    assert r.get("ok"), r

    open_ids = [t["id"] for t in _call("task_list", {"status": "open"}, MUSE_TOKEN)]
    assert task_id in open_ids, "released task must be back in open queue"


def test_priority_ordering():
    run = uuid.uuid4().hex[:6]
    low  = _submit("Low %s"  % run, "Low priority.", priority=0)["task_id"]
    high = _submit("High %s" % run, "High priority.", priority=10)["task_id"]

    open_tasks = _call("task_list", {"status": "open", "limit": 50}, MUSE_TOKEN)
    ids = [t["id"] for t in open_tasks]
    assert ids.index(high) < ids.index(low), \
        "higher priority task must appear before lower priority task"


# ── scope enforcement ────────────────────────────────────────────────────────

def test_muse_cannot_claim():
    """Muse's token has task_submit but not task_claim."""
    run = uuid.uuid4().hex[:6]
    task_id = _submit("Scope test %s" % run, "Body.")["task_id"]
    r = _call("task_claim", {"task_id": task_id, "agent_name": "muse"}, MUSE_TOKEN)
    assert not r.get("ok") or r.get("isError"), \
        "Muse must not be able to claim tasks"


def test_muse_cannot_complete():
    """Muse cannot mark tasks done."""
    r = _call("task_complete", {"task_id": "fake-id", "result_notes": "hacked"}, MUSE_TOKEN)
    assert not r.get("ok") or r.get("isError"), \
        "Muse must not be able to complete tasks"


def test_muse_cannot_release():
    r = _call("task_release", {"task_id": "fake-id"}, MUSE_TOKEN)
    assert not r.get("ok") or r.get("isError"), \
        "Muse must not be able to release tasks"


def test_agent_cannot_submit():
    """Agent token has claim/complete/release but not task_submit."""
    r = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": "task_submit",
                         "arguments": {"title": "x", "body": "y"}}}, AGENT_TOKEN)
    import json
    res = r.get("result", {})
    assert res.get("isError"), "agent must not be able to submit tasks"
    assert "scope" in res["content"][0]["text"].lower()


def test_task_list_visible_to_all():
    """task_list is a read tool — all token holders can call it."""
    for token in (MUSE_TOKEN, AGENT_TOKEN, "shared-read-token"):
        result = _call("task_list", {}, token)
        assert isinstance(result, list), \
            "task_list must return a list for token %r" % token


def test_complete_requires_claim_first():
    """task_complete from open (unclaimed) must fail."""
    run = uuid.uuid4().hex[:6]
    task_id = _submit("No claim %s" % run, "Body.")["task_id"]
    r = _call("task_complete", {"task_id": task_id, "result_notes": "skip"}, AGENT_TOKEN)
    assert not r.get("ok"), "completing an unclaimed task must fail"


if __name__ == "__main__":
    print("agent task queue")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
