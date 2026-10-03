#!/usr/bin/env python3
"""Steam: OpenID assertion checks, linking through the steam_id tag, Squad rows.

Plain asserts, no pytest -- run inside the app image:

    docker build -t crcmz-app:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_steam.py

A local HTTP server stands in for both Steam's OpenID endpoint and the Web API,
so the real httpx path is exercised.
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

server = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
BASE = f"http://127.0.0.1:{server.server_port}"
os.environ["STEAM_WEB_API_KEY"] = "SECRET-STEAM-KEY"
os.environ["STEAM_API_BASE"] = BASE
os.environ["STEAM_OPENID_URL"] = f"{BASE}/openid/login"
os.environ.setdefault("SESSION_SECRET", "test-secret-for-steam")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crcmz_identity  # noqa: E402
import steam  # noqa: E402

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


MAZINO, NOONI, PRIVATE = "76561198000000001", "76561198000000002", "76561198000000003"
OPENID_VALID = True
API_CALLS: list[str] = []

SUMMARIES = [
    {"steamid": MAZINO, "personaname": "mazino_steam", "personastate": 1, "avatarfull": "https://a/m.jpg",
     "profileurl": "https://steamcommunity.com/id/mazino/", "communityvisibilitystate": 3,
     "gameextrainfo": "Counter-Strike 2", "gameid": "730"},
    {"steamid": NOONI, "personaname": "nooni", "personastate": 3, "communityvisibilitystate": 3},
    {"steamid": PRIVATE, "personaname": "ghost", "personastate": 0, "communityvisibilitystate": 1},
]
OWNED = {MAZINO: {"game_count": 2, "games": [
    {"appid": 730, "name": "Counter-Strike 2", "playtime_forever": 6000, "img_icon_url": "abc"},
    {"appid": 570, "name": "Dota 2", "playtime_forever": 120, "img_icon_url": "def"}]},
    NOONI: {"game_count": 0}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        form = parse_qs(self.rfile.read(n).decode())
        assert form["openid.mode"] == ["check_authentication"], form
        self._send(f"ns:http://specs.openid.net/auth/2.0\nis_valid:{'true' if OPENID_VALID else 'false'}\n",
                   "text/plain")

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        assert q.get("key") == "SECRET-STEAM-KEY", q
        API_CALLS.append(u.path)
        sid = q.get("steamid")
        if u.path.startswith("/ISteamUser/GetPlayerSummaries"):
            ids = q["steamids"].split(",")
            return self._send({"response": {"players": [p for p in SUMMARIES if p["steamid"] in ids]}})
        if u.path.startswith("/IPlayerService/GetSteamLevel"):
            return self._send({"response": {"player_level": 42} if sid == MAZINO else {}})
        if u.path.startswith("/IPlayerService/GetOwnedGames"):
            return self._send({"response": OWNED.get(sid, {})})
        if u.path.startswith("/IPlayerService/GetRecentlyPlayedGames"):
            if sid == MAZINO:
                return self._send({"response": {"total_count": 1, "games": [
                    {"appid": 730, "name": "Counter-Strike 2", "playtime_2weeks": 90, "img_icon_url": "abc"}]}})
            return self._send({"response": {"total_count": 0} if sid == NOONI else {}})
        self.send_response(404)
        self.end_headers()


server.RequestHandlerClass = Handler
threading.Thread(target=server.serve_forever, daemon=True).start()

# ── Fake identity graph ──────────────────────────────────────────────────────
PEOPLE = [
    {"zitadel_id": "100", "display_name": "Mazino", "mm_username": "mazino", "steam_id": MAZINO,
     "tags": {"steam_id": MAZINO}},
    {"zitadel_id": "200", "display_name": "Nooni", "mm_username": "nooni", "steam_id": NOONI,
     "tags": {"steam_id": NOONI}},
    {"zitadel_id": "300", "display_name": "Ghost", "mm_username": "", "steam_id": PRIVATE, "tags": {}},
    {"zitadel_id": "400", "display_name": "PSN only", "mm_username": "", "steam_id": "", "tags": {}},
]
TAG_WRITES: list[tuple] = []
crcmz_identity.people = lambda **_: PEOPLE
crcmz_identity.by_zitadel_id = lambda **_: {p["zitadel_id"]: p for p in PEOPLE}
crcmz_identity.set_tag = lambda sub, key, value: TAG_WRITES.append((sub, key, value)) or True
crcmz_identity.clear_tag = lambda sub, key: TAG_WRITES.append((sub, key, None)) or True

CALLBACK = "https://app.crcmz.me/settings/steam/callback"


def assertion(**over):
    p = {"openid.ns": "http://specs.openid.net/auth/2.0", "openid.mode": "id_res",
         "openid.op_endpoint": steam.OPENID_URL,
         "openid.claimed_id": f"https://steamcommunity.com/openid/id/{MAZINO}",
         "openid.identity": f"https://steamcommunity.com/openid/id/{MAZINO}",
         "openid.return_to": CALLBACK + "?state=abc", "openid.response_nonce": "2026-10-03T00:00:00Zx",
         "openid.assoc_handle": "1234567890", "openid.signed": "signed,op_endpoint,claimed_id",
         "openid.sig": "sig=", "state": "abc"}
    p.update(over)
    return p


print("openid")


def login_url_asks_for_identifier_select():
    url = steam.login_url(CALLBACK + "?state=s", "https://app.crcmz.me/")
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    assert q["openid.mode"] == "checkid_setup" and q["openid.return_to"].endswith("?state=s"), q
    assert q["openid.claimed_id"].endswith("identifier_select") and q["openid.realm"] == "https://app.crcmz.me/", q


def valid_assertion_yields_steam_id():
    assert steam.verify_assertion(assertion(), CALLBACK) == MAZINO


def steam_saying_no_is_refused():
    global OPENID_VALID
    OPENID_VALID = False
    try:
        assert steam.verify_assertion(assertion(), CALLBACK) is None
    finally:
        OPENID_VALID = True


def tampered_fields_are_refused_before_asking_steam():
    for over in ({"openid.return_to": "https://evil.example/cb"},
                 {"openid.op_endpoint": "https://evil.example/openid/login"},
                 {"openid.claimed_id": "https://evil.example/openid/id/76561198000000001"},
                 {"openid.identity": f"https://steamcommunity.com/openid/id/{NOONI}"},
                 {"openid.mode": "cancel"}):
        assert steam.verify_assertion(assertion(**over), CALLBACK) is None, over


check("login_url asks Steam for identifier_select", login_url_asks_for_identifier_select)
check("a valid assertion yields the SteamID64", valid_assertion_yields_steam_id)
check("is_valid:false is refused", steam_saying_no_is_refused)
check("tampered return_to/endpoint/claimed_id are refused", tampered_fields_are_refused_before_asking_steam)

print("linking")


def link_writes_the_tag():
    TAG_WRITES.clear()
    assert steam.link("400", "76561198000000009") == "ok"
    assert TAG_WRITES == [("400", "steam_id", "76561198000000009")], TAG_WRITES


def link_refuses_someone_elses_steam():
    TAG_WRITES.clear()
    assert steam.link("400", MAZINO) == "taken" and TAG_WRITES == []
    assert steam.link("100", MAZINO) == "ok"  # re-linking your own is fine


def link_refuses_garbage():
    assert steam.link("400", "123") == "failed"


def unlink_clears_the_tag():
    TAG_WRITES.clear()
    assert steam.unlink("100") and TAG_WRITES == [("100", "steam_id", None)]


check("link writes the steam_id tag", link_writes_the_tag)
check("link refuses a SteamID tagged on someone else", link_refuses_someone_elses_steam)
check("link refuses a malformed SteamID", link_refuses_garbage)
check("unlink clears the tag", unlink_clears_the_tag)

print("squad")
ROWS = steam.squad_status()
BY = {r["zitadel_id"]: r for r in ROWS}


def only_linked_people_playing_first():
    assert [r["zitadel_id"] for r in ROWS] == ["100", "200", "300"], [r["zitadel_id"] for r in ROWS]


def presence_and_stats():
    m = BY["100"]
    assert m["playing"] and m["game"] == "Counter-Strike 2" and m["state"] == "online", m
    assert m["level"] == 42 and m["game_count"] == 2 and m["hours_total"] == 102, m
    assert m["top_game"]["name"] == "Counter-Strike 2" and m["hours_2weeks"] == 1.5, m
    assert m["game_image"].endswith("/730/capsule_184x69.jpg"), m
    assert BY["200"]["state"] == "away" and BY["200"]["online"] and not BY["200"]["playing"]


def private_profile_is_unknown_not_zero():
    g = BY["300"]
    assert g["private"] and g["game_count"] is None and g["hours_total"] is None and g["level"] is None, g
    assert BY["200"]["game_count"] == 0 and BY["200"]["hours_2weeks"] == 0, BY["200"]


def no_key_leaks():
    blob = json.dumps(ROWS)
    assert "SECRET-STEAM-KEY" not in blob


def stats_are_cached():
    before = len(API_CALLS)
    steam.squad_status()
    assert len(API_CALLS) == before, API_CALLS[before:]


check("only linked people, playing first", only_linked_people_playing_first)
check("presence and stats are mapped", presence_and_stats)
check("a private profile reads as unknown, not zero", private_profile_is_unknown_not_zero)
check("the API key never reaches a row", no_key_leaks)
check("a second read is served from cache", stats_are_cached)

print("one squad list")
PEOPLE[0]["psn_id"] = "mazino_psn"
crcmz_identity.by_psn_id = lambda **_: {"mazino_psn": PEOPLE[0]}
PSN = [{"online_id": "mazino_psn", "online": False, "playing": False, "trophy_level": 300},
       {"online_id": "psn_only_guy", "online": True, "playing": True, "game": "Arc Raiders"}]
MERGED = steam.merge_into_squad(PSN)


def steam_playing_wins_over_psn_offline():
    m = MERGED[0]
    assert m["platform_source"] == "steam" and m["platforms"] == ["psn", "steam"], m
    assert m["playing"] and m["game"] == "Counter-Strike 2" and m["trophy_level"] == 300, m
    assert m["game_icon"].endswith("/730/abc.jpg") and m["steam"]["level"] == 42, m


def psn_rows_untouched_otherwise():
    m = MERGED[1]
    assert m["platform_source"] == "psn" and "steam" not in m and m["game"] == "Arc Raiders", m


def steam_only_people_get_their_own_rows():
    extra = MERGED[2:]
    assert [m["name"] for m in extra] == ["Nooni", "Ghost"], extra
    assert all(m["platform_source"] == "steam" and not m.get("online_id") for m in extra)
    assert extra[0]["online"] and not extra[0]["playing"]


def merged_rows_carry_no_ids_or_key():
    # `_sub` is squad_view's internal join key; squad_view strips it (test_squad_view.py).
    blob = json.dumps(MERGED)
    assert "SECRET-STEAM-KEY" not in blob and MAZINO not in blob, blob
    assert all("zitadel_id" not in m for m in MERGED) and all("_sub" in m for m in MERGED)


def psn_input_not_mutated():
    assert "platform_source" not in PSN[0]


check("Steam presence fills an offline PSN row and badges it Steam", steam_playing_wins_over_psn_offline)
check("a PSN-only row only gains its platform", psn_rows_untouched_otherwise)
check("Steam-only people are appended as their own rows", steam_only_people_get_their_own_rows)
check("merged rows carry no SteamID or key, only the internal _sub", merged_rows_carry_no_ids_or_key)
check("the PSN list passed in is not mutated", psn_input_not_mutated)

print("primary platform")


def primary_steam_leads_an_idle_row():
    PEOPLE[0]["primary_platform"] = "steam"
    SUMMARIES[0].pop("gameextrainfo"); SUMMARIES[0].pop("gameid")
    steam._cache.clear()
    try:
        m = steam.merge_into_squad([{"online_id": "mazino_psn", "online": False, "playing": False,
                                     "recent_game": "Arc Raiders", "trophy_level": 300}])[0]
        assert m["primary"] == "steam" and m["platform_source"] == "steam", m
        assert m["online"] and m["recent_game"] == "Counter-Strike 2", m
    finally:
        SUMMARIES[0].update(gameextrainfo="Counter-Strike 2", gameid="730")
        steam._cache.clear()


def a_live_psn_game_beats_primary_steam():
    PEOPLE[0]["primary_platform"] = "steam"
    steam._cache.clear()
    SUMMARIES[0].pop("gameextrainfo"); SUMMARIES[0].pop("gameid")
    try:
        m = steam.merge_into_squad([{"online_id": "mazino_psn", "online": True, "playing": True,
                                     "game": "Arc Raiders"}])[0]
        assert m["primary"] == "steam" and m["platform_source"] == "psn" and m["game"] == "Arc Raiders", m
    finally:
        SUMMARIES[0].update(gameextrainfo="Counter-Strike 2", gameid="730")
        PEOPLE[0].pop("primary_platform")
        steam._cache.clear()


def set_primary_writes_only_known_platforms():
    TAG_WRITES.clear()
    assert steam.set_primary("100", "steam") and TAG_WRITES == [("100", "primary_platform", "steam")]
    assert not steam.set_primary("100", "xbox") and len(TAG_WRITES) == 1


check("primary=steam leads an idle row (badge, last game)", primary_steam_leads_an_idle_row)
check("a live PSN game still beats primary=steam", a_live_psn_game_beats_primary_steam)
check("set_primary only writes psn or steam", set_primary_writes_only_known_platforms)

print("identity + tool")


def steam_id_is_an_app_writable_tag():
    assert "steam_id" in crcmz_identity.TAG_KEYS and "steam_id" in crcmz_identity._APP_TAGS
    assert "founder" not in crcmz_identity._APP_TAGS


def tool_is_registered_and_read_only():
    import assistant
    assert "steam_squad_status" in assistant.tool_names()
    text, ok = assistant.call_tool("steam_squad_status", {})
    out = json.loads(text)
    assert ok, out
    assert out["configured"] and out["count"] == 3, out
    assert "SECRET-STEAM-KEY" not in json.dumps(out) and "zitadel_id" not in out["members"][0]


check("steam_id is a tag the app may write; founder is not", steam_id_is_an_app_writable_tag)
check("steam_squad_status is registered and leaks nothing", tool_is_registered_and_read_only)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
