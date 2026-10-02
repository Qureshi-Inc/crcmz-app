#!/usr/bin/env python3
"""Friend video uploads: chunked upload, validation, dedupe, the one-queued guard,
the Muse-facing tools (pending list, per-platform record, skip), the WhatsApp
share-back, and the HTTP surface a member uses.

Needs ffmpeg and the app deps, so run it in the image:

    tests/run-all.sh test_video_uploads
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_tmp = Path(tempfile.mkdtemp(prefix="vu-test-"))
os.environ["VIDEO_UPLOADS_DB"] = str(_tmp / "video_uploads.db")
os.environ["VIDEO_UPLOADS_STAGING"] = str(_tmp / "staging")
os.environ["CLIP_LOCAL_DIR"] = str(_tmp / "clips")
os.environ.pop("CLIP_BUCKET", None)
os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ["PORTAL_PUBLIC_HOST"] = "app.crcmz.me"
os.environ["MCP_TOKEN"] = "test-mcp-token"

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
os.environ["WA_MAIN_JID"] = "group@g.us"

import assistant  # noqa: E402
import clip_store  # noqa: E402
import video_uploads as vu  # noqa: E402

vu.init()
CALLER = {"zitadel_id": "service:muse", "label": "Muse",
          "scopes": {"video_post_record", "video_post_skip"}}
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


def make_video(seconds: float, name: str, colour: str = "red") -> Path:
    out = _tmp / name
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"color=c={colour}:size=64x114:rate=10:duration={seconds}",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    str(out)], check=True)
    return out


def upload(zid, psn, path: Path, caption=None, chunk=None):
    """Drive the module the way the HTTP handlers do."""
    data = path.read_bytes()
    s = vu.start_session(zid, psn, path.name, len(data), caption)
    step = chunk or s["chunk_bytes"]
    for off in range(0, len(data), step):
        vu.append_chunk(s["upload_id"], zid, off, data[off:off + step])
    return vu.finish_session(s["upload_id"], zid, clip_store.archive_file)


def rejected(code, fn):
    try:
        fn()
    except vu.Rejected as e:
        assert e.code == code, (e.code, str(e))
        return str(e)
    raise AssertionError(f"expected Rejected({code})")


def call(tool, **args):
    out, _ = assistant.call_write_tool(tool, args, CALLER)
    return json.loads(out)


def read(tool, **args):
    out, ok = assistant.call_tool(tool, args)
    assert ok, out
    return json.loads(out)


V1 = make_video(4, "one.mp4")
V2 = make_video(5, "two.mov", "blue")
MINUTE_AND_HALF = make_video(91, "ninety-one.mp4", "green")
LONG = make_video(601, "long.mp4", "yellow")
SHORT = make_video(1, "short.mp4", "white")
STATE = {}


# ── upload + validation ───────────────────────────────────────────────────────
def t_happy_path_queues_and_archives():
    row = upload("zid-a", "ASamad89", V1, caption="  clutch   1v3 ", chunk=1000)
    STATE["a"] = row["video_post_id"]
    assert row["status"] == "queued" and row["psn_id"] == "ASamad89", row
    assert row["caption"] == "clutch 1v3", row["caption"]
    assert row["file_size_bytes"] == V1.stat().st_size
    assert 3.5 < row["duration_seconds"] < 4.5, row["duration_seconds"]
    stored = clip_store.CLIP_LOCAL_DIR / row["storage_key"]
    assert stored.read_bytes() == V1.read_bytes(), "archived bytes differ"
    assert row["storage_key"].startswith("clips/uploads/"), row["storage_key"]
    assert not list((_tmp / "staging").iterdir()), "staging not cleaned"


def t_second_queued_upload_rejected():
    msg = rejected("already_queued", lambda: vu.start_session("zid-a", "ASamad89", "x.mp4", 10, None))
    assert "hasn't been posted yet" in msg, msg


def t_duplicate_rejected_for_anyone():
    rejected("duplicate", lambda: upload("zid-b", "Mutasif", V1))


def t_no_size_cap():
    # Chunked upload carries any size; only the duration is capped.
    s = vu.start_session("zid-bigfile", "Big", "big.mp4", 5 * 1024 ** 3, None)
    assert s["size"] == 5 * 1024 ** 3 and s["received"] == 0, s


def t_over_90s_accepted():
    row = upload("zid-long", "LongPlayer", MINUTE_AND_HALF)
    assert row["status"] == "queued" and 90 < row["duration_seconds"] < 92, row
    vu.skip(row["video_post_id"], "test fixture")   # free the queue for later tests


def t_over_10_minutes_rejected():
    msg = rejected("too_long", lambda: upload("zid-b", "Mutasif", LONG))
    assert "600s" in msg, msg


def t_under_3s_rejected():
    rejected("too_short", lambda: upload("zid-b", "Mutasif", SHORT))


def t_wrong_format_rejected():
    rejected("format", lambda: vu.start_session("zid-b", "Mutasif", "x.avi", 10, None))
    junk = _tmp / "fake.mp4"
    junk.write_bytes(b"not a video at all" * 100)
    rejected("format", lambda: upload("zid-b", "Mutasif", junk))


def t_caption_limit():
    rejected("caption", lambda: vu.start_session("zid-b", "Mutasif", "x.mp4", 10, "x" * 151))


def t_chunk_offsets_enforced():
    s = vu.start_session("zid-b", "Mutasif", "two.mov", V2.stat().st_size, None)
    data = V2.read_bytes()
    vu.append_chunk(s["upload_id"], "zid-b", 0, data[:500])
    rejected("offset", lambda: vu.append_chunk(s["upload_id"], "zid-b", 0, data[:500]))
    rejected("no_session", lambda: vu.append_chunk(s["upload_id"], "zid-a", 500, data[500:]))
    rejected("incomplete", lambda: vu.finish_session(s["upload_id"], "zid-b",
                                                     clip_store.archive_file))


def t_resume_continues_from_what_arrived():
    data = V2.read_bytes()
    s = vu.start_session("zid-r", "Resumer", "two.mov", len(data), None, file_key="k-two")
    vu.append_chunk(s["upload_id"], "zid-r", 0, data[:700])
    # Page reloaded; iOS hands the same file back under another name.
    r = vu.start_session("zid-r", "Resumer", "IMG_9999.MOV", len(data), "late caption",
                         file_key="k-two")
    assert r["resumed"] and r["upload_id"] == s["upload_id"] and r["received"] == 700, r
    assert vu.open_session("zid-r")["received"] == 700
    # A crash after the write but before the counter update leaves extra bytes.
    with open(vu._staged(s["upload_id"]), "ab") as fh:
        fh.write(b"garbage-from-a-half-written-chunk")
    r = vu.start_session("zid-r", "Resumer", "two.mov", len(data), None, file_key="k-two")
    assert r["received"] == 700 and vu._staged(s["upload_id"]).stat().st_size == 700
    try:
        vu.append_chunk(s["upload_id"], "zid-r", 0, data[:700])
    except vu.Rejected as e:
        assert e.code == "offset" and e.extra == {"received": 700}, (e.code, e.extra)
    else:
        raise AssertionError("replayed chunk accepted")
    vu.append_chunk(s["upload_id"], "zid-r", 700, data[700:])
    row = vu.finish_session(s["upload_id"], "zid-r", clip_store.archive_file)
    assert (clip_store.CLIP_LOCAL_DIR / row["storage_key"]).read_bytes() == data, "bytes differ"
    assert row["storage_key"].endswith(".mov"), row["storage_key"]
    assert vu.open_session("zid-r") is None
    STATE["resumed"] = row["video_post_id"]
    vu.skip(row["video_post_id"], "test")          # free the member and the bytes' twin slot
    with vu._conn() as db:                         # so later tests can reuse V2
        db.execute("DELETE FROM video_posts WHERE video_post_id=?", (row["video_post_id"],))


def t_different_file_replaces_the_open_session():
    s = vu.start_session("zid-r", "Resumer", "a.mp4", 5000, None, file_key="k-a")
    vu.append_chunk(s["upload_id"], "zid-r", 0, b"x" * 100)
    r = vu.start_session("zid-r", "Resumer", "b.mp4", 5000, None, file_key="k-b")
    assert not r["resumed"] and r["upload_id"] != s["upload_id"], r
    assert not vu._staged(s["upload_id"]).exists(), "old staging file left behind"
    r2 = vu.start_session("zid-r", "Resumer", "b.mp4", 5000, None)  # no key: never resumes
    assert not r2["resumed"], r2


def t_abandoned_uploads_expire_after_24h():
    s = vu.open_session("zid-r")
    with vu._conn() as db:
        db.execute("UPDATE upload_sessions SET created_at=created_at-? WHERE zitadel_id=?",
                   (23 * 3600, "zid-r"))
    vu.sweep_stale()
    assert vu.open_session("zid-r"), "swept before 24h"
    with vu._conn() as db:
        db.execute("UPDATE upload_sessions SET created_at=created_at-? WHERE zitadel_id=?",
                   (2 * 3600, "zid-r"))
    assert vu.open_session("zid-r") is None, "expired session still offered"
    vu.sweep_stale()
    assert not vu._staged(s["upload_id"]).exists()
    with vu._conn() as db:
        assert db.execute("SELECT COUNT(*) FROM upload_sessions").fetchone()[0] <= 1


def t_read_tool_does_not_sweep():
    s = vu.start_session("zid-sw", "Sweeper", "a.mp4", 5000, None)
    with vu._conn() as db:
        db.execute("UPDATE upload_sessions SET created_at=0 WHERE upload_id=?", (s["upload_id"],))
    read("pending_video_uploads")
    assert vu._staged(s["upload_id"]).exists(), "the read tool deleted a file"
    vu.sweep_stale()


# ── Muse-facing tools ─────────────────────────────────────────────────────────
def t_pending_lists_roster_psn_and_media_url():
    page = read("pending_video_uploads")
    assert page["total"] == 1, page
    item = page["items"][0]
    assert item["video_post_id"] == STATE["a"] and item["uploader_psn_id"] == "ASamad89"
    assert item["media_url"] == ("https://app.crcmz.me/api/video-uploads/media?id=" + STATE["a"])
    assert item["missing_platforms"] == ["instagram", "tiktok", "youtube"], item
    assert "zitadel_id" not in item and "storage_key" not in item, sorted(item)
    assert item["sha256"] and item["file_size_bytes"] and item["duration_seconds"]


def t_bad_links_refused():
    r = call("video_post_record", video_post_id=STATE["a"], platform="instagram",
             url="https://www.instagram.com/reel/17894952330419326/")
    assert not r["ok"] and "numeric" in r["error"], r
    r = call("video_post_record", video_post_id=STATE["a"], platform="tiktok",
             url="https://vm.tiktok.com/ZMabc/")
    assert not r["ok"], r
    r = call("video_post_record", video_post_id=STATE["a"], platform="myspace", url="x")
    assert not r["ok"], r


def t_instagram_record_notifies_once():
    SENT.clear()
    r = call("video_post_record", video_post_id=STATE["a"], platform="instagram",
             url="https://instagram.com/reel/Dd0w-8rDgb7?igsh=x", media_id="17894952330419326")
    assert r["ok"] and r["status"] == "queued" and r["group_notified"], r
    assert r["missing_platforms"] == ["tiktok", "youtube"], r
    assert len(SENT) == 1 and "ASamad89" in SENT[0]["message"], SENT
    assert "https://www.instagram.com/reel/Dd0w-8rDgb7/" in SENT[0]["message"], SENT
    r = call("video_post_record", video_post_id=STATE["a"], platform="instagram",
             url="https://www.instagram.com/reel/Dd0w-8rDgb7/")
    assert r["ok"] and r["changed"] is False and not r["group_notified"], r
    assert len(SENT) == 1, "second record re-announced"
    assert vu.get(STATE["a"])["platforms"]["instagram"]["media_id"] == "17894952330419326", \
        "a repeat without media_id must not erase it"


def t_uploader_cannot_withdraw_once_live():
    rejected("posting", lambda: vu.skip(STATE["a"], "withdrawn by you", only_if_unposted=True))


def t_incremental_records_flip_posted_exactly_once():
    r = call("video_post_record", video_post_id=STATE["a"], platform="tiktok",
             url="https://www.tiktok.com/@crcmzclan/video/7420000000000000001?lang=en")
    assert r["ok"] and r["status"] == "queued", r
    r = call("video_post_record", video_post_id=STATE["a"], platform="youtube",
             url="https://youtube.com/shorts/abcdefghijk?feature=share", media_id="abcdefghijk")
    assert r["ok"] and r["status"] == "posted" and r["missing_platforms"] == [], r
    row = vu.get(STATE["a"])
    first = row["posted_at"]
    assert row["platforms"]["tiktok"]["url"] == \
        "https://www.tiktok.com/@crcmzclan/video/7420000000000000001"
    assert row["platforms"]["instagram"]["url"] == "https://www.instagram.com/reel/Dd0w-8rDgb7/"
    # A correction replaces one platform's link and leaves status and the others alone.
    r = call("video_post_record", video_post_id=STATE["a"], platform="youtube",
             url="https://www.youtube.com/watch?v=zyxwvutsrqp")
    assert r["ok"] and r["changed"] and r["replaced_url"].endswith("abcdefghijk"), r
    row = vu.get(STATE["a"])
    assert row["status"] == "posted" and row["posted_at"] == first
    assert row["platforms"]["tiktok"] and row["platforms"]["instagram"]
    assert read("pending_video_uploads")["total"] == 0


def t_posted_frees_the_member_and_cannot_be_skipped():
    r = call("video_post_skip", video_post_id=STATE["a"], reason="nah")
    assert not r["ok"] and "posted" in r["error"], r
    row = upload("zid-a", "ASamad89", V2)
    STATE["b"] = row["video_post_id"]


def t_skip_is_idempotent_and_blocks_records():
    r = call("video_post_skip", video_post_id=STATE["b"], reason="  audio is\ncopyrighted ")
    assert r["ok"] and r["already_skipped"] is False and r["reason"] == "audio is copyrighted", r
    r = call("video_post_skip", video_post_id=STATE["b"], reason="something else")
    assert r["ok"] and r["already_skipped"] and r["reason"] == "audio is copyrighted", r
    r = call("video_post_record", video_post_id=STATE["b"], platform="instagram",
             url="https://www.instagram.com/reel/Dd0w-8rDgb8/")
    assert not r["ok"] and "skipped" in r["error"], r
    r = call("video_post_skip", video_post_id=STATE["b"], reason="")
    assert not r["ok"], r


def t_skipped_video_still_counts_as_duplicate():
    msg = rejected("duplicate", lambda: upload("zid-c", "Zubi", V2))
    assert "skipped" in msg, msg


def t_registry_split():
    assert "pending_video_uploads" in assistant.tool_names()
    for w in ("video_post_record", "video_post_skip"):
        assert w in assistant.write_tool_names() and w not in assistant.tool_names(), w


def t_service_scope_via_mcp():
    import mcp_server
    other = {"zitadel_id": "service:x", "label": "X", "scopes": {"ig_post_record"}}
    reply = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                               "params": {"name": "video_post_skip",
                                          "arguments": {"video_post_id": "x", "reason": "y"}}},
                              other)
    assert reply["result"]["isError"] and "scope" in reply["result"]["content"][0]["text"], reply
    reply = mcp_server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                               "params": {"name": "video_post_skip",
                                          "arguments": {"video_post_id": "x", "reason": "y"}}},
                              None)
    assert reply["result"]["isError"], "shared read token reached a write tool"


# ── HTTP ──────────────────────────────────────────────────────────────────────
def http_tests():
    from fastapi.testclient import TestClient
    import crcmz_identity
    import server

    people = {"zid-h": {"zitadel_id": "zid-h", "psn_id": "Moiz_07"},
              "zid-nopsn": {"zitadel_id": "zid-nopsn", "psn_id": ""}}
    crcmz_identity.by_zitadel_id = lambda **k: people
    server.portal_mod.find_by_zitadel_id = lambda z: None
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    ORIGIN = {"Origin": "https://app.crcmz.me"}

    def login(sub):
        client.cookies.clear()
        client.cookies.set(server._SESSION_COOKIE, server._signer().dumps(
            {"sub": sub, "iss": "https://auth.crcmz.me", "email": "x@crcmz.me"}))

    def t_unauthenticated_rejected():
        client.cookies.clear()
        assert client.get("/api/video-uploads/mine").status_code == 401
        r = client.post("/api/video-uploads/start", headers=ORIGIN,
                        json={"filename": "a.mp4", "size": 10})
        assert r.status_code == 401, r.text
        r = client.put("/api/video-uploads/chunk?id=%s&offset=0" % ("0" * 32),
                       headers=ORIGIN, content=b"x")
        assert r.status_code == 401, r.text
        r = client.post("/api/video-uploads/finish", headers=ORIGIN, json={"upload_id": "x"})
        assert r.status_code == 401, r.text

    def t_unlinked_member_refused():
        login("zid-nopsn")
        r = client.get("/api/video-uploads/mine")
        assert r.status_code == 403 and "PSN" in r.json()["detail"], r.text

    def t_cross_origin_refused():
        login("zid-h")
        r = client.post("/api/video-uploads/start", headers={"Origin": "https://evil.example"},
                        json={"filename": "a.mp4", "size": 10})
        assert r.status_code == 403, r.text

    V3 = make_video(6, "three.mp4", "yellow")

    def t_full_upload_through_http():
        login("zid-h")
        data = V3.read_bytes()
        s = client.post("/api/video-uploads/start", headers=ORIGIN,
                        json={"filename": "three.mp4", "size": len(data), "caption": "gg"}).json()
        half = len(data) // 2
        for off, part in ((0, data[:half]), (half, data[half:])):
            r = client.put(f"/api/video-uploads/chunk?id={s['upload_id']}&offset={off}",
                           headers=ORIGIN, content=part)
            assert r.status_code == 200, r.text
        r = client.post("/api/video-uploads/finish", headers=ORIGIN,
                        json={"upload_id": s["upload_id"]})
        assert r.status_code == 200 and r.json()["upload"]["status"] == "queued", r.text
        STATE["h"] = r.json()["upload"]["video_post_id"]
        mine = client.get("/api/video-uploads/mine").json()
        assert mine["psn_id"] == "Moiz_07" and mine["can_upload"] is False, mine
        assert "storage_key" not in json.dumps(mine) and "sha256" not in json.dumps(mine)
        r = client.post("/api/video-uploads/start", headers=ORIGIN,
                        json={"filename": "b.mp4", "size": 10})
        assert r.status_code == 409 and "hasn't been posted yet" in r.json()["detail"], r.text

    def t_resume_over_http():
        people["zid-res"] = {"zitadel_id": "zid-res", "psn_id": "Res"}
        login("zid-res")
        data = make_video(7, "four.mp4", "purple").read_bytes()
        body = {"filename": "four.mp4", "size": len(data), "file_key": "k-four"}
        s = client.post("/api/video-uploads/start", headers=ORIGIN, json=body).json()
        assert s["received"] == 0 and not s["resumed"], s
        assert client.put(f"/api/video-uploads/chunk?id={s['upload_id']}&offset=0",
                          headers=ORIGIN, content=data[:1000]).status_code == 200
        r = client.put(f"/api/video-uploads/chunk?id={s['upload_id']}&offset=0",
                       headers=ORIGIN, content=data[:1000])
        assert r.status_code == 409 and r.json()["received"] == 1000, r.text
        mine = client.get("/api/video-uploads/mine").json()
        assert mine["open_session"]["received"] == 1000, mine["open_session"]
        s2 = client.post("/api/video-uploads/start", headers=ORIGIN, json=body).json()
        assert s2["resumed"] and s2["received"] == 1000 and s2["upload_id"] == s["upload_id"], s2
        assert client.put(f"/api/video-uploads/chunk?id={s['upload_id']}&offset=1000",
                          headers=ORIGIN, content=data[1000:]).status_code == 200
        r = client.post("/api/video-uploads/finish", headers=ORIGIN,
                        json={"upload_id": s["upload_id"]})
        assert r.status_code == 200, r.text

    def t_over_200mb_accepted_over_http():
        people["zid-big"] = {"zitadel_id": "zid-big", "psn_id": "Big"}
        login("zid-big")
        r = client.post("/api/video-uploads/start", headers=ORIGIN,
                        json={"filename": "a.mp4", "size": 200 * 1024 * 1024 + 1})
        assert r.status_code == 200 and r.json()["size"] == 200 * 1024 * 1024 + 1, r.text
        r = client.put(f"/api/video-uploads/chunk?id={'0' * 32}&offset=0", headers=ORIGIN,
                       content=b"x" * (vu.CHUNK_BYTES + 1))
        assert r.status_code == 413, r.status_code

    def t_media_needs_a_bearer():
        client.cookies.clear()
        url = f"/api/video-uploads/media?id={STATE['h']}"
        assert client.get(url).status_code == 401
        login("zid-h")  # a session cookie is not a bearer
        assert client.get(url).status_code == 401
        client.cookies.clear()
        r = client.get(url, headers={"Authorization": "Bearer test-mcp-token"})
        assert r.status_code == 200 and r.content == V3.read_bytes(), r.status_code
        assert r.headers["content-type"].startswith("video/mp4")

    def t_withdraw_own_queued_only():
        login("zid-big")
        r = client.post("/api/video-uploads/withdraw", headers=ORIGIN,
                        json={"video_post_id": STATE["h"]})
        assert r.status_code == 404, "withdrew someone else's video"
        login("zid-h")
        r = client.post("/api/video-uploads/withdraw", headers=ORIGIN,
                        json={"video_post_id": STATE["h"]})
        assert r.status_code == 200 and r.json()["upload"]["status"] == "skipped", r.text
        assert r.json()["upload"]["skip_reason"] == "withdrawn by you"
        assert client.get("/api/video-uploads/mine").json()["can_upload"] is True

    def t_upload_section_lives_in_clips():
        login("zid-h")
        html = client.get("/", headers={"Accept": "text/html"}).text
        clips = html.index('id="p-pipeline"')
        assert clips < html.index('id="clips-upload"') < html.index('id="reels-inner"')
        assert 'data-p="upload"' not in html, "upload should not be its own menu item"

    for n, f in list(locals().items()):
        if n.startswith("t_"):
            check("http/" + n[2:], f)


def main():
    print("video uploads")
    for n, f in list(globals().items()):
        if n.startswith("t_") and callable(f):
            check(n[2:], f)
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
