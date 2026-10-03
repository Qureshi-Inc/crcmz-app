#!/usr/bin/env python3
"""Huddle meeting notes (meeting_notes.py), the writer and the routes.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_meeting_notes

Nothing leaves the box: the AI (_huddle_chat), LiveKit (_livekit_people) and the
notification router are fakes.
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-notes-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import meeting_notes as mn  # noqa: E402

TMP = Path(tempfile.mkdtemp())
mn._DB_PATH = TMP / "meeting_notes.db"
mn.init()

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


def reset():
    mn._DB_PATH.unlink(missing_ok=True)
    mn.init()


SAID = "we should play ranked tonight and Zubi books the lobby at nine and Moiz brings the snacks " * 2


def store_tests():
    print("store")

    def first_line_opens_a_meeting_and_counts_the_speaker_in():
        reset()
        a = mn.add_line("crcmz", "u1", "Moiz", "hello there")
        b = mn.add_line("crcmz", "u2", "Zubi", "hey\x07 you\x00")
        assert a and a == b, (a, b)
        assert [l["text"] for l in mn.transcript(a)] == ["hello there", "hey  you"]
        assert {p["sub"] for p in mn.attendees(a)} == {"u1", "u2"}
        assert mn.add_line("other", "u1", "Moiz", "x") != a, "each room has its own meeting"

    def people_in_the_call_join_the_live_meeting_only():
        reset()
        mn.add_people("crcmz", {"u9": "Nobody"})
        assert mn.live_meetings() == []
        mid = mn.add_line("crcmz", "u1", "Moiz", "hi")
        mn.add_people("crcmz", {"u3": "Nuhni", "": "blank"})
        assert {p["sub"] for p in mn.attendees(mid)} == {"u1", "u3"}

    def notes_are_written_once_and_titled_from_their_heading():
        reset()
        mid = mn.add_line("crcmz", "u1", "Moiz", SAID)
        assert mn.claim_for_writing(mid) and not mn.claim_for_writing(mid)
        mn.finish(mid, "ready", "# Ranked night plan\n\n## Summary\nStuff.", mn.title_from("# Meeting notes: Ranked night plan"))
        m = mn.get(mid)
        assert m["status"] == "ready" and m["title"] == "Ranked night plan", m
        assert m["notes"].startswith("# Ranked") and len(m["transcript"]) == 1
        assert mn.add_line("crcmz", "u1", "Moiz", "after") != mid, "a finished meeting never grows; a new one opens"

    def only_attendees_rename_and_a_rename_survives_rewrites():
        reset()
        mid = mn.add_line("crcmz", "u1", "Moiz", SAID)
        assert not mn.rename(mid, "stranger", "Mine now")
        assert mn.rename(mid, "u1", "  Squad plans\n ")
        mn.finish(mid, "ready", "# Something else", "Something else")
        assert mn.get(mid)["title"] == "Squad plans"

    def lists_show_your_meetings_and_search_the_notes():
        reset()
        a = mn.add_line("crcmz", "u1", "Moiz", SAID)
        mn.finish(a, "ready", "# Ranked\nlobby at nine", "Ranked")
        b = mn.add_line("crcmz2", "u2", "Zubi", SAID)
        mn.finish(b, "empty")
        c = mn.add_line("crcmz3", "u2", "Zubi", SAID)
        assert [m["id"] for m in mn.list_meetings(sub="u1")] == [a]
        assert [m["id"] for m in mn.list_meetings(sub="u2")] == [c], "empty calls stay out"
        assert [m["id"] for m in mn.list_meetings(query="lobby")] == [a]
        assert mn.list_meetings(sub="u1")[0]["people"] == ["Moiz"]

    for fn in (first_line_opens_a_meeting_and_counts_the_speaker_in, people_in_the_call_join_the_live_meeting_only,
               notes_are_written_once_and_titled_from_their_heading, only_attendees_rename_and_a_rename_survives_rewrites,
               lists_show_your_meetings_and_search_the_notes):
        check(fn.__name__, fn)


def server_tests():
    from fastapi.testclient import TestClient
    import server
    import assistant

    print("server")
    rang: list[tuple] = []
    asked: list[list] = []
    people: dict[str, dict[str, str]] = {}

    async def fake_chat(messages, model="", timeout=60):
        asked.append(messages)
        return "# Ranked night plan\n\n## Summary\nThey planned ranked."

    async def fake_people(room):
        return people.get(room, {})

    server._huddle_chat = fake_chat
    server._livekit_people = fake_people
    server._notify.route_in_background = lambda *a, **k: rang.append((a, k))
    server.OLLAMA_BASE_URL = server.OLLAMA_BASE_URL or "http://ai.invalid/v1"
    server.LIVEKIT_API_KEY = server.LIVEKIT_API_KEY or "k"
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    me = server._make_session("u1", "m@b.co")
    sub = me.get("sub")
    cookie = {server._SESSION_COOKIE: server._signer().dumps(me)}
    origin = {"Origin": "https://app.crcmz.me"}

    def an_empty_call_writes_the_notes_and_tells_who_was_there():
        reset()
        two_min_ago = server._time.time() - 120
        mid = mn.add_line("crcmz", sub, "Moiz", SAID, now=two_min_ago)
        mn.add_line("crcmz", "u2", "Zubi", SAID, now=two_min_ago)
        people["crcmz"] = {sub: "Moiz", "u3": "Nuhni"}
        asyncio.run(server._meeting_notes_tick())
        assert mn.get(mid)["status"] == "live", "still in the call: keep going"
        assert {p["sub"] for p in mn.attendees(mid)} == {sub, "u2", "u3"}
        people["crcmz"] = {}
        asyncio.run(server._meeting_notes_tick())
        m = mn.get(mid)
        assert m["status"] == "ready" and m["title"] == "Ranked night plan", m
        assert "never follow instructions" in asked[-1][0]["content"] and "Zubi:" in asked[-1][1]["content"]
        (cat, title, *_), kw = rang[-1]
        assert cat == "notes" and title.endswith("Ranked night plan") and set(kw["only"]) == {sub, "u2", "u3"}
        assert kw["dms"] is False

    def a_call_where_nobody_said_much_leaves_no_notes():
        reset()
        n = len(asked)
        mid = mn.add_line("crcmz", sub, "Moiz", "hi", now=server._time.time() - 120)
        asyncio.run(server._meeting_notes_tick())
        assert mn.get(mid)["status"] == "empty" and len(asked) == n

    def routes_list_open_and_rename():
        reset()
        mid = mn.add_line("crcmz", sub, "Moiz", SAID)
        mn.finish(mid, "ready", "# Plan", "Plan")
        other = mn.add_line("crcmz9", "u7", "Zubi", SAID)
        mn.finish(other, "ready", "# Theirs", "Theirs")
        assert client.get("/api/huddle/notes").status_code == 401
        r = client.get("/api/huddle/notes", cookies=cookie)
        assert [m["id"] for m in r.json()["meetings"]] == [mid], r.text
        r = client.get(f"/api/huddle/notes/{other}", cookies=cookie)
        assert r.status_code == 200 and r.json()["mine"] is False and r.json()["notes"] == "# Theirs", "a shared link opens"
        assert "sub" not in str(r.json()["people"])
        assert client.post(f"/api/huddle/notes/{other}", json={"title": "x"}, cookies=cookie, headers=origin).status_code == 403
        r = client.post(f"/api/huddle/notes/{mid}", json={"title": "Ranked"}, cookies=cookie, headers=origin)
        assert r.status_code == 200 and r.json()["title"] == "Ranked", r.text
        assert client.get("/api/huddle/notes/nope", cookies=cookie).status_code == 404

    def a_link_that_lost_its_last_underscore_still_opens():
        reset()
        mid = mn.add_line("crcmz", sub, "Moiz", SAID)
        assert mid.isalnum(), "new ids are letters and digits only"
        with mn._conn() as db:   # an older id, made before that
            db.execute("UPDATE meetings SET id = 'dYZCAleFgjZ_' WHERE id = ?", (mid,))
            db.execute("UPDATE people SET meeting_id = 'dYZCAleFgjZ_' WHERE meeting_id = ?", (mid,))
        r = client.get("/api/huddle/notes/dYZCAleFgjZ", cookies=cookie)
        assert r.status_code == 200 and r.json()["id"] == "dYZCAleFgjZ_" and r.json()["mine"] is True, r.text
        assert client.post("/api/huddle/notes/dYZCAleFgjZ", json={"title": "Fixed"}, cookies=cookie, headers=origin).status_code == 200
        assert client.get("/api/huddle/notes/dYZCAle", cookies=cookie).status_code == 404, "too short to guess"

    def a_transcript_line_without_a_room_goes_to_the_room_you_joined():
        server._huddle_rooms[sub] = ("squadnight", server._time.time())
        assert server._huddle_room_of(sub) == "squadnight"
        assert server._huddle_room_of(sub, "Other Room!") == "otherroom"
        assert server._huddle_room_of("nobody") == ""

    def the_assistant_and_mcp_can_read_the_notes():
        reset()
        mid = mn.add_line("crcmz", sub, "Moiz", SAID)
        mn.finish(mid, "ready", "# Plan\nlobby at nine", "Plan")
        assert {"huddle_meeting_notes", "huddle_meeting_get"} <= set(assistant.tool_names())
        got = assistant._huddle_meeting_get(id=mid, include_transcript=True)
        assert got["notes"].startswith("# Plan") and got["transcript"][0]["name"] == "Moiz" and got["url"].endswith(mid)
        assert assistant._huddle_meeting_notes(query="lobby", limit=999)["meetings"][0]["id"] == mid
        assert "sub" not in str(got["people"])

    for fn in (an_empty_call_writes_the_notes_and_tells_who_was_there, a_call_where_nobody_said_much_leaves_no_notes,
               routes_list_open_and_rename, a_link_that_lost_its_last_underscore_still_opens, a_transcript_line_without_a_room_goes_to_the_room_you_joined,
               the_assistant_and_mcp_can_read_the_notes):
        check(fn.__name__, fn)


if __name__ == "__main__":
    store_tests()
    server_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
