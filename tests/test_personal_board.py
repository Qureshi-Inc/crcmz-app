#!/usr/bin/env python3
"""Personal chat board tests (swipe-left board on the dashboard).

Plain asserts, no pytest — run inside the app image where the deps live:

    docker build -t crcmz-app:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_personal_board.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-board-tests")
# The app refuses to import without these; nothing in these tests talks to PSN.
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

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


def http_tests():
    from fastapi.testclient import TestClient
    import roast_bot
    import server
    import soundboard

    tmp = Path(tempfile.mkdtemp(prefix="board-test-"))
    # Never touch the real /data, and never call Bedrock for the flavor text.
    # The paths live in `soundboard`, not `server` — server only wraps them, so
    # patching server attributes here would silently write to the real /data.
    soundboard.PERSONAL_FILE = tmp / "soundboard_personal.json"
    soundboard.SHARED_FILE = tmp / "soundboard.json"
    roast_bot.flavor_message = lambda raw: raw.strip() + " 🔥"

    # Nothing here talks to PSN: the mod account is a recorder, and sending as
    # the user must never happen from a board button.
    class _FakeMod:
        def __init__(self):
            self.sent = []

        def send_message(self, message):
            self.sent.append(message)
            return True

    mod = _FakeMod()
    server._squad_messenger = mod

    def _no_user_send(request, message):
        raise AssertionError("board buttons must send as crcmz-mod, not as the user")

    server._send_as_user = _no_user_send

    client = TestClient(server.app, base_url="https://app.crcmz.me")
    # Direct-IP / LAN hits (Stream Deck) skip the auth gate, so this is the one
    # way to reach the board endpoints with no session at all.
    lan = TestClient(server.app, base_url="http://10.0.0.7:8000")
    HDR = {"Origin": "https://app.crcmz.me", "Content-Type": "application/json"}
    COOKIE = server._SESSION_COOKIE

    def session_cookie(sub="zit-user-1"):
        return server._signer().dumps({"sub": sub, "iss": "https://auth.crcmz.me"})

    def as_user(sub):
        client.cookies.clear()
        client.cookies.set(COOKIE, session_cookie(sub))

    def add(text, sub="zit-user-1"):
        as_user(sub)
        r = client.post("/api/soundboard/personal",
                        json={"text": text, "send": False}, headers=HDR)
        assert r.status_code == 200, (r.status_code, r.text)
        return r.json()

    def t_sessionless_gets_empty_board():
        lan.cookies.clear()
        r = lan.get("/api/soundboard/personal")
        assert r.status_code == 200, r.status_code
        assert r.json() == {"buttons": [], "signed_in": False}, r.json()

    def t_sessionless_cannot_write():
        lan.cookies.clear()
        for path, body in (("/api/soundboard/personal", {"text": "hi"}),
                           ("/api/soundboard/personal/delete", {"text": "hi"}),
                           ("/api/soundboard/personal/order", {"labels": []})):
            r = lan.post(path, json=body)
            assert r.status_code == 401, (path, r.status_code)

    def t_anonymous_is_gated_on_the_public_host():
        client.cookies.clear()
        for path, body in (("/api/soundboard/personal", {"text": "hi"}),
                           ("/api/soundboard/personal/delete", {"text": "hi"}),
                           ("/api/soundboard/personal/order", {"labels": []})):
            r = client.post(path, json=body, headers=HDR)
            assert r.status_code == 401, (path, r.status_code)

    def t_add_then_read_back():
        d = add("water break")
        assert d["button"]["mine"] is True, d
        assert d["button"]["custom"] is True, d
        as_user("zit-user-1")
        got = client.get("/api/soundboard/personal").json()
        assert got["signed_in"] is True
        labels = [b["label"] for b in got["buttons"]]
        assert "water break 🔥" in labels, labels

    def t_new_button_fires_as_crcmz_mod():
        mod.sent.clear()
        as_user("zit-user-send")
        r = client.post("/api/soundboard/personal",
                        json={"text": "squad up", "send": True}, headers=HDR)
        assert r.status_code == 200, (r.status_code, r.text)
        assert r.json()["sent"] is True, r.json()
        assert mod.sent == ["squad up 🔥"], mod.sent

    def t_board_is_private_to_its_owner():
        add("only mine", sub="zit-user-A")
        as_user("zit-user-B")
        other = client.get("/api/soundboard/personal").json()["buttons"]
        assert not [b for b in other if "only mine" in b["label"]], other
        # ...and it never leaks into the shared squad board
        shared = client.get("/api/soundboard").json()["buttons"]
        assert not [b for b in shared if "only mine" in b["label"]], shared

    def t_owner_only_delete():
        add("delete me", sub="zit-user-C")
        as_user("zit-user-D")
        r = client.post("/api/soundboard/personal/delete",
                        json={"text": "delete me 🔥"}, headers=HDR)
        assert r.status_code == 200 and r.json()["removed"] == 0, r.json()
        as_user("zit-user-C")
        still = [b["label"] for b in client.get("/api/soundboard/personal").json()["buttons"]]
        assert "delete me 🔥" in still, still
        r = client.post("/api/soundboard/personal/delete",
                        json={"text": "delete me 🔥"}, headers=HDR)
        assert r.json()["removed"] == 1, r.json()
        after = [b["label"] for b in client.get("/api/soundboard/personal").json()["buttons"]]
        assert "delete me 🔥" not in after, after

    def t_order_persists_server_side():
        sub = "zit-user-order"
        for t in ("one", "two", "three"):
            add(t, sub=sub)
        as_user(sub)
        labels = [b["label"] for b in client.get("/api/soundboard/personal").json()["buttons"]]
        assert labels == ["one 🔥", "two 🔥", "three 🔥"], labels
        r = client.post("/api/soundboard/personal/order",
                        json={"labels": ["three 🔥", "one 🔥", "two 🔥"]}, headers=HDR)
        assert r.status_code == 200, r.text
        again = [b["label"] for b in client.get("/api/soundboard/personal").json()["buttons"]]
        assert again == ["three 🔥", "one 🔥", "two 🔥"], again

    def t_order_keeps_unknown_labels():
        # A button added on another device isn't in the posted order — keep it.
        sub = "zit-user-order2"
        for t in ("a", "b"):
            add(t, sub=sub)
        as_user(sub)
        client.post("/api/soundboard/personal/order",
                    json={"labels": ["b 🔥"]}, headers=HDR)
        labels = [b["label"] for b in client.get("/api/soundboard/personal").json()["buttons"]]
        assert labels == ["b 🔥", "a 🔥"], labels

    def t_board_full_is_rejected():
        sub = "zit-user-full"
        boards = json.loads(soundboard.PERSONAL_FILE.read_text())["boards"] \
            if soundboard.PERSONAL_FILE.exists() else {}
        boards[sub] = [{"label": f"b{i}", "msg": f"b{i}", "cls": "c1"}
                       for i in range(soundboard.PERSONAL_MAX)]
        soundboard.PERSONAL_FILE.write_text(json.dumps({"boards": boards}))
        as_user(sub)
        r = client.post("/api/soundboard/personal",
                        json={"text": "one too many", "send": False}, headers=HDR)
        assert r.status_code == 400, (r.status_code, r.text)
        assert "full" in r.text.lower(), r.text

    def t_empty_text_rejected():
        as_user("zit-user-1")
        r = client.post("/api/soundboard/personal",
                        json={"text": "   ", "send": False}, headers=HDR)
        assert r.status_code == 400, r.status_code

    def t_dashboard_inlines_the_personal_board():
        add("inline me", sub="zit-user-inline")
        as_user("zit-user-inline")
        r = client.get("/dashboard")
        assert r.status_code == 200, r.status_code
        # json.dumps escapes the emoji, so match the ASCII part of the label.
        assert "inline me" in r.text, "personal button should be in first paint"
        assert "const SIGNED_IN = true" in r.text, "SIGNED_IN placeholder unreplaced"
        assert "__PERSONAL__" not in r.text and "__SIGNED_IN__" not in r.text

    def t_dashboard_sessionless_has_empty_personal_board():
        lan.cookies.clear()
        r = lan.get("/dashboard")
        assert r.status_code == 200, r.status_code
        assert "const PERSONAL = []" in r.text, "board must be empty with no session"
        assert "const SIGNED_IN = false" in r.text

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check(name[2:], fn)


print("Personal chat board tests")
try:
    http_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"http_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not boot the app: {type(e).__name__}: {e}")

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
