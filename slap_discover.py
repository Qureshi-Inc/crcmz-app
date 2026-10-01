"""Slap Discover: this week's new finds, downloading them, and everyone's picks playlists.

    new finds    a weekly mix of songs the library doesn't have, from slaptastic's
                 per-person AI recommendations, checked against Apple's catalogue
                 (which also gives each one a 30-second preview and a link the
                 importer can download)
    Download     sends that link to music-importer's job queue; the card follows the
                 job until the song is in Jellyfin. Only downloaded songs ever reach
                 the library.
    expiry       when the ISO week rolls over, every find nobody downloaded is
                 deleted. Downloads in flight finish first.
    picks        every completed import is filed into "<name>'s picks" for whoever
                 asked for it (Mattermost, WhatsApp, the scrobbler, or Download here),
                 so the player's "Added by" and the playlists agree.

DB: /data/slap_discover.db
  weeks    week -> when its finds were made (an empty week retries after a few hours)
  finds    one row per suggestion: what it is, where to preview it, and its download state
  credits  importer job -> who pressed Download (kept after the week ends)
  synced   importer jobs already filed into a picks playlist
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import os
import re
import sqlite3
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException

import crcmz_identity
import slap

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("SLAP_DISCOVER_DB", "/data/slap_discover.db"))
_lock = threading.Lock()
_ready = False

FINDS_MAX = 10          # one small section, never a flood
PER_PERSON = 3          # so one person's taste can't fill it
RECOMMEND_FOR = 5       # the squad's most active adders get recommendations
EMPTY_RETRY_S = 6 * 3600
POLL_S = 10             # how often a page view may re-check downloads in flight
DOWNLOADS_PER_DAY = 15  # per person
SYNC_TRIES = 6          # an import that never shows up in Jellyfin is let go after this many passes

ITUNES_URL = os.environ.get("ITUNES_SEARCH_URL", "https://itunes.apple.com/search")
_APPLE_HOSTS = re.compile(r"^https://(music\.apple\.com|audio-ssl\.itunes\.apple\.com|is\d-ssl\.mzstatic\.com)/")
_BOT_IDS = {"srrgmm688pds7fiqndeweew6zr"}   # slapper: its imports go in "slapper's picks"


def _conn() -> sqlite3.Connection:
    global _ready
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    if not _ready:
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        c.executescript("""
            CREATE TABLE IF NOT EXISTS weeks (
                week   TEXT PRIMARY KEY,
                ts     REAL NOT NULL,
                n      INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS finds (
                week        TEXT NOT NULL,
                apple_id    TEXT NOT NULL,
                pos         INTEGER NOT NULL,
                title       TEXT NOT NULL,
                artist      TEXT NOT NULL,
                album       TEXT NOT NULL DEFAULT '',
                art         TEXT NOT NULL DEFAULT '',
                preview     TEXT NOT NULL DEFAULT '',
                url         TEXT NOT NULL,
                duration    INTEGER NOT NULL DEFAULT 0,
                for_user    TEXT NOT NULL DEFAULT '',
                why         TEXT NOT NULL DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'new',
                job_id      TEXT NOT NULL DEFAULT '',
                by_sub      TEXT NOT NULL DEFAULT '',
                by_name     TEXT NOT NULL DEFAULT '',
                at          REAL NOT NULL DEFAULT 0,
                track_id    TEXT NOT NULL DEFAULT '',
                error       TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (week, apple_id)
            );
            CREATE TABLE IF NOT EXISTS credits (
                job_id   TEXT PRIMARY KEY,
                sub      TEXT NOT NULL,
                name     TEXT NOT NULL,
                title    TEXT NOT NULL,
                artist   TEXT NOT NULL,
                ts       REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS synced (
                job_id    TEXT PRIMARY KEY,
                track_id  TEXT NOT NULL DEFAULT '',
                tries     INTEGER NOT NULL DEFAULT 0,
                ts        REAL NOT NULL
            );
        """)
        _ready = True
    return c


def week_of(now: float | None = None) -> str:
    """The ISO week a mix belongs to, as its Monday (UTC)."""
    d = dt.datetime.fromtimestamp(now if now is not None else time.time(), dt.timezone.utc).date()
    return (d - dt.timedelta(days=d.weekday())).isoformat()


def expires_at(week: str) -> int:
    """ms since epoch when this week's finds go away."""
    monday = dt.datetime.fromisoformat(week).replace(tzinfo=dt.timezone.utc)
    return int((monday + dt.timedelta(days=7)).timestamp() * 1000)


# ── Matching songs ───────────────────────────────────────────────────────────
def norm(s: str) -> str:
    """"Big Dawgs (feat. Kalmi) - Single" -> "big dawgs": for comparing titles."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[\(\[][^\)\]]*(feat|ft\.|with|remaster|version|edit|single|explicit)[^\)\]]*[\)\]]", " ", s)
    s = re.sub(r"\s-\s.*(remaster|version|edit|single|mix).*$", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _artists(s: str) -> set[str]:
    parts = re.split(r",|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b|/|;", norm_artist(s))
    return {p.strip() for p in parts if p.strip()}


def norm_artist(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9,&/; ]+", " ", s)


def same_song(title_a: str, artist_a: str, title_b: str, artist_b: str) -> bool:
    """One title, and at least one credited artist in common."""
    ta, tb = norm(title_a), norm(title_b)
    if not ta or ta != tb:
        return False
    aa, ab = _artists(artist_a), _artists(artist_b)
    if not aa or not ab:
        return True
    return bool(aa & ab) or any(x in y or y in x for x in aa for y in ab if min(len(x), len(y)) >= 4)


class LibraryIndex:
    """The library's tracks by normalised title, for "do we already have this?"."""

    def __init__(self, tracks: list[dict]):
        self.by_title: dict[str, list[dict]] = {}
        for t in tracks:
            self.by_title.setdefault(norm(t.get("title") or ""), []).append(t)

    def find(self, title: str, artist: str) -> dict | None:
        for t in self.by_title.get(norm(title), []):
            if same_song(t.get("title") or "", t.get("artist") or "", title, artist):
                return t
        return None


async def _admin_uid() -> str:
    if (hit := slap._cached("jf-admin", 600)) is not None:
        return hit
    users = slap._ok(await slap._jf("GET", "/Users")) or []
    admin = next((u["Id"] for u in users if (u.get("Policy") or {}).get("IsAdministrator")), None)
    admin = admin or next((u["Id"] for u in users if u.get("Id")), "")
    return slap._store("jf-admin", admin)


async def library_index(refresh: bool = False) -> LibraryIndex:
    uid = await _admin_uid()
    return LibraryIndex(await slap.library_for(uid, refresh=refresh) if uid else [])


# ── Apple's catalogue (previews and download links) ──────────────────────────
async def itunes_find(client: httpx.AsyncClient, artist: str, title: str) -> dict | None:
    """The catalogue entry for this song, or None if Apple doesn't have it."""
    try:
        r = await client.get(ITUNES_URL, params={"term": f"{artist} {title}", "entity": "song", "limit": 8,
                                                 "media": "music"})
        results = r.json().get("results", []) if r.status_code == 200 else []
    except (httpx.HTTPError, ValueError) as e:
        logger.info("discover: itunes search failed for %s - %s: %s", artist, title, e)
        return None
    for x in results:
        name, by = x.get("trackName") or "", x.get("artistName") or ""
        url, preview = x.get("trackViewUrl") or "", x.get("previewUrl") or ""
        if not (x.get("trackId") and _APPLE_HOSTS.match(url) and same_song(name, by, title, artist)):
            continue
        art = (x.get("artworkUrl100") or "").replace("100x100bb", "600x600bb")
        return {
            "apple_id": str(x["trackId"]), "title": name, "artist": by,
            "album": x.get("collectionName") or "", "url": url.split("&uo=")[0],
            "preview": preview if _APPLE_HOSTS.match(preview) else "",
            "art": art if _APPLE_HOSTS.match(art) else "",
            "duration": int((x.get("trackTimeMillis") or 0) / 1000),
        }
    return None


# ── Making a week's finds ────────────────────────────────────────────────────
def _split_song(entry: str) -> tuple[str, str] | None:
    parts = (entry or "").split(" - ", 1)
    if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
        return None
    return parts[0].strip()[:120], parts[1].strip()[:160]


async def _recommendations() -> list[dict]:
    """[{user, why, songs: [(artist, title)]}] for the squad's most active adders."""
    board = await slap.social_get("dashboard/leaderboard", {})
    users = [e["username"] for e in (board or {}).get("entries", []) if e.get("username")][:RECOMMEND_FOR]
    out = []
    for u in users:
        try:
            r = await slap._social.get(f"/dashboard/ai/recommendations/{u}", timeout=90)
            d = r.json() if r.status_code == 200 else {}
        except (httpx.HTTPError, ValueError) as e:
            logger.info("discover: recommendations for %s failed: %s", u, e)
            continue
        songs = [s for s in (_split_song(x) for x in d.get("recommendations") or []) if s]
        if songs:
            out.append({"user": u, "why": str(d.get("reasoning") or "")[:400], "songs": songs})
    return out


_gen_lock = asyncio.Lock()


def _week_state(week: str) -> tuple[int, float] | None:
    with _conn() as db:
        row = db.execute("SELECT n, ts FROM weeks WHERE week=?", (week,)).fetchone()
    return (row["n"], row["ts"]) if row else None


def needs_finds(week: str, now: float | None = None) -> bool:
    st = _week_state(week)
    return st is None or (st[0] == 0 and (now or time.time()) - st[1] > EMPTY_RETRY_S)


async def generate(week: str | None = None, *, force: bool = False) -> int:
    """Make this week's finds once. Returns how many there are."""
    week = week or week_of()
    async with _gen_lock:
        if not force and not needs_finds(week):
            return _week_state(week)[0]  # type: ignore[index]
        recs = await _recommendations()
        index = await library_index(refresh=True)
        picked: list[dict] = []
        seen: set[str] = set()
        async with httpx.AsyncClient(timeout=15) as client:
            # Round-robin over people so the mix is everyone's, not the top adder's.
            for rnd in range(PER_PERSON):
                for rec in recs:
                    if len(picked) >= FINDS_MAX or rnd >= len(rec["songs"]):
                        continue
                    artist, title = rec["songs"][rnd]
                    if index.find(title, artist):
                        continue
                    hit = await itunes_find(client, artist, title)
                    if not hit or hit["apple_id"] in seen or index.find(hit["title"], hit["artist"]):
                        continue
                    seen.add(hit["apple_id"])
                    picked.append({**hit, "for_user": rec["user"], "why": rec["why"]})
        with _lock, _conn() as db:
            for pos, f in enumerate(picked):
                db.execute(
                    "INSERT OR IGNORE INTO finds(week, apple_id, pos, title, artist, album, art, preview, url, "
                    "duration, for_user, why) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (week, f["apple_id"], pos, f["title"], f["artist"], f["album"], f["art"], f["preview"],
                     f["url"], f["duration"], f["for_user"], f["why"]))
            n = db.execute("SELECT COUNT(*) FROM finds WHERE week=?", (week,)).fetchone()[0]
            db.execute("INSERT INTO weeks(week, ts, n) VALUES (?,?,?) ON CONFLICT(week) DO UPDATE SET "
                       "ts=excluded.ts, n=excluded.n", (week, time.time(), n))
        logger.info("discover: %d new finds for the week of %s", n, week)
        return n


def prune(now: float | None = None) -> int:
    """Delete last week's finds nobody downloaded (and the finished ones; credits keep those)."""
    week = week_of(now)
    with _lock, _conn() as db:
        n = db.execute("DELETE FROM finds WHERE week < ? AND status != 'queued'", (week,)).rowcount
        db.execute("DELETE FROM weeks WHERE week < ?", (week,))
    if n:
        logger.info("discover: %d expired finds removed", n)
    return n


# ── Downloading ──────────────────────────────────────────────────────────────
def _find(week: str, apple_id: str) -> dict | None:
    with _conn() as db:
        row = db.execute("SELECT * FROM finds WHERE week=? AND apple_id=?", (week, apple_id)).fetchone()
    return dict(row) if row else None


def _downloads_today(sub: str) -> int:
    with _conn() as db:
        return db.execute("SELECT COUNT(*) FROM credits WHERE sub=? AND ts > ?", (sub, time.time() - 86400)).fetchone()[0]


async def _importer_get(path: str) -> dict:
    if not slap.SLAP_ADMIN_TOKEN:
        raise HTTPException(503, "downloads aren't set up yet")
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{slap.SLAP_INTERNAL_URL}{path}",
                            headers={"Authorization": f"Bearer {slap.SLAP_ADMIN_TOKEN}"})
    except httpx.HTTPError as e:
        logger.warning("discover: importer %s failed: %s", path, e)
        raise HTTPException(502, "the music importer is unreachable")
    if r.status_code >= 400:
        raise HTTPException(404 if r.status_code == 404 else 502, "the music importer didn't answer")
    return r.json()


def picks_name(person: dict) -> str:
    """Whose picks a person's songs go in: their Mattermost tag in the identity chart.

    That's the name their picks playlist has always had. Their live Mattermost
    name can drift (Moose's is mutasif now; the playlist is themoosecompany's).
    """
    return re.sub(r"[^\w.-]", "", person.get("mm_username") or "") or slap.handle_of(person)


async def download(sub: str, name: str, apple_id: str, week: str | None = None, picks: str = "") -> dict:
    """Queue one find for the library, credited to ``name``, filed in ``picks``'s playlist."""
    week = week or week_of()
    f = _find(week, apple_id)
    if not f:
        raise HTTPException(404, "that find has expired")
    if f["status"] in ("queued", "review", "done"):
        return public(f)
    if _downloads_today(sub) >= DOWNLOADS_PER_DAY:
        raise HTTPException(429, f"that's {DOWNLOADS_PER_DAY} downloads today; try again tomorrow")
    if hit := (await library_index(refresh=True)).find(f["title"], f["artist"]):
        _update(week, apple_id, status="done", track_id=hit["id"], error="")
        return public(_find(week, apple_id) or f)
    job = await slap._importer("/jobs", {"url": f["url"]}, timeout=30)
    jid = str(job.get("id") or "")
    if not jid:
        raise HTTPException(502, "the music importer didn't take that")
    now = time.time()
    with _lock, _conn() as db:
        db.execute("INSERT OR REPLACE INTO credits(job_id, sub, name, title, artist, ts) VALUES (?,?,?,?,?,?)",
                   (jid, sub, picks or name, f["title"], f["artist"], now))
    _update(week, apple_id, status="queued", job_id=jid, by_sub=sub, by_name=name, at=now, error="")
    logger.info("discover: %s downloading %s - %s (job %s)", name, f["artist"], f["title"], jid)
    return public(_find(week, apple_id) or f)


def _update(week: str, apple_id: str, **cols: Any) -> None:
    sets = ", ".join(f"{k}=?" for k in cols)
    with _lock, _conn() as db:
        db.execute(f"UPDATE finds SET {sets} WHERE week=? AND apple_id=?", (*cols.values(), week, apple_id))


_last_poll = 0.0


async def follow_downloads(*, force: bool = False) -> int:
    """Move queued finds along with their importer jobs. Returns how many changed."""
    global _last_poll
    if not force and time.time() - _last_poll < POLL_S:
        return 0
    _last_poll = time.time()
    with _conn() as db:
        rows = [dict(r) for r in db.execute("SELECT * FROM finds WHERE status IN ('queued', 'review')")]
    changed = 0
    index: LibraryIndex | None = None
    for f in rows:
        try:
            job = await _importer_get(f"/jobs/{f['job_id']}")
        except HTTPException as e:
            if e.status_code == 404:
                _update(f["week"], f["apple_id"], status="failed", error="the importer lost this one")
                changed += 1
            continue
        st = str(job.get("status") or "").lower()
        if st == "complete":
            index = index or await library_index(refresh=True)
            hit = index.find(job.get("title") or f["title"], job.get("artist") or f["artist"]) \
                or index.find(f["title"], f["artist"])
            _update(f["week"], f["apple_id"], status="done", track_id=hit["id"] if hit else "", error="")
            with _conn() as db:
                cr = db.execute("SELECT name FROM credits WHERE job_id=?", (f["job_id"],)).fetchone()
            owner = (cr["name"] if cr else "") or f["by_name"]
            if hit and owner:
                await file_into_picks({owner: [hit["id"]]})
                with _lock, _conn() as db:
                    db.execute("INSERT OR REPLACE INTO synced(job_id, track_id, tries, ts) VALUES (?,?,0,?)",
                               (f["job_id"], hit["id"], time.time()))
            changed += 1
        elif st in ("failed", "cancelled"):
            _update(f["week"], f["apple_id"], status="failed",
                    error=str(job.get("error_message") or "the download didn't work")[:200])
            changed += 1
        elif st == "reviewing" and f["status"] != "review":
            _update(f["week"], f["apple_id"], status="review")
            changed += 1
    return changed


async def approve(apple_id: str, week: str | None = None) -> dict:
    """An admin says the importer's unsure match is right."""
    week = week or week_of()
    f = _find(week, apple_id)
    if not f or f["status"] != "review" or not f["job_id"]:
        raise HTTPException(409, "nothing to approve")
    await slap._importer(f"/jobs/{f['job_id']}/approve", {}, timeout=20)
    _update(week, apple_id, status="queued")
    return public(_find(week, apple_id) or f)


# ── Picks playlists ──────────────────────────────────────────────────────────
async def _picks_playlists(uid: str) -> dict[str, dict]:
    """casefolded owner -> {id, name, items: set of track ids}."""
    data = slap._ok(await slap._jf("GET", "/Items", params={
        "userId": uid, "IncludeItemTypes": "Playlist", "Recursive": "true"})) or {}
    out: dict[str, dict] = {}
    for pl in data.get("Items", []):
        m = slap._PICKS.match(pl.get("Name") or "")
        if not m or not pl.get("Id"):
            continue
        items = slap._ok(await slap._jf("GET", f"/Playlists/{pl['Id']}/Items", params={"userId": uid})) or {}
        out[m.group(1).strip().casefold()] = {"id": pl["Id"], "name": pl["Name"],
                                              "items": {t["Id"] for t in items.get("Items", []) if t.get("Id")}}
    return out


async def file_into_picks(wanted: dict[str, list[str]]) -> int:
    """Put each person's tracks in "<name>'s picks", making the playlist if it's new."""
    uid = await _admin_uid()
    if not uid or not wanted:
        return 0
    lists = await _picks_playlists(uid)
    added = 0
    for name, ids in wanted.items():
        pl = lists.get(name.casefold())
        todo = [i for i in dict.fromkeys(ids) if not pl or i not in pl["items"]]
        if not todo:
            continue
        if not pl:
            made = slap._ok(await slap._jf("POST", "/Playlists", json={
                "Name": f"{name}'s picks", "UserId": uid, "MediaType": "Audio", "Ids": todo[:50]})) or {}
            if not made.get("Id"):
                logger.warning("discover: couldn't make %s's picks", name)
                continue
            pl = lists[name.casefold()] = {"id": made["Id"], "name": f"{name}'s picks", "items": set(todo[:50])}
            added += len(todo[:50])
            todo = todo[50:]
        for k in range(0, len(todo), 50):
            chunk = todo[k:k + 50]
            slap._ok(await slap._jf("POST", f"/Playlists/{pl['id']}/Items",
                                    params={"ids": ",".join(chunk), "userId": uid}))
            pl["items"].update(chunk)
            added += len(chunk)
    if added:
        slap._forget("picks")
    return added


async def _completed_jobs() -> list[dict]:
    jobs, page = [], 1
    while page <= 50:
        d = await _importer_get(f"/jobs?status=complete&per_page=100&page={page}")
        jobs += d.get("items") or []
        if page * 100 >= int(d.get("total") or 0):
            break
        page += 1
    return jobs


def _mm_names(ids: list[str]) -> dict[str, str]:
    """Mattermost user id -> whose picks: the chart's name for them, else their username.

    The importer files by live Mattermost username; the chart matches the account by
    its email first (the SSO link), then by the hand-set mm_username tag.
    """
    import mattermost
    if not ids or not mattermost.available():
        return {}
    try:
        r = httpx.post(f"{mattermost._BASE}/api/v4/users/ids", headers=mattermost._headers(), json=ids, timeout=20)
        users = r.json() if r.status_code == 200 else []
        people = crcmz_identity.people()
        by_email = {p["email"].casefold(): p for p in people if p.get("email")}
        by_tag = {p["mm_username"].casefold(): p for p in people if p.get("mm_username")}
        out = {}
        for u in users:
            p = by_email.get((u.get("email") or "").casefold()) or by_tag.get(u["username"].casefold())
            out[u["id"]] = (picks_name(p) if p else "") or u["username"]
            if out[u["id"]].casefold() != u["username"].casefold():
                _DRIFTED[u["username"].casefold()] = out[u["id"]]
        return out
    except (httpx.HTTPError, ValueError, KeyError) as e:
        logger.warning("discover: mattermost names failed: %s", e)
        return {}


# Live Mattermost username -> the chart's picks name, where they differ.
_DRIFTED: dict[str, str] = {}


async def fold_drifted() -> int:
    """Move "<live mm name>'s picks" into the chart's playlist, then drop the empty copy.

    The importer makes those itself whenever someone's Mattermost name has drifted.
    """
    uid = await _admin_uid()
    if not uid or not _DRIFTED:
        return 0
    lists = await _picks_playlists(uid)
    moved = 0
    for live, name in list(_DRIFTED.items()):
        stray = lists.get(live)
        if not stray or live == name.casefold():
            continue
        moved += await file_into_picks({name: sorted(stray["items"])})
        target = (await _picks_playlists(uid)).get(name.casefold())
        if target and stray["items"] <= target["items"]:
            try:
                slap._ok(await slap._jf("DELETE", f"/Items/{stray['id']}", params={"userId": uid}))
            except HTTPException:
                continue
            logger.info("discover: folded %s into %s's picks", stray["name"], name)
            slap._forget("picks")
    return moved


async def sync_picks() -> dict:
    """File every completed import nobody filed yet into its person's picks playlist."""
    with _conn() as db:
        done = {r["job_id"] for r in db.execute(
            "SELECT job_id FROM synced WHERE track_id != '' OR tries >= ?", (SYNC_TRIES,))}
        credits = {r["job_id"]: r["name"] for r in db.execute("SELECT job_id, name FROM credits")}
    every = await _completed_jobs()
    # Everyone's names, every time: that's also how a drifted name gets noticed.
    people = await asyncio.to_thread(_mm_names, sorted({j["requester_user_id"] for j in every
                                                         if j.get("requester_user_id")
                                                         and j["requester_user_id"] not in _BOT_IDS}))
    jobs = [j for j in every if str(j.get("id")) not in done]
    if not jobs:
        return {"checked": 0, "filed": await fold_drifted()}
    index = await library_index(refresh=True)
    wanted: dict[str, list[str]] = {}
    outcome: list[tuple[str, str, bool]] = []   # job id, track id, settled
    for j in jobs:
        jid, req = str(j.get("id")), j.get("requester_user_id") or ""
        name = credits.get(jid) or ("slapper" if req in _BOT_IDS else people.get(req, ""))
        hit = index.find(j.get("title") or "", j.get("artist") or "")
        if hit and name:
            wanted.setdefault(name, []).append(hit["id"])
            outcome.append((jid, hit["id"], True))
        else:
            outcome.append((jid, "", False))
    filed = await file_into_picks(wanted)
    filed += await fold_drifted()
    now = time.time()
    with _lock, _conn() as db:
        for jid, tid, settled in outcome:
            if settled:
                db.execute("INSERT OR REPLACE INTO synced(job_id, track_id, tries, ts) VALUES (?,?,0,?)", (jid, tid, now))
            else:
                # Not in Jellyfin yet, or nobody to credit: try a few more times, then let it go.
                db.execute("INSERT INTO synced(job_id, track_id, tries, ts) VALUES (?, '', 1, ?) "
                           "ON CONFLICT(job_id) DO UPDATE SET tries=tries+1, ts=excluded.ts", (jid, now))
    logger.info("discover: picks sync checked %d imports, filed %d tracks", len(jobs), filed)
    return {"checked": len(jobs), "filed": filed}


# ── Reading ──────────────────────────────────────────────────────────────────
def public(f: dict) -> dict:
    return {
        "id": f["apple_id"], "title": f["title"], "artist": f["artist"], "album": f["album"],
        "art": f["art"] or None, "preview": f["preview"] or None, "duration": f["duration"],
        "for": f["for_user"], "status": f["status"], "by": f["by_name"] or None,
        "track_id": f["track_id"] or None, "error": f["error"] or None,
    }


def current(week: str | None = None) -> dict:
    """This week's finds, newest state first in their mix order."""
    week = week or week_of()
    with _conn() as db:
        rows = [dict(r) for r in db.execute("SELECT * FROM finds WHERE week=? ORDER BY pos", (week,))]
    why = {}
    for r in rows:
        why.setdefault(r["for_user"], r["why"])
    st = _week_state(week)
    return {"week": week, "expires": expires_at(week), "finds": [public(r) for r in rows],
            "why": why, "ready": st is not None}


def overview(limit: int = 20) -> dict:
    """For the assistant: this week's finds and recent downloads. No ids or subs."""
    limit = max(1, min(int(limit or 20), 100))
    cur = current()
    with _conn() as db:
        recent = [{"title": r["title"], "artist": r["artist"], "by": r["name"],
                   "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"]))}
                  for r in db.execute("SELECT * FROM credits ORDER BY ts DESC LIMIT ?", (limit,))]
    return {"week_of": cur["week"],
            "expires": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(cur["expires"] / 1000)),
            "new_finds": [{k: f[k] for k in ("title", "artist", "album", "for", "status", "by")} for f in cur["finds"]],
            "recent_downloads": recent}


# ── Background ───────────────────────────────────────────────────────────────
async def tick() -> None:
    """One pass: expire, make this week's finds if missing, follow downloads, file picks."""
    prune()
    if needs_finds(week_of()):
        try:
            await generate()
        except Exception as e:  # noqa: BLE001
            logger.warning("discover: making finds failed: %s", e)
    await follow_downloads(force=True)


async def loop() -> None:
    await asyncio.sleep(45)
    n = 0
    while True:
        try:
            await tick()
            if n % 6 == 0:   # every half hour
                await sync_picks()
        except Exception as e:  # noqa: BLE001
            logger.warning("discover: background pass failed: %s", e)
        n += 1
        await asyncio.sleep(300)
