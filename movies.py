"""Watch · Library: find a movie, add it through Real-Debrid, keep it on the server, watch it in a party.

    search      Cinemeta (Stremio's free catalogue, keyed by IMDb id) for titles,
                years and posters; "Popular" is its top list
    add         Torrentio lists the copies of that IMDb id; rank() picks the best one:
                4K (HDR preferred, never a remux, a disc image or a cam), else 1080p.
                The disk guard drops any copy that would leave the server with less
                than MIN_FREE_GB free, so a big 4K gives way to 1080p; if nothing
                fits, the add fails and says so. The first copy Real-Debrid already
                has cached wins, so most adds start copying within a minute. With none
                cached, the best copy downloads on Real-Debrid and the card shows it.
                Everyone else hears "X added Y" (category "movies").
    copy        once Real-Debrid has the file, copy_worker() downloads it from a
                Real-Debrid unrestricted link onto the server's own disk, one film at a
                time: LOCAL_DIR/.incoming/<imdb>.part (Range-resumed after a restart),
                size checked, then renamed into "Title (Year) [imdbid-tt…]/file.mkv" so
                Jellyfin never sees half a file and matches the film by its id. The
                card says "Downloading to the server… 42%".
                LOCAL_DIR is the host's /home/opti3/media/movies-local, bind-mounted
                into this container at /movies-local (a Coolify storage on app 24);
                Jellyfin reads the same folder, read-only, at /media/movies-local.
                Without that mount the old flow stands: Jellyfin streams from Zurg.
    library     Jellyfin's Movies library: /media/movies-local and Real-Debrid via Zurg
                (/zurg/movies). When Jellyfin lists the local copy, the film's Real-
                Debrid torrents are deleted (never while someone is playing that copy),
                so only the local one is left, and everyone hears "Y is ready to watch".
    migrate     films that were only on Real-Debrid are copied the same way, in the
                background, one at a time and silently (migrate=1 rows: no card, no
                notification). Runs once; the flag is in meta.
    remove      the person who added a film (or an admin) can take it out: its copies on
                Real-Debrid are deleted and its local folder too. Films someone put in
                movies-local by hand (no [imdbid-…] folder) stay.
    play        a party can't play a raw 4K HDR file, so the stream is Jellyfin's 1080p
                H.264 HLS transcode, proxied here so the Jellyfin token stays on the
                server. Each viewer gets their own transcode session.

The Real-Debrid token is Zurg's (same account, or Jellyfin never sees the file):
REAL_DEBRID_TOKEN.

DB: /data/movies.db
  adds     one row per movie someone added (or being migrated): what it is, which copy,
           its state (finding → downloading → copying → adding → ready, or failed)
           and, once it's on the server, the folder it's in
  removed  Jellyfin ids just removed, hidden until Jellyfin's rescan catches up
  meta     one-off flags (the migration ran)
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import re
import shutil
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
# Every try is an add (and usually a delete) on Real-Debrid; a burst of them looks like
# abuse and can get our IP refused, so a movie gets at most MAX_ADDS.
MAX_ADDS = 3
TRY_4K = 2              # cached-copy attempts in 4K, then one in 1080p, then one to download
BLOCK_PAUSE_S = 6 * 3600
# Big Buck Bunny (public domain): if Real-Debrid refuses even this, it's refusing us, not the film.
PROBE_HASH = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"
SERVER_BLOCKED = ("Real-Debrid is refusing new movies from our server right now (every torrent, even free "
                  "ones). It's usually temporary; try again later.")
_rd_blocked_until = 0.0
ADDING_GIVE_UP_S = 30 * 60
RESCAN_AFTER_S = 20      # Zurg notices a deleted torrent within seconds
POLL_S = 1.5            # between Real-Debrid checks while a copy is being tried
STREAM_PREFIX = "/api/watch/movies/stream/"

# The server's own disk. Containers see it at different paths: this app writes LOCAL_DIR,
# Jellyfin reads JF_LOCAL.
LOCAL_DIR = Path(os.environ.get("MOVIES_LOCAL_DIR", "/movies-local"))
JF_LOCAL = os.environ.get("MOVIES_JELLYFIN_LOCAL", "/media/movies-local").rstrip("/")
LOCAL_UID = int(os.environ.get("MOVIES_LOCAL_UID", "1000"))
MIN_FREE_GB = float(os.environ.get("MOVIES_MIN_FREE_GB", "100"))
MIGRATE = os.environ.get("MOVIES_MIGRATE", "1") != "0"
CHUNK = 4 << 20

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
            CREATE TABLE IF NOT EXISTS meta (
                key    TEXT PRIMARY KEY,
                value  TEXT NOT NULL
            );
        """)
        have = {r[1] for r in c.execute("PRAGMA table_info(adds)")}
        for col, ddl in (("src_file", "TEXT NOT NULL DEFAULT ''"),     # which file of the torrent to copy
                         ("local_dir", "TEXT NOT NULL DEFAULT ''"),    # its folder under LOCAL_DIR
                         ("local_file", "TEXT NOT NULL DEFAULT ''"),
                         ("bytes_total", "INTEGER NOT NULL DEFAULT 0"),
                         ("bytes_done", "INTEGER NOT NULL DEFAULT 0"),
                         ("migrate", "INTEGER NOT NULL DEFAULT 0")):   # a film moved off Real-Debrid: silent
            if col not in have:
                c.execute(f"ALTER TABLE adds ADD COLUMN {col} {ddl}")
        c.commit()
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


def _img(url: object, size: str = "medium") -> str:
    """Cinemeta images (metahub) at the size we want; anything not https is dropped."""
    u = str(url or "")
    if not u.startswith("https://"):
        return ""
    return re.sub(r"/(small|medium|large)/(tt\d+)/", f"/{size}/\\2/", u)


def _meta_row(m: dict) -> dict | None:
    imdb = str(m.get("imdb_id") or m.get("id") or "")
    if not _IMDB.match(imdb) or not m.get("name"):
        return None
    year = str(m.get("releaseInfo") or m.get("year") or "")[:4]
    genres = m.get("genres") or m.get("genre") or []
    rating = str(m.get("imdbRating") or "")
    return {"imdb": imdb, "title": str(m["name"])[:200], "year": year if year.isdigit() else "",
            "poster": _img(m.get("poster")), "background": _img(m.get("background")),
            "rating": rating if re.match(r"^\d{1,2}(\.\d)?$", rating) else "",
            "genres": [str(g)[:30] for g in genres if isinstance(g, str)][:4] if isinstance(genres, list) else [],
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


# Browsing. Cinemeta's movie catalogues: "top" is what's popular now, "year" what came
# out in a year, "imdbRating" the best rated; the first and last split by genre.
GENRES = ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary", "Drama", "Family",
          "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western"]
_CATALOGS = {"popular": "top", "new": "year", "top": "imdbRating"}
_YT = re.compile(r"^[A-Za-z0-9_-]{11}$")
PAGE = 50


def _this_year() -> str:
    return time.strftime("%Y")


async def catalog(kind: str, genre: str = "", skip: int = 0) -> list[dict]:
    """One page of a catalogue. `genre` is a genre (popular, top) or a year (new)."""
    if kind not in _CATALOGS:
        raise HTTPException(400, "which list?")
    if kind == "new":
        genre = genre or _this_year()
        if not re.match(r"^(19|20)\d\d$", genre):
            raise HTTPException(400, "which year?")
    elif genre and genre not in GENRES:
        raise HTTPException(400, "which genre?")
    skip = max(0, min(int(skip or 0), 1000))
    extra = "&".join(x for x in (f"genre={quote(genre, safe='')}" if genre else "", f"skip={skip}" if skip else "") if x)
    path = f"catalog/movie/{_CATALOGS[kind]}" + (f"/{extra}" if extra else "") + ".json"
    key = f"cat:{path}"
    if (hit := _cached(key, 6 * 3600)) is not None:
        return hit
    data = await _cinemeta(path)
    rows = [r for m in (data.get("metas") or []) if (r := _meta_row(m))]
    if kind == "top":
        # Cinemeta's "Featured" list isn't in rating order and has unrated new releases.
        rows = sorted((r for r in rows if r["rating"] and float(r["rating"]) >= 7.0),
                      key=lambda r: -float(r["rating"]))
    _cache[key] = (time.time(), rows)
    return rows


HOME_GENRES = ["Action", "Comedy", "Horror", "Sci-Fi", "Animation", "Thriller", "Romance", "Crime"]


async def home(genre: str = "") -> dict:
    """The Movies home: a featured film and rows of posters. With a genre, every row is that genre."""
    if genre and genre not in GENRES:
        raise HTTPException(400, "which genre?")
    if genre:
        plan = [("popular", f"Popular {genre}", "popular", genre), ("top", f"Highest rated {genre}", "top", genre)]
    else:
        y = _this_year()
        plan = [("popular", "Trending now", "popular", ""), ("new", f"New in {y}", "new", y),
                ("top", "Highest rated", "top", "")] + [(f"g-{g}", g, "popular", g) for g in HOME_GENRES]

    async def one(kind: str, g: str) -> list[dict]:
        try:
            return await catalog(kind, g)
        except HTTPException as e:
            logger.info("movies: home row %s/%s failed: %s", kind, g, e.detail)
            return []

    lists = await asyncio.gather(*(one(kind, g) for _, _, kind, g in plan))
    rows, seen = [], set()
    for (rid, title, kind, g), items in zip(plan, lists):
        # Genre rows skip films already shown higher up, so the page doesn't repeat itself.
        fresh = [m for m in items if m["imdb"] not in seen] if rid.startswith("g-") else items
        pick = (fresh if len(fresh) >= 8 else items)[:20]
        if pick:
            rows.append({"id": rid, "title": title, "kind": kind, "genre": g, "items": pick})
            seen.update(m["imdb"] for m in pick[:10])
    pool = [m for m in (lists[0] if lists else [])[:12] if m["background"]]
    # The same featured film all day, a different one tomorrow.
    featured = pool[int(time.time() // 86400) % len(pool)] if pool else None
    flat = [m for r in rows for m in r["items"]] + ([featured] if featured else [])
    states = {m["imdb"]: m for m in await annotate(flat)}
    for r in rows:
        r["items"] = [states[m["imdb"]] for m in r["items"]]
    return {"featured": states[featured["imdb"]] if featured else None, "rows": rows, "genres": GENRES}


async def details(imdb: str) -> dict:
    """Everything the movie sheet shows."""
    if not _IMDB.match(imdb or ""):
        raise HTTPException(404, "not found")
    key = f"meta:{imdb}"
    m = _cached(key, 24 * 3600)
    if m is None:
        m = (await _cinemeta(f"meta/movie/{imdb}.json")).get("meta") or {}
        _cache[key] = (time.time(), m)
    row = _meta_row(m)
    if not row:
        raise HTTPException(404, "that movie isn't in the catalogue")
    trailers = []
    for t in m.get("trailers") or []:
        yt = str((t or {}).get("source") or "")
        if _YT.match(yt) and yt not in trailers:
            trailers.append(yt)
    runtime = re.match(r"^(\d{1,3})", str(m.get("runtime") or ""))
    lst = lambda v: [str(x)[:60] for x in (v or []) if isinstance(x, str)][:8]  # noqa: E731
    return {**row, "overview": str(m.get("description") or "")[:2000], "poster": _img(m.get("poster"), "large"),
            "background": _img(m.get("background"), "large"), "logo": _img(m.get("logo")),
            "runtime": int(runtime.group(1)) if runtime else 0, "director": lst(m.get("director")),
            "cast": lst(m.get("cast")), "writer": lst(m.get("writer")), "awards": str(m.get("awards") or "")[:200],
            "country": str(m.get("country") or "").split(",")[0][:60], "trailers": trailers[:3]}


# What the party is on right now, from the Watch Party server's room list (server.py's
# chat poller hands it over every few seconds).
_rooms: dict[str, dict] = {}


PARTY_QUIET_S = 10 * 60     # a room that's been off this long is "starting" when it plays again: phones ring
CHANNEL_QUIET_S = 30 * 60   # ~watchparty's @channel waits for a longer break, so it isn't spammed
PRIME_S = 120               # just after a restart, a playing room is a party already running
_last_playing: dict[str, float] = {}
_last_channel: dict[str, float] = {}
_started = time.time()


def set_rooms(rooms: list) -> None:
    now = time.time()
    for rm in rooms if isinstance(rooms, list) else []:
        rid = str((rm or {}).get("roomId") or "").strip("/")
        if not rid:
            continue
        r = {"video": str(rm.get("video") or ""), "paused": bool(rm.get("paused")),
             "watching": int(rm.get("participantCount") or 0), "at": now}
        _rooms[rid] = r
        if not (r["video"] and not r["paused"] and r["watching"] > 0):
            continue
        # Playing. After a quiet spell that's a party starting: tell everyone. A room already
        # playing when we come up (a restart) only primes, so a running party isn't announced twice.
        last = _last_playing.get(rid)
        _last_playing[rid] = now
        if last is None and now - _started < PRIME_S:
            _last_channel[rid] = now
            continue
        if last is None or now - last > PARTY_QUIET_S:
            ch = _last_channel.get(rid)
            to_channel = ch is None or now - ch > CHANNEL_QUIET_S
            if to_channel:
                _last_channel[rid] = now
            _in_background(announce_party, rid, r["video"], r["watching"], to_channel)


def _in_background(fn, *args) -> None:
    threading.Thread(target=fn, args=args, name="party-on", daemon=True).start()


def _video_title(url: str) -> str:
    if url.startswith(STREAM_PREFIX):
        return history_meta(url).get("title") or ""
    try:
        import watch_history
        return (watch_history.item_info(url) or {}).get("title") or ""
    except Exception:  # noqa: BLE001
        return ""


def announce_party(room: str, video: str, watching: int, to_channel: bool = True) -> None:
    """A Watch Party has something playing: a ring/push + inbox for everyone, and ~watchparty."""
    title = _video_title(video)
    what = f"**{title}**" if title else "something"
    n = f"{watching} watching"
    try:
        import notifications
        notifications.route("watch", f"📺 Watch Party: {title or 'on now'}", f"{n}. Tap to join.",
                            "/app/watch/party", tag=f"watch-{room}", urgency="high", ttl=1800)
    except Exception:  # noqa: BLE001
        logger.exception("movies: couldn't push the party start")
    if to_channel:
        announce_channel(f"@channel 📺 The Watch Party is on: {what} is playing ({n}). "
                         f"Join: {PUBLIC_URL}/app/watch/party")


def now_playing(room: str) -> dict:
    r = _rooms.get(room) or {}
    if not r or time.time() - r["at"] > 60:
        return {"room": room, "watching": 0, "video": "", "title": "", "poster": "", "id": None, "paused": True}
    url = r["video"]
    m = re.match(re.escape(STREAM_PREFIX) + r"([0-9a-f]{32})/", url)
    info: dict = {}
    if url:
        try:
            import watch_history
            info = watch_history.item_info(url) or {}
        except Exception:  # noqa: BLE001
            info = {}
    return {"room": room, "watching": r["watching"], "video": url, "paused": r["paused"],
            "title": info.get("title") or "", "poster": info.get("poster") or "", "id": m.group(1) if m else None}


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
        size = int(((it.get("MediaSources") or [{}])[0] or {}).get("Size") or 0)
        # An upscale is never the version to play; 8K can't be transcoded in time. The copy
        # on the server's disk beats the same film on Real-Debrid; then the bigger encode.
        rank_ = (0 if re.search(r"upscale", path, re.I) or tier > 2160 else 1, tier, hdr,
                 path.startswith(JF_LOCAL + "/"), size)
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
        if r.status_code == 451:
            # "infringing_file": Real-Debrid has this one torrent blocked (a takedown). Others may be fine.
            raise HTTPException(451, "Real-Debrid has that copy blocked")
        if r.status_code == 429:
            raise HTTPException(429, "Real-Debrid says we're asking too often. Try again in a few minutes.")
        raise HTTPException(502, "Real-Debrid refused the request")
    return r.json() if r.content else None


async def _try_copy(c: dict, *, keep: bool, wait_s: float = 12) -> tuple[str, str] | None:
    """Add one copy to Real-Debrid. Returns (torrent id, status) when it's cached (or
    `keep` is set); otherwise deletes it again and returns None."""
    try:
        added = await _rd("POST", "/torrents/addMagnet", data={"magnet": f"magnet:?xt=urn:btih:{c['hash']}"})
    except HTTPException as e:
        if e.status_code != 451:
            raise
        c["blocked"] = True
        logger.info("movies: Real-Debrid has %s blocked; trying the next copy", c["release"][:60])
        return None
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


# ── The server's own disk ────────────────────────────────────────────────────
class _Refused(Exception):
    """A copy that can't happen: the add fails with this message."""


def local_on() -> bool:
    """Is the server's movie folder mounted here? Without it Jellyfin streams from Zurg."""
    return LOCAL_DIR.is_dir()


def _gb(n: float) -> str:
    return f"{n / 2**30:.0f} GB"


def _reserved(skip: str = "") -> int:
    """Bytes still to land for copies already promised, so two adds can't both take the last 100 GB."""
    with _conn() as db:
        rows = db.execute("SELECT imdb, size_gb, bytes_total, bytes_done FROM adds "
                          "WHERE status IN ('downloading', 'copying')").fetchall()
    return sum(max(0, (r["bytes_total"] or int(r["size_gb"] * 2**30)) - r["bytes_done"]) for r in rows if r["imdb"] != skip)


def _room(skip: str = "") -> int:
    """Bytes a new copy may use without the disk dropping under MIN_FREE_GB free."""
    return shutil.disk_usage(LOCAL_DIR).free - _reserved(skip) - int(MIN_FREE_GB * 2**30)


def _no_room(need: float, room: float) -> str:
    return (f"There isn't room on the server for this one: it needs {_gb(need)} and only {_gb(max(0, room))} "
            f"can go before the disk drops under {MIN_FREE_GB:.0f} GB free.")


_UNSAFE = re.compile(r'[\x00-\x1f/\\:*?"<>|]+')


def _clean_name(s: str, limit: int = 120) -> str:
    s = re.sub(r"\s+", " ", _UNSAFE.sub(" ", s or "")).strip(" .")
    return s[:limit].strip(" .")


def folder_name(title: str, year: str, imdb: str) -> str:
    """'Title (Year) [imdbid-tt…]': Jellyfin matches the film by the id in the folder name."""
    t = _clean_name(title) or imdb
    return f"{t} ({year}) [imdbid-{imdb}]" if year else f"{t} [imdbid-{imdb}]"


def _file_name(name: str, imdb: str) -> str:
    base = _clean_name(name.rsplit("/", 1)[-1], 160)
    return base if _VIDEO_EXT.search(base) and not base.startswith(".") else f"{imdb}.mkv"


def _local_folder(path: str) -> str:
    """/media/movies-local/<folder>/<file> -> <folder>, or '' for anything else."""
    if not path.startswith(JF_LOCAL + "/"):
        return ""
    parts = path[len(JF_LOCAL) + 1:].split("/")
    return parts[0] if len(parts) >= 2 and parts[0] not in ("", ".", "..") else ""


def _managed(path: str, imdb: str) -> bool:
    """A folder this app made (so it may delete it): '… [imdbid-<this film>]'."""
    return bool(imdb) and _local_folder(path).endswith(f"[imdbid-{imdb}]")


def _is_local(path: str) -> bool:
    return path.startswith(JF_LOCAL + "/")


# ── Telling people ───────────────────────────────────────────────────────────
LIBRARY_URL = "/app/watch?library=downloaded"


def _members() -> list[str]:
    """Every active person in the identity graph (Zitadel ids)."""
    try:
        people = crcmz_identity.people()
    except Exception:  # noqa: BLE001
        return []
    return sorted({p["zitadel_id"] for p in people if p.get("zitadel_id") and not p.get("is_bot")
                   and (not p.get("state") or p["state"] in ("USER_STATE_ACTIVE", "active"))})


def _film(r: dict) -> str:
    return f"{r['title']} ({r['year']})" if r.get("year") else r["title"]


# The squad's Mattermost channel for Watch: every add, every film that's ready and every
# party that starts is posted there with @channel, so the whole channel is alerted.
WATCH_CHANNEL = os.environ.get("WATCH_MM_CHANNEL", "watchparty")
PUBLIC_URL = "https://" + os.environ.get("PORTAL_PUBLIC_HOST", "app.crcmz.me")
_channel_id: str | None = None


def announce_channel(text: str) -> bool:
    """Post to the Watch channel (blocking; call from a thread). Best-effort."""
    global _channel_id
    if not WATCH_CHANNEL:
        return False
    try:
        import mattermost
        if not mattermost.available():
            return False
        _channel_id = _channel_id or mattermost.find_channel_id(WATCH_CHANNEL)
        if not _channel_id:
            logger.warning("movies: no Mattermost channel %r the bot is in", WATCH_CHANNEL)
            return False
        ok = mattermost.post_channel(_channel_id, text)
        logger.info("movies: posted to ~%s: %s", WATCH_CHANNEL, ok)
        return ok
    except Exception:  # noqa: BLE001
        logger.exception("movies: couldn't post to ~%s", WATCH_CHANNEL)
        return False


def _movie_link(r: dict) -> str:
    return f"{PUBLIC_URL}/app/watch?m={r['imdb']}"


async def _announce_added(r: dict) -> None:
    """Squad news, once a copy is on its way: "Zubair added Dune". Inbox and push for
    everyone but them; no WhatsApp or Mattermost DMs (it isn't a message to you)."""
    try:
        import notifications
        subs = [s for s in await asyncio.to_thread(_members) if s != r["sub"]]
        if not subs:
            return
        who = r["name"] or "Someone"
        notifications.route_in_background(
            "movies", f"{who} added {r['title']}",
            "It's on its way to the server. You'll hear when it's ready to watch.",
            url=LIBRARY_URL, only=subs, exclude=r["sub"], tag=f"movie-added-{r['imdb']}", dms=False)
    except Exception:  # noqa: BLE001
        logger.exception("movies: couldn't announce the add of %s", r["imdb"])
    who = r["name"] or "Someone"
    quality = f" ({r['quality']})" if r.get("quality") else ""
    await asyncio.to_thread(announce_channel, f"@channel 🎬 **{who}** added **{_film(r)}**{quality} to the "
                            f"Watch library. It's on its way; you'll hear when it's ready.\n{_movie_link(r)}")


async def _announce_ready(r: dict) -> None:
    """"Dune is ready to watch": inbox and push for everyone; a DM only for whoever added it."""
    try:
        import notifications
        title, body = f"{r['title']} is ready to watch", "It's in the Watch library. Start a party and press Play."
        others = [s for s in await asyncio.to_thread(_members) if s != r["sub"]]
        if others:
            notifications.route_in_background(
                "movies", title, body, url=LIBRARY_URL, only=others, tag=f"movie-ready-{r['imdb']}", dms=False)
        if r["sub"]:
            notifications.route_in_background(
                "movies", title, body, url=LIBRARY_URL, only=[r["sub"]], tag=f"movie-ready-{r['imdb']}",
                dm_text=f"🍿 {_film(r)}, the movie you added, is ready to watch in the Watch library. "
                        "Start a party and press Play.")
    except Exception:  # noqa: BLE001
        logger.exception("movies: couldn't announce %s", r["imdb"])
    by = f", added by {r['name']}" if r.get("name") else ""
    await asyncio.to_thread(announce_channel, f"@channel 🍿 **{_film(r)}** is ready to watch{by}. "
                            f"Open it and press Watch together:\n{_movie_link(r)}")


async def _announce_failed(r: dict) -> None:
    """Only the person who pressed Add hears that it didn't work, and why."""
    if not r["sub"]:
        return
    try:
        import notifications
        notifications.route_in_background(
            "movies", f"Couldn't add {r['title']}", r["error"] or "Something went wrong finding a copy.",
            url=f"/app/watch?m={r['imdb']}", only=[r["sub"]], tag=f"movie-failed-{r['imdb']}", dms=False)
    except Exception:  # noqa: BLE001
        logger.exception("movies: couldn't report the failed add of %s", r["imdb"])


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


# ── Adding a movie ───────────────────────────────────────────────────────────
_fetch_lock = asyncio.Lock()
_tasks: set[asyncio.Task] = set()


async def add(sub: str, name: str, imdb: str, *, admin: bool = False) -> dict:
    if not _IMDB.match(imdb or ""):
        raise HTTPException(400, "which movie?")
    if not RD_TOKEN:
        raise HTTPException(503, "adding movies isn't set up yet")
    if time.time() < _rd_blocked_until:
        raise HTTPException(503, SERVER_BLOCKED)
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
            n = db.execute("SELECT COUNT(*) FROM adds WHERE sub = ? AND created > ? AND migrate = 0",
                           (sub, time.time() - 86400)).fetchone()[0]
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
                        progress=0, error='', rd_id='', release='', quality='', size_gb=0, src_file='',
                        local_dir='', local_file='', bytes_total=0, bytes_done=0, migrate=0,
                        created=excluded.created, updated=excluded.updated""",
                   (imdb, m["title"], m["year"], m["poster"], sub, name[:80], now, now))
    row = _row(imdb)
    _spawn(fetch(imdb))
    return _public(row)


def _after_rd() -> str:
    """Where an add goes once Real-Debrid has the whole file."""
    return "copying" if local_on() else "adding"


async def fetch(imdb: str) -> None:
    """Find the best copy and start it on Real-Debrid, then tell people how it went."""
    await _fetch(imdb)
    r = _row(imdb)
    if not r:
        return
    if r["status"] == "failed":
        await _announce_failed(r)
    elif r["status"] != "finding":
        await _announce_added(r)


async def _fetch(imdb: str) -> None:
    """Find the best copy and start it on Real-Debrid. One movie at a time."""
    async with _fetch_lock:
        try:
            ranked = rank(await _torrentio(imdb))
            if not ranked:
                _set(imdb, status="failed", error="No good copy of this one yet")
                return
            if local_on():
                # The disk guard: a 4K that would leave under MIN_FREE_GB free gives way to 1080p.
                room = _room(imdb)
                fits = [c for c in ranked if c["size_gb"] * 2**30 <= room]
                if not fits:
                    _set(imdb, status="failed", error=_no_room(min(c["size_gb"] for c in ranked) * 2**30, room))
                    return
                if len(fits) < len(ranked):
                    logger.info("movies: %s: %d copies too big for the disk (%s usable)", imdb,
                                len(ranked) - len(fits), _gb(room))
                ranked = fits
            fours = [c for c in ranked if c["tier"] == 2160]
            tens = [c for c in ranked if c["tier"] == 1080]
            # Up to MAX_ADDS copies: the best 4K ones, then the best 1080p. The first one Real-Debrid
            # takes is held (downloading) while the others are checked for a copy it already has;
            # a cached one wins and the held one is deleted. Never add, delete and re-add.
            plan = (fours[:TRY_4K] + tens[:1])[:MAX_ADDS]
            held = None
            for n, c in enumerate(plan):
                got = await _try_copy(c, keep=held is None)
                if got and got[1] == "downloaded":
                    if held:
                        try:
                            await _rd("DELETE", f"/torrents/delete/{held[1]}")
                        except HTTPException:
                            logger.info("movies: couldn't remove the copy we held")
                    _chosen(imdb, c, got[0], _after_rd())
                    return
                if got and held is None:
                    held = (c, got[0])
                if n == 0 and c.get("blocked") and await _we_are_blocked():
                    _set(imdb, status="failed", error=SERVER_BLOCKED)
                    return
            if held:
                _chosen(imdb, held[0], held[1], "downloading")
                return
            blocked = sum(1 for x in plan if x.get("blocked"))
            _set(imdb, status="failed", error=(
                "Real-Debrid has the copies of this one blocked (a takedown claim). New releases often are; "
                "try again in a few days." if blocked else "Real-Debrid couldn't get a copy"))
        except HTTPException as e:
            _set(imdb, status="failed", error=str(e.detail))
        except Exception:  # noqa: BLE001
            logger.exception("movies: fetching %s failed", imdb)
            _set(imdb, status="failed", error="Something went wrong finding a copy")


async def _we_are_blocked() -> bool:
    """The first copy was refused: is Real-Debrid refusing this film, or us? Adds a public
    domain film once to find out (deleted straight away). If us, adds pause for a while."""
    global _rd_blocked_until
    try:
        added = await _rd("POST", "/torrents/addMagnet", data={"magnet": f"magnet:?xt=urn:btih:{PROBE_HASH}"})
    except HTTPException as e:
        if e.status_code == 451:
            _rd_blocked_until = time.time() + BLOCK_PAUSE_S
            logger.warning("movies: Real-Debrid refuses every add from this server; pausing adds for %d h",
                           BLOCK_PAUSE_S // 3600)
            return True
        return False
    try:
        if (added or {}).get("id"):
            await _rd("DELETE", f"/torrents/delete/{added['id']}")
    except HTTPException:
        pass
    return False


def _chosen(imdb: str, c: dict, tid: str, status: str) -> None:
    logger.info("movies: %s -> %s (%s, %.1f GB, %s)", imdb, c["release"][:80], c["tier"], c["size_gb"], status)
    _set(imdb, status=status, rd_id=tid, release=c["release"][:200], quality=quality_label(c["tier"], c["hdr"]),
         size_gb=c["size_gb"], progress=100 if status == "adding" else 0)


# ── Copying it onto the server ───────────────────────────────────────────────
_wake = asyncio.Event()
_copy_fails: dict[str, int] = {}
COPY_TRIES = 5
_streamed: dict[str, float] = {}    # Jellyfin id -> last time a viewer fetched a piece of it


def _next_copy() -> dict | None:
    """The next film to copy: people's adds before the migration, oldest first."""
    with _conn() as db:
        r = db.execute("SELECT * FROM adds WHERE status = 'copying' ORDER BY migrate, created LIMIT 1").fetchone()
    return dict(r) if r else None


async def _source(r: dict) -> tuple[str, int, str]:
    """(download URL, bytes, file name) of the film's file on Real-Debrid."""
    if not r["rd_id"]:
        raise _Refused("Lost track of its copy on Real-Debrid")
    info = await _rd("GET", f"/torrents/info/{r['rd_id']}") or {}
    if info.get("status") != "downloaded":
        raise _Refused("Real-Debrid doesn't have the whole file any more")
    files = sorted((f for f in info.get("files") or [] if f.get("selected")), key=lambda f: f.get("id") or 0)
    links = list(info.get("links") or [])
    want = r["src_file"]
    idx = next((i for i, f in enumerate(files) if want and (f.get("path") or "").rsplit("/", 1)[-1] == want), None)
    if idx is None and not want:
        vids = [i for i, f in enumerate(files) if _VIDEO_EXT.search(f.get("path") or "")]
        idx = max(vids, key=lambda i: files[i].get("bytes") or 0) if vids else None
    if idx is None or not links:
        raise _Refused("Its file isn't on Real-Debrid any more")
    size = int(files[idx].get("bytes") or 0)
    # Real-Debrid lists one link per selected file, in order; check the size to be sure.
    for i in [idx] + [i for i in range(len(links)) if i != idx]:
        if i >= len(links):
            continue
        u = await _rd("POST", "/unrestrict/link", data={"link": links[i]}) or {}
        if u.get("download") and int(u.get("filesize") or 0) == size:
            return str(u["download"]), size, (files[idx].get("path") or "").rsplit("/", 1)[-1]
    raise _Refused("Real-Debrid wouldn't hand over the file")


def _part(imdb: str) -> Path:
    return LOCAL_DIR / ".incoming" / f"{imdb}.part"


async def _download(url: str, part: Path, size: int, r: dict) -> str:
    """Append the rest of the file to `part`. Returns 'done', 'paused' (a person's add
    jumps the migration queue), 'gone' (removed meanwhile) or 'full' (the disk filled up)."""
    imdb = r["imdb"]
    done = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": _UA}
    if done:
        headers["Range"] = f"bytes={done}-"
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0), follow_redirects=True) as c:
        async with c.stream("GET", url, headers=headers) as resp:
            if done and resp.status_code == 200:
                done = 0        # the server ignored the range: start over
            elif resp.status_code not in (200, 206):
                raise httpx.HTTPStatusError(f"download answered {resp.status_code}", request=resp.request, response=resp)
            f = await asyncio.to_thread(open, part, "ab" if done else "wb")
            try:
                buf = bytearray()
                last = time.monotonic()
                async for chunk in resp.aiter_bytes(1 << 20):
                    buf += chunk
                    if len(buf) < CHUNK:
                        continue
                    await asyncio.to_thread(f.write, bytes(buf))
                    done += len(buf)
                    buf.clear()
                    if time.monotonic() - last < 2:
                        continue
                    last = time.monotonic()
                    _set(imdb, bytes_done=done, progress=round(done * 100 / size, 1) if size else 0)
                    now = _row(imdb)
                    if not now or now["status"] != "copying":
                        return "gone"
                    if r["migrate"] and (nxt := _next_copy()) and not nxt["migrate"]:
                        return "paused"
                    if _room(imdb) < size - done:
                        return "full"
                if buf:
                    await asyncio.to_thread(f.write, bytes(buf))
                    done += len(buf)
                await asyncio.to_thread(f.flush)
                await asyncio.to_thread(os.fsync, f.fileno())
            finally:
                await asyncio.to_thread(f.close)
    _set(imdb, bytes_done=done, progress=round(done * 100 / size, 1) if size else 0)
    return "done"


def _fail_copy(r: dict, msg: str) -> None:
    _part(r["imdb"]).unlink(missing_ok=True)
    _copy_fails.pop(r["imdb"], None)
    _set(r["imdb"], status="failed", error=msg)
    logger.warning("movies: copying %s%s failed: %s", r["title"], " (migration)" if r["migrate"] else "", msg)


async def copy_one(r: dict) -> str:
    """Copy one film from Real-Debrid onto the server's disk. Returns what happened."""
    imdb = r["imdb"]
    if not local_on():
        _set(imdb, status="adding", progress=100)
        return "no-disk"
    folder = r["local_dir"] or folder_name(r["title"], r["year"], imdb)
    # Already there (we were restarted between the rename and the save)?
    if r["local_file"] and r["bytes_total"]:
        final = LOCAL_DIR / folder / r["local_file"]
        if final.is_file() and final.stat().st_size == r["bytes_total"]:
            _set(imdb, status="adding", progress=100, bytes_done=r["bytes_total"], error="")
            return "done"
    try:
        url, size, name = await _source(r)
        part = _part(imdb)
        part.parent.mkdir(exist_ok=True)
        have = part.stat().st_size if part.exists() else 0
        if have > size:
            part.unlink()
            have = 0
        room = _room(imdb)
        if size - have > room:
            _fail_copy(r, _no_room(size - have, room))
            return "full"
        fname = r["local_file"] or _file_name(name, imdb)
        _set(imdb, local_dir=folder, local_file=fname, bytes_total=size, bytes_done=have, error="",
             progress=round(have * 100 / size, 1) if size else 0)
        logger.info("movies: copying %s (%s, %s%s) onto the server", r["title"], _gb(size),
                    f"resuming at {_gb(have)}, " if have else "", "migration" if r["migrate"] else "add")
        out = await _download(url, part, size, r)
    except _Refused as e:
        _fail_copy(r, str(e))
        return "failed"
    except (httpx.HTTPError, HTTPException, OSError) as e:
        if not _row(imdb):
            _part(imdb).unlink(missing_ok=True)
            return "gone"
        n = _copy_fails[imdb] = _copy_fails.get(imdb, 0) + 1
        logger.warning("movies: copying %s hit a snag (%d/%d): %s", r["title"], n, COPY_TRIES,
                       getattr(e, "detail", None) or type(e).__name__)
        if n >= COPY_TRIES:
            _fail_copy(r, "The copy to the server kept failing")
            return "failed"
        return "retry"
    if out == "gone":
        _part(imdb).unlink(missing_ok=True)
        return out
    if out == "full":
        _fail_copy(r, _no_room(size, _room(imdb)))
        return out
    if out == "paused":
        logger.info("movies: pausing the migration of %s for someone's add", r["title"])
        return out
    got = part.stat().st_size
    if got != size:
        _fail_copy(r, f"The copy came out the wrong size ({got} of {size} bytes)")
        return "failed"
    dest = LOCAL_DIR / folder
    dest.mkdir(exist_ok=True)
    final = dest / fname
    os.replace(part, final)            # one rename: Jellyfin never sees half a file
    for p, mode in ((dest, 0o755), (final, 0o644)):
        try:
            os.chmod(p, mode)
            os.chown(p, LOCAL_UID, LOCAL_UID)
        except OSError:
            pass
    _copy_fails.pop(imdb, None)
    _set(imdb, status="adding", progress=100, bytes_done=size, error="")
    logger.info("movies: %s is on the server (%s)", r["title"], _gb(size))
    global _last_scan
    _last_scan = 0.0
    return "done"


async def copy_worker() -> None:
    """One copy at a time, for as long as the app runs. Picks up after a restart."""
    while True:
        wait = 10.0
        try:
            r = _next_copy()
            if r:
                out = await copy_one(r)
                wait = {"retry": 60.0, "done": 0.0, "paused": 0.0, "gone": 0.0}.get(out, 1.0)
                if out == "done":
                    await tick(force=True)
        except Exception:  # noqa: BLE001
            logger.exception("movies: the copy worker tripped")
            wait = 60.0
        if wait:
            _wake.clear()
            try:
                await asyncio.wait_for(_wake.wait(), wait)
            except asyncio.TimeoutError:
                pass


# ── Moving the films that are only on Real-Debrid ────────────────────────────
async def migrate_existing() -> int:
    """Queue every film that's only on Real-Debrid for a silent copy onto the server.
    Once: the flag lands in meta. Returns how many were queued."""
    if not (MIGRATE and RD_TOKEN and local_on()):
        return 0
    with _conn() as db:
        if db.execute("SELECT 1 FROM meta WHERE key = 'migrated'").fetchone():
            return 0
    cards = await jellyfin_movies(refresh=True)
    if not cards:
        return 0    # Jellyfin had a blip; try again next start
    torrents = [t for t in await _rd("GET", "/torrents", params={"limit": "2500"}) or [] if isinstance(t, dict)]
    queued = 0
    now = time.time()
    for c in cards:
        if not c["imdb"] or any(_is_local(v["path"]) for v in c["versions"]) or not c["path"].startswith("/zurg/"):
            continue
        names = set(_rd_dir(c["path"])) - {""}
        tid = next((str(t["id"]) for t in torrents if t.get("filename") in names and t.get("status") == "downloaded"), "")
        if not tid:
            logger.warning("movies: migration: couldn't find %s on Real-Debrid", c["title"])
            continue
        fname = _rd_dir(c["path"])[1]
        with _lock, _conn() as db:
            if db.execute("SELECT 1 FROM adds WHERE imdb = ?", (c["imdb"],)).fetchone():
                db.execute("""UPDATE adds SET status='copying', migrate=1, rd_id=?, src_file=?, progress=0,
                              bytes_done=0, bytes_total=0, local_dir='', local_file='', error='', updated=?
                              WHERE imdb=?""", (tid, fname, now, c["imdb"]))
            else:
                db.execute("""INSERT INTO adds (imdb, title, year, sub, name, status, rd_id, src_file, quality,
                              migrate, created, updated) VALUES (?,?,?,'','','copying',?,?,?,1,?,?)""",
                           (c["imdb"], c["title"], c["year"], tid, fname, c["quality"], now, now))
        queued += 1
        logger.info("movies: migration: queued %s", c["title"])
    with _lock, _conn() as db:
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated', ?)", (str(int(now)),))
    _wake.set()
    return queued


# ── Following adds until they're in Jellyfin ─────────────────────────────────
_last_tick = 0.0
_last_scan = 0.0


def pending() -> list[dict]:
    with _conn() as db:
        return [dict(r) for r in db.execute("SELECT * FROM adds WHERE status IN ('finding','downloading','adding')")]


async def _playing(ids: set[str]) -> bool:
    """Is anyone watching one of these Jellyfin items right now? Unsure counts as yes."""
    if any(time.time() - _streamed.get(i, 0) < 180 for i in ids):
        return True
    try:
        sessions = slap._ok(await slap._jf("GET", "/Sessions", params={"ActiveWithinSeconds": "300"})) or []
    except Exception:  # noqa: BLE001
        return True
    return any(((s.get("NowPlayingItem") or {}).get("Id") or "") in ids for s in sessions if isinstance(s, dict))


async def _rd_ids(versions: list[dict], rd_id: str = "") -> set[str]:
    """The Real-Debrid torrents behind these Zurg versions (plus the one we added)."""
    want = {n for v in versions for n in _rd_dir(v["path"]) if n}
    ids = {rd_id} if rd_id else set()
    if want:
        torrents = await _rd("GET", "/torrents", params={"limit": "2500"}) or []
        ids |= {str(t["id"]) for t in torrents if isinstance(t, dict) and t.get("filename") in want}
    return ids


async def _settle(r: dict, card: dict, mine: dict) -> bool:
    """Jellyfin has the local copy: drop the Real-Debrid one(s), so only the local one is left."""
    debrid = [v for v in card["versions"] if v["path"].startswith("/zurg/")]
    if debrid and await _playing({v["id"] for v in debrid}):
        logger.info("movies: %s is playing from Real-Debrid; deleting it there later", r["title"])
        return False
    ids = await _rd_ids(debrid, r["rd_id"])
    for tid in ids:
        try:
            await _rd("DELETE", f"/torrents/delete/{tid}")
        except HTTPException:
            logger.info("movies: a Real-Debrid copy of %s was already gone", r["title"])
    now = time.time()
    with _lock, _conn() as db:
        db.executemany("INSERT OR REPLACE INTO removed (jf_id, ts) VALUES (?, ?)", [(v["id"], now) for v in debrid])
    _set(r["imdb"], status="ready", jf_id=mine["id"], progress=100, quality=card["quality"] or r["quality"], rd_id="")
    _cache.pop("jf:movies", None)
    logger.info("movies: %s is ready from the server's disk (%d Real-Debrid copies deleted)", r["title"], len(ids))
    if debrid or ids:
        _spawn(_rescan_later())
    if not r["migrate"]:
        await _announce_ready(r)
    return True


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
                nxt = _after_rd()
                _set(r["imdb"], status=nxt, progress=100 if nxt == "adding" else 0)
                _wake.set()
            elif st in ("error", "magnet_error", "virus", "dead"):
                _set(r["imdb"], status="failed", error="Real-Debrid couldn't finish the download")
            else:
                _set(r["imdb"], progress=float(info.get("progress") or 0))
    adding = [r for r in pending() if r["status"] == "adding"]
    if not adding:
        return 0
    have = {m["imdb"]: m for m in await jellyfin_movies(refresh=True) if m["imdb"]}
    waiting = False
    for r in adding:
        hit = have.get(r["imdb"])
        if r["local_dir"]:
            mine = next((v for v in (hit or {}).get("versions", [])
                         if v["path"].startswith(f"{JF_LOCAL}/{r['local_dir']}/")), None)
            if mine:
                if await _settle(r, hit, mine):
                    ready += 1
                continue
        elif hit:
            _set(r["imdb"], status="ready", jf_id=hit["id"], quality=hit["quality"] or r["quality"])
            ready += 1
            if not r["migrate"]:
                await _announce_ready(r)
            continue
        waiting = True
        if time.time() - r["updated"] > ADDING_GIVE_UP_S:
            _set(r["imdb"], status="failed", error="Jellyfin didn't pick it up")
    # Zurg lists a new file within seconds, and the copy lands in one rename; Jellyfin needs telling.
    if waiting and time.time() - _last_scan > 60:
        _last_scan = time.time()
        try:
            await _rescan()
        except HTTPException as e:
            logger.info("movies: rescan failed: %s", e.detail)
    return ready


async def loop() -> None:
    await asyncio.sleep(30)
    _spawn(copy_worker())
    if MIGRATE:
        try:
            n = await migrate_existing()
            if n:
                logger.info("movies: migration: %d films to copy onto the server", n)
        except Exception as e:  # noqa: BLE001
            logger.warning("movies: migration couldn't start: %s", e)
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


def _removable(card: dict) -> bool:
    return _on_debrid(card) or any(_managed(v["path"], card["imdb"]) for v in card["versions"])


async def library(sub: str = "", admin: bool = False) -> dict:
    cards = await jellyfin_movies()
    with _conn() as db:
        rows = [dict(r) for r in db.execute(
            "SELECT * FROM adds WHERE status != 'ready' AND migrate = 0 AND updated > ? ORDER BY created DESC",
            (time.time() - 7 * 86400,))]
        added = {r["imdb"]: (r["name"], r["sub"]) for r in db.execute(
            "SELECT imdb, name, sub FROM adds WHERE status = 'ready' OR migrate = 1")}
    movies = []
    for c in cards:
        name, by_sub = added.get(c["imdb"], ("", ""))
        movies.append({**{k: v for k, v in c.items() if k not in ("path", "versions")}, "by": name,
                       "can_remove": _removable(c) and (admin or (bool(sub) and by_sub == sub))})
    return {"movies": movies, "adding": [_public(r) for r in rows], "can_add": bool(RD_TOKEN)}


def _rd_dir(path: str) -> tuple[str, str]:
    """/zurg/movies/<torrent folder>/<file> -> (folder, file)."""
    parts = path.split("/")
    return (parts[3] if len(parts) > 4 else "", parts[-1])


def _rmtree(folder: str) -> bool:
    """Delete one folder directly under LOCAL_DIR, and nothing else."""
    p = LOCAL_DIR / folder
    if not folder or "/" in folder or folder in (".", "..") or p.resolve().parent != LOCAL_DIR.resolve():
        return False
    if p.is_dir():
        shutil.rmtree(p)
        return True
    return False


async def remove(sub: str, jf_id: str, *, admin: bool = False) -> dict:
    """Take a film out of the library: delete its Real-Debrid copies and its folder on the
    server's disk. Returns how many copies went."""
    if not _JF_ID.match(jf_id or ""):
        raise HTTPException(404, "not found")
    card = next((c for c in await jellyfin_movies(refresh=True) if jf_id in {v["id"] for v in c["versions"]}), None)
    if not card:
        raise HTTPException(404, "that movie isn't in the library")
    row = _row(card["imdb"]) if card["imdb"] else None
    if not (admin or (row and row["sub"] == sub)):
        raise HTTPException(403, "only the person who added it, or an admin, can remove it")
    debrid = [v for v in card["versions"] if v["path"].startswith("/zurg/")]
    local = [v for v in card["versions"] if _managed(v["path"], card["imdb"])]
    if not debrid and not local:
        raise HTTPException(400, "this one is on the server's own disk, so it can't be removed here")
    ids = await _rd_ids(debrid, row["rd_id"] if row else "") if debrid or (row and row["rd_id"]) else set()
    if debrid and not ids and not local:
        raise HTTPException(404, "couldn't find its copy on Real-Debrid")
    for tid in ids:
        try:
            await _rd("DELETE", f"/torrents/delete/{tid}")
        except HTTPException:
            logger.info("movies: a copy of %s was already gone", card["title"])
    folders = {_local_folder(v["path"]) for v in local}
    gone = sum([await asyncio.to_thread(_rmtree, f) for f in sorted(folders)]) if local_on() else 0
    now = time.time()
    with _lock, _conn() as db:
        db.executemany("INSERT OR REPLACE INTO removed (jf_id, ts) VALUES (?, ?)",
                       [(v["id"], now) for v in debrid + local])
        if card["imdb"]:
            db.execute("DELETE FROM adds WHERE imdb = ?", (card["imdb"],))
    if card["imdb"]:
        _part(card["imdb"]).unlink(missing_ok=True)
    _cache.pop("jf:movies", None)
    logger.info("movies: %s removed %s (%d Real-Debrid copies, %d folders on the server)",
                "admin" if admin and not (row and row["sub"] == sub) else "adder", card["title"], len(ids), gone)
    _spawn(_rescan_later())
    return {"title": card["title"], "removed": len(ids) + gone}


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
              "on_server_disk": bool(r["local_dir"]) and r["status"] == "ready", "migrating": bool(r["migrate"]),
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

    @router.get("/home")
    async def home_get(request: Request, genre: str = ""):
        caller_sub(request)
        return await home(genre)

    @router.get("/catalog")
    async def catalog_get(request: Request, kind: str = "popular", genre: str = "", skip: int = 0):
        caller_sub(request)
        return {"results": await annotate(await catalog(kind, genre, skip)), "next": skip + PAGE}

    @router.get("/meta/{imdb}")
    async def details_get(imdb: str, request: Request):
        sub = caller_sub(request)
        d = await details(imdb)
        state = (await annotate([d]))[0]
        lib = await library(sub, await is_admin(sub))
        card = next((m for m in lib["movies"] if m["imdb"] == imdb), None)
        adding = next((a for a in lib["adding"] if a["imdb"] == imdb), None)
        return {**state, "can_add": lib["can_add"], "by": (card or adding or {}).get("by", ""),
                "can_remove": bool(card and card["can_remove"]), "library_quality": (card or {}).get("quality", ""),
                "adding": adding}

    @router.get("/now")
    async def now_get(request: Request, room: str = "crcmz"):
        caller_sub(request)
        import watch as watch_mod
        room = watch_mod.canonical_room(room) or "crcmz"
        return now_playing(room)

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
        _streamed[jf_id] = time.time()   # so the migration never pulls a copy out from under a party
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


__all__ = ["add", "annotate", "build_router", "remove", "configured", "copy_one", "copy_worker", "fetch", "folder_name",
           "hls_request", "history_meta", "library", "local_on", "loop", "migrate_existing", "overview", "popular", "rank",
           "search", "stream_url", "tick"]
