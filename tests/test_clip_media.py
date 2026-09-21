#!/usr/bin/env python3
"""Clip media exposure: the identifier, the URL tool, and the bearer-gated endpoint.

Runs in the image (imports server). Plain asserts, no pytest:

  docker run --rm -e SESSION_SECRET=test -e MCP_TOKEN=test-mcp-token \
    -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_clip_media.py
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ.setdefault("MCP_TOKEN", "test-mcp-token")

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


# ── storage layer ────────────────────────────────────────────────────────────

def test_local_file_rejects_traversal():
    import clip_store
    assert clip_store.local_file("../../etc/passwd") is None, \
        "a key escaping the clip root must be refused"
    assert clip_store.local_file("clips/../../../etc/passwd") is None


def test_local_file_and_stream_roundtrip():
    import importlib
    with tempfile.TemporaryDirectory() as d:
        os.environ["CLIP_LOCAL_DIR"] = d
        os.environ.pop("CLIP_BUCKET", None)
        import clip_store
        importlib.reload(clip_store)
        key = "clips/original/2026/09/x.mp4"
        p = Path(d) / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"abc" * 1000)
        got = clip_store.local_file(key)
        assert got is not None and got.is_file(), "local_file should resolve a real file"
        assert b"".join(clip_store.stream(key, chunk_size=7)) == b"abc" * 1000, \
            "stream must reassemble to the original bytes"
        assert clip_store.local_file("clips/original/2026/09/missing.mp4") is None


# ── the tool ─────────────────────────────────────────────────────────────────

def test_clip_id_exposed_and_tool_registered():
    import assistant
    names = assistant.tool_names()
    assert "clip_media_url" in names, "clip_media_url must be registered"
    assert "recent_clips" in names


def test_tool_is_not_named_like_a_write():
    import assistant
    banned = ("send", "post", "delete", "write", "create", "set_", "update", "remove")
    for n in assistant.tool_names():
        assert not any(b in n for b in banned), "read registry gained a write-ish name: %s" % n


def _tool(name, args):
    """call_tool returns (json_text, ok) — unwrap it to the payload dict."""
    import json
    import assistant
    body, _ok = assistant.call_tool(name, args)
    return json.loads(body)


def test_tool_requires_clip_id_and_rejects_unknown():
    import clips
    clips.init()
    for args in ({"clip_id": ""}, {}):
        r = _tool("clip_media_url", args)
        assert "error" in r, "missing clip_id must error, not 500: %s" % r
        assert "url" not in r
    r = _tool("clip_media_url", {"clip_id": "definitely-not-a-real-uid"})
    assert "error" in r, "unknown clip must error: %s" % r
    assert "url" not in r, "a rejected lookup must not hand back a URL"


def test_tool_leaks_no_credentials():
    import clips
    clips.init()
    rows = clips.list_clips(limit=5)
    if not rows:
        return                      # nothing archived in this image; nothing to assert
    r = _tool("clip_media_url", {"clip_id": rows[0]["message_uid"]})
    blob = repr(r).lower()
    for bad in ("npsso", "access_token", "refresh_token", "session_secret", "mcp_token"):
        assert bad not in blob, "clip_media_url leaked %s" % bad


def test_tool_does_not_overclaim_range_support():
    """This Starlette's FileResponse ignores Range, so the tool must not promise it."""
    import clips
    clips.init()
    rows = [r for r in clips.list_clips(limit=200)
            if r.get("archive_status") == "archived" and r.get("storage_key_original")]
    if not rows:
        return
    r = _tool("clip_media_url", {"clip_id": rows[0]["message_uid"]})
    assert r.get("supports_range") is False, \
        "endpoint has no Range handling — advertising it would mislead clients"


# ── the endpoint ─────────────────────────────────────────────────────────────

def test_media_endpoint_is_open_path_but_self_authed():
    import server
    assert "/api/clips/media" in server._OPEN_PATHS, \
        "endpoint must bypass the cookie gate so a machine can reach it"


def test_media_endpoint_401s_without_bearer():
    from fastapi.testclient import TestClient
    import server
    c = TestClient(server.app)
    r = c.get("/api/clips/media", params={"uid": "whatever"})
    assert r.status_code == 401, "no bearer must 401, got %s" % r.status_code
    r = c.get("/api/clips/media", params={"uid": "whatever"},
              headers={"Authorization": "Bearer wrong-token"})
    assert r.status_code == 401, "a bad bearer must 401, got %s" % r.status_code


def test_media_endpoint_404s_unknown_clip_with_valid_bearer():
    from fastapi.testclient import TestClient
    import server
    c = TestClient(server.app)
    r = c.get("/api/clips/media", params={"uid": "no-such-clip"},
              headers={"Authorization": "Bearer %s" % os.environ["MCP_TOKEN"]})
    assert r.status_code == 404, "valid bearer + unknown clip must 404, got %s" % r.status_code


def test_media_endpoint_does_not_serve_unarchived():
    """An un-archived clip has no bytes; it must 409 rather than 500 or empty 200."""
    from fastapi.testclient import TestClient
    import server
    import clips
    clips.init()
    pending = [r for r in clips.list_clips(limit=200)
               if r.get("archive_status") != "archived"]
    if not pending:
        return
    c = TestClient(server.app)
    r = c.get("/api/clips/media", params={"uid": pending[0]["message_uid"]},
              headers={"Authorization": "Bearer %s" % os.environ["MCP_TOKEN"]})
    assert r.status_code == 409, "un-archived clip must 409, got %s" % r.status_code


if __name__ == "__main__":
    print("clip media exposure")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
