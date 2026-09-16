#!/usr/bin/env python3
"""WhatsApp analytics: date-order detection, import dedupe, live ingest auth.

Plain asserts, no pytest — run inside the app image where the deps live:

    docker build -t psn-messenger:test .
    docker run --rm -e SESSION_SECRET=test-secret -e WA_INGEST_SECRET=test-ingest \
      -v "$PWD/tests:/app/tests" psn-messenger:test python tests/test_whatsapp.py
"""

import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

os.environ.setdefault("SESSION_SECRET", "test-secret-for-wa-tests")
os.environ.setdefault("WA_INGEST_SECRET", "test-ingest-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TZ = ZoneInfo("America/Los_Angeles")
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


import whatsapp_analytics as wa  # noqa: E402

# A North American export: M/D/YY with AM/PM. "9/12/26" is September 12th.
US_EXPORT = """9/12/26, 3:04 PM - Zubi: yo
9/12/26, 3:05 PM - Brenden: <Media omitted>
9/16/26, 8:00 AM - Samad: my R3 is broken
"""

# A day-first export: 16/09/26 can only be the 16th, so the file is DMY.
EU_EXPORT = """16/09/26, 08:00 - Samad: my R3 is broken
9/12/26, 15:04 - Zubi: yo
"""


def _dt(ts):
    return datetime.fromtimestamp(ts, TZ)


def t_detects_month_first_from_unambiguous_line():
    assert wa.detect_date_order(US_EXPORT) == "MDY"


def t_detects_day_first_from_unambiguous_line():
    assert wa.detect_date_order(EU_EXPORT) == "DMY"


def t_ambiguous_file_uses_ampm_as_the_tiebreak():
    assert wa.detect_date_order("1/2/26, 3:04 PM - Zubi: yo\n") == "MDY"
    assert wa.detect_date_order("1/2/26, 15:04 - Zubi: yo\n") == "DMY"


def t_us_export_parses_september_not_december():
    msgs = wa.parse_txt(US_EXPORT)
    assert len(msgs) == 3, msgs
    first = _dt(msgs[0]["timestamp"])
    assert (first.month, first.day) == (9, 12), first.isoformat()
    assert first.hour == 15, first.isoformat()
    last = _dt(msgs[-1]["timestamp"])
    assert (last.month, last.day, last.hour) == (9, 16, 8), last.isoformat()


def t_day_first_export_still_parses_day_first():
    msgs = wa.parse_txt(EU_EXPORT)
    second = _dt(msgs[1]["timestamp"])
    assert (second.month, second.day) == (12, 9), second.isoformat()


def t_explicit_order_overrides_detection():
    msgs = wa.parse_txt("9/12/26, 3:04 PM - Zubi: yo\n", order="DMY")
    d = _dt(msgs[0]["timestamp"])
    assert (d.month, d.day) == (12, 9), d.isoformat()


def t_impossible_ordering_falls_back():
    # 13 cannot be a month, so an MDY file still reads this line day-first.
    msgs = wa.parse_txt("9/13/26, 1:00 PM - Zubi: a\n13/9/26, 2:00 PM - Zubi: b\n")
    a, b = _dt(msgs[0]["timestamp"]), _dt(msgs[1]["timestamp"])
    assert (a.month, a.day) == (9, 13), a.isoformat()
    assert (b.month, b.day) == (9, 13), b.isoformat()


def t_media_and_multiline_survive():
    msgs = wa.parse_txt(US_EXPORT)
    assert msgs[1]["is_media_omitted"] is True, msgs[1]
    assert msgs[1]["text"] is None, msgs[1]


def db_tests():
    tmp = Path(tempfile.mkdtemp(prefix="wa-test-")) / "wa.db"
    wa._DB_PATH = tmp
    wa.init()

    def t_first_import_inserts_everything():
        r = wa.import_messages(US_EXPORT.encode(), "export1.txt", "g@g.us", "sub-1")
        assert r["status"] == "imported", r
        assert r["message_count"] == 3, r

    def t_same_file_is_rejected_by_hash():
        r = wa.import_messages(US_EXPORT.encode(), "again.txt", "g@g.us", "sub-1")
        assert r["status"] == "already_imported", r

    def t_new_export_only_adds_new_messages():
        # What a fresh export looks like: the old history plus newer lines.
        extended = US_EXPORT + "9/17/26, 9:15 AM - Mutasif: brb one sec\n"
        r = wa.import_messages(extended.encode(), "export2.txt", "g@g.us", "sub-1")
        assert r["status"] == "imported", r
        assert r["message_count"] == 1, f"expected 1 new message, got {r}"
        assert r["duplicate_count"] == 3, r
        total = wa._q("SELECT COUNT(*) n FROM whatsapp_messages")[0]["n"]
        assert total == 4, f"history was duplicated: {total} rows"

    def t_live_ingest_inserts_and_dedupes():
        msg = {"message_id": "ABC123", "sender_name": "Zubi", "group_jid": "g@g.us",
               "timestamp": 1789000000, "text": "live one", "type": "text"}
        assert wa.ingest_baileys_message(msg) is True
        assert wa.ingest_baileys_message(msg) is False, "same message_id twice"
        rows = wa._q("SELECT source, text FROM whatsapp_messages WHERE text='live one'")
        assert len(rows) == 1 and rows[0]["source"] == "baileys", rows

    def t_export_does_not_duplicate_a_live_message():
        # Android exports have no seconds, so the minute is the shared identity.
        d = datetime.fromtimestamp(1789000000, TZ)
        line = (f"{d.month}/{d.day}/{d.strftime('%y')}, "
                f"{d.strftime('%-I:%M %p')} - Zubi: live one\n")
        r = wa.import_messages(line.encode(), "overlap.txt", "g@g.us", "sub-1")
        assert r["message_count"] == 0, f"live message re-imported: {r}"
        rows = wa._q("SELECT id FROM whatsapp_messages WHERE text='live one'")
        assert len(rows) == 1, rows

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check("db/" + name[2:], fn)


def http_tests():
    from fastapi.testclient import TestClient
    import server

    tmp = Path(tempfile.mkdtemp(prefix="wa-http-")) / "wa.db"
    server._wa._DB_PATH = tmp
    server._wa.init()

    client = TestClient(server.app, base_url="https://app.crcmz.me")
    SECRET = server.WA_INGEST_SECRET
    body = [{"message_id": "LIVE1", "sender_name": "Zubi", "group_jid": "g@g.us",
             "timestamp": 1789000123, "text": "from the bridge", "type": "text"}]

    def t_bridge_reaches_ingest_without_a_session():
        # The bridge has no cookie: before this path was opened the auth gate
        # 401'd every message and analytics silently stopped updating.
        client.cookies.clear()
        r = client.post("/api/whatsapp/ingest", json=body,
                        headers={"x-ingest-secret": SECRET})
        assert r.status_code == 200, (r.status_code, r.text)
        assert r.json() == {"inserted": 1, "received": 1}, r.json()

    def t_wrong_secret_is_rejected():
        client.cookies.clear()
        r = client.post("/api/whatsapp/ingest", json=body,
                        headers={"x-ingest-secret": "nope"})
        assert r.status_code == 403, (r.status_code, r.text)

    def t_missing_secret_is_rejected():
        client.cookies.clear()
        r = client.post("/api/whatsapp/ingest", json=body)
        assert r.status_code == 403, (r.status_code, r.text)

    def t_unconfigured_secret_refuses_instead_of_opening_up():
        saved = server.WA_INGEST_SECRET
        server.WA_INGEST_SECRET = ""
        try:
            r = client.post("/api/whatsapp/ingest", json=body)
            assert r.status_code == 503, (r.status_code, r.text)
        finally:
            server.WA_INGEST_SECRET = saved

    def t_stats_still_need_a_session():
        client.cookies.clear()
        r = client.get("/api/whatsapp/stats", headers={"Accept": "application/json"})
        assert r.status_code == 401, r.status_code

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check("http/" + name[2:], fn)


print("WhatsApp date-order tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("\nImport / ingest DB tests")
try:
    db_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"db_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ db bootstrap: {type(e).__name__}: {e}")

print("\nHTTP endpoint tests")
try:
    http_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"http_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not boot the app: {type(e).__name__}: {e}")

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
