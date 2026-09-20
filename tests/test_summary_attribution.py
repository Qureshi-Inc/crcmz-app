#!/usr/bin/env python3
"""The catch-up summary must not put the bot's words in a member's mouth.

A real misattribution: the summary said Mutasif and MQ were telling Samad what to
build, when they were telling the bot. Three causes, all here:

  1. `_messages_since_sender` filtered `from_me = 0`, dropping all 150 of the bot's
     messages. With a participant missing, "can you search the web" reads as aimed
     at whichever human is nearest in the window.
  2. The bot's own rows carry the group JID as `sender_name`, so even included it
     would show as a bare number.
  3. `@56767304183939` was left as digits — the one clear signal that a message was
     addressed to the bot, invisible to the model.

Plus names drifted: the same person appeared as "MQ", "AbdulSamad Baw", "Mutasif"
depending on what they'd set their WhatsApp display name to, so the identity graph
now supplies one canonical label.

Runs on the host: the two formatting functions are lifted out of server.py, which
needs fastapi.

    python3 tests/test_summary_attribution.py
"""

import datetime
import logging
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAILED: list[str] = []
PASSED = 0


def check(name, fn):
    global PASSED
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        FAILED.append("%s: %s" % (name, e))
        print("  ✗ %s\n      %s" % (name, e))
    else:
        PASSED += 1
        print("  ✓ %s" % name)


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = open(os.path.join(ROOT, "server.py")).read()


class _FakeWaAi:
    """Stands in for wa_ai: one known member, one known bot id."""
    @staticmethod
    def resolve_inbound_mentions(text):
        return text.replace("@212777109086321", "@Samad")

    @staticmethod
    def self_ids():
        return {"56767304183939"}


class _FakeIdentity:
    """The identity graph: display names people actually post under -> one label."""
    NAMES = {
        "mq": {"display_name": "Interesting Soup"},
        "abdulsamad baw": {"display_name": "asamad89 asamad89"},   # doubled on purpose
        "mutasif": {"display_name": "themoosecompany"},
    }

    @staticmethod
    def identify_sender_name(name):
        return _FakeIdentity.NAMES.get((name or "").strip().casefold())

    @staticmethod
    def bot_person():
        return {"display_name": "CRCMZ Bot"}


_NS = {"_re": re, "logger": logging.getLogger("t"), "wa_ai": _FakeWaAi,
       "datetime": datetime, "_dt": datetime}
sys.modules["crcmz_identity"] = _FakeIdentity  # the in-function import picks this up
exec(_SRC[_SRC.index("def _bot_label()"):_SRC.index("def _messages_since_sender(")], _NS)
exec(_SRC[_SRC.index("def _summary_speaker("):
          _SRC.index("def _tts_and_send(")], _NS)

_fmt = _NS["_format_messages_for_summary"]
_speaker = _NS["_summary_speaker"]

TS = 1758000000


def row(name, text, from_me=0):
    return {"sender_name": name, "timestamp": TS, "text": text, "from_me": from_me,
            "has_photo": 0, "has_video": 0, "has_audio": 0}


def bot_rows_are_labelled_as_the_bot():
    out = _fmt([row("120363406504549565", "creator mode enabled.", from_me=1)])
    assert "CRCMZ Bot" in out, out
    assert "not a person" in out, "nothing tells the model this is not a member: %s" % out
    assert "120363406504549565" not in out, "group JID leaked as a speaker name: %s" % out


def a_message_to_the_bot_shows_who_it_was_for():
    out = _fmt([row("MQ", "@56767304183939 can you search the web for this")])
    assert "@CRCMZ Bot" in out, ("the bot's id was left as digits, so the model cannot "
                                "tell who was being addressed: %s" % out)
    assert "56767304183939" not in out, out


def member_mentions_still_resolve_to_names():
    out = _fmt([row("MQ", "@212777109086321 wya?")])
    assert "@Samad" in out and "212777109086321" not in out, out


def display_names_are_canonicalised():
    assert _speaker(row("MQ", "x"), {}) == "Interesting Soup"
    assert _speaker(row("Mutasif", "x"), {}) == "themoosecompany"


def doubled_zitadel_names_are_collapsed():
    # "asamad89 asamad89" reads badly in a sentence; one word is enough.
    assert _speaker(row("AbdulSamad Baw", "x"), {}) == "asamad89"


def an_unmapped_name_is_kept_verbatim():
    assert _speaker(row("SomeNewGuy", "x"), {}) == "SomeNewGuy"


def identity_is_looked_up_once_per_name():
    calls = []
    orig = _FakeIdentity.identify_sender_name

    def counting(name):
        calls.append(name)
        return orig(name)

    _FakeIdentity.identify_sender_name = staticmethod(counting)
    try:
        _fmt([row("MQ", "a"), row("MQ", "b"), row("MQ", "c")])
    finally:
        _FakeIdentity.identify_sender_name = staticmethod(orig)
    assert len(calls) == 1, ("identity resolved %d times for one name — a long window "
                            "would hammer Zitadel" % len(calls))


def the_bot_is_not_filtered_out_of_the_query():
    src = _SRC[_SRC.index("def _messages_since_sender("):_SRC.index("def _bot_label(")
               if _SRC.index("def _bot_label(") > _SRC.index("def _messages_since_sender(")
               else len(_SRC)]
    window = _SRC[_SRC.index("SELECT sender_name, timestamp, text"):]
    window = window[:window.index("ORDER BY timestamp ASC")]
    assert "from_me = 0" not in window, (
        "the summary window excludes the bot's own messages again — that is exactly "
        "what made it attribute a request to the bot to another member")


print("summary attribution")
check("bot rows are labelled as the bot", bot_rows_are_labelled_as_the_bot)
check("a message to the bot shows who it was for", a_message_to_the_bot_shows_who_it_was_for)
check("member mentions still resolve to names", member_mentions_still_resolve_to_names)
check("display names are canonicalised", display_names_are_canonicalised)
check("doubled zitadel names are collapsed", doubled_zitadel_names_are_collapsed)
check("an unmapped name is kept verbatim", an_unmapped_name_is_kept_verbatim)
check("identity is looked up once per name", identity_is_looked_up_once_per_name)
check("the bot is not filtered out of the window", the_bot_is_not_filtered_out_of_the_query)

print("\n%d passed, %d failed" % (PASSED, len(FAILED)))
for f in FAILED:
    print("  - %s" % f)
sys.exit(1 if FAILED else 0)
