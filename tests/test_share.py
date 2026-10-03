#!/usr/bin/env python3
"""Share → CRCMZ: what a shared link is (share.py) and the inspect route.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_share

Nothing leaves the box: the movie catalogue, the library and YouTube's titles are fakes.
"""

import asyncio
import os
import sys

os.environ.setdefault("SESSION_SECRET", "test-secret-for-share-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import movies  # noqa: E402
import share  # noqa: E402

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


HEAT = {"imdb": "tt0113277", "title": "Heat", "year": "1995", "poster": "p.jpg"}
HEAT2 = {"imdb": "tt9999999", "title": "Heat", "year": "1986", "poster": ""}
DUNE = {"imdb": "tt1160419", "title": "Dune", "year": "2021", "poster": ""}
TITLES = {"https://youtu.be/heat": "Heat (1995) Official Trailer #1 - Al Pacino Movie HD",
          "https://www.youtube.com/watch?v=dune": "DUNE - Official Main Trailer | Warner Bros",
          "https://youtu.be/song": "Drake - Hotline Bling", "https://youtu.be/odd": "Totally Unknown Thing Trailer"}
SEARCHED: list[str] = []


async def fake_search(q):
    SEARCHED.append(q)
    return {"heat": [HEAT2, HEAT], "dune": [DUNE]}.get(q.lower(), [])


async def fake_meta(imdb):
    return HEAT if imdb == HEAT["imdb"] else None


async def fake_index():
    return {DUNE["imdb"]: {"id": "jf-dune"}}


async def fake_title(url):
    return TITLES.get(url, "")


movies.search, movies.meta, movies.library_index = fake_search, fake_meta, fake_index
share.youtube_title = fake_title
run = asyncio.run


def tests():
    print("share")

    def trailer_titles_become_a_film_name_and_year():
        assert share.trailer_query("Heat (1995) Official Trailer #1 - Al Pacino Movie HD") == ("Heat", "1995")
        assert share.trailer_query("DUNE - Official Main Trailer | Warner Bros")[0].lower() == "dune"
        assert share.trailer_query("The Batman – Official Trailer 2 [4K]")[0] == "The Batman"

    def a_song_goes_straight_to_slap():
        r = run(share.inspect(text="Saturn by SZA https://open.spotify.com/track/abc?si=1"))
        assert r["kind"] == "song" and r["auto"] == "slap" and r["link"] == "https://open.spotify.com/track/abc?si=1", r

    def a_trailer_offers_its_film_first():
        r = run(share.inspect(url="https://youtu.be/heat"))
        assert r["kind"] == "trailer" and r["movie"]["imdb"] == HEAT["imdb"] and r["choices"] == ["movie", "watch"], r
        assert r["movie"]["in_library"] is False and r["auto"] is None
        r = run(share.inspect(url="https://www.youtube.com/watch?v=dune"))
        assert r["movie"]["imdb"] == DUNE["imdb"] and r["movie"]["in_library"] is True, r

    def a_trailer_for_an_unknown_film_is_just_a_video():
        r = run(share.inspect(url="https://youtu.be/odd"))
        assert r["kind"] == "video" and r["movie"] is None and r["choices"] == ["watch", "slap"], r

    def other_videos_and_pages_go_to_the_watch_party():
        r = run(share.inspect(url="https://youtu.be/song"))
        assert r["kind"] == "video" and r["choices"][0] == "watch" and r["video_title"] == "Drake - Hotline Bling"
        r = run(share.inspect(url="https://cdn.example.com/film.mp4"))
        assert r["kind"] == "video" and r["choices"] == ["watch"], r
        assert run(share.inspect(text="no link here"))["kind"] == "none"

    def an_imdb_page_is_a_movie():
        r = run(share.inspect(url="https://m.imdb.com/title/tt0113277/?ref_=x"))
        assert r["kind"] == "movie" and r["movie"]["title"] == "Heat" and r["choices"] == ["movie"], r

    def the_route_needs_a_session():
        from fastapi.testclient import TestClient
        import server
        client = TestClient(server.app, base_url="https://app.crcmz.me")
        origin = {"Origin": "https://app.crcmz.me"}
        assert client.post("/api/share/inspect", json={"url": "https://youtu.be/heat"}, headers=origin).status_code == 401
        cookie = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("u1", "a@b.co"))}
        r = client.post("/api/share/inspect", json={"url": "https://youtu.be/heat"}, cookies=cookie, headers=origin)
        assert r.status_code == 200 and r.json()["kind"] == "trailer", r.text

    for fn in (trailer_titles_become_a_film_name_and_year, a_song_goes_straight_to_slap, a_trailer_offers_its_film_first,
               a_trailer_for_an_unknown_film_is_just_a_video, other_videos_and_pages_go_to_the_watch_party,
               an_imdb_page_is_a_movie, the_route_needs_a_session):
        check(fn.__name__, fn)


if __name__ == "__main__":
    tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
