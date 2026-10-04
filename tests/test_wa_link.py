#!/usr/bin/env python3
"""Settings → WhatsApp: linking a WhatsApp name with a one-time code (wa_link.py).

Plain asserts, no pytest. Zitadel is stubbed: nothing here writes a real tag.

    docker run --rm -e SESSION_SECRET=t -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_wa_link.py
"""

import os
import sys
import tempfile
import time

os.environ.setdefault("SESSION_SECRET", "test-secret-for-wa-link")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ["WA_LINK_DB"] = os.path.join(tempfile.mkdtemp(), "wa_link.db")
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


import crcmz_identity  # noqa: E402
import wa_link  # noqa: E402

PEOPLE = {
    "111": {"zitadel_id": "111", "display_name": "Interesting Soup", "username": "soup", "wa_names": ["Moiz"]},
    "222": {"zitadel_id": "222", "display_name": "Mazino", "username": "mazino", "wa_names": []},
}
WRITES: list[tuple] = []


def fake_set(sub, key, value):
    assert key == "wa_names"
    WRITES.append((sub, value))
    PEOPLE[sub]["wa_names"] = [v.strip() for v in value.split(",") if v.strip()]
    return True


def fake_clear(sub, key):
    WRITES.append((sub, ""))
    PEOPLE[sub]["wa_names"] = []
    return True


crcmz_identity.by_zitadel_id = lambda refresh=False: dict(PEOPLE)
crcmz_identity.people = lambda refresh=False: list(PEOPLE.values())
crcmz_identity.set_tag = fake_set
crcmz_identity.clear_tag = fake_clear


def code_of(sub):
    return wa_link.status(sub)["code"]


def t_settings_gives_a_message_with_a_code_and_keeps_it():
    s = wa_link.status("222")
    assert s["names"] == [] and s["code"].startswith("CRCMZ-") and len(s["code"]) == 12
    assert s["message"] == f"@{wa_link.BOT_NAME} link my WhatsApp, I'm Mazino: {s['code']}", s["message"]
    assert wa_link.status("222")["code"] == s["code"], "the same code until it's used"
    assert 0 < s["expires_in"] <= wa_link.CODE_TTL_S


def t_sending_the_code_links_the_senders_name_once():
    WRITES.clear()
    code = code_of("222")
    reply = wa_link.link_from_message(f"@CRCMZ_BOT link my WhatsApp, I'm Mazino: {code.lower()}", "Mazino 🔥")
    assert reply.startswith("✅") and "Mazino 🔥" in reply, reply
    assert WRITES == [("222", "Mazino 🔥")] and PEOPLE["222"]["wa_names"] == ["Mazino 🔥"]
    again = wa_link.link_from_message(f"link {code}", "Someone Else")
    assert "isn't valid" in again and len(WRITES) == 1, "a code works once"
    assert wa_link.status("222")["code"] != code, "a fresh code after one is used"


def t_a_second_name_is_added_not_replaced():
    WRITES.clear()
    wa_link.link_from_message(code_of("111"), "Soup Phone")
    assert PEOPLE["111"]["wa_names"] == ["Moiz", "Soup Phone"], PEOPLE["111"]


def t_someone_elses_name_is_refused():
    WRITES.clear()
    reply = wa_link.link_from_message(code_of("222"), "moiz")
    assert "another CRCMZ account" in reply and not WRITES


def t_old_codes_and_no_name_and_no_code():
    code = code_of("222")
    with wa_link._conn() as db:
        db.execute("UPDATE codes SET created = ?", (time.time() - wa_link.CODE_TTL_S - 5,))
    assert "isn't valid" in wa_link.link_from_message(code, "Mazino Two")
    assert "WhatsApp name" in wa_link.link_from_message(code_of("222"), "15551234567")
    assert wa_link.link_from_message("@CRCMZ_BOT what's up", "Mazino") is None
    assert wa_link.link_from_message("CRCMZ-ABC", "Mazino") is None, "not a code"


def t_unlink_takes_one_name_off():
    WRITES.clear()
    assert wa_link.unlink("111", "soup phone")["names"] == ["Moiz"]
    assert wa_link.unlink("111", "nobody")["names"] == ["Moiz"] and len(WRITES) == 1
    assert wa_link.unlink("111", "Moiz")["names"] == [] and WRITES[-1] == ("111", "")


def t_the_app_may_write_wa_names():
    assert "wa_names" in crcmz_identity._APP_TAGS


def http_tests():
    from fastapi.testclient import TestClient
    import server
    import wa_ai
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    HDR = {"Origin": "https://app.crcmz.me", "Content-Type": "application/json"}

    def t_settings_routes_need_a_session_and_work():
        assert client.get("/api/settings/whatsapp").status_code == 401
        client.cookies.set(server._SESSION_COOKIE, server._signer().dumps({"sub": "222", "iss": "x"}))
        try:
            r = client.get("/api/settings/whatsapp")
            assert r.status_code == 200 and r.json()["message"].endswith(r.json()["code"]), r.text
            r = client.post("/api/settings/whatsapp/unlink", json={"name": "Mazino 🔥"}, headers=HDR)
            assert r.status_code == 200 and "Mazino 🔥" not in r.json()["names"], r.text
        finally:
            client.cookies.clear()

    def t_a_link_message_links_and_is_not_asked_of_the_ai():
        old = (server.WA_INGEST_SECRET, server.WA_AI_ENABLED, server.WA_BRIDGE_URL, wa_ai.trigger_from)
        asked = []
        server.WA_INGEST_SECRET, server.WA_AI_ENABLED, server.WA_BRIDGE_URL = "s" * 20, True, ""
        wa_ai.trigger_from = lambda *a, **k: asked.append(a) or None
        try:
            code = code_of("222")
            msg = {"group_jid": "1203@g.us", "sender_jid": "99@lid", "sender_name": "Mazino", "message_id": "m1",
                   "text": f"@CRCMZ_BOT link my WhatsApp, I'm Mazino: {code}", "timestamp": int(time.time())}
            r = client.post("/api/whatsapp/ingest", json=msg, headers={"x-ingest-secret": "s" * 20})
            assert r.status_code == 200, r.text
            assert "Mazino" in PEOPLE["222"]["wa_names"] and not asked, (PEOPLE["222"], asked)
        finally:
            server.WA_INGEST_SECRET, server.WA_AI_ENABLED, server.WA_BRIDGE_URL, wa_ai.trigger_from = old

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check("http/" + name[2:], fn)


print("wa_link")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)
try:
    http_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"http_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not boot the app: {type(e).__name__}: {e}")
print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
