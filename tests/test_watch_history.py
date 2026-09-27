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
assert len(items) == 1 and items[0]["title"] == "Inception 2010 1080p", items
assert {v["name"] for v in items[0]["viewers"]} == {"A", "B"}
assert wh.list_history(user_id="u2")[0]["finished"] is True
assert wh.list_history(user_id="u1")[0]["position"] == 600
assert wh.list_history(user_id="u2", include_finished=False) == []
assert wh.resume_point(U, user_id="u1")["position"] == 600
assert wh.parse_title("The.Bear.S02E06.Fishes.1080p")["season"] == 2
assert wh.parse_title("Dune Part Two (2024) [2160p]") == {"title": "Dune Part Two", "year": "2024", "season": None, "episode": None}
assert wh.delete_for_user("u1", U) and not wh.list_history(user_id="u1")
print("test_watch_history: ok")
