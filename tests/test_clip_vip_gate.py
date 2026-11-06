#!/usr/bin/env python3
"""PSN clips reach WhatsApp only from a VIP or founder member (server._wa_clip_allowed).

Someone who's only in the PSN group (no CRCMZ account) is kept off WhatsApp; the
bridge is a local HTTP server, so nothing is really sent. Plain asserts, no pytest:

  docker run --rm -e SESSION_SECRET=t -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_clip_vip_gate.py
"""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SENT: list[dict] = []


class Bridge(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._json({"status": "ok", "whatsapp": True})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SENT.append(body)
        self._json({"status": "sent", "messageId": f"WA{len(SENT)}"})


srv = HTTPServer(("127.0.0.1", 0), Bridge)
threading.Thread(target=srv.serve_forever, daemon=True).start()

TMP = Path(tempfile.mkdtemp(prefix="clip-vip-"))
os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ["WA_BRIDGE_URL"] = f"http://127.0.0.1:{srv.server_port}"
os.environ["WA_MAIN_JID"] = "120363334247249772@g.us"
os.environ["IG_POSTS_DB"] = str(TMP / "ig_posts.db")
os.environ["WA_REACTIONS_DB"] = str(TMP / "wa_reactions.db")
os.environ["MONTAGE_RECORDS_DB"] = str(TMP / "montage_records.db")

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


def _p(zid, psn, tags, founder=False):
    return {"zitadel_id": zid, "display_name": zid, "username": zid, "mm_username": "", "psn_id": psn,
            "wa_jid": "", "wa_phone": "", "wa_names": [], "tags": tags, "founder": founder}


PEOPLE = [
    _p("vip", "Kurokishi-Haruma", {"vip": "2026-10-01"}),
    _p("founder", "mutasif", {"founder": "true"}, founder=True),
    _p("member", "PlainMember", {}),
]
crcmz_identity.people = lambda refresh=False: PEOPLE
crcmz_identity.by_zitadel_id = lambda refresh=False: {p["zitadel_id"]: p for p in PEOPLE}

import server  # noqa: E402
import clips  # noqa: E402

assert server.WA_BRIDGE_URL.startswith("http://127.0.0.1"), "must never reach the real bridge"
print("\nclips: who reaches WhatsApp")


def t_vip_and_founder_clips_go_to_whatsapp():
    SENT.clear()
    assert server._send_to_wa("u-vip", b"x" * 2000, "Kurokishi-Haruma") == "WA1"
    assert server._send_to_wa("u-f", b"x" * 2000, "MUTASIF") == "WA2", "PSN ids match case-insensitively"
    assert [s["caption"] for s in SENT] == ["🎮 Kurokishi-Haruma", "🎮 MUTASIF"]


def t_non_member_is_kept_off_whatsapp():
    SENT.clear()
    assert server._send_to_wa("u-braden", b"x" * 2000, "IG_Juicy") is None
    assert SENT == [], SENT
    assert server._wa_clip_allowed("IG_Juicy") is False


def t_member_without_vip_is_kept_off_too():
    assert server._wa_clip_allowed("PlainMember") is False


def t_identity_down_fails_open():
    orig = crcmz_identity.people
    try:
        crcmz_identity.people = lambda refresh=False: []
        assert server._wa_clip_allowed("IG_Juicy") is True
        crcmz_identity.people = lambda refresh=False: (_ for _ in ()).throw(RuntimeError("zitadel"))
        assert server._wa_clip_allowed("IG_Juicy") is True
    finally:
        crcmz_identity.people = orig


def t_kept_off_clip_is_done_without_a_whatsapp_send_date():
    clips._DB_PATH = TMP / "clips.db"
    clips.init()
    assert clips.claim("u-braden", "ugc1", "g", "The Squad", "IG_Juicy", 0, "")
    clips.set_kept_off_whatsapp("u-braden")
    row = clips.get("u-braden")
    assert row["status"] in clips.TERMINAL, row["status"]
    assert row["whatsapp_delivered_at"] is None and row["wa_message_id"] is None, row


def t_worker_uses_the_kept_off_state():
    src = Path(server.__file__).read_text()
    assert "_clips.set_kept_off_whatsapp(uid)" in src
    i = src.index("_clips.set_kept_off_whatsapp(uid)")
    assert "_wa_clip_allowed(" in src[i - 200:i], "the worker decides with the same gate"


print("\nmontage: non-members' clips stay out")
import ig_posts  # noqa: E402
import month_montage  # noqa: E402
import wa_reactions  # noqa: E402

ig_posts.init(); wa_reactions.init(); month_montage.init()
WHEN = datetime(2026, 11, 3, 12, tzinfo=ZoneInfo("America/Los_Angeles")).timestamp()


def _clip(cid, sender, body="", elig=1, not_member=0):
    with sqlite3.connect(clips._DB_PATH) as db:
        db.execute("INSERT INTO clips (message_uid, ugc_id, psn_group_id, sender_online_id, psn_created_at,"
                   " discovered_at, status, archive_status, storage_key_original, sha256, body,"
                   " montage_eligible, sender_not_member, created_at, updated_at)"
                   " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (cid, "g-" + cid, "g", sender, WHEN, WHEN, "delivered", "archived", f"clips/{cid}.mp4",
                    "sha-" + cid, body, elig, not_member, WHEN, WHEN))


def _reasons():
    got = month_montage.evaluate("2026-11", vetoes=set(), fetch=False)["clips"]
    return {c["clip_id"]: {r["code"] for r in c["excluded_reasons"]} for c in got}


def t_montage_excludes_non_members_and_keeps_members():
    clips.init()
    _clip("m-vip", "Kurokishi-Haruma")
    _clip("m-founder", "mutasif")
    _clip("m-braden", "IG_Juicy")                      # sent before the rule: flags never set
    _clip("m-braden-new", "IG_Juicy", elig=0, not_member=1)
    _clip("m-rev", "mutasif", body="rev pls", elig=0)
    r = _reasons()
    assert r["m-vip"] == set() and r["m-founder"] == set(), r
    assert r["m-braden"] == {"not_member"}, r["m-braden"]
    assert r["m-braden-new"] == {"not_member"}, "never mislabelled as coaching"
    assert r["m-rev"] == {"rev_coaching"}, r["m-rev"]
    assert "not_member" in month_montage.HARD_REASONS


def t_kept_off_whatsapp_flags_it_for_psn_montage_too():
    clips.claim("u-later", "ugc9", "g", "The Squad", "IG_Juicy", 0, "")
    clips.set_kept_off_whatsapp("u-later")
    row = clips.get("u-later")
    assert row["montage_eligible"] == 0 and row["sender_not_member"] == 1, row


def t_becoming_a_vip_lets_their_clips_back_into_the_montage():
    PEOPLE.append(_p("braden", "IG_Juicy", {"vip": "2026-11-06"}))
    try:
        r = _reasons()
        assert r["m-braden"] == set() and r["m-braden-new"] == set(), r
        assert server._wa_clip_allowed("IG_Juicy") is True
    finally:
        PEOPLE.pop()


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
