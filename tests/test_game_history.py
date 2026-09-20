#!/usr/bin/env python3
"""Game history: PSN title counters, session folding, and the tools over MCP.

Plain asserts, no pytest. The module itself is pure sqlite + stdlib so it runs on
the host; the assistant/MCP half needs the app deps, so run it in the image:

    docker build -t crcmz-app:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_game_history.py
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-games")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import game_history as gh  # noqa: E402

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


gh.DB_PATH = Path(tempfile.mkdtemp(prefix="games-test-")) / "game_history.db"
gh.init()

NOW = int(time.time())

# Shaped like the real gamelist payload, including the fields that matter:
# playDuration as an ISO-8601 duration and the two timestamps.
TITLES_MOIZ = [
    {"titleId": "PPSA01", "name": "ARC Raiders", "category": "ps5_native_game",
     "service": "ps5", "imageUrl": "http://img/arc.png", "playCount": 412,
     "playDuration": "PT138H23M11S",
     "firstPlayedDateTime": "2025-11-02T04:10:00Z",
     "lastPlayedDateTime": "2026-09-18T06:55:00Z"},
    {"titleId": "PPSA02", "name": "Call of Duty", "category": "ps5_native_game",
     "playCount": 90, "playDuration": "PT41H5M",
     "lastPlayedDateTime": "2026-09-10T02:00:00Z"},
    # A media app: stored, because the point is to keep everything, unlike the
    # dashboard's whitelist.
    {"titleId": "PPSA03", "name": "Netflix", "playCount": 3,
     "playDuration": "PT2H", "lastPlayedDateTime": "2026-01-05T02:00:00Z"},
]

TITLES_ZUBI = [
    {"titleId": "PPSA01", "name": "ARC Raiders", "playCount": 120,
     "playDuration": "PT40H", "lastPlayedDateTime": "2026-09-17T05:00:00Z"},
]


# ── duration parsing ──────────────────────────────────────────────────────────
def t_iso_durations_parse():
    assert gh.duration_seconds("PT1H") == 3600
    assert gh.duration_seconds("PT1H30M") == 5400
    assert gh.duration_seconds("PT138H23M11S") == 138 * 3600 + 23 * 60 + 11
    assert gh.duration_seconds("P2DT1H") == 2 * 86400 + 3600
    assert gh.duration_seconds("PT10.5S") == 10


def t_bad_durations_are_zero_not_an_exception():
    # A weird value must cost us that one field, not the whole library.
    for bad in (None, "", "banana", "1H30M", 42, {}, "P"):
        assert gh.duration_seconds(bad) == 0, bad


# ── title records ─────────────────────────────────────────────────────────────
def t_titles_are_recorded():
    assert gh.record_titles("moiiz41510", TITLES_MOIZ) == 3
    assert gh.record_titles("killerx096", TITLES_ZUBI) == 1
    top = gh.top_games()
    arc = top["games"][0]
    assert arc["game"] == "ARC Raiders", top
    # 138h23m11s + 40h, summed across both accounts.
    assert arc["hours"] == round((138 * 3600 + 23 * 60 + 11 + 40 * 3600) / 3600, 1), arc
    assert arc["players"] == 2, arc
    assert arc["launches"] == 412 + 120, arc


def t_unfiltered_by_the_dashboard_whitelist():
    names = [g["game"] for g in gh.top_games(limit=50)["games"]]
    assert "Netflix" in names, "the library must keep non-whitelisted titles"


def t_per_player_split():
    arc = gh.top_games()["games"][0]
    by = {p["psn_id"]: p["hours"] for p in arc["by_player"]}
    assert by["moiiz41510"] > by["killerx096"], by
    assert by["killerx096"] == 40.0, by


def t_upsert_does_not_double_count():
    before = gh.top_games()["games"][0]["hours"]
    gh.record_titles("moiiz41510", TITLES_MOIZ)      # same sweep again
    assert gh.top_games()["games"][0]["hours"] == before


def t_counters_never_walk_backwards():
    # A partial or stale PSN response must not shrink a recorded playtime.
    stale = [{"titleId": "PPSA01", "name": "ARC Raiders", "playCount": 1,
              "playDuration": "PT1H", "lastPlayedDateTime": "2025-01-01T00:00:00Z"}]
    before = gh.top_games()["games"][0]["hours"]
    gh.record_titles("moiiz41510", stale)
    assert gh.top_games()["games"][0]["hours"] == before, "playtime went backwards"


def t_junk_entries_are_skipped():
    assert gh.record_titles("nobody", []) == 0
    assert gh.record_titles("", TITLES_MOIZ) == 0
    # No titleId or no name -> not a title we can key on.
    assert gh.record_titles("x", [{"name": "No Id"}, {"titleId": "T"}, "nonsense"]) == 0


# ── sessions ──────────────────────────────────────────────────────────────────
def t_consecutive_samples_fold_into_one_session():
    base = NOW - 7200
    assert gh.record_presence("moiiz41510", "ARC Raiders", at=base) == "opened"
    for i in range(1, 5):                      # four more polls, 180s apart
        assert gh.record_presence("moiiz41510", "ARC Raiders",
                                  at=base + i * 180) == "extended"
    s = gh.sessions(who="moiiz41510")["sessions"][0]
    assert s["game"] == "ARC Raiders", s
    assert s["observations"] == 5, s
    assert s["minutes"] == 12, s               # 4 * 180s
    assert s["who"] == "moiiz41510", "unresolvable psn id should fall back to itself"


def t_a_long_gap_starts_a_new_session():
    base = NOW - 7200
    gh.record_presence("moiiz41510", "ARC Raiders",
                       at=base + 4 * 180 + gh.SESSION_GAP_SEC + 1)
    got = gh.sessions(who="moiiz41510")["sessions"]
    assert len(got) == 2, got
    assert got[0]["observations"] == 1, got[0]


def t_switching_game_starts_a_new_session():
    assert gh.record_presence("killerx096", "ARC Raiders", at=NOW - 600) == "opened"
    assert gh.record_presence("killerx096", "Call of Duty", at=NOW - 500) == "opened"
    got = gh.sessions(who="killerx096")["sessions"]
    assert [s["game"] for s in got] == ["Call of Duty", "ARC Raiders"], got


def t_no_game_is_ignored():
    # Someone online on the menus must not open a session, and must not close the
    # one that is running -- the gap does that.
    before = gh.sessions(who="killerx096")["count"]
    for empty in (None, "", "   "):
        assert gh.record_presence("killerx096", empty) == "ignored"
    assert gh.sessions(who="killerx096")["count"] == before


def t_record_sweep_reads_a_squad_payload():
    out = gh.record_sweep([
        {"online_id": "ASamad89", "game": "ARC Raiders", "playing": True},
        {"online_id": "mutasif", "game": None, "online": True},   # menus
        {"online_id": "", "game": "Ghost"},                       # no id
        "not a dict",
    ])
    assert out["opened"] == 1, out
    assert out["ignored"] == 2, out
    assert gh.sessions(who="ASamad89")["count"] == 1


def t_session_minutes_never_report_zero():
    # A single-sample session is real (they were seen once); reporting 0 minutes
    # would read as "did not play".
    gh.record_presence("oneshot", "Helldivers", at=NOW - 30)
    assert gh.sessions(who="oneshot")["sessions"][0]["minutes"] == 1


# ── ranges, clamps, empties ───────────────────────────────────────────────────
def t_range_filters_sessions():
    old = NOW - 400 * 86400
    gh.record_presence("ancient", "PT Demo", at=old)
    assert gh.sessions(who="ancient", range="all_time")["count"] == 1
    assert gh.sessions(who="ancient", range="last_7_days")["count"] == 0


def t_limits_are_clamped():
    assert len(gh.sessions(limit=1)["sessions"]) == 1
    assert len(gh.sessions(limit=-5)["sessions"]) == 1        # floor is 1
    assert len(gh.top_games(limit=99999)["games"]) <= 100     # ceiling holds


def t_person_games_rolls_up_one_account():
    p = gh.person_games("moiiz41510")
    assert p["titles"] == 3, p
    assert p["top"][0]["game"] == "ARC Raiders", p
    assert p["total_hours"] > 180, p
    assert p["last_session"]["game"] == "ARC Raiders", p


def t_unknown_person_is_empty_not_an_error():
    p = gh.person_games("nobody-at-all")
    assert p["titles"] == 0 and p["top"] == [], p
    assert p["last_session"] is None, p
    assert gh.person_games("")["titles"] == 0


def t_overview_counts():
    o = gh.overview()
    assert o["players_with_history"] == 2, o
    assert o["distinct_games"] == 3, o
    assert o["sessions_recorded"] >= 5, o


def t_missing_db_degrades_to_a_note():
    saved = gh.DB_PATH
    gh.DB_PATH = Path("/nope/never/game_history.db")
    try:
        assert gh.top_games()["games"] == []
        assert "note" in gh.top_games()
        assert gh.sessions()["sessions"] == []
        assert gh.person_games("moiiz41510")["titles"] == 0
        assert gh.overview()["titles_known"] == 0
    finally:
        gh.DB_PATH = saved


# ── the tools + MCP ───────────────────────────────────────────────────────────
def tool_tests():
    import assistant
    import mcp_server

    def t_tools_are_registered():
        for n in ("games_played", "game_sessions"):
            assert n in assistant.tool_names(), assistant.tool_names()
        # And therefore exposed over MCP with no second list to maintain.
        mcp = {t["name"] for t in mcp_server._tools()}
        assert {"games_played", "game_sessions"} <= mcp, sorted(mcp)

    def t_tool_names_stay_read_only():
        banned = ("send", "post", "delete", "remove", "write", "create", "update")
        for n in ("games_played", "game_sessions"):
            assert not any(b in n for b in banned), n

    def t_games_played_through_the_registry():
        import game_history
        game_history.DB_PATH = gh.DB_PATH          # the tool reads the test db
        out, ok = assistant.call_tool("games_played", {})
        assert ok is True, out
        d = json.loads(out)
        assert d["games"][0]["game"] == "ARC Raiders", d
        assert "measured_by" in d, "the tool must say what the hours mean"

    def t_sessions_through_the_registry():
        out, ok = assistant.call_tool("game_sessions", {"who": "killerx096"})
        assert ok is True, out
        d = json.loads(out)
        assert d["count"] == 2, d
        assert "caveat" in d, "the accuracy caveat must travel with the numbers"

    def t_tool_clamps_a_silly_limit():
        out, ok = assistant.call_tool("games_played", {"limit": 10 ** 6})
        assert ok is True, out
        assert len(json.loads(out)["games"]) <= 100

    def t_no_credentials_in_the_output():
        out, _ = assistant.call_tool("games_played", {})
        blob = out.lower()
        for bad in ("npsso", "access_token", "refresh_token", "authorization"):
            assert bad not in blob, bad

    def t_overview_mentions_games():
        out, ok = assistant.call_tool("platform_overview", {})
        assert ok is True, out
        assert "games" in json.loads(out), "platform_overview must surface game history"

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check("tools/" + name[2:], fn)


print("Game history tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("\nTool + MCP tests")
try:
    tool_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"tool_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not load the assistant: {type(e).__name__}: {e}")

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
