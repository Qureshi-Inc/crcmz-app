#!/usr/bin/env python3
"""Admin → WhatsApp bot access (wa_blocks.py): the bot ignores a blocked member.

Plain asserts, no pytest. Zitadel and the bot's reply path are stubbed: nothing
here sends a WhatsApp message.

    docker run --rm -e SESSION_SECRET=t -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_wa_blocks.py
"""

import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

MAIN = "120363334247249772@g.us"
TMP = Path(tempfile.mkdtemp(prefix="wa-blocks-"))
os.environ.setdefault("SESSION_SECRET", "test-secret-for-wa-blocks")
os.environ.setdefault("WA_INGEST_SECRET", "test-ingest-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ["WA_MAIN_JID"] = MAIN
os.environ["WA_BLOCKS_DB"] = str(TMP / "wa_blocks.db")
os.environ["WA_AI_DATA_DIR"] = str(TMP)
os.environ.pop("WA_BRIDGE_URL", None)
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


def _p(zid, name, wa_jid="", wa_phone="", wa_names=(), tags=None):
    return {"zitadel_id": zid, "display_name": name, "username": name.lower(), "mm_username": "",
            "psn_id": "", "wa_jid": wa_jid, "wa_phone": wa_phone, "wa_names": list(wa_names),
            "tags": tags or {}, "founder": False}


SAMAD = "zid-samad"
PEOPLE = {
    SAMAD: _p(SAMAD, "Samad", "17865233277@s.whatsapp.net", "+17865233277", ["Abdul Samad", "AbdulSamad Bawany"]),
    "zid-zubi": _p("zid-zubi", "Zubi", wa_names=["Zubi"], tags={"wa_lids": "999000111@lid"}),
    "zid-admin": _p("zid-admin", "Moiz", wa_names=["Moiz"]),
}
crcmz_identity.people = lambda refresh=False: list(PEOPLE.values())
crcmz_identity.by_zitadel_id = lambda refresh=False: dict(PEOPLE)

import whatsapp_analytics as wa  # noqa: E402

wa._DB_PATH = TMP / "whatsapp.db"
wa.init()


def _store(sender_jid, sender_name, from_me=0, group=MAIN):
    with sqlite3.connect(wa._DB_PATH) as db:
        db.execute("INSERT INTO whatsapp_messages (id, message_id, group_jid, sender_jid, sender_name, "
                   "timestamp, text, from_me, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (f"r{time.time_ns()}", "", group, sender_jid, sender_name, 1, "hi", from_me, "baileys", 1))


_store("212777109086321@lid", "AbdulSamad Bawany")      # his group id, only known from history
_store("999000111@lid", "Zubi")
_store(MAIN, "AbdulSamad Bawany", from_me=1)             # a bot row: carries the group JID
_store("555@lid", "Abdul Samad")                          # ...but not the bot's: still his name

import wa_blocks  # noqa: E402

wa_blocks.init()

print("\nwa_blocks: who the bot ignores")


def t_nothing_blocked_never_touches_identity():
    orig = crcmz_identity.identify_jid
    crcmz_identity.identify_jid = lambda *a, **k: (_ for _ in ()).throw(AssertionError("looked up"))
    try:
        assert wa_blocks.is_blocked("212777109086321@lid", "AbdulSamad Bawany") is False
    finally:
        crcmz_identity.identify_jid = orig


def t_block_collects_phone_and_history_lids():
    e = wa_blocks.block(SAMAD, by="zid-admin")
    assert e["zitadel_id"] == SAMAD and e["name"] == "Samad" and e["blocked_by"] == "zid-admin", e
    with sqlite3.connect(os.environ["WA_BLOCKS_DB"]) as db:
        ids = {r[0] for r in db.execute("SELECT wa_id FROM block_ids WHERE sub=?", (SAMAD,))}
    assert ids == {"17865233277", "212777109086321", "555"}, ids
    assert "120363334247249772" not in ids, "never the group JID from a bot row"
    assert e["whatsapp_ids"] == 3


def t_blocked_by_lid_and_by_phone():
    assert wa_blocks.is_blocked("212777109086321@lid", "") is True
    assert wa_blocks.is_blocked("17865233277:4@s.whatsapp.net", "whoever") is True


def t_everyone_else_still_gets_the_bot():
    assert wa_blocks.is_blocked("999000111@lid", "Zubi") is False
    assert wa_blocks.is_blocked("424242@lid", "Someone New") is False


def t_new_id_under_his_name_is_learned_so_renaming_doesnt_help():
    assert wa_blocks.is_blocked("777888@lid", "Abdul Samad") is True
    assert wa_blocks.is_blocked("777888@lid", "Totally Not Samad") is True


def t_someone_else_taking_his_name_is_not_blocked():
    # Zubi's id is Zubi's in the graph: the id wins over a lookalike name.
    assert wa_blocks.is_blocked("999000111@lid", "Abdul Samad") is False


def t_listing():
    rows = wa_blocks.list_blocks()
    assert [r["zitadel_id"] for r in rows] == [SAMAD], rows
    assert set(rows[0]) == {"zitadel_id", "name", "blocked_by", "created", "whatsapp_ids"}


def t_bad_blocks_refused():
    for sub, by in (("zid-nobody", "zid-admin"), ("zid-admin", "zid-admin")):
        try:
            wa_blocks.block(sub, by=by)
        except ValueError:
            continue
        raise AssertionError(f"blocked {sub}")


def t_unblock_drops_every_id():
    assert wa_blocks.unblock(SAMAD) is True
    for jid in ("212777109086321@lid", "17865233277@s.whatsapp.net", "777888@lid"):
        assert wa_blocks.is_blocked(jid, "Abdul Samad") is False, jid
    assert wa_blocks.unblock(SAMAD) is False


def t_broken_store_fails_open():
    wa_blocks.block(SAMAD, by="zid-admin")
    orig = wa_blocks._blocked_subs
    wa_blocks._blocked_subs = lambda: (_ for _ in ()).throw(sqlite3.OperationalError("disk"))
    try:
        assert wa_blocks.is_blocked("212777109086321@lid", "") is False
    finally:
        wa_blocks._blocked_subs = orig
    wa_blocks.unblock(SAMAD)


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)
        del globals()[name]


# ── HTTP: the ingest gate and the admin endpoints ──────────────────────────────
from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402

assert server._wa_blocks is wa_blocks
ADMINS = {"zid-admin"}


async def _fake_admin(uid):
    return uid in ADMINS


server._is_iam_admin = _fake_admin
server._peer_is_local = lambda request: True


def _client(sub=None, host="https://app.crcmz.me"):
    c = TestClient(server.app, base_url=host)
    if sub:
        c.cookies.set(server._SESSION_COOKIE, server._signer().dumps({"sub": sub, "email": ""}))
    return c


BRIDGE = _client(host="http://testserver")
ADMIN = _client("zid-admin")
MEMBER = _client("zid-zubi")
HDR = {"x-ingest-secret": os.environ["WA_INGEST_SECRET"]}

print("\nhttp: admin endpoints and the ingest gate")


def _asked_for(msgs):
    asked = []
    orig = server._answer_whatsapp
    server._answer_whatsapp = lambda *a, **k: asked.append(a)
    try:
        for m in msgs:
            r = BRIDGE.post("/api/whatsapp/ingest", headers=HDR, json=m)
            assert r.status_code == 200, r.text
        time.sleep(0.5)
    finally:
        server._answer_whatsapp = orig
    return [a[1] for a in asked]


def _live(mid, jid, name, text):
    return {"message_id": mid, "sender_name": name, "sender_jid": jid, "group_jid": MAIN,
            "timestamp": int(time.time()), "text": text, "type": "text"}


def t_admin_endpoints_are_admin_only():
    assert _client().get("/api/admin/wa-blocks").status_code == 401
    assert MEMBER.get("/api/admin/wa-blocks").status_code == 403
    assert MEMBER.post(f"/api/admin/wa-blocks/{SAMAD}").status_code == 403
    assert MEMBER.delete(f"/api/admin/wa-blocks/{SAMAD}").status_code == 403
    assert wa_blocks.list_blocks() == []


def t_admin_blocks_and_the_bot_ignores_only_him():
    r = ADMIN.post(f"/api/admin/wa-blocks/{SAMAD}")
    assert r.status_code == 200 and r.json()["block"]["whatsapp_ids"] >= 2, r.text
    assert [b["zitadel_id"] for b in ADMIN.get("/api/admin/wa-blocks").json()["blocks"]] == [SAMAD]
    before = sqlite3.connect(wa._DB_PATH).execute("SELECT COUNT(*) FROM whatsapp_messages").fetchone()[0]
    asked = _asked_for([_live("B-1", "212777109086321@lid", "AbdulSamad Bawany", "ai who's the goat"),
                        _live("B-2", "999000111@lid", "Zubi", "ai who's the goat")])
    assert asked == ["Zubi"], asked
    after = sqlite3.connect(wa._DB_PATH).execute("SELECT COUNT(*) FROM whatsapp_messages").fetchone()[0]
    assert after == before + 2, "his message is still stored"


def t_admin_unblocks_and_he_is_answered_again():
    assert ADMIN.delete(f"/api/admin/wa-blocks/{SAMAD}").json() == {"ok": True}
    assert _asked_for([_live("B-3", "212777109086321@lid", "AbdulSamad Bawany", "ai back?")]) == ["AbdulSamad Bawany"]


def t_admin_bad_requests():
    assert ADMIN.post("/api/admin/wa-blocks/zid-nobody").status_code == 400
    assert ADMIN.post("/api/admin/wa-blocks/zid-admin").status_code == 400


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
