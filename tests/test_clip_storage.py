#!/usr/bin/env python3
"""Clip storage monitoring: the usage() scan and the clip_storage_status tool.

Runs in the image (imports clip_store + assistant). Plain asserts, no pytest:

    python tests/test_clip_storage.py
"""
import importlib
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


def _local_store(tmpdir, files):
    os.environ["CLIP_LOCAL_DIR"] = tmpdir
    os.environ.pop("CLIP_BUCKET", None)
    import clip_store
    importlib.reload(clip_store)
    for rel, size in files:
        p = Path(tmpdir) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * size)
    return clip_store


# ── clip_store.usage() ───────────────────────────────────────────────────────


def test_usage_counts_local_files_and_bytes():
    with tempfile.TemporaryDirectory() as d:
        cs = _local_store(d, [
            ("clips/original/2026/09/a.mp4", 1000),
            ("clips/original/2026/09/b.mp4", 2500),
            ("clips/other/c.txt", 100),
        ])
        u = cs.usage()
        assert u["bytes"] == 3600, "usage must sum all file sizes, got %r" % u
        assert u["files"] == 3, "usage must count all files, got %r" % u


def test_usage_empty_dir_is_zero_not_none():
    with tempfile.TemporaryDirectory() as d:
        cs = _local_store(d, [])
        u = cs.usage()
        assert u["bytes"] == 0 and u["files"] == 0, \
            "empty archive is 0 bytes/0 files, not unknown: %r" % u


def test_usage_missing_dir_is_zero():
    with tempfile.TemporaryDirectory() as d:
        cs = _local_store(os.path.join(d, "does-not-exist"), [])
        u = cs.usage()
        assert u["bytes"] == 0 and u["files"] == 0, \
            "missing dir must report 0, not crash: %r" % u


# ── clip_storage_status tool ─────────────────────────────────────────────────


def test_storage_status_tool_registered_and_shaped():
    with tempfile.TemporaryDirectory() as d:
        cs = _local_store(d, [("clips/original/2026/09/a.mp4", 4096)])
        import assistant
        importlib.reload(assistant)
        assert "clip_storage_status" in assistant._TOOLS, \
            "the MCP tool must be registered in assistant._TOOLS"
        fn = assistant._TOOLS["clip_storage_status"]["fn"]
        out = fn()
        assert out["backend"] == cs.backend(), "backend must match clip_store"
        assert out["archive_bytes"] == 4096, "archive_bytes must match the scan"
        assert out["archive_files"] == 1
        assert "disk_free_bytes" in out and "disk_total_bytes" in out, \
            "local backend must report disk space: %r" % out
        assert out["disk_free_bytes"] > 0
        assert isinstance(out.get("db_archived_clips"), int)
        assert out.get("measured_at"), "must carry a measurement timestamp"


def test_storage_status_survives_missing_dir():
    with tempfile.TemporaryDirectory() as d:
        _local_store(os.path.join(d, "nope"), [])
        import assistant
        importlib.reload(assistant)
        fn = assistant._TOOLS["clip_storage_status"]["fn"]
        out = fn()  # must not raise
        assert out["archive_bytes"] == 0


if __name__ == "__main__":
    print("clip storage status")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
