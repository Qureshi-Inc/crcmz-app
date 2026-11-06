#!/usr/bin/env python3
"""Admin → WhatsApp bot behaviour (wa_neuter.py): neutered members get the supportive persona.

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
TMP = Path(tempfile.mkdtemp(prefix="wa-neuter-"))
os.environ.setdefault("SESSION_SECRET", "test-secret-for-wa-blocks")
os.environ.setdefault("WA_INGEST_SECRET", "test-ingest-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ["WA_MAIN_JID"] = MAIN
os.environ["WA_NEUTER_DB"] = str(TMP / "wa_neuter.db")
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

import wa_neuter  # noqa: E402

wa_neuter.init()

print("\nwa_neuter: who gets the supportive persona")


def t_nothing_neutered_never_touches_identity():
    orig = crcmz_identity.identify_jid
    crcmz_identity.identify_jid = lambda *a, **k: (_ for _ in ()).throw(AssertionError("looked up"))
    try:
        assert wa_neuter.is_neutered("212777109086321@lid", "AbdulSamad Bawany") is False
    finally:
        crcmz_identity.identify_jid = orig


def t_neuter_collects_phone_and_history_lids():
    e = wa_neuter.neuter(SAMAD, by="zid-admin")
    assert e["zitadel_id"] == SAMAD and e["name"] == "Samad" and e["blocked_by"] == "zid-admin", e
    with sqlite3.connect(os.environ["WA_NEUTER_DB"]) as db:
        ids = {r[0] for r in db.execute("SELECT wa_id FROM block_ids WHERE sub=?", (SAMAD,))}
    assert ids == {"17865233277", "212777109086321", "555"}, ids
    assert "120363334247249772" not in ids, "never the group JID from a bot row"
    assert e["whatsapp_ids"] == 3


def t_neutered_by_lid_and_by_phone():
    assert wa_neuter.is_neutered("212777109086321@lid", "") is True
    assert wa_neuter.is_neutered("17865233277:4@s.whatsapp.net", "whoever") is True


def t_everyone_else_still_gets_normal_bot():
    assert wa_neuter.is_neutered("999000111@lid", "Zubi") is False
    assert wa_neuter.is_neutered("424242@lid", "Someone New") is False


def t_new_id_under_his_name_is_learned_so_renaming_doesnt_help():
    assert wa_neuter.is_neutered("777888@lid", "Abdul Samad") is True
    assert wa_neuter.is_neutered("777888@lid", "Totally Not Samad") is True


def t_someone_else_taking_his_name_is_not_neutered():
    # Zubi's id is Zubi's in the graph: the id wins over a lookalike name.
    assert wa_neuter.is_neutered("999000111@lid", "Abdul Samad") is False


def t_listing():
    rows = wa_neuter.list_neutered()
    assert [r["zitadel_id"] for r in rows] == [SAMAD], rows
    assert set(rows[0]) == {"zitadel_id", "name", "blocked_by", "created", "whatsapp_ids"}


def t_bad_neuters_refused():
    for sub, by in (("zid-nobody", "zid-admin"), ("zid-admin", "zid-admin")):
        try:
            wa_neuter.neuter(sub, by=by)
        except ValueError:
            continue
        raise AssertionError(f"neutered {sub}")


def t_unneutered_drops_every_id():
    assert wa_neuter.unneutered(SAMAD) is True
    for jid in ("212777109086321@lid", "17865233277@s.whatsapp.net", "777888@lid"):
        assert wa_neuter.is_neutered(jid, "Abdul Samad") is False, jid
    assert wa_neuter.unneutered(SAMAD) is False


def t_broken_store_fails_open():
    wa_neuter.neuter(SAMAD, by="zid-admin")
    orig = wa_neuter._blocked_subs
    wa_neuter._blocked_subs = lambda: (_ for _ in ()).throw(sqlite3.OperationalError("disk"))
    try:
        assert wa_neuter.is_neutered("212777109086321@lid", "") is False
    finally:
        wa_neuter._blocked_subs = orig
    wa_neuter.unneutered(SAMAD)


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)
        del globals()[name]


# ── HTTP: the ingest gate and the admin endpoints ──────────────────────────────
from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402

assert server._wa_neuter is wa_neuter
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


def _captured(msgs):
    """Return list of (author, neutered) tuples for each _answer_whatsapp call."""
    captured = []
    orig = server._answer_whatsapp
    server._answer_whatsapp = lambda *a, **k: captured.append(a)
    try:
        for m in msgs:
            r = BRIDGE.post("/api/whatsapp/ingest", headers=HDR, json=m)
            assert r.status_code == 200, r.text
        time.sleep(0.5)
    finally:
        server._answer_whatsapp = orig
    return captured


def _live(mid, jid, name, text):
    return {"message_id": mid, "sender_name": name, "sender_jid": jid, "group_jid": MAIN,
            "timestamp": int(time.time()), "text": text, "type": "text"}


def t_admin_endpoints_are_admin_only():
    assert _client().get("/api/admin/wa-neuter").status_code == 401
    assert MEMBER.get("/api/admin/wa-neuter").status_code == 403
    assert MEMBER.post(f"/api/admin/wa-neuter/{SAMAD}").status_code == 403
    assert MEMBER.delete(f"/api/admin/wa-neuter/{SAMAD}").status_code == 403
    assert wa_neuter.list_neutered() == []


def t_admin_neuters_and_both_get_answered_but_samad_gets_nice_mode():
    r = ADMIN.post(f"/api/admin/wa-neuter/{SAMAD}")
    assert r.status_code == 200 and r.json()["block"]["whatsapp_ids"] >= 2, r.text
    assert [b["zitadel_id"] for b in ADMIN.get("/api/admin/wa-neuter").json()["blocks"]] == [SAMAD]
    before = sqlite3.connect(wa._DB_PATH).execute("SELECT COUNT(*) FROM whatsapp_messages").fetchone()[0]
    caps = _captured([_live("B-1", "212777109086321@lid", "AbdulSamad Bawany", "ai who's the goat"),
                      _live("B-2", "999000111@lid", "Zubi", "ai who's the goat")])
    # Both are answered (neutered mode still replies, just with a nicer persona)
    authors = [a[1] for a in caps]
    assert "AbdulSamad Bawany" in authors, f"Samad should still get a reply: {authors}"
    assert "Zubi" in authors, f"Zubi should still get a reply: {authors}"
    # Samad's call has neutered=True (8th positional arg, index 7)
    samad_cap = next(a for a in caps if a[1] == "AbdulSamad Bawany")
    assert len(samad_cap) >= 8 and samad_cap[7] is True, f"Samad should be neutered: {samad_cap}"
    zubi_cap = next(a for a in caps if a[1] == "Zubi")
    assert len(zubi_cap) < 8 or zubi_cap[7] is False, f"Zubi should not be neutered: {zubi_cap}"
    after = sqlite3.connect(wa._DB_PATH).execute("SELECT COUNT(*) FROM whatsapp_messages").fetchone()[0]
    assert after == before + 2, "both messages stored"


def t_admin_unneutered_and_he_gets_normal_bot():
    assert ADMIN.delete(f"/api/admin/wa-neuter/{SAMAD}").json() == {"ok": True}
    caps = _captured([_live("B-3", "212777109086321@lid", "AbdulSamad Bawany", "ai back?")])
    assert len(caps) == 1, f"should be answered: {caps}"
    # After unneutered, neutered flag is False
    assert len(caps[0]) < 8 or caps[0][7] is False, f"should not be neutered after removal: {caps[0]}"


def t_admin_bad_requests():
    assert ADMIN.post("/api/admin/wa-neuter/zid-nobody").status_code == 400
    assert ADMIN.post("/api/admin/wa-neuter/zid-admin").status_code == 400


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
