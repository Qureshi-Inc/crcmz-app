"""Share → CRCMZ: what a shared link is, and what to offer to do with it.

The phones' share sheets (Android, the iPhone app's share extension) and the installed
web app send a link here (POST /api/share/inspect) before doing anything:

    song     Spotify, Apple Music, YouTube Music, SoundCloud, Deezer, Tidal: added to
             Slap straight away (auto = "slap"), with Undo.
    movie    a film's page (IMDb, Letterboxd, Netflix, Apple TV, Google, cinejoy.to…):
             the film is found in the catalogue and added to Movies straight away
             (auto = "movie", with Undo); when it's not clear which film, pick one.
    trailer  a YouTube video whose title says trailer / teaser and names a film we can
             find: the one case that asks: add that film, or play the trailer.
    video    TikTok, Snapchat, Facebook, Instagram, X, YouTube, a video file, any other
             page: played in the Watch Party straight away (auto = "watch").

Videos from the camera roll aren't links: the apps upload those to Clips themselves.
The decision lives here, not in the apps, so it can get smarter without an app update.
"""

from __future__ import annotations

import logging
import re
import time

import httpx

import safe_fetch

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


# Pages that are about one film: a movie link there means "get this film".
_MOVIE_SITES = re.compile(
    r"^https://([\w-]+\.)*(letterboxd\.com|boxd\.it|themoviedb\.org|rottentomatoes\.com|justwatch\.com|netflix\.com|"
    r"tv\.apple\.com|primevideo\.com|amazon\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|disneyplus\.com|max\.com|hbomax\.com|hulu\.com|"
    r"paramountplus\.com|peacocktv\.com|cinejoy\.to|google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|g\.co|bing\.com|metacritic\.com|trakt\.tv|"
    r"fandango\.com|wikipedia\.org)/", re.I)
# Short videos and posts: always for the Watch Party.
_SHORTS = re.compile(
    r"^https://([\w-]+\.)*(tiktok\.com|snapchat\.com|facebook\.com|fb\.watch|instagram\.com|x\.com|twitter\.com|"
    r"threads\.net|reddit\.com|redd\.it|twitch\.tv|vimeo\.com|dailymotion\.com|streamable\.com|kick\.com)/", re.I)
_TT = re.compile(r"\b(tt\d{7,8})\b")
# What sites add to a film's page title.
_SITE_SUFFIX = re.compile(r"\s*[|\-–—:]\s*(netflix|apple tv\+?|prime video|amazon\.com.*|disney\+|max|hulu|letterboxd|"
                          r"rotten tomatoes|the movie database.*|tmdb|justwatch|metacritic|trakt|google search|wikipedia|"
                          r"watch .*|stream .*|official site|fandango|cinejoy.*)\s*$", re.I)
_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"


async def page_info(url: str) -> dict:
    """A page's title, og:type and any IMDb id in it (Letterboxd and many others link IMDb)."""
    try:
        # Someone else's link: never into our own network, redirects included.
        async with safe_fetch.client(timeout=8, follow_redirects=True, headers={"User-Agent": _UA}) as c:
            r = await c.get(url)
        html = r.text[:400_000] if r.status_code < 400 else ""
        final = str(r.url)
    except httpx.HTTPError:
        html, final = "", url
    def meta(prop: str) -> str:
        m = re.search(rf'<meta[^>]+(?:property|name)=["\']{prop}["\'][^>]*content=["\']([^"\']+)', html, re.I) \
            or re.search(rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']{prop}["\']', html, re.I)
        return _unescape(m.group(1)) if m else ""
    t = re.search(r"<title[^>]*>([^<]+)</title>", html, re.I)
    return {"url": final, "title": meta("og:title") or (_unescape(t.group(1)) if t else ""), "type": meta("og:type"),
            "imdb": (_TT.search(html) or _TT.search(final) or [None, ""])[1] if html or final else ""}


def _unescape(s: str) -> str:
    import html as _html
    return re.sub(r"\s+", " ", _html.unescape(s)).strip()[:300]


def title_from_url(url: str) -> str:
    """A film's name from the address itself: Google's ?q=, or the page's slug."""
    from urllib.parse import parse_qs, unquote, urlparse
    u = urlparse(url)
    if (q := parse_qs(u.query).get("q")) and q[0].strip():
        return q[0][:120]
    parts = [p for p in u.path.split("/") if p]
    for i, p in enumerate(parts):
        if p.lower() in ("movie", "movies", "film", "title", "watch", "m", "detail") and i + 1 < len(parts):
            slug = parts[i + 1]
            if not re.fullmatch(r"[\d]+|umc\.\S+|[A-Z0-9]{8,}", slug):
                return re.sub(r"^\d+-", "", unquote(slug)).replace("-", " ").replace("_", " ")[:120]
    return ""


async def find_movie(link: str, hint: str = "") -> tuple[dict | None, bool, list[dict]]:
    """The film a page is about: (best match, sure?, other likely ones). `hint` is the
    title the share sheet sent with the link (the page's own title in the browser):
    sites that build their page in the browser (cinejoy.to) show the server nothing else."""
    info = await page_info(link)
    if info["imdb"]:
        try:
            if row := await movies.meta(info["imdb"]):
                return row, True, []
        except Exception:  # noqa: BLE001
            pass
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())  # noqa: E731
    # A search page's ?q= says it best; then the page's own title, then its address.
    from urllib.parse import parse_qs, urlparse
    asked = (parse_qs(urlparse(link).query).get("q") or [""])[0]
    # (A search page's own title is "Google Search": with a ?q=, that's all there is.)
    for raw in ((asked,) if asked else (hint, info["title"], title_from_url(info["url"]), title_from_url(link))):
        if not raw:
            continue
        name = _SITE_SUFFIX.sub("", raw)
        year = m.group(1) if (m := re.search(r"\b(19[2-9]\d|20[0-4]\d)\b", name)) else ""
        q = re.sub(r"\s+", " ", re.sub(r"[\(\[]?\b(19[2-9]\d|20[0-4]\d)\b[\)\]]?", " ", name)).strip(" -|:")
        q = re.sub(r"\b(watch|stream|streaming|online|free|full|hd|movie|film|where to watch)\b", " ", q, flags=re.I)
        q = re.sub(r"\s+", " ", q).strip(" -|:")
        if len(q) < 2:
            continue
        try:
            rows = await movies.search(q)
        except Exception:  # noqa: BLE001
            rows = []
        if not rows:
            continue
        exact = [r for r in rows if norm(r["title"]) == norm(q)]
        if year:
            for r in exact + rows[:3]:
                if r.get("year") == year:
                    return r, r in exact, [x for x in rows[:3] if x is not r]
        if len(exact) == 1:
            return exact[0], True, rows[:3]
        # Unsure: only films whose name is in what was shared (a site's home page isn't a film).
        close = exact or [r for r in rows[:5] if norm(r["title"]) and (norm(r["title"]) in norm(q) or norm(q) in norm(r["title"]))]
        if close:
            return close[0], False, close[1:4]
    return None, False, []


async def inspect(url: str = "", text: str = "", title: str = "") -> dict:
    """What a shared link is, and what to do. `auto` is done without asking (with Undo);
    `choices` are offered when it isn't clear."""
    link = first_link(url, text, title)
    # What the share sheet said about the page, minus the link itself.
    hint = re.sub(r"\s+", " ", _LINK.sub(" ", f"{title} {text}")).strip()[:200]
    out: dict = {"link": link, "kind": "none", "auto": None, "movie": None, "candidates": [], "video_title": "", "choices": []}
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
            out.update(kind="movie", auto="movie", movie=await _movie_card(row), choices=["movie"])
            return out
    if _YOUTUBE.match(link):
        vt = await youtube_title(link)
        out["video_title"] = vt
        # A trailer is the one case that's unclear: the film, or the trailer itself?
        if vt and _TRAILER.search(vt) and (row := await guess_movie(vt)):
            out.update(kind="trailer", movie=await _movie_card(row), choices=["movie", "watch"])
            return out
        out.update(kind="video", auto="watch", choices=["watch", "slap"])
        return out
    if _SHORTS.match(link):
        out.update(kind="video", auto="watch", choices=["watch"])
        return out
    if _MOVIE_SITES.match(link):
        row, sure, others = await find_movie(link, hint)
        if row:
            card = await _movie_card(row)
            if sure:
                out.update(kind="movie", auto="movie", movie=card, choices=["movie"])
            else:
                # Not sure which film: pick from the likely ones.
                out.update(kind="movie", movie=card, choices=["movie"],
                           candidates=[await _movie_card(r) for r in others])
            return out
        # A film site, but we can't tell which film: look for it in Movies.
        out.update(kind="movie", choices=["search"], video_title=_SITE_SUFFIX.sub("", hint) or title_from_url(link))
        return out
    # Any other page: a film's page (og:type video.movie) or something to play.
    info = await page_info(link)
    if info["type"].lower() == "video.movie" or info["imdb"]:
        row, sure, others = await find_movie(link, hint)
        if row:
            card = await _movie_card(row)
            out.update(kind="movie", auto="movie" if sure else None, movie=card, choices=["movie"],
                       candidates=[] if sure else [await _movie_card(r) for r in others])
            return out
    out.update(kind="video", auto="watch", video_title=info["title"], choices=["watch"])
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
