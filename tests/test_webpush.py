#!/usr/bin/env python3
"""Web Push (webpush.py) and the installable-app routes.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_webpush

No push service is ever called: webpush._send_one is replaced in every test that
fans out, so nothing leaves the box (the runner also uses --network none).
"""

import asyncio
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-push-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import webpush  # noqa: E402

TMP = Path(tempfile.mkdtemp())
webpush._DB_PATH = TMP / "push.db"
webpush._KEY_PATH = TMP / "vapid_private.pem"
webpush.init()

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


def sub_json(n: int, host: str = "fcm.googleapis.com") -> dict:
    return {"endpoint": f"https://{host}/fcm/send/device-{n}",
            "keys": {"p256dh": "B" + "x" * 86, "auth": "a" * 22}}


def reset():
    with webpush._conn() as db:
        db.executescript("DELETE FROM subscriptions; DELETE FROM prefs; DELETE FROM sent;")


SENT: list[tuple[str, dict]] = []


def fake_send(status_for=lambda endpoint: 201):
    def send(row, payload, *, ttl, urgency):
        SENT.append((row["endpoint"], json.loads(payload)))
        return status_for(row["endpoint"])
    webpush._send_one = send
    SENT.clear()


# ── Store ────────────────────────────────────────────────────────────────────
def store_tests():
    print("store")

    def only_real_push_services():
        ok = ["https://web.push.apple.com/QGx", "https://fcm.googleapis.com/fcm/send/x",
              "https://updates.push.services.mozilla.com/wpush/v2/x",
              "https://wns2-par02p.notify.windows.com/w/?token=x"]
        bad = ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.io/x",
               "https://evil.io/fcm.googleapis.com", "https://127.0.0.1/x", "https://localhost/x",
               "https://fcm.googleapis.com:8443/x", "https://notify.windows.com.evil.io/x",
               "javascript:alert(1)", "", "https://jellyfin:8096/x"]
        assert all(webpush.endpoint_allowed(u) for u in ok), [u for u in ok if not webpush.endpoint_allowed(u)]
        assert not any(webpush.endpoint_allowed(u) for u in bad), [u for u in bad if webpush.endpoint_allowed(u)]

    def subscribe_validates():
        reset()
        assert "error" in webpush.subscribe("u1", sub_json(1, "evil.io"))
        assert "error" in webpush.subscribe("u1", {"endpoint": sub_json(1)["endpoint"], "keys": {}})
        assert "error" in webpush.subscribe("", sub_json(1))
        assert webpush.subscribe("u1", sub_json(1)) == {"ok": True, "devices": 1}

    def resubscribe_moves_the_device():
        reset()
        webpush.subscribe("u1", sub_json(1))
        webpush.subscribe("u2", sub_json(1))  # same phone, someone else signed in
        assert webpush.device_count("u1") == 0 and webpush.device_count("u2") == 1

    def replaces_drops_the_old_endpoint():
        reset()
        webpush.subscribe("u1", sub_json(1))
        webpush.subscribe("u1", sub_json(2), replaces=sub_json(1)["endpoint"])
        assert webpush.device_count("u1") == 1 and webpush.is_subscribed("u1", sub_json(2)["endpoint"])

    def replaces_cannot_drop_someone_elses():
        reset()
        webpush.subscribe("u2", sub_json(1))
        webpush.subscribe("u1", sub_json(2), replaces=sub_json(1)["endpoint"])
        assert webpush.device_count("u2") == 1

    def devices_are_capped():
        reset()
        for n in range(webpush._MAX_DEVICES + 4):
            webpush.subscribe("u1", sub_json(n))
        assert webpush.device_count("u1") == webpush._MAX_DEVICES

    def unsubscribe_only_own():
        reset()
        webpush.subscribe("u1", sub_json(1))
        assert webpush.unsubscribe("u2", sub_json(1)["endpoint"])["removed"] == 0
        assert webpush.unsubscribe("u1", sub_json(1)["endpoint"])["removed"] == 1

    def prefs_default_on_and_ignore_unknown():
        reset()
        assert webpush.get_prefs("u1") == {k: True for k in webpush.CATEGORIES}
        p = webpush.save_prefs("u1", {"clips": False, "bogus": False})
        assert p["clips"] is False and "bogus" not in p and p["squad"] is True
        assert webpush.get_prefs("u1")["clips"] is False

    def vapid_key_is_stable_and_private():
        k1, k2 = webpush.public_key(), webpush.public_key()
        assert k1 == k2 and len(k1) == 87 and k1.startswith("B"), (len(k1), k1[:2])
        assert stat.S_IMODE(webpush._KEY_PATH.stat().st_mode) == 0o600

    for fn in (only_real_push_services, subscribe_validates, resubscribe_moves_the_device,
               replaces_drops_the_old_endpoint, replaces_cannot_drop_someone_elses, devices_are_capped,
               unsubscribe_only_own, prefs_default_on_and_ignore_unknown, vapid_key_is_stable_and_private):
        check(fn.__name__, fn)


# ── Fan-out ──────────────────────────────────────────────────────────────────
def notify_tests():
    print("notify")

    def respects_prefs_and_exclude():
        reset()
        for n, s in enumerate(("actor", "fan", "muted")):
            webpush.subscribe(s, sub_json(n))
        webpush.save_prefs("muted", {"squad": False})
        fake_send()
        r = webpush.notify("squad", "Moiz: Squad Up", "who's on", "/app/squad", exclude="actor")
        assert r["recipients"] == 1 and r["delivered"] == 1, r
        assert [e for e, _ in SENT] == [sub_json(1)["endpoint"]]
        assert SENT[0][1] == {"title": "Moiz: Squad Up", "body": "who's on", "url": "/app/squad",
                              "tag": "squad", "category": "squad"}

    def dead_devices_are_dropped():
        reset()
        webpush.subscribe("u1", sub_json(1))
        webpush.subscribe("u1", sub_json(2))
        fake_send(lambda e: 410 if e.endswith("-2") else 201)
        r = webpush.notify("clips", "New clip")
        assert r == {"category": "clips", "recipients": 2, "delivered": 1, "gone": 1}, r
        assert webpush.device_count("u1") == 1

    def other_failures_keep_the_device():
        reset()
        webpush.subscribe("u1", sub_json(1))
        fake_send(lambda e: 500)
        webpush.notify("clips", "x")
        with webpush._conn() as db:
            assert db.execute("SELECT fails FROM subscriptions").fetchone()[0] == 1

    def only_limits_recipients_and_test_ignores_prefs():
        reset()
        webpush.subscribe("me", sub_json(1))
        webpush.subscribe("you", sub_json(2))
        for k in webpush.CATEGORIES:
            webpush.save_prefs("me", {k: False})
        fake_send()
        r = webpush.notify("test", "t", only=["me"])
        assert r["recipients"] == 1 and SENT[0][0] == sub_json(1)["endpoint"], r

    def urls_stay_inside_the_app():
        reset()
        webpush.subscribe("u1", sub_json(1))
        fake_send()
        webpush.notify("watch", "x", url="https://evil.io/")
        assert SENT[0][1]["url"] == "/app"

    def unknown_category_is_a_bug():
        try:
            webpush.notify("nope", "x")
        except ValueError:
            return
        raise AssertionError("no ValueError")

    def debounce_is_first_after_quiet():
        d = webpush.Debounce(60)
        assert d.first("r", 0) and not d.first("r", 30) and not d.first("r", 80) and d.first("r", 200)
        assert d.first("other", 200)

    def stats_never_show_endpoints():
        reset()
        webpush.subscribe("u1", sub_json(1))
        webpush.save_prefs("u1", {"clips": False})
        fake_send()
        webpush.notify("squad", "rally")
        st = webpush.stats()
        raw = json.dumps(st)
        assert "fcm.googleapis.com" not in raw and "x" * 40 not in raw, raw[:200]
        assert st["people_with_push"] == 1 and st["opted_in_by_category"]["clips"] == 0
        assert st["people"][0]["off"] == ["clips"] and st["recent"][0]["title"] == "rally"

    for fn in (respects_prefs_and_exclude, dead_devices_are_dropped, other_failures_keep_the_device,
               only_limits_recipients_and_test_ignores_prefs, urls_stay_inside_the_app,
               unknown_category_is_a_bug, debounce_is_first_after_quiet, stats_never_show_endpoints):
        check(fn.__name__, fn)


# ── Routes ───────────────────────────────────────────────────────────────────
def http_tests():
    from fastapi.testclient import TestClient
    import server
    import assistant

    print("routes")
    reset()
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    cookie = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("393", "f@b.co"))}
    origin = {"Origin": "https://app.crcmz.me"}
    dist = Path(server._APP_DIST)

    def pwa_files_are_public():
        if not (dist / "manifest.webmanifest").is_file():
            raise AssertionError("frontend/dist has no manifest: run npm run build first")
        r = client.get("/app/manifest.webmanifest")
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/manifest+json")
        m = r.json()
        assert m["start_url"] == "/app" and m["display"] == "standalone"
        assert any(i["purpose"] == "maskable" for i in m["icons"])
        for i in m["icons"]:
            assert client.get(i["src"]).status_code == 200, i["src"]
        r = client.get("/app/sw.js")
        assert r.status_code == 200 and r.headers.get("service-worker-allowed") == "/app/"
        assert "no-cache" in r.headers["cache-control"] and r.headers.get("cloudflare-cdn-cache-control") == "no-store"
        assert client.get("/app/pwa/apple-touch-icon.png").status_code == 200

    def pwa_icons_do_not_leak_other_files():
        assert client.get("/app/pwa/..%2Findex.html").status_code == 404
        assert client.get("/app/pwa/sw.js").status_code == 404
        assert client.get("/app/pwa/nope.png").status_code == 404

    def the_app_document_is_still_gated():
        r = client.get("/app", headers={"accept": "text/html"}, follow_redirects=False)
        assert r.status_code == 302 and "/auth/login" in r.headers["location"], r.status_code

    def push_api_needs_a_session():
        assert client.get("/api/push/config").status_code == 401
        assert client.post("/api/push/subscribe", json={}, headers=origin).status_code == 401

    def config_has_key_and_categories():
        r = client.get("/api/push/config", cookies=cookie)
        assert r.status_code == 200, r.text
        d = r.json()
        assert len(d["publicKey"]) == 87 and d["devices"] == 0
        assert [c["id"] for c in d["categories"]] == list(webpush.CATEGORIES)

    def subscribe_rejects_cross_origin_and_bad_endpoints():
        r = client.post("/api/push/subscribe", json={"subscription": sub_json(1)}, cookies=cookie,
                        headers={"Origin": "https://evil.io"})
        assert r.status_code == 403, r.status_code
        r = client.post("/api/push/subscribe", json={"subscription": sub_json(1, "10.0.0.5")},
                        cookies=cookie, headers=origin)
        assert r.status_code == 400, r.status_code

    def subscribe_prefs_test_unsubscribe():
        r = client.post("/api/push/subscribe", json={"subscription": sub_json(1)}, cookies=cookie, headers=origin)
        assert r.status_code == 200 and r.json()["devices"] == 1, r.text
        r = client.post("/api/push/prefs", json={"clips": False}, cookies=cookie, headers=origin)
        assert r.json()["prefs"]["clips"] is False
        webpush.subscribe("someone-else", sub_json(9))
        fake_send()
        r = client.post("/api/push/test", json={}, cookies=cookie, headers=origin)
        assert r.status_code == 200 and r.json()["delivered"] == 1, r.text
        assert [e for e, _ in SENT] == [sub_json(1)["endpoint"]], SENT
        r = client.post("/api/push/unsubscribe", json={"endpoint": sub_json(1)["endpoint"]}, cookies=cookie, headers=origin)
        assert r.json()["devices"] == 0

    def giveaway_reveal_push_does_not_name_the_winner():
        seen = []
        orig = server._notify.route_in_background
        server._notify.route_in_background = lambda *a, **k: seen.append((a, k))
        server._giveaway.get_giveaway = lambda gid: {"title": "October drop", "prize": "PS Plus"}
        try:
            asyncio.run(server._push_giveaway_won(7))
        finally:
            server._notify.route_in_background = orig
        (cat, title, body, url), kw = seen[0]
        assert cat == "giveaway" and url == "/app/giveaway" and "October drop" in title and "PS Plus" in body
        assert "won" not in title.lower(), title

    def assistant_tool_is_registered_and_safe():
        assert "push_notifications_log" in assistant.tool_names()
        out, ok = assistant.call_tool("push_notifications_log", {"limit": 5000})
        assert ok, out
        assert "fcm.googleapis.com" not in out

    for fn in (pwa_files_are_public, pwa_icons_do_not_leak_other_files, the_app_document_is_still_gated,
               push_api_needs_a_session, config_has_key_and_categories,
               subscribe_rejects_cross_origin_and_bad_endpoints, subscribe_prefs_test_unsubscribe,
               giveaway_reveal_push_does_not_name_the_winner, assistant_tool_is_registered_and_safe):
        check(fn.__name__, fn)


if __name__ == "__main__":
    store_tests()
    notify_tests()
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
