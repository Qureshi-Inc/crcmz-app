#!/usr/bin/env python3
"""Month-end retention: nothing goes until the month's montage is published, then
media older than 14 days is cleared and the rows are kept.

Runs in the image (imports assistant):
    docker run --rm -v "$PWD":/app -w /app crcmz-app:test python3 tests/test_clip_retention.py
"""

import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_tmp = Path(tempfile.mkdtemp())
STORE = _tmp / "store"
os.environ["CLIP_LOCAL_DIR"] = str(STORE)
os.environ.pop("CLIP_BUCKET", None)
os.environ["VIDEO_UPLOADS_DB"] = str(_tmp / "video_uploads.db")
os.environ["VIDEO_UPLOADS_STAGING"] = str(_tmp / "staging")
os.environ["MONTAGE_RECORDS_DB"] = str(_tmp / "montage_records.db")
os.environ["REEL_REVIEW_TOKEN"] = "rr-test-token"

PRUNES = []


class _RR(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        ok = self.path == "/api/prune" and self.headers.get("X-App-Token") == "rr-test-token"
        if ok:
            PRUNES.append(body)
        out = json.dumps({"ok": True, "files": 3, "bytes": 300} if ok else {"detail": "no"}).encode()
        self.send_response(200 if ok else 401)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


_srv = HTTPServer(("127.0.0.1", 0), _RR)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
os.environ["REEL_REVIEW_URL"] = "http://127.0.0.1:%d" % _srv.server_port

import assistant  # noqa: E402
import clip_retention  # noqa: E402
import clip_store  # noqa: E402
import clips  # noqa: E402
import mcp_oauth  # noqa: E402
import month_montage  # noqa: E402
import video_uploads as vu  # noqa: E402

clips._DB_PATH = _tmp / "clips.db"
mcp_oauth.DB_PATH = _tmp / "mcp_user_tokens.db"

PT = ZoneInfo("America/Los_Angeles")
def ts(y, m, d, h=12):
    return datetime(y, m, d, h, tzinfo=PT).timestamp()

NOW = ts(2026, 10, 1, 12)          # the day the September montage lands
FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


def put(key, size=1000, mtime=None):
    p = STORE / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * size)
    if mtime:
        os.utime(p, (mtime, mtime))
    return p


# clip id -> (captured at, archived?)
CLIPS = {
    "aug10": (ts(2026, 8, 10), True),
    "sep05": (ts(2026, 9, 5), True),
    "sep16": (ts(2026, 9, 16), True),
    "sep20": (ts(2026, 9, 20), True),
    "sep29": (ts(2026, 9, 29), True),
    "unarch": (ts(2026, 9, 1), False),
}
# video id -> (status, uploaded at)
UPLOADS = {
    "up-posted-old": ("posted", ts(2026, 9, 2)),
    "up-skipped-old": ("skipped", ts(2026, 9, 3)),
    "up-queued-old": ("queued", ts(2026, 9, 4)),
    "up-posted-new": ("posted", ts(2026, 9, 28)),
}


def seed():
    clips.init(); vu.init(); month_montage.init(); mcp_oauth.init()
    with sqlite3.connect(clips._DB_PATH) as db:
        for i, (cid, (when, arch)) in enumerate(CLIPS.items()):
            key = f"clips/original/test/{cid}.mp4"
            if arch:
                put(key)
            db.execute(
                "INSERT INTO clips (message_uid, ugc_id, psn_group_id, sender_online_id, psn_created_at,"
                " discovered_at, status, archive_status, storage_key_original, duration_seconds,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (cid, f"u{i}", "g", "ASamad89", when, when, "delivered",
                 "archived" if arch else "not_archived", key if arch else None, 20.0, when, when))
    with sqlite3.connect(os.environ["VIDEO_UPLOADS_DB"]) as db:
        for i, (vid, (status, when)) in enumerate(UPLOADS.items()):
            key = f"clips/uploads/2026/09/{vid}.mp4"
            put(key, 2000)
            db.execute(
                "INSERT INTO video_posts (video_post_id, zitadel_id, psn_id, filename, content_type,"
                " storage_key, sha256, file_size_bytes, duration_seconds, status, uploaded_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (vid, f"zid-{i}", "ASamad89", vid + ".mp4", "video/mp4", key, "%064x" % i, 2000 + i,
                 30.0, status, when))
    put("montages/2026/08/v8/master.mp4", 5000, mtime=ts(2026, 8, 31))
    put("montages/2026/08/v8/manifest.json", 50, mtime=ts(2026, 8, 31))
    put("montages/2026/09/v1/master.mp4", 5000, mtime=ts(2026, 9, 30))


def status(cid):
    return clips.get(cid)["archive_status"]


def exists(key):
    return (STORE / key).exists()


def main():
    seed()
    print("clip retention")

    def nothing_before_a_published_montage():
        out = clip_retention.run(now=NOW)
        assert "skipped" in out, out
        month_montage.save_record("2026-09", "America/Los_Angeles", ["sep20"], None, None, None, "t")
        out = clip_retention.run(now=NOW)
        assert "skipped" in out, "a selection without both links is not a published montage: %s" % out
        assert all(status(c) == "archived" for c, (_, a) in CLIPS.items() if a)
        assert not PRUNES
    check("nothing is deleted until a month's montage has both links", nothing_before_a_published_montage)

    def cap_at_last_published_month():
        month_montage.save_record("2026-08", "America/Los_Angeles", ["aug10"],
                                  "https://www.instagram.com/reel/Aug0000001/",
                                  "https://www.tiktok.com/@crcmzclan/video/7400000000000000001", None, "t")
        out = clip_retention.run(now=NOW)
        assert out["ok"] and out["clips"]["files"] == 1, out
        assert status("aug10") == "purged" and not exists("clips/original/test/aug10.mp4")
        assert status("sep05") == "archived", "September's montage is not out yet, so its clips stay"
    check("the cutoff never passes the latest published month", cap_at_last_published_month)

    def september_published():
        month_montage.save_record("2026-09", "America/Los_Angeles", None,
                                  "https://www.instagram.com/reel/Sep0000001/",
                                  "https://www.tiktok.com/@crcmzclan/video/7400000000000000002", None, "t")
        PRUNES.clear()
        out = clip_retention.run(now=NOW)
        assert out["clips"]["files"] == 2, out            # sep05, sep16
        assert out["cutoff_iso"].startswith("2026-09-17"), out["cutoff_iso"]
        for c in ("sep05", "sep16"):
            assert status(c) == "purged" and not exists(f"clips/original/test/{c}.mp4"), c
            assert clips.get(c)["purged_at"], c
        for c in ("sep20", "sep29"):
            assert status(c) == "archived" and exists(f"clips/original/test/{c}.mp4"), c
        assert status("unarch") == "not_archived"
    check("after the montage: clips older than 14 days go, newer ones stay", september_published)

    def uploads():
        gone = {r["video_post_id"] for r in vu.purgeable_before(ts(2026, 9, 17))}
        assert not gone, "already purged on the last run: %s" % gone
        for vid, keep in (("up-posted-old", False), ("up-skipped-old", False),
                          ("up-queued-old", True), ("up-posted-new", True)):
            row = vu.get(vid)
            assert exists(row["storage_key"]) == keep, vid
            assert bool(row.get("media_purged_at")) != keep, vid
    check("member uploads: old posted/skipped cleared, queued never touched", uploads)

    def montages_and_reel_review():
        assert not exists("montages/2026/08/v8/master.mp4")
        assert exists("montages/2026/08/v8/manifest.json"), "manifests are kept"
        assert exists("montages/2026/09/v1/master.mp4")
        assert PRUNES == [{"older_than_days": 14}], PRUNES
    check("old montage videos and reel-review's cache are pruned", montages_and_reel_review)

    def idempotent():
        out = clip_retention.run(now=NOW)
        assert out["clips"]["files"] == 0 and out["uploads"]["files"] == 0, out
    check("a second run deletes nothing new", idempotent)

    def media_says_why():
        out = assistant._clip_media("sep05", clips.get("sep05"))
        assert "retention" in out["error"] and out["archive_status"] == "purged", out
    check("clip_media_url explains cleared media", media_says_why)

    def healer_leaves_purged_alone():
        # The startup healer re-flags a row only if its file exists; a purged
        # clip's file is gone, so it must stay purged.
        for r in clips.non_archived_recent(0):
            if r["message_uid"] == "sep05":
                derived = clip_store.storage_key("sep05", r.get("psn_created_at"))
                assert not clip_store.exists(derived)
    check("the archive-flag healer cannot revive purged clips", healer_leaves_purged_alone)

    def tool_triggers_only_when_published():
        calls = []
        real = clip_retention.run
        clip_retention.run = lambda **k: calls.append(1) or {"ok": True, "stub": True}
        try:
            caller = {"zitadel_id": "svc-muse", "label": "muse"}
            out = assistant._montage_record(caller, month="2026-07", clip_ids=None,
                                            ig_url="https://www.instagram.com/reel/Jul0000001/")
            assert not out.get("ok") and not calls, out     # no record yet
            month_montage.save_record("2026-07", "America/Los_Angeles", ["x"], None, None, None, "t")
            out = assistant._montage_record(caller, month="2026-07",
                                            ig_url="https://www.instagram.com/reel/Jul0000001/")
            assert out["ok"] and "retention" not in out and not calls, out
            out = assistant._montage_record(caller, month="2026-07",
                                            tiktok_url="https://www.tiktok.com/@crcmzclan/video/7400000000000000003")
            assert out["ok"] and out["retention"] == {"ok": True, "stub": True} and calls == [1], out
        finally:
            clip_retention.run = real
    check("montage_record runs retention once both links are in", tool_triggers_only_when_published)

    print("\n%d failed" % len(FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
