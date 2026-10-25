#!/usr/bin/env python3
"""trip.crcmz.me tools: registered as read tools, GET-only, and failing soft.

Plain asserts, no pytest. No network: httpx.get is replaced by a fake.

    tests/run-all.sh test_trip_hub
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import assistant  # noqa: E402
import trip_hub  # noqa: E402

FAILED: list[str] = []
PASSED = 0
TRIP_TOOLS = ["trip_overview", "trip_days", "trip_stay", "trip_split", "trip_flights",
              "trip_packing", "trip_poll", "trip_weather", "trip_food_search", "trip_buds_search"]


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


class _Resp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


calls = []


def fake_get(url, params=None, headers=None, timeout=None):
    calls.append((url, params, headers))
    if headers.get("Authorization") != "Bearer test-token":
        return _Resp(401, {"error": "service token required"})
    return _Resp(200, {"result": {"tool": url.rsplit("/", 1)[1], "params": params}})


def main():
    trip_hub.httpx.get = fake_get

    def registered_as_read_tools():
        names = set(assistant.tool_names())
        missing = [n for n in TRIP_TOOLS if n not in names]
        assert not missing, missing
        assert not set(TRIP_TOOLS) & set(assistant.write_tool_names())
    check("all trip tools are in the read registry (so MCP serves them)", registered_as_read_tools)

    def unset_token_is_soft():
        os.environ.pop("TRIP_SERVICE_TOKEN", None)
        out = assistant._TOOLS["trip_overview"]["fn"]()
        assert "isn't connected" in out.get("error", ""), out
    check("no TRIP_SERVICE_TOKEN -> a clear message, not a crash", unset_token_is_soft)

    def calls_the_right_read_tool():
        os.environ["TRIP_SERVICE_TOKEN"] = "test-token"
        calls.clear()
        r = trip_hub.read("search_food", {"query": "shawarma", "limit": 3})
        assert r["tool"] == "search_food", r
        url, params, headers = calls[-1]
        assert url.endswith("/api/service/tool/search_food"), url
        assert '"shawarma"' in params["args"], params
        assert headers["Authorization"] == "Bearer test-token"
    check("GETs /api/service/tool/<name> with JSON args and the bearer", calls_the_right_read_tool)

    def clamps_limits():
        calls.clear()
        assistant._TOOLS["trip_food_search"]["fn"](query="x", limit=10000)
        assert '"limit": 40' in calls[-1][1]["args"], calls[-1]
    check("food search clamps limit to 40", clamps_limits)

    def wrong_token_reports_error():
        os.environ["TRIP_SERVICE_TOKEN"] = "nope"
        r = trip_hub.read("get_split")
        assert "error" in r and "token" in r["error"], r
    check("a rejected token comes back as an error dict", wrong_token_reports_error)

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
