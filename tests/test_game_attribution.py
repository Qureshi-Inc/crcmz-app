#!/usr/bin/env python3
"""Game attribution: clip.game_name / title_id set from play_sessions or live API.

Run in the image:
  docker run --rm -e SESSION_SECRET=test -e NPSSO_TOKEN=t -e GROUP_ID=g \
    -e MCP_TOKEN=shared \
    -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_game_attribution.py
"""
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("MCP_TOKEN", "shared-read-token")
os.environ["CLIPS_DB"] = "/tmp/test_game_attr_%s.db" % uuid.uuid4().hex[:8]

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


import clips as _clips_mod
from pathlib import Path
_clips_mod._DB_PATH = Path(os.environ["CLIPS_DB"])
_clips_mod.init()

GRP = "test-group-g"
SENDER = "shooter1"


def _uid():
    return "msg-" + uuid.uuid4().hex[:12]


def _ugc():
    return "ugc-" + uuid.uuid4().hex[:8]


# ── set_game ─────────────────────────────────────────────────────────────────

def test_set_game_persists():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "g", SENDER)
    _clips_mod.set_game(uid, "Battlefield™ 6", "PPSA19534_00")
    row = _clips_mod.get(uid)
    assert row["game_name"] == "Battlefield™ 6"
    assert row["title_id"] == "PPSA19534_00"


def test_set_game_no_overwrite():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "g", SENDER)
    _clips_mod.set_game(uid, "ARC Raiders", "PPSA04998_00")
    _clips_mod.set_game(uid, "Different Game", "XXXX_00")  # must not overwrite
    row = _clips_mod.get(uid)
    assert row["game_name"] == "ARC Raiders", "set_game must not overwrite existing value"


def test_set_game_noop_on_empty():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "g", SENDER)
    _clips_mod.set_game(uid, "", "XXXX")
    row = _clips_mod.get(uid)
    assert row["game_name"] is None


def test_claim_game_null_by_default():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "g", SENDER)
    row = _clips_mod.get(uid)
    assert row["game_name"] is None
    assert row["title_id"] is None


# ── untagged_game_clips backfill query ───────────────────────────────────────

def test_untagged_returns_clips_without_game():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "g", SENDER,
                     psn_created_ms=int(time.time() * 1000))
    since = time.time() - 60
    untagged = _clips_mod.untagged_game_clips(since, limit=50)
    ids = [c["message_uid"] for c in untagged]
    assert uid in ids


def test_untagged_excludes_tagged_clips():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "g", SENDER,
                     psn_created_ms=int(time.time() * 1000))
    _clips_mod.set_game(uid, "Fortnite", "PPSA01922_00")
    since = time.time() - 60
    untagged = _clips_mod.untagged_game_clips(since, limit=50)
    ids = [c["message_uid"] for c in untagged]
    assert uid not in ids, "tagged clip must not appear in untagged_game_clips"


# ── _game_from_sessions logic ─────────────────────────────────────────────────

def test_game_from_sessions_finds_overlapping_session():
    """Session that contains the clip timestamp is found."""
    import server as _srv
    import game_history as _gh

    sender = "session-player-" + uuid.uuid4().hex[:4]
    now = int(time.time())
    session_start = now - 3600  # 1h ago
    session_last  = now - 60    # ended 60s ago

    with _gh._lock, _gh._conn() as db:
        db.execute(
            "INSERT INTO play_sessions (online_id, game, started_at, last_seen_at, samples)"
            " VALUES (?,?,?,?,?)",
            (sender, "Call of Duty Test", session_start, session_last, 10))
        db.execute(
            "INSERT OR IGNORE INTO game_titles (online_id, title_id, name, updated_at)"
            " VALUES (?,?,?,?)",
            (sender, "CUSA99999_00", "Call of Duty Test", now))
        db.commit()

    clip_ts = float(now - 1800)  # 30 min ago, within session window
    game, tid = _srv._game_from_sessions(sender, clip_ts)
    assert game == "Call of Duty Test", f"expected CoD, got {game!r}"
    assert tid == "CUSA99999_00", f"expected title id, got {tid!r}"


def test_game_from_sessions_no_match_outside_window():
    """Clip timestamp before any session returns None."""
    import server as _srv

    sender = "no-session-" + uuid.uuid4().hex[:4]
    game, tid = _srv._game_from_sessions(sender, time.time() - 86400)
    assert game is None


# ── recent_clips tool exposes game field ─────────────────────────────────────

def test_recent_clips_includes_game_fields():
    import json
    import mcp_server

    # Seed a clip with game name
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "g", SENDER,
                     psn_created_ms=int(time.time() * 1000))
    _clips_mod.set_game(uid, "Battlefield™ 6", "PPSA19534_00")

    caller = mcp_server.resolve_caller("Bearer shared-read-token")
    out, _ = mcp_server.handle_body(
        json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "method": "tools/call",
            "params": {"name": "recent_clips", "arguments": {"limit": 5}},
        }).encode(),
        caller=caller)
    clips = json.loads(out["result"]["content"][0]["text"])
    assert isinstance(clips, list)
    # Find our clip
    match = next((c for c in clips if c.get("clip_id") == uid), None)
    if match:
        assert match.get("game") == "Battlefield™ 6"
        assert match.get("title_id") == "PPSA19534_00"
    # All clips must have the game key (even if null)
    for c in clips:
        assert "game" in c, "game key must be present even if null"
        assert "title_id" in c, "title_id key must be present even if null"


if __name__ == "__main__":
    print("game attribution")
    ORDERED = [
        test_claim_game_null_by_default,
        test_set_game_persists,
        test_set_game_no_overwrite,
        test_set_game_noop_on_empty,
        test_untagged_returns_clips_without_game,
        test_untagged_excludes_tagged_clips,
        test_game_from_sessions_finds_overlapping_session,
        test_game_from_sessions_no_match_outside_window,
        test_recent_clips_includes_game_fields,
    ]
    for fn in ORDERED:
        check(fn.__name__[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
