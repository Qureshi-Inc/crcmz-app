"""watch_history store: progress upsert, finished flag, listing, resume points."""
import sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import watch_history as wh

wh._DB_PATH = Path(tempfile.mkdtemp()) / "wh.db"
wh.init()

U = "https://cdn.example/Inception.2010.1080p.mp4"
assert wh.record_progress(user_id="u1", url=U, position=600, duration=8880, room="crcmz", display_name="A")
assert wh.record_progress(user_id="u2", url=U, position=8800, duration=8880, room="crcmz", display_name="B")
assert not wh.record_progress(user_id="u1", url="javascript:alert(1)", position=1)
assert not wh.record_progress(user_id="", url=U, position=1)

items = wh.list_history(room="crcmz")
# No title was given, so none is guessed from the file name.
assert len(items) == 1 and items[0]["title"] == "" and items[0]["named_by"] is None, items
assert {v["name"] for v in items[0]["viewers"]} == {"A", "B"}
assert wh.list_history(user_id="u2")[0]["finished"] is True
assert wh.list_history(user_id="u1")[0]["position"] == 600
assert wh.list_history(user_id="u2", include_finished=False) == []
assert wh.resume_point(U, user_id="u1")["position"] == 600
assert wh.parse_title("The.Bear.S02E06.Fishes.1080p")["season"] == 2
assert wh.parse_title("Dune Part Two (2024) [2160p]") == {"title": "Dune Part Two", "year": "2024", "season": None, "episode": None}
assert wh.delete_for_user("u1", U) and not wh.list_history(user_id="u1")
print("test_watch_history: ok")

# A typed title re-opens the metadata lookup; the same title again doesn't.
V = "https://cdn.example/movie.mp4"
wh.record_progress(user_id="u1", url=V, position=5)
wh._save_meta(V, {"title": "Wrong Film", "source": "wikipedia"})
assert not wh.needs_meta(V)
wh.record_progress(user_id="u1", url=V, position=6, title_hint="Heat 1995")
assert wh.needs_meta(V)
wh._save_meta(V, {"title": "Heat", "source": "wikipedia"})
wh.record_progress(user_id="u1", url=V, position=7, title_hint="Heat 1995")
assert not wh.needs_meta(V)
print("test_watch_history: retitle ok")

# Titles: typed > extracted, never the file name; lookups must match the name.
M = "https://cdn.example/hls/abc/master.m3u8"
wh.record_progress(user_id="u1", url=M, position=10, extracted_title="Watch Unabomber Online Free HD | Nebula")
it = wh.list_history(user_id="u1")[0]
assert it["title"] == "Unabomber" and it["named_by"] == "source", it
assert wh.clean_page_title("master") == "" and wh.clean_page_title("Heat (1995) - FMovies") == "Heat (1995)"
assert wh.needs_meta(M)
wh._save_meta(M, {"title": "Unabomber", "source": "wikipedia"})
assert wh.set_title(M, "Unabomber (2025)") and wh.needs_meta(M)
it = wh.list_history(user_id="u1")[0]
assert it["title"] == "Unabomber (2025)" and it["named_by"] == "viewer", it
wh.record_progress(user_id="u1", url=M, position=11, extracted_title="Something Else")
assert wh.list_history(user_id="u1")[0]["title"] == "Unabomber (2025)"   # typed wins
assert not wh.set_title("https://cdn.example/unknown.mp4", "X")
assert wh._title_matches("Unabomber", "Unabomber") and not wh._title_matches("Master", "Unabomber")
assert not wh._title_matches("Heat", "Master")
assert wh.lookup_meta(M, "") == {}     # no name, no lookup (and no network)
print("test_watch_history: titles ok")

# Chat is filed under the video that was on when it was sent.
wh.record_progress(user_id="u1", url=M, position=12, room="crcmz")
Y = "https://youtu.be/D8cei4SJ3KI"
chat = [
    {"id": "c1", "cmd": "host", "msg": M, "timestamp": "2026-09-27T07:15:00Z"},
    {"id": "c1", "msg": "this is wild", "timestamp": "2026-09-27T07:20:00Z", "videoTS": 300},
    {"id": "c2", "cmd": "pause", "msg": "", "timestamp": "2026-09-27T07:21:00Z"},
    {"id": "c2", "msg": "brb", "timestamp": "2026-09-27T07:22:00Z", "videoTS": 420, "system": True},
    {"id": "c2", "cmd": "host", "msg": Y, "timestamp": "2026-09-27T08:00:00Z"},
    {"id": "c2", "msg": "next one", "timestamp": "2026-09-27T08:01:00Z", "videoTS": 5},
]
names = {"c1": "moiiz41510", "c2": "mutasif"}
assert wh.ingest_room_chat("/crcmz", chat, names, Y) == 2
assert wh.ingest_room_chat("/crcmz", chat, names, Y) == 0          # idempotent
m = wh.chat_for(M, room="crcmz")
assert [x["msg"] for x in m] == ["this is wild"] and m[0]["name"] == "moiiz41510" and m[0]["video_ts"] == 300, m
assert [x["msg"] for x in wh.chat_for(Y, room="crcmz")] == ["next one"]
assert wh.chat_for(M, room="other") == []
# Later poll after the buffer rolled: no host cmd left, so it's the current video.
assert wh.ingest_room_chat("crcmz", [{"id": "c1", "msg": "lol", "timestamp": "2026-09-27T08:05:00Z"}], names, Y) == 1
assert len(wh.chat_for(Y, room="crcmz")) == 2
assert wh.list_history(room="crcmz")[0]["chat_count"] >= 1
print("test_watch_history: chat ok")
