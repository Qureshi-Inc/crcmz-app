"""Share → CRCMZ: what a shared link is, and what to offer to do with it.

The phones' share sheets (Android, the iPhone app's share extension) and the installed
web app send a link here (POST /api/share/inspect) before doing anything:

    song     Spotify, Apple Music, YouTube Music, SoundCloud, Deezer, Tidal: added to
             Slap straight away (auto = "slap"), with Undo.
    movie    an IMDb page: add the film to Movies (4K / 1080p when both exist), or
             watch it together if it's already in.
    trailer  a YouTube video whose title says trailer / teaser and names a film we can
             find: add that film, or play the trailer in the Watch Party.
    video    anything else that plays (YouTube, a video file, a page with a video): the
             Watch Party; a YouTube video can also go to Slap (a music video).

Videos from the camera roll aren't links: the apps upload those to Clips themselves.
The decision lives here, not in the apps, so it can get smarter without an app update.
"""

from __future__ import annotations

import logging
import re
import time

import httpx

import movies

logger = logging.getLogger(__name__)

_LINK = re.compile(r"https?://\S+", re.I)
_SONG = re.compile(r"^https://(music\.apple\.com|open\.spotify\.com|music\.youtube\.com|soundcloud\.com|"
                   r"(www\.)?deezer\.com|tidal\.com|listen\.tidal\.com)/", re.I)
_YOUTUBE = re.compile(r"^https://((www|m)\.)?(youtube\.com/(watch|shorts/|live/)|youtu\.be/)", re.I)
_IMDB = re.compile(r"^https://(www\.|m\.)?imdb\.com/title/(tt\d{5,10})", re.I)
_TRAILER = re.compile(r"\b(trailer|teaser)\b", re.I)
# What a trailer title adds around the film's name.
_NOISE = re.compile(
    r"\b(official|final|new|main|extended|special|launch|theatrical|character|hd|4k|uhd|1080p|teaser|trailer|red band|restricted|international|"
    r"exclusive|first look|sneak peek|clip|full|movie|film|imax|dolby|in cinemas|now playing|"
    r"#?\d(st|nd|rd|th)?)\b", re.I)


def first_link(*parts: str) -> str:
    for p in parts:
        if m := _LINK.search(p or ""):
            return m.group(0).rstrip(").,;!?'\"]")
    return ""


async def youtube_title(url: str) -> str:
    """A YouTube video's title (oEmbed: no key, no quota)."""
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as c:
            r = await c.get("https://www.youtube.com/oembed", params={"url": url, "format": "json"})
        return str(r.json().get("title") or "")[:200] if r.status_code == 200 else ""
    except (httpx.HTTPError, ValueError):
        return ""


def trailer_query(title: str) -> tuple[str, str]:
    """'Heat (1995) Official Trailer #1 - Al Pacino Movie HD' -> ('Heat', '1995')."""
    year = ""
    if m := re.search(r"\b(19[2-9]\d|20[0-4]\d)\b", title):
        year = m.group(1)
    t = title.split("|")[0]
    # The film's name is what comes before the trailer words: "Heat (1995) Official
    # Trailer - Al Pacino", or the part before them, "DUNE - Official Main Trailer".
    parts = [p for p in re.split(r"\s+[-–—:]\s+", t) if p.strip()]
    for i, p in enumerate(parts):
        if m := _TRAILER.search(p):
            before = _NOISE.sub(" ", re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", p[:m.start()])).strip(" -")
            t = before if len(before) >= 2 else (parts[i - 1] if i > 0 else p)
            break
    t = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", t)      # (1995), [HD]
    t = _NOISE.sub(" ", t)
    t = re.sub(r"\b(19[2-9]\d|20[0-4]\d)\b", " ", t)
    t = re.sub(r"[^\w'&.!? ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip(" .-"), year


async def guess_movie(title: str) -> dict | None:
    """The film a trailer is for, or None when we can't tell."""
    q, year = trailer_query(title)
    if len(q) < 2:
        return None
    try:
        rows = await movies.search(q)
    except Exception as e:  # noqa: BLE001 (the catalogue being down just means no guess)
        logger.info("share: movie search for %r failed: %s", q, e)
        return None
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())  # noqa: E731
    exact = [r for r in rows if norm(r["title"]) == norm(q)]
    if year:
        for r in exact + rows[:3]:
            if r.get("year") == year:
                return r
    return exact[0] if exact else None


async def _movie_card(row: dict) -> dict:
    have = (await movies.library_index()).get(row["imdb"])
    return {"imdb": row["imdb"], "title": row["title"], "year": row.get("year", ""), "poster": row.get("poster", ""),
            "in_library": bool(have)}


async def inspect(url: str = "", text: str = "", title: str = "") -> dict:
    link = first_link(url, text, title)
    out: dict = {"link": link, "kind": "none", "auto": None, "movie": None, "video_title": "", "choices": []}
    if not link:
        return out
    if _SONG.match(link):
        out.update(kind="song", auto="slap", choices=["slap", "watch"])
        return out
    if m := _IMDB.match(link):
        try:
            row = await movies.meta(m.group(2))
        except Exception:  # noqa: BLE001
            row = None
        if row and row.get("imdb"):
            out.update(kind="movie", movie=await _movie_card(row), choices=["movie"])
            return out
    if _YOUTUBE.match(link):
        vt = await youtube_title(link)
        out["video_title"] = vt
        if vt and _TRAILER.search(vt) and (row := await guess_movie(vt)):
            out.update(kind="trailer", movie=await _movie_card(row), choices=["movie", "watch"])
            return out
        out.update(kind="video", choices=["watch", "slap"])
        return out
    out.update(kind="video", choices=["watch"])
    return out


# The iPhone's share extension can't open the app: "Play in the Watch Party" leaves the
# link here, and the app picks it up the next time it opens (GET /api/share/pending).
_pending: dict[str, tuple[str, float]] = {}
PENDING_S = 15 * 60


def leave_for_app(sub: str, url: str) -> bool:
    if not sub or not _LINK.match(url or ""):
        return False
    _pending[sub] = (url[:2000], time.time())
    return True


def take_for_app(sub: str) -> str:
    url, at = _pending.pop(sub, ("", 0.0))
    return url if time.time() - at < PENDING_S else ""
