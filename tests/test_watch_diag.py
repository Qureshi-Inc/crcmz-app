"""watch_diag store: batch ingest, validation, filters, summary."""
import sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import watch_diag as wd

wd._DB_PATH = Path(tempfile.mkdtemp()) / "wd.db"
wd.init()

now = time.time()
n = wd.record_batch(user_id="u1", name="A", room="crcmz", client_id="c1", session="s1", events=[
    {"ts": now - 30, "type": "sock.connect", "data": {"sid": "x"}},
    {"ts": now - 20, "type": "sock.disconnect", "level": "warn", "data": {"reason": "transport close"}},
    {"ts": now - 10, "type": "play.blocked", "level": "warn", "data": {"name": "NotAllowedError"}},
    {"ts": now, "type": "js.error", "level": "error", "data": {"msg": "x" * 5000}},
    {"type": ""},                       # no type: dropped
    "junk",                             # not an object: dropped
    {"ts": 1, "type": "clock.skew"},    # bogus client clock: clamped to now
    {"type": "odd.level", "level": "fatal"},
])
assert n == 6, n
wd.record_batch(user_id="u2", name="B", room="other", client_id="c2", session="s2",
                events=[{"type": "heartbeat", "level": "debug"}])

ev = wd.list_events(room="crcmz")
assert [e["type"] for e in ev][:4] == ["sock.connect", "sock.disconnect", "play.blocked", "js.error"], ev
assert ev[0]["name"] == "A" and ev[0]["data"] == {"sid": "x"}
assert len(ev[3]["data"]) <= wd._MAX_DATA          # oversize payload is kept as a truncated string
assert any(e["type"] == "clock.skew" and e["ts"] > now - 5 for e in ev)
assert next(e for e in ev if e["type"] == "odd.level")["level"] == "info"
assert {e["type"] for e in wd.list_events(level="warn")} == {"sock.disconnect", "play.blocked", "js.error"}
assert [e["type"] for e in wd.list_events(types=["play.blocked"])] == ["play.blocked"]
assert [e["name"] for e in wd.list_events(user_id="u2")] == ["B"]
assert len(wd.list_events(room="crcmz", limit=2)) == 2
assert "user_id" not in ev[0]

s = wd.summary(room="crcmz")
assert {r["name"] for r in s["reporters"]} == {"A"}
assert sum(r["n"] for r in s["by_type"]) == 6
print("test_watch_diag: ok")
