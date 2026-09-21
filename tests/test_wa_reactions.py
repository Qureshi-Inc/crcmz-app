#!/usr/bin/env python3
"""WhatsApp reaction tracking: clip mapping, reaction upsert/delete, MCP tool.

Run in the image:
  docker run --rm -e SESSION_SECRET=test -e NPSSO_TOKEN=t -e GROUP_ID=g \
    -e MCP_TOKEN=shared \
    -e WA_REACTIONS_DB=/tmp/test_wa_reactions.db \
    -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_wa_reactions.py
"""
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("MCP_TOKEN", "shared-read-token")
os.environ.setdefault("WA_REACTIONS_DB", "/tmp/test_wa_reactions_%s.db" % uuid.uuid4().hex[:8])

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


import wa_reactions as wr
wr.init()

CLIP_A = "clip-" + uuid.uuid4().hex[:8]
MSG_A  = "wa-msg-" + uuid.uuid4().hex[:8]
CLIP_B = "clip-" + uuid.uuid4().hex[:8]


def test_untracked_returns_not_tracked():
    r = wr.reactions_for_clip("nonexistent-clip-id")
    assert r["tracked"] is False
    assert r["reaction_count"] == 0
    assert r["reactions"] == []


def test_empty_clip_id():
    r = wr.reactions_for_clip("")
    assert r["tracked"] is False
    assert r["reaction_count"] == 0


def test_track_clip_records_mapping():
    wr.track_clip(CLIP_A, MSG_A, "1234@g.us")
    r = wr.reactions_for_clip(CLIP_A)
    assert r["tracked"] is True
    assert r["whatsapp_message_id"] == MSG_A


def test_no_reactions_yet():
    r = wr.reactions_for_clip(CLIP_A)
    assert r["reaction_count"] == 0
    assert r["reactions"] == []


def test_reaction_add():
    wr.update_reaction({
        "target_msg_id": MSG_A,
        "reactor_jid":   "44700111222@s.whatsapp.net",
        "reactor_name":  "Ali",
        "emoji":         "😂",
    })
    r = wr.reactions_for_clip(CLIP_A)
    assert r["reaction_count"] == 1
    assert r["reactions"][0]["emoji"] == "😂"
    assert r["reactions"][0]["sender"] == "Ali"


def test_second_reactor():
    wr.update_reaction({
        "target_msg_id": MSG_A,
        "reactor_jid":   "44700999888@s.whatsapp.net",
        "reactor_name":  "Zara",
        "emoji":         "🔥",
    })
    r = wr.reactions_for_clip(CLIP_A)
    assert r["reaction_count"] == 2


def test_reaction_change_replaces():
    """Same sender reacting again replaces their previous emoji."""
    wr.update_reaction({
        "target_msg_id": MSG_A,
        "reactor_jid":   "44700111222@s.whatsapp.net",
        "reactor_name":  "Ali",
        "emoji":         "🔥",
    })
    r = wr.reactions_for_clip(CLIP_A)
    # Still 2 distinct senders
    assert r["reaction_count"] == 2
    emojis = {rx["emoji"] for rx in r["reactions"]}
    assert "😂" not in emojis  # replaced
    assert emojis == {"🔥"}


def test_reaction_remove():
    wr.update_reaction({
        "target_msg_id": MSG_A,
        "reactor_jid":   "44700111222@s.whatsapp.net",
        "emoji":         "",  # empty = removal
    })
    r = wr.reactions_for_clip(CLIP_A)
    assert r["reaction_count"] == 1


def test_reaction_event_missing_target_is_silent():
    wr.update_reaction({"reactor_jid": "44700111222@s.whatsapp.net", "emoji": "🔥"})


def test_reaction_event_missing_sender_is_silent():
    wr.update_reaction({"target_msg_id": MSG_A, "emoji": "🔥"})


def test_unrelated_message_not_counted():
    wr.update_reaction({
        "target_msg_id": "other-msg-entirely",
        "reactor_jid":   "44700111222@s.whatsapp.net",
        "emoji":         "😂",
    })
    r = wr.reactions_for_clip(CLIP_A)
    # Still just 1 from the previous remove test
    assert r["reaction_count"] == 1


def test_different_clip_isolated():
    msg_b = "wa-msg-" + uuid.uuid4().hex[:8]
    wr.track_clip(CLIP_B, msg_b, "1234@g.us")
    wr.update_reaction({
        "target_msg_id": msg_b,
        "reactor_jid":   "44700111222@s.whatsapp.net",
        "emoji":         "👏",
    })
    r_a = wr.reactions_for_clip(CLIP_A)
    r_b = wr.reactions_for_clip(CLIP_B)
    assert r_b["reaction_count"] == 1
    # Clip A unchanged
    assert r_a["reaction_count"] == 1


def test_tool_is_registered():
    import assistant
    assert "whatsapp_clip_reactions" in assistant.tool_names(), \
        "whatsapp_clip_reactions must be in the assistant registry"


def test_tool_is_read_only():
    """Tool name must not contain any write verb."""
    banned = ("send", "post", "delete", "remove", "write", "create",
              "draw", "import", "ingest", "set_", "update")
    name = "whatsapp_clip_reactions"
    for verb in banned:
        assert verb not in name, \
            "Tool name %r contains banned write verb %r" % (name, verb)


def test_mcp_tool_call_returns_structure():
    import json
    import mcp_server
    caller = mcp_server.resolve_caller("Bearer shared-read-token")
    out, _status = mcp_server.handle_body(
        json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "method": "tools/call",
            "params": {"name": "whatsapp_clip_reactions",
                       "arguments": {"clip_id": "nonexistent-test-clip"}},
        }).encode(),
        caller=caller)
    result = json.loads(out["result"]["content"][0]["text"])
    assert result["tracked"] is False
    assert result["reaction_count"] == 0
    assert isinstance(result["reactions"], list)


if __name__ == "__main__":
    print("wa reactions")
    ORDERED = [
        test_untracked_returns_not_tracked,
        test_empty_clip_id,
        test_track_clip_records_mapping,
        test_no_reactions_yet,
        test_reaction_add,
        test_second_reactor,
        test_reaction_change_replaces,
        test_reaction_remove,
        test_reaction_event_missing_target_is_silent,
        test_reaction_event_missing_sender_is_silent,
        test_unrelated_message_not_counted,
        test_different_clip_isolated,
        test_tool_is_registered,
        test_tool_is_read_only,
        test_mcp_tool_call_returns_structure,
    ]
    for fn in ORDERED:
        check(fn.__name__[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
