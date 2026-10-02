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
os.environ["VIDEO_UPLOADS_DB"] = os.path.join(_tmp, "video_uploads.db")
os.environ["VIDEO_UPLOADS_STAGING"] = os.path.join(_tmp, "staging")
os.environ.setdefault("SESSION_SECRET", "test-secret")

SENT = []
CLEARED = []


class _Bridge(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.startswith("/api/clips/"):
            CLEARED.append((self.path, body, self.headers.get("X-App-Token")))
        else:
            SENT.append(body)
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


_srv = HTTPServer(("127.0.0.1", 0), _Bridge)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
os.environ["WA_BRIDGE_URL"] = f"http://127.0.0.1:{_srv.server_port}"
# The stub also plays reel-review, so force-post clearing hits a real HTTP path.
os.environ["REEL_REVIEW_URL"] = f"http://127.0.0.1:{_srv.server_port}"
os.environ["REEL_REVIEW_TOKEN"] = "rr-test-token"
os.environ["WA_MAIN_JID"] = "group@g.us"

import assistant  # noqa: E402
import clips  # noqa: E402

clips.get = lambda cid: {"message_uid": cid, "sender_online_id": "ASamad89"}
CALLER = {"zitadel_id": "service:test", "label": "Muse",
          "scopes": {"ig_post_record", "ig_reel_share", "video_post_record"}}
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


def test_daily_caption_is_a_generic_announcement():
    r = call("ig_reel_share", clip_id="c-dailycap", instagram_url="https://www.instagram.com/reel/DailyCap01/",
             caption="Daily highlights have dropped! \U0001f525")
    assert r["ok"] and r["group_notified"], r
    msg = SENT[-1]["message"]
    assert "@all" in msg and "Daily highlights have dropped! \U0001f525" in msg, msg
    assert "ASamad89" not in msg and "dropped on Instagram" not in msg, msg
    assert SENT[-1]["mentionAll"] is True
    r = call("ig_reel_share", clip_id="c-firecap", instagram_url="https://www.instagram.com/reel/FireCap001/",
             caption="clean shot", reel_type="fire")
    msg = SENT[-1]["message"]
    assert "@all" in msg and "*ASamad89*" in msg and "@everyone" not in msg, msg


def test_recording_a_post_clears_that_clips_force_post():
    CLEARED.clear()
    r = call("ig_post_record", clip_id="15#force1", ig_url="https://www.instagram.com/reel/Forced1234/")
    assert r["ok"], r
    assert CLEARED == [("/api/clips/15%23force1/override/force-post", {"force": False}, "rr-test-token")], CLEARED
    call("ig_reel_share", clip_id="15#force2", instagram_url="https://www.instagram.com/reel/Forced5678/")
    assert CLEARED[-1][0] == "/api/clips/15%23force2/override/force-post", CLEARED


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


def _member_video(vid, psn):
    import sqlite3
    import video_uploads as vu
    vu.init()
    with sqlite3.connect(os.environ["VIDEO_UPLOADS_DB"]) as db:
        db.execute("INSERT INTO video_posts (video_post_id, zitadel_id, psn_id, filename, content_type,"
                   " storage_key, sha256, file_size_bytes, duration_seconds, status, uploaded_at)"
                   " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                   (vid, "zid-" + vid, psn, "v.mp4", "video/mp4", "k", vid.ljust(64, "0"), 1, 30.0, "queued", 1.0))


def test_member_share_carries_tiktok_and_youtube_links():
    _member_video("vp-all3", "Mutasif")
    ig = "https://www.instagram.com/reel/Member00001/"
    r = call("ig_reel_share", clip_id="", video_post_id="vp-all3", instagram_url=ig, reel_type="member",
             tiktok_url="https://www.tiktok.com/@crcmzclan/video/7420000000000000001",
             youtube_url="https://youtu.be/AbCdEfGhIjK")
    assert r["ok"] and r["group_notified"], r
    msg = SENT[-1]["message"]
    assert "*Mutasif*'s video just dropped on Instagram:\n" + ig in msg, msg
    assert msg.endswith("\nTikTok: https://www.tiktok.com/@crcmzclan/video/7420000000000000001"
                        "\nYouTube: https://www.youtube.com/watch?v=AbCdEfGhIjK"), msg
    before = len(SENT)
    r = call("ig_reel_share", clip_id="", video_post_id="vp-all3", instagram_url=ig, reel_type="member",
             tiktok_url="https://www.tiktok.com/@crcmzclan/video/7420000000000000001")
    assert r.get("already_shared") and len(SENT) == before, "one message per video"


def test_member_share_without_extra_links_is_unchanged():
    _member_video("vp-igonly", "Mutasif")
    ig = "https://www.instagram.com/reel/Member00002/"
    r = call("ig_reel_share", clip_id="", video_post_id="vp-igonly", instagram_url=ig, reel_type="member")
    assert r["ok"] and r["group_notified"], r
    assert SENT[-1]["message"] == "[Muse] @all \U0001f3ae *Mutasif*'s video just dropped on Instagram:\n" + ig, \
        SENT[-1]["message"]


def test_member_share_rejects_bad_links():
    _member_video("vp-bad", "Mutasif")
    ig = "https://www.instagram.com/reel/Member00003/"
    before = len(SENT)
    for extra in ({"tiktok_url": "https://www.tiktok.com/@someoneelse/video/7420000000000000001"},
                  {"tiktok_url": "https://vm.tiktok.com/ZMabc/"},
                  {"youtube_url": "https://vimeo.com/123"}):
        r = call("ig_reel_share", clip_id="", video_post_id="vp-bad", instagram_url=ig,
                 reel_type="member", **extra)
        assert not r["ok"], (extra, r)
    r = call("ig_reel_share", clip_id="c-fire-x", instagram_url=ig, reel_type="fire",
             tiktok_url="https://www.tiktok.com/@crcmzclan/video/7420000000000000001")
    assert not r["ok"] and "member" in r["error"], r
    assert len(SENT) == before, "nothing is sent when a link is refused"


def test_member_video_gets_one_message_per_platform():
    _member_video("vp-seq", "Mutasif")
    ig = "https://www.instagram.com/reel/Member00004/"
    tt = "https://www.tiktok.com/@crcmzclan/video/7420000000000000004"
    yt = "https://www.youtube.com/shorts/AbCdEfGhIj4"
    r = call("ig_reel_share", clip_id="", video_post_id="vp-seq", instagram_url=ig, reel_type="member")
    assert r["announced"] == ["instagram"] and SENT[-1]["mentionAll"] is True, r
    r = call("ig_reel_share", clip_id="", video_post_id="vp-seq", instagram_url=ig, reel_type="member",
             tiktok_url=tt)
    assert r["ok"] and r["announced"] == ["tiktok"], r
    assert SENT[-1]["message"] == "[Muse] \U0001f3ae *Mutasif*'s video is also on TikTok:\nTikTok: " + tt, SENT[-1]
    assert SENT[-1]["mentionAll"] is False, "follow-ups don't ping @all"
    r = call("ig_reel_share", clip_id="", video_post_id="vp-seq", reel_type="member", youtube_url=yt)
    assert r["announced"] == ["youtube"] and SENT[-1]["message"].endswith("also on YouTube:\nYouTube: " + yt), r
    before = len(SENT)
    r = call("ig_reel_share", clip_id="", video_post_id="vp-seq", instagram_url=ig, reel_type="member",
             tiktok_url=tt, youtube_url=yt)
    assert r["ok"] and r.get("already_shared") and r["announced"] == [] and len(SENT) == before, r


def test_member_video_without_instagram_can_lead_with_tiktok():
    _member_video("vp-long", "Mutasif")
    tt = "https://www.tiktok.com/@crcmzclan/video/7420000000000000005"
    r = call("ig_reel_share", clip_id="", video_post_id="vp-long", reel_type="member", tiktok_url=tt)
    assert r["ok"] and r["announced"] == ["tiktok"], r
    assert SENT[-1]["message"] == "[Muse] @all \U0001f3ae *Mutasif*'s video just dropped on TikTok:\n" + tt
    r = call("ig_reel_share", clip_id="", video_post_id="vp-long", reel_type="member")
    assert not r["ok"] and "at least one" in r["error"], r


def test_video_post_record_and_ig_reel_share_share_one_ledger():
    _member_video("vp-both", "Mutasif")
    ig = "https://www.instagram.com/reel/Member00006/"
    before = len(SENT)
    r = call("video_post_record", video_post_id="vp-both", platform="instagram", url=ig)
    assert r["ok"] and r["group_notified"] and len(SENT) == before + 1, r
    r = call("ig_reel_share", clip_id="", video_post_id="vp-both", instagram_url=ig, reel_type="member")
    assert r.get("already_shared") and len(SENT) == before + 1, "same post via both tools = one message"
    tt = "https://www.tiktok.com/@crcmzclan/video/7420000000000000006"
    r = call("ig_reel_share", clip_id="", video_post_id="vp-both", reel_type="member", tiktok_url=tt)
    assert r["announced"] == ["tiktok"] and len(SENT) == before + 2, r
    r = call("video_post_record", video_post_id="vp-both", platform="tiktok", url=tt)
    assert r["ok"] and not r["group_notified"] and len(SENT) == before + 2, r


def test_failed_send_leaves_the_platform_to_retry():
    _member_video("vp-fail", "Mutasif")
    ig = "https://www.instagram.com/reel/Member00007/"
    good = os.environ["WA_BRIDGE_URL"]
    os.environ["WA_BRIDGE_URL"] = "http://127.0.0.1:9"
    try:
        r = call("ig_reel_share", clip_id="", video_post_id="vp-fail", instagram_url=ig, reel_type="member")
        assert not r["ok"] and r["announced"] == [] and "notify_note" in r, r
    finally:
        os.environ["WA_BRIDGE_URL"] = good
    r = call("ig_reel_share", clip_id="", video_post_id="vp-fail", instagram_url=ig, reel_type="member")
    assert r["ok"] and r["announced"] == ["instagram"] and SENT[-1]["mentionAll"] is True, r


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
