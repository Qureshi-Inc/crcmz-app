#!/usr/bin/env python3
"""Coaching feedback loop: one row per player per review, and a weekly digest that
aggregates by game with no player identities in it.

  docker run --rm -e SESSION_SECRET=test -v "$PWD/tests:/app/tests" crcmz-app:test \
    python tests/test_feedback_digest.py
"""
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import coach  # noqa: E402
import coach_digest  # noqa: E402

_tmp = Path(tempfile.mkdtemp())
coach._DB_PATH = _tmp / "coach_reviews.db"
coach_digest._OUTPUT_DIR = _tmp / "feedback_digests"
FAILED = []
PLAYERS = ["389214164473618691", "389228042100154627", "389300000000000001"]


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


def seed():
    coach.init()
    import sqlite3
    with sqlite3.connect(coach._DB_PATH) as db:
        for rid, game, user in (("rev-arc-1", "ARC Raiders", "moiiz41510"), ("rev-arc-2", "ARC Raiders", "ASamad89"),
                                ("rev-bf6-1", "Battlefield™ 6", "moiiz41510")):
            db.execute("INSERT INTO coach_reviews (review_id, clip_id, psn_user, game, created_at, review_status)"
                       " VALUES (?,?,?,?,?, 'complete')", (rid, "clip-" + rid, user, game, time.time()))


def test_resubmitting_updates_the_same_row():
    seed()
    a = coach.submit_feedback("rev-arc-1", PLAYERS[0], "down", ["wrong-grade"], "grade too high")
    b = coach.submit_feedback("rev-arc-1", PLAYERS[0], "up", ["bad-tip", "not-a-tag"], "")
    assert a and a == b, (a, b)
    got = coach.get_feedback("rev-arc-1", PLAYERS[0])
    assert got["rating"] == "up" and got["tags"] == ["bad-tip"], got
    assert coach.submit_feedback("rev-arc-1", PLAYERS[0], "sideways", [], "") is None


def test_digest_aggregates_by_game_without_identities():
    for i, zid in enumerate(PLAYERS):
        coach.submit_feedback("rev-arc-2" if i else "rev-arc-1", zid, "down",
                              ["wrong-grade", "missed-moment"], "moiiz41510 said this was wrong")
    coach.submit_feedback("rev-bf6-1", PLAYERS[0], "down", ["transcript-wrong"], "")
    path = coach_digest.run()
    text = path.read_text()
    assert path.name == time.strftime("%G-W%V", time.gmtime()) + ".md", path.name
    assert "## ARC Raiders" in text, text
    assert "**wrong-grade** — 3 player(s)" in text and "**missed-moment** — 3 player(s)" in text, text
    assert "Battlefield" not in text, "a single player's tag is a one-off, not a pattern"
    for secret in PLAYERS + ["moiiz41510", "ASamad89", "said this was wrong"]:
        assert secret not in text, f"{secret!r} leaked into the digest"


if __name__ == "__main__":
    print("feedback digest")
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
