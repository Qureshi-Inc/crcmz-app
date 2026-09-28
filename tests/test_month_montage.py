#!/usr/bin/env python3
"""Month-end montage: every clip of a month with its exclusion reasons, batch
media URLs, a balanced proposal, and the montage_record round-trip.

Reel Review's veto list is served by a local HTTPServer so the real httpx path
runs. Plain asserts, no pytest:

  docker run --rm -e SESSION_SECRET=test -v "$PWD/tests:/app/tests" crcmz-app:test \
    python tests/test_month_montage.py
"""
import json
import os
import sqlite3
import sys
import tempfile
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_tmp = Path(tempfile.mkdtemp())
os.environ["IG_POSTS_DB"] = str(_tmp / "ig_posts.db")
os.environ["WA_REACTIONS_DB"] = str(_tmp / "wa_reactions.db")
os.environ["MONTAGE_RECORDS_DB"] = str(_tmp / "montage_records.db")
os.environ["REEL_REVIEW_TOKEN"] = "rr-test-token"

VETOES = [{"clip_id": "app-veto", "at": 1.0, "reason": "", "source": "app"}]
SERVE_VETOES = {"ok": True}


class _RR(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        ok = (self.path == "/api/vetoes" and SERVE_VETOES["ok"]
              and self.headers.get("X-App-Token") == "rr-test-token")
        body = json.dumps(VETOES if ok else {"detail": "no"}).encode()
        self.send_response(200 if ok else 503)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


_srv = HTTPServer(("127.0.0.1", 0), _RR)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
os.environ["REEL_REVIEW_URL"] = "http://127.0.0.1:%d" % _srv.server_port

import assistant  # noqa: E402
import clips  # noqa: E402
import ig_posts  # noqa: E402
import mcp_oauth  # noqa: E402
import month_montage  # noqa: E402
import wa_reactions  # noqa: E402

clips._DB_PATH = _tmp / "clips.db"
mcp_oauth.DB_PATH = _tmp / "mcp_user_tokens.db"
FAILED = []
LA = ZoneInfo("America/Los_Angeles")
CALLER = {"zitadel_id": "service:test", "label": "muse"}


def at(day, hour=12, month=9):
    return datetime(2026, month, day, hour, tzinfo=LA).timestamp()


# clip_id: (sender, body, when, sha256, archived, montage_eligible)
SEED = {
    "fire-1":    ("moiiz41510", "🔥", at(2), "s-fire1", True, 1),
    "fire-2":    ("ASamad89", "D with a clutch 🔥", at(3), "s-fire2", True, 1),
    "fail-1":    ("mutasif", "😂", at(4), "s-fail1", True, 1),
    "fail-2":    ("ASamad89", "Suss new homie 🤣", at(5), "s-fail2", True, 1),
    "plain-1":   ("ASamad89", "Cross Map 💪🏼", at(6), "s-plain1", True, 1),
    "plain-2":   ("BrendanSoup", None, at(7), "s-plain2", True, 1),
    "plain-3":   ("ASamad89", None, at(8), "s-plain3", True, 1),
    "plain-4":   ("ASamad89", None, at(9), "s-plain4", True, 1),
    "revenge":   ("nooramin40", "revenge kill", at(10), "s-revenge", True, 1),
    "rev":       ("ASamad89", "Rev", at(11), "s-rev", True, 0),
    "coach-only": ("ASamad89", None, at(12), "s-co", True, 0),
    "app-veto":  ("mutasif", "🔥", at(13), "s-appveto", True, 1),
    "wa-veto":   ("mutasif", None, at(14), "s-waveto", True, 1),
    "veto-twin": ("mutasif", None, at(15), "s-appveto", True, 1),
    "twin-a":    ("BrendanSoup", "😂", at(16), "s-twin", True, 1),
    "twin-b":    ("BrendanSoup", "😂", at(17), "s-twin", True, 1),
    "failed":    ("ASamad89", None, at(18), None, False, 1),
    "posted":    ("moiiz41510", "🔥", at(19), "s-posted", True, 1),
    # Month edges are LA local midnight: 1 Oct 01:00 UTC is still 30 Sep in LA.
    "edge-in":   ("mutasif", None, datetime(2026, 10, 1, 1, tzinfo=ZoneInfo("UTC")).timestamp(),
                  "s-edge", True, 1),
    "october":   ("mutasif", None, at(2, month=10), "s-oct", True, 1),
    "august":    ("mutasif", None, at(20, month=8), "s-aug", True, 1),
}
SEPT = [k for k in SEED if k not in ("october", "august")]


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


def seed():
    clips.init(); ig_posts.init(); wa_reactions.init(); month_montage.init(); mcp_oauth.init()
    with sqlite3.connect(clips._DB_PATH) as db:
        for i, (cid, (sender, body, when, sha, arch, elig)) in enumerate(SEED.items()):
            db.execute(
                "INSERT INTO clips (message_uid, ugc_id, psn_group_id, sender_online_id, psn_created_at,"
                " discovered_at, status, archive_status, storage_key_original, duration_seconds, file_size,"
                " sha256, body, montage_eligible, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (cid, f"u{i}", "g", sender, when, when, "delivered" if arch else "failed",
                 "archived" if arch else "not_archived", f"clips/{cid}.mp4" if arch else None,
                 20.0 + i, 1000 + i, sha, body, elig, when, when))
    pid = ig_posts.claim_for_post("posted", "moiiz41510")
    ig_posts.submit_post(pid, "https://www.instagram.com/reel/Posted0001/")
    wa_reactions.track_clip("wa-veto", "wa-msg-1")
    wa_reactions.update_reaction({"target_msg_id": "wa-msg-1", "reactor_jid": "a@s", "emoji": "🛑"})


def read_tool(name, args):
    return json.loads(assistant.call_tool(name, args)[0])


def write_tool(name, args, caller):
    return json.loads(assistant.call_write_tool(name, args, caller)[0])


def rows_by_id(month="2026-09"):
    out, offset = {}, 0
    while offset is not None:
        page = read_tool("month_clips", {"month": month, "limit": 5, "offset": offset})
        out.update({c["clip_id"]: c for c in page["clips"]})
        offset = page["next_offset"]
    return out, page


def codes(row):
    return {r["code"] for r in row["excluded_reasons"]}


def test_month_clips_paginates_every_september_clip():
    rows, last = rows_by_id()
    assert set(rows) == set(SEPT), sorted(set(rows) ^ set(SEPT))
    assert last["total"] == len(SEPT) and last["has_more"] is False
    assert last["timezone"] == "America/Los_Angeles" and last["veto_list_available"] is True
    whens = [rows[k]["when"] for k in SEPT]
    assert whens == sorted(whens), "oldest first"


def test_exclusion_reasons():
    rows, last = rows_by_id()
    want = {
        "rev": {"rev_coaching"}, "coach-only": {"rev_coaching"},
        "app-veto": {"vetoed"}, "wa-veto": {"vetoed"},
        "veto-twin": {"vetoed", "twin"}, "twin-b": {"twin"}, "failed": {"not_archived"},
    }
    for cid, exp in want.items():
        assert codes(rows[cid]) == exp, (cid, rows[cid]["excluded_reasons"])
        assert rows[cid]["eligible"] is False
    eligible = {k for k, r in rows.items() if r["eligible"]}
    assert eligible == set(SEPT) - set(want), eligible
    assert rows["twin-b"]["twin_of"] == "twin-a" and rows["twin-a"]["eligible"]
    assert rows["revenge"]["eligible"], "'revenge' is not a rev trigger"
    assert rows["posted"]["eligible"] and rows["posted"]["pipeline_state"] == "posted"
    assert last["eligible_count"] == len(eligible)
    assert rows["fire-1"]["sha256"] == "s-fire1" and rows["fire-1"]["file_size_bytes"] == 1000
    assert rows["fire-2"]["category"] == "win" and rows["fail-2"]["category"] == "fail"
    assert rows["plain-1"]["category"] == "untagged"


def test_veto_list_unavailable_fails_closed():
    SERVE_VETOES["ok"] = False
    try:
        rows, last = rows_by_id()
        assert last["veto_list_available"] is False
        assert not any(r["eligible"] for r in rows.values())
        res = write_tool("montage_record", {"month": "2026-09", "clip_ids": ["fire-1"]}, CALLER)
        assert res["ok"] is False and any(p["code"] == "veto_list_unavailable" for p in res["problems"])
    finally:
        SERVE_VETOES["ok"] = True


def test_bad_month_and_timezone():
    r = read_tool("month_clips", {"month": "Sept"})
    assert "error" in r
    r = read_tool("month_clips", {"month": "2026-09", "timezone": "Mars/Base"})
    assert "error" in r
    r = read_tool("month_clips", {"month": "2026-09", "timezone": "UTC"})
    assert "edge-in" not in {c["clip_id"] for c in r["clips"]}, "UTC month ends before 1 Oct 01:00 UTC"


def test_clip_media_urls_batch():
    r = read_tool("clip_media_urls", {"clip_ids": ["fire-1", "failed", "nope", "fire-1"]})
    assert r["count"] == 3 and r["with_media"] == 1, r
    first = r["clips"][0]
    assert first["clip_id"] == "fire-1" and first["url"].endswith("uid=fire-1")
    assert first["sha256"] == "s-fire1" and first["file_size_bytes"] == 1000
    assert "error" in r["clips"][1] and "error" in r["clips"][2]
    too_many = read_tool("clip_media_urls", {"clip_ids": [str(i) for i in range(21)]})
    assert "error" in too_many
    single = read_tool("clip_media_url", {"clip_id": "fire-1"})
    assert single["sha256"] == "s-fire1" and single["file_size_bytes"] == 1000


def test_eligible_clips_carries_hash_and_size():
    r = read_tool("eligible_clips", {"limit": 20})
    row = next(c for c in r["clips"] if c["clip_id"] == "fire-1")
    assert row["sha256"] == "s-fire1" and row["file_size_bytes"] == 1000


def test_proposal_balances_senders_and_categories():
    r = read_tool("montage_proposal",
                                       {"month": "2026-09", "target_count": 8, "max_sender_share": 0.25,
                                        "labels": {"plain-2": "goop"}})
    assert r["selected_columns"][0] == "clip_id"
    sel = [c[0] for c in r["selected"]]
    assert len(sel) == len(set(sel)) <= 8
    assert max(r["by_sender"].values()) <= r["max_per_sender"] == 2, r["by_sender"]
    rows, _ = rows_by_id()
    assert all(rows[c]["eligible"] for c in sel), "a proposal only draws from eligible clips"
    assert {"win", "fail", "goop"} <= set(r["by_category"]), r["by_category"]
    assert r["category_quotas"].keys() == {"win", "fail", "goop"}
    whens = [c[2] for c in r["selected"]]
    assert whens == sorted(whens)
    # Cap of 1 per sender with 5 senders present -> at most 5 picks, reported as shortfall.
    r = read_tool("montage_proposal",
                                       {"month": "2026-09", "target_count": 20, "max_sender_share": 0.05})
    assert max(r["by_sender"].values()) == 1 and r["shortfalls"].get("total", 0) > 0


def test_montage_record_refuses_excluded_clips():
    bad = ["fire-1", "app-veto", "rev", "failed", "twin-a", "twin-b", "october"]
    res = write_tool("montage_record", {"month": "2026-09", "clip_ids": bad}, CALLER)
    assert res["ok"] is False
    got = {(p["clip_id"], p["code"]) for p in res["problems"]}
    for want in (("app-veto", "vetoed"), ("rev", "rev_coaching"), ("failed", "not_archived"),
                 ("twin-b", "twin"), ("october", "not_in_month")):
        assert want in got, (want, got)
    assert not any(p["clip_id"] == "fire-1" for p in res["problems"])
    assert month_montage.get_record("2026-09") is None, "a refused selection saves nothing"


def test_montage_record_round_trip():
    pick = ["fire-1", "fail-1", "twin-b", "posted"]   # twin-b alone is fine: one copy of that video
    res = write_tool("montage_record",
                                               {"month": "2026-09", "clip_ids": pick,
                                                "notes": "trending sound"}, CALLER)
    assert res["ok"], res
    res = write_tool("montage_record",
                                               {"month": "2026-09",
                                                "ig_url": "https://www.instagram.com/reel/Abc123/"}, CALLER)
    assert res["ok"], res
    res = write_tool("montage_record",
                                               {"month": "2026-09",
                                                "tiktok_url": "https://www.tiktok.com/@crcmzclan/video/1"}, CALLER)
    rec = read_tool("montage_records", {"month": "2026-09"})
    assert rec["clip_ids"] == pick and rec["notes"] == "trending sound"
    assert rec["ig_url"].endswith("/Abc123/") and rec["tiktok_url"].endswith("/video/1")
    assert rec["recorded_by"] == "muse" and rec["timezone"] == "America/Los_Angeles"
    listed = read_tool("montage_records", {})
    assert [(r["month"], r["clip_count"]) for r in listed] == [("2026-09", 4)]
    bad = write_tool("montage_record",
                                               {"month": "2026-09", "ig_url": "https://evil.example/instagram.com"},
                                               CALLER)
    assert bad["ok"] is False and "ig_url" in bad["fields"]
    assert write_tool("montage_record", {"month": "2026-08"}, CALLER)["ok"] is False


def test_recorded_clips_count_as_used_in_other_months():
    # An October twin of a September-used clip is excluded from October.
    with sqlite3.connect(clips._DB_PATH) as db:
        db.execute("UPDATE clips SET sha256='s-fire1' WHERE message_uid='october'")
    rows, _ = rows_by_id("2026-10")
    assert codes(rows["october"]) == {"used_in_montage"}, rows["october"]["excluded_reasons"]
    # ...but re-saving September's own record does not trip over itself.
    res = write_tool("montage_record",
                                               {"month": "2026-09", "clip_ids": ["fire-1", "fail-1"]}, CALLER)
    assert res["ok"], res


def test_registry_placement():
    names = set(assistant.tool_names())
    assert {"month_clips", "clip_media_urls", "montage_proposal", "montage_records"} <= names
    assert "montage_record" in assistant.write_tool_names()
    assert "montage_record" not in names, "the write tool must not be in the read registry"
    banned = ("send", "post", "delete", "write", "create", "set_", "update", "remove")
    for n in ("month_clips", "clip_media_urls", "montage_proposal", "montage_records"):
        assert not any(b in n for b in banned), n


def test_pages_fit_the_tool_budget():
    # A big page is trimmed to whole rows that fit, and next_offset resumes exactly.
    with sqlite3.connect(clips._DB_PATH) as db:
        for i in range(60):
            db.execute(
                "INSERT INTO clips (message_uid, ugc_id, psn_group_id, sender_online_id, psn_created_at,"
                " discovered_at, status, archive_status, storage_key_original, duration_seconds, file_size,"
                " sha256, body, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"15#4583{i:08d}", f"bulk{i}", "g", "BrendanSoup", at(25) + i, at(25) + i, "delivered",
                 "archived", f"clips/b{i}.mp4", 12.5, 5000 + i, "%064x" % i, "long-ish caption " * 5,
                 at(25), at(25)))
    seen, offset, pages = [], 0, 0
    while offset is not None:
        raw, _ = assistant.call_tool("month_clips", {"month": "2026-09", "limit": 50, "offset": offset})
        assert len(raw) <= assistant.MAX_TOOL_CHARS and "truncated at" not in raw
        page = json.loads(raw)
        seen += [c["clip_id"] for c in page["clips"]]
        offset, pages = page["next_offset"], pages + 1
    assert len(seen) == len(set(seen)) == len(SEPT) + 60 and pages > 1, (len(seen), pages)
    ids = [f"15#4583{i:08d}" for i in range(20)]
    raw, _ = assistant.call_tool("clip_media_urls", {"clip_ids": ids})
    assert "truncated at" not in raw and json.loads(raw)["with_media"] == 20
    raw, _ = assistant.call_tool("montage_proposal", {"month": "2026-09", "target_count": 60,
                                                      "max_sender_share": 1})
    assert "truncated at" not in raw and len(json.loads(raw)["selected"]) == 60


def test_limits_are_clamped():
    r = read_tool("month_clips", {"month": "2026-09", "limit": 10000})
    assert len(r["clips"]) <= 50
    r = read_tool("montage_proposal", {"month": "2026-09", "target_count": 10000})
    assert r["target_count"] == 60


if __name__ == "__main__":
    seed()
    print("month_montage")
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name, fn)
    _srv.shutdown()
    if FAILED:
        print("\n%d failed" % len(FAILED))
        sys.exit(1)
    print("\nall passed")
