#!/usr/bin/env python3
"""Soundboard store + the read API the assistant and MCP call.

Plain asserts, no pytest -- run inside the app image where the deps live:

    docker build -t crcmz-app:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_soundboard.py
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-soundboard")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crcmz_identity as ident  # noqa: E402
import soundboard as sb  # noqa: E402

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


def person(zid, name, username="", psn="", wa_names=()):
    return {"zitadel_id": zid, "display_name": name, "username": username or name,
            "email": "", "state": "", "mm_username": "", "psn_id": psn,
            "wa_jid": "", "wa_phone": "+15551234567", "wa_names": list(wa_names),
            "tags": {}}


ROSTER = [
    person("1001", "Interesting Soup", "moiz", "moiiz41510", ["MQ"]),
    person("1002", "ace killerx", "zubair221b", "killerx096", ["Zubair"]),
]


def main():
    tmp = Path(tempfile.mkdtemp(prefix="sb-test-"))
    sb.SHARED_FILE = tmp / "soundboard.json"
    sb.PERSONAL_FILE = tmp / "soundboard_personal.json"
    # Seed the identity cache instead of reaching for Zitadel; people() honours it.
    ident._cache["people"] = (time.time(), ROSTER)

    print("soundboard")

    def missing_files_are_empty():
        # A fresh deploy has no JSON at all; that must read as empty, not explode.
        assert sb.load_custom() == []
        assert sb.load_all_personal() == {}
        assert sb.shared() == sb.DEFAULTS
    check("missing files read as empty", missing_files_are_empty)

    def corrupt_file_is_empty():
        sb.SHARED_FILE.write_text("{ not json")
        assert sb.load_custom() == []
        sb.SHARED_FILE.unlink()
    check("corrupt file reads as empty", corrupt_file_is_empty)

    def round_trip_shared():
        sb.save_custom([{"label": "GG", "msg": "gg wp", "cls": "c1", "custom": True}])
        assert sb.load_custom()[0]["msg"] == "gg wp"
        assert len(sb.shared()) == len(sb.DEFAULTS) + 1
    check("shared board round-trips", round_trip_shared)

    def round_trip_personal():
        sb.save_personal("1001", [{"label": "Mine", "msg": "mine", "cls": "c2"}])
        mine = sb.load_personal("1001")
        assert len(mine) == 1 and mine[0]["mine"] is True, mine
        # Another person's board is separate, not shared.
        assert sb.load_personal("1002") == []
    check("personal boards are per-person", round_trip_personal)

    def empty_save_removes_key():
        sb.save_personal("1002", [{"label": "x", "msg": "x", "cls": "c1"}])
        sb.save_personal("1002", [])
        # Storing [] would leave a phantom owner row in overview().
        assert "1002" not in sb.load_all_personal()
    check("saving an empty board removes the key", empty_save_removes_key)

    def overview_shape():
        o = sb.overview()
        assert o["shared"]["builtin"] == len(sb.DEFAULTS)
        assert o["shared"]["custom"] == 1
        assert o["personal"]["boards"] == 1
        assert o["personal"]["owners"][0]["name"] == "Interesting Soup"
        assert o["personal"]["owners"][0]["known_person"] is True
    check("overview names board owners via the identity graph", overview_shape)

    def overview_hides_private_text():
        # The private button's text must not leak into a broad "what buttons
        # exist" answer; only its owner's name and a count.
        blob = json.dumps(sb.overview()["personal"])
        assert "mine" not in blob, blob
        assert "Mine" not in blob, blob
    check("overview does not include private button text", overview_hides_private_text)

    def orphan_board_kept():
        sb.save_personal("9999-deleted", [{"label": "ghost", "msg": "boo", "cls": "c1"}])
        owners = {o["zitadel_id"]: o for o in sb.overview()["personal"]["owners"]}
        ghost = owners["9999-deleted"]
        # Honest about a board whose owner is gone from Zitadel rather than hiding it.
        assert ghost["known_person"] is False and ghost["name"] == ""
        assert ghost["buttons"] == 1
        sb.save_personal("9999-deleted", [])
    check("a board with no matching person still shows up", orphan_board_kept)

    def person_buttons_resolves_any_id():
        for needle in ("Interesting Soup", "moiz", "moiiz41510", "MQ", "1001"):
            got = sb.person_buttons(needle)
            assert got["found"] is True, (needle, got)
            assert got["buttons"][0]["msg"] == "mine", (needle, got)
    check("person_buttons accepts name, username, psn id, wa name, sub",
          person_buttons_resolves_any_id)

    def person_buttons_unknown():
        got = sb.person_buttons("nobody at all")
        assert got["found"] is False and "reason" in got, got
    check("unknown person returns found=false, not a guess", person_buttons_unknown)

    def limits_clamped():
        # 300 buttons so the 200 ceiling actually bites.
        sb.save_custom([{"label": f"b{i}", "msg": f"m{i}", "cls": "c1"} for i in range(300)])
        assert len(sb.overview(limit=10000)["shared"]["buttons"]) == 200
        assert len(sb.overview(limit=3)["shared"]["buttons"]) == 3
        # 0 means "unset" here, same as every other limit in this repo, so it
        # falls back to the default rather than returning a single button.
        assert len(sb.overview(limit=0)["shared"]["buttons"]) == 40
        assert len(sb.overview(limit=-5)["shared"]["buttons"]) == 1
        sb.save_custom([{"label": "GG", "msg": "gg wp", "cls": "c1", "custom": True}])
    check("limit is clamped in both directions", limits_clamped)

    def describe_drops_unknown_keys():
        sb.save_personal("1001", [{"label": "L", "msg": "M", "cls": "c1",
                                   "secret_token": "leak-me"}])
        blob = json.dumps(sb.person_buttons("1001"))
        assert "leak-me" not in blob, blob
        assert "secret_token" not in blob, blob
    check("button projection is an allowlist", describe_drops_unknown_keys)

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
