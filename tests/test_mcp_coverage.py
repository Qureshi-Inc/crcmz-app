#!/usr/bin/env python3
"""Enforces the convention: every data store is reachable through a tool.

This is the test that makes `.claude/skills/crcmz-mcp-tool/SKILL.md` stick. The
documented rule is "new data store -> new assistant tool -> automatically exposed
over MCP", and a rule with no check is a rule that lapses -- the app already grew
store-first once, which is why the identity graph had to be retrofitted onto
`whatsapp_messages` after the fact.

So: scrape every `/data/...` path literal out of the source, and require each one
to appear in STORES below with the tool that exposes it. Adding a store without
touching this file fails the test with the skill's name in the message.

`None` is a legitimate answer -- some paths are not user-visible data (a token
cache, a video work queue). It just has to be a *decision*, written down with the
reason, rather than an omission nobody noticed.

Plain asserts, no pytest. This one needs no app deps, so it runs on the host:

    python3 tests/test_mcp_coverage.py
"""

import os
import re
import sys
from pathlib import Path

REPO = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, str(REPO))

FAILED: list[str] = []
PASSED = 0

SKILL = ".claude/skills/crcmz-mcp-tool/SKILL.md"

# store path -> the assistant tool(s) that expose it, or None with a reason.
STORES: dict[str, list[str] | None] = {
    "/data/whatsapp.db": ["whatsapp_stats", "whatsapp_search", "whatsapp_members",
                          "whatsapp_activity", "whatsapp_words", "whatsapp_emojis",
                          "whatsapp_awards", "whatsapp_response_times",
                          "person_profile"],
    "/data/clips.db": ["recent_clips", "person_profile"],
    "/data/giveaway.db": ["giveaway_status"],
    "/data/assistant_facts.db": ["squad_facts", "person_profile"],
    "/data/soundboard.json": ["soundboard_buttons"],
    "/data/soundboard_personal.json": ["soundboard_buttons", "person_profile"],
    "/data/users": ["squad_members", "squad_roster", "person_profile"],
    "/data/game_history.db": ["games_played", "game_sessions", "person_profile",
                              "platform_overview"],

    "/data/memory.db": ["memory_search", "memory_get", "memory_context",
                        "memory_status"],

    "/data/coach_reviews.db": ["coach_reviews"],
    "/data/ig_posts.db":     ["ig_clips_recent"],
    "/data/app_events.db":    ["app_events_list"],
    "/data/watchparty_events.db": ["watchparty_events_list"],

    "/data/mm_tokens.db": None,         # Mattermost OAuth access/refresh tokens.
                                       # Same rule as mcp_user_tokens — tokens
                                       # must never be readable through a tool.

    "/data/mcp_user_tokens.db": None,   # OAuth token state for per-user MCP access.
                                       # Internal auth DB — no tool should ever
                                       # read tokens, codes, or audit rows.

    # Deliberately not exposed:
    "/data/assistant_chat.db": None,   # the bot's own transcripts. person_profile
                                       # reports a count; the text is nobody
                                       # else's business.
    "/data/psn_tokens.json": None,     # live PSN access/refresh tokens. Must never
                                       # be readable through a tool.
    "/data/psn_ai_seen.json": None,    # dedupe cursor, not content.
    "/data/mcp_calls.db": None,        # the MCP call log itself. Operational
                                       # telemetry, not squad data, and exposing
                                       # "who called what when" over the same
                                       # endpoint it records would let a caller
                                       # watch the other callers. Read it locally.
    "/data/coach_prefs.json": None,    # one member's own notification choice for AI
                                       # Coach (group/dm/off). A UI setting, not squad
                                       # data, and surfacing whether somebody wants
                                       # DMs to everyone holding the shared read token
                                       # is not warranted. The reviews themselves are
                                       # exposed via coach_reviews and
                                       # coach_player_profile.
    "/data/video_jobs.db": None,       # internal clip-forwarding work queue.
    "/data/clips": None,               # the media files themselves; clips.db is
                                       # the queryable index.
    "/data/watch": None,               # WatchParty room state, owned by the other
                                       # repo (see the watch-party notes).
}

_PATH_RE = re.compile(r"""["'](/data/[A-Za-z0-9_./-]+)["']""")


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


def discovered_stores() -> dict[str, set[str]]:
    """Every /data path literal in the top-level source, mapped to its files."""
    found: dict[str, set[str]] = {}
    for py in sorted(REPO.glob("*.py")):
        for path in _PATH_RE.findall(py.read_text()):
            found.setdefault(path, set()).add(py.name)
    return found


def main():
    import assistant

    print("mcp coverage")
    found = discovered_stores()
    registered = set(assistant.tool_names())

    def every_store_is_accounted_for():
        unknown = {p: sorted(f) for p, f in found.items() if p not in STORES}
        assert not unknown, (
            f"new data store(s) with no entry in STORES: {unknown}. Read {SKILL}: "
            "add an @tool() in assistant.py so the bot and MCP can see it, then "
            "list it here. If it genuinely should not be exposed, map it to None "
            "with the reason."
        )
    check("every /data store is declared", every_store_is_accounted_for)

    def named_tools_exist():
        for path, tools in STORES.items():
            for t in tools or []:
                assert t in registered, (
                    f"{path} claims tool {t!r}, which is not registered in "
                    f"assistant.py -- it was renamed or removed, so that store is "
                    f"now invisible. Registered: {sorted(registered)}"
                )
    check("every claimed tool is actually registered", named_tools_exist)

    def stale_entries_removed():
        # A store listed here but gone from the source means this file is drifting
        # and its guarantees are worth less than they look.
        gone = [p for p in STORES if p not in found]
        assert not gone, f"STORES lists paths no longer in the source: {gone}"
    check("no stale store entries", stale_entries_removed)

    def secrets_are_not_exposed():
        # The two stores holding live credentials must never gain a tool, however
        # convenient it seems at the time.
        for path in ("/data/psn_tokens.json",):
            assert STORES[path] is None, f"{path} must not be exposed through a tool"
    check("credential stores stay unexposed", secrets_are_not_exposed)

    def mcp_mirrors_the_registry():
        # The other half of the promise: a registered tool is an MCP tool, with no
        # second list to maintain.
        import mcp_server
        mcp_names = {t["name"] for t in mcp_server._tools()}
        assert mcp_names == registered, (
            f"MCP and the assistant registry disagree: "
            f"only in MCP {sorted(mcp_names - registered)}, "
            f"only in assistant {sorted(registered - mcp_names)}"
        )
    check("MCP exposes exactly the assistant registry", mcp_mirrors_the_registry)

    def person_tools_use_the_graph():
        # Cheap guard against the mistake that cost the most here: matching people
        # by display name instead of going through the identity graph.
        src = (REPO / "soundboard.py").read_text()
        assert "crcmz_identity" in src, \
            "soundboard.py must resolve people through crcmz_identity"
        assert "display_name ==" not in src, \
            "soundboard.py looks like it matches people by display name"
    check("person lookups go through the identity graph", person_tools_use_the_graph)

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
