#!/usr/bin/env python3
"""Reel publishing contract: shortcode permalinks only, media IDs kept, reel types,
the one-time corrected re-share, and the paginated eligible_clips roster.

  docker run --rm -e SESSION_SECRET=test -v "$PWD/tests:/app/tests" crcmz-app:test \
    python tests/test_ig_reels.py
"""
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_tmp = tempfile.mkdtemp()
os.environ["IG_POSTS_DB"] = os.path.join(_tmp, "ig_posts.db")
os.environ.setdefault("SESSION_SECRET", "test-secret")

SENT = []


class _Bridge(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        SENT.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


_srv = HTTPServer(("127.0.0.1", 0), _Bridge)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
os.environ["WA_BRIDGE_URL"] = f"http://127.0.0.1:{_srv.server_port}"
os.environ["WA_GOOPERS_JID"] = "group@g.us"

import assistant  # noqa: E402
import clips  # noqa: E402

clips.get = lambda cid: {"message_uid": cid, "sender_online_id": "ASamad89"}
CALLER = {"zitadel_id": "service:test", "label": "Muse",
          "scopes": {"ig_post_record", "ig_reel_share"}}
FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


def call(tool, **args):
    result, _ = assistant.call_write_tool(tool, args, CALLER)
    return json.loads(result)


def test_numeric_media_id_url_is_rejected():
    for tool, key in (("ig_post_record", "ig_url"), ("ig_reel_share", "instagram_url")):
        r = call(tool, clip_id="c-num", **{key: "https://www.instagram.com/reel/17894952330419326/"})
        assert not r["ok"] and "numeric media ID" in r["error"], r
        r = call(tool, clip_id="c-num", **{key: "https://evil.example/reel/Dd0w-8rDgb7/"})
        assert not r["ok"], r


def test_post_record_stores_media_id_and_canonical_permalink():
    import ig_posts
    r = call("ig_post_record", clip_id="c-rec", ig_url="https://instagram.com/reels/Dd0w-8rDgb7?igsh=x",
             instagram_media_id="17894952330419326")
    assert r["ok"], r
    row = ig_posts.get_by_clip("c-rec")
    assert row["ig_url"] == "https://www.instagram.com/reel/Dd0w-8rDgb7/", row["ig_url"]
    assert row["instagram_media_id"] == "17894952330419326"
    call("ig_post_record", clip_id="c-rec", ig_url="https://www.instagram.com/reel/Dd0w-8rDgb7/")
    assert ig_posts.get_by_clip("c-rec")["instagram_media_id"] == "17894952330419326", \
        "a later call without a media ID must not erase it"


def test_goop_and_review_types_accepted_unknown_rejected():
    for t in ("goop", "review"):
        r = call("ig_reel_share", clip_id=f"c-{t}", instagram_url="https://www.instagram.com/reel/AbCdE12345/",
                 reel_type=t)
        assert r["ok"] and r["group_notified"], r
    r = call("ig_reel_share", clip_id="c-bad", instagram_url="https://www.instagram.com/reel/AbCdE12345/",
             reel_type="everyone")
    assert not r["ok"] and "reel_type" in r["error"], r


def test_corrected_reshare_goes_out_once_per_clip():
    url = "https://www.instagram.com/reel/DdxdzZHj8_X/"
    r = call("ig_reel_share", clip_id="c-daily", instagram_url=url, reel_type="daily")
    assert r["ok"] and r["group_notified"], r
    before = len(SENT)
    r = call("ig_reel_share", clip_id="c-daily", instagram_url=url, reel_type="daily")
    assert r.get("already_shared") and len(SENT) == before, "plain retry must not resend"
    r = call("ig_reel_share", clip_id="c-daily", instagram_url=url, reel_type="daily", resend_correction=True)
    assert r["ok"] and r["resent_correction"] and len(SENT) == before + 1, r
    assert SENT[-1]["message"].endswith(url) and "Daily highlights" in SENT[-1]["message"]
    r = call("ig_reel_share", clip_id="c-daily", instagram_url=url, reel_type="daily", resend_correction=True)
    assert not r["ok"] and len(SENT) == before + 1, "second correction must be refused"


def test_reshare_needs_a_prior_share_and_is_per_clip():
    r = call("ig_reel_share", clip_id="c-never", instagram_url="https://www.instagram.com/reel/NeverSent1/",
             resend_correction=True)
    assert not r["ok"], r
    r = call("ig_reel_share", clip_id="c-goop", instagram_url="https://www.instagram.com/reel/AbCdE12345/",
             reel_type="goop", resend_correction=True)
    assert r["ok"], "another clip's correction must be unaffected by c-daily's"


def test_eligible_clips_pages_through_everything():
    import sqlite3
    import time
    clips._DB_PATH = __import__("pathlib").Path(os.path.join(_tmp, "clips.db"))
    clips.init()
    now = time.time()
    with sqlite3.connect(clips._DB_PATH) as db:
        for i in range(45):
            body = "rev pls" if i % 9 == 0 else ("🔥" if i % 2 else None)
            dur = 75.0 if i % 10 == 5 else 20.0 + i
            db.execute("INSERT INTO clips (message_uid, ugc_id, psn_group_id, sender_online_id, psn_created_at,"
                       " discovered_at, status, archive_status, duration_seconds, body, created_at, updated_at)"
                       " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                       (f"15#{i}", f"u{i}", "g", "ASamad89", now - i, now, "delivered", "archived",
                        dur, body, now, now))
    want = sum(1 for i in range(45) if i % 9 != 0 and not (i % 10 == 5) and 20.0 + i <= 60)
    seen, offset = [], 0
    while True:
        page = json.loads(assistant.call_tool("eligible_clips", {"offset": offset, "limit": 500})[0])
        assert len(page["clips"]) <= 20, "limit must clamp to 20"
        assert page["total"] == want, page["total"]
        seen += [c["clip_id"] for c in page["clips"]]
        if not page["has_more"]:
            break
        offset = page["next_offset"]
    assert len(seen) == want == len(set(seen)), (len(seen), want)
    assert seen[0] == "15#1", "newest first"
    raw = assistant.call_tool("eligible_clips", {"limit": 20})[0]
    assert "truncated" not in raw and len(raw) < assistant.MAX_TOOL_CHARS, len(raw)


if __name__ == "__main__":
    print("reel publishing")
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
