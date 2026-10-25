#!/usr/bin/env python3
"""Shared soundboard (audio_sounds.py): board order, adding clips, and the
stream deck's soundboard.yaml only ever losing the slots this page owns.

Plain asserts, no pytest. The Pi is faked: no SSH leaves the test.

    tests/run-all.sh test_audio_board
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-audio-board")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_sounds as a  # noqa: E402

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


class FakePi:
    """Stands in for `ssh psaudio …`: sounds / receive_sound / delete_sound / play."""

    def __init__(self, names):
        self.names = list(names)
        self.received: dict[str, bytes] = {}

    def __call__(self, args, stdin=None):
        cmd = args[0]
        out, rc = b"", 0
        if cmd == "sounds":
            out = ("Available sounds:\n" + "\n".join(self.names) + "\n").encode()
        elif cmd == "receive_sound":
            self.names.append(args[1])
            self.received[args[1]] = stdin or b""
        elif cmd == "delete_sound":
            self.names = [n for n in self.names if n != args[1]]
        return subprocess.CompletedProcess(args, rc, out, b"")


def tone(seconds=1.0) -> bytes:
    """A real MP3, so the ffmpeg conversion path is exercised."""
    with tempfile.TemporaryDirectory() as t:
        p = Path(t) / "t.mp3"
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                        str(p)], capture_output=True, check=True)
        return p.read_bytes()


SOUNDBOARD_YAML = """name: soundboard

keys:
  "0":
    icon: icons/my-custom.gif
    action: ssh -i /home/opti3/.ssh/id_ed25519_aicontroller -o ConnectTimeout=5 -o StrictHostKeyChecking=no psaudio@192.168.5.151 "play coin"
    dm: {i: soundboard, a: play, p: {sound: coin}}
  "1":
    icon: icons/sb_alert.png
    action: ssh -i /home/opti3/.ssh/id_ed25519_aicontroller -o ConnectTimeout=5 -o StrictHostKeyChecking=no psaudio@192.168.5.151 "play alert"
  "9":
    icon: icons/custom_home.png
    action: ragnarosctl profile macbook

knobs:
  "0":
    rotate:
      cw: /home/opti3/.config/ragnaros/sb_vol.sh up 5
      ccw: /home/opti3/.config/ragnaros/sb_vol.sh down 5
    press: /home/opti3/.config/ragnaros/sb_vol.sh get
strip:
  gif: gifs/sb_vol_strip.png
  idle: [gifs]
"""


def main():
    tmp = Path(tempfile.mkdtemp())
    a.AUDIO_DIR, a.ICONS_DIR, a.PROFILES_DIR = tmp / "audio", tmp / "icons", tmp / "profiles"
    a.DECK_FILE, a.BOARD_FILE = tmp / "deck.json", tmp / "board.json"
    a._ensure_dirs()
    pi = FakePi(["coin", "alert", "vid-1", "airhorn"])
    a._ssh = pi

    def lists_pi_clips_without_builtins():
        b = a.board(fresh=True)
        names = [s["name"] for s in b["sounds"]]
        assert names == ["airhorn", "vid-1"], names     # no order yet: alphabetical
        assert "coin" in b["builtins"] and "coin" not in names
        assert b["sounds"][1]["label"] == "vid 1"
    check("board = the Pi's clips, builtins apart", lists_pi_clips_without_builtins)

    def add_converts_and_appends():
        r = a.add_sound(tone(), name="Bruh Moment!!", label="Bruh", source="link", by="Moiz", url="https://x/y.mp3")
        assert r["name"] == "bruh-moment", r
        wav = pi.received["bruh-moment"]
        assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE", wav[:12]
        b = a.board(fresh=True)
        last = b["sounds"][-1]
        assert last["name"] == "bruh-moment" and last["label"] == "Bruh" and last["by"] == "Moiz", last
        assert last["source"] == "link"
    check("adding converts to WAV, uploads, goes last with attribution", add_converts_and_appends)

    def names_stay_unique():
        r = a.add_sound(tone(0.5), name="airhorn", by="X")
        assert r["name"] == "airhorn-2", r
        r = a.add_sound(tone(0.5), name="coin", by="X")   # builtin name is taken too
        assert r["name"] == "coin-2", r
    check("a clip never overwrites another (or a builtin)", names_stay_unique)

    def rejects_non_audio():
        try:
            a.add_sound(b"definitely not audio" * 100, name="junk")
        except ValueError:
            return
        raise AssertionError("garbage was accepted")
    check("non-audio is refused", rejects_non_audio)

    def reorder_and_rename():
        names = [s["name"] for s in a.board(fresh=True)["sounds"]]
        a.reorder(list(reversed(names)) + ["../etc/passwd", "ghost"])
        got = [s["name"] for s in a.board(fresh=True)["sounds"]]
        assert got == list(reversed(names)), got
        a.rename("vid-1", "  Victory Royale ")
        assert next(s for s in a.board()["sounds"] if s["name"] == "vid-1")["label"] == "Victory Royale"
        a.rename("vid-1", "")
        assert next(s for s in a.board()["sounds"] if s["name"] == "vid-1")["label"] == "vid 1"
    check("reorder keeps only real clips; rename and un-rename", reorder_and_rename)

    def new_pi_clips_join_the_end():
        pi.names.append("from-deck-manager")
        got = [s["name"] for s in a.board(fresh=True)["sounds"]]
        assert got[-1] == "from-deck-manager", got
    check("a clip added elsewhere (Deck Manager) joins the end", new_pi_clips_join_the_end)

    def delete_forgets():
        a.delete_sound("bruh-moment")
        got = [s["name"] for s in a.board(fresh=True)["sounds"]]
        assert "bruh-moment" not in got
        assert "bruh-moment" not in json.loads(a.BOARD_FILE.read_text())["order"]
    check("removing a clip removes it from the Pi and the board", delete_forgets)

    def deck_yaml_is_lossless():
        prof = a.PROFILES_DIR / "soundboard.yaml"
        prof.write_text(SOUNDBOARD_YAML)
        slots = {str(i): None for i in range(9)}
        slots["0"] = {"type": "builtin", "name": "coin"}       # unchanged: keeps custom icon + dm
        slots["1"] = {"type": "builtin", "name": "combo"}      # changed
        a.set_deck(slots)
        text = prof.read_text()
        assert "icons/my-custom.gif" in text and "dm: {i: soundboard" in text, text
        assert '"play combo"' in text and '"play alert"' not in text, text
        assert "sb_vol.sh up 5" in text and "mac_vol.sh" not in text, "knobs were replaced"
        assert "gif: gifs/sb_vol_strip.png" in text, "strip was dropped"
        assert "icons/custom_home.png" in text, "key 9 was replaced"
        assert not (a.PROFILES_DIR / ".soundboard.yaml.tmp").exists()
    check("deck assignment rewrites only keys 0-8 of soundboard.yaml", deck_yaml_is_lossless)

    def deck_yaml_from_nothing():
        (a.PROFILES_DIR / "soundboard.yaml").unlink()
        a.set_deck({"0": {"type": "builtin", "name": "coin"}})
        text = (a.PROFILES_DIR / "soundboard.yaml").read_text()
        assert text.startswith("name: soundboard") and '"play coin"' in text and "knobs:" in text, text
    check("a missing soundboard.yaml is created whole", deck_yaml_from_nothing)

    if os.environ.get("AUDIO_BOARD_HTTP", "1") == "1":
        try:
            import fastapi  # noqa: F401  (only in the app image)
        except ImportError:
            print("  · http tests skipped (run inside crcmz-app:test)")
        else:
            http_tests(tone)

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    return 0


def http_tests(tone):
    from fastapi.testclient import TestClient
    import server

    client = TestClient(server.app, base_url="https://app.crcmz.me")
    origin = {"Origin": "https://app.crcmz.me"}

    def login():
        client.cookies.clear()
        client.cookies.set(server._SESSION_COOKIE, server._signer().dumps(
            {"sub": "u1", "iss": "https://auth.crcmz.me", "name": "Tester"}))

    def needs_a_session():
        client.cookies.clear()
        assert client.get("/api/audio-sounds", headers={"Accept": "application/json"}).status_code == 401
        assert client.put("/api/audio-sounds/order", json={"order": []}, headers=origin).status_code == 401
    check("http: the board needs a session", needs_a_session)

    def upload_reorder_rename_delete():
        login()
        r = client.post("/api/audio-sounds/upload", headers=origin,
                        files={"file": ("my clip.mp3", tone(), "audio/mpeg")}, data={"label": "Air Horn", "source": "record"})
        assert r.status_code == 200, r.text
        name = r.json()["name"]
        assert name == "air-horn", name
        board = client.get("/api/audio-sounds").json()
        mine = next(s for s in board["sounds"] if s["name"] == name)
        assert mine["by"] == "Tester" and mine["source"] == "record" and mine["label"] == "Air Horn", mine
        order = [s["name"] for s in board["sounds"]]
        r = client.put("/api/audio-sounds/order", json={"order": [name] + [n for n in order if n != name]}, headers=origin)
        assert r.status_code == 200 and r.json()["sounds"][0]["name"] == name, r.text
        r = client.patch(f"/api/audio-sounds/{name}", json={"label": "Horn"}, headers=origin)
        assert r.status_code == 200, r.text
        assert client.get("/api/audio-sounds").json()["sounds"][0]["label"] == "Horn"
        assert client.delete(f"/api/audio-sounds/{name}", headers=origin).status_code == 200
        assert name not in [s["name"] for s in client.get("/api/audio-sounds").json()["sounds"]]
    check("http: upload → reorder → rename → delete", upload_reorder_rename_delete)

    def junk_upload_is_400():
        login()
        r = client.post("/api/audio-sounds/upload", headers=origin, files={"file": ("x.mp3", b"nope" * 300, "audio/mpeg")})
        assert r.status_code == 400, r.text
    check("http: a non-audio upload is a 400", junk_upload_is_400)

    def link_refuses_private_addresses():
        login()
        for url in ("http://127.0.0.1:8000/x.mp3", "http://192.168.5.151/a.mp3", "file:///etc/passwd", "nonsense"):
            r = client.post("/api/audio-sounds/link", json={"url": url}, headers=origin)
            assert r.status_code == 400, (url, r.status_code, r.text)
    check("http: links can't reach our own network", link_refuses_private_addresses)



if __name__ == "__main__":
    sys.exit(main())
