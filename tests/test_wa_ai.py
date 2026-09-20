#!/usr/bin/env python3
"""The "ai ..." bot in the WhatsApp group.

Plain asserts, no pytest — run inside the app image where the deps live:

    docker build -t crcmz-app:test .
    docker run --rm -e SESSION_SECRET=test-secret -e WA_INGEST_SECRET=test-ingest \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_wa_ai.py
"""

import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-wa-ai")
os.environ.setdefault("WA_INGEST_SECRET", "test-ingest")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ.setdefault("WA_GOOPERS_JID", "120363406504549565@g.us")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAILED: list[str] = []
PASSED = 0
BRIDGE_SENT: list[dict] = []
MODEL_SEEN: list[dict] = []
REPLY = {"content": "Mutasif, 2,943 — types more than he plays."}
SCRIPT: list[dict] = []      # queued assistant messages, popped per model call
GROUP = "120363406504549565@g.us"


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


class _Stub(BaseHTTPRequestHandler):
    """Plays both the Baileys bridge (/send) and the model (/v1/...)."""

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        if self.path.endswith("/send"):
            BRIDGE_SENT.append(body)
            out = {"status": "sent"}
        else:
            MODEL_SEEN.append(body)
            msg = SCRIPT.pop(0) if SCRIPT else {"role": "assistant",
                                                "content": REPLY["content"]}
            out = {"choices": [{"message": msg}]}
        payload = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), _Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"
os.environ["OLLAMA_BASE_URL"] = BASE + "/v1"
os.environ["WA_BRIDGE_URL"] = BASE

import wa_ai  # noqa: E402


def a_tool_call(name):
    return {"role": "assistant", "content": "",
            "tool_calls": [{"id": "c1", "type": "function",
                            "function": {"name": name, "arguments": "{}"}}]}


def wa_msg(text, **over):
    msg = {"message_id": "M1", "sender_name": "killerx096", "sender_jid": "1@s.whatsapp.net",
           "group_jid": GROUP, "timestamp": int(time.time()), "text": text, "type": "text"}
    msg.update(over)
    return msg


# ── @mentions: how people actually talk to a bot on WhatsApp ─────────────────
def t_a_mention_followed_by_ai_triggers():
    # The real message that got no reply: the mention comes first, so "ai" is
    # no longer at the start of the body.
    assert wa_ai.trigger_from(wa_msg("@56767304183939 ai yo")) == "yo"
    assert wa_ai.trigger_from(wa_msg("@56767304183939  ai who yaps the most")) == \
        "who yaps the most"


def t_a_mention_of_us_is_enough_on_its_own():
    wa_ai._self_ids.add("56767304183939")
    try:
        assert wa_ai.trigger_from(wa_msg("@56767304183939 yo")) == "yo"
        assert wa_ai.trigger_from(wa_msg("@56767304183939 who yaps the most?")) == \
            "who yaps the most?"
    finally:
        wa_ai._self_ids.discard("56767304183939")


def t_mentioning_somebody_else_is_not_a_trigger():
    wa_ai._self_ids.add("56767304183939")
    try:
        assert wa_ai.trigger_from(wa_msg("@19998887777 yo bro")) is None
        # ...unless they also say "ai", which is unambiguous either way.
        assert wa_ai.trigger_from(wa_msg("@19998887777 ai yo")) == "yo"
    finally:
        wa_ai._self_ids.discard("56767304183939")


def t_a_bare_mention_with_nothing_after_it_is_ignored():
    wa_ai._self_ids.add("56767304183939")
    try:
        assert wa_ai.trigger_from(wa_msg("@56767304183939")) is None
        assert wa_ai.trigger_from(wa_msg("@56767304183939   ")) is None
    finally:
        wa_ai._self_ids.discard("56767304183939")


def t_our_id_is_learned_from_our_own_messages():
    wa_ai._self_ids.clear()
    assert wa_ai.trigger_from(wa_msg("anything", from_me=True,
                                     sender_jid="56767304183939:2@lid")) is None
    assert "56767304183939" in wa_ai.self_ids(), wa_ai.self_ids()
    # ...and from then on a bare mention works.
    assert wa_ai.trigger_from(wa_msg("@56767304183939 sup")) == "sup"
    wa_ai._self_ids.clear()


# ── quoted-reply (replying to a bot message) ─────────────────────────────────
def t_reply_to_bot_message_triggers_without_ai_prefix():
    # Swipe-reply to a bot message: bridge sends reply_to = the bot's message ID.
    # The bot's own messages come back through ingest with from_me=True, so
    # learn_self() records the ID in _recent_sent_ids.
    wa_ai._recent_sent_ids.clear()
    bot_echo = wa_msg("Mutasif yaps the most.", from_me=True,
                      sender_jid="56767304183939:2@lid", message_id="BOT-MSG-1")
    assert wa_ai.trigger_from(bot_echo) is None   # own message, not a trigger
    assert "BOT-MSG-1" in wa_ai._recent_sent_ids, wa_ai._recent_sent_ids

    # Now someone swipe-replies to that message.
    reply = wa_msg("lol ok but who is second?")
    reply["reply_to"] = "BOT-MSG-1"
    assert wa_ai.trigger_from(reply) == "lol ok but who is second?"

    # quotedMessageId is an alias some bridge versions send.
    reply2 = wa_msg("and who is third?")
    reply2["quotedMessageId"] = "BOT-MSG-1"
    assert wa_ai.trigger_from(reply2) == "and who is third?"
    wa_ai._recent_sent_ids.clear()


def t_reply_to_someone_else_does_not_trigger():
    wa_ai._recent_sent_ids.clear()
    msg = wa_msg("lol ok")
    msg["reply_to"] = "OTHER-MSG-999"
    assert wa_ai.trigger_from(msg) is None


# ── trigger ───────────────────────────────────────────────────────────────────
def t_picks_up_the_ai_prefix():
    assert wa_ai.trigger_from(wa_msg("ai who yaps the most")) == "who yaps the most"
    assert wa_ai.trigger_from(wa_msg("AI: settle this")) == "settle this"
    assert wa_ai.trigger_from(wa_msg("@ai wyd")) == "wyd"


def t_ignores_normal_chatter():
    for text in ("hello", "aim better", "ai", "", "what about ai"):
        assert wa_ai.trigger_from(wa_msg(text)) is None, text


def t_ignores_our_own_messages():
    # Our reply is echoed back through ingest; answering it would loop forever.
    assert wa_ai.trigger_from(wa_msg("ai this is my own text", from_me=True)) is None
    assert wa_ai.trigger_from(wa_msg("ai also mine", fromMe=True)) is None


def t_ignores_reactions_and_other_groups():
    assert wa_ai.trigger_from({"type": "reaction", "text": "ai hi"}) is None
    assert wa_ai.trigger_from(wa_msg("ai hi", group_jid="other@g.us"), GROUP) is None
    assert wa_ai.trigger_from(wa_msg("ai hi"), GROUP) == "hi"


def t_sender_name_falls_back_to_the_number():
    assert wa_ai.sender_name(wa_msg("x")) == "killerx096"
    assert wa_ai.sender_name(wa_msg("x", sender_name="")) == "1"
    assert wa_ai.sender_name({"text": "x"}) == "someone"


# ── sending ───────────────────────────────────────────────────────────────────
def t_reply_goes_to_the_bridge():
    BRIDGE_SENT.clear()
    assert wa_ai.send_reply(BASE, GROUP, "here you go") is True
    assert BRIDGE_SENT[-1] == {"message": "here you go", "groupJid": GROUP}, BRIDGE_SENT


def t_long_replies_are_trimmed():
    BRIDGE_SENT.clear()
    wa_ai.send_reply(BASE, GROUP, "z" * 3000)
    sent = BRIDGE_SENT[-1]["message"]
    assert len(sent) == wa_ai.MAX_REPLY_CHARS and sent.endswith("…"), len(sent)


def t_our_own_reply_is_never_a_trigger():
    BRIDGE_SENT.clear()
    wa_ai.send_reply(BASE, GROUP, "ai this looks like a trigger")
    # Even without from_me, the text we just sent must not start a new answer.
    assert wa_ai.trigger_from(wa_msg("ai this looks like a trigger")) is None


def t_empty_or_unconfigured_sends_nothing():
    BRIDGE_SENT.clear()
    assert wa_ai.send_reply(BASE, GROUP, "   ") is False
    assert wa_ai.send_reply("", GROUP, "hi") is False
    assert wa_ai.send_reply(BASE, "", "hi") is False
    assert BRIDGE_SENT == []


def t_a_dead_bridge_is_survivable():
    assert wa_ai.send_reply("http://127.0.0.1:9", GROUP, "hi") is False


# ── end to end through the ingest endpoint ────────────────────────────────────
def http_tests():
    from fastapi.testclient import TestClient
    import server

    tmp = Path(tempfile.mkdtemp(prefix="wa-ai-"))
    server._wa._DB_PATH = tmp / "wa.db"
    server._wa.init()
    server._chat._DB_PATH = tmp / "chat.db"
    server._chat.init()
    server.WA_BRIDGE_URL = BASE
    server.WA_GOOPERS_JID = GROUP

    client = TestClient(server.app, base_url="https://app.crcmz.me")
    HDR = {"Content-Type": "application/json", "x-ingest-secret": server.WA_INGEST_SECRET}

    def wait(pred, timeout=10.0):
        end = time.time() + timeout
        while time.time() < end:
            if pred():
                return True
            time.sleep(0.05)
        return False

    def t_an_ai_message_gets_answered_in_the_group():
        BRIDGE_SENT.clear(); MODEL_SEEN.clear(); SCRIPT.clear()
        # "who yaps the most" is a data question, so the loop insists on a tool.
        SCRIPT.extend([a_tool_call("whatsapp_members"),
                       {"role": "assistant", "content": REPLY["content"]}])
        r = client.post("/api/whatsapp/ingest",
                        json=[wa_msg("ai who yaps the most", message_id="E1")],
                        headers=HDR)
        assert r.status_code == 200, r.text
        assert r.json()["inserted"] == 1, r.json()
        assert wait(lambda: BRIDGE_SENT), "no reply reached the bridge"
        assert BRIDGE_SENT[-1]["groupJid"] == GROUP, BRIDGE_SENT[-1]
        assert "2,943" in BRIDGE_SENT[-1]["message"], BRIDGE_SENT[-1]
        # The question carries the asker's name into the prompt.
        assert any("killerx096 asks" in json.dumps(m) for m in MODEL_SEEN), MODEL_SEEN[-1]

    def t_ingest_is_not_blocked_by_the_model():
        BRIDGE_SENT.clear()
        t0 = time.time()
        client.post("/api/whatsapp/ingest",
                    json=[wa_msg("ai something", message_id="E2")], headers=HDR)
        assert time.time() - t0 < 1.0, "ingest waited for the model"
        # Let this one's answer land, so it cannot leak into the next test.
        assert wait(lambda: BRIDGE_SENT)

    def t_normal_messages_do_not_trigger_it():
        BRIDGE_SENT.clear()
        client.post("/api/whatsapp/ingest",
                    json=[wa_msg("just chatting", message_id="E3")], headers=HDR)
        time.sleep(0.6)
        assert BRIDGE_SENT == [], BRIDGE_SENT

    def t_the_group_thread_remembers():
        BRIDGE_SENT.clear(); MODEL_SEEN.clear()
        client.post("/api/whatsapp/ingest",
                    json=[wa_msg("ai say something funny", message_id="E4")], headers=HDR)
        assert wait(lambda: BRIDGE_SENT)
        BRIDGE_SENT.clear(); MODEL_SEEN.clear()
        client.post("/api/whatsapp/ingest",
                    json=[wa_msg("ai again please", message_id="E5")], headers=HDR)
        assert wait(lambda: BRIDGE_SENT)
        roles = [m["role"] for m in MODEL_SEEN[0]["messages"]]
        assert roles.count("user") >= 2, roles     # earlier turn replayed
        assert any("say something funny" in json.dumps(m) for m in MODEL_SEEN[0]["messages"])

    def t_a_reply_echoed_back_does_not_loop():
        BRIDGE_SENT.clear()
        REPLY["content"] = "ai this reply looks like a trigger"
        try:
            client.post("/api/whatsapp/ingest",
                        json=[wa_msg("ai say something", message_id="E6")], headers=HDR)
            assert wait(lambda: BRIDGE_SENT)
            echoed = BRIDGE_SENT[-1]["message"]
            before = len(BRIDGE_SENT)
            # The bridge echoes our own message straight back into ingest.
            client.post("/api/whatsapp/ingest",
                        json=[wa_msg(echoed, message_id="E7", from_me=True)], headers=HDR)
            time.sleep(0.8)
            assert len(BRIDGE_SENT) == before, f"looped: {BRIDGE_SENT[before:]}"
        finally:
            REPLY["content"] = "Mutasif, 2,943 — types more than he plays."

    def t_disabling_it_stops_the_answers():
        BRIDGE_SENT.clear()
        server.WA_AI_ENABLED = False
        try:
            client.post("/api/whatsapp/ingest",
                        json=[wa_msg("ai are you there", message_id="E8")], headers=HDR)
            time.sleep(0.6)
            assert BRIDGE_SENT == [], BRIDGE_SENT
        finally:
            server.WA_AI_ENABLED = True

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check("http/" + name[2:], fn)



def t_a_long_build_brief_is_not_truncated():
    """trigger_from used to cap every message at 400 chars, inherited from the PSN bot
    where messages are one-liners. A request for a site with a feature list was cut off
    mid-word and the engineer built from the fragment."""
    brief = ("Build me a fun interactive website for my friend group called Spin It. "
             + "Feature: " * 60 + "and a leaderboard that persists between hangouts.")
    msg = {"sender_jid": "1@s.whatsapp.net", "sender_name": "MQ",
           "group_jid": GROUP, "text": "ai " + brief}
    got = wa_ai.trigger_from(msg, GROUP)
    assert got, "no trigger at all"
    assert len(got) > 400, "still capped at the old 400-char limit (%d)" % len(got)
    assert got.endswith("persists between hangouts."), (
        "brief truncated at %d chars — the engineer builds from a fragment" % len(got))


print("WhatsApp \"ai ...\" bot tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("\nIngest endpoint tests")
try:
    http_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"http_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not boot the app: {type(e).__name__}: {e}")

srv.shutdown()
print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
