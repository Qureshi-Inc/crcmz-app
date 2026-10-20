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


PAGES = {"https://www.netflix.com/title/123": {"title": "Heat | Netflix", "type": "video.movie", "imdb": ""},
         "https://letterboxd.com/film/heat-1995/": {"title": "Heat (1995)", "type": "video.movie", "imdb": "tt0113277"},
         "https://cinejoy.to/movie/heat": {"title": "Watch Heat (1995) Online Free - Cinejoy", "type": "", "imdb": ""},
         "https://www.netflix.com/title/999": {"title": "Heat | Netflix", "type": "video.movie", "imdb": ""}}


async def fake_page(url):
    return {"url": url, **PAGES.get(url, {"title": "", "type": "", "imdb": ""})}


movies.search, movies.meta, movies.library_index = fake_search, fake_meta, fake_index
share.youtube_title = fake_title
share.page_info = fake_page
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
        assert r["kind"] == "video" and r["movie"] is None and r["auto"] == "watch", r

    def videos_and_shorts_play_in_the_watch_party_straight_away():
        r = run(share.inspect(url="https://youtu.be/song"))
        assert r["kind"] == "video" and r["auto"] == "watch" and r["video_title"] == "Drake - Hotline Bling"
        for u in ("https://www.tiktok.com/@a/video/1", "https://x.com/a/status/1", "https://www.instagram.com/reel/abc/",
                  "https://www.facebook.com/watch/?v=1", "https://www.snapchat.com/spotlight/abc", "https://cdn.example.com/film.mp4"):
            r = run(share.inspect(url=u))
            assert r["kind"] == "video" and r["auto"] == "watch", (u, r)
        assert run(share.inspect(text="no link here"))["kind"] == "none"

    def a_film_page_is_found_and_added_straight_away():
        r = run(share.inspect(url="https://m.imdb.com/title/tt0113277/?ref_=x"))
        assert r["kind"] == "movie" and r["auto"] == "movie" and r["movie"]["title"] == "Heat", r
        r = run(share.inspect(url="https://letterboxd.com/film/heat-1995/"))
        assert r["auto"] == "movie" and r["movie"]["imdb"] == HEAT["imdb"], r
        r = run(share.inspect(url="https://www.google.com/search?q=heat+1995+movie"))
        assert r["auto"] == "movie" and r["movie"]["imdb"] == HEAT["imdb"], r
        r = run(share.inspect(url="https://cinejoy.to/movie/heat"))
        assert r["auto"] == "movie" and r["movie"]["year"] == "1995", r

    def a_page_built_in_the_browser_is_found_by_the_title_the_share_sheet_sent():
        PAGES["https://cinejoy.to/movie/949"] = {"title": "Cinejoy", "type": "", "imdb": ""}
        r = run(share.inspect(url="https://cinejoy.to/movie/949", title="Heat (1995) | Cinejoy"))
        assert r["auto"] == "movie" and r["movie"]["imdb"] == HEAT["imdb"], r
        r = run(share.inspect(url="https://cinejoy.to/movie/1"))
        assert r["choices"] == ["search"], r

    def an_unclear_film_offers_the_likely_ones():
        r = run(share.inspect(url="https://www.netflix.com/title/123"))
        assert r["kind"] == "movie" and r["auto"] is None and r["movie"]["title"] == "Heat" and len(r["candidates"]) >= 1, r

    def the_route_needs_a_session():
        from fastapi.testclient import TestClient
        import server
        client = TestClient(server.app, base_url="https://app.crcmz.me")
        origin = {"Origin": "https://app.crcmz.me"}
        assert client.post("/api/share/inspect", json={"url": "https://youtu.be/heat"}, headers=origin).status_code == 401
        cookie = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("u1", "a@b.co"))}
        r = client.post("/api/share/inspect", json={"url": "https://youtu.be/heat"}, cookies=cookie, headers=origin)
        assert r.status_code == 200 and r.json()["kind"] == "trailer", r.text

    def a_link_left_for_the_app_is_picked_up_once():
        from fastapi.testclient import TestClient
        import server
        client = TestClient(server.app, base_url="https://app.crcmz.me")
        origin = {"Origin": "https://app.crcmz.me"}
        cookie = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("u1", "a@b.co"))}
        assert client.post("/api/share/pending", json={"url": "nope"}, cookies=cookie, headers=origin).status_code == 400
        assert client.post("/api/share/pending", json={"url": "https://youtu.be/x"}, cookies=cookie, headers=origin).status_code == 200
        assert client.get("/api/share/pending", cookies=cookie).json()["url"] == "https://youtu.be/x"
        assert client.get("/api/share/pending", cookies=cookie).json()["url"] == ""

    def a_shared_together_link_previews_itself():
        """The Listen Together link gets shared into WhatsApp, which reads the document.

        frontend/dist is a build artifact and is not in git, so this checks the tags and
        the injection directly rather than going through the /app route.
        """
        import server
        from starlette.datastructures import QueryParams
        og = server._og_preview("slap", QueryParams("join=together"))
        assert '<meta property="og:title" content="Listen Together on Slap">' in og, og
        assert '<meta name="twitter:card" content="summary_large_image">' in og, og
        assert "https://app.crcmz.me/crcmz-logo.png" in og, og
        assert '<meta property="og:url" content="https://app.crcmz.me/app/slap?join=together">' in og, og
        # A link-preview crawler is never signed in, so this must not say who is in the room.
        assert "listening" not in og.lower(), og
        # Every other page keeps the plain document.
        assert server._og_preview("slap", QueryParams("")) == ""
        assert server._og_preview("slap", QueryParams("join=nope")) == ""
        assert server._og_preview("squad", QueryParams("join=together")) == ""
        assert server._og_preview("", QueryParams("join=together")) == ""

    def a_signed_out_fetcher_gets_the_preview_and_nothing_else():
        """WhatsApp fetches a shared link with no session. It must see the preview tags,
        a person must be sent to sign in, and every neighbouring page stays gated."""
        from fastapi.testclient import TestClient
        import server
        client = TestClient(server.app, base_url="https://app.crcmz.me", follow_redirects=False)
        html = {"Accept": "text/html", "User-Agent": "WhatsApp/2.23"}
        r = client.get("/app/slap?join=together", headers=html)
        assert r.status_code == 200, r.status_code
        assert '<meta property="og:title" content="Listen Together on Slap">' in r.text, r.text
        assert "/auth/login?next=/app/slap%3Fjoin%3Dtogether" in r.text, r.text
        assert "/app/assets/" not in r.text, "the app itself must not be served signed out"
        assert server._safe_next("/app/slap?join=together") == "/app/slap?join=together"
        # Anything else under /app still demands a session.
        for p in ("/app/slap", "/app/slap?join=nope", "/app/squad?join=together", "/slap?join=together"):
            g = client.get(p, headers=html)
            assert g.status_code == 302 and "/auth/login" in g.headers["location"], (p, g.status_code)
        assert client.post("/app/slap?join=together").status_code == 401
        assert client.get("/api/slap/together").status_code == 401
        assert client.get("/api/slap/library").status_code == 401
        # Song shares reach their own handlers, which check the id themselves.
        s = client.get("/share/song/not-an-id", headers=html)
        assert s.status_code == 302 and s.headers["location"] == "/app/slap", s.status_code
        assert client.get("/share/art/not-an-id").status_code == 404
        assert client.get("/share/songs").status_code == 401
        assert client.post("/share/song/" + "0" * 32).status_code == 401

    for fn in (a_shared_together_link_previews_itself, a_signed_out_fetcher_gets_the_preview_and_nothing_else,
               a_link_left_for_the_app_is_picked_up_once, trailer_titles_become_a_film_name_and_year, a_song_goes_straight_to_slap, a_trailer_offers_its_film_first,
               a_trailer_for_an_unknown_film_is_just_a_video, videos_and_shorts_play_in_the_watch_party_straight_away,
               a_film_page_is_found_and_added_straight_away, a_page_built_in_the_browser_is_found_by_the_title_the_share_sheet_sent, an_unclear_film_offers_the_likely_ones, the_route_needs_a_session):
        check(fn.__name__, fn)


if __name__ == "__main__":
    tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
