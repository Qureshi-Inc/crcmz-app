#!/usr/bin/env python3
"""iOS app notifications and rings (apns.py) and how notifications.route uses them.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_apns

Nothing leaves the box: apns.send, fcm._send_one and webpush._send_one are fakes.
"""

import base64
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-apns-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import jwt  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402

import apns  # noqa: E402
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

# A throwaway EC key stands in for the "crcmz push" .p8.
KEY = ec.generate_private_key(ec.SECP256R1())
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption()).decode()
os.environ["APNS_KEY_B64"] = base64.b64encode(PEM.encode()).decode()

FAILED: list[str] = []
PASSED = 0
SENT: list[dict] = []
STATUS = {"default": (200, "")}
IOS, VOIP, DROID = "a" * 64, "b" * 64, "c" * 40


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


def fake_send(device, payload, *, voip=False, collapse="", ttl=0):
    SENT.append({"device": device, "payload": payload, "voip": voip, "collapse": collapse, "ttl": ttl})
    return STATUS.get(device, STATUS["default"])


apns.send = fake_send
fcm._credentials = lambda: {"project_id": "p", "client_email": "x@y", "token_uri": "https://t", "private_key": "k"}
FCM_SENT: list[str] = []
fcm._send_one = lambda creds, token, data: (FCM_SENT.append(token), (200, ""))[1]
webpush._send_one = lambda sub, payload, ttl, urgency: 201


def reset():
    SENT.clear()
    FCM_SENT.clear()
    STATUS.clear()
    STATUS["default"] = (200, "")
    with fcm._conn() as db:
        db.execute("DELETE FROM devices")
    fcm.register("u-moiz", IOS, "ios")
    fcm.register("u-moiz", VOIP, "ios-voip")
    fcm.register("u-noor", DROID, "android")


def tests():
    print("iPhones")

    def both_iphone_tokens_register_and_junk_is_refused():
        reset()
        with fcm._conn() as db:
            got = sorted((r["platform"], r["sub"]) for r in db.execute("SELECT * FROM devices"))
        assert got == [("android", "u-noor"), ("ios", "u-moiz"), ("ios-voip", "u-moiz")], got
        assert fcm.register("u-moiz", IOS, "windows") == {"error": "unknown platform"}

    def a_mention_is_an_iphone_notification_that_opens_the_page():
        reset()
        notifications.route("mentions", "Zubair mentioned you on Slap", "“banger”", "/app/slap?track=x",
                            only=["u-moiz"], dms=False)
        assert len(SENT) == 1 and not SENT[0]["voip"] and SENT[0]["device"] == IOS, SENT
        p = SENT[0]["payload"]
        assert p["aps"]["alert"] == {"title": "Zubair mentioned you on Slap", "body": "“banger”"}
        assert p["url"] == "/app/slap?track=x" and p["aps"]["sound"] == "default"
        assert FCM_SENT == [], "Android doesn't ring for a mention"

    def a_party_rings_iphones_on_the_call_screen_and_not_also_as_a_banner():
        reset()
        out = notifications.route("watch", "📞 Moiz is calling you to the Watch Party", "Tap to join.",
                                  "/app/watch/party", exclude="u-zub", tag="watch-ring", caller="Moiz")
        voip = [s for s in SENT if s["voip"]]
        assert len(voip) == 1 and voip[0]["device"] == VOIP and voip[0]["ttl"] == apns.RING_S, SENT
        assert voip[0]["payload"]["type"] == "ring" and voip[0]["payload"]["caller"] == "Moiz"
        assert voip[0]["payload"]["url"] == "/app/watch/party"
        assert not [s for s in SENT if not s["voip"]], "rung: no second buzz"
        assert FCM_SENT == [DROID], "Android still rings through Firebase"
        assert out["ring_ios"]["delivered"] == 1

    def someone_who_switched_the_category_off_gets_nothing():
        reset()
        webpush.save_prefs("u-moiz", {"watch": False})
        try:
            notifications.route("watch", "📺 Watch Party: Dune", "Tap to join.", "/app/watch/party")
            assert SENT == [], SENT
        finally:
            webpush.save_prefs("u-moiz", {"watch": True})

    def a_deleted_app_is_forgotten():
        reset()
        STATUS[IOS] = (410, "Unregistered")
        notifications.route("mentions", "hi", "", "/app", only=["u-moiz"], dms=False)
        with fcm._conn() as db:
            left = [r["platform"] for r in db.execute("SELECT * FROM devices WHERE sub='u-moiz'")]
        assert left == ["ios-voip"], left

    def outside_links_never_ride_along():
        reset()
        apns.alert("mentions", "x", "", "https://evil.example/phish", only=["u-moiz"])
        assert SENT[-1]["payload"]["url"] == "/app"

    def the_provider_token_is_es256_from_the_crcmz_push_key():
        apns._jwt = ("", 0.0)
        tok = apns._token()
        h = jwt.get_unverified_header(tok)
        assert h["alg"] == "ES256" and h["kid"] == "6J4DUKY9AR"
        claims = jwt.decode(tok, KEY.public_key(), algorithms=["ES256"])
        assert claims["iss"] == "CF6R3NUAP7"
        assert apns._token() == tok, "reused, not minted per push"

    def no_key_means_no_iphone_pushes_and_nothing_breaks():
        reset()
        saved = os.environ.pop("APNS_KEY_B64")
        try:
            out = notifications.route("mentions", "hi", "", "/app", only=["u-moiz"], dms=False)
            assert SENT == [] and out["ios"]["delivered"] == 0
        finally:
            os.environ["APNS_KEY_B64"] = saved

    for fn in (both_iphone_tokens_register_and_junk_is_refused, a_mention_is_an_iphone_notification_that_opens_the_page,
               a_party_rings_iphones_on_the_call_screen_and_not_also_as_a_banner,
               someone_who_switched_the_category_off_gets_nothing, a_deleted_app_is_forgotten,
               outside_links_never_ride_along, the_provider_token_is_es256_from_the_crcmz_push_key,
               no_key_means_no_iphone_pushes_and_nothing_breaks):
        check(fn.__name__, fn)


if __name__ == "__main__":
    tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
