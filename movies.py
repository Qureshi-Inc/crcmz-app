"""Watch · Library: find a movie, add it to Jellyfin through Real-Debrid, watch it in a party.

    search      Cinemeta (Stremio's free catalogue, keyed by IMDb id) for titles,
                years and posters; "Popular" is its top list
    add         Torrentio lists the copies of that IMDb id; rank() picks the best one:
                4K (HDR preferred, never a remux, a disc image or a cam), else 1080p.
                The first copy Real-Debrid already has cached wins, so most adds are
                ready in a minute. With none cached, the best copy downloads on
                Real-Debrid and the card shows its progress.
    library     Real-Debrid -> Zurg (/zurg/movies) -> Jellyfin's Movies library. Once
                Real-Debrid has the file we ask Jellyfin to rescan, find the film by
                its IMDb id and tell the person who added it.
    remove      the person who added a film (or an admin) can take it out: its copies on
                Real-Debrid are deleted, so Zurg drops them and Jellyfin forgets the film.
                Films on the server's own disk (movies-local) stay.
    play        a party can't play a raw 4K HDR file, so the stream is Jellyfin's 1080p
                H.264 HLS transcode, proxied here so the Jellyfin token stays on the
                server. Each viewer gets their own transcode session.

The Real-Debrid token is Zurg's (same account, or Jellyfin never sees the file):
REAL_DEBRID_TOKEN.

DB: /data/movies.db
  adds     one row per movie someone added: what it is, which copy, its download state
  removed  Jellyfin ids just removed, hidden until Jellyfin's rescan catches up
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

import crcmz_identity
import slap

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("MOVIES_DB", "/data/movies.db"))
_lock = threading.Lock()
_ready = False

RD_TOKEN = os.environ.get("REAL_DEBRID_TOKEN", "")
RD_URL = os.environ.get("REAL_DEBRID_URL", "https://api.real-debrid.com/rest/1.0").rstrip("/")
CINEMETA_URL = os.environ.get("CINEMETA_URL", "https://v3-cinemeta.strem.io").rstrip("/")
TORRENTIO_URL = os.environ.get("TORRENTIO_URL", "https://torrentio.strem.fun").rstrip("/")
_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

ADDS_PER_DAY = 5        # per person; admins aren't capped
TRY_4K = 5              # cached-copy attempts before settling
TRY_1080 = 3
ADDING_GIVE_UP_S = 30 * 60
RESCAN_AFTER_S = 20      # Zurg notices a deleted torrent within seconds
POLL_S = 1.5            # between Real-Debrid checks while a copy is being tried
STREAM_PREFIX = "/api/watch/movies/stream/"

_IMDB = re.compile(r"^tt\d{5,10}$")
_JF_ID = re.compile(r"^[0-9a-f]{32}$")
_HASH = re.compile(r"^[0-9a-f]{40}$")
_HLS_PATH = re.compile(r"^(?:master\.m3u8|main\.m3u8|hls1/main/\d{1,6}\.ts)$")
_VIDEO_EXT = re.compile(r"\.(mkv|mp4|m4v|avi|mov|ts|webm)$", re.I)


def configured() -> bool:
    return bool(RD_TOKEN) and slap.configured()


def _conn() -> sqlite3.Connection:
    global _ready
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    if not _ready:
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        c.executescript("""
            CREATE TABLE IF NOT EXISTS adds (
                imdb      TEXT PRIMARY KEY,
                title     TEXT NOT NULL,
                year      TEXT NOT NULL DEFAULT '',
                poster    TEXT NOT NULL DEFAULT '',
                sub       TEXT NOT NULL,
                name      TEXT NOT NULL DEFAULT '',
                status    TEXT NOT NULL DEFAULT 'finding',
                progress  REAL NOT NULL DEFAULT 0,
                rd_id     TEXT NOT NULL DEFAULT '',
                release   TEXT NOT NULL DEFAULT '',
                quality   TEXT NOT NULL DEFAULT '',
                size_gb   REAL NOT NULL DEFAULT 0,
                jf_id     TEXT NOT NULL DEFAULT '',
                error     TEXT NOT NULL DEFAULT '',
                created   REAL NOT NULL,
                updated   REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS removed (
                jf_id  TEXT PRIMARY KEY,
                ts     REAL NOT NULL
            );
        """)
        _ready = True
    return c


def _row(imdb: str) -> dict | None:
    with _conn() as db:
        r = db.execute("SELECT * FROM adds WHERE imdb = ?", (imdb,)).fetchone()
    return dict(r) if r else None


def _set(imdb: str, **cols: Any) -> None:
    cols["updated"] = time.time()
    with _lock, _conn() as db:
        db.execute(f"UPDATE adds SET {', '.join(f'{k} = ?' for k in cols)} WHERE imdb = ?", (*cols.values(), imdb))


def _public(r: dict) -> dict:
    """What the page sees about an add: no Zitadel id, no Real-Debrid id."""
    return {"imdb": r["imdb"], "title": r["title"], "year": r["year"], "poster": r["poster"],
            "status": r["status"], "progress": round(r["progress"], 1), "quality": r["quality"],
            "size_gb": r["size_gb"], "by": r["name"], "error": r["error"], "id": r["jf_id"] or None,
            "at": int(r["created"] * 1000)}


# ── Choosing a copy ──────────────────────────────────────────────────────────
_REJECT = re.compile(
    r"\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|scr|screener|dvdscr|r5|3d|hsbs|h-sbs|sbs|"
    r"remux|bdremux|iso|bdmv|complete[ .-]?(uhd[ .-]?)?blu-?ray|upscaled?|ai[ .-]?upscale|4klight|sample|trailer|featurettes?|extras|bonus|behind[ .-]the[ .-]scenes|making[ .-]of)\b",
    re.I)
_ZURG_ANIME = re.compile(r"\b[a-fA-F0-9]{8}\b")   # Zurg files these under anime, which Jellyfin doesn't read
_FLAG = re.compile(r"[\U0001F1E6-\U0001F1FF]{2}")
_SIZE = re.compile(r"💾\s*([\d.]+)\s*(GB|MB)", re.I)
_SEEDS = re.compile(r"👤\s*(\d+)")
_BOUNDS = {2160: (6.0, 45.0), 1080: (1.5, 20.0)}   # GB: not a remux, not a starved encode
_SWEET = {2160: (10.0, 35.0), 1080: (4.0, 15.0)}    # a proper encode: the quality without the remux size


def parse_stream(s: dict) -> dict | None:
    """One Torrentio stream -> {hash, release, tier, size_gb, seeders, hdr, dv}, or None."""
    h = str(s.get("infoHash") or "").lower()
    if not _HASH.match(h):
        return None
    name = str(s.get("name") or "")
    tag = name.split("\n", 1)[1] if "\n" in name else name
    tier = 2160 if re.match(r"\s*4k\b", tag, re.I) else 1080 if re.match(r"\s*1080p\b", tag, re.I) else 0
    title = str(s.get("title") or "")
    release = title.split("\n", 1)[0].strip()
    m = _SIZE.search(title)
    size = (float(m.group(1)) / (1024 if m.group(2).upper() == "MB" else 1)) if m else 0.0
    m = _SEEDS.search(title)
    seeders = int(m.group(1)) if m else 0
    hdr = bool(re.search(r"\bHDR(10\+?|10Plus)?\b", tag + " " + release, re.I))
    dv = bool(re.search(r"\b(DV|DoVi|Dolby[ .]?Vision)\b", tag + " " + release, re.I))
    return {"hash": h, "release": release, "tier": tier, "size_gb": round(size, 2), "seeders": seeders,
            "hdr": hdr, "dv": dv, "filename": str((s.get("behaviorHints") or {}).get("filename") or ""),
            "flags": _FLAG.findall(title), "multi": bool(re.search(r"\b(Multi|Dual) Audio\b", title, re.I))}


def _score(c: dict) -> float:
    rel = c["release"]
    # Seeders matter less than you'd think: a copy Real-Debrid has cached plays the same
    # whoever seeds it. They break ties and decide what downloads when nothing is cached.
    s = math.log2(c["seeders"] + 1) * 4
    if re.search(r"blu-?ray|bdrip|brrip", rel, re.I):
        s += 8
    elif re.search(r"web-?dl", rel, re.I):
        s += 6
    elif re.search(r"webrip", rel, re.I):
        s += 3
    if c["hdr"]:
        s += 5
    if c["dv"] and not c["hdr"] and not re.search(r"blu-?ray|bdrip|brrip|uhd", rel, re.I):
        # Web Dolby Vision with no HDR10 under it (profile 5) comes out green and purple when
        # transcoded. Disc DV is profile 7, always on an HDR10 base, so it's fine.
        s -= 30
    lo, hi = _SWEET[c["tier"]]
    if lo <= c["size_gb"] <= hi:
        s += 15
    elif c["size_gb"] < lo:
        s -= 10   # a "4K" this small is starved of bitrate
    return s


def rank(streams: list[dict]) -> list[dict]:
    """Every acceptable copy, best first: all the 4K ones, then the 1080p ones."""
    out = []
    for s in streams:
        c = parse_stream(s)
        if not c or not c["tier"]:
            continue
        if _REJECT.search(c["release"]) or _REJECT.search(c["filename"]):
            continue
        if _ZURG_ANIME.search(c["release"]) or _ZURG_ANIME.search(c["filename"]):
            continue
        if c["flags"] and "🇬🇧" not in c["flags"] and not c["multi"]:
            continue   # dubbed only
        lo, hi = _BOUNDS[c["tier"]]
        if not lo <= c["size_gb"] <= hi:
            continue
        c["score"] = _score(c)
        out.append(c)
    out.sort(key=lambda c: (-c["tier"], -c["score"]))
    return out


def quality_label(tier: int, hdr: bool) -> str:
    return ("4K" if tier >= 2160 else "1080p") + (" HDR" if hdr and tier >= 2160 else "")


# ── Catalogue (Cinemeta) ─────────────────────────────────────────────────────
_cache: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: float) -> Any:
    hit = _cache.get(key)
    return hit[1] if hit and time.time() - hit[0] < ttl else None


def _meta_row(m: dict) -> dict | None:
    imdb = str(m.get("imdb_id") or m.get("id") or "")
    if not _IMDB.match(imdb) or not m.get("name"):
        return None
    year = str(m.get("releaseInfo") or m.get("year") or "")[:4]
    poster = str(m.get("poster") or "")
    return {"imdb": imdb, "title": str(m["name"])[:200], "year": year if year.isdigit() else "",
            "poster": poster if poster.startswith("https://") else "",
            "overview": str(m.get("description") or "")[:600]}


async def _cinemeta(path: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": _UA}, follow_redirects=True) as c:
            r = await c.get(f"{CINEMETA_URL}/{path}")
    except httpx.HTTPError as e:
        logger.warning("movies: cinemeta %s failed: %s", path, e)
        raise HTTPException(502, "the movie catalogue is unreachable")
    if r.status_code == 404:
        return {}
    if r.status_code >= 400:
        raise HTTPException(502, "the movie catalogue refused the request")
    try:
        return r.json()
    except ValueError:
        logger.warning("movies: cinemeta %s answered %s that isn't JSON", path, r.status_code)
        raise HTTPException(502, "the movie catalogue is unreachable")


async def search(q: str) -> list[dict]:
    q = re.sub(r"\s+", " ", q or "").strip()[:80]
    if len(q) < 2:
        return []
    key = f"search:{q.lower()}"
    if (hit := _cached(key, 3600)) is not None:
        return hit
    data = await _cinemeta(f"catalog/movie/top/search={quote(q, safe='')}.json")
    rows = [r for m in (data.get("metas") or [])[:30] if (r := _meta_row(m))]
    _cache[key] = (time.time(), rows)
    return rows


async def popular() -> list[dict]:
    if (hit := _cached("popular", 6 * 3600)) is not None:
        return hit
    data = await _cinemeta("catalog/movie/top.json")
    rows = [r for m in (data.get("metas") or [])[:40] if (r := _meta_row(m))]
    _cache["popular"] = (time.time(), rows)
    return rows


async def meta(imdb: str) -> dict | None:
    data = await _cinemeta(f"meta/movie/{imdb}.json")
    return _meta_row(data.get("meta") or {}) if data else None


async def _torrentio(imdb: str) -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=25, headers={"User-Agent": _UA}, follow_redirects=True) as c:
            r = await c.get(f"{TORRENTIO_URL}/stream/movie/{imdb}.json")
        r.raise_for_status()
        return list(r.json().get("streams") or [])
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("movies: torrentio %s failed: %s", imdb, e)
        return []


# ── Jellyfin ─────────────────────────────────────────────────────────────────
async def _movies_library_id() -> str:
    if (hit := _cached("jf:lib", 3600)) is not None:
        return hit
    folders = slap._ok(await slap._jf("GET", "/Library/VirtualFolders")) or []
    lib = next((f.get("ItemId") for f in folders if (f.get("CollectionType") or "") == "movies"), "") or ""
    _cache["jf:lib"] = (time.time(), lib)
    return lib


def _version(item: dict) -> tuple[int, bool]:
    """(height tier, HDR) of a Jellyfin movie's first video stream."""
    ms = (item.get("MediaSources") or [{}])[0]
    v = next((s for s in ms.get("MediaStreams") or [] if s.get("Type") == "Video"), {}) or {}
    w = int(v.get("Width") or 0)
    tier = 4320 if w >= 7000 else 2160 if w >= 3000 else 1080 if w >= 1700 else 720 if w else 0
    return tier, (v.get("VideoRangeType") or v.get("VideoRange") or "SDR") not in ("SDR", "Unknown", "")


async def jellyfin_movies(refresh: bool = False) -> list[dict]:
    """The Movies library, one card per film (the best version of each), newest first.
    Each card keeps every version's id and path, which removing needs."""
    if not refresh and (hit := _cached("jf:movies", 60)) is not None:
        return hit
    lib = await _movies_library_id()
    params = {"IncludeItemTypes": "Movie", "Recursive": "true", "SortBy": "DateCreated", "SortOrder": "Descending",
              "Fields": "ProviderIds,MediaSources,Path,DateCreated,Overview", "Limit": "500"}
    if lib:
        params["ParentId"] = lib
    items = (slap._ok(await slap._jf("GET", "/Items", params=params)) or {}).get("Items") or []
    with _lock, _conn() as db:
        db.execute("DELETE FROM removed WHERE ts < ?", (time.time() - 6 * 3600,))
        gone = {r[0] for r in db.execute("SELECT jf_id FROM removed")}
    films: dict[str, list[tuple[tuple, dict]]] = {}
    for it in items:
        if not _JF_ID.match(str(it.get("Id") or "")) or it["Id"] in gone:
            continue
        tier, hdr = _version(it)
        path = str(it.get("Path") or "")
        # An upscale is never the version to play; 8K can't be transcoded in time.
        rank_ = (0 if re.search(r"upscale", path, re.I) or tier > 2160 else 1, tier, hdr)
        imdb = (it.get("ProviderIds") or {}).get("Imdb") or ""
        key = imdb or f"jf:{(it.get('Name') or '').lower()}:{it.get('ProductionYear')}"
        films.setdefault(key, []).append((rank_, {
            "id": it["Id"], "imdb": imdb, "title": it.get("Name") or "", "year": str(it.get("ProductionYear") or ""),
            "quality": quality_label(tier, hdr) if tier >= 1080 else "", "overview": (it.get("Overview") or "")[:600],
            "poster": f"/api/watch/movies/poster/{it['Id']}", "added": it.get("DateCreated") or "", "path": path}))
    out = []
    for versions in films.values():
        card = dict(max(versions, key=lambda v: v[0])[1])
        card["versions"] = [{"id": v["id"], "path": v["path"]} for _, v in versions]
        card["added"] = max(v["added"] for _, v in versions)
        out.append(card)
    out.sort(key=lambda c: c["added"], reverse=True)
    _cache["jf:movies"] = (time.time(), out)
    return out


async def library_index() -> dict[str, dict]:
    return {m["imdb"]: m for m in await jellyfin_movies() if m["imdb"]}


async def _rescan() -> None:
    lib = await _movies_library_id()
    path = f"/Items/{lib}/Refresh" if lib else "/Library/Refresh"
    await slap._jf("POST", path, params={"Recursive": "true", "MetadataRefreshMode": "Default",
                                           "ImageRefreshMode": "Default"})


# ── Real-Debrid ──────────────────────────────────────────────────────────────
async def _rd(method: str, path: str, **kw) -> Any:
    if not RD_TOKEN:
        raise HTTPException(503, "adding movies isn't set up yet")
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.request(method, f"{RD_URL}{path}", headers={"Authorization": f"Bearer {RD_TOKEN}"}, **kw)
    except httpx.HTTPError as e:
        logger.warning("movies: real-debrid %s %s failed: %s", method, path.split("/")[1:3], e)
        raise HTTPException(502, "Real-Debrid is unreachable")
    if r.status_code >= 400:
        logger.warning("movies: real-debrid %s answered %s: %s", path.split("/")[1:3], r.status_code, r.text[:200])
        raise HTTPException(502, "Real-Debrid refused the request")
    return r.json() if r.content else None


async def _try_copy(c: dict, *, keep: bool, wait_s: float = 12) -> tuple[str, str] | None:
    """Add one copy to Real-Debrid. Returns (torrent id, status) when it's cached (or
    `keep` is set); otherwise deletes it again and returns None."""
    added = await _rd("POST", "/torrents/addMagnet", data={"magnet": f"magnet:?xt=urn:btih:{c['hash']}"})
    tid = str((added or {}).get("id") or "")
    if not tid:
        return None
    try:
        deadline = time.time() + wait_s
        info: dict = {}
        selected = False
        while time.time() < deadline:
            info = await _rd("GET", f"/torrents/info/{tid}") or {}
            st = info.get("status")
            if st == "waiting_files_selection" and not selected:
                vids = [f for f in info.get("files") or [] if _VIDEO_EXT.search(f.get("path") or "")
                        and not re.search(r"sample|trailer|extras?/", f.get("path") or "", re.I)]
                pick = max(vids, key=lambda f: f.get("bytes") or 0) if vids else None
                await _rd("POST", f"/torrents/selectFiles/{tid}", data={"files": str(pick["id"]) if pick else "all"})
                selected = True
            elif st == "downloaded":
                return tid, "downloaded"
            elif st in ("error", "magnet_error", "virus", "dead"):
                break
            elif selected and st in ("queued", "downloading") and not keep:
                break   # not cached
            await asyncio.sleep(POLL_S)
        if keep and info.get("status") not in ("error", "magnet_error", "virus", "dead"):
            return tid, str(info.get("status") or "queued")
    except HTTPException:
        pass
    try:
        await _rd("DELETE", f"/torrents/delete/{tid}")
    except HTTPException:
        logger.info("movies: couldn't remove a copy we didn't keep")
    return None


# ── Adding a movie ───────────────────────────────────────────────────────────
_fetch_lock = asyncio.Lock()
_tasks: set[asyncio.Task] = set()


async def add(sub: str, name: str, imdb: str, *, admin: bool = False) -> dict:
    if not _IMDB.match(imdb or ""):
        raise HTTPException(400, "which movie?")
    if not RD_TOKEN:
        raise HTTPException(503, "adding movies isn't set up yet")
    have = (await library_index()).get(imdb)
    if have:
        return {"imdb": imdb, "title": have["title"], "year": have["year"], "poster": have["poster"],
                "status": "ready", "progress": 100, "quality": have["quality"], "by": "", "error": "",
                "id": have["id"], "size_gb": 0, "at": 0}
    r = _row(imdb)
    if r and r["status"] != "failed":
        return _public(r)
    if not admin:
        with _conn() as db:
            n = db.execute("SELECT COUNT(*) FROM adds WHERE sub = ? AND created > ?", (sub, time.time() - 86400)).fetchone()[0]
        if n >= ADDS_PER_DAY:
            raise HTTPException(429, f"that's {ADDS_PER_DAY} movies today. Try again tomorrow.")
    m = await meta(imdb)
    if not m:
        raise HTTPException(404, "that movie isn't in the catalogue")
    now = time.time()
    with _lock, _conn() as db:
        db.execute("""INSERT INTO adds (imdb, title, year, poster, sub, name, status, created, updated)
                      VALUES (?,?,?,?,?,?,'finding',?,?)
                      ON CONFLICT(imdb) DO UPDATE SET sub=excluded.sub, name=excluded.name, status='finding',
                        progress=0, error='', rd_id='', release='', quality='', size_gb=0,
                        created=excluded.created, updated=excluded.updated""",
                   (imdb, m["title"], m["year"], m["poster"], sub, name[:80], now, now))
    task = asyncio.create_task(fetch(imdb))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return _public(_row(imdb))


async def fetch(imdb: str) -> None:
    """Find the best copy and start it on Real-Debrid. One movie at a time."""
    async with _fetch_lock:
        try:
            ranked = rank(await _torrentio(imdb))
            if not ranked:
                _set(imdb, status="failed", error="No good copy of this one yet")
                return
            fours = [c for c in ranked if c["tier"] == 2160][:TRY_4K]
            tens = [c for c in ranked if c["tier"] == 1080][:TRY_1080]
            for c in fours + tens:
                got = await _try_copy(c, keep=False)
                if got:
                    _chosen(imdb, c, got[0], "adding")
                    return
            # Nothing cached: download the best copy with people seeding it.
            c = next((c for c in fours if c["seeders"] >= 5), None) or (tens or fours)[0]
            got = await _try_copy(c, keep=True, wait_s=20)
            if not got:
                _set(imdb, status="failed", error="Real-Debrid couldn't get a copy")
                return
            _chosen(imdb, c, got[0], "adding" if got[1] == "downloaded" else "downloading")
        except HTTPException as e:
            _set(imdb, status="failed", error=str(e.detail))
        except Exception:  # noqa: BLE001
            logger.exception("movies: fetching %s failed", imdb)
            _set(imdb, status="failed", error="Something went wrong finding a copy")


def _chosen(imdb: str, c: dict, tid: str, status: str) -> None:
    logger.info("movies: %s -> %s (%s, %.1f GB, %s)", imdb, c["release"][:80], c["tier"], c["size_gb"], status)
    _set(imdb, status=status, rd_id=tid, release=c["release"][:200], quality=quality_label(c["tier"], c["hdr"]),
         size_gb=c["size_gb"], progress=100 if status == "adding" else 0)


# ── Following adds until they're in Jellyfin ─────────────────────────────────
_last_tick = 0.0
_last_scan = 0.0


def pending() -> list[dict]:
    with _conn() as db:
        return [dict(r) for r in db.execute("SELECT * FROM adds WHERE status IN ('finding','downloading','adding')")]


async def tick(force: bool = False) -> int:
    """Move adds along. Returns how many became ready."""
    global _last_tick, _last_scan
    if not force and time.time() - _last_tick < 15:
        return 0
    _last_tick = time.time()
    rows = pending()
    if not rows:
        return 0
    ready = 0
    for r in rows:
        if r["status"] == "downloading" and r["rd_id"]:
            try:
                info = await _rd("GET", f"/torrents/info/{r['rd_id']}") or {}
            except HTTPException:
                continue
            st = info.get("status")
            if st == "downloaded":
                _set(r["imdb"], status="adding", progress=100)
            elif st in ("error", "magnet_error", "virus", "dead"):
                _set(r["imdb"], status="failed", error="Real-Debrid couldn't finish the download")
            else:
                _set(r["imdb"], progress=float(info.get("progress") or 0))
    adding = [r for r in pending() if r["status"] == "adding"]
    if not adding:
        return 0
    have = {m["imdb"]: m for m in await jellyfin_movies(refresh=True) if m["imdb"]}
    for r in adding:
        hit = have.get(r["imdb"])
        if hit:
            _set(r["imdb"], status="ready", jf_id=hit["id"], quality=hit["quality"] or r["quality"])
            ready += 1
            _announce(r, hit["id"])
        elif time.time() - r["updated"] > ADDING_GIVE_UP_S:
            _set(r["imdb"], status="failed", error="Jellyfin didn't pick it up")
    # Zurg lists a new file within seconds; Jellyfin needs telling.
    if any(not have.get(r["imdb"]) for r in adding) and time.time() - _last_scan > 60:
        _last_scan = time.time()
        try:
            await _rescan()
        except HTTPException as e:
            logger.info("movies: rescan failed: %s", e.detail)
    return ready


def _announce(r: dict, jf_id: str) -> None:
    try:
        import notifications
        notifications.route_in_background(
            "watch", f"{r['title']} is ready", "It's in the Watch library. Start a party and press Play.",
            url="/app/watch", only=[r["sub"]], tag=f"movie-{r['imdb']}")
    except Exception:  # noqa: BLE001
        logger.exception("movies: couldn't announce %s", r["imdb"])


async def loop() -> None:
    await asyncio.sleep(30)
    while True:
        try:
            if pending():
                await tick(force=True)
        except Exception as e:  # noqa: BLE001
            logger.warning("movies: background pass failed: %s", e)
        await asyncio.sleep(20)


# ── What the page shows ──────────────────────────────────────────────────────
def _on_debrid(card: dict) -> bool:
    return any(v["path"].startswith("/zurg/") for v in card["versions"])


async def library(sub: str = "", admin: bool = False) -> dict:
    cards = await jellyfin_movies()
    with _conn() as db:
        rows = [dict(r) for r in db.execute(
            "SELECT * FROM adds WHERE status != 'ready' AND updated > ? ORDER BY created DESC", (time.time() - 7 * 86400,))]
        added = {r["imdb"]: (r["name"], r["sub"]) for r in db.execute("SELECT imdb, name, sub FROM adds WHERE status = 'ready'")}
    movies = []
    for c in cards:
        name, by_sub = added.get(c["imdb"], ("", ""))
        movies.append({**{k: v for k, v in c.items() if k not in ("path", "versions")}, "by": name,
                       "can_remove": _on_debrid(c) and (admin or (bool(sub) and by_sub == sub))})
    return {"movies": movies, "adding": [_public(r) for r in rows], "can_add": bool(RD_TOKEN)}


def _rd_dir(path: str) -> tuple[str, str]:
    """/zurg/movies/<torrent folder>/<file> -> (folder, file)."""
    parts = path.split("/")
    return (parts[3] if len(parts) > 4 else "", parts[-1])


async def remove(sub: str, jf_id: str, *, admin: bool = False) -> dict:
    """Take a film out of the library: delete its Real-Debrid copies. Returns how many."""
    if not _JF_ID.match(jf_id or ""):
        raise HTTPException(404, "not found")
    card = next((c for c in await jellyfin_movies(refresh=True) if jf_id in {v["id"] for v in c["versions"]}), None)
    if not card:
        raise HTTPException(404, "that movie isn't in the library")
    row = _row(card["imdb"]) if card["imdb"] else None
    if not (admin or (row and row["sub"] == sub)):
        raise HTTPException(403, "only the person who added it, or an admin, can remove it")
    debrid = [v for v in card["versions"] if v["path"].startswith("/zurg/")]
    if not debrid:
        raise HTTPException(400, "this one is on the server's own disk, so it can't be removed here")
    want = {n for v in debrid for n in _rd_dir(v["path"]) if n}
    torrents = await _rd("GET", "/torrents", params={"limit": "2500"}) or []
    ids = {str(t["id"]) for t in torrents if isinstance(t, dict) and t.get("filename") in want}
    if row and row["rd_id"]:
        ids.add(row["rd_id"])
    if not ids:
        raise HTTPException(404, "couldn't find its copy on Real-Debrid")
    for tid in ids:
        try:
            await _rd("DELETE", f"/torrents/delete/{tid}")
        except HTTPException:
            logger.info("movies: a copy of %s was already gone", card["title"])
    now = time.time()
    with _lock, _conn() as db:
        db.executemany("INSERT OR REPLACE INTO removed (jf_id, ts) VALUES (?, ?)", [(v["id"], now) for v in debrid])
        if card["imdb"]:
            db.execute("DELETE FROM adds WHERE imdb = ?", (card["imdb"],))
    _cache.pop("jf:movies", None)
    logger.info("movies: %s removed %s (%d copies)", "admin" if admin and not (row and row["sub"] == sub) else "adder",
                card["title"], len(ids))
    task = asyncio.create_task(_rescan_later())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"title": card["title"], "removed": len(ids)}


async def _rescan_later() -> None:
    """Once Zurg has dropped the deleted copies, Jellyfin can forget the film."""
    await asyncio.sleep(RESCAN_AFTER_S)
    try:
        await _rescan()
    except HTTPException as e:
        logger.info("movies: rescan after removing failed: %s", e.detail)


async def annotate(rows: list[dict]) -> list[dict]:
    """Catalogue rows + whether each is in the library or on its way."""
    have = await library_index()
    with _conn() as db:
        adds = {r["imdb"]: dict(r) for r in db.execute("SELECT * FROM adds")}
    out = []
    for r in rows:
        h, a = have.get(r["imdb"]), adds.get(r["imdb"])
        state = "ready" if h else (a["status"] if a and a["status"] != "ready" else "new")
        out.append({**r, "state": state, "id": h["id"] if h else None, "quality": (h or {}).get("quality") or "",
                    "progress": round(a["progress"], 1) if a else 0, "error": a["error"] if a and state == "failed" else ""})
    return out


def overview(limit: int = 20, query: str = "") -> dict:
    """For the assistant: what's in the movie library and what's on its way. No ids or subs."""
    limit = max(1, min(int(limit or 20), 100))
    words = [w for w in re.split(r"\W+", (query or "").lower()) if w]
    match = lambda t: all(w in (t or "").lower() for w in words)  # noqa: E731
    with _conn() as db:
        rows = [dict(r) for r in db.execute("SELECT * FROM adds ORDER BY created DESC")]
    added = [{"title": r["title"], "year": r["year"], "status": r["status"], "quality": r["quality"],
              "by": r["name"], "progress": round(r["progress"]),
              "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["created"]))}
             for r in rows if match(r["title"])][:limit]
    library_: list[dict] = []
    if slap.configured():
        try:
            r = httpx.get(f"{slap.JELLYFIN_URL}/Items", headers=slap._jf_headers(), timeout=15, params={
                "IncludeItemTypes": "Movie", "Recursive": "true", "SortBy": "DateCreated",
                "SortOrder": "Descending", "Fields": "MediaSources,ProviderIds", "Limit": "500"})
            seen: set[str] = set()
            for it in (r.json().get("Items") or []) if r.status_code == 200 else []:
                key = (it.get("ProviderIds") or {}).get("Imdb") or it.get("Name")
                if key in seen or not match(it.get("Name")):
                    continue
                seen.add(key)
                tier, hdr = _version(it)
                library_.append({"title": it.get("Name") or "", "year": str(it.get("ProductionYear") or ""),
                                 "quality": quality_label(tier, hdr) if tier >= 1080 else ""})
        except (httpx.HTTPError, ValueError) as e:
            logger.info("movies: overview couldn't list the library: %s", e)
    return {"library": library_[:limit], "library_total": len(library_), "added": added}


# ── Streaming ────────────────────────────────────────────────────────────────
def stream_url(jf_id: str) -> str:
    return f"{STREAM_PREFIX}{jf_id}/master.m3u8"


def _session_ids(sub: str, jf_id: str) -> tuple[str, str]:
    """Per viewer, per film: their own transcode, so one person seeking doesn't stall the rest."""
    device = "crcmz-" + hashlib.sha256(f"dev:{sub}".encode()).hexdigest()[:20]
    play = hashlib.sha256(f"play:{sub}:{jf_id}:{int(time.time() // 21600)}".encode()).hexdigest()[:32]
    return device, play


_TRANSCODE = {"VideoCodec": "h264", "AudioCodec": "aac", "VideoBitrate": "10000000", "AudioBitrate": "192000",
              "MaxWidth": "1920", "MaxHeight": "1080", "TranscodingMaxAudioChannels": "2",
              "SegmentContainer": "ts", "BreakOnNonKeyFrames": "true"}
_DROP = {"api_key", "apikey", "deviceid", "playsessionid"}


def hls_request(sub: str, jf_id: str, path: str, query: str) -> tuple[str, dict]:
    """The Jellyfin path and params for one HLS request from a viewer. Raises 404 on anything else."""
    if not _JF_ID.match(jf_id or "") or not _HLS_PATH.match(path or ""):
        raise HTTPException(404, "not found")
    device, play = _session_ids(sub, jf_id)
    if path == "master.m3u8":
        params = {"MediaSourceId": jf_id, **_TRANSCODE}
    else:
        params = {k: v for k, v in parse_qsl(query or "", keep_blank_values=True) if k.lower() not in _DROP}
    params.update({"DeviceId": device, "PlaySessionId": play})
    return f"/Videos/{jf_id}/{path}", params


def history_meta(url: str) -> dict:
    """Metadata for a library stream in watch history (sync; called from a thread)."""
    m = re.match(re.escape(STREAM_PREFIX) + r"([0-9a-f]{32})/", url or "")
    if not m or not slap.configured():
        return {}
    try:
        r = httpx.get(f"{slap.JELLYFIN_URL}/Items/{m.group(1)}", headers=slap._jf_headers(), timeout=10,
                      params={"Fields": "Overview,ProviderIds,Genres"})
        if r.status_code != 200:
            return {}
        it = r.json()
    except (httpx.HTTPError, ValueError):
        return {}
    return {"kind": "movie", "title": it.get("Name") or "", "year": str(it.get("ProductionYear") or "") or None,
            "description": ", ".join(it.get("Genres") or [])[:200], "overview": (it.get("Overview") or "")[:1200],
            "poster": f"/api/watch/movies/poster/{m.group(1)}", "genres": ", ".join(it.get("Genres") or []),
            "source": "jellyfin", "meta_url": ""}


# ── Routes ───────────────────────────────────────────────────────────────────
def build_router(get_session, is_admin) -> APIRouter:
    router = APIRouter(prefix="/api/watch/movies", tags=["movies"])

    def caller_sub(request: Request) -> str:
        sub = (get_session(request) or {}).get("sub")
        if not sub:
            raise HTTPException(401, "sign in to use the library")
        return sub

    @router.get("/library")
    async def library_get(request: Request):
        sub = caller_sub(request)
        try:
            await tick()
        except HTTPException as e:
            logger.info("movies: couldn't check adds: %s", e.detail)
        return await library(sub, await is_admin(sub))

    @router.post("/remove")
    async def remove_post(request: Request):
        sub = caller_sub(request)
        try:
            b = await request.json()
        except ValueError:
            raise HTTPException(400, "expected JSON")
        jf_id = str((b or {}).get("id") or "") if isinstance(b, dict) else ""
        return await remove(sub, jf_id, admin=await is_admin(sub))

    @router.get("/search")
    async def search_get(request: Request, q: str = ""):
        caller_sub(request)
        return {"results": await annotate(await search(q))}

    @router.get("/popular")
    async def popular_get(request: Request):
        caller_sub(request)
        return {"results": await annotate(await popular())}

    @router.post("/add")
    async def add_post(request: Request):
        sub = caller_sub(request)
        try:
            b = await request.json()
        except ValueError:
            raise HTTPException(400, "expected JSON")
        imdb = str((b or {}).get("imdb") or "") if isinstance(b, dict) else ""
        person = (await asyncio.to_thread(crcmz_identity.by_zitadel_id)).get(sub) or {}
        name = person.get("display_name") or person.get("username") or "someone"
        return await add(sub, name, imdb, admin=await is_admin(sub))

    @router.get("/poster/{jf_id}")
    async def poster(jf_id: str, request: Request):
        caller_sub(request)
        if not _JF_ID.match(jf_id):
            raise HTTPException(404, "not found")
        r = await slap._jf("GET", f"/Items/{jf_id}/Images/Primary", params={"maxWidth": "400", "quality": "85"})
        if r.status_code != 200:
            raise HTTPException(404, "no poster")
        return Response(r.content, media_type=r.headers.get("content-type", "image/jpeg"),
                        headers={"Cache-Control": "private, max-age=86400"})

    @router.get("/stream/{jf_id}/{path:path}")
    async def stream(jf_id: str, path: str, request: Request):
        sub = caller_sub(request)
        jf_path, params = hls_request(sub, jf_id, path, request.url.query)
        if path.endswith(".m3u8"):
            r = await slap._jf("GET", jf_path, params=params)
            if r.status_code >= 400:
                logger.warning("movies: jellyfin playlist %s answered %s", path, r.status_code)
                raise HTTPException(502, "the movie won't play right now")
            return Response(r.content, media_type="application/vnd.apple.mpegurl", headers={"Cache-Control": "no-store"})
        req = slap._client.build_request("GET", jf_path, params=params, headers=slap._jf_headers(),
                                         timeout=httpx.Timeout(20.0, read=180.0))
        try:
            r = await slap._client.send(req, stream=True)
        except httpx.HTTPError as e:
            logger.warning("movies: jellyfin segment failed: %s", e)
            raise HTTPException(502, "the movie won't play right now")
        if r.status_code >= 400:
            await r.aclose()
            logger.warning("movies: jellyfin segment %s answered %s", path, r.status_code)
            raise HTTPException(502, "the movie won't play right now")
        return StreamingResponse(r.aiter_bytes(), media_type="video/mp2t", background=BackgroundTask(r.aclose),
                                 headers={"Cache-Control": "private, max-age=3600"})

    return router


__all__ = ["add", "annotate", "build_router", "remove", "configured", "fetch", "hls_request", "history_meta", "library", "loop",
           "overview", "popular", "rank", "search", "stream_url", "tick"]
