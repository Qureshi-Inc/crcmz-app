#!/usr/bin/env python3
"""Slap Discover (slap_discover.py): new finds, downloads, expiry and picks credit.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_slap_discover

Nothing leaves the box: Jellyfin, slaptastic, the importer, Apple and Mattermost
are all fakes.
"""

import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-discover-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ["JELLYFIN_TOKEN"] = "test-jf"
os.environ["SLAP_ADMIN_TOKEN"] = "test-admin"
TMP = Path(tempfile.mkdtemp())
os.environ["SLAP_DISCOVER_DB"] = str(TMP / "slap_discover.db")
os.environ["SLAP_THUMBS_DB"] = str(TMP / "slap_thumbs.db")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import slap  # noqa: E402
import slap_discover as d  # noqa: E402

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


def run(coro):
    return asyncio.run(coro)


# ── A fake Jellyfin ──────────────────────────────────────────────────────────
class FakeJF:
    def __init__(self):
        self.tracks = [
            {"Id": "a" * 32, "Name": "Hotline Bling", "Artists": ["Drake"], "Album": "Views"},
            {"Id": "b" * 32, "Name": "Big Dawgs (feat. Kalmi)", "Artists": ["Hanumankind", "Kalmi"]},
        ]
        self.playlists: dict[str, dict] = {"p" * 32: {"Name": "moiz's picks", "items": ["a" * 32]}}
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, method, path, **kw):
        self.calls.append((method, path))
        params, body = kw.get("params") or {}, kw.get("json")
        if path == "/Users":
            return self.r([{"Id": "u" * 32, "Name": "admin", "Policy": {"IsAdministrator": True}},
                           {"Id": "v" * 32, "Name": "moiz", "Policy": {}}])
        if path == "/Items" and params.get("IncludeItemTypes") == "Audio":
            return self.r({"Items": self.tracks})
        if path == "/Items" and params.get("IncludeItemTypes") == "Playlist":
            return self.r({"Items": [{"Id": k, "Name": v["Name"]} for k, v in self.playlists.items()]})
        if method == "GET" and path.startswith("/Playlists/"):
            pid = path.split("/")[2]
            return self.r({"Items": [{"Id": i} for i in self.playlists[pid]["items"]]})
        if method == "POST" and path == "/Playlists":
            assert body["UserId"] == "u" * 32 and body["MediaType"] == "Audio"
            pid = f"{len(self.playlists):032x}"
            self.playlists[pid] = {"Name": body["Name"], "items": list(body.get("Ids") or [])}
            return self.r({"Id": pid})
        if method == "POST" and path.startswith("/Playlists/") and path.endswith("/Items"):
            assert params["userId"] == "u" * 32
            self.playlists[path.split("/")[2]]["items"] += params["ids"].split(",")
            return self.r(None, 204)
        if method == "DELETE" and path.startswith("/Items/"):
            del self.playlists[path.split("/")[2]]
            return self.r(None, 204)
        raise AssertionError(f"unexpected jellyfin call {method} {path}")

    @staticmethod
    def r(data, code=200):
        return httpx.Response(code, json=data) if data is not None else httpx.Response(code)

    def picks(self, name):
        return next((v["items"] for v in self.playlists.values() if v["Name"] == f"{name}'s picks"), None)


JF = FakeJF()
IMPORTER: list[tuple[str, dict]] = []
JOBS: dict[str, dict] = {}


async def fake_importer(path, body, timeout):
    IMPORTER.append((path, body))
    if path == "/jobs":
        jid = f"job-{len(JOBS) + 1}"
        JOBS[jid] = {"id": jid, "status": "pending", "url": body["url"], "title": None, "artist": None,
                     "requester_user_id": body.get("requester_user_id")}
        return JOBS[jid]
    if path.endswith("/approve"):
        JOBS[path.split("/")[2]]["status"] = "approved"
        return {"ok": True}
    raise AssertionError(path)


async def fake_importer_get(path):
    if path.startswith("/jobs?"):
        done = [j for j in JOBS.values() if j["status"] == "complete"]
        return {"items": done, "total": len(done), "page": 1, "per_page": 100}
    jid = path.split("/")[2]
    if jid not in JOBS:
        raise HTTPException(404, "not found")
    return JOBS[jid]


RECS = {
    "moiz": {"recommendations": ["Drake - Hotline Bling", "Kendrick Lamar - Not Like Us", "SZA - Saturn",
                                 "nonsense without a dash"], "reasoning": "You like rap."},
    "mutasif": {"recommendations": ["Kendrick Lamar - Not Like Us", "Hanumankind - Big Dawgs",
                                    "Fred again.. - Delilah"], "reasoning": "Bangers."},
}
APPLE = {
    ("Kendrick Lamar", "Not Like Us"): "1001", ("SZA", "Saturn"): "1002", ("Fred again..", "Delilah"): "1003",
}


async def fake_social_get(path, params):
    assert path == "dashboard/leaderboard"
    return {"entries": [{"username": "moiz"}, {"username": "mutasif"}]}


class FakeSocial:
    async def get(self, path, **kw):
        u = path.rsplit("/", 1)[1]
        return httpx.Response(200, json={"username": u, **RECS[u]})


async def fake_itunes(client, artist, title):
    aid = APPLE.get((artist, title))
    if not aid:
        return None
    return {"apple_id": aid, "title": title, "artist": artist, "album": "", "url": f"https://music.apple.com/us/album/x?i={aid}",
            "preview": f"https://audio-ssl.itunes.apple.com/{aid}.m4a", "art": "", "duration": 200}


slap._jf = JF
slap._importer = fake_importer
slap.social_get = fake_social_get
slap._social = FakeSocial()
d._importer_get = fake_importer_get
REAL_ITUNES = d.itunes_find
d.itunes_find = fake_itunes
d.ITUNES_GAP_S = 0


def reset():
    with d._conn() as db:
        db.executescript("DELETE FROM finds; DELETE FROM weeks; DELETE FROM credits; DELETE FROM offered; DELETE FROM shares;")
    slap._cache.clear()
    IMPORTER.clear(); JOBS.clear()
    d._last_poll = 0.0
    JF.__init__()


# ── Matching ─────────────────────────────────────────────────────────────────
def matching_tests():
    print("matching")

    def titles_match_through_features_and_remasters():
        assert d.same_song("Big Dawgs (feat. Kalmi)", "Hanumankind, Kalmi", "Big Dawgs", "Hanumankind")
        assert d.same_song("Wish You Were Here - 2011 Remaster", "Pink Floyd", "Wish You Were Here", "Pink Floyd")
        assert d.same_song("Beyoncé Song", "Beyoncé", "Beyonce Song", "Beyonce")
        assert not d.same_song("Hotline Bling", "Drake", "Hotline Bling", "Some Cover Band")
        assert not d.same_song("Saturn", "SZA", "Saturday", "SZA")

    def apple_results_must_be_the_same_song_and_on_apple():
        payload = {"results": [
            {"trackId": 9, "trackName": "Not Like Us (Karaoke)", "artistName": "Karaoke Kings",
             "trackViewUrl": "https://music.apple.com/us/album/k?i=9&uo=4"},
            {"trackId": 8, "trackName": "Not Like Us", "artistName": "Kendrick Lamar",
             "trackViewUrl": "https://evil.example/x"},
            {"trackId": 7, "trackName": "Not Like Us", "artistName": "Kendrick Lamar", "collectionName": "GNX",
             "trackViewUrl": "https://music.apple.com/us/album/n?i=7&uo=4",
             "previewUrl": "https://audio-ssl.itunes.apple.com/p.m4a",
             "artworkUrl100": "https://is1-ssl.mzstatic.com/a/100x100bb.jpg", "trackTimeMillis": 274000}]}
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, json=payload)))
        hit = run(REAL_ITUNES(client, "Kendrick Lamar", "Not Like Us"))
        assert hit and hit["apple_id"] == "7" and hit["url"] == "https://music.apple.com/us/album/n?i=7", hit
        assert hit["art"].endswith("600x600bb.jpg") and hit["duration"] == 274
        down = httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(503)))
        assert run(REAL_ITUNES(down, "Kendrick Lamar", "Not Like Us")) is None

    for fn in (titles_match_through_features_and_remasters, apple_results_must_be_the_same_song_and_on_apple):
        check(fn.__name__, fn)


# ── Making finds ─────────────────────────────────────────────────────────────
def finds_tests():
    print("new finds")

    def a_day_of_finds_skips_the_library_and_duplicates():
        reset()
        assert run(d.generate()) == 3
        cur = d.current()
        got = [(f["title"], f["for"]) for f in cur["finds"]]
        # Round-robin by person. Hotline Bling and Big Dawgs are already in the library;
        # Not Like Us is suggested twice; the line without " - " isn't a song.
        assert got == [("Not Like Us", "mutasif"), ("Saturn", "moiz"), ("Delilah", "mutasif")], got
        assert all(f["status"] == "new" and f["preview"] for f in cur["finds"])
        assert cur["why"]["moiz"] == "You like rap."
        assert cur["expires"] > time.time() * 1000

    def finds_are_made_once_a_day():
        reset()
        run(d.generate())
        RECS["moiz"]["recommendations"].append("Someone - New Song")
        try:
            assert run(d.generate()) == 3 and not d.needs_finds(d.week_of())
        finally:
            RECS["moiz"]["recommendations"].pop()

    def an_empty_day_tries_again_later():
        reset()
        old = d._recommendations
        async def none():
            return []
        d._recommendations = none
        try:
            assert run(d.generate()) == 0
        finally:
            d._recommendations = old
        assert not d.needs_finds(d.week_of())
        assert d.needs_finds(d.week_of(), now=time.time() + d.EMPTY_RETRY_S + 60)

    def yesterdays_undownloaded_finds_are_deleted():
        reset()
        last = d.week_of(time.time() - 86400)
        run(d.generate(last))
        with d._conn() as db:
            db.execute("UPDATE finds SET status='queued' WHERE week=? AND apple_id='1001'", (last,))
            db.execute("UPDATE finds SET status='done' WHERE week=? AND apple_id='1002'", (last,))
        assert d.prune() == 2
        with d._conn() as db:
            left = [r[0] for r in db.execute("SELECT apple_id FROM finds")]
        assert left == ["1001"], "a download still in flight is kept until it lands"

    def a_new_day_starts_at_midnight_pacific():
        import datetime as dt
        day = d.week_of()
        assert len(day) == 10 and dt.date.fromisoformat(day)
        end = d.expires_at(day) / 1000
        assert d.week_of(end - 1) == day and d.week_of(end + 1) != day
        assert 23 * 3600 <= end - dt.datetime.fromisoformat(day).replace(tzinfo=d._TZ).timestamp() <= 25 * 3600

    def each_day_brings_songs_it_didnt_just_offer():
        reset()
        yesterday = d.week_of(time.time() - 86400)
        run(d.generate(yesterday))      # Not Like Us, Saturn, Delilah offered yesterday
        RECS["moiz"]["recommendations"].insert(0, "Doechii - Anxiety")
        APPLE[("Doechii", "Anxiety")] = "1004"
        old = d.FINDS_MAX
        d.FINDS_MAX = 2
        try:
            run(d.generate())
            got = [f["title"] for f in d.current()["finds"]]
            assert got[0] == "Anxiety" and len(got) == 2, got   # new first, then a repeat to fill
        finally:
            d.FINDS_MAX = old
            RECS["moiz"]["recommendations"].pop(0)
            APPLE.pop(("Doechii", "Anxiety"))

    for fn in (a_day_of_finds_skips_the_library_and_duplicates, finds_are_made_once_a_day,
               an_empty_day_tries_again_later, yesterdays_undownloaded_finds_are_deleted,
               a_new_day_starts_at_midnight_pacific, each_day_brings_songs_it_didnt_just_offer):
        check(fn.__name__, fn)


# ── Downloading ──────────────────────────────────────────────────────────────
def download_tests():
    print("downloads")

    def download_queues_a_job_and_credits_the_presser():
        reset()
        run(d.generate())
        f = run(d.download("u-zub", "zubair221b", "1001"))
        assert f["status"] == "queued" and f["by"] == "zubair221b"
        assert IMPORTER == [("/jobs", {"url": "https://music.apple.com/us/album/x?i=1001"})], IMPORTER
        again = run(d.download("u-noor", "nooramin40", "1001"))
        assert again["by"] == "zubair221b" and len(IMPORTER) == 1, "a second press doesn't queue it twice"
        with d._conn() as db:
            assert db.execute("SELECT name FROM credits").fetchone()[0] == "zubair221b"

    def a_finished_download_lands_in_the_pressers_picks():
        reset()
        run(d.generate())
        run(d.download("u-zub", "zubair221b", "1001"))
        JOBS["job-1"].update(status="complete", title="Not Like Us", artist="Kendrick Lamar")
        JF.tracks.append({"Id": "c" * 32, "Name": "Not Like Us", "Artists": ["Kendrick Lamar"]})
        assert run(d.follow_downloads(force=True)) == 1
        f = next(x for x in d.current()["finds"] if x["id"] == "1001")
        assert f["status"] == "done" and f["track_id"] == "c" * 32
        assert JF.picks("zubair221b") == ["c" * 32], JF.playlists

    def a_download_with_a_mattermost_id_is_slaptastics_to_credit():
        reset()
        run(d.generate())
        run(d.download("u-moose", "mutasif", "1001", picks="themoosecompany", requester="a7a5hiwbe3n57koxmxbhu74jqh"))
        assert IMPORTER[0][1] == {"url": "https://music.apple.com/us/album/x?i=1001",
                                  "requester_user_id": "a7a5hiwbe3n57koxmxbhu74jqh"}, IMPORTER
        JOBS["job-1"].update(status="complete", title="Not Like Us", artist="Kendrick Lamar")
        JF.tracks.append({"Id": "c" * 32, "Name": "Not Like Us", "Artists": ["Kendrick Lamar"]})
        run(d.follow_downloads(force=True))
        assert d._find(d.week_of(), "1001")["status"] == "done"
        assert JF.picks("themoosecompany") is None, "slaptastic files it; we don't add it twice"

    def failed_and_unsure_downloads_say_so():
        reset()
        run(d.generate())
        run(d.download("u-zub", "zubair221b", "1001"))
        run(d.download("u-zub", "zubair221b", "1002"))
        JOBS["job-1"].update(status="failed", error_message="no match")
        JOBS["job-2"].update(status="reviewing")
        run(d.follow_downloads(force=True))
        st = {f["id"]: (f["status"], f["error"]) for f in d.current()["finds"]}
        assert st["1001"] == ("failed", "no match") and st["1002"][0] == "review", st
        run(d.approve("1002"))
        assert JOBS["job-2"]["status"] == "approved" and d._find(d.week_of(), "1002")["status"] == "queued"
        retry = run(d.download("u-zub", "zubair221b", "1001"))
        assert retry["status"] == "queued" and len(JOBS) == 3, "a failed one can be tried again"

    def a_song_already_in_the_library_is_not_downloaded_again():
        reset()
        run(d.generate())
        JF.tracks.append({"Id": "d" * 32, "Name": "Saturn", "Artists": ["SZA"]})
        f = run(d.download("u-zub", "zubair221b", "1002"))
        assert f["status"] == "done" and f["track_id"] == "d" * 32 and IMPORTER == []

    def expired_finds_and_too_many_downloads_are_refused():
        reset()
        try:
            run(d.download("u-zub", "zubair221b", "1001"))
        except HTTPException as e:
            assert e.status_code == 404
        else:
            raise AssertionError("an expired find downloaded")
        run(d.generate())
        with d._conn() as db:
            for n in range(d.DOWNLOADS_PER_DAY):
                db.execute("INSERT INTO credits VALUES (?, 'u-zub', 'z', 't', 'a', ?)", (f"old-{n}", time.time()))
        try:
            run(d.download("u-zub", "zubair221b", "1001"))
        except HTTPException as e:
            assert e.status_code == 429
        else:
            raise AssertionError("no daily cap")

    for fn in (download_queues_a_job_and_credits_the_presser, a_finished_download_lands_in_the_pressers_picks,
               a_download_with_a_mattermost_id_is_slaptastics_to_credit,
               failed_and_unsure_downloads_say_so, a_song_already_in_the_library_is_not_downloaded_again,
               expired_finds_and_too_many_downloads_are_refused):
        check(fn.__name__, fn)


# ── Picks playlists ──────────────────────────────────────────────────────────
def picks_tests():
    print("picks playlists")

    def a_download_lands_in_the_chart_picks_not_the_login():
        reset()
        run(d.generate())
        f = run(d.download("u-noor", "noor", "1001", picks="nooramin40"))
        assert f["by"] == "noor"
        JOBS["job-1"].update(status="complete", title="Not Like Us", artist="Kendrick Lamar")
        JF.tracks.append({"Id": "c" * 32, "Name": "Not Like Us", "Artists": ["Kendrick Lamar"]})
        run(d.follow_downloads(force=True))
        assert JF.picks("nooramin40") == ["c" * 32] and JF.picks("noor") is None, JF.playlists

    def picks_go_by_the_chart_name():
        assert d.picks_name({"mm_username": "themoosecompany", "jellyfin_user": "mutasif"}) == "themoosecompany"
        assert d.picks_name({"mm_username": "", "jellyfin_user": "noor"}) == "noor"

    for fn in (a_download_lands_in_the_chart_picks_not_the_login, picks_go_by_the_chart_name):
        check(fn.__name__, fn)


# ── HTTP and the assistant ───────────────────────────────────────────────────
def http_tests():
    from fastapi.testclient import TestClient
    import server
    import assistant

    print("routes")
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    origin = {"Origin": "https://app.crcmz.me"}
    cookie = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("u-zub", "z@b.co"))}
    person = {"zitadel_id": "u-zub", "display_name": "Zubair", "username": "zubair221b"}
    import crcmz_identity
    crcmz_identity.by_zitadel_id = lambda refresh=False: {"u-zub": person}

    d.mm_id = lambda p: ""

    async def fake_jf_user(sub, p):
        return {"id": "z" * 32, "name": "zubair221b"}, False
    slap.resolve_jellyfin = fake_jf_user

    def every_member_reads_as_their_name_by_any_username():
        import crcmz_identity
        nooni = {"zitadel_id": "u-n", "display_name": "Nooni", "username": "nuharqam@gmail.com",
                 "tags": {"mm_username": "nuharqam", "jellyfin_user": "mythnuni", "chosen_username": "mythnuni"}}
        reviewer = {"zitadel_id": "u-r", "display_name": "App Review", "tags": {"review": "true", "mm_username": "appreview"}}
        old = crcmz_identity.people
        crcmz_identity.people = lambda refresh=False: [person, nooni, reviewer]
        try:
            r = client.get("/api/slap/names", cookies=cookie)
            assert r.status_code == 200, r.text
            n = r.json()
            assert n["nuharqam"] == "Nooni" and n["mythnuni"] == "Nooni", n
            assert "appreview" not in n, "the App Store reviewer stays out"
            assert client.get("/api/slap/names").status_code == 401
        finally:
            crcmz_identity.people = old

    def the_app_review_account_gets_no_new_finds():
        reset()
        run(d.generate())
        person["tags"] = {"review": "true"}
        try:
            r = client.get("/api/slap/discover", cookies=cookie)
            assert r.status_code == 200 and r.json()["off"] is True and r.json()["finds"] == [], r.text
            assert client.post("/api/slap/discover/download", json={"id": "1001"}, cookies=cookie, headers=origin).status_code == 403
        finally:
            person.pop("tags")

    def discover_needs_a_session_and_downloads_credit_the_caller():
        reset()
        run(d.generate())
        assert client.get("/api/slap/discover").status_code == 401
        r = client.get("/api/slap/discover", cookies=cookie)
        assert r.status_code == 200 and len(r.json()["finds"]) == 3, r.text
        assert client.post("/api/slap/discover/download", json={"id": "x"}, cookies=cookie, headers=origin).status_code == 400
        r = client.post("/api/slap/discover/download", json={"id": "1001"}, cookies=cookie, headers=origin)
        assert r.status_code == 200 and r.json()["by"] == "zubair221b", r.text
        assert client.post("/api/slap/discover/approve", json={"id": "1001"}, cookies=cookie, headers=origin).status_code == 403

    def assistant_tool_shows_finds_without_ids():
        assert "slap_discover" in assistant.tool_names()
        out, ok = assistant.call_tool("slap_discover", {"limit": 5000})
        assert ok and "Not Like Us" in out and "zubair221b" in out, out
        for leak in ("u-zub", "job-", "music.apple.com"):
            assert leak not in out, leak

    def a_shared_song_downloads_and_the_sharer_hears_when_its_in():
        reset()
        told: list[tuple] = []
        d.notify = lambda *a, **k: told.append((a, k))
        try:
            assert client.post("/api/slap/share", json={"text": "look https://example.com/x"}, cookies=cookie, headers=origin).status_code == 400
            r = client.post("/api/slap/share", cookies=cookie, headers=origin,
                            json={"text": "Saturn by SZA https://open.spotify.com/track/abc?si=1)", "url": ""})
            assert r.status_code == 200 and r.json()["status"] == "downloading" and "job_id" not in r.json(), r.text
            assert IMPORTER[-1][1]["url"] == "https://open.spotify.com/track/abc?si=1", IMPORTER[-1]
            assert d.shares_pending()
            run(d.follow_shares())
            assert told == [], "still downloading: nothing to say"
            have = JF.tracks[0]
            jid = list(JOBS)[-1]
            JOBS[jid].update(status="complete", title=have["Name"], artist=(have.get("Artists") or [""])[0])
            run(d.follow_shares())
            (cat, title, *_), kw = told[-1]
            assert cat == "music" and have["Name"] in title and kw["only"] == ["u-zub"] and kw["dms"] is False, told
            assert not d.shares_pending()
            person["tags"] = {"review": "true"}
            try:
                assert client.post("/api/slap/share", json={"url": "https://open.spotify.com/track/abc"}, cookies=cookie, headers=origin).status_code == 403
            finally:
                person.pop("tags")
        finally:
            d.notify = None

    for fn in (discover_needs_a_session_and_downloads_credit_the_caller, assistant_tool_shows_finds_without_ids,
               the_app_review_account_gets_no_new_finds, every_member_reads_as_their_name_by_any_username,
               a_shared_song_downloads_and_the_sharer_hears_when_its_in):
        check(fn.__name__, fn)


def add_song_tests():
    print("add a song (AI / MCP)")
    import assistant
    import crcmz_identity
    import mcp_oauth
    moiz = {"zitadel_id": "u-moiz", "display_name": "Moiz", "mm_username": "moiz", "email": "m@x.co"}
    noor = {"zitadel_id": "u-noor", "display_name": "kaptaan noor", "mm_username": "nooramin40", "email": "n@x.co"}
    crcmz_identity.by_zitadel_id = lambda refresh=False: {"u-moiz": moiz, "u-noor": noor}
    crcmz_identity.resolve = lambda q: {"noor": noor, "nooramin40": noor, "moiz": moiz}.get(q.lower())
    old_mm = d.mm_id
    d.mm_id = lambda p: {"u-moiz": "mm-moiz", "u-noor": "mm-noor"}.get(p["zitadel_id"], "")
    mcp_oauth.within_rate_limit = lambda *a, **k: True
    mcp_oauth.audit_write = lambda *a, **k: None

    def a_title_downloads_for_the_asker_credited_to_them():
        reset()
        out = assistant._slap_add_song(title="Saturn", artist="SZA", caller={"zitadel_id": "u-moiz"})
        assert out["ok"] and out["status"] == "downloading" and out["picks"] == "moiz", out
        path, body = IMPORTER[-1]
        assert path == "/jobs" and body["url"].startswith("https://music.apple.com/") and body["requester_user_id"] == "mm-moiz", IMPORTER

    def it_can_be_for_someone_else():
        reset()
        out = assistant._slap_add_song(url="https://open.spotify.com/track/abc", for_person="noor",
                                       caller={"zitadel_id": "u-moiz"})
        assert out["ok"] and out["picks"] == "nooramin40" and IMPORTER[-1][1]["requester_user_id"] == "mm-noor", out

    def unknown_asker_means_ask_who_its_for():
        reset()
        out = assistant._slap_add_song(title="Saturn", artist="SZA", caller={})
        assert "ask" in out and not IMPORTER, out
        out = assistant._slap_add_song(title="Saturn", artist="SZA", for_person="Stranger", caller={"zitadel_id": "u-moiz"})
        assert "ask" in out and not IMPORTER, out

    def only_music_links_and_not_twice():
        reset()
        assert "error" in assistant._slap_add_song(url="https://evil.example/x.mp3", caller={"zitadel_id": "u-moiz"})
        have = JF.tracks[0]
        out = assistant._slap_add_song(title=have["Name"], artist=(have.get("Artists") or [""])[0], caller={"zitadel_id": "u-moiz"})
        assert out.get("status") == "already_in_library" and not IMPORTER, out

    def only_the_private_app_chat_gets_it():
        assert "slap_add_song" in assistant.write_tool_names() and "slap_add_song" not in assistant.tool_names()
        assert assistant._chat_write_specs() == [], "no writer: no write tools (group chats)"
        tok = assistant._CHAT_WRITER.set({"zitadel_id": "u-moiz"})
        try:
            assert [t["function"]["name"] for t in assistant._chat_write_specs()] == ["slap_add_song"]
        finally:
            assistant._CHAT_WRITER.reset(tok)

    try:
        for fn in (a_title_downloads_for_the_asker_credited_to_them, it_can_be_for_someone_else,
                   unknown_asker_means_ask_who_its_for, only_music_links_and_not_twice,
                   only_the_private_app_chat_gets_it):
            check(fn.__name__, fn)
    finally:
        d.mm_id = old_mm


if __name__ == "__main__":
    matching_tests()
    finds_tests()
    download_tests()
    picks_tests()
    add_song_tests()
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
