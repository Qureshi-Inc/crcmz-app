"""live.py: opt-in prefs, start/update/end diffing, progress throttling, payloads."""
import json, sys, tempfile, time, types
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import live

live._DB_PATH = Path(tempfile.mkdtemp()) / "live.db"

# ── prefs: off by default; on, then per kind ─────────────────────────────────
assert live.get_prefs("a") == {"on": False, "watch": True, "huddle": True, "slap": True, "tourney": True, "private": False}
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

# ── the shared state: sessions, revisions, seeks, heartbeats, ended ──────────
sent.clear()
captured = []
live._deliver = lambda event, it, urgent=True: (sent.append((event, it["key"], urgent)), captured.append(it))
live._last.clear(); live._sent_at.clear()
party = {**w, "elapsed": 600, "duration": 6780, "pos_at": 5000.0, "anchor_pos": 0.0, "anchor_at": 4400.0,
         "status": "playing", "rate": 1.0, "subs": ["a"], "poster": "https://x/p.jpg"}
live.tick([party])
first = captured[-1]
assert first["session"].startswith("watch:crcmz@") and first["rev"] > 0, first
live.tick([{**party, "elapsed": 620, "pos_at": 5020.0}])      # the clock moving on: phones run it themselves
assert len(captured) == 1, sent
live.tick([{**party, "elapsed": 3000, "anchor_pos": 3000.0, "anchor_at": 5040.0}])   # a seek: at once, urgent
assert sent[-1] == ("update", "watch:crcmz", True) and captured[-1]["rev"] > first["rev"], sent
assert captured[-1]["session"] == first["session"]           # same party, same session: an update, not a new one
live.tick([{**party, "elapsed": 3000, "anchor_pos": 3000.0, "anchor_at": 5040.0, "status": "paused", "paused": True}])
assert sent[-1] == ("update", "watch:crcmz", True), sent      # paused: at once
n = len(captured)
live._sent_at["watch:crcmz"] -= live.HEARTBEAT_S + 1          # nothing changed for a while: sent anyway, quietly
live.tick([{**party, "elapsed": 3000, "anchor_pos": 3000.0, "anchor_at": 5040.0, "status": "paused", "paused": True}])
assert len(captured) == n + 1 and sent[-1] == ("update", "watch:crcmz", False), sent
live.tick([])
assert sent[-1][0] == "end" and captured[-1]["status"] == "ended", captured[-1]

# Per person: joined ("Open party"), private (no film, names or poster), and the old
# builds' paused flag set when it's reconnecting or ended, so it never looks like it plays on.
s = live._state({**party, "session": "watch:crcmz@1", "rev": 7}, "a")
assert s["joined"] and not s["private"] and s["people"] == "a, b +1" and s["status"] == "playing" and s["rev"] == 7, s
assert s["at"] == 5000.0 and s["elapsed"] == 600 and s["rate"] == 1.0
assert not live._state(party, "b")["joined"]
assert live._state({**party, "status": "stale"}, "a")["paused"] is True
assert live._state({**party, "status": "ended"}, "a")["paused"] is True
assert live._state({**party, "count": 0, "names": []}, "a")["people"] == ""
assert live._state({**party, "count": 250, "names": ["a", "b"]}, "a")["people"] == "a, b +248"
assert live._state({**party, "count": 1240, "names": ["a", "b"]}, "a")["people"] == "a, b +1.2K"
assert live._state({**party, "count": 1002, "names": ["a", "b"]}, "a")["people"] == "a, b +1K"
assert live._state({**party, "count": 25002, "names": ["a", "b"]}, "a")["people"] == "a, b +25K"
live.save_prefs("a", {"private": True})
s = live._state(party, "a")
assert s["private"] and s["title"] == "Watch Party" and s["names"] == [] and s["people"] == "" and s["poster"] == "", s
assert s["subtitle"] == "3 watching" and s["count"] == 3
d = live._android_data("update", {**party, "session": "watch:crcmz@1"}, "a")
assert d["private"] == "1" and d["title"] == "Watch Party" and d["names"] == "" and d["joined"] == "1" and d["status"] == "playing"
assert all(isinstance(v, str) for v in d.values()), d
live.save_prefs("a", {"private": False})
assert live._android_data("end", {**party, "gone": True}, "a")["keep"] == "0"     # switched off: goes at once

# ── iPhones: Hide, Live Activities off, and the ordinary-notification fallback ─
alerts = []
fake_apns.alert = lambda category, title, body="", url="/app", **kw: alerts.append((category, title, body, url, kw))
apns_calls.clear()
it = {**party, "session": "watch:crcmz@42", "rev": 1}
live.register_ios_start("a", "aa11")
live._ios("start", it, {"a", "b"})
assert {c[0] for c in apns_calls} == {"AB12cd", "aa11"}, apns_calls          # a's iPhones start it
assert [(x[1], x[2], x[4]["only"], x[4]["tag"]) for x in alerts] == [("Watch Party is live", "Dune · 3 watching", ["b"], "watch:crcmz@42")], alerts
assert alerts[0][4]["quiet"] and alerts[0][3] == "/app"                      # b has no Live Activities: one quiet notification
live.hide("a", "watch:crcmz@42")                                             # Hide on a's iPhone
apns_calls.clear(); alerts.clear()
live._ios("start", it, {"a"})
assert apns_calls == [] and alerts == [], (apns_calls, alerts)               # not started again this session...
live._ios("start", {**it, "session": "watch:crcmz@99"}, {"a"})
assert len(apns_calls) == 2, apns_calls                                      # ...but the next party shows
live._last["watch:crcmz"] = it
live.register_ios_activity("a", "watch:crcmz", "cafe")                       # an activity of a hidden session: ended
assert apns_calls[-1][0] == "cafe" and apns_calls[-1][1]["aps"]["event"] == "end"
live._last.clear()
live.set_ios_enabled("a", False)                                             # Live Activities off on a's iPhones
apns_calls.clear(); alerts.clear()
live._ios("start", {**it, "session": "watch:crcmz@100"}, {"a"})
assert apns_calls == [] and [x[4]["only"] for x in alerts] == [["a"]], (apns_calls, alerts)
live.set_ios_enabled("a", True, "aa11")
apns_calls.clear()
live._ios_send("aa11", "end", {**it, "status": "ended"}, sub="a")
aps = apns_calls[-1][1]["aps"]
assert aps["content-state"]["status"] == "ended" and aps["dismissal-date"] - aps["timestamp"] == live.ENDED_S
live._ios_send("aa11", "end", {**it, "gone": True}, sub="a")
aps = apns_calls[-1][1]["aps"]
assert aps["dismissal-date"] - aps["timestamp"] == 5
assert len(json.dumps(apns_calls[-1][1])) < 4096
print("test_live: ok")
