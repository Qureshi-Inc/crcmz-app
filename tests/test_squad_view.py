#!/usr/bin/env python3
"""squad_view: Squad names, cross-platform stats, ranks and squad numbers.

Plain asserts, no pytest. Pure module (no server import), so it runs on the host
or in the image:

    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_squad_view.py

game_history runs against a temp SQLite file; the identity graph and Steam's
cached stats are stubbed, so nothing reaches the network.
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-squad-view")
os.environ["STEAM_WEB_API_KEY"] = "SECRET-STEAM-KEY"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crcmz_identity  # noqa: E402
import game_history  # noqa: E402
import steam  # noqa: E402
import squad_view  # noqa: E402

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


game_history.DB_PATH = Path(tempfile.mkdtemp()) / "game_history.db"
game_history.init()
game_history.record_titles("mazino_psn", [
    {"titleId": "CUSA1", "name": "Call of Duty®", "playDuration": "PT900H", "playCount": 50},
    {"titleId": "CUSA2", "name": "Arc Raiders", "playDuration": "PT100H", "playCount": 9},
])
game_history.record_titles("soup_psn", [
    {"titleId": "CUSA2", "name": "ARC RAIDERS", "playDuration": "PT40H", "playCount": 3},
])
now = int(time.time())
with game_history._conn() as db:
    db.execute("INSERT INTO play_sessions (online_id, game, started_at, last_seen_at) VALUES (?,?,?,?)",
               ("mazino_psn", "Arc Raiders", now - 3 * 3600, now - 3600))
    db.execute("INSERT INTO play_sessions (online_id, game, started_at, last_seen_at) VALUES (?,?,?,?)",
               ("mazino_psn", "Arc Raiders", now - 40 * 86400, now - 40 * 86400 + 3600))
    db.commit()

PEOPLE = {
    "100": {"zitadel_id": "100", "display_name": "Mazino", "psn_id": "mazino_psn", "mm_username": "mazino",
            "steam_id": "76561198000000001", "squad_name": "Maz", "tags": {}},
    "200": {"zitadel_id": "200", "display_name": "Nooni", "psn_id": "", "mm_username": "nuharqam",
            "steam_id": "76561198000000002", "squad_name": "", "tags": {"chosen_username": "mythnuni"}},
    "300": {"zitadel_id": "300", "display_name": "Interesting Soup", "psn_id": "soup_psn", "mm_username": "moiz",
            "steam_id": "", "squad_name": "", "tags": {}},
}
TAG_WRITES: list[tuple] = []
crcmz_identity.by_zitadel_id = lambda **_: PEOPLE
crcmz_identity.people = lambda **_: list(PEOPLE.values())
crcmz_identity.set_tag = lambda sub, key, value: TAG_WRITES.append((sub, key, value)) or True
crcmz_identity.clear_tag = lambda sub, key: TAG_WRITES.append((sub, key, None)) or True
OWNED = {"76561198000000002": [{"name": "Call of Duty®", "hours": 980, "icon": "i1"},
                               {"name": "Arc Raiders", "hours": 20, "icon": "i2"}]}
steam.stats = lambda sid: {"owned": OWNED.get(sid, [])}

# What steam.merge_into_squad hands over: Mazino has both (Steam game details
# private), Nooni is Steam-only, Soup is PSN-only.
ROWS = [
    {"online_id": "mazino_psn", "_sub": "100", "online": True, "playing": False, "trophy_level": 108,
     "platinum": 2, "platforms": ["psn", "steam"],
     "steam": {"level": 7, "level_top_pct": 60.0, "game_count": None, "hours_total": None, "hours_2weeks": None,
               "top_game": None}},
    {"name": "Nooni", "_sub": "200", "online": True, "playing": True, "game": "MW3", "platforms": ["steam"],
     "steam": {"level": 3, "level_top_pct": 80.0, "game_count": 11, "hours_total": 1163, "hours_2weeks": 4.2,
               "top_game": {"name": "Call of Duty®", "hours": 980, "icon": "i1"}}},
    {"online_id": "soup_psn", "_sub": "300", "online": False, "playing": False, "trophy_level": 300,
     "platinum": 20, "platforms": ["psn"]},
]
OUT = squad_view.build(ROWS)
BY = {r.get("online_id") or r["name"]: r for r in OUT["squad"]}

print("rows")


def squad_name_replaces_the_shown_name():
    assert BY["mazino_psn"]["name"] == "Maz" and "name" not in BY["soup_psn"], OUT["squad"]


def join_key_is_stripped():
    assert all("_sub" not in r for r in OUT["squad"])
    blob = json.dumps(OUT)
    assert "SECRET-STEAM-KEY" not in blob and "76561198" not in blob, blob


def psn_and_steam_hours_add_up():
    m = BY["mazino_psn"]["stats"]
    assert m["psn_hours"] == 1000 and m["steam_hours"] is None and m["hours_total"] == 1000, m
    assert m["hours_2weeks"] == 2.0 and m["games"] == 2, m  # the 40-day-old session is outside the window
    assert m["steam_games_private"] and m["steam_level"] == 7, m
    n = BY["Nooni"]["stats"]
    assert n["hours_total"] == 1163 and n["games"] == 11 and n["hours_2weeks"] == 4.2, n
    assert not n["steam_games_private"] and n["top_game"]["platform"] == "steam", n


check("squad_name replaces the shown name", squad_name_replaces_the_shown_name)
check("the _sub join key, SteamIDs and the key never leave", join_key_is_stripped)
check("PSN and Steam numbers add up per person", psn_and_steam_hours_add_up)

print("ranks")
R = OUT["ranks"]


def every_mode_present():
    assert set(R) == set(squad_view.RANK_MODES), R.keys()


def steam_only_player_ranks_on_cross_platform_boards():
    assert [e["name"] for e in R["hours"]["entries"]] == ["Nooni", "Maz", "soup_psn"]
    assert [e["name"] for e in R["recent"]["entries"]] == ["Nooni", "Maz"], R["recent"]


def platform_boards_only_hold_that_platform():
    assert [e["name"] for e in R["trophies"]["entries"]] == ["soup_psn", "Maz"]
    assert [e["name"] for e in R["steam"]["entries"]] == ["Maz", "Nooni"]
    assert R["steam"]["entries"][0]["detail"] == "Top 60.0% of Steam"


def overall_is_scaled_and_bounded():
    e = {x["name"]: x["value"] for x in R["overall"]["entries"]}
    assert all(0 <= v <= 100 for v in e.values()) and e["Nooni"] > e["soup_psn"], e
    assert "Steam games private" in next(x for x in R["overall"]["entries"] if x["name"] == "Maz")["detail"]


check("every rank mode is returned", every_mode_present)
check("a Steam-only player ranks on cross-platform boards", steam_only_player_ranks_on_cross_platform_boards)
check("trophy/Steam boards only hold that platform", platform_boards_only_hold_that_platform)
check("overall is 0-100 and notes private Steam games", overall_is_scaled_and_bounded)

print("squad numbers")
S = OUT["summary"]


def numbers():
    assert S["hours_total"] == 1000 + 1163 + 40, S
    assert S["most_played"]["name"].startswith("Call of Duty") and S["most_played"]["hours"] == 1880, S
    # Arc Raiders: Mazino + Soup on PSN (named differently) + Nooni on Steam.
    assert S["most_shared"]["players"] == 3 and S["most_shared"]["name"].lower() == "arc raiders", S
    assert S["grinder"] == {"name": "Nooni", "hours": 4.2} and S["playing_now"] == 1, S


check("squad totals, most played, most shared, grinder", numbers)

print("set_name")


def name_rules():
    TAG_WRITES.clear()
    assert squad_view.set_name("300", "  Soup   King ") == "ok" and TAG_WRITES[-1] == ("300", "squad_name", "Soup King")
    assert squad_view.set_name("300", "x") == "invalid"
    assert squad_view.set_name("300", "a" * 25) == "invalid"
    assert squad_view.set_name("300", "@everyone") == "invalid"
    assert squad_view.set_name("300", "bad‮name") == "invalid"
    assert squad_view.set_name("300", "") == "ok" and TAG_WRITES[-1] == ("300", "squad_name", None)


def no_impersonation():
    for taken in ("maz", "MAZINO", "mythnuni", "nuharqam", "Nooni"):
        assert squad_view.set_name("300", taken) == "taken", taken
    assert squad_view.set_name("100", "Maz") == "ok"  # your own name is fine


def resolve_knows_squad_names():
    import importlib
    ident = importlib.reload(crcmz_identity)
    ident.people = lambda **_: [{**p, "username": "", "email": "", "wa_names": [], "wa_jid": "", "wa_phone": ""}
                                for p in PEOPLE.values()]
    assert ident.resolve("maz")["zitadel_id"] == "100"


check("names are cleaned, bounded and refuse @ / control chars", name_rules)
check("a name already used by someone else is refused", no_impersonation)
check("resolve() finds people by Squad name", resolve_knows_squad_names)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
