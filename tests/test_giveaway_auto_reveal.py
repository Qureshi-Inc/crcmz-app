#!/usr/bin/env python3
"""Giveaway auto-reveal: the winner is drawn and revealed at reveal_at, in the
configured zone, with nobody watching. Drafts and future reveals are left alone.

Plain asserts, no pytest. Run through tests/run-all.sh test_giveaway_auto_reveal
(the app image, tmpfs /data).
"""

import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import giveaway as gv  # noqa: E402

gv.DB_PATH = Path(tempfile.mkdtemp(prefix="giveaway-auto-")) / "giveaway.db"
gv.init_db()

FAILED: list[str] = []
PASSED = 0
TZ = "America/Los_Angeles"
MEMBERS = [{"id": "z1", "display": "Goopy"}, {"id": "z2", "display": "Bizzle"}]
# 2026-10-31 20:00 Pacific (PDT, -07:00) is 2026-11-01 03:00 UTC.
REVEAL = "2026-10-31T20:00"
AT = datetime(2026, 10, 31, 20, 0, tzinfo=ZoneInfo(TZ)).timestamp()


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


def fresh(status="open", reveal_at=REVEAL) -> int:
    gv.reset_all()
    gid = gv.create_giveaway("October drop", "PS Plus", reveal_at, reveal_at)["id"]
    if status != "draft":
        assert gv.publish_giveaway(gid, MEMBERS)["status"] == "ok"
    if status == "drawn":
        assert gv.draw_winner(gid)["status"] == "ok"
    return gid


def t_epoch():
    assert gv.reveal_epoch(REVEAL, TZ) == AT
    assert gv.reveal_epoch("2026-11-01T03:00:00+00:00", TZ) == AT  # an explicit offset wins
    assert gv.reveal_epoch("2026-11-01T03:00Z", TZ) == AT
    assert gv.reveal_epoch(None, TZ) is None and gv.reveal_epoch("not a date", TZ) is None


def t_not_yet():
    gid = fresh()
    assert gv.auto_reveal_due(TZ, now=AT - 1) is None
    assert gv.get_giveaway(gid)["status"] == "open"


def t_open_reveals():
    gid = fresh()
    r = gv.auto_reveal_due(TZ, now=AT)
    assert r["status"] == "revealed" and r["id"] == gid and r["winner"] in ("Goopy", "Bizzle"), r
    g = gv.get_giveaway(gid)
    assert g["status"] == "revealed" and g["active_draw"]["winner_name"] == r["winner"]
    assert gv.auto_reveal_due(TZ, now=AT + 60) is None  # idempotent: nothing left to do


def t_drawn_keeps_winner():
    gid = fresh("drawn")
    drawn = gv.get_giveaway(gid)["active_draw"]["winner_name"]
    r = gv.auto_reveal_due(TZ, now=AT + 5)
    assert r["status"] == "revealed" and r["winner"] == drawn  # no redraw


def t_draft_never():
    gid = fresh("draft")
    assert gv.auto_reveal_due(TZ, now=AT + 86400) is None
    assert gv.get_giveaway(gid)["status"] == "draft"


def t_no_reveal_time():
    gid = fresh(reveal_at=None)
    assert gv.auto_reveal_due(TZ, now=AT + 86400) is None
    assert gv.get_giveaway(gid)["status"] == "open"


def t_zone_matters():
    fresh()
    # 20:00 Pacific has not happened yet at 20:00 UTC the same day.
    utc_8pm = datetime(2026, 10, 31, 20, 0, tzinfo=ZoneInfo("UTC")).timestamp()
    assert gv.auto_reveal_due(TZ, now=utc_8pm) is None
    assert gv.auto_reveal_due("UTC", now=utc_8pm)["status"] == "revealed"


def t_no_entries_reports():
    gid = fresh()
    for m in MEMBERS:
        gv.remove_entry(gid, m["id"])  # an admin removed everyone
    r = gv.auto_reveal_due(TZ, now=AT)
    assert r and r["status"] == "error" and gv.get_giveaway(gid)["status"] != "revealed", r


for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
