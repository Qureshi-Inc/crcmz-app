#!/usr/bin/env python3
"""AI coaching pipeline: the rev trigger, scoped service tokens, and the
notification boundary.

The property that matters most here: a scoped service token must NOT be able to
send messages. The analyser's input is a PSN caption (user-controlled text), so
if it could reach send_whatsapp_dm a poisoned caption would become a message.

  docker run --rm -e SESSION_SECRET=test -e NPSSO_TOKEN=t -e GROUP_ID=g \
    -e MCP_TOKEN=shared -e CRCMZ_SERVICE_TOKENS='muse:muse-token-abcdefghij:coach_review_record' \
    -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_coaching.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ.setdefault("MCP_TOKEN", "shared-read-token")
os.environ.setdefault(
    "CRCMZ_SERVICE_TOKENS", "muse:muse-token-abcdefghij:coach_review_record")

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


SERVICE_TOKEN = "muse-token-abcdefghij"


# ── the rev trigger ──────────────────────────────────────────────────────────

def test_rev_trigger_word_boundary():
    import server
    fires = ["rev", "Rev", "REV!", "rev this one", "please rev 🤣", "rev.",
             "revenge rev"]
    quiet = ["revenge", "my revenge", "reverse", "preview", "reverb", "", None,
             "reveal", "revving"]
    for c in fires:
        assert server._wants_coaching(c), "%r should request coaching" % c
    for c in quiet:
        assert not server._wants_coaching(c), "%r must NOT request coaching" % c


# ── scoped service tokens ────────────────────────────────────────────────────

def test_service_token_resolves_with_its_scope():
    import mcp_server
    c = mcp_server.resolve_service("Bearer " + SERVICE_TOKEN)
    assert c is not None, "valid service token must resolve"
    assert c["scopes"] == {"coach_review_record"}, c
    assert c["zitadel_id"].startswith("service:"), "must be attributable for audit"
    assert mcp_server.resolve_service("Bearer wrong-token-value-here") is None


def test_short_service_token_refused():
    """A guessable service credential must not be accepted."""
    import importlib
    import mcp_server
    os.environ["CRCMZ_SERVICE_TOKENS"] = "weak:short:coach_review_record"
    importlib.reload(mcp_server)
    try:
        assert mcp_server.resolve_service("Bearer short") is None, \
            "a sub-16-char service token must be rejected"
    finally:
        os.environ["CRCMZ_SERVICE_TOKENS"] = \
            "muse:muse-token-abcdefghij:coach_review_record"
        importlib.reload(mcp_server)


def _rpc(body, token):
    import json
    import mcp_server
    caller = None
    if not mcp_server.authorised("Bearer " + token):
        caller = (mcp_server.resolve_caller("Bearer " + token)
                  or mcp_server.resolve_service("Bearer " + token))
    out, _status = mcp_server.handle_body(json.dumps(body).encode(), caller=caller)
    return out


def test_scoped_token_cannot_send_messages():
    """THE point of the scope: no messaging tool is reachable."""
    for tool in ("send_whatsapp_dm", "send_psn_group_message",
                 "send_whatsapp_group_message", "send_mattermost_dm",
                 "send_mattermost_channel_message", "clawbot_build"):
        r = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": tool, "arguments": {"to": "x", "message": "y"}}},
                 SERVICE_TOKEN)
        res = r.get("result", {})
        assert res.get("isError"), "%s must be refused for a scoped token" % tool
        text = res["content"][0]["text"]
        assert "scope" in text.lower(), \
            "%s refusal should name the scope, got: %s" % (tool, text)


def test_scoped_token_does_not_advertise_forbidden_tools():
    r = _rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
             SERVICE_TOKEN)
    names = {t["name"] for t in r["result"]["tools"]}
    assert "coach_review_record" in names, "its own tool must be listed"
    for bad in ("send_whatsapp_dm", "clawbot_build", "send_psn_group_message"):
        assert bad not in names, "scoped token must not see %s" % bad


def test_shared_read_token_still_has_no_write_tools():
    r = _rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}},
             os.environ["MCP_TOKEN"])
    names = {t["name"] for t in r["result"]["tools"]}
    assert "coach_review_record" not in names, \
        "the shared read token must not gain a write tool"
    assert "recent_clips" in names


# ── notification boundary ────────────────────────────────────────────────────

def test_notify_is_idempotent_flagging():
    import coach
    coach.init()
    rid = coach.upsert({"clip_id": "test-clip-notify", "psn_user": "nobody",
                        "review_status": "complete"})
    assert coach.needs_notification(rid), "a fresh complete review needs notifying"
    coach.mark_notified(rid)
    assert not coach.needs_notification(rid), \
        "after notifying, a resubmit must not notify again"


def test_resubmit_does_not_renotify():
    """INSERT OR REPLACE must not wipe notified_at — otherwise every analyser
    retry re-DMs the member."""
    import coach
    coach.init()
    rid = coach.upsert({"clip_id": "test-clip-resubmit", "psn_user": "nobody",
                        "review_status": "complete"})
    coach.mark_notified(rid)
    assert not coach.needs_notification(rid)
    # analyser resubmits the same review, carrying the flag forward
    existing = coach.get_any_by_clip("test-clip-resubmit")
    coach.upsert({"review_id": existing["review_id"],
                  "clip_id": "test-clip-resubmit", "psn_user": "nobody",
                  "summary": "updated analysis", "review_status": "complete",
                  "notified_at": existing.get("notified_at")})
    assert not coach.needs_notification(rid), \
        "a resubmit must not make the member notifiable again"


def test_claim_notification_is_atomic():
    """The load-bearing guard. needs_notification() is check-then-act, so only the
    conditional UPDATE in claim_notification can stop a concurrent double-DM."""
    import coach
    coach.init()
    rid = coach.upsert({"clip_id": "test-clip-atomic", "psn_user": "nobody",
                        "review_status": "complete"})
    assert coach.claim_notification(rid) is True, "first claimant must win"
    assert coach.claim_notification(rid) is False, \
        "a second concurrent submit must NOT also get to send"
    # a failed send hands the claim back so a retry can pick it up
    coach.release_notification(rid)
    assert coach.claim_notification(rid) is True, \
        "released claim must be retryable after a failed send"


def test_pending_review_cannot_be_claimed():
    import coach
    coach.init()
    rid = coach.upsert({"clip_id": "test-clip-noclaim", "psn_user": "nobody",
                        "review_status": "pending"})
    assert coach.claim_notification(rid) is False, \
        "an unfinished review must never notify"


def test_zitadel_id_is_persisted_for_the_join():
    """/coaching must join on the Zitadel sub: PSN online IDs are renameable."""
    import coach
    coach.init()
    rid = coach.upsert({"clip_id": "test-clip-zid", "psn_user": "SomeOldName",
                        "zitadel_id": "zid-123", "review_status": "complete"})
    got = coach.get(rid)
    assert got.get("zitadel_id") == "zid-123", "zitadel_id must survive upsert"
    coach.mark_notified(rid)
    coach.upsert({"review_id": rid, "clip_id": "test-clip-zid",
                  "psn_user": "ARenamedAccount", "zitadel_id": "zid-123",
                  "review_status": "complete",
                  "notified_at": coach.get(rid).get("notified_at")})
    assert coach.get(rid).get("zitadel_id") == "zid-123", \
        "renaming the PSN account must not orphan the review"


def test_pending_review_is_not_notified():
    import coach
    coach.init()
    rid = coach.upsert({"clip_id": "test-clip-pending", "psn_user": "nobody",
                        "review_status": "pending"})
    assert not coach.needs_notification(rid), \
        "a pending review must not trigger a member notification"


def test_claim_for_review_is_idempotent():
    import coach
    coach.init()
    first = coach.claim_for_review("test-clip-claim", "somebody")
    assert first, "first claim should create a review"
    again = coach.claim_for_review("test-clip-claim", "somebody")
    assert again is None, "re-seeing the same clip must not queue it twice"


def test_notify_helper_never_raises_without_a_jid():
    """A member with no WhatsApp JID must not fail the review write."""
    import assistant
    ok, note = assistant._notify_coaching_ready("")
    assert ok is False and note, "empty sender should report, not raise"
    ok, note = assistant._notify_coaching_ready("definitely-not-a-member")
    assert ok is False and note, "unknown member should report, not raise"


def test_service_messages_are_attributed_to_the_service():
    """A service token has no Zitadel profile, so without its own label anything it
    emits would be signed "unknown"."""
    import mcp_server, assistant
    c = mcp_server.resolve_service("Bearer " + SERVICE_TOKEN)
    assert c.get("label") == "muse", "service label must be carried on the caller"
    assert assistant._caller_name(c) == "Muse", \
        "a service must be named, not resolved to 'unknown'"
    # a human with no resolvable profile still falls back, unchanged
    assert assistant._caller_name({"zitadel_id": "nobody"}) == "unknown"


def test_coaching_notification_is_tagged_with_the_service():
    import assistant, wa_ai, crcmz_identity, coach_prefs, mcp_server
    import os as _os
    _os.environ["WA_BRIDGE_URL"] = "http://stub"
    _os.environ["WA_GOOPERS_JID"] = "group@g.us"
    sent = {}
    orig_send, orig_res = wa_ai.send_reply, crcmz_identity.resolve
    wa_ai.send_reply = lambda u, j, t: (sent.update({"jid": j, "text": t}) or True)
    crcmz_identity.resolve = lambda w: {"zitadel_id": "zid-tag", "display_name": "Soup",
                                        "wa_jid": "me@s.whatsapp.net"}
    try:
        caller = mcp_server.resolve_service("Bearer " + SERVICE_TOKEN)
        coach_prefs.set_mode("zid-tag", "group")
        ok, _ = assistant._notify_coaching_ready("somebody", caller)
        assert ok and sent["text"].startswith("[Muse] "), sent.get("text")
        assert sent["jid"] == "group@g.us", "group mode must target the group"
        assert "@Soup" in sent["text"], "group post should mention the member"

        coach_prefs.set_mode("zid-tag", "dm")
        sent.clear()
        ok, _ = assistant._notify_coaching_ready("somebody", caller)
        assert ok and sent["jid"] == "me@s.whatsapp.net", "dm mode must target the member"
        assert sent["text"].startswith("[Muse] ")

        coach_prefs.set_mode("zid-tag", "off")
        sent.clear()
        ok, note = assistant._notify_coaching_ready("somebody", caller)
        assert ok is False and sent == {}, "off must send nothing at all"
    finally:
        wa_ai.send_reply, crcmz_identity.resolve = orig_send, orig_res


# ── grade + tags contract ────────────────────────────────────────────────────

def test_grade_normalisation():
    import assistant as a
    assert a._normalise_grade("B", "") == "B"
    assert a._normalise_grade("b", "") == "B", "lower case should be accepted"
    # falls back to the leading token of the agreed "<GRADE> — <phrase>" form
    assert a._normalise_grade("", "B — solid aim, late rotations") == "B"
    assert a._normalise_grade("", "S - exceptional") == "S"
    # anything unrecognised stays empty rather than being guessed at
    assert a._normalise_grade("", "pretty good actually") == ""
    assert a._normalise_grade("F", "") == "", "F is not in the S-D scale"


def test_tag_normalisation_keeps_unknown_tags():
    import assistant as a
    assert a._normalise_tags(["Rotation", "GUNSKILL"]) == ["rotation", "gunskill"]
    assert a._normalise_tags(["crosshair_placement"]) == ["crosshair-placement"]
    assert a._normalise_tags(["rotation", "rotation"]) == ["rotation"], "dedupe"
    # an off-vocabulary tag is kept, not dropped: losing analyser output to a typo
    # is worse than an unexpected chip
    assert a._normalise_tags(["something-new"]) == ["something-new"]


def test_notify_respects_member_preference():
    import coach_prefs
    assert coach_prefs.get_mode("nobody-set-this") == "group", "group is the default"
    coach_prefs.set_mode("zid-pref-test", "off")
    assert coach_prefs.get_mode("zid-pref-test") == "off"
    import assistant
    ok, note = assistant._notify_coaching_ready("")
    assert ok is False and note
    try:
        coach_prefs.set_mode("zid-pref-test", "shout")
        raise AssertionError("an unknown mode must be rejected")
    except ValueError:
        pass


def test_player_profile_tool_registered_and_read_only():
    import assistant
    names = assistant.tool_names()
    assert "coach_player_profile" in names
    assert "coach_player_profile" not in assistant.write_tool_names(), \
        "characterisation data is a read; it must not sit in the write registry"


if __name__ == "__main__":
    print("coaching pipeline")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
