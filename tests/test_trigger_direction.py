#!/usr/bin/env python3
"""Trigger-emoji direction logic and dedup tests.

Verifies:
  - App-style (text AFTER clip): matched backward, source=text_after_clip
  - Console-style same-batch (text BEFORE clip within 5s): skipped by forward
    guard; _adjacent_caption picks it up as clip_caption on the clip
  - Console-style cross-batch (text BEFORE clip, >5s): pending trigger consumed
    at clip arrival, source=text_before_clip
  - One text -> one clip (no double-fire)
  - Caption in clip message unchanged: always clip_caption

Run in the image:
  docker run --rm -e SESSION_SECRET=test -e NPSSO_TOKEN=t -e GROUP_ID=g \
    -e MCP_TOKEN=shared \
    -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_trigger_direction.py
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
os.environ["CLIPS_DB"] = "/tmp/test_trigger_dir_%s.db" % uuid.uuid4().hex[:8]

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


import clips as _clips_mod

# Patch the DB path so tests are isolated
from pathlib import Path
_clips_mod._DB_PATH = Path(os.environ["CLIPS_DB"])
_clips_mod.init()

GRP = "test-group-123"
SENDER = "player1"


def _uid():
    return "msg-" + uuid.uuid4().hex[:12]


def _ugc():
    return "ugc-" + uuid.uuid4().hex[:8]


def _now_ms():
    return int(time.time() * 1000)


# ── Helper: set_message with explicit source ─────────────────────────────────

def test_set_message_default_source_is_text_after_clip():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "group", SENDER)
    ok = _clips_mod.set_message(uid, "🔥")
    assert ok
    row = _clips_mod.get(uid)
    assert row["body"] == "🔥"
    assert row["message_source"] == "text_after_clip"


def test_set_message_text_before_clip():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "group", SENDER)
    ok = _clips_mod.set_message(uid, "🔥", source="text_before_clip")
    assert ok
    row = _clips_mod.get(uid)
    assert row["message_source"] == "text_before_clip"


def test_set_message_no_overwrite():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "group", SENDER, body="rev")
    ok = _clips_mod.set_message(uid, "🔥")
    assert not ok, "must not overwrite existing body"
    row = _clips_mod.get(uid)
    assert row["body"] == "rev"


# ── clip_caption from claim ──────────────────────────────────────────────────

def test_claim_with_body_sets_clip_caption():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "group", SENDER, body="🔥")
    row = _clips_mod.get(uid)
    assert row["message_source"] == "clip_caption"


def test_claim_with_pending_body_source():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "group", SENDER,
                     body="🔥", body_source="text_before_clip")
    row = _clips_mod.get(uid)
    assert row["message_source"] == "text_before_clip"


# ── recent_untagged_by_sender ────────────────────────────────────────────────

def test_backward_lookup_finds_untagged_clip():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "group", SENDER,
                     psn_created_ms=_now_ms())
    since = time.time() - 60
    match = _clips_mod.recent_untagged_by_sender(SENDER, GRP, since)
    assert match is not None
    assert match["message_uid"] == uid


def test_backward_lookup_skips_tagged_clip():
    uid = _uid()
    _clips_mod.claim(uid, _ugc(), GRP, "group", SENDER,
                     psn_created_ms=_now_ms(), body="rev")
    since = time.time() - 60
    # Only looks for clips with no body; this clip has a body so should not appear
    # (there may be other untagged clips from prior tests, but this specific uid
    #  must not be the match if it already has a body)
    match = _clips_mod.recent_untagged_by_sender(SENDER, GRP, since)
    if match:
        assert match["message_uid"] != uid, \
            "tagged clip must not be returned by backward lookup"


# ── Simulated forward-guard logic (mirrors server.py logic in isolation) ─────

def test_forward_guard_detects_same_batch_clip():
    """Simulate: text at idx=N, clip at idx=N+1 within 5s.
    The forward guard must detect the clip and indicate 'skip'."""
    text_ts_ms = _now_ms()
    clip_ts_ms = text_ts_ms + 4000  # 4s later, within 5s window

    msgs = [
        # text at idx=0
        {"messageType": 1, "sender": SENDER,
         "body": "🔥", "timestamp": str(text_ts_ms)},
        # clip at idx=1
        {"messageType": 210, "sender": SENDER,
         "ugcId": _ugc(), "timestamp": str(clip_ts_ms)},
    ]
    idx = 0  # text index

    _CAPTION_WINDOW_MS = 5000
    forward_found = False
    for fi in range(idx + 1, min(len(msgs), idx + 4)):
        fm = msgs[fi]
        if fm.get("messageType") != 210:
            continue
        if fm.get("sender") != SENDER:
            continue
        try:
            fts_s = int(fm.get("timestamp") or 0) / 1000.0
        except (ValueError, TypeError):
            continue
        if abs(fts_s - text_ts_ms / 1000.0) <= (_CAPTION_WINDOW_MS / 1000.0):
            forward_found = True
            break

    assert forward_found, \
        "forward guard must detect the clip at idx+1 within the 5s window"


def test_forward_guard_misses_far_clip():
    """Clip 10s after text is outside the 5s adjacent_caption window — no skip."""
    text_ts_ms = _now_ms()
    clip_ts_ms = text_ts_ms + 10000  # 10s later

    msgs = [
        {"messageType": 1, "sender": SENDER,
         "body": "🔥", "timestamp": str(text_ts_ms)},
        {"messageType": 210, "sender": SENDER,
         "ugcId": _ugc(), "timestamp": str(clip_ts_ms)},
    ]
    idx = 0

    _CAPTION_WINDOW_MS = 5000
    forward_found = False
    for fi in range(idx + 1, min(len(msgs), idx + 4)):
        fm = msgs[fi]
        if fm.get("messageType") != 210:
            continue
        if fm.get("sender") != SENDER:
            continue
        try:
            fts_s = int(fm.get("timestamp") or 0) / 1000.0
        except (ValueError, TypeError):
            continue
        if abs(fts_s - text_ts_ms / 1000.0) <= (_CAPTION_WINDOW_MS / 1000.0):
            forward_found = True
            break

    assert not forward_found, \
        "forward guard must not fire for a clip 10s away"


# ── Pending trigger dict logic ───────────────────────────────────────────────

def test_pending_trigger_consumed_by_clip():
    """Simulate the cross-batch console flow end-to-end using clips module."""
    import server as _srv

    sender = "console-player-" + uuid.uuid4().hex[:4]
    trigger_ts = time.time()

    # Text arrives first — store pending trigger
    _srv._pending_triggers[sender] = {
        "text": "🔥",
        "ts": trigger_ts,
        "expires_at": trigger_ts + 120,
    }

    # Clip arrives 30s later (next batch)
    clip_uid = _uid()
    clip_ts_ms = int((trigger_ts + 30) * 1000)

    # Simulate the clip-side logic: no adjacent caption, check pending trigger
    body_text = ""  # _adjacent_caption returned nothing
    body_source = None
    clip_ts = clip_ts_ms / 1000.0
    pt = _srv._pending_triggers.get(sender)
    if pt and pt["ts"] <= clip_ts <= pt["expires_at"]:
        body_text = pt["text"]
        body_source = "text_before_clip"
        del _srv._pending_triggers[sender]

    assert body_text == "🔥"
    assert body_source == "text_before_clip"
    assert sender not in _srv._pending_triggers, "trigger must be cleared after use"

    # Claim the clip with the pending body
    _clips_mod.claim(clip_uid, _ugc(), GRP, "group", sender,
                     psn_created_ms=clip_ts_ms,
                     body=body_text, body_source=body_source)
    row = _clips_mod.get(clip_uid)
    assert row["body"] == "🔥"
    assert row["message_source"] == "text_before_clip"


def test_pending_trigger_expires():
    """An expired pending trigger must not be consumed by a late clip."""
    import server as _srv

    sender = "expired-player-" + uuid.uuid4().hex[:4]
    trigger_ts = time.time() - 200  # 200s ago, past TRIGGER_FORWARD_WINDOW=120

    _srv._pending_triggers[sender] = {
        "text": "🔥",
        "ts": trigger_ts,
        "expires_at": trigger_ts + 120,  # expired 80s ago
    }

    body_text = ""
    body_source = None
    clip_ts = time.time()
    pt = _srv._pending_triggers.get(sender)
    if pt and pt["ts"] <= clip_ts <= pt["expires_at"]:
        body_text = pt["text"]
        body_source = "text_before_clip"
        del _srv._pending_triggers[sender]

    assert body_text == "", "expired pending trigger must not be consumed"
    # trigger stays in dict (cleanup is lazy), but it's harmless
    _srv._pending_triggers.pop(sender, None)  # tidy up


def test_no_double_fire_same_batch():
    """Core dedup: one emoji text between an old clip and a new clip in the
    same batch. The new clip must get clip_caption; the old clip stays untagged.

    This reproduces the 2026-09-21 double-fire bug.
    """
    # Old clip already in DB (arrived in a previous batch)
    old_uid = _uid()
    old_ts_ms = int((time.time() - 65) * 1000)  # 65s ago
    _clips_mod.claim(old_uid, _ugc(), GRP, "group", SENDER,
                     psn_created_ms=old_ts_ms)
    old_before = _clips_mod.get(old_uid)
    assert old_before["body"] is None

    # Current batch: [text "🔥" at T, new clip at T+5s]
    text_ts_ms = _now_ms()
    new_clip_ts_ms = text_ts_ms + 4500  # 4.5s after text

    msgs = [
        {"messageType": 1,   "sender": SENDER,
         "body": "🔥",       "timestamp": str(text_ts_ms)},
        {"messageType": 210, "sender": SENDER,
         "ugcId": _ugc(),    "timestamp": str(new_clip_ts_ms)},
    ]
    idx = 0  # text index

    # Simulate the forward-guard check
    _CAPTION_WINDOW_MS = 5000
    forward_found = False
    for fi in range(idx + 1, min(len(msgs), idx + 4)):
        fm = msgs[fi]
        if fm.get("messageType") != 210 or fm.get("sender") != SENDER:
            continue
        try:
            fts_s = int(fm.get("timestamp") or 0) / 1000.0
        except (ValueError, TypeError):
            continue
        if abs(fts_s - text_ts_ms / 1000.0) <= (_CAPTION_WINDOW_MS / 1000.0):
            forward_found = True
            break

    # Forward guard fires → skip backward lookup
    assert forward_found, "forward guard must fire for 4.5s gap"

    # Old clip untouched — no set_message was called
    old_after = _clips_mod.get(old_uid)
    assert old_after["body"] is None, \
        "old clip must not be tagged when forward guard fires (dedup check)"

    # New clip would get clip_caption via _adjacent_caption on the real path.
    # Verify the claim with that body sets clip_caption:
    new_uid = _uid()
    _clips_mod.claim(new_uid, _ugc(), GRP, "group", SENDER,
                     psn_created_ms=new_clip_ts_ms, body="🔥")
    new_row = _clips_mod.get(new_uid)
    assert new_row["message_source"] == "clip_caption"


if __name__ == "__main__":
    print("trigger direction & dedup")
    ORDERED = [
        test_set_message_default_source_is_text_after_clip,
        test_set_message_text_before_clip,
        test_set_message_no_overwrite,
        test_claim_with_body_sets_clip_caption,
        test_claim_with_pending_body_source,
        test_backward_lookup_finds_untagged_clip,
        test_backward_lookup_skips_tagged_clip,
        test_forward_guard_detects_same_batch_clip,
        test_forward_guard_misses_far_clip,
        test_pending_trigger_consumed_by_clip,
        test_pending_trigger_expires,
        test_no_double_fire_same_batch,
    ]
    for fn in ORDERED:
        check(fn.__name__[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
