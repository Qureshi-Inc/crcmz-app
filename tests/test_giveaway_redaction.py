#!/usr/bin/env python3
"""Giveaway: members must not learn the winner before the reveal.

Plain asserts, no pytest. Run through tests/run-all.sh test_giveaway_redaction
(the app image, tmpfs /data).
"""

import copy
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-giveaway")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import giveaway as gv  # noqa: E402

gv.DB_PATH = Path(tempfile.mkdtemp(prefix="giveaway-test-")) / "giveaway.db"
gv.init_db()

FAILED: list[str] = []
PASSED = 0

WINNER_ID = "zit-winner-7f3a91"
WINNER_NAME = "Secret_Winner_Qx"
MEMBERS = [{"id": WINNER_ID, "display": WINNER_NAME}]  # one entry -> deterministic draw
OTHER = "zit-someone-else"


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


def leaks(obj) -> bool:
    blob = json.dumps(obj)
    return WINNER_NAME in blob or WINNER_ID in blob


def fresh_drawn() -> int:
    gv.reset_all()
    gid = gv.create_giveaway("October drop", "PS Plus", None, None)["id"]
    assert gv.publish_giveaway(gid, MEMBERS)["status"] == "ok"
    assert gv.lock_giveaway(gid)["status"] == "ok"
    assert gv.draw_winner(gid)["winner"] == WINNER_NAME
    return gid


def plant_pending_win(gid):
    """A rotation row for the unrevealed giveaway (the case the filter guards)."""
    with gv._conn() as c:
        c.execute("INSERT INTO rotation_history(cycle, member_id, display_name, won_at,"
                  " giveaway_id) VALUES(1,?,?,?,?)", (WINNER_ID, WINNER_NAME, gv._now(), gid))


import server  # noqa: E402

# The member list shows up in rotation.all_members for everyone by design (it is
# the roster, not the result), so the leak checks use a roster without the winner.
ROSTER = [{"id": OTHER, "display": "Someone"}]


def payload(user_id, is_admin):
    g = gv.get_active_giveaway()
    rot = gv.get_rotation_state(ROSTER)
    p = server._giveaway_payload(g, rot, ROSTER, user_id, is_admin)
    return server._redact_giveaway_for_member(p, user_id) if not is_admin else p


# ── pure redaction ────────────────────────────────────────────────────────────
def t_member_while_drawn_sees_nothing():
    fresh_drawn()
    p = payload(WINNER_ID, False)
    assert p["giveaway"]["status"] == "drawn"
    assert p["giveaway"]["active_draw"] is None
    assert p["giveaway"]["draws"] and all(d["winner_name"] is None and d["winner_id"] is None
                                          for d in p["giveaway"]["draws"])
    # entries legitimately list every member, the winner included; strip them
    # before asserting nothing else points at the result
    rest = {**p, "giveaway": {**p["giveaway"], "entries": []}}
    assert not leaks(rest), json.dumps(rest)
    assert p["user_won_this_cycle"] is False


def t_member_while_drawn_pending_rotation_win_hidden():
    gid = fresh_drawn()
    plant_pending_win(gid)
    p = payload(WINNER_ID, False)
    rest = {**p, "giveaway": {**p["giveaway"], "entries": []}}
    assert not leaks(rest), json.dumps(rest)
    assert p["rotation"]["won_members"] == []
    assert p["rotation"]["won_count"] == 0
    assert p["user_won_this_cycle"] is False


def t_rotation_keeps_earlier_wins():
    gid = fresh_drawn()
    plant_pending_win(gid)
    with gv._conn() as c:
        c.execute("INSERT INTO rotation_history(cycle, member_id, display_name, won_at,"
                  " giveaway_id) VALUES(1,'zit-old','OldWinner',?,NULL)", (gv._now(),))
    everyone = MEMBERS + ROSTER + [{"id": "zit-old", "display": "OldWinner"}]
    rot = gv.redact_rotation_for_member(gv.get_rotation_state(everyone),
                                        gv.get_active_giveaway(), everyone)
    assert [m["member_id"] for m in rot["won_members"]] == ["zit-old"]
    assert rot["won_count"] == 1
    assert any(m["id"] == WINNER_ID for m in rot["eligible"])
    assert not any(m["id"] == "zit-old" for m in rot["eligible"])
    assert rot["eligible_count"] == 2


def t_admin_while_drawn_sees_everything():
    gid = fresh_drawn()
    plant_pending_win(gid)
    p = payload(WINNER_ID, True)
    assert p["giveaway"]["active_draw"]["winner_name"] == WINNER_NAME
    assert p["giveaway"]["draws"][0]["winner_id"] == WINNER_ID
    assert p["rotation"]["won_members"][0]["member_id"] == WINNER_ID
    assert p["user_won_this_cycle"] is True


def t_member_after_reveal_sees_winner():
    gid = fresh_drawn()
    assert gv.reveal_winner(gid)["status"] == "ok"
    p = payload(WINNER_ID, False)
    assert p["giveaway"]["active_draw"]["winner_name"] == WINNER_NAME
    assert p["giveaway"]["draws"][0]["winner_id"] == WINNER_ID
    assert p["rotation"]["won_members"][0]["member_id"] == WINNER_ID
    assert p["user_won_this_cycle"] is True


def t_redaction_is_pure_and_keeps_shape():
    fresh_drawn()
    g = gv.get_active_giveaway()
    before = copy.deepcopy(g)
    red = gv.redact_giveaway_for_member(g)
    assert g == before, "input mutated"
    assert set(red) == set(g)
    assert all(set(a) == set(b) for a, b in zip(red["draws"], g["draws"]))


def t_open_and_none_pass_through():
    assert gv.redact_giveaway_for_member(None) is None
    assert not gv.winner_hidden({"status": "revealed"})
    assert not gv.winner_hidden({"status": "closed"})
    for s in ("draft", "open", "locked", "drawn"):
        assert gv.winner_hidden({"status": s})


def t_assistant_tool_hides_pending_win():
    import assistant
    gid = fresh_drawn()
    plant_pending_win(gid)
    orig = server._portal_members
    server._portal_members = lambda: ROSTER
    try:
        out = assistant._giveaway_status()
    finally:
        server._portal_members = orig
    assert not leaks(out), out
    assert gv.reveal_winner(gid)["status"] == "ok"
    server._portal_members = lambda: ROSTER
    try:
        out = assistant._giveaway_status()
    finally:
        server._portal_members = orig
    assert out["rotation"]["already_won"] == [WINNER_NAME], out


def t_history_only_lists_closed():
    gid = fresh_drawn()
    assert gv.list_past_giveaways(20) == []
    gv.reveal_winner(gid)
    assert gv.list_past_giveaways(20) == []
    gv.close_giveaway(gid, MEMBERS)
    assert [h["id"] for h in gv.list_past_giveaways(20)] == [gid]


# ── HTTP surface ──────────────────────────────────────────────────────────────
def t_http_get_giveaway():
    from fastapi.testclient import TestClient
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    orig_admin, orig_members = server._is_iam_admin, server._portal_members
    admins = set()

    async def fake_admin(uid):
        return uid in admins

    server._is_iam_admin = fake_admin
    server._portal_members = lambda: ROSTER
    try:
        gid = fresh_drawn()
        plant_pending_win(gid)
        client.cookies.set(server._SESSION_COOKIE,
                           server._signer().dumps({"sub": WINNER_ID, "iss": "x"}))
        r = client.get("/api/giveaway")
        assert r.status_code == 200, r.text
        d = r.json()
        d["giveaway"]["entries"] = []
        assert not leaks(d), r.text
        assert d["is_admin"] is False and d["giveaway"]["status"] == "drawn"
        admins.add(WINNER_ID)
        d = client.get("/api/giveaway").json()
        assert d["giveaway"]["active_draw"]["winner_name"] == WINNER_NAME
    finally:
        server._is_iam_admin, server._portal_members = orig_admin, orig_members


print("giveaway redaction tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
