"""live.py: opt-in prefs, start/update/end diffing, progress throttling, payloads."""
import json, sys, tempfile, time, types
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import live

live._DB_PATH = Path(tempfile.mkdtemp()) / "live.db"

# ── prefs: off by default; on, then per kind ─────────────────────────────────
assert live.get_prefs("a") == {"on": False, "watch": True, "huddle": True, "slap": True, "tourney": True}
live.save_prefs("a", {"on": True, "huddle": False, "bogus": True})
p = live.get_prefs("a")
assert p["on"] and not p["huddle"] and p["watch"] and "bogus" not in p
live.save_prefs("b", {"on": True})
assert live._opted_in("watch") == {"a", "b"} and live._opted_in("huddle") == {"b"}

# ── tick: start, update only when it matters, progress throttled, end ────────
sent = []
live._deliver = lambda event, it, urgent=True: sent.append((event, it["key"], urgent))
w = {"key": "watch:crcmz", "kind": "watch", "title": "Dune", "subtitle": "3 watching", "count": 3, "names": ["a", "b", "c"], "progress": 0.10}
out = live.tick([w, {"key": "nope", "kind": "weird"}])
assert out["start"] == ["watch:crcmz"] and sent == [("start", "watch:crcmz", True)], (out, sent)
started = live.current()[0]["started"]

sent.clear()
live.tick([{**w, "progress": 0.105}])                  # tiny move: nothing
assert sent == [], sent
live.tick([{**w, "progress": 0.2}])                    # a real move, but within PROGRESS_S: nothing yet
assert sent == [], sent
live._sent_at["watch:crcmz"] -= live.PROGRESS_S + 1
live.tick([{**w, "progress": 0.2}])                    # now it goes, low priority
assert sent == [("update", "watch:crcmz", False)], sent
sent.clear()
live.tick([{**w, "progress": 0.2, "count": 4, "subtitle": "4 watching"}])   # someone joined: at once, urgent
assert sent == [("update", "watch:crcmz", True)], sent
assert live.current()[0]["started"] == started         # the start time sticks
# Switching it on mid-party shows what's already on, at once, to just that person.
started_for = []
real_start = live._start_for
live._start_for = lambda sub, it: started_for.append((sub, it["key"]))
live.save_prefs("late", {"on": True})
assert started_for == [("late", "watch:crcmz")], started_for
started_for.clear()
live.save_prefs("late", {"on": True})                  # already on: nothing again
assert started_for == [], started_for
live._start_for = real_start

sent.clear()
live.tick([])
assert sent == [("end", "watch:crcmz", True)] and live.current() == [], sent

# A restart remembers what was showing, so its end still goes out.
live.tick([w])
live._last.clear(); live._loaded = False
sent.clear()
live.tick([])
assert sent == [("end", "watch:crcmz", True)], sent

# ── payloads ────────────────────────────────────────────────────────────────
pushed = []
fake_fcm = types.SimpleNamespace(
    _credentials=lambda: {"project_id": "x"},
    _conn=lambda: types.SimpleNamespace(__enter__=None),
)
class _DB:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, q, *a):
        return [{"sub": "a", "token": "tokA"}, {"sub": "zz", "token": "tokZ"}]
fake_fcm._conn = lambda: _DB()
fake_fcm._send_one = lambda creds, token, data: (pushed.append((token, data)) or (200, ""))
fake_fcm._gone = lambda s, e: False
sys.modules["fcm"] = fake_fcm
item = {**w, "started": 1000.0, "segments": [1, 1, 1]}
live._android("update", item, {"a"})
assert [t for t, _ in pushed] == ["tokA"], pushed           # only opted-in people's phones
d = pushed[0][1]
assert d["type"] == "live" and d["event"] == "update" and d["key"] == "watch:crcmz" and d["kind"] == "watch"
assert all(isinstance(v, str) for v in d.values()), d       # FCM data values are strings
assert d["started"] == "1000000" and d["progress"] == "0.1000" and json.loads(d["segments"]) == [1, 1, 1]
assert d["elapsed"] == "0" and d["duration"] == "0" and d["poster"] == ""   # absent: zero, never missing
pushed.clear()
live._android("update", {**item, "elapsed": 1380.4, "duration": 6780, "poster": "https://app.crcmz.me/api/widgets/poster?id=a&t=b"}, {"a"})
d = pushed[0][1]
assert d["elapsed"] == "1380" and d["duration"] == "6780" and d["poster"].startswith("https://"), d   # the phone writes 23:00 / 1:53:00

apns_calls = []
fake_apns = types.SimpleNamespace(configured=lambda: True,
                                  send_live=lambda tok, payload, priority=10: (apns_calls.append((tok, payload, priority)) or (200, "")))
sys.modules["apns"] = fake_apns
live.register_ios_start("a", "AB12cd!!")               # junk characters are dropped
live._ios("start", item, {"a"})
tok, payload, prio = apns_calls[-1]
aps = payload["aps"]
assert tok == "AB12cd" and prio == 10
assert aps["event"] == "start" and aps["attributes-type"] == "CRCMZLiveAttributes"
assert aps["attributes"] == {"key": "watch:crcmz", "kind": "watch"} and aps["alert"]["title"] == "Watch Party is live"
assert aps["content-state"]["title"] == "Dune" and aps["content-state"]["count"] == 3 and "stale-date" in aps
cs = aps["content-state"]
assert cs["elapsed"] == 0 and cs["duration"] == 0 and cs["poster"] == "" and cs["at"] > 0, cs   # absent: zero, never missing
live._ios_send("tokP", "update", {**item, "elapsed": 1380.4, "duration": 6780, "poster": "https://app.crcmz.me/api/widgets/poster?id=a&t=b"})
cs = apns_calls[-1][1]["aps"]["content-state"]
assert cs["elapsed"] == 1380 and cs["duration"] == 6780 and cs["poster"].startswith("https://"), cs   # the iPhone's clock and poster
assert len(json.dumps(apns_calls[-1][1])) < 4096, "a Live Activity push must stay under 4 KB"

live._last.clear(); live._last["watch:crcmz"] = item
live.register_ios_activity("a", "watch:crcmz", "beef")   # a fresh activity is brought up to date at once
assert apns_calls[-1][0] == "beef" and apns_calls[-1][1]["aps"]["event"] == "update"
live._ios("update", item, {"a"}, urgent=False)
assert apns_calls[-1][2] == 5                               # a progress-only update is low priority
live._last.clear()
live.register_ios_activity("a", "watch:gone", "dead")      # its session already ended: end it
assert apns_calls[-1][0] == "dead" and apns_calls[-1][1]["aps"]["event"] == "end"
print("test_live: ok")
