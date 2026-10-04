#!/usr/bin/env python3
"""Watch · Library (movies.py): choosing a copy, adding through Real-Debrid, copying it onto
the server's disk, Jellyfin, notifications, the migration, streaming.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_movies

Nothing leaves the box: Real-Debrid, Torrentio, Cinemeta and Jellyfin are fakes, and
Real-Debrid's download server is a local HTTPServer (so the real httpx download path,
Range resume included, runs against it).
"""

import asyncio
import collections
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-movies-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ["JELLYFIN_TOKEN"] = "test-jf"
os.environ["REAL_DEBRID_TOKEN"] = "test-rd"
TMP = Path(tempfile.mkdtemp())
os.environ["MOVIES_DB"] = str(TMP / "movies.db")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import movies as mv  # noqa: E402
import slap  # noqa: E402

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


def st(tag, release, gb, seeds, h, extra="", filename=""):
    return {"name": f"Torrentio\n{tag}", "infoHash": h * 40 if len(h) == 1 else h,
            "title": f"{release}\n👤 {seeds} 💾 {gb} GB ⚙️ TorrentGalaxy{extra}",
            "behaviorHints": {"filename": filename or release + ".mkv"}}


# Shaped like Torrentio's real answer for Dune: Part Two.
DUNE = [
    st("4k DV | HDR", "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX[TGx]", "29.26", 433, "a"),
    st("4k DV", "Dune.Part.Two.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR", "64.29", 236, "b"),
    st("4k DV | HDR", "Dune.Part.Two.2024.2160p.10bit.HDR.DV.BluRay.8CH.x265.HEVC-PSA", "3.46", 147, "c"),
    st("4k HDR", "Dune.Part.Two.(2024).(2160p.BluRay.x265.HEVC.10bit.HDR.AAC.7.1.Tigole) [QxR]", "12.76", 71, "d"),
    st("4k DV | HDR10+", "Dune.Part.Two.2024.MULTI.VFF.2160p.4KLight.DV.HDR10Plus.WEBRip-ESPER", "7.26", 42, "e", " / Multi Audio / 🇫🇷"),
    st("4k DV", "Dune.Part.Two.2024.2160p.WEB-DL.DV.H.265-NOHDR", "18.0", 300, "f"),
    st("4k HDR", "Dune.Parte.Due.2024.2160p.HDR.WEB-DL.ITA", "14.0", 90, "1", " / 🇮🇹"),
    st("1080p", "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP", "11.2", 500, "2"),
    st("1080p", "Dune.Part.Two.2024.1080p.HDCAM.x264", "2.0", 900, "3"),
    st("720p", "Dune.Part.Two.2024.720p.WEB", "1.2", 50, "4"),
    st("4k HDR", "Dune.Part.Two.2024.2160p.HDR.WEB-DL [ABCD1234]", "15.0", 80, "5"),
    st("4k HDR", "Dune Part Two (2024) Featurettes (2160p BluRay x265 HDR)", "8.0", 400, "6"),
    st("4k", "Dune.Part.Two.2024.2160p.BluRay.x265-SMALL", "6.5", 800, "7"),
    st("4k DV", "Dune.Part.Two.2024.UHD.Blu-ray.2160p.DTS-HD.MA.5.1.DV.HEVC.x265-E", "17.5", 21, "8"),
]


# ── Fakes ────────────────────────────────────────────────────────────────────
FILE_BYTES = 300_000


def blob(n: int) -> bytes:
    return bytes((i * 7 + i // 251) % 256 for i in range(n))


class _DL(BaseHTTPRequestHandler):
    """Real-Debrid's download host: serves a file, honouring Range like the real one."""
    def log_message(self, *a):
        pass

    def do_GET(self):
        data = DL.files.get(self.path.rsplit("/", 1)[1])
        if data is None:
            self.send_response(404); self.end_headers(); return
        DL.ranges.append(self.headers.get("Range") or "")
        start = 0
        if (rng := self.headers.get("Range")) and rng.startswith("bytes="):
            start = int(rng[6:].split("-")[0])
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
        else:
            self.send_response(200)
        body = data[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class DLServer:
    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.ranges: list[str] = []
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), _DL)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()


DL = DLServer()


class FakeRD:
    def __init__(self, cached=()):
        self.cached = set(cached)
        self.torrents: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.filesize: dict[str, int] = {}

    async def __call__(self, method, path, **kw):
        self.calls.append((method, path))
        data = kw.get("data") or {}
        if path == "/torrents/addMagnet":
            h = data["magnet"].rsplit(":", 1)[1]
            if h in getattr(self, "blocked", set()):
                raise HTTPException(451, "Real-Debrid has that copy blocked")
            tid = f"T{len(self.torrents) + 1}"
            self.torrents[tid] = {"hash": h, "status": "waiting_files_selection", "progress": 0,
                                  "files": [{"id": 1, "path": "/Sample/sample.mkv", "bytes": 10, "selected": 0},
                                            {"id": 2, "path": "/Movie.mkv", "bytes": FILE_BYTES, "selected": 0}],
                                  "links": []}
            return {"id": tid}
        if method == "GET" and path == "/torrents":
            return [{"id": k, "filename": v.get("filename", ""), "status": v.get("status", "downloaded")}
                    for k, v in self.torrents.items()]
        if path == "/unrestrict/link":
            tid = data["link"].rsplit("/", 1)[1]
            f = next(f for f in self.torrents[tid]["files"] if f["selected"])
            DL.files[tid] = DL.files.get(tid) or blob(f["bytes"])
            return {"download": f"{DL.url}/dl/{tid}", "filesize": self.filesize.get(tid, f["bytes"]),
                    "filename": f["path"].rsplit("/", 1)[1]}
        tid = path.rsplit("/", 1)[1]
        t = self.torrents.get(tid)
        if path.startswith("/torrents/info/"):
            return {**t, "files": t["files"]}
        if path.startswith("/torrents/selectFiles/"):
            assert data["files"] == "2", data
            t["files"][1]["selected"] = 1
            t["links"] = [f"https://real-debrid.com/d/{tid}"]
            t["status"] = "downloaded" if t["hash"] in self.cached else "downloading"
            t["progress"] = 100 if t["status"] == "downloaded" else 3
            return None
        if path.startswith("/torrents/delete/"):
            if tid not in self.torrents:
                raise HTTPException(404, "unknown_ressource")
            del self.torrents[tid]
            return None
        raise AssertionError(path)


class FakeJF:
    def __init__(self):
        self.items: list[dict] = []
        self.calls: list[tuple[str, str, dict]] = []
        self.sessions: list[dict] = []

    async def __call__(self, method, path, **kw):
        self.calls.append((method, path, kw.get("params") or {}))
        if path == "/Library/VirtualFolders":
            return httpx.Response(200, json=[{"Name": "Music", "CollectionType": "music", "ItemId": "m" * 32},
                                             {"Name": "Movies", "CollectionType": "movies", "ItemId": "f" * 32}])
        if path == "/Items":
            assert kw["params"]["ParentId"] == "f" * 32
            return httpx.Response(200, json={"Items": self.items})
        if method == "POST" and path.endswith("/Refresh"):
            return httpx.Response(204)
        if path == "/Sessions":
            return httpx.Response(200, json=self.sessions)
        if path.endswith(".m3u8"):
            return httpx.Response(200, text="#EXTM3U\nmain.m3u8?x=1")
        raise AssertionError(path)

    def movie(self, iid, name, imdb, width=3840, rng="HDR10", path="/zurg/movies/x/x.mkv", size=0):
        self.items.append({"Id": iid, "Name": name, "ProductionYear": 2024, "ProviderIds": {"Imdb": imdb},
                           "Path": path, "DateCreated": f"2026-10-0{len(self.items) + 1}T00:00:00Z",
                           "MediaSources": [{"Size": size, "MediaStreams": [{"Type": "Video", "Width": width, "VideoRangeType": rng}]}]})


RD = FakeRD()
JF = FakeJF()
TORRENTIO: dict[str, list] = {"tt15239678": DUNE}
NOTES: list[tuple] = []


async def fake_torrentio(imdb):
    return TORRENTIO.get(imdb, [])


async def fake_cinemeta(path):
    if path.startswith("meta/movie/tt15239678"):
        return {"meta": {"imdb_id": "tt15239678", "name": "Dune: Part Two", "releaseInfo": "2024",
                         "poster": "https://images.metahub.space/poster/medium/tt15239678/img"}}
    if path.startswith("meta/movie/tt7777777"):
        return {"meta": {"imdb_id": "tt7777777", "name": "Trailer Test", "releaseInfo": "2020", "runtime": "123 min",
                         "imdbRating": "7.9", "genres": ["Drama"], "cast": ["A", "B"], "director": ["D"],
                         "poster": "https://images.metahub.space/poster/small/tt7777777/img",
                         "background": "http://insecure.example/bg.jpg", "logo": "https://images.metahub.space/logo/medium/tt7777777/img",
                         "trailers": [{"source": "U2Qp5pL3ovA"}, {"source": "U2Qp5pL3ovA"}, {"source": "<script>"}]}}
    if path.startswith("meta/movie/"):
        imdb = path.split("/")[2].split(".")[0]
        return {"meta": {"imdb_id": imdb, "name": f"Film {imdb}", "releaseInfo": "2001"}}
    if path.startswith("catalog/movie/") and "search=" not in path:
        CATALOG_CALLS.append(path)
        # Each list: a page of films, some shared with the others, one unrated.
        base = [("tt1000001", "Shared One", "6.1"), ("tt1000002", "Shared Two", ""), ("tt1000003", "Great", "9.1"),
                ("tt1000004", "Good", "7.4"), ("tt1000005", "Meh", "5.0")]
        extra = [(f"tt2{abs(hash(path)) % 10**5:05d}{i}", f"{path.split('/')[2]} {i}", f"{6 + i % 4}.{i}") for i in range(12)]
        return {"metas": [{"imdb_id": i, "name": n, "releaseInfo": "2026", "imdbRating": r, "genres": ["Horror"],
                           "poster": f"https://images.metahub.space/poster/small/{i}/img",
                           "background": f"https://images.metahub.space/background/medium/{i}/img"} for i, n, r in base + extra]}
    if path.startswith("catalog/movie/top/search="):
        return {"metas": [{"imdb_id": "tt15239678", "name": "Dune: Part Two", "releaseInfo": "2024"},
                          {"imdb_id": "tt1160419", "name": "Dune", "releaseInfo": "2021"},
                          {"id": "bogus", "name": "No id"}]}
    raise AssertionError(path)


CATALOG_CALLS: list[str] = []
mv._rd = RD
mv._torrentio = fake_torrentio
mv._cinemeta = fake_cinemeta
slap._jf = JF


mv.POLL_S = 0   # no real waiting between Real-Debrid checks
mv.RESCAN_AFTER_S = 0


import notifications  # noqa: E402
notifications.route_in_background = lambda *a, **k: NOTES.append((a, k))
CHANNEL: list[str] = []
mv.announce_channel = lambda text: CHANNEL.append(text) or True

import crcmz_identity  # noqa: E402
PEOPLE = [{"zitadel_id": "u-zub", "display_name": "Zubair", "state": "USER_STATE_ACTIVE"},
          {"zitadel_id": "u-noor", "display_name": "Noor", "state": "USER_STATE_ACTIVE"},
          {"zitadel_id": "u-gone", "display_name": "Gone", "state": "USER_STATE_INACTIVE"},
          {"zitadel_id": "bot-psn", "display_name": "PSN bot", "is_bot": True}]
crcmz_identity.people = lambda refresh=False: list(PEOPLE)


def reset(cached=()):
    with mv._conn() as db:
        db.execute("DELETE FROM adds")
        db.execute("DELETE FROM removed")
        db.execute("DELETE FROM meta")
    mv._streamed.clear()
    mv._copy_fails.clear()
    DL.files.clear()
    DL.ranges.clear()
    RD.__init__(cached)
    JF.__init__()
    mv._cache.clear()
    mv._last_tick = mv._last_scan = 0.0
    NOTES.clear()
    CHANNEL.clear()


async def and_wait(coro):
    r = await coro
    await asyncio.gather(*list(mv._tasks))
    return r


async def add_and_wait(sub, name, imdb, **kw):
    r = await mv.add(sub, name, imdb, **kw)
    await asyncio.gather(*list(mv._tasks))
    return r


# ── Choosing a copy ──────────────────────────────────────────────────────────
def ranking_tests():
    print("choosing a copy")

    def four_k_first_never_remux_cam_tiny_or_dubbed():
        got = [c["hash"][0] for c in mv.rank(DUNE)]
        # FLUX (busy, WEB-DL, HDR) beats Tigole; the DV-only one sinks to the end of the 4K
        # copies; the remux, the 3.5 GB "4K", 4KLight, the Italian dub, the cam, the 720p
        # and the hex-tagged one (Zurg files it under anime) are all gone.
        # A proper 10-35 GB encode beats a busier 6.5 GB one; the extras-only torrent is gone.
        # Disc Dolby Vision (profile 7, HDR10 underneath) is fine; web DV with no HDR isn't.
        assert got == ["a", "d", "8", "7", "f", "2"], got

    def sizes_seeders_and_hdr_are_read():
        c = mv.parse_stream(DUNE[0])
        assert c["tier"] == 2160 and c["size_gb"] == 29.26 and c["seeders"] == 433 and c["hdr"] and c["dv"]
        assert mv.parse_stream({"infoHash": "nothex", "name": "x"}) is None
        mb = mv.parse_stream({**st("1080p", "Film.1080p.WEB-DL", "0", 5, "9"), "title": "Film.1080p.WEB-DL\n👤 5 💾 900 MB"})
        assert abs(mb["size_gb"] - 0.88) < 0.01

    def only_1080p_when_there_is_no_good_4k():
        got = mv.rank([DUNE[1], DUNE[7]])
        assert [c["tier"] for c in got] == [1080]
        assert mv.quality_label(2160, True) == "4K HDR" and mv.quality_label(1080, True) == "1080p"

    for fn in (four_k_first_never_remux_cam_tiny_or_dubbed, sizes_seeders_and_hdr_are_read,
               only_1080p_when_there_is_no_good_4k):
        check(fn.__name__, fn)


# ── Adding ───────────────────────────────────────────────────────────────────
def add_tests():
    print("adding")

    def the_first_cached_4k_copy_wins_and_the_rest_are_removed():
        reset(cached={"d" * 40})
        r = run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        assert r["status"] == "finding" and r["by"] == "Zubair" and r["title"] == "Dune: Part Two"
        row = mv._row("tt15239678")
        assert row["status"] == "adding" and row["quality"] == "4K HDR" and "Tigole" in row["release"], row
        assert list(RD.torrents) == [row["rd_id"]], "the uncached FLUX copy we tried is deleted again"

    def the_adder_can_pick_1080p_or_4k_when_both_exist():
        reset()
        o = run(mv.options("tt15239678"))
        assert o["4k"] and o["1080p"] and o["1080p"]["label"] == "1080p" and o["4k"]["label"].startswith("4K"), o
        run(add_and_wait("u-zub", "Zubair", "tt15239678", want="1080p"))
        row = mv._row("tt15239678")
        assert row["want"] == "1080p" and RD.torrents[row["rd_id"]]["hash"] == "2" * 40, (row["want"], RD.torrents)
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt15239678", want="4k"))
        row = mv._row("tt15239678")
        assert RD.torrents[row["rd_id"]]["hash"] == "a" * 40 and len(RD.torrents) == 1, RD.torrents
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt15239678", want="8k?"))
        assert mv._row("tt15239678")["want"] == "", "anything else is the best copy, as before"

    def with_nothing_cached_the_best_seeded_4k_downloads():
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        row = mv._row("tt15239678")
        assert row["status"] == "downloading" and RD.torrents[row["rd_id"]]["hash"] == "a" * 40, row
        assert len(RD.torrents) == 1

    def a_cached_1080p_beats_an_uncached_4k():
        reset(cached={"2" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        row = mv._row("tt15239678")
        assert row["status"] == "adding" and row["quality"] == "1080p", row

    def no_copy_says_so():
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt0000001"))
        row = mv._row("tt0000001")
        assert row["status"] == "failed" and row["error"], row

    def already_in_the_library_is_not_added_again():
        reset()
        JF.movie("c" * 32, "Dune: Part Two", "tt15239678")
        r = run(mv.add("u-zub", "Zubair", "tt15239678"))
        assert r["status"] == "ready" and r["id"] == "c" * 32 and not RD.calls and mv._row("tt15239678") is None

    def a_second_press_joins_the_first_and_bad_ids_are_refused():
        reset(cached={"a" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        again = run(mv.add("u-noor", "Noor", "tt15239678"))
        assert again["by"] == "Zubair" and len(RD.torrents) == 1
        for bad in ("", "tt12", "../etc", "tt15239678; drop"):
            try:
                run(mv.add("u-zub", "Zubair", bad))
            except HTTPException as e:
                assert e.status_code == 400
            else:
                raise AssertionError(f"{bad!r} was accepted")

    def five_a_day_unless_admin():
        reset()
        now = time.time()
        with mv._conn() as db:
            for n in range(mv.ADDS_PER_DAY):
                db.execute("INSERT INTO adds (imdb, title, sub, status, created, updated) VALUES (?,?,?,?,?,?)",
                           (f"tt900000{n}", "x", "u-zub", "ready", now, now))
        try:
            run(mv.add("u-zub", "Zubair", "tt15239678"))
        except HTTPException as e:
            assert e.status_code == 429
        else:
            raise AssertionError("no daily cap")
        RD.cached = {"a" * 40}
        assert run(add_and_wait("u-zub", "Zubair", "tt15239678", admin=True))["status"] == "finding"

    def a_failed_add_can_be_tried_again():
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt0000001"))
        TORRENTIO["tt0000001"] = [DUNE[3]]
        RD.cached = {"d" * 40}
        try:
            run(add_and_wait("u-noor", "Noor", "tt0000001"))
            row = mv._row("tt0000001")
            assert row["status"] == "adding" and row["name"] == "Noor", row
        finally:
            TORRENTIO.pop("tt0000001")

    def a_copy_real_debrid_has_blocked_is_skipped_not_fatal():
        reset(cached={"d" * 40})
        RD.blocked = {"a" * 40}
        try:
            run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        finally:
            RD.blocked = set()
        row = mv._row("tt15239678")
        assert row["status"] != "failed" and "Tigole" in row["release"], row

    def when_every_copy_is_blocked_only_the_adder_hears_why():
        reset()
        RD.blocked = {c["hash"] for c in mv.rank(DUNE)}
        try:
            run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        finally:
            RD.blocked = set()
        row = mv._row("tt15239678")
        assert row["status"] == "failed" and "blocked" in row["error"], row
        assert len(NOTES) == 1 and NOTES[0][1]["only"] == ["u-zub"] and NOTES[0][1]["dms"] is False, NOTES
        assert "Couldn't add Dune" in NOTES[0][0][1] and NOTES[0][1]["url"] == "/app/watch?m=tt15239678"
        assert CHANNEL == [], "a failed add isn't posted to the channel"

    def a_server_wide_block_stops_at_once_and_pauses_adds():
        reset()
        RD.blocked = {c["hash"] for c in mv.rank(DUNE)} | {mv.PROBE_HASH}
        try:
            run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        finally:
            RD.blocked = set()
        adds = [p for m, p in RD.calls if p == "/torrents/addMagnet"]
        assert len(adds) == 2, f"one copy, then the free-film check: {len(adds)}"
        assert mv._row("tt15239678")["error"] == mv.SERVER_BLOCKED
        try:
            run(mv.add("u-noor", "Noor", "tt0000001"))
        except HTTPException as e:
            assert e.status_code == 503 and e.detail == mv.SERVER_BLOCKED
        else:
            raise AssertionError("adds weren't paused")
        finally:
            mv._rd_blocked_until = 0.0

    def a_movie_never_costs_more_than_three_adds():
        reset()   # nothing cached: two 4K and one 1080p, the first held to download
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        adds = [p for m, p in RD.calls if p == "/torrents/addMagnet"]
        assert len(adds) <= mv.MAX_ADDS and mv._row("tt15239678")["status"] == "downloading", (len(adds), mv._row("tt15239678"))

    def the_copies_list_starts_with_what_add_picks_and_one_can_be_pinned():
        reset()
        c = run(mv.copies("tt15239678"))["copies"]
        assert c and c[0]["id"] == "a" * 40 and "FLUX" in c[0]["release"] and c[0]["label"].startswith("4K"), c[0]
        assert {"id", "release", "size_gb", "label", "seeders"} == set(c[0]) and len({x["id"] for x in c}) == len(c)
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt15239678", want="hash:" + "2" * 40))
        row = mv._row("tt15239678")
        assert row["want"] == "hash:" + "2" * 40 and list(RD.torrents.values())[0]["hash"] == "2" * 40 and len(RD.torrents) == 1
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt15239678", want="hash:" + "9" * 40))
        row = mv._row("tt15239678")
        assert row["status"] == "failed" and "pick another" in row["error"] and not RD.torrents, row
        for bad in ("tt12", "../x"):
            try:
                run(mv.copies(bad))
            except HTTPException as e:
                assert e.status_code == 400
            else:
                raise AssertionError(bad)

    def replacing_swaps_the_copy_for_the_adder_or_an_admin_only():
        reset(cached={"d" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        tid = mv._row("tt15239678")["rd_id"]
        RD.torrents[tid]["filename"] = "Dune.Tigole"
        JF.movie("c" * 32, "Dune: Part Two", "tt15239678", path="/zurg/movies/Dune.Tigole/Movie.mkv")
        try:
            run(mv.replace("u-noor", "Noor", "tt15239678", "2" * 40))
        except HTTPException as e:
            assert e.status_code == 403
        else:
            raise AssertionError("someone else replaced it")
        assert tid in RD.torrents, "a refused replace leaves the copy alone"
        for bad in ("", "x" * 40, "2" * 39):
            try:
                run(mv.replace("u-zub", "Zubair", "tt15239678", bad))
            except HTTPException as e:
                assert e.status_code == 400
            else:
                raise AssertionError(bad)
        r = run(and_wait(mv.replace("u-zub", "Zubair", "tt15239678", "2" * 40)))
        row = mv._row("tt15239678")
        assert r["status"] == "finding" and tid not in RD.torrents, (r, RD.torrents)
        assert row["want"] == "hash:" + "2" * 40 and [t["hash"] for t in RD.torrents.values()] == ["2" * 40], RD.torrents
        # An add that hasn't reached Jellyfin yet: still only the adder.
        try:
            run(mv.replace("u-noor", "Noor", "tt15239678", "d" * 40))
        except HTTPException as e:
            assert e.status_code == 403
        else:
            raise AssertionError("someone else replaced a pending add")
        assert run(and_wait(mv.replace("u-noor", "Noor", "tt15239678", "d" * 40, admin=True)))["status"] == "finding"
        assert [t["hash"] for t in RD.torrents.values()] == ["d" * 40], "the pending copy's torrent went too"

    def a_search_cut_off_by_a_restart_is_picked_up_again():
        reset(cached={"d" * 40})
        now = time.time()
        with mv._conn() as db:
            db.execute("INSERT INTO adds (imdb, title, sub, name, status, created, updated) VALUES (?,?,?,?,?,?,?)",
                       ("tt15239678", "Dune: Part Two", "u-zub", "Zubair", "finding", now - 3600, now - 3600))
        run(and_wait(mv.tick(force=True)))
        row = mv._row("tt15239678")
        assert row["status"] == "adding" and "Tigole" in row["release"], row
        # A fresh one (still in its Undo wait, or being searched) is left alone.
        reset()
        with mv._conn() as db:
            db.execute("INSERT INTO adds (imdb, title, sub, name, status, created, updated) VALUES (?,?,?,?,?,?,?)",
                       ("tt15239678", "Dune: Part Two", "u-zub", "Zubair", "finding", now, now))
        run(and_wait(mv.tick(force=True)))
        assert mv._row("tt15239678")["status"] == "finding" and not RD.calls

    for fn in (the_first_cached_4k_copy_wins_and_the_rest_are_removed, a_server_wide_block_stops_at_once_and_pauses_adds, a_movie_never_costs_more_than_three_adds, a_copy_real_debrid_has_blocked_is_skipped_not_fatal, when_every_copy_is_blocked_only_the_adder_hears_why, with_nothing_cached_the_best_seeded_4k_downloads,
               a_cached_1080p_beats_an_uncached_4k, no_copy_says_so, already_in_the_library_is_not_added_again,
               a_second_press_joins_the_first_and_bad_ids_are_refused, five_a_day_unless_admin,
               a_failed_add_can_be_tried_again, the_adder_can_pick_1080p_or_4k_when_both_exist,
               the_copies_list_starts_with_what_add_picks_and_one_can_be_pinned, replacing_swaps_the_copy_for_the_adder_or_an_admin_only,
               a_search_cut_off_by_a_restart_is_picked_up_again):
        check(fn.__name__, fn)


# ── Following it into Jellyfin ───────────────────────────────────────────────
def follow_tests():
    print("into the library")

    def downloading_shows_progress_then_jellyfin_gets_a_rescan_then_it_is_ready():
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        tid = mv._row("tt15239678")["rd_id"]
        RD.torrents[tid]["progress"] = 42.5
        run(mv.tick(force=True))
        assert mv._row("tt15239678")["progress"] == 42.5
        RD.torrents[tid].update(status="downloaded", progress=100)
        run(mv.tick(force=True))
        assert mv._row("tt15239678")["status"] == "adding"
        assert any(m == "POST" and p == f"/Items/{'f' * 32}/Refresh" for m, p, _ in JF.calls), JF.calls
        JF.movie("c" * 32, "Dune: Part Two", "tt15239678")
        assert run(mv.tick(force=True)) == 1
        row = mv._row("tt15239678")
        assert row["status"] == "ready" and row["jf_id"] == "c" * 32
        added, ready, mine = NOTES
        assert added[1]["only"] == ["u-noor"] and added[1]["exclude"] == "u-zub" and added[1]["dms"] is False, added
        assert ready[1]["only"] == ["u-noor"] and ready[1]["dms"] is False and "Dune" in ready[0][1] and ready[0][0] == "movies", ready
        assert mine[1]["only"] == ["u-zub"] and mine[1].get("dms", True) and "you added" in mine[1]["dm_text"], mine

    def an_add_jellyfin_never_finds_gives_up():
        reset(cached={"a" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        with mv._conn() as db:
            db.execute("UPDATE adds SET updated = ?", (time.time() - mv.ADDING_GIVE_UP_S - 5,))
        run(mv.tick(force=True))
        assert mv._row("tt15239678")["status"] == "failed"

    def the_library_shows_the_best_version_and_who_added_it():
        reset(cached={"a" * 40})
        JF.movie("1" * 32, "Edward Scissorhands", "tt0099487", width=7680, path="/zurg/movies/E (4320p Ai Upscale)/e.mkv")
        JF.movie("2" * 32, "Edward Scissorhands", "tt0099487", width=3840, rng="DOVIWithHDR10")
        JF.movie("3" * 32, "Edward Scissorhands", "tt0099487", width=1920, rng="SDR")
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        JF.movie("c" * 32, "Dune: Part Two", "tt15239678")
        run(mv.tick(force=True))
        lib = run(mv.library())
        cards = {m["title"]: m for m in lib["movies"]}
        assert cards["Edward Scissorhands"]["id"] == "2" * 32 and cards["Edward Scissorhands"]["quality"] == "4K HDR"
        assert cards["Dune: Part Two"]["by"] == "Zubair" and "path" not in cards["Dune: Part Two"]
        assert lib["adding"] == [] and lib["can_add"] is True and "versions" not in cards["Dune: Part Two"]

    def search_results_say_what_is_in_the_library_or_on_its_way():
        reset()
        JF.movie("c" * 32, "Dune: Part Two", "tt15239678")
        with mv._conn() as db:
            db.execute("INSERT INTO adds (imdb, title, sub, status, progress, created, updated) VALUES (?,?,?,?,?,?,?)",
                       ("tt1160419", "Dune", "u-zub", "downloading", 12.0, time.time(), time.time()))
        got = run(mv.annotate(run(mv.search("dune"))))
        assert [(r["imdb"], r["state"]) for r in got] == [("tt15239678", "ready"), ("tt1160419", "downloading")], got
        assert got[0]["id"] == "c" * 32 and got[1]["progress"] == 12.0
        assert run(mv.search("d")) == []

    for fn in (downloading_shows_progress_then_jellyfin_gets_a_rescan_then_it_is_ready, an_add_jellyfin_never_finds_gives_up,
               the_library_shows_the_best_version_and_who_added_it, search_results_say_what_is_in_the_library_or_on_its_way):
        check(fn.__name__, fn)


# ── Copying it onto the server's disk ────────────────────────────────────────
Disk = collections.namedtuple("Disk", "total used free")
GiB = 2**30


def local_tests():
    print("onto the server's disk")
    real_dir, real_chunk, real_usage = mv.LOCAL_DIR, mv.CHUNK, mv.shutil.disk_usage
    loc = TMP / "movies-local"
    loc.mkdir(exist_ok=True)
    mv.LOCAL_DIR = loc
    mv.CHUNK = 64 << 10       # several writes per file, so the loop runs
    folder = "Dune Part Two (2024) [imdbid-tt15239678]"

    def free(gb):
        mv.shutil.disk_usage = lambda p: Disk(1000 * GiB, 0, int(gb * GiB))

    def fresh(cached=()):
        reset(cached)
        free(500)
        for p in loc.iterdir():
            mv.shutil.rmtree(p)

    def copied():
        fresh(cached={"d" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        row = mv._row("tt15239678")
        assert row["status"] == "copying" and row["progress"] == 0, row
        assert run(mv.copy_one(row)) == "done"
        return mv._row("tt15239678")

    def a_cached_add_is_copied_into_a_folder_jellyfin_matches_by_imdb_id():
        row = copied()
        assert mv.folder_name("Dune: Part Two", "2024", "tt15239678") == folder
        f = loc / folder / "Movie.mkv"
        assert f.read_bytes() == blob(FILE_BYTES), "the whole file, byte for byte"
        assert list((loc / ".incoming").iterdir()) == [], "no .part left behind"
        assert row["status"] == "adding" and row["local_dir"] == folder and row["bytes_done"] == FILE_BYTES, row
        assert DL.ranges == [""], DL.ranges
        assert RD.torrents, "Real-Debrid's copy stays until Jellyfin lists ours"

    def the_card_shows_the_copy_progress():
        fresh(cached={"d" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        mv._set("tt15239678", bytes_total=1000, bytes_done=420, progress=42.0)
        lib = run(mv.library("u-zub"))
        assert [(a["status"], a["progress"]) for a in lib["adding"]] == [("copying", 42.0)], lib["adding"]
        for leak in ("local_dir", "local_file", "src_file", "rd_id", "sub"):
            assert leak not in lib["adding"][0], leak

    def a_restart_resumes_the_copy_with_a_range_request():
        fresh(cached={"d" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        part = mv._part("tt15239678")
        part.parent.mkdir(exist_ok=True)
        part.write_bytes(blob(FILE_BYTES)[:100_000])
        assert run(mv.copy_one(mv._row("tt15239678"))) == "done"
        assert DL.ranges == ["bytes=100000-"], DL.ranges
        assert (loc / folder / "Movie.mkv").read_bytes() == blob(FILE_BYTES)

    def a_copy_of_the_wrong_size_never_reaches_the_library():
        fresh(cached={"d" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        DL.files[mv._row("tt15239678")["rd_id"]] = blob(FILE_BYTES - 5)
        assert run(mv.copy_one(mv._row("tt15239678"))) == "failed"
        row = mv._row("tt15239678")
        assert row["status"] == "failed" and "wrong size" in row["error"], row
        assert not (loc / folder).exists() and not mv._part("tt15239678").exists()

    def only_the_local_copy_is_left_and_never_while_someone_watches():
        row = copied()
        tid = row["rd_id"]
        RD.torrents[tid]["filename"] = "Dune.FLUX"
        JF.movie("c" * 32, "Dune: Part Two", "tt15239678", path="/zurg/movies/Dune.FLUX/Movie.mkv")
        assert run(mv.tick(force=True)) == 0 and tid in RD.torrents, "not before Jellyfin lists our copy"
        JF.movie("d" * 32, "Dune: Part Two", "tt15239678", path=f"/media/movies-local/{folder}/Movie.mkv")
        mv._streamed["c" * 32] = time.time()
        assert run(mv.tick(force=True)) == 0 and tid in RD.torrents, "someone is streaming the Real-Debrid copy"
        mv._streamed.clear()
        JF.sessions = [{"NowPlayingItem": {"Id": "c" * 32}}]
        assert run(mv.tick(force=True)) == 0 and tid in RD.torrents, "Jellyfin says it's playing"
        assert mv._row("tt15239678")["status"] == "adding"
        JF.sessions = []
        assert run(mv.tick(force=True)) == 1
        row = mv._row("tt15239678")
        assert row["status"] == "ready" and row["jf_id"] == "d" * 32 and not RD.torrents, (row, RD.torrents)
        cards = run(mv.library("u-zub"))["movies"]
        assert [(c["id"], c["by"], c["can_remove"]) for c in cards] == [("d" * 32, "Zubair", True)], cards

    def everyone_hears_it_was_added_then_that_it_is_ready():
        row = copied()
        JF.movie("d" * 32, "Dune: Part Two", "tt15239678", path=f"/media/movies-local/{folder}/Movie.mkv")
        run(mv.tick(force=True))
        (a_args, added), (r_args, ready), (m_args, mine) = NOTES
        assert a_args[0] == r_args[0] == m_args[0] == "movies"
        # Squad news (added, ready) is inbox + push for everyone else, never a DM to them.
        assert added["only"] == ["u-noor"] and added["exclude"] == "u-zub", "not the adder, not the inactive or bots"
        assert added["dms"] is False and ready["dms"] is False and ready["only"] == ["u-noor"]
        # Whoever added it gets the one DM: theirs is ready.
        assert mine["only"] == ["u-zub"] and mine.get("dms", True) and "Dune: Part Two (2024)" in mine["dm_text"]
        assert added["url"] == ready["url"] == mine["url"] == mv.LIBRARY_URL == "/app/watch?library=downloaded"
        assert added["tag"] != ready["tag"] and "tt15239678" in added["tag"], (added["tag"], ready["tag"])
        assert "Zubair added Dune" in a_args[1] and "ready to watch" in r_args[1] and "ready to watch" in mine["dm_text"]
        # And the ~watchparty channel hears both, with @channel so everyone in it is alerted.
        assert len(CHANNEL) == 2 and all(t.startswith("@channel") for t in CHANNEL), CHANNEL
        assert "Zubair" in CHANNEL[0] and "added **Dune: Part Two (2024)**" in CHANNEL[0] and "ready to watch" in CHANNEL[1]
        assert CHANNEL[1].endswith("https://app.crcmz.me/app/watch?m=tt15239678"), CHANNEL[1]

    def removing_deletes_the_folder_it_made():
        copied()
        JF.movie("d" * 32, "Dune: Part Two", "tt15239678", path=f"/media/movies-local/{folder}/Movie.mkv")
        run(mv.tick(force=True))
        try:
            run(mv.remove("u-noor", "d" * 32))
        except HTTPException as e:
            assert e.status_code == 403
        else:
            raise AssertionError("someone else removed it")
        assert run(mv.remove("u-zub", "d" * 32)) == {"title": "Dune: Part Two", "removed": 1}
        assert not (loc / folder).exists() and (loc / ".incoming").is_dir()
        assert mv._row("tt15239678") is None

    def removing_mid_copy_drops_the_part_file():
        fresh(cached={"d" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        mv._part("tt15239678").parent.mkdir(exist_ok=True)
        mv._part("tt15239678").write_bytes(b"x" * 10)
        tid = mv._row("tt15239678")["rd_id"]
        RD.torrents[tid]["filename"] = "Dune.FLUX"
        JF.movie("c" * 32, "Dune: Part Two", "tt15239678", path="/zurg/movies/Dune.FLUX/Movie.mkv")
        assert run(mv.remove("u-zub", "c" * 32))["removed"] == 1
        assert not mv._part("tt15239678").exists() and not RD.torrents

    def the_disk_guard_takes_1080p_when_4k_wont_fit_and_refuses_when_nothing_does():
        TORRENTIO["tt0000002"] = [DUNE[0], DUNE[7]]     # 29.26 GB 4K, 11.2 GB 1080p
        try:
            fresh(cached={"a" * 40, "2" * 40})
            free(100 + 40)
            run(add_and_wait("u-zub", "Zubair", "tt0000002"))
            assert mv._row("tt0000002")["quality"] == "4K HDR", "the 4K fits"
            fresh(cached={"a" * 40, "2" * 40})
            free(100 + 20)
            run(add_and_wait("u-zub", "Zubair", "tt0000002"))
            row = mv._row("tt0000002")
            assert row["status"] == "copying" and row["quality"] == "1080p", row
            # A copy already on its way counts against the room.
            fresh(cached={"a" * 40, "2" * 40})
            free(100 + 35)
            with mv._conn() as db:
                db.execute("INSERT INTO adds (imdb, title, sub, status, bytes_total, bytes_done, created, updated) "
                           "VALUES ('tt0000003','x','u-noor','copying',?,0,?,?)", (10 * GiB, time.time(), time.time()))
            run(add_and_wait("u-zub", "Zubair", "tt0000002"))
            assert mv._row("tt0000002")["quality"] == "1080p"
            fresh(cached={"a" * 40, "2" * 40})
            free(100 + 5)
            run(add_and_wait("u-zub", "Zubair", "tt0000002"))
            row = mv._row("tt0000002")
            assert row["status"] == "failed" and "isn't room" in row["error"] and "100 GB" in row["error"], row
            assert not RD.torrents
        finally:
            TORRENTIO.pop("tt0000002")

    def a_copy_that_no_longer_fits_stops_before_filling_the_disk():
        fresh(cached={"d" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        free(100)
        assert run(mv.copy_one(mv._row("tt15239678"))) == "full"
        row = mv._row("tt15239678")
        assert row["status"] == "failed" and "isn't room" in row["error"] and not (loc / folder).exists()

    def peoples_adds_are_copied_before_the_migration():
        fresh()
        now = time.time()
        with mv._conn() as db:
            for imdb, mig, at in (("tt0000011", 1, now - 99), ("tt0000012", 0, now), ("tt0000013", 1, now - 50)):
                db.execute("INSERT INTO adds (imdb, title, sub, status, migrate, created, updated) "
                           "VALUES (?,?,'','copying',?,?,?)", (imdb, imdb, mig, at, at))
        assert mv._next_copy()["imdb"] == "tt0000012"
        mv._set("tt0000012", status="ready")
        assert mv._next_copy()["imdb"] == "tt0000011"

    def the_migration_copies_films_only_on_real_debrid_silently_and_once():
        fresh()
        JF.movie("1" * 32, "Back to the Future", "tt0088763", path="/zurg/movies/BTTF.1985.2160p/BTTF.mkv")
        JF.movie("2" * 32, "Half Baked", "tt0120693", path="/media/movies-local/Half Baked/hb.mkv")
        JF.movie("3" * 32, "Heat", "tt0113277", path="/zurg/movies/Heat.1995/Heat.mkv")   # not on RD any more
        JF.movie("4" * 32, "No Id", "", path="/zurg/movies/NoId/n.mkv")
        RD.torrents["M1"] = {"filename": "BTTF.1985.2160p", "status": "downloaded", "hash": "7" * 40,
                             "files": [{"id": 1, "path": "/BTTF.mkv", "bytes": FILE_BYTES, "selected": 1}],
                             "links": ["https://real-debrid.com/d/M1"]}
        RD.torrents["ODY"] = {"filename": "The.Odyssey.2026", "status": "downloaded", "hash": "6" * 40}
        assert run(mv.migrate_existing()) == 1
        row = mv._row("tt0088763")
        assert row["status"] == "copying" and row["migrate"] == 1 and row["rd_id"] == "M1" and row["src_file"] == "BTTF.mkv"
        assert run(mv.library())["adding"] == [], "the migration isn't anyone's add"
        assert run(mv.migrate_existing()) == 0, "once"
        assert run(mv.copy_one(row)) == "done"
        bttf = "Back to the Future (2024) [imdbid-tt0088763]"
        assert (loc / bttf / "BTTF.mkv").read_bytes() == blob(FILE_BYTES)
        assert run(mv.tick(force=True)) == 0 and "M1" in RD.torrents, "still only on Real-Debrid as far as Jellyfin knows"
        JF.movie("5" * 32, "Back to the Future", "tt0088763", path=f"/media/movies-local/{bttf}/BTTF.mkv")
        assert run(mv.tick(force=True)) == 1
        assert set(RD.torrents) == {"ODY"}, RD.torrents
        assert NOTES == [], "the migration tells nobody"
        cards = {c["title"]: c for c in run(mv.library("u-admin", True))["movies"]}
        assert cards["Back to the Future"]["id"] == "5" * 32 and cards["Back to the Future"]["can_remove"]
        assert not cards["Half Baked"]["can_remove"], "a folder the app didn't make is never deleted"
        out = mv.overview()
        bt = next(a for a in out["added"] if a["title"] == "Back to the Future")
        assert bt["on_server_disk"] and bt["migrating"], bt
        # A migrated film doesn't count against anyone's five a day.
        with mv._conn() as db:
            assert db.execute("SELECT COUNT(*) FROM adds WHERE migrate = 1").fetchone()[0] == 1

    def without_the_disk_mounted_it_streams_from_real_debrid_as_before():
        fresh(cached={"d" * 40})
        mv.LOCAL_DIR = TMP / "not-mounted"
        try:
            run(add_and_wait("u-zub", "Zubair", "tt15239678"))
            assert mv._row("tt15239678")["status"] == "adding"
            assert run(mv.migrate_existing()) == 0
        finally:
            mv.LOCAL_DIR = loc

    try:
        for fn in (a_cached_add_is_copied_into_a_folder_jellyfin_matches_by_imdb_id, the_card_shows_the_copy_progress,
                   a_restart_resumes_the_copy_with_a_range_request, a_copy_of_the_wrong_size_never_reaches_the_library,
                   only_the_local_copy_is_left_and_never_while_someone_watches,
                   everyone_hears_it_was_added_then_that_it_is_ready, removing_deletes_the_folder_it_made,
                   removing_mid_copy_drops_the_part_file,
                   the_disk_guard_takes_1080p_when_4k_wont_fit_and_refuses_when_nothing_does,
                   a_copy_that_no_longer_fits_stops_before_filling_the_disk, peoples_adds_are_copied_before_the_migration,
                   the_migration_copies_films_only_on_real_debrid_silently_and_once,
                   without_the_disk_mounted_it_streams_from_real_debrid_as_before):
            check(fn.__name__, fn)
    finally:
        mv.LOCAL_DIR, mv.CHUNK, mv.shutil.disk_usage = real_dir, real_chunk, real_usage


# ── Removing ─────────────────────────────────────────────────────────────────
def subtitle_tests():
    print("subtitles")

    def image_subtitles_burn_into_your_own_stream_only():
        path, params = mv.hls_request("u-zub", "c" * 32, "master.m3u8", "burn=3")
        assert params["SubtitleStreamIndex"] == "3" and params["SubtitleMethod"] == "Encode", params
        _, plain = mv.hls_request("u-zub", "c" * 32, "master.m3u8", "")
        assert "SubtitleStreamIndex" not in plain
        _, bad = mv.hls_request("u-zub", "c" * 32, "master.m3u8", "burn=3;rm")
        assert "SubtitleStreamIndex" not in bad, "only a number"

    def the_list_puts_english_first_and_names_tracks_plainly():
        old = mv.slap._jf
        async def fake(method, path, **kw):
            import httpx
            return httpx.Response(200, json={"Items": [{"Id": "c" * 32, "MediaStreams": [
                {"Type": "Video", "Index": 0},
                {"Type": "Subtitle", "Index": 4, "Language": "zho", "DisplayTitle": "Chinese - PGSSUB", "IsTextSubtitleStream": False},
                {"Type": "Subtitle", "Index": 2, "Language": "eng", "DisplayTitle": "English - Default - SUBRIP", "IsTextSubtitleStream": True},
                {"Type": "Subtitle", "Index": 5, "Language": "eng", "DisplayTitle": "English - Forced - PGSSUB", "IsForced": True}]}]})
        mv.slap._jf = fake
        mv._cache.pop("subs:" + "c" * 32, None)
        try:
            subs = run(mv.subtitles("c" * 32))
        finally:
            mv.slap._jf = old
        assert [x["index"] for x in subs] == [2, 4, 5], subs
        assert subs[0] == {"index": 2, "label": "English - Default", "lang": "eng", "text": True, "forced": False}, subs[0]
        assert subs[1]["text"] is False and subs[1]["label"] == "Chinese"

    for fn in (image_subtitles_burn_into_your_own_stream_only, the_list_puts_english_first_and_names_tracks_plainly):
        check(fn.__name__, fn)


def remove_tests():
    print("removing")

    def setup():
        reset(cached={"a" * 40})
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        tid = mv._row("tt15239678")["rd_id"]
        RD.torrents[tid]["filename"] = "Dune.Part.Two.2024.2160p.WEB-DL-FLUX"
        RD.torrents["OLD"] = {"filename": "Dune Part Two 2024.mkv", "hash": "9" * 40}
        RD.torrents["KEEP"] = {"filename": "Heat.1995.mkv", "hash": "8" * 40}
        JF.movie("c" * 32, "Dune: Part Two", "tt15239678", path="/zurg/movies/Dune.Part.Two.2024.2160p.WEB-DL-FLUX/dune.mkv")
        JF.movie("d" * 32, "Dune: Part Two", "tt15239678", width=1920, rng="SDR", path="/zurg/movies/Dune 1080/Dune Part Two 2024.mkv")
        JF.movie("e" * 32, "Heat", "tt0113277", path="/zurg/movies/Heat.1995/Heat.1995.mkv")
        JF.movie("1" * 32, "Half Baked", "tt0120693", path="/media/movies-local/Half Baked/hb.mkv")
        run(mv.tick(force=True))
        return tid

    def the_adder_or_an_admin_can_remove_and_it_says_so():
        setup()
        lib = {m["title"]: m["can_remove"] for m in run(mv.library("u-zub"))["movies"]}
        assert lib == {"Dune: Part Two": True, "Heat": False, "Half Baked": False}, lib
        lib = {m["title"]: m["can_remove"] for m in run(mv.library("u-admin", True))["movies"]}
        assert lib == {"Dune: Part Two": True, "Heat": True, "Half Baked": False}, lib

    def removing_deletes_every_real_debrid_copy_and_hides_it_at_once():
        tid = setup()
        out = run(mv.remove("u-zub", "d" * 32))
        run(asyncio.gather(*list(mv._tasks)) if mv._tasks else asyncio.sleep(0))
        assert out == {"title": "Dune: Part Two", "removed": 2}, out
        assert set(RD.torrents) == {"KEEP"} and tid not in RD.torrents
        assert "Dune: Part Two" not in [m["title"] for m in run(mv.library("u-zub"))["movies"]]
        assert mv._row("tt15239678") is None, "it can be added again"

    def added_again_it_shows_up_even_with_the_same_jellyfin_id():
        setup()
        run(mv.remove("u-zub", "c" * 32))
        run(asyncio.gather(*list(mv._tasks)) if mv._tasks else asyncio.sleep(0))
        lib = lambda: [m["title"] for m in run(mv.library("u-zub", True))["movies"]]  # noqa: E731
        assert "Dune: Part Two" not in lib(), "the old copies stay hidden until Jellyfin's rescan"
        # Downloaded again: Jellyfin's id comes from the folder, so the new copy has the same
        # id, but it was added after the removal.
        for it in JF.items:
            if it["Id"] == "c" * 32:
                it["DateCreated"] = time.strftime("%Y-%m-%dT%H:%M:%S.1234567Z", time.gmtime(time.time() + 60))
        mv._cache.clear() if hasattr(mv, "_cache") else None
        assert "Dune: Part Two" in lib(), "the re-added film shows up"

    def nobody_else_and_never_a_film_on_the_servers_disk():
        setup()
        for who, jf, admin, code in (("u-noor", "c" * 32, False, 403), ("u-zub", "e" * 32, False, 403),
                                     ("u-admin", "1" * 32, True, 400), ("u-zub", "nope", False, 404)):
            try:
                run(mv.remove(who, jf, admin=admin))
            except HTTPException as e:
                assert e.status_code == code, (who, jf, e.status_code)
            else:
                raise AssertionError(f"{who} removed {jf}")
        assert {"OLD", "KEEP"} <= set(RD.torrents)
        assert run(mv.remove("u-admin", "e" * 32, admin=True))["removed"] == 1 and "KEEP" not in RD.torrents

    for fn in (the_adder_or_an_admin_can_remove_and_it_says_so, removing_deletes_every_real_debrid_copy_and_hides_it_at_once,
               nobody_else_and_never_a_film_on_the_servers_disk, added_again_it_shows_up_even_with_the_same_jellyfin_id):
        check(fn.__name__, fn)


# ── Browsing ─────────────────────────────────────────────────────────────────
def browse_tests():
    print("browsing")

    def catalogues_build_cinemeta_paths_and_refuse_anything_else():
        reset(); CATALOG_CALLS.clear()
        run(mv.catalog("popular"))
        run(mv.catalog("popular", "Sci-Fi", 50))
        run(mv.catalog("new"))
        assert CATALOG_CALLS == ["catalog/movie/top.json", "catalog/movie/top/genre=Sci-Fi&skip=50.json",
                                 f"catalog/movie/year/genre={mv._this_year()}.json"], CATALOG_CALLS
        for bad in (("popular", "Nope", 0), ("new", "abcd", 0), ("trending", "", 0), ("top", "../x", 0)):
            try:
                run(mv.catalog(*bad))
            except HTTPException as e:
                assert e.status_code == 400, bad
            else:
                raise AssertionError(f"{bad} accepted")
        assert "skip=1000" in (run(mv.catalog("popular", "", 99999)) and CATALOG_CALLS[-1])

    def highest_rated_is_in_rating_order_with_no_unrated_films():
        reset()
        top = run(mv.catalog("top"))
        ratings = [float(m["rating"]) for m in top]
        assert ratings == sorted(ratings, reverse=True) and min(ratings) >= 7.0, ratings
        assert "Shared Two" not in [m["title"] for m in top] and "Meh" not in [m["title"] for m in top]

    def home_has_a_featured_film_rows_without_repeats_and_library_state():
        reset()
        JF.movie("c" * 32, "Great", "tt1000003")
        h = run(mv.home())
        assert h["featured"] and h["featured"]["background"].startswith("https://") and h["genres"][0] == "Action"
        ids = [r["id"] for r in h["rows"]]
        assert ids[:3] == ["popular", "new", "top"] and all(i.startswith("g-") for i in ids[3:]), ids
        genre_rows = [r for r in h["rows"] if r["id"].startswith("g-")]
        assert "tt1000001" not in [m["imdb"] for m in genre_rows[0]["items"]], "genre rows skip films shown above"
        great = next(m for r in h["rows"] for m in r["items"] if m["imdb"] == "tt1000003")
        assert great["state"] == "ready" and great["id"] == "c" * 32
        assert "/medium/" in great["poster"]
        g = run(mv.home("Horror"))
        assert [r["title"] for r in g["rows"]] == ["Popular Horror", "Highest rated Horror"]

    def details_bring_trailers_cast_and_safe_images():
        reset()
        d = run(mv.details("tt7777777"))
        assert d["trailers"] == ["U2Qp5pL3ovA"] and d["runtime"] == 123 and d["cast"] == ["A", "B"]
        assert d["poster"].endswith("/large/tt7777777/img") and d["background"] == "", d
        try:
            run(mv.details("../etc"))
        except HTTPException as e:
            assert e.status_code == 404
        else:
            raise AssertionError("bad id accepted")

    def now_playing_names_the_film_and_forgets_a_quiet_room():
        jf = "c" * 32
        mv.set_rooms([{"roomId": "/crcmz", "video": mv.stream_url(jf), "paused": False, "participantCount": 3}])
        n = mv.now_playing("crcmz")
        assert n["watching"] == 3 and n["id"] == jf and not n["paused"], n
        mv._rooms["crcmz"]["at"] -= 120
        assert mv.now_playing("crcmz")["watching"] == 0
        assert mv.now_playing("nope")["video"] == ""

    def the_party_is_announced_when_something_plays_not_when_someone_opens_it():
        said: list[tuple] = []
        real, started = mv._in_background, mv._started
        mv._in_background = lambda fn, *a: said.append(a)
        try:
            mv._last_playing.clear()
            mv._last_channel.clear()
            room = lambda video, paused=False, n=1: [{"roomId": "/crcmz", "video": video, "paused": paused, "participantCount": n}]
            v = mv.stream_url("c" * 32)
            t = time.time()
            mv._started = t                                   # just restarted...
            mv.set_rooms(room("", n=1))                       # someone opened the party page: nothing on
            mv.set_rooms(room(v))                             # ...a room already playing only primes
            assert said == [], said
            mv._last_playing["crcmz"] = t - mv.PARTY_QUIET_S - 60   # it went quiet a while ago...
            mv._last_channel["crcmz"] = t - mv.CHANNEL_QUIET_S - 60
            mv.set_rooms(room(v, n=2))                        # ...and now it plays again: a party starting
            assert said == [("crcmz", v, 2, True)], said
            mv.set_rooms(room(v, paused=True, n=2))
            mv.set_rooms(room(v, n=2))                        # a pause and resume isn't a new party
            assert len(said) == 1, said
            mv._last_playing["crcmz"] = t - mv.PARTY_QUIET_S - 60   # off for a bit, then back on:
            mv.set_rooms(room(v, n=2))                        # phones ring again, ~watchparty doesn't
            assert said[-1] == ("crcmz", v, 2, False), said
            mv._started = t - mv.PRIME_S - 1                  # long after a restart, a new room...
            mv.set_rooms([{"roomId": "/late", "video": v, "paused": False, "participantCount": 1}])
            assert said[-1] == ("late", v, 1, True), said     # ...is a party starting, not a prime
        finally:
            mv._in_background, mv._started = real, started

    def a_party_starting_posts_to_the_channel_but_rings_nobody():
        CHANNEL.clear(); NOTES.clear()
        mv.announce_party("crcmz", mv.stream_url("c" * 32), 3, True)
        assert len(CHANNEL) == 1 and CHANNEL[0].startswith("@channel") and "3 watching" in CHANNEL[0], CHANNEL
        assert NOTES == [], "no ring or push: that's the Ring / Rally buttons"
        mv.announce_party("crcmz", mv.stream_url("c" * 32), 3, False)
        assert len(CHANNEL) == 1

    for fn in (catalogues_build_cinemeta_paths_and_refuse_anything_else, a_party_starting_posts_to_the_channel_but_rings_nobody, the_party_is_announced_when_something_plays_not_when_someone_opens_it, highest_rated_is_in_rating_order_with_no_unrated_films,
               home_has_a_featured_film_rows_without_repeats_and_library_state, details_bring_trailers_cast_and_safe_images,
               now_playing_names_the_film_and_forgets_a_quiet_room):
        check(fn.__name__, fn)


# ── Streaming ────────────────────────────────────────────────────────────────
def stream_tests():
    print("streaming")
    jf = "c" * 32

    def master_asks_jellyfin_for_1080p_h264_per_viewer():
        path, p = mv.hls_request("u-zub", jf, "master.m3u8", "api_key=stolen&VideoBitrate=1")
        assert path == f"/Videos/{jf}/master.m3u8"
        assert p["VideoCodec"] == "h264" and p["MaxHeight"] == "1080" and p["VideoBitrate"] == "10000000"
        assert "api_key" not in p and p["MediaSourceId"] == jf
        _, q = mv.hls_request("u-noor", jf, "master.m3u8", "")
        assert p["DeviceId"] != q["DeviceId"] and p["PlaySessionId"] != q["PlaySessionId"]

    def segments_keep_jellyfins_query_but_never_a_key_or_someone_elses_session():
        _, mine = mv.hls_request("u-zub", jf, "master.m3u8", "")
        path, p = mv.hls_request("u-zub", jf, "hls1/main/12.ts",
                                 "MediaSourceId=x&runtimeTicks=360000000&ApiKey=k&PlaySessionId=theirs&DeviceId=theirs")
        assert path == f"/Videos/{jf}/hls1/main/12.ts" and p["runtimeTicks"] == "360000000"
        assert "ApiKey" not in p and p["PlaySessionId"] == mine["PlaySessionId"] and p["DeviceId"] == mine["DeviceId"]

    def anything_but_jellyfins_hls_files_is_a_404():
        for item, path in ((jf, "../../System/Info"), (jf, "stream.mkv"), (jf, "hls1/main/x.ts"),
                           ("Q" * 32, "master.m3u8"), (jf, "Images/Primary")):
            try:
                mv.hls_request("u-zub", item, path, "")
            except HTTPException as e:
                assert e.status_code == 404
            else:
                raise AssertionError(f"{path} was allowed")

    def library_streams_go_in_watch_history():
        import watch_history
        assert watch_history._clean_url(mv.stream_url(jf)) == mv.stream_url(jf)
        assert watch_history._clean_url(f"/api/watch/movies/stream/{jf}/hls1/main/1.ts") == ""
        assert mv.history_meta("/api/watch/proxy?url=x") == {}

    for fn in (master_asks_jellyfin_for_1080p_h264_per_viewer,
               segments_keep_jellyfins_query_but_never_a_key_or_someone_elses_session,
               anything_but_jellyfins_hls_files_is_a_404, library_streams_go_in_watch_history):
        check(fn.__name__, fn)


# ── HTTP and the assistant ───────────────────────────────────────────────────
def http_tests():
    from fastapi.testclient import TestClient
    import server
    import assistant
    import crcmz_identity

    print("routes")
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    origin = {"Origin": "https://app.crcmz.me"}
    cookie = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("u-zub", "z@b.co"))}
    crcmz_identity.by_zitadel_id = lambda refresh=False: {"u-zub": {"zitadel_id": "u-zub", "display_name": "Zubair"}}

    def the_library_needs_a_session_and_adds_credit_the_caller():
        reset(cached={"a" * 40})
        for path in ("/api/watch/movies/library", "/api/watch/movies/search?q=dune", "/api/watch/movies/home",
                     "/api/watch/movies/catalog?kind=top", "/api/watch/movies/meta/tt15239678", "/api/watch/movies/now",
                     f"/api/watch/movies/stream/{'c' * 32}/master.m3u8", f"/api/watch/movies/poster/{'c' * 32}"):
            assert client.get(path).status_code == 401, path
        r = client.get("/api/watch/movies/meta/tt15239678", cookies=cookie)
        assert r.status_code == 200 and r.json()["title"] == "Dune: Part Two" and r.json()["can_add"] is True, r.text
        assert "sub" not in r.text and "u-zub" not in r.text
        assert client.get("/api/watch/movies/catalog?kind=nope", cookies=cookie).status_code == 400
        assert client.get("/api/watch/movies/now?room=crcmz", cookies=cookie).json()["room"] == "crcmz"
        r = client.get("/api/watch/movies/search?q=dune", cookies=cookie)
        assert r.status_code == 200 and r.json()["results"][0]["state"] == "new", r.text
        r = client.post("/api/watch/movies/add", json={"imdb": "tt15239678"}, cookies=cookie, headers=origin)
        assert r.status_code == 200 and r.json()["by"] == "Zubair", r.text
        assert "sub" not in r.json() and "rd_id" not in r.json()
        r = client.post("/api/watch/movies/remove", json={"id": "f" * 32}, cookies=cookie, headers=origin)
        assert r.status_code == 404, r.text
        r = client.get(f"/api/watch/movies/stream/{'c' * 32}/master.m3u8", cookies=cookie)
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.apple.mpegurl")

    def an_app_review_account_gets_the_party_but_no_movies():
        review = {"zitadel_id": "u-review", "display_name": "App Review", "tags": {"review": "true"}}
        saved = crcmz_identity.by_zitadel_id
        crcmz_identity.by_zitadel_id = lambda refresh=False: {"u-zub": {"zitadel_id": "u-zub", "display_name": "Zubair"},
                                                              "u-review": review}
        rc = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("u-review", "appreview@crcmz.me"))}
        try:
            for path in ("/api/watch/movies/home", "/api/watch/movies/library", "/api/watch/movies/search?q=dune",
                         "/api/watch/movies/catalog?kind=top", "/api/watch/movies/meta/tt15239678", "/api/watch/movies/popular"):
                r = client.get(path, cookies=rc)
                assert r.status_code == 403 and r.json()["detail"] == "movies_off", (path, r.status_code)
            assert client.post("/api/watch/movies/add", json={"imdb": "tt15239678"}, cookies=rc, headers=origin).status_code == 403
            assert client.get("/api/watch/movies/now", cookies=rc).status_code == 200, "the party is still theirs"
            assert client.get("/api/watch/movies/home", cookies=cookie).status_code == 200, "everyone else keeps movies"
            assert mv.is_review(review) and not mv.is_review({"tags": {}}) and not mv.is_review(None)
        finally:
            crcmz_identity.by_zitadel_id = saved

    def assistant_tool_lists_movies_without_ids():
        assert "movie_library" in assistant.tool_names()
        out, ok = assistant.call_tool("movie_library", {"limit": 5000})
        assert ok and "Dune" in out and "Zubair" in out, out
        for leak in ("u-zub", "test-rd", "test-jf", "rd_id"):
            assert leak not in out, leak

    for fn in (the_library_needs_a_session_and_adds_credit_the_caller, an_app_review_account_gets_the_party_but_no_movies,
               assistant_tool_lists_movies_without_ids):
        check(fn.__name__, fn)


def share_undo_tests():
    print("a film shared to the app: Undo")

    def undone_in_its_wait_it_never_starts():
        reset()
        old = mv.UNDO_S
        mv.UNDO_S = 0.3
        try:
            async def go():
                r = await mv.add("u-zub", "Zubair", "tt15239678", grace=0.3)
                assert r["status"] == "finding"
                assert mv.undo_add("u-zub", "tt15239678")["ok"]
                await asyncio.gather(*list(mv._tasks))
            run(go())
            assert mv._row("tt15239678") is None, "undone: no add, nothing on Real-Debrid"
        finally:
            mv.UNDO_S = old

    def only_the_adder_and_only_before_it_starts():
        reset()
        run(add_and_wait("u-zub", "Zubair", "tt15239678"))
        for who in ("someone-else", "u-zub"):
            try:
                mv.undo_add(who, "tt15239678")
                raise AssertionError("undo allowed")
            except mv.HTTPException as e:
                assert e.status_code in (404, 409), e.status_code

    for fn in (undone_in_its_wait_it_never_starts, only_the_adder_and_only_before_it_starts):
        check(fn.__name__, fn)


if __name__ == "__main__":
    ranking_tests()
    share_undo_tests()
    add_tests()
    follow_tests()
    local_tests()
    remove_tests()
    subtitle_tests()
    browse_tests()
    stream_tests()
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
