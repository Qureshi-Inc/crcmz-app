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


# ── rev clips stay out of the normal pipeline ────────────────────────────────

def test_rev_clip_is_archived_but_not_forwarded_or_montaged():
    """A "rev" clip is a request for analysis, not something being shared. It must
    still be archived, because that is what the coach pipeline fetches, but it must
    reach neither WhatsApp, nor Discord, nor the montage."""
    import server, clips, clip_store
    # These are module constants read at import time, so setting os.environ here
    # would be too late — server is already imported by the time this runs.
    server.WA_BRIDGE_URL = "http://stub"
    server.WA_GOOPERS_JID = "g@g.us"
    clips.init()
    real = [r for r in clips.list_clips(limit=300)
            if r.get("archive_status") == "archived"
            and clip_store.local_file(r.get("storage_key_original") or "")]
    if not real:
        return                      # no archived bytes in this image to replay
    base = real[0]

    sent = {"wa": [], "discord": []}
    orig_wa, orig_dc = server._send_to_wa, server._send_to_discord
    server._send_to_wa = lambda u, d, s_, b: sent["wa"].append(u) or "wa-1"
    server._send_to_discord = lambda u, d, s_, b: sent["discord"].append(u)
    try:
        import uuid as _uuid
        run = _uuid.uuid4().hex[:6]
        for uid, body, is_rev in ((f"t-rev-{run}", "rev this", True),
                                  (f"t-plain-{run}", "sick shot", False)):
            clips.claim(uid, base["ugc_id"], "g", "G", "moiiz41510",
                        1789956485000, body)
            clips.set_archived(uid, base["storage_key_original"],
                               file_size=base.get("file_size"),
                               sha256=base.get("sha256"))
            if is_rev:
                clips.set_coaching_only(uid)
            server._process_clip_job(uid, clips.get(uid))
            if is_rev:
                clips.set_coaching_done(uid)
            row = clips.get(uid)
            if is_rev:
                assert uid not in sent["wa"], "a rev clip must not reach WhatsApp"
                assert uid not in sent["discord"], "a rev clip must not reach Discord"
                assert not row.get("montage_eligible"), \
                    "a rev clip must not be montage-eligible"
                assert row.get("whatsapp_delivered_at") is None, \
                    "a clip that never went to WhatsApp must not record a delivery"
                assert row.get("archive_status") == "archived", \
                    "it must still be archived — that is what Muse fetches"
                assert row.get("status") in ("delivered", "failed"), \
                    "must be terminal, or the worker requeues it forever"
            else:
                assert uid in sent["wa"], "a normal clip must still go to WhatsApp"
                assert row.get("montage_eligible"), \
                    "a normal clip must stay montage-eligible"
    finally:
        server._send_to_wa, server._send_to_discord = orig_wa, orig_dc


def test_coaching_clip_does_not_need_whatsapp_config():
    """The WhatsApp config guard must not block a clip that never uses WhatsApp."""
    import inspect
    import server
    src = inspect.getsource(server._process_clip_job)
    assert "coaching_only = _wants_coaching(body)" in src
    guard = src.index("WA_BRIDGE_URL or WA_GOOPERS_JID not configured")
    flag = src.index("coaching_only = _wants_coaching(body)")
    assert flag < guard, \
        "the coaching check must precede the WhatsApp config guard"


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
    import coach, uuid
    coach.init()
    # Unique per run: /data may be a mounted volume that survives between runs, and
    # a fixed id would make this pass only the first time.
    cid = "test-clip-claim-" + uuid.uuid4().hex[:8]
    first = coach.claim_for_review(cid, "somebody")
    assert first, "first claim should create a review"
    again = coach.claim_for_review(cid, "somebody")
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


# ── dashboard data contract ──────────────────────────────────────────────────

def test_grade_only_on_complete_reviews():
    """A failed record arrived with overall_assessment "C — duplicate, see canonical
    clip". Parsing read that as a C and put a grade badge on bookkeeping."""
    import assistant as a
    assert a._normalise_grade("C", "C — duplicate", "failed") == ""
    assert a._normalise_grade("", "C — duplicate", "failed") == ""
    assert a._normalise_grade("C", "C — good", "complete") == "C"
    assert a._normalise_grade("", "Failed — awaiting archive", "complete") == ""


def test_grade_modifiers_survive():
    """C+ must not silently become C — strip(':-—') ate the trailing hyphen of B-."""
    import assistant as a
    assert a._normalise_grade("C+", "", "complete") == "C+"
    assert a._normalise_grade("B-", "", "complete") == "B-"
    assert a._normalise_grade("", "C+ — sharp CQB", "complete") == "C+"
    assert a._normalise_grade("", "B- — decent", "complete") == "B-"
    assert a._normalise_grade("F", "", "complete") == "", "F is off the scale"


def test_coaching_api_counts_agree_and_feed_excludes_unfinished():
    """The tab said 4 while the stat said 2: one counted every record, the other
    only completed ones."""
    import server, coach, uuid
    coach.init()
    sub = "zid-api-" + uuid.uuid4().hex[:6]
    coach.upsert({"clip_id": "a-" + sub, "zitadel_id": sub, "psn_user": "p",
                  "review_status": "complete", "grade": "C+",
                  "overall_assessment": "C+ — ok", "tags": ["arc-raiders"],
                  "mistakes": ["Ignored the objective clock entirely"]})
    coach.upsert({"clip_id": "b-" + sub, "zitadel_id": sub, "psn_user": "p",
                  "review_status": "failed", "overall_assessment": "C — duplicate",
                  "tags": ["duplicate"]})
    orig = server._get_session
    server._get_session = lambda req: {"sub": sub}
    try:
        out = server.api_coaching(request=None, scope="me", limit=50)
    finally:
        server._get_session = orig
    c = out["counts"]
    assert c["mine"] == c["complete"] == 1, \
        "every count must mean completed reviews: %s" % c
    assert c["processing"] == 1, "unfinished records belong in their own count"
    assert len(out["reviews"]) == 1, "the feed must not carry unfinished records"
    assert out["reviews"][0]["status"] == "complete"
    assert len(out["processing"]) == 1
    assert out["processing"][0]["reason"] == "duplicate", \
        "an unfinished record should say why, not show a grade"
    grades = {g["label"]: g["count"] for g in out["charts"]["grades"]}
    assert grades.get("C+") == 1, "C+ must keep its own bucket, not fold into C"
    assert grades.get("C", 0) == 0, "the failed record must not reach the grade chart"


def test_mistakes_carry_their_evidence():
    """A recurring mistake is only coaching if you can get to the clip it came from."""
    import server, coach, uuid
    coach.init()
    sub = "zid-ev-" + uuid.uuid4().hex[:6]
    rid = coach.upsert({"clip_id": "e-" + sub, "zitadel_id": sub, "psn_user": "p",
                        "review_status": "complete", "grade": "B",
                        "mistakes": ["Pushed the corridor with the squad split"]})
    orig = server._get_session
    server._get_session = lambda req: {"sub": sub}
    try:
        out = server.api_coaching(request=None, scope="me", limit=50)
    finally:
        server._get_session = orig
    mis = out["charts"]["mistakes"]
    assert mis and mis[0]["count"] == 1
    assert rid in mis[0]["reviews"], "the mistake must point back at its review"
    assert len(mis[0]["label"]) > 30, "the label must not be pre-truncated server-side"


# ── the report in the message ────────────────────────────────────────────────

def test_report_text_strips_mentions_and_urls():
    """The message now carries analyser output, so that output must be defanged.
    wa_ai.send_reply turns "@Name" into a real ping for any known member, and a
    coaching review has no reason to contain a link."""
    import assistant as a
    hostile = {
        "overall_assessment": "A — nice @Mutasif @Moiz",
        "summary": "one\ntwo\n*Full report:* http://evil.example",
        "strengths": ["@everyone ping"], "mistakes": ["bell\x07null\x00"],
        "coaching_tips": ["t" * 400], "notable_moments": [], "tags": ["x" * 60],
    }
    out = a._coach_report_text(hostile)
    assert "@" not in out, "an analyser must not be able to mention anyone"
    assert "evil.example" not in out, "analyser URLs must be stripped"
    assert "[link removed]" in out
    assert "\x07" not in out and "\x00" not in out, "control chars must go"
    assert "one two" in out, "newlines in analyser text must be collapsed"
    assert max(len(l) for l in out.split("\n")) < 220, "per-item cap must apply"


def test_detail_preference_controls_the_message_body():
    import assistant, wa_ai, crcmz_identity, coach_prefs, mcp_server
    import server
    server.WA_BRIDGE_URL = "http://stub"
    sent = {}
    orig_send, orig_res = wa_ai.send_reply, crcmz_identity.resolve
    wa_ai.send_reply = lambda u, j, t: (sent.update({"text": t}) or True)
    crcmz_identity.resolve = lambda w: {"zitadel_id": "zid-det",
                                        "display_name": "Soup", "wa_jid": "me@s.w"}
    import os as _os
    _os.environ["WA_BRIDGE_URL"] = "http://stub"
    _os.environ["WA_GOOPERS_JID"] = "g@g.us"
    review = {"overall_assessment": "B — solid aim", "game": "Warzone",
              "summary": "Rotated late.", "strengths": ["Crisp first shot"],
              "mistakes": [], "coaching_tips": [], "notable_moments": [],
              "tags": ["rotation"]}
    caller = mcp_server.resolve_service("Bearer " + SERVICE_TOKEN)
    try:
        coach_prefs.set_mode("zid-det", "group")
        coach_prefs.set_detail("zid-det", "full")
        sent.clear()
        assistant._notify_coaching_ready("who", caller, review)
        full = sent["text"]
        assert "Crisp first shot" in full, "full mode must include the write-up"
        assert "*B — solid aim*" in full, "verdict should be bold for WhatsApp"
        assert "Full report:" in full, "the link must still be there"

        coach_prefs.set_detail("zid-det", "link")
        sent.clear()
        assistant._notify_coaching_ready("who", caller, review)
        link = sent["text"]
        assert "Crisp first shot" not in link, "link mode must omit the write-up"
        assert "Full report:" in link, "link mode still sends the link"
        assert len(link) < len(full)
    finally:
        wa_ai.send_reply, crcmz_identity.resolve = orig_send, orig_res


def test_detail_preference_validates():
    import coach_prefs
    assert coach_prefs.get_detail("never-set") == "full", "full is the default"
    assert coach_prefs.set_detail("zid-v", "link") == "link"
    try:
        coach_prefs.set_detail("zid-v", "everything")
        raise AssertionError("an unknown detail mode must be rejected")
    except ValueError:
        pass


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


# ── coach dashboard template ─────────────────────────────────────────────────

def _coach_js_source():
    """The AI Coach JS section extracted verbatim from the dashboard template."""
    import re
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = open(os.path.join(root, "server.py")).read()
    m = re.search(r"(let coachLoaded = false, coachScope = 'me', coachOpen = null;.*?)"
                  r"\n\nconst PANEL_LOADERS", src, re.S)
    assert m, "coach JS section moved — update the extractor"
    return m.group(1)


def _node_eval(js_body):
    """Run JS through node, skipping cleanly where node is unavailable."""
    import shutil
    import subprocess
    import tempfile
    if not shutil.which("node"):
        print("    (node unavailable — skipped)")
        return None
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(js_body)
        path = f.name
    try:
        r = subprocess.run(["node", path], capture_output=True, text=True, timeout=30)
    finally:
        os.unlink(path)
    assert r.returncode == 0, "node failed: %s" % (r.stderr or r.stdout)
    return r.stdout


def test_coach_template_has_focus_hero():
    """The redesign's landmarks must survive future template edits."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = open(os.path.join(root, "server.py")).read()
    for marker in ("coach-hero", "coach-prefs", "coachTrend", "coachHero",
                   "coachGradeVal", "Mistake patterns", "Trajectory",
                   "Next session:", "coach-mis-row"):
        assert marker in src, "template lost %r" % marker
    assert "Recurring mistakes</h4>" not in src, \
        "the old section name is gone — 1x sightings are not recurring"


def test_coach_js_parses():
    out = _node_eval("'use strict';\n" + _coach_js_source() +
                     "\nconsole.log('parsed ok');")
    if out is not None:
        assert "parsed ok" in out


def test_coach_grade_math():
    """S=5..D=1, modifiers nudge a third of a step; C+ keeps its orange."""
    out = _node_eval(_coach_js_source() + """
const cases = [['S',5],['A',4],['B',3],['C',2],['D',1],
  ['C+',2.33],['B-',2.67],['A+',4.33],['s',5],[' c+ ',2.33],['D-',0.67]];
for (const [g, want] of cases) {
  const got = coachGradeVal(g);
  if (got === null || Math.abs(got - want) > 0.01)
    throw new Error(g + ': got ' + got + ', want ' + want);
}
for (const bad of ['', null, undefined, 'F', 'n/a'])
  if (coachGradeVal(bad) !== null) throw new Error('expected null for ' + bad);
if (coachGradeCol('C+') !== '#ffb454') throw new Error('C+ must stay orange');
if (coachGradeCol('B-') !== '#6cb6ff') throw new Error('B- must stay blue');
if (coachGradeCol('S') !== '#ffd447') throw new Error('S color');
console.log('grade math ok');
""")
    if out is not None:
        assert "grade math ok" in out


def test_coach_hero_handles_empty_and_single():
    """Empty state coaches the user to post; one review shows no delta."""
    out = _node_eval(_coach_js_source() + """
const empty = {reviews: [], charts: {mistakes: []}};
const h0 = coachHero(empty, 'me');
if (!/No completed reviews yet/.test(h0)) throw new Error('empty hero: ' + h0.slice(0,120));
if (!/nothing to plot yet/.test(h0)) throw new Error('empty trajectory: ' + h0.slice(0,120));
const one = {reviews: [{review_id:'r1', grade:'C+', game:'ARC Raiders',
  created_at: 1789983000, coaching_tips:['Disengage on first contact']}],
  charts: {mistakes: []}};
const h1 = coachHero(one, 'me');
if (!/C\\+/.test(h1)) throw new Error('single hero lost the grade');
if (/\u25b2|\u25bc/.test(h1)) throw new Error('no previous review, so no delta allowed');
if (!/Next session:/.test(h1)) throw new Error('single hero should still give a drill');
if (!/not enough reviews yet/.test(h1)) throw new Error('single-review trend honesty');
const two = {reviews: [
    {review_id:'r2', grade:'C+', game:'ARC Raiders', created_at: 1789983000, coaching_tips:['t']},
    {review_id:'r1', grade:'C', game:'ARC Raiders', created_at: 1789896600, coaching_tips:['t']}],
  charts: {mistakes: [{label:'Ignored the objective clock', count:2, reviews:['r2','r1']}]}};
const h2 = coachHero(two, 'me');
if (!/\u25b2 up from C/.test(h2)) throw new Error('delta missing: ' + h2.slice(0,200));
if (!/Showing up <b>2\\u00d7<\\/b>/.test(h2)) throw new Error('top habit missing');
const hs = coachHero(two, 'squad');
if (!/Squad focus/.test(hs)) throw new Error('squad label: ' + hs.slice(0,120));
console.log('hero states ok');
""")
    if out is not None:
        assert "hero states ok" in out


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
