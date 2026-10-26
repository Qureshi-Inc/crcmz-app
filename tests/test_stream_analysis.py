#!/usr/bin/env python3
"""Stream analysis: the ON/OFF gate, sample caps, Muse's records, and the MCP surface.

Plain asserts, no pytest — run inside the app image:

    tests/run-all.sh test_stream_analysis
"""

import base64
import json
import os
import sys
import tempfile

os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
_TMP = tempfile.mkdtemp()
os.environ["STREAM_ANALYSIS_DB"] = os.path.join(_TMP, "stream_analysis.db")
os.environ["CRCMZ_SERVICE_TOKENS"] = (
    "streamproxy:proxy-token-abcdefghij:stream_sample_add,stream_analysis_toggle;"
    "muse:muse-token-abcdefghij:stream_analysis_record")

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


import assistant  # noqa: E402
import crcmz_identity  # noqa: E402
import mcp_oauth  # noqa: E402
import mcp_server  # noqa: E402
import stream_analysis as sa  # noqa: E402

try:
    mcp_oauth.init()
except Exception:  # noqa: BLE001
    pass
sa.init()

# Synthetic people only: the identity graph is stubbed, nothing real is touched.
PEOPLE = {
    "zid-streamer": {"zitadel_id": "zid-streamer", "display_name": "Streamer", "psn_id": "test_streamer"},
    "zid-friend": {"zitadel_id": "zid-friend", "display_name": "Friend", "psn_id": "test_friend"},
}
crcmz_identity.resolve = lambda w, **k: PEOPLE.get(w) or next(
    (p for p in PEOPLE.values() if w in (p["psn_id"], p["display_name"])), None)
crcmz_identity.by_zitadel_id = lambda **k: PEOPLE

ME = {"zitadel_id": "zid-streamer"}                         # a personal token
PROXY = mcp_server.resolve_service("Bearer proxy-token-abcdefghij")
MUSE = mcp_server.resolve_service("Bearer muse-token-abcdefghij")
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
B64 = lambda b: base64.b64encode(b).decode()  # noqa: E731


def w(name, args, caller=ME):
    text, ok = assistant.call_write_tool(name, args, caller)
    assert ok, text
    return json.loads(text)


def r(name, args):
    text, ok = assistant.call_tool(name, args)
    assert ok, text
    return json.loads(text)


def count_samples():
    with sa._conn() as db:
        return db.execute("SELECT COUNT(*) AS n FROM samples").fetchone()["n"]


def chat(session="s1", text="gg", caller=ME, **extra):
    return w("stream_sample_add", {"session_id": session, "type": "chat",
                                   "timestamp": "2026-10-26T20:00:00-07:00", "text": text, **extra},
             caller)


def off_by_default_rejects_and_stores_nothing():
    st = r("stream_analysis_status", {"person": "test_streamer"})
    assert st["enabled"] is False, st
    out = chat()
    assert out == {"ok": False, "error": "analysis is off", "enabled": False}, out
    assert count_samples() == 0
    with mcp_oauth._connect() as db:
        n = db.execute("SELECT COUNT(*) FROM write_audit WHERE tool='stream_sample_add'").fetchone()[0]
    assert n == 0, "an OFF sample left an audit row"


def on_accepts_and_lists():
    out = w("stream_analysis_toggle", {})
    assert out["ok"] and out["enabled"] is True and out["state"] == "ON", out
    assert r("stream_analysis_status", {"person": "test_streamer"})["enabled"] is True
    c = chat(text="nice shot")
    f = w("stream_sample_add", {"session_id": "s1", "type": "frame", "timestamp": 1792990000,
                                "image_base64": B64(JPEG), "mime": "image/jpeg"})
    e = w("stream_sample_add", {"session_id": "s1", "type": "event", "timestamp": 1792990001000,
                                "event": {"kind": "death", "by": "sniper"}})
    assert c["ok"] and f["ok"] and e["ok"], (c, f, e)
    assert e["ts"] == 1792990001.0, e
    got = r("stream_samples", {"session_id": "s1"})
    types = [s["type"] for s in got["samples"]]
    assert types == ["chat", "frame", "event"], got
    frame = got["samples"][1]
    assert frame["image"] == {"mime": "image/jpeg", "bytes": len(JPEG)}, frame
    assert "data" not in json.dumps(frame), "listing must not carry image bytes"
    assert got["samples"][2]["event"] == {"kind": "death", "by": "sniper"}


def toggle_off_stops_acceptance():
    out = w("stream_analysis_toggle", {"enabled": False})
    assert out["enabled"] is False, out
    before = count_samples()
    assert chat()["ok"] is False
    assert count_samples() == before
    assert w("stream_analysis_toggle", {"enabled": True})["enabled"] is True


def bad_samples_rejected():
    n = count_samples()
    bad = [
        {"type": "frame", "image_base64": B64(b"GIF89a" + b"\x00" * 20)},          # not JPEG/PNG
        {"type": "frame", "image_base64": B64(PNG), "mime": "image/jpeg"},         # mime lies
        {"type": "frame", "image_base64": B64(b"\xff\xd8\xff" + b"\x00" * (sa.MAX_IMAGE_BYTES + 1))},
        {"type": "frame", "image_base64": "%%%not base64%%%"},
        {"type": "frame"},
        {"type": "chat", "text": ""},
        {"type": "chat", "text": "x" * (sa.MAX_TEXT_CHARS + 1)},
        {"type": "event", "event": "not json"},
        {"type": "event", "event": {"blob": "x" * sa.MAX_EVENT_BYTES}},
        {"type": "video", "text": "hi"},
        {"type": "chat", "text": "hi", "session_id": "bad session!"},
        {"type": "chat", "text": "hi", "timestamp": "2026-10-26T20:00:00"},       # no timezone
        {"type": "chat", "text": "hi", "timestamp": "yesterday"},
    ]
    for b in bad:
        args = {"session_id": "s1", "timestamp": 1792990000, **b}
        out = w("stream_sample_add", args)
        assert out["ok"] is False and out.get("error"), (b, out)
    assert count_samples() == n
    png = w("stream_sample_add", {"session_id": "s1", "type": "frame", "timestamp": 1792990002,
                                  "image_base64": "data:image/png;base64," + B64(PNG)})
    assert png["ok"], png


def session_belongs_to_first_sender():
    sa.set_enabled("zid-friend", True)
    out = chat(session="s1", caller={"zitadel_id": "zid-friend"})
    assert out["ok"] is False and "someone else" in out["error"], out


def personal_token_cannot_flip_someone_else():
    out = w("stream_analysis_toggle", {"person": "test_friend"})
    assert out["ok"] is False, out
    assert w("stream_analysis_toggle", {"person": "test_streamer", "enabled": True})["ok"]


def service_token_must_name_person():
    out = w("stream_sample_add", {"session_id": "s1", "type": "chat", "timestamp": 1, "text": "x"}, PROXY)
    assert out["ok"] is False and "person" in out["error"], out
    out = w("stream_sample_add", {"session_id": "s1", "type": "chat", "timestamp": 1792990003,
                                  "text": "from proxy", "person": "test_streamer"}, PROXY)
    assert out["ok"], out


def rate_limited():
    old = sa.RATE_LIMIT
    sa.RATE_LIMIT = 3
    sa._hits.clear()
    try:
        results = [chat(session="rl")["ok"] for _ in range(5)]
        assert results == [True, True, True, False, False], results
    finally:
        sa.RATE_LIMIT = old
        sa._hits.clear()


def rate_is_configurable_without_flipping():
    before = sa.status("zid-streamer")["enabled"]
    out = w("stream_analysis_toggle", {"max_per_min": 300})
    assert out["ok"] and out["max_per_min"] == 300 and out["enabled"] is before, out
    st = r("stream_analysis_status", {"person": "test_streamer"})
    assert st["max_per_min"] == 300 and st["max_per_min_ceiling"] == sa.RATE_CEILING, st
    big = w("stream_analysis_toggle", {"max_per_min": 10 ** 6})
    assert big["max_per_min"] == sa.RATE_CEILING, big
    for bad in (0, -5, "fast", True):
        assert w("stream_analysis_toggle", {"max_per_min": bad})["ok"] is False, bad
    assert w("stream_analysis_toggle", {"max_per_min": 300})["max_per_min"] == 300


def batches_go_past_120_a_minute():
    sa._hits.clear()
    frame = {"type": "frame", "image_base64": B64(JPEG), "mime": "image/jpeg"}
    stored = 0
    for b in range(6):                                    # 180 samples inside one minute
        out = w("stream_sample_add", {"session_id": "fast", "timestamp": 1792990100 + b,
                                      "samples": [frame] * 30})
        assert out["ok"] and out["stored"] == 30, out
        stored += out["stored"]
    assert stored == 180
    w("stream_analysis_toggle", {"max_per_min": 200})
    out = w("stream_sample_add", {"session_id": "fast", "timestamp": 1792990200, "samples": [frame] * 30})
    assert out["stored"] == 20 and not out["ok"], out          # the configured ceiling still bites
    assert "rate limit: 200" in out["results"][-1]["error"], out["results"][-1]
    with mcp_oauth._connect() as db:
        rows = db.execute("SELECT result FROM write_audit WHERE tool='stream_sample_add' "
                          "AND result LIKE 'batch:%'").fetchall()
    assert len(rows) == 7, "one audit row per call, not per sample"
    sa._hits.clear()


def batch_limits_and_off():
    frame = {"type": "frame", "image_base64": B64(JPEG)}
    out = w("stream_sample_add", {"session_id": "fast", "timestamp": 1, "samples": [frame] * 31})
    assert out["ok"] is False and "at most 30" in out["error"], out
    mixed = w("stream_sample_add", {"session_id": "fast", "timestamp": 1792990300, "samples": [
        {"type": "event", "event": {"kind": "kill_feed", "killer": "a", "victim": "b", "weapon": "M4"}},
        {"type": "chat", "text": ""}, "nope"]})
    assert mixed["stored"] == 1 and [x["ok"] for x in mixed["results"]] == [True, False, False], mixed
    w("stream_analysis_toggle", {"enabled": False})
    n = count_samples()
    out = w("stream_sample_add", {"session_id": "fast", "timestamp": 1792990301, "samples": [frame] * 5})
    assert out == {"ok": False, "error": "analysis is off", "enabled": False}, out
    assert count_samples() == n
    w("stream_analysis_toggle", {"enabled": True, "max_per_min": sa.RATE_LIMIT})


def type_filter_and_cursor_with_batches():
    ev = r("stream_samples", {"session_id": "fast", "type": "event"})
    assert [s["event"]["kind"] for s in ev["samples"]] == ["kill_feed"], ev
    first = r("stream_samples", {"session_id": "fast", "limit": 100})      # r() fails on cut JSON
    n1 = len(first["samples"])
    assert 0 < n1 < 100 and first["remaining"] == 201 - n1, (n1, first["remaining"])
    upto = first["next_after_id"]
    assert upto == first["samples"][-1]["sample_id"]
    w("stream_analysis_record", {"session_id": "fast", "kind": "moment", "good": "batch read",
                                 "upto_sample_id": upto}, MUSE)
    seen, after = n1, 0
    while True:
        page = r("stream_samples", {"session_id": "fast", "limit": 100, "after_id": after})
        assert page["after_id"] >= upto and all(s["sample_id"] > upto for s in page["samples"]), page["after_id"]
        seen += len(page["samples"])
        if not page["remaining"]:
            break
        after = page["next_after_id"]
    assert seen == 201, seen


def record_round_trips_and_cursor_advances():
    before = r("stream_samples", {"session_id": "s1"})["samples"]
    assert before, "need unprocessed samples"
    upto = before[1]["sample_id"]
    rec = w("stream_analysis_record", {
        "session_id": "s1", "kind": "moment", "good": "held the angle", "bad": "pushed alone",
        "next_time": "wait for the trade", "funny_death_roast": "died to his own grenade, again",
        "roast_subject": "test_friend", "at": "2026-10-26T20:01:00-07:00",
        "upto_sample_id": upto}, MUSE)
    assert rec["ok"] and rec["created"], rec
    after = r("stream_samples", {"session_id": "s1"})
    assert after["after_id"] == upto and all(s["sample_id"] > upto for s in after["samples"]), after
    allr = r("stream_samples", {"session_id": "s1", "unprocessed_only": False})
    assert allr["samples"][0]["sample_id"] == before[0]["sample_id"]
    got = r("stream_analysis_records", {"session_id": "s1"})["records"][0]
    for k, v in {"good": "held the angle", "bad": "pushed alone", "next_time": "wait for the trade",
                 "funny_death_roast": "died to his own grenade, again",
                 "roast_subject_sub": "zid-friend", "roast_subject_name": "Friend",
                 "upto_sample_id": upto, "kind": "moment", "author": "Muse"}.items():
        assert got[k] == v, (k, got)
    roasts = r("stream_analysis_records", {"has_roast": True})["records"]
    assert [x["id"] for x in roasts] == [rec["record"]["id"]], roasts


def bad_records_rejected():
    for args in ({"session_id": "s1", "kind": "moment"},                        # nothing in it
                 {"session_id": "nope", "kind": "moment", "good": "x"},           # no such session
                 {"session_id": "s1", "kind": "rant", "good": "x"},
                 {"session_id": "s1", "kind": "moment", "funny_death_roast": "x" * 281},
                 {"session_id": "s1", "kind": "moment", "good": "x", "upto_sample_id": 10 ** 9},
                 {"session_id": "s1", "kind": "moment", "good": "x", "at": "2026-10-26 20:00"},
                 {"session_id": "s1", "kind": "moment", "good": "x", "roast_subject": "nobody"}):
        out = w("stream_analysis_record", args, MUSE)
        assert out["ok"] is False, (args, out)


def summary_upserts():
    assert r("stream_analysis_summary", {"session_id": "s1"})["summary"] is None
    a = w("stream_analysis_record", {"session_id": "s1", "kind": "summary", "good": "v1"}, MUSE)
    b = w("stream_analysis_record", {"session_id": "s1", "kind": "summary", "good": "v2",
                                     "next_time": "rotate earlier"}, MUSE)
    assert a["created"] and not b["created"] and a["record"]["id"] == b["record"]["id"], (a, b)
    s = r("stream_analysis_summary", {"session_id": "s1"})["summary"]
    assert s["good"] == "v2" and s["next_time"] == "rotate earlier", s
    sess = {x["session_id"]: x for x in r("stream_sessions", {})["sessions"]}
    assert sess["s1"]["has_summary"] and sess["s1"]["person"] == "Streamer", sess


def samples_are_append_only():
    import sqlite3
    with sa._conn() as db:
        for sql in ("UPDATE samples SET text='x'", "DELETE FROM samples"):
            try:
                db.execute(sql)
            except sqlite3.DatabaseError as e:
                assert "append-only" in str(e)
            else:
                raise AssertionError(f"{sql} was allowed")


def registries():
    reads, writes = set(assistant.tool_names()), set(assistant.write_tool_names())
    for n in ("stream_analysis_status", "stream_sessions", "stream_samples", "stream_sample_image",
              "stream_analysis_records", "stream_analysis_summary"):
        assert n in reads and n not in writes, n
    for n in ("stream_analysis_toggle", "stream_sample_add", "stream_analysis_record"):
        assert n in writes and n not in reads, n


def mcp_service_scopes_and_image_block():
    def call(name, args, caller):
        return mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                  "params": {"name": name, "arguments": args}}, caller)["result"]
    listed = {t["name"] for t in mcp_server.handle(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, PROXY)["result"]["tools"]}
    assert {"stream_sample_add", "stream_analysis_toggle"} <= listed
    assert "stream_analysis_record" not in listed
    res = call("stream_analysis_record", {"session_id": "s1", "kind": "moment", "good": "x"}, PROXY)
    assert res["isError"], res
    res = call("stream_sample_add", {"session_id": "s1", "type": "frame", "timestamp": 1792990009,
                                     "image_base64": B64(JPEG), "person": "test_streamer"}, PROXY)
    sid = json.loads(res["content"][0]["text"])["sample_id"]
    res = call("stream_sample_image", {"sample_id": sid}, None)
    assert not res["isError"], res
    blocks = res["content"]
    assert blocks[0]["type"] == "text" and json.loads(blocks[0]["text"])["image_attached"] is True
    assert blocks[1] == {"type": "image", "data": B64(JPEG), "mimeType": "image/jpeg"}, blocks[1]
    # Outside MCP (the chat bots) no image is attached and no bytes leak into the text.
    out = r("stream_sample_image", {"sample_id": sid})
    assert out["image_attached"] is False and B64(JPEG) not in json.dumps(out), out


def memory_source_has_roasts():
    import memory_store
    old = memory_store._sq
    memory_store._sq = lambda p: old(os.environ["STREAM_ANALYSIS_DB"]) if p == "/data/stream_analysis.db" else old(p)
    try:
        recs = memory_store._src_streams()
    finally:
        memory_store._sq = old
    texts = " | ".join(t for _, t, _, _ in recs)
    assert "funny death roast of Friend: died to his own grenade" in texts, texts
    assert "end-of-stream summary" in texts, texts
    assert "streams" in memory_store._VALID_SOURCES


for name, fn in [
    ("OFF by default: sample rejected, nothing stored, status OFF", off_by_default_rejects_and_stores_nothing),
    ("ON: chat, frame and event accepted and listed", on_accepts_and_lists),
    ("toggling OFF stops acceptance", toggle_off_stops_acceptance),
    ("bad images, types, sessions and timestamps rejected", bad_samples_rejected),
    ("a session belongs to whoever started it", session_belongs_to_first_sender),
    ("a personal token only flips its own switch", personal_token_cannot_flip_someone_else),
    ("a service token must name the person", service_token_must_name_person),
    ("ingestion is rate limited", rate_limited),
    ("rate is configurable per person, clamped, without flipping the switch", rate_is_configurable_without_flipping),
    ("batches carry more than 120 samples a minute; the set rate still caps", batches_go_past_120_a_minute),
    ("batch size cap, mixed results, nothing stored while OFF", batch_limits_and_off),
    ("type filter and the processed cursor work with batches", type_filter_and_cursor_with_batches),
    ("record with good/bad/next_time/roast round-trips; cursor advances", record_round_trips_and_cursor_advances),
    ("bad records rejected", bad_records_rejected),
    ("summary is one per session and readable", summary_upserts),
    ("samples are append-only", samples_are_append_only),
    ("read and write registries hold the right tools", registries),
    ("MCP: service scopes enforced, frame comes back as an image block", mcp_service_scopes_and_image_block),
    ("records feed semantic memory (streams source)", memory_source_has_roasts),
]:
    check(name, fn)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
