#!/usr/bin/env python3
"""The "ai ..." bot in The Squad PSN group (successor to the psn-gpt script).

No PSN and no model: a fake messenger and a fake ask() make the whole loop
testable, which the original standalone script could not be.

Plain asserts, no pytest — run inside the app image where the deps live:

    docker build -t psn-messenger:test .
    docker run --rm -v "$PWD/tests:/app/tests" psn-messenger:test \
      python tests/test_psn_ai.py
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAILED: list[str] = []
PASSED = 0


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


import psn_ai  # noqa: E402

psn_ai.SEEN_FILE = Path(tempfile.mkdtemp(prefix="psnai-")) / "seen.json"


class FakeMessenger:
    def __init__(self, messages=None):
        self.messages = messages or []
        self.sent: list[str] = []
        self.reads = 0

    def get_messages(self, limit=10):
        self.reads += 1
        return self.messages[-limit:]

    def send_message(self, text):
        self.sent.append(text)
        # A real group echoes the bot's own message back on the next read.
        self.messages.append({"messageUid": f"bot-{len(self.sent)}",
                              "sender": "crcmz-mod", "body": text})
        return True


def msg(uid, sender, body):
    return {"messageUid": uid, "sender": sender, "body": body}


def fresh(messages):
    """A messenger whose existing messages are already 'seen'."""
    if psn_ai.SEEN_FILE.exists():
        psn_ai.SEEN_FILE.unlink()
    m = FakeMessenger(list(messages))
    psn_ai.poll_once(m, lambda p, a: "should not answer")   # first pass: record only
    return m


ASK = lambda prompt, author: f"answer for {author}: {prompt}"  # noqa: E731


# ── trigger parsing ───────────────────────────────────────────────────────────
def t_recognises_the_ai_prefix():
    assert psn_ai.parse_trigger("ai who yaps the most") == "who yaps the most"
    assert psn_ai.parse_trigger("AI  settle this") == "settle this"
    assert psn_ai.parse_trigger("ai, best loadout?") == "best loadout?"
    assert psn_ai.parse_trigger("ai: whats up") == "whats up"
    assert psn_ai.parse_trigger("@ai wyd") == "wyd"
    assert psn_ai.parse_trigger("  ai   spaced   out  ") == "spaced out"


def t_ignores_everything_else():
    for body in ("hello", "aim better bro", "airplane mode", "ai", "ai ",
                 "what about ai", "", "   ", "said ai to me"):
        assert psn_ai.parse_trigger(body) is None, body


def t_ignores_psn_system_messages():
    assert psn_ai.parse_trigger("Zubi sent a video clip.") is None
    assert psn_ai.parse_trigger("MQ sent a screenshot.") is None


def t_multiline_and_overlong_prompts_are_flattened():
    p = psn_ai.parse_trigger("ai line one\nline two")
    assert p == "line one line two", p
    long = psn_ai.parse_trigger("ai " + "x" * 900)
    assert len(long) == psn_ai.PROMPT_MAX, len(long)


# ── the loop ──────────────────────────────────────────────────────────────────
def t_first_pass_never_answers_the_backlog():
    if psn_ai.SEEN_FILE.exists():
        psn_ai.SEEN_FILE.unlink()
    m = FakeMessenger([msg("1", "MQ", "ai who yaps the most"),
                       msg("2", "Zubi", "ai best gun")])
    out = psn_ai.poll_once(m, ASK)
    assert out == [] and m.sent == [], (out, m.sent)
    # ...but they are remembered, so they never get answered later either.
    assert psn_ai.poll_once(m, ASK) == []


def t_answers_a_new_question():
    m = fresh([msg("1", "MQ", "hey")])
    m.messages.append(msg("2", "Zubi", "ai who yaps the most"))
    out = psn_ai.poll_once(m, ASK)
    assert len(out) == 1, out
    assert out[0]["author"] == "Zubi" and out[0]["prompt"] == "who yaps the most", out
    assert m.sent == ["answer for Zubi: who yaps the most"], m.sent


def t_never_answers_the_same_message_twice():
    m = fresh([])
    m.messages.append(msg("9", "MQ", "ai one time only"))
    assert len(psn_ai.poll_once(m, ASK)) == 1
    assert psn_ai.poll_once(m, ASK) == []
    assert len(m.sent) == 1, m.sent


def t_does_not_answer_its_own_replies():
    # The bot's own message comes back on the next read; it must not loop.
    m = fresh([])
    m.messages.append(msg("5", "MQ", "ai say something"))
    psn_ai.poll_once(m, lambda p, a: "ai this looks like a trigger")
    before = len(m.sent)
    for _ in range(3):
        psn_ai.poll_once(m, ASK)
    assert len(m.sent) == before, f"looped: {m.sent}"


def t_answers_oldest_first():
    m = fresh([])
    m.messages += [msg("a1", "MQ", "ai first"), msg("a2", "Zubi", "ai second")]
    out = psn_ai.poll_once(m, ASK)
    assert [o["prompt"] for o in out] == ["first", "second"], out


def t_caps_replies_per_tick_and_picks_the_rest_up_later():
    m = fresh([])
    m.messages += [msg(f"b{i}", "MQ", f"ai question {i}") for i in range(5)]
    first = psn_ai.poll_once(m, ASK)
    assert len(first) == psn_ai.MAX_REPLIES_PER_TICK, first
    second = psn_ai.poll_once(m, ASK)
    assert len(second) == psn_ai.MAX_REPLIES_PER_TICK, second
    assert [o["prompt"] for o in second] == ["question 2", "question 3"], second


def t_long_answers_are_trimmed():
    m = fresh([])
    m.messages.append(msg("c1", "MQ", "ai ramble"))
    psn_ai.poll_once(m, lambda p, a: "y" * 2000)
    assert len(m.sent[0]) == psn_ai.MAX_REPLY_CHARS, len(m.sent[0])
    assert m.sent[0].endswith("…"), m.sent[0][-20:]


def t_a_failing_model_still_says_something():
    m = fresh([])
    m.messages.append(msg("d1", "MQ", "ai break yourself"))
    def boom(prompt, author):
        raise RuntimeError("model down")
    out = psn_ai.poll_once(m, boom)
    assert len(out) == 1 and m.sent, (out, m.sent)
    assert "crashed" in m.sent[0], m.sent[0]


def t_an_empty_answer_is_not_sent():
    m = fresh([])
    m.messages.append(msg("e1", "MQ", "ai nothing"))
    assert psn_ai.poll_once(m, lambda p, a: "   ") == []
    assert m.sent == []


def t_a_dead_group_read_is_survivable():
    class Broken(FakeMessenger):
        def get_messages(self, limit=10):
            raise RuntimeError("PSN 401")
    assert psn_ai.poll_once(Broken(), ASK) == []
    assert psn_ai.poll_once(None, ASK) == []


def t_a_failed_send_is_not_recorded_as_answered():
    m = fresh([])
    m.messages.append(msg("f1", "MQ", "ai send will fail"))
    class NoSend(FakeMessenger):
        def send_message(self, text):
            raise RuntimeError("PSN rejected it")
    broken = NoSend(list(m.messages))
    out = psn_ai.poll_once(broken, ASK)
    assert out == [], out


def t_reads_the_original_uid_only_state_file():
    # The standalone bot stored a bare list of uids; upgrading must not make it
    # re-answer everything it had already replied to.
    import json
    psn_ai.SEEN_FILE.write_text(json.dumps(["old-1", "old-2"]))
    m = FakeMessenger([msg("old-1", "MQ", "ai already answered this")])
    assert psn_ai.poll_once(m, ASK) == [], "re-answered a message from the old format"
    assert m.sent == []
    psn_ai.SEEN_FILE.unlink(missing_ok=True)


def t_seen_list_is_bounded():
    if psn_ai.SEEN_FILE.exists():
        psn_ai.SEEN_FILE.unlink()
    saved = psn_ai.SEEN_KEEP
    psn_ai.SEEN_KEEP = 5
    try:
        m = FakeMessenger([msg(str(i), "MQ", "hi") for i in range(20)])
        psn_ai.poll_once(m, ASK)
        import json
        state = json.loads(psn_ai.SEEN_FILE.read_text())
        assert len(state["uids"]) == 5, state
    finally:
        psn_ai.SEEN_KEEP = saved
        psn_ai.SEEN_FILE.unlink(missing_ok=True)


print("PSN group \"ai ...\" bot tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
