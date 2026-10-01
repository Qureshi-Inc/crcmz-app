#!/usr/bin/env python3
"""Watch · Library (movies.py): choosing a copy, adding through Real-Debrid, Jellyfin, streaming.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_movies

Nothing leaves the box: Real-Debrid, Torrentio, Cinemeta and Jellyfin are fakes.
"""

import asyncio
import os
import sys
import tempfile
import time
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
class FakeRD:
    def __init__(self, cached=()):
        self.cached = set(cached)
        self.torrents: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, method, path, **kw):
        self.calls.append((method, path))
        data = kw.get("data") or {}
        if path == "/torrents/addMagnet":
            h = data["magnet"].rsplit(":", 1)[1]
            tid = f"T{len(self.torrents) + 1}"
            self.torrents[tid] = {"hash": h, "status": "waiting_files_selection", "progress": 0,
                                  "files": [{"id": 1, "path": "/Sample/sample.mkv", "bytes": 10},
                                            {"id": 2, "path": "/Movie.mkv", "bytes": 10_000}]}
            return {"id": tid}
        if method == "GET" and path == "/torrents":
            return [{"id": k, "filename": v.get("filename", "")} for k, v in self.torrents.items()]
        tid = path.rsplit("/", 1)[1]
        t = self.torrents.get(tid)
        if path.startswith("/torrents/info/"):
            return {**t, "files": t["files"]}
        if path.startswith("/torrents/selectFiles/"):
            assert data["files"] == "2", data
            t["status"] = "downloaded" if t["hash"] in self.cached else "downloading"
            t["progress"] = 100 if t["status"] == "downloaded" else 3
            return None
        if path.startswith("/torrents/delete/"):
            del self.torrents[tid]
            return None
        raise AssertionError(path)


class FakeJF:
    def __init__(self):
        self.items: list[dict] = []
        self.calls: list[tuple[str, str, dict]] = []

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
        if path.endswith(".m3u8"):
            return httpx.Response(200, text="#EXTM3U\nmain.m3u8?x=1")
        raise AssertionError(path)

    def movie(self, iid, name, imdb, width=3840, rng="HDR10", path="/zurg/movies/x/x.mkv"):
        self.items.append({"Id": iid, "Name": name, "ProductionYear": 2024, "ProviderIds": {"Imdb": imdb},
                           "Path": path, "DateCreated": f"2026-10-0{len(self.items) + 1}T00:00:00Z",
                           "MediaSources": [{"MediaStreams": [{"Type": "Video", "Width": width, "VideoRangeType": rng}]}]})


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
    if path.startswith("meta/movie/"):
        imdb = path.split("/")[2].split(".")[0]
        return {"meta": {"imdb_id": imdb, "name": f"Film {imdb}", "releaseInfo": "2001"}}
    if path.startswith("catalog/movie/top/search="):
        return {"metas": [{"imdb_id": "tt15239678", "name": "Dune: Part Two", "releaseInfo": "2024"},
                          {"imdb_id": "tt1160419", "name": "Dune", "releaseInfo": "2021"},
                          {"id": "bogus", "name": "No id"}]}
    raise AssertionError(path)


mv._rd = RD
mv._torrentio = fake_torrentio
mv._cinemeta = fake_cinemeta
slap._jf = JF


mv.POLL_S = 0   # no real waiting between Real-Debrid checks
mv.RESCAN_AFTER_S = 0


import notifications  # noqa: E402
notifications.route_in_background = lambda *a, **k: NOTES.append((a, k))


def reset(cached=()):
    with mv._conn() as db:
        db.execute("DELETE FROM adds")
        db.execute("DELETE FROM removed")
    RD.__init__(cached)
    JF.__init__()
    mv._cache.clear()
    mv._last_tick = mv._last_scan = 0.0
    NOTES.clear()


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

    for fn in (the_first_cached_4k_copy_wins_and_the_rest_are_removed, with_nothing_cached_the_best_seeded_4k_downloads,
               a_cached_1080p_beats_an_uncached_4k, no_copy_says_so, already_in_the_library_is_not_added_again,
               a_second_press_joins_the_first_and_bad_ids_are_refused, five_a_day_unless_admin,
               a_failed_add_can_be_tried_again):
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
        assert NOTES and NOTES[0][1]["only"] == ["u-zub"] and "Dune" in NOTES[0][0][1], NOTES

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


# ── Removing ─────────────────────────────────────────────────────────────────
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
               nobody_else_and_never_a_film_on_the_servers_disk):
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
        for path in ("/api/watch/movies/library", "/api/watch/movies/search?q=dune",
                     f"/api/watch/movies/stream/{'c' * 32}/master.m3u8", f"/api/watch/movies/poster/{'c' * 32}"):
            assert client.get(path).status_code == 401, path
        r = client.get("/api/watch/movies/search?q=dune", cookies=cookie)
        assert r.status_code == 200 and r.json()["results"][0]["state"] == "new", r.text
        r = client.post("/api/watch/movies/add", json={"imdb": "tt15239678"}, cookies=cookie, headers=origin)
        assert r.status_code == 200 and r.json()["by"] == "Zubair", r.text
        assert "sub" not in r.json() and "rd_id" not in r.json()
        r = client.post("/api/watch/movies/remove", json={"id": "f" * 32}, cookies=cookie, headers=origin)
        assert r.status_code == 404, r.text
        r = client.get(f"/api/watch/movies/stream/{'c' * 32}/master.m3u8", cookies=cookie)
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.apple.mpegurl")

    def assistant_tool_lists_movies_without_ids():
        assert "movie_library" in assistant.tool_names()
        out, ok = assistant.call_tool("movie_library", {"limit": 5000})
        assert ok and "Dune" in out and "Zubair" in out, out
        for leak in ("u-zub", "test-rd", "test-jf", "rd_id"):
            assert leak not in out, leak

    for fn in (the_library_needs_a_session_and_adds_credit_the_caller, assistant_tool_lists_movies_without_ids):
        check(fn.__name__, fn)


if __name__ == "__main__":
    ranking_tests()
    add_tests()
    follow_tests()
    remove_tests()
    stream_tests()
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
