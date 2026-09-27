"""Watch Party history: what was watched, by whom, and where it was left off.

Two tables:

* ``watch_items``    — one row per video URL, with metadata looked up from free,
                        keyless sources (YouTube oEmbed, Wikipedia, TVmaze, iTunes).
* ``watch_progress`` — one row per (Zitadel sub, video URL): last position,
                        duration, room, and when it was last watched.

Playback position lives here, not in ``watchparty_events`` (that store is for
semantic events only).

DB: /data/watch_history.db
"""

from __future__ import annotations

import html
import logging
import re
import sqlite3
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/watch_history.db")
_lock = threading.Lock()

# Treat a video as finished once you're this close to the end.
_FINISHED_TAIL_S = 120
_FINISHED_FRAC = 0.95
# Metadata lookups that found nothing are retried after this long.
_META_RETRY_S = 6 * 3600

_UA = "crcmz-app/1.0 (https://app.crcmz.me; watch-history)"


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS watch_items (
                url             TEXT PRIMARY KEY,
                source_url      TEXT,
                title_hint      TEXT,
                kind            TEXT,
                title           TEXT,
                year            TEXT,
                description     TEXT,
                overview        TEXT,
                poster          TEXT,
                genres          TEXT,
                meta_source     TEXT,
                meta_url        TEXT,
                meta_fetched_at REAL,
                first_seen      REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS watch_progress (
                user_id      TEXT NOT NULL,
                url          TEXT NOT NULL,
                display_name TEXT,
                room         TEXT,
                position     REAL NOT NULL DEFAULT 0,
                duration     REAL,
                finished     INTEGER NOT NULL DEFAULT 0,
                started_at   REAL NOT NULL,
                updated_at   REAL NOT NULL,
                PRIMARY KEY (user_id, url)
            );
            CREATE INDEX IF NOT EXISTS idx_wh_progress_user
                ON watch_progress(user_id, updated_at);
            CREATE INDEX IF NOT EXISTS idx_wh_progress_room
                ON watch_progress(room, updated_at);
        """)
        db.commit()
    logger.info("watch_history: DB ready at %s", _DB_PATH)


# ── writes ───────────────────────────────────────────────────────────────────


def _clean_url(url: str) -> str:
    url = (url or "").strip()
    if not url or len(url) > 4000:
        return ""
    if not (url.startswith("http://") or url.startswith("https://")
            or url.startswith("/api/watch/proxy?")):
        return ""
    return url


def record_progress(
    *,
    user_id: str,
    url: str,
    position: float,
    duration: float | None = None,
    room: str = "",
    display_name: str = "",
    title_hint: str = "",
    source_url: str = "",
) -> bool:
    """Upsert one viewer's position in one video. Returns False if rejected."""
    url = _clean_url(url)
    if not user_id or not url:
        return False
    try:
        pos = max(0.0, float(position or 0))
    except (TypeError, ValueError):
        pos = 0.0
    try:
        dur = float(duration) if duration else None
    except (TypeError, ValueError):
        dur = None
    if dur is not None and (dur <= 0 or dur != dur or dur > 86400 * 2):
        dur = None  # live streams report Infinity / junk
    if dur:
        pos = min(pos, dur)
    finished = int(bool(dur and (pos >= dur * _FINISHED_FRAC
                                 or dur - pos <= min(_FINISHED_TAIL_S, dur * 0.1))))
    source_url = _clean_url(source_url) if source_url else ""
    title_hint = (title_hint or "").strip()[:200]
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            """INSERT INTO watch_items (url, source_url, title_hint, first_seen)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(url) DO UPDATE SET
                 source_url = COALESCE(NULLIF(excluded.source_url, ''), watch_items.source_url),
                 title_hint = COALESCE(NULLIF(excluded.title_hint, ''), watch_items.title_hint)""",
            (url, source_url or None, title_hint or None, now),
        )
        db.execute(
            """INSERT INTO watch_progress
                 (user_id, url, display_name, room, position, duration, finished,
                  started_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, url) DO UPDATE SET
                 display_name = excluded.display_name,
                 room = excluded.room,
                 position = excluded.position,
                 duration = COALESCE(excluded.duration, watch_progress.duration),
                 finished = excluded.finished,
                 updated_at = excluded.updated_at""",
            (user_id, url, (display_name or "")[:64], (room or "")[:64], pos, dur,
             finished, now, now),
        )
        db.commit()
    return True


def needs_meta(url: str) -> bool:
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT title, meta_fetched_at FROM watch_items WHERE url = ?", (url,)
        ).fetchone()
    if not row:
        return False
    if row["title"]:
        return False
    return not row["meta_fetched_at"] or time.time() - row["meta_fetched_at"] > _META_RETRY_S


def _save_meta(url: str, meta: dict) -> None:
    with _lock, _conn() as db:
        db.execute(
            """UPDATE watch_items SET kind=?, title=?, year=?, description=?, overview=?,
                 poster=?, genres=?, meta_source=?, meta_url=?, meta_fetched_at=?
               WHERE url = ?""",
            (meta.get("kind"), meta.get("title"), meta.get("year"),
             meta.get("description"), meta.get("overview"), meta.get("poster"),
             meta.get("genres"), meta.get("source"), meta.get("meta_url"),
             time.time(), url),
        )
        db.commit()


def delete_for_user(user_id: str, url: str) -> bool:
    """Forget one entry from a viewer's own history."""
    with _lock, _conn() as db:
        cur = db.execute("DELETE FROM watch_progress WHERE user_id = ? AND url = ?",
                         (user_id, url))
        db.commit()
    return cur.rowcount > 0


# ── reads ────────────────────────────────────────────────────────────────────

# Allowlisted projection: nothing here is a secret, but keep the shape explicit.
_ITEM_FIELDS = ("url", "source_url", "kind", "title", "year", "description",
                "overview", "poster", "genres", "meta_source", "meta_url")


def _item(row: sqlite3.Row) -> dict:
    d = {k: row[k] for k in _ITEM_FIELDS}
    d["title"] = d["title"] or row["title_hint"] or guess_title(row["url"])
    return d


def list_history(*, room: str | None = None, user_id: str | None = None,
                 limit: int = 20, include_finished: bool = True) -> list[dict]:
    """Videos, most recently watched first, each with who watched and where
    everyone left off. Filter to one room and/or one viewer (Zitadel sub)."""
    limit = max(1, min(int(limit or 20), 100))
    where, args = [], []
    if room:
        where.append("p.room = ?")
        args.append(room)
    if user_id:
        where.append("p.user_id = ?")
        args.append(user_id)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with _lock, _conn() as db:
        urls = db.execute(
            f"""SELECT p.url, MAX(p.updated_at) AS last FROM watch_progress p
                {clause} GROUP BY p.url ORDER BY last DESC LIMIT ?""",
            (*args, limit * 2 if not include_finished else limit),
        ).fetchall()
        out = []
        for u in urls:
            item = db.execute("SELECT * FROM watch_items WHERE url = ?", (u["url"],)).fetchone()
            if not item:
                continue
            prog_where = ["url = ?"] + (["room = ?"] if room else [])
            prog_args = [u["url"]] + ([room] if room else [])
            viewers = db.execute(
                f"""SELECT user_id, display_name, room, position, duration, finished,
                           started_at, updated_at
                    FROM watch_progress WHERE {' AND '.join(prog_where)}
                    ORDER BY updated_at DESC""",
                prog_args,
            ).fetchall()
            latest = viewers[0] if viewers else None
            mine = next((v for v in viewers if user_id and v["user_id"] == user_id), None)
            ref = mine or latest
            if not include_finished and ref and ref["finished"]:
                continue
            d = _item(item)
            d.update({
                "last_watched_at": u["last"],
                "room": latest["room"] if latest else None,
                "position": ref["position"] if ref else 0,
                "duration": ref["duration"] if ref else None,
                "finished": bool(ref["finished"]) if ref else False,
                "viewers": [{
                    "user_id": v["user_id"],
                    "name": v["display_name"] or "",
                    "position": v["position"],
                    "finished": bool(v["finished"]),
                    "updated_at": v["updated_at"],
                } for v in viewers],
            })
            out.append(d)
            if len(out) >= limit:
                break
    return out


def resume_point(url: str, *, user_id: str | None = None, room: str | None = None) -> dict | None:
    """Where to pick `url` back up: the viewer's own spot, else the room's latest."""
    with _lock, _conn() as db:
        row = None
        if user_id:
            row = db.execute(
                "SELECT position, duration, finished, updated_at FROM watch_progress "
                "WHERE user_id = ? AND url = ?", (user_id, url)).fetchone()
        if not row:
            q = "SELECT position, duration, finished, updated_at FROM watch_progress WHERE url = ?"
            a: list = [url]
            if room:
                q += " AND room = ?"
                a.append(room)
            row = db.execute(q + " ORDER BY updated_at DESC LIMIT 1", a).fetchone()
    return dict(row) if row else None


# ── metadata (free, keyless sources) ─────────────────────────────────────────

_YT_RE = re.compile(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/)|youtu\.be/)([\w-]{11})")
_EP_RE = re.compile(r"\bS(\d{1,2})\s*E(\d{1,3})\b|\b(\d{1,2})x(\d{2})\b", re.I)
_YEAR_RE = re.compile(r"(?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)")
_JUNK_RE = re.compile(
    r"\b(2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|bluray|blu-ray|brrip|bdrip|web-?dl|"
    r"web-?rip|webrip|hdtv|dvdrip|x26[45]|h\.?26[45]|hevc|avc|aac\d?(\.\d)?|ac3|dts|"
    r"ddp?\d?(\.\d)?|atmos|10bit|remux|proper|repack|extended|unrated|imax|"
    r"yts(\.\w+)?|yify|rarbg|amzn|nf|dsnp|hmax|atvp)\b.*$", re.I)


def guess_title(url: str, hint: str = "") -> str:
    """A human title from a hint or from the URL's file name."""
    if hint and hint.strip():
        return hint.strip()[:200]
    try:
        u = urlparse(url)
        raw = (parse_qs(u.query).get("url") or [u.path])[0]
        raw = unquote(unquote(raw)).split("?")[0].rstrip("/").split("/")[-1]
    except Exception:  # noqa: BLE001
        return ""
    raw = re.sub(r"\.[a-z0-9]{2,4}$", "", raw, flags=re.I)
    raw = re.sub(r"[._]+", " ", raw).strip()
    return raw[:200]


def parse_title(text: str) -> dict:
    """Split a release-style name into {title, year, season, episode}."""
    t = re.sub(r"[._]+", " ", text or "").strip()
    t = re.sub(r"\[[^\]]*\]", " ", t)
    out: dict = {"title": "", "year": None, "season": None, "episode": None}
    m = _EP_RE.search(t)
    if m:
        out["season"] = int(m.group(1) or m.group(3))
        out["episode"] = int(m.group(2) or m.group(4))
        t = t[:m.start()]
    y = _YEAR_RE.search(t)
    if y and y.start() > 0:
        out["year"] = y.group(1)
        t = t[:y.start()]
    t = _JUNK_RE.sub("", t)
    t = re.sub(r"[\(\)\-–|:]+\s*$", "", t)
    out["title"] = re.sub(r"\s+", " ", t).strip(" -–|:()")
    return out


def _strip_html(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def _youtube_meta(c, url: str) -> dict | None:
    r = c.get("https://www.youtube.com/oembed", params={"url": url, "format": "json"})
    if r.status_code != 200:
        return None
    d = r.json()
    return {
        "kind": "youtube", "title": d.get("title") or "",
        "description": d.get("author_name") or "",
        "poster": d.get("thumbnail_url") or "",
        "source": "youtube_oembed", "meta_url": url,
    }


def _tvmaze_meta(c, p: dict) -> dict | None:
    r = c.get("https://api.tvmaze.com/singlesearch/shows", params={"q": p["title"]})
    if r.status_code != 200:
        return None
    show = r.json()
    img = (show.get("image") or {})
    meta = {
        "kind": "episode" if p.get("season") else "show",
        "title": show.get("name") or p["title"],
        "year": (show.get("premiered") or "")[:4] or None,
        "overview": _strip_html(show.get("summary") or "")[:1200],
        "poster": img.get("original") or img.get("medium") or "",
        "genres": ", ".join(show.get("genres") or []),
        "source": "tvmaze", "meta_url": show.get("url") or "",
    }
    if p.get("season") and p.get("episode") and show.get("id"):
        e = c.get(f"https://api.tvmaze.com/shows/{show['id']}/episodebynumber",
                  params={"season": p["season"], "number": p["episode"]})
        if e.status_code == 200:
            ep = e.json()
            meta["title"] = (f"{meta['title']} · S{p['season']:02d}E{p['episode']:02d}"
                             + (f" · {ep['name']}" if ep.get("name") else ""))
            meta["description"] = _strip_html(ep.get("summary") or "")[:300] or None
            if (ep.get("image") or {}).get("original"):
                meta["poster"] = ep["image"]["original"]
    return meta


def _wikipedia_meta(c, p: dict) -> dict | None:
    q = p["title"] + (f" {p['year']}" if p.get("year") else "") + " film"
    r = c.get("https://en.wikipedia.org/w/api.php", params={
        "action": "query", "list": "search", "srsearch": q, "srlimit": 5,
        "format": "json",
    })
    if r.status_code != 200:
        return None
    hits = (r.json().get("query") or {}).get("search") or []
    want = p["title"].lower()
    for h in hits:
        title = h.get("title") or ""
        if want.split()[0] not in title.lower():
            continue
        s = c.get("https://en.wikipedia.org/api/rest_v1/page/summary/" + quote(title.replace(" ", "_")))
        if s.status_code != 200:
            continue
        d = s.json()
        desc = d.get("description") or ""
        if not re.search(r"\b(film|movie|documentary|animated)\b", desc, re.I):
            continue
        img = (d.get("originalimage") or d.get("thumbnail") or {}).get("source") or ""
        y = _YEAR_RE.search(desc)
        return {
            "kind": "movie",
            "title": re.sub(r"\s*\((?:\d{4} )?film\)$", "", d.get("title") or title),
            "year": y.group(1) if y else p.get("year"),
            "description": desc,
            "overview": (d.get("extract") or "")[:1200],
            "poster": img,
            "source": "wikipedia",
            "meta_url": ((d.get("content_urls") or {}).get("desktop") or {}).get("page") or "",
        }
    return None


def _itunes_meta(c, p: dict) -> dict | None:
    r = c.get("https://itunes.apple.com/search", params={
        "term": p["title"], "media": "movie", "entity": "movie", "limit": 5})
    if r.status_code != 200:
        return None
    res = r.json().get("results") or []
    if p.get("year"):
        res.sort(key=lambda x: (x.get("releaseDate") or "")[:4] != p["year"])
    for m in res:
        if not m.get("trackName"):
            continue
        return {
            "kind": "movie",
            "title": m["trackName"],
            "year": (m.get("releaseDate") or "")[:4] or None,
            "description": m.get("primaryGenreName") or "",
            "overview": (m.get("longDescription") or "")[:1200],
            "poster": (m.get("artworkUrl100") or "").replace("100x100", "600x600"),
            "genres": m.get("primaryGenreName") or "",
            "source": "itunes", "meta_url": m.get("trackViewUrl") or "",
        }
    return None


def lookup_meta(url: str, hint: str = "") -> dict:
    """Best-effort metadata for a video. Never raises; {} when nothing matched."""
    import httpx

    try:
        with httpx.Client(timeout=8, headers={"User-Agent": _UA},
                          follow_redirects=True) as c:
            if _YT_RE.search(url):
                return _youtube_meta(c, url) or {}
            p = parse_title(guess_title(url, hint))
            if not p["title"] or len(p["title"]) < 2:
                return {}
            order = ([_tvmaze_meta, _wikipedia_meta] if p.get("season")
                     else [_wikipedia_meta, _itunes_meta, _tvmaze_meta])
            for fn in order:
                try:
                    m = fn(c, p)
                except Exception as e:  # noqa: BLE001
                    logger.info("watch_history: %s failed for %r: %s", fn.__name__, p["title"], e)
                    m = None
                if m and m.get("title"):
                    return m
    except Exception as e:  # noqa: BLE001
        logger.info("watch_history: metadata lookup failed: %s", e)
    return {}


def enrich(url: str) -> None:
    """Fetch and store metadata for `url` if it has none yet (blocking)."""
    if not needs_meta(url):
        return
    with _lock, _conn() as db:
        row = db.execute("SELECT title_hint, source_url FROM watch_items WHERE url = ?",
                         (url,)).fetchone()
    hint = (row["title_hint"] if row else "") or ""
    src = (row["source_url"] if row else "") or ""
    # The page URL (e.g. the YouTube link behind an extracted stream) names the
    # video better than the stream URL does.
    meta = lookup_meta(src, hint) if src else {}
    if not meta:
        meta = lookup_meta(url, hint)
    _save_meta(url, meta or {})
