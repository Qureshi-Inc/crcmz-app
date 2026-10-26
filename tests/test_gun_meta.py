#!/usr/bin/env python3
"""Gun meta tools: read-only, built URLs, API errors passed through, soft failures.

Plain asserts, no pytest. A local HTTPServer stands in for the meta API.

    tests/run-all.sh test_gun_meta
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import assistant  # noqa: E402
import gun_meta  # noqa: E402

FAILED: list[str] = []
PASSED = 0
TOOLS = ["gun_meta_games", "gun_meta_class", "gun_meta_tier_list", "gun_meta_weapon",
         "gun_meta_search"]
seen: list[tuple[str, dict]] = []


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


class Api(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        seen.append((url.path, q))
        if url.path == "/api/games/mw4/weapons/kastv":
            status, body = 404, {"error": "No weapon 'kastv' in mw4. Did you mean: KASTOV 762?"}
        elif url.path == "/api/broken":
            status, body = 500, None
        else:
            status, body = 200, {"path": url.path, "params": q}
        raw = b"not json" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


def call(name, args):
    out, ok = assistant.call_tool(name, args)
    assert ok, out
    return json.loads(out)


def main():
    srv = HTTPServer(("127.0.0.1", 0), Api)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def registered_read_only():
        names = set(assistant.tool_names())
        assert not [n for n in TOOLS if n not in names], names
        assert not set(TOOLS) & set(assistant.write_tool_names())

    def unset_url_says_so():
        os.environ.pop("GUN_META_URL", None)
        r = call("gun_meta_games", {})
        assert "GUN_META_URL unset" in r["error"], r

    check("registered as read tools", registered_read_only)
    check("unset GUN_META_URL fails soft", unset_url_says_so)
    os.environ["GUN_META_URL"] = f"http://127.0.0.1:{srv.server_port}/"

    def games_paths():
        assert call("gun_meta_games", {})["path"] == "/api/games"
        assert call("gun_meta_games", {"game": "mw4"})["path"] == "/api/games/mw4"

    def class_params_and_clamp():
        r = call("gun_meta_class", {"game": "mw4", "mode": "dmz pvp",
                                    "category": "long range", "weapon_type": "smg",
                                    "limit": 500})
        assert r["path"] == "/api/games/mw4/meta", r
        assert r["params"] == {"mode": "dmz pvp", "category": "long range", "type": "smg",
                               "limit": "10"}, r
        assert call("gun_meta_class", {"game": "mw4", "limit": 0})["params"]["limit"] == "3"

    def empty_filters_not_sent():
        r = call("gun_meta_tier_list", {"game": "bo6", "mode": "multiplayer"})
        assert r["path"] == "/api/games/bo6/tier-list" and r["params"] == {"mode": "multiplayer"}, r

    def path_segments_escaped():
        r = call("gun_meta_weapon", {"game": "mw4", "name": "../../health?x=1"})
        assert r["path"] == "/api/games/mw4/weapons/..%2F..%2Fhealth%3Fx%3D1", r

    def api_error_passed_through():
        r = call("gun_meta_weapon", {"game": "mw4", "name": "kastv"})
        assert r == {"error": "No weapon 'kastv' in mw4. Did you mean: KASTOV 762?"}, r

    def non_json_and_unreachable_fail_soft():
        assert gun_meta.read("/broken") == {"error": "gun meta service answered HTTP 500"}
        os.environ["GUN_META_URL"] = "http://127.0.0.1:1"
        try:
            assert "unreachable" in call("gun_meta_search", {"q": "han"})["error"]
        finally:
            os.environ["GUN_META_URL"] = f"http://127.0.0.1:{srv.server_port}"

    def search_params():
        r = call("gun_meta_search", {"q": "han", "game": "mw4"})
        assert r["path"] == "/api/search" and r["params"] == {"q": "han", "game": "mw4"}, r

    check("games: list and one game", games_paths)
    check("class: filters mapped, limit clamped 1-10", class_params_and_clamp)
    check("empty filters are not sent", empty_filters_not_sent)
    check("weapon name can't escape its path segment", path_segments_escaped)
    check("API error text reaches the model", api_error_passed_through)
    check("non-JSON / unreachable fail soft", non_json_and_unreachable_fail_soft)
    check("search params", search_params)

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
