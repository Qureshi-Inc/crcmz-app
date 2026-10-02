#!/usr/bin/env python3
"""Android app rings (fcm.py), their routing and the app's routes.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_fcm

Nothing leaves the box: fcm._send_one and webpush._send_one are fakes.
"""

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-fcm-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fcm  # noqa: E402
import notifications  # noqa: E402
import webpush  # noqa: E402

TMP = Path(tempfile.mkdtemp())
webpush._DB_PATH = TMP / "push.db"
webpush._KEY_PATH = TMP / "vapid_private.pem"
fcm._DB_PATH = TMP / "fcm.db"
notifications._DB_PATH = TMP / "notifications.db"
webpush.init()
fcm.init()
notifications.init()

FAILED: list[str] = []
PASSED = 0

TOKEN = "f" * 40
CREDS = {"project_id": "crcmz-app", "client_email": "x@y", "token_uri": "https://oauth2.example/token",
         "private_key": "unused"}
SENT: list[tuple[str, dict]] = []
PUSHED: list[str] = []
FCM_STATUS = {"default": (200, "")}


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


def fake_fcm(creds, token, data):
    SENT.append((token, data))
    return FCM_STATUS.get(token, FCM_STATUS["default"])


def fake_push(row, payload, *, ttl, urgency):
    PUSHED.append(row["endpoint"])
    return 201


fcm._send_one = fake_fcm
fcm._credentials = lambda: CREDS
webpush._send_one = fake_push


def reset():
    SENT.clear()
    PUSHED.clear()
    FCM_STATUS.clear()
    FCM_STATUS["default"] = (200, "")
    for p in (fcm._DB_PATH, webpush._DB_PATH, notifications._DB_PATH):
        p.unlink(missing_ok=True)
    webpush.init()
    fcm.init()
    notifications.init()


def web_sub(n: int) -> dict:
    return {"endpoint": f"https://fcm.googleapis.com/fcm/send/dev{n}",
            "keys": {"p256dh": "B" + "A" * 86, "auth": "A" * 22}}


def store_tests():
    print("store")

    def register_validates():
        reset()
        assert fcm.register("u1", "short") == {"error": "bad token"}
        assert fcm.register("u1", "a b" * 10) == {"error": "bad token"}
        assert fcm.register("u1", TOKEN, "ios") == {"error": "unknown platform"}
        assert fcm.register("", TOKEN) == {"error": "bad token"}
        assert fcm.register("u1", TOKEN) == {"ok": True}
        assert fcm.device_count("u1") == 1

    def re_register_keeps_endpoint_and_moves_owner():
        reset()
        fcm.register("u1", TOKEN, web_endpoint="https://fcm.googleapis.com/fcm/send/dev1")
        fcm.register("u2", TOKEN)  # the phone signed in as someone else; endpoint not known yet
        with fcm._conn() as db:
            row = db.execute("SELECT * FROM devices").fetchone()
        assert row["sub"] == "u2" and row["web_endpoint"].endswith("dev1")

    def devices_are_capped():
        reset()
        for i in range(fcm._MAX_DEVICES + 3):
            fcm.register("u1", f"{i:02d}" + "t" * 40)
        assert fcm.device_count("u1") == fcm._MAX_DEVICES

    for fn in (register_validates, re_register_keeps_endpoint_and_moves_owner, devices_are_capped):
        check(fn.__name__, fn)


def ring_tests():
    print("ring")

    def only_ring_categories_ring():
        reset()
        fcm.register("u1", TOKEN)
        assert fcm.ring("squad", "x")["recipients"] == 0 and SENT == []
        out = fcm.ring("huddle", "🎧 Moiz started a Huddle", "Room crcmz.", "/app/huddle?room=crcmz",
                       tag="huddle-crcmz", caller="Moiz")
        assert out["delivered"] == 1, out
        token, data = SENT[0]
        assert token == TOKEN and data["type"] == "ring" and data["caller"] == "Moiz"
        assert data["url"] == "/app/huddle?room=crcmz" and data["tag"] == "huddle-crcmz"
        assert all(isinstance(v, str) for v in data.values())  # FCM data values must be strings

    def exclude_only_and_prefs_apply():
        reset()
        fcm.register("u1", "1" * 40)
        fcm.register("u2", "2" * 40)
        fcm.register("u3", "3" * 40)
        webpush.save_prefs("u3", {"huddle": False})
        out = fcm.ring("huddle", "t", exclude="u1")
        assert [t for t, _ in SENT] == ["2" * 40] and out["recipients"] == 1
        SENT.clear()
        fcm.ring("watch", "t", only=["u3"])
        assert [t for t, _ in SENT] == ["3" * 40]  # watch is still on for u3

    def unsafe_url_becomes_app():
        reset()
        fcm.register("u1", TOKEN)
        fcm.ring("watch", "t", url="https://evil.io")
        assert SENT[0][1]["url"] == "/app"

    def dead_tokens_go_bad_payloads_stay():
        reset()
        fcm.register("u1", "1" * 40)
        fcm.register("u2", "2" * 40)
        fcm.register("u3", "3" * 40)
        FCM_STATUS["1" * 40] = (404, '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}')
        FCM_STATUS["2" * 40] = (400, '{"error":{"message":"Invalid JSON payload received."}}')
        FCM_STATUS["3" * 40] = (400, '{"error":{"message":"The registration token is not a valid FCM registration token"}}')
        out = fcm.ring("huddle", "t")
        assert out["gone"] == 2 and out["delivered"] == 0, out
        assert fcm.device_count("u2") == 1 and fcm.device_count("u1") == 0 and fcm.device_count("u3") == 0

    def no_credentials_no_ring():
        reset()
        fcm.register("u1", TOKEN)
        orig = fcm._credentials
        fcm._credentials = lambda: None
        try:
            assert fcm.ring("huddle", "t")["recipients"] == 0 and SENT == []
        finally:
            fcm._credentials = orig

    for fn in (only_ring_categories_ring, exclude_only_and_prefs_apply, unsafe_url_becomes_app,
               dead_tokens_go_bad_payloads_stay, no_credentials_no_ring):
        check(fn.__name__, fn)


def route_tests():
    print("route")

    def a_phone_that_rang_is_not_also_pushed():
        reset()
        webpush.subscribe("u1", web_sub(1))  # the Android app's own Web Push
        webpush.subscribe("u1", web_sub(2))  # a laptop
        fcm.register("u1", TOKEN, web_endpoint=web_sub(1)["endpoint"])
        out = notifications.route("huddle", "🎧 Noor started a Huddle", "Room crcmz.", "/app/huddle?room=crcmz",
                                  tag="huddle-crcmz", caller="Noor")
        assert out["ring"]["delivered"] == 1, out
        assert PUSHED == [web_sub(2)["endpoint"]], PUSHED
        assert out["push"]["recipients"] == 1

    def a_failed_ring_still_pushes():
        reset()
        webpush.subscribe("u1", web_sub(1))
        fcm.register("u1", TOKEN, web_endpoint=web_sub(1)["endpoint"])
        FCM_STATUS["default"] = (503, "")
        notifications.route("watch", "📺 Watch Party: Dune", "2 watching.", "/app/watch/party")
        assert PUSHED == [web_sub(1)["endpoint"]], PUSHED

    def other_categories_never_ring():
        reset()
        webpush.subscribe("u1", web_sub(1))
        fcm.register("u1", TOKEN, web_endpoint=web_sub(1)["endpoint"])
        out = notifications.route("squad", "Squad Up", "", "/app/squad")
        assert "ring" not in out and SENT == [] and PUSHED == [web_sub(1)["endpoint"]]

    for fn in (a_phone_that_rang_is_not_also_pushed, a_failed_ring_still_pushes, other_categories_never_ring):
        check(fn.__name__, fn)


def http_tests():
    from fastapi.testclient import TestClient
    import server

    print("routes")
    reset()
    server._fcm._DB_PATH = fcm._DB_PATH
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    cookie = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("393", "f@b.co"))}
    origin = {"Origin": "https://app.crcmz.me"}

    def asset_links_are_public():
        r = client.get("/.well-known/assetlinks.json")
        assert r.status_code == 200, r.status_code
        t = r.json()[0]["target"]
        assert t["package_name"] == "me.crcmz.app" and t["namespace"] == "android_app"
        assert len(t["sha256_cert_fingerprints"]) == 1 and t["sha256_cert_fingerprints"][0].count(":") == 31

    def native_needs_a_session_and_same_origin():
        assert client.post("/api/push/native", json={"token": TOKEN}, headers=origin).status_code == 401
        r = client.post("/api/push/native", json={"token": TOKEN}, cookies=cookie, headers={"Origin": "https://evil.io"})
        assert r.status_code == 403, r.status_code

    def native_registers_the_phone():
        r = client.post("/api/push/native", json={"token": "x"}, cookies=cookie, headers=origin)
        assert r.status_code == 400
        r = client.post("/api/push/native", cookies=cookie, headers=origin,
                        json={"token": TOKEN, "platform": "android", "endpoint": web_sub(1)["endpoint"]})
        assert r.status_code == 200, r.text
        assert fcm.device_count("393") == 1

    def huddle_rings_when_the_room_is_empty_not_on_every_join():
        rang: list[str] = []
        others = {"n": 0}

        async def fake_others(room, identity):
            return others["n"]

        real_route, real_others, key = server._notify.route_in_background, server._huddle_others, server.LIVEKIT_API_KEY
        server._notify.route_in_background = lambda cat, title, *a, **k: rang.append(title)
        server._huddle_others = fake_others
        server.LIVEKIT_API_KEY, secret = "k", server.LIVEKIT_API_SECRET
        server.LIVEKIT_API_SECRET = "s" * 32
        server._huddle_ring_guard._seen.clear()
        join = lambda room: client.post("/api/huddle/token", json={"room": room}, cookies=cookie, headers=origin)
        try:
            assert join("ringtest").status_code == 200 and len(rang) == 1, rang  # first in: ring
            others["n"] = 1
            join("ringtest")                     # someone's already in there: no ring
            assert len(rang) == 1, rang
            others["n"] = 0
            join("ringtest")                     # everyone left and came straight back: a reconnect
            assert len(rang) == 1, rang
            server._huddle_ring_guard._seen["ringtest"] -= 200
            join("ringtest")                     # the room emptied, a new Huddle a few minutes later
            assert len(rang) == 2, rang
            others["n"] = None                   # LiveKit down: the old 30-minute rule
            join("ringtest")
            assert len(rang) == 2, rang
        finally:
            server._notify.route_in_background, server._huddle_others = real_route, real_others
            server.LIVEKIT_API_KEY, server.LIVEKIT_API_SECRET = key, secret

    for fn in (asset_links_are_public, native_needs_a_session_and_same_origin, native_registers_the_phone,
               huddle_rings_when_the_room_is_empty_not_on_every_join):
        check(fn.__name__, fn)


if __name__ == "__main__":
    store_tests()
    ring_tests()
    route_tests()
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
