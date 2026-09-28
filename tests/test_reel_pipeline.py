#!/usr/bin/env python3
"""Reel Review pipeline badges must match the pipeline that will claim each clip.

  docker run --rm -e SESSION_SECRET=test -v "$PWD/tests:/app/tests" crcmz-app:test \
    python tests/test_reel_pipeline.py
"""
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_tmp = Path(tempfile.mkdtemp())
os.environ["IG_POSTS_DB"] = str(_tmp / "ig_posts.db")
os.environ["WA_REACTIONS_DB"] = str(_tmp / "wa_reactions.db")

import clips  # noqa: E402
import ig_posts  # noqa: E402
import reel_pipeline  # noqa: E402
import wa_reactions  # noqa: E402

clips._DB_PATH = _tmp / "clips.db"
FAILED = []

# clip_id: (sender, body, duration, file_size, status, archive_status)
SEED = {
    "fire":        ("moiiz41510", "🔥 clean", 20.0, 1001, "delivered", "archived"),
    "fail-wait":   ("moiiz41510", "epic fail", 21.0, 1002, "delivered", "archived"),
    "fail-ready":  ("moiiz41510", "😂😂", 22.0, 1003, "delivered", "archived"),
    "daily":       ("ASamad89", None, 23.0, 1004, "delivered", "archived"),
    "revenge":     ("ASamad89", "revenge kill", 24.0, 1005, "delivered", "archived"),
    "posted":      ("ASamad89", "🔥", 29.58, 29413376, "delivered", "archived"),
    "twin":        ("asamad89", "🔥", 29.58, 29413376, "delivered", "archived"),
    "vetoed":      ("ASamad89", None, 25.0, 1006, "delivered", "archived"),
    "wa-veto":     ("ASamad89", "🔥", 26.0, 1007, "delivered", "archived"),
    "long":        ("ASamad89", None, 75.0, 1008, "delivered", "archived"),
    "coaching":    ("ASamad89", "rev this one", 30.0, 1009, "delivered", "archived"),
}


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


def seed():
    clips.init(); ig_posts.init(); wa_reactions.init()
    now = time.time()
    with sqlite3.connect(clips._DB_PATH) as db:
        for i, (cid, (sender, body, dur, size, status, arch)) in enumerate(SEED.items()):
            db.execute("INSERT INTO clips (message_uid, ugc_id, psn_group_id, sender_online_id, psn_created_at,"
                       " discovered_at, status, archive_status, duration_seconds, file_size, body, created_at,"
                       " updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (cid, f"u{i}", "g", sender, now - i, now, status, arch, dur, size, body, now, now))
    pid = ig_posts.claim_for_post("posted", "ASamad89")
    ig_posts.submit_post(pid, "https://www.instagram.com/reel/Posted0001/")
    for cid, reactors in (("fail-wait", [("a", "😂")]), ("fail-ready", [("a", "😂"), ("b", "🤣")]),
                          ("wa-veto", [("a", "🛑")])):
        wa_reactions.track_clip(cid, "wa-" + cid)
        for who, emoji in reactors:
            wa_reactions.update_reaction({"target_msg_id": "wa-" + cid, "reactor_jid": who + "@s", "emoji": emoji})


def test_every_badge_matches_the_pipeline():
    seed()
    got = reel_pipeline.classify(list(SEED), vetoed={"vetoed"})
    want = {"fire": "fire", "fail-wait": "fail", "fail-ready": "fail", "daily": "daily_eligible",
            "revenge": "daily_eligible", "posted": "posted", "twin": "twin_of_posted", "vetoed": "vetoed",
            "wa-veto": "vetoed", "long": "not_eligible", "coaching": "not_eligible"}
    wrong = {k: got[k]["state"] for k in want if got[k]["state"] != want[k]}
    assert not wrong, wrong
    assert got["fail-wait"]["reactions"] == 1 and got["fail-ready"]["reactions"] == 2
    assert got["fail-wait"]["gate"] == reel_pipeline.FAIL_REACTION_GATE == 2
    assert got["twin"]["twin_of"] == "posted" and got["twin"]["ig_url"].endswith("/Posted0001/")
    assert got["posted"]["editable"] is False and got["twin"]["editable"] is False
    assert got["long"]["detail"] == "longer than 60s" and got["coaching"]["detail"] == "coaching clip (rev)"
    assert got["wa-veto"]["detail"] == "🛑 reaction in WhatsApp"


def test_eligible_clips_uses_the_same_rev_rule():
    rows, total = clips.list_eligible(limit=50)
    ids = {r["message_uid"] for r in rows}
    assert "revenge" in ids and "coaching" not in ids and "long" not in ids, ids


def test_ingest_uses_the_same_triggers():
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py")).read()
    assert "_wants_ig_post = _rp.wants_ig_post" in src and "_wants_coaching = _rp.wants_coaching" in src
    assert reel_pipeline.wants_coaching("rev pls") and not reel_pipeline.wants_coaching("revenge")


if __name__ == "__main__":
    print("reel pipeline badges")
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
