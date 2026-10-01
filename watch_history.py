"""Watch Party history: what was watched, by whom, and where it was left off.

Three tables:

* ``watch_items``    — one row per video URL, with metadata looked up from free,
                        keyless sources (YouTube oEmbed, Wikipedia, TVmaze, iTunes).
* ``watch_progress`` — one row per (Zitadel sub, video URL): last position,
                        duration, room, and when it was last watched.
* ``watch_chat``     — Watch Party chat messages, filed under the video that was
                        on when they were sent (copied from the realtime server,
                        which only keeps its last 100 entries in memory).

A title is only ever what a viewer typed or what the source itself reported
(YouTube, or the page title the extractor read). File names are never guessed
at: an HLS stream is "master.m3u8" whatever the film is.

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
            CREATE TABLE IF NOT EXISTS watch_chat (
                room      TEXT NOT NULL,
                ts        REAL NOT NULL,
                sender    TEXT NOT NULL,     -- WatchParty clientId
                name      TEXT,
                msg       TEXT NOT NULL,
                video     TEXT,              -- watch_items.url on at the time
                video_ts  REAL,
                PRIMARY KEY (room, ts, sender, msg)
            );
            CREATE INDEX IF NOT EXISTS idx_wh_chat_video ON watch_chat(video, ts);
        """)
        cols = {r[1] for r in db.execute("PRAGMA table_info(watch_items)")}
        if "extracted_title" not in cols:
            db.execute("ALTER TABLE watch_items ADD COLUMN extracted_title TEXT")
        db.commit()
    logger.info("watch_history: DB ready at %s", _DB_PATH)


# ── writes ───────────────────────────────────────────────────────────────────


def _clean_url(url: str) -> str:
    url = (url or "").strip()
    if not url or len(url) > 4000:
        return ""
    if not (url.startswith("http://") or url.startswith("https://")
            or url.startswith("/api/watch/proxy?")
            or re.match(r"^/api/watch/movies/stream/[0-9a-f]{32}/master\.m3u8$", url)):
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
    extracted_title: str = "",
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
    extracted_title = clean_page_title(extracted_title)
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            """INSERT INTO watch_items (url, source_url, title_hint, extracted_title, first_seen)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(url) DO UPDATE SET
                 source_url = COALESCE(NULLIF(excluded.source_url, ''), watch_items.source_url)""",
            (url, source_url or None, title_hint or None, extracted_title or None, now),
        )
        _apply_title(db, url, typed=title_hint, extracted=extracted_title)
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


def _apply_title(db, url: str, *, typed: str = "", extracted: str = "") -> None:
    """Store a newly seen title. When the name we'd look up changes, drop the
    old lookup (it may have matched the wrong film) so enrich() runs again.
    YouTube's own title is authoritative, so that is left alone."""
    row = db.execute("SELECT title_hint, extracted_title, meta_source FROM watch_items WHERE url = ?",
                     (url,)).fetchone()
    if not row:
        return
    new_typed = typed or row["title_hint"]
    new_ext = extracted or row["extracted_title"]
    before = row["title_hint"] or row["extracted_title"]
    after = new_typed or new_ext
    reset = after != before and (row["meta_source"] or "") != "youtube_oembed"
    db.execute(
        f"""UPDATE watch_items SET title_hint = ?, extracted_title = ?
            {", title = NULL, year = NULL, description = NULL, overview = NULL, poster = NULL,"
             " genres = NULL, meta_source = NULL, meta_url = NULL, meta_fetched_at = NULL" if reset else ""}
            WHERE url = ?""",
        (new_typed, new_ext, url),
    )


def set_title(url: str, title: str) -> bool:
    """A viewer named (or renamed) a video by hand. Returns False if unknown."""
    title = (title or "").strip()[:200]
    url = _clean_url(url)
    if not url or not title:
        return False
    with _lock, _conn() as db:
        if not db.execute("SELECT 1 FROM watch_items WHERE url = ?", (url,)).fetchone():
            return False
        # Typed titles always win, so reset even if it matches the extracted one.
        db.execute("""UPDATE watch_items SET title_hint = ?, title = NULL, year = NULL,
                        description = NULL, overview = NULL, poster = NULL, genres = NULL,
                        meta_source = NULL, meta_url = NULL, meta_fetched_at = NULL
                      WHERE url = ?""", (title, url))
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
    d["title"] = d["title"] or row["title_hint"] or row["extracted_title"] or ""
    d["named_by"] = ("viewer" if row["title_hint"] else
                     "source" if row["extracted_title"] or d["meta_source"] == "youtube_oembed" else None)
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
            d["chat_count"] = db.execute(
                "SELECT COUNT(*) FROM watch_chat WHERE video = ?" + (" AND room = ?" if room else ""),
                [u["url"]] + ([room] if room else [])).fetchone()[0]
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


# ── chat ─────────────────────────────────────────────────────────────────────


def _iso_ts(v) -> float | None:
    if isinstance(v, (int, float)):
        return float(v) / (1000 if v > 1e11 else 1)
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def _video_at(db, room: str, ts: float) -> str | None:
    """Best guess at what was playing in `room` at `ts`, for messages older
    than the first video change we can see."""
    r = db.execute("SELECT video FROM watch_chat WHERE room = ? AND ts <= ? AND video IS NOT NULL "
                   "ORDER BY ts DESC LIMIT 1", (room, ts)).fetchone()
    if r:
        return r["video"]
    r = db.execute("SELECT url FROM watch_progress WHERE room = ? AND started_at <= ? "
                   "ORDER BY updated_at DESC LIMIT 1", (room, ts + 60)).fetchone()
    return r["url"] if r else None


def ingest_room_chat(room: str, chat: list, name_map: dict | None = None,
                     current_video: str = "") -> int:
    """Copy a room's in-memory chat into the store (idempotent). The realtime
    server logs every video change in the same list, so each message is filed
    under the video that was on when it was sent. Returns rows added."""
    room = (room or "").strip("/")[:64]
    if not room or not isinstance(chat, list):
        return 0
    name_map = name_map or {}
    rows = []
    with _lock, _conn() as db:
        hosts = [m for m in chat if isinstance(m, dict) and m.get("cmd") == "host"]
        video = None if hosts else (_clean_url(current_video or "") or current_video or None)
        seen_host = False
        for m in chat:
            if not isinstance(m, dict):
                continue
            ts = _iso_ts(m.get("timestamp"))
            if ts is None:
                continue
            if m.get("cmd") == "host":
                raw = str(m.get("msg") or "")
                video, seen_host = (_clean_url(raw) or raw or None), True
                continue
            if m.get("cmd") or m.get("system") or not isinstance(m.get("msg"), str):
                continue
            text = m["msg"].strip()
            if not text:
                continue
            v = video if (seen_host or not hosts) else _video_at(db, room, ts)
            sender = str(m.get("id") or "")[:64]
            vts = m.get("videoTS")
            rows.append((room, ts, sender, (name_map.get(sender) or "")[:64], text[:2000], v,
                         float(vts) if isinstance(vts, (int, float)) else None))
        if not rows:
            return 0
        before = db.total_changes
        db.executemany("INSERT OR IGNORE INTO watch_chat (room, ts, sender, name, msg, video, video_ts) "
                       "VALUES (?,?,?,?,?,?,?)", rows)
        db.commit()
        return db.total_changes - before


def chat_for(url: str, *, room: str | None = None, limit: int = 500) -> list[dict]:
    """Messages sent while `url` was playing, oldest first."""
    limit = max(1, min(int(limit or 500), 2000))
    q = "SELECT ts, name, msg, video_ts FROM watch_chat WHERE video = ?"
    a: list = [url]
    if room:
        q += " AND room = ?"
        a.append(room)
    with _lock, _conn() as db:
        rows = db.execute(q + " ORDER BY ts DESC LIMIT ?", (*a, limit)).fetchall()
    return [{"ts": r["ts"], "name": r["name"] or "", "msg": r["msg"], "video_ts": r["video_ts"]}
            for r in reversed(rows)]


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


_SITE_SPLIT_RE = re.compile(r"\s+[|\-–—•:]\s+")
_WATCH_RE = re.compile(r"^(?:watch|stream|download)\s+|\s+(?:online|full movie|free|hd|"
                       r"full hd|in hd|streaming|with subtitles?|eng ?sub)\b.*$", re.I)


def clean_page_title(t: str) -> str:
    """A video/page title as the extractor saw it, minus site cruft
    ("Watch Unabomber Online Free HD | SiteName" -> "Unabomber")."""
    t = html.unescape((t or "").strip())[:300]
    if not t:
        return ""
    parts = [p for p in _SITE_SPLIT_RE.split(t) if p.strip()]
    if len(parts) > 1:
        t = max(parts[:2], key=len) if len(parts[0]) < 3 else parts[0]
    t = _WATCH_RE.sub("", t).strip(" -–|:")
    if re.fullmatch(r"(?i)(master|index|playlist|video|stream|manifest|chunklist\w*|file|"
                    r"download|embed|player|watch)(\.\w+)?", t):
        return ""
    return t[:200]


_STOP = {"the", "a", "an", "of", "and", "in", "on", "to", "part", "film", "movie"}


def _words(t: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", (t or "").lower()) if w not in _STOP}


def _title_matches(want: str, got: str) -> bool:
    """Verification: every significant word we asked for is in what we got."""
    w = _words(want)
    return bool(w) and w <= _words(got)


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
    if not _title_matches(p["title"], show.get("name") or ""):
        return None
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
        if not _title_matches(want, re.sub(r"\s*\(.*?\)$", "", title)):
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
        if not m.get("trackName") or not _title_matches(p["title"], m["trackName"]):
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
    """Best-effort metadata for a video, from its YouTube id or a title a
    viewer/the source gave. Never raises; {} when nothing matched."""
    import httpx

    if url.startswith("/api/watch/movies/stream/"):
        import movies   # a film from our own library: Jellyfin knows exactly what it is
        return movies.history_meta(url)
    try:
        with httpx.Client(timeout=8, headers={"User-Agent": _UA},
                          follow_redirects=True) as c:
            if _YT_RE.search(url):
                return _youtube_meta(c, url) or {}
            if not (hint or "").strip():
                return {}          # no name to go on: don't guess from the URL
            p = parse_title(hint)
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
        row = db.execute("SELECT title_hint, extracted_title, source_url FROM watch_items WHERE url = ?",
                         (url,)).fetchone()
    hint = (row["title_hint"] or row["extracted_title"] if row else "") or ""
    src = (row["source_url"] if row else "") or ""
    # The page URL (e.g. the YouTube link behind an extracted stream) names the
    # video better than the stream URL does.
    meta = lookup_meta(src, hint) if src else {}
    if not meta:
        meta = lookup_meta(url, hint)
    _save_meta(url, meta or {})
