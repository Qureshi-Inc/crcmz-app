"""Slap: the squad's Jellyfin music library, its social stats, and Listen Together.

    browser ──/api/slap/*──> crcmz-app ──admin API key + userId──> Jellyfin
                                       └─stamped username──────> slaptastic

crcmz-app holds one admin API key and acts *as* the signed-in person by passing
their Jellyfin userId:

  * a Zitadel person maps to a Jellyfin user through the ``jellyfin_user``
    metadata tag (the identity graph, see crcmz_identity);
  * a person with no tag gets the account named by ``jellyfin_name`` — the same
    name the Zitadel ``jellyfinUser`` action puts in the SSO claim. If they have
    already signed in to Jellyfin with Zitadel, that account is adopted (the SSO
    plugin's link proves it is theirs); otherwise one is created — non-admin, all
    libraries, a random password nobody knows. Either way the tag is written back,
    so it happens once, and ``link_sso_accounts`` tags anyone who only ever used
    Jellyfin itself;
  * the key never reaches the browser: audio and artwork stream through here.

slaptastic trusts whatever ``username`` a write carries, so the browser never
supplies one — every play/skip/thumb/comment/settings write is stamped here with
the caller's Jellyfin username, lowercased the way slaptastic keys it.

Listen Together is one shared room for the squad: a queue, a current track and a
clock, held here in memory (uvicorn runs one worker) and pushed to members over
Server-Sent Events. Anyone in the room can play, pause, seek, skip, add, remove
and reorder. Each member's browser plays the audio itself, aligned to the
server's clock. State is lost on a redeploy, which for a listening session is
fine.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

import crcmz_identity
import notifications

logger = logging.getLogger(__name__)

JELLYFIN_URL = os.environ.get("JELLYFIN_URL", "https://jelly.qureshi.io").rstrip("/")
JELLYFIN_TOKEN = os.environ.get("JELLYFIN_TOKEN", "")
SLAP_API_URL = os.environ.get("SLAP_API_URL", "https://slap.qureshi.io/api/v1").rstrip("/")

TAG = "jellyfin_user"
SSO_PLUGIN = "505ce9d1-d916-42fa-86ca-673ef241d7df"   # 9p4/jellyfin-plugin-sso
SSO_PROVIDER = os.environ.get("JELLYFIN_SSO_PROVIDER", "crcmz")
_PLAYLISTS_FILE = Path(os.environ.get("SLAP_PLAYLISTS_FILE", "/data/slap_playlists.json"))

_ID = re.compile(r"^[0-9a-f]{32}$")
_JF_NAME = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")
_STREAM_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges",
                   "last-modified", "etag")
_TICKS = 10_000_000

# The importer's admin API (rerolling a wrong download), reached inside the Docker network.
SLAP_INTERNAL_URL = os.environ.get("SLAP_INTERNAL_URL", "http://music-importer:8080/api/v1").rstrip("/")
SLAP_ADMIN_TOKEN = os.environ.get("SLAP_ADMIN_TOKEN", "")
_MUSIC_ROOT = "/media/music/"   # where Jellyfin sees the importer's library

_client = httpx.AsyncClient(base_url=JELLYFIN_URL, timeout=httpx.Timeout(20.0, read=60.0))
_social = httpx.AsyncClient(base_url=SLAP_API_URL, timeout=20.0)


def configured() -> bool:
    return bool(JELLYFIN_TOKEN)


def _jf_headers() -> dict[str, str]:
    return {"X-Emby-Token": JELLYFIN_TOKEN}


async def _jf(method: str, path: str, **kw) -> httpx.Response:
    if not configured():
        raise HTTPException(503, "the music library is not configured")
    try:
        return await _client.request(method, path, headers=_jf_headers(), **kw)
    except httpx.HTTPError as e:
        logger.warning("slap: jellyfin %s %s failed: %s", method, path, e)
        raise HTTPException(502, "the music library is unreachable")


def _ok(r: httpx.Response) -> Any:
    if r.status_code == 404:
        raise HTTPException(404, "not found")
    if r.status_code >= 400:
        logger.warning("slap: jellyfin answered %s: %s", r.status_code, r.text[:200])
        raise HTTPException(502, "the music library refused the request")
    if not r.content:
        return None
    try:
        return r.json()
    except ValueError:
        return None


# ── Short caches ─────────────────────────────────────────────────────────────
_cache: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: float) -> Any:
    hit = _cache.get(key)
    return hit[1] if hit and time.time() - hit[0] < ttl else None


def _store(key: str, value: Any) -> Any:
    _cache[key] = (time.time(), value)
    return value


def _forget(prefix: str) -> None:
    for k in [k for k in _cache if k.startswith(prefix)]:
        _cache.pop(k, None)


async def _jf_users(refresh: bool = False) -> dict[str, dict]:
    """Jellyfin users by casefolded name → {id, name}."""
    if not refresh and (hit := _cached("users", 60)) is not None:
        return hit
    users = _ok(await _jf("GET", "/Users")) or []
    return _store("users", {u["Name"].casefold(): {"id": u["Id"], "name": u["Name"]}
                            for u in users if u.get("Name") and u.get("Id")})


# ── Who is calling, as a Jellyfin user ──────────────────────────────────────
_create_locks: dict[str, asyncio.Lock] = {}


def claim_name(person: dict) -> str:
    """What the Zitadel `jellyfinUser` action puts in the SSO claim, same order — the
    name a Jellyfin sign-in by this person uses. '' when they have none, and then
    the plugin names the account after their Zitadel id instead."""
    tags = person.get("tags") or {}
    for key in (TAG, "chosen_username", "mm_username"):
        if v := (tags.get(key) or "").strip():
            return v
    return ""


def jellyfin_name(person: dict) -> str:
    """The Jellyfin username for a person: the claim name, so Slap and a Jellyfin
    sign-in land on the same account, else their Zitadel username."""
    return claim_name(person) or (person.get("username") or "").strip()


async def _sso_links(refresh: bool = False) -> dict[str, str]:
    """The SSO plugin's links, casefolded claim name → Jellyfin userId. A name is
    only here once someone signed in to Jellyfin through Zitadel with that claim."""
    if not refresh and (hit := _cached("sso", 60)) is not None:
        return hit
    try:
        cfg = _ok(await _jf("GET", f"/Plugins/{SSO_PLUGIN}/Configuration")) or {}
    except HTTPException:
        cfg = {}   # plugin missing or Jellyfin down: nothing is linked
    links = (((cfg.get("OidConfigs") or {}).get(SSO_PROVIDER) or {}).get("CanonicalLinks") or {})
    return _store("sso", {str(k).casefold(): str(v).replace("-", "")
                          for k, v in links.items() if k and v})


def _tagged_by_other(name: str, sub: str) -> bool:
    return any(p.get("zitadel_id") != sub and ((p.get("tags") or {}).get(TAG) or "").casefold() == name.casefold()
               for p in crcmz_identity.people())


async def _create_jellyfin_user(name: str) -> dict:
    created = _ok(await _jf("POST", "/Users/New",
                            json={"Name": name, "Password": secrets.token_urlsafe(32)}))
    uid = (created or {}).get("Id")
    if not uid:
        raise HTTPException(502, "the music library didn't create an account")
    policy = dict((created or {}).get("Policy") or {})
    policy.update({
        "IsAdministrator": False, "IsHidden": True, "IsDisabled": False,
        "EnableAllFolders": True, "EnabledFolders": [],
        "EnableContentDeletion": False, "EnableContentDeletionFromFolders": [],
        "EnableRemoteControlOfOtherUsers": False, "EnableMediaPlayback": True,
    })
    _ok(await _jf("POST", f"/Users/{uid}/Policy", json=policy))
    logger.info("slap: created Jellyfin user %s", name)
    return {"id": uid, "name": name}


async def resolve_jellyfin(sub: str, person: dict) -> tuple[dict, bool]:
    """(the caller's Jellyfin user, whether it was created just now)."""
    tag = ((person.get("tags") or {}).get(TAG) or "").strip()
    users = await _jf_users()
    if tag:
        u = users.get(tag.casefold()) or (await _jf_users(refresh=True)).get(tag.casefold())
        if not u:
            raise HTTPException(409, f"your music account '{tag}' no longer exists — ask an admin")
        return u, False
    name = jellyfin_name(person)
    if not _JF_NAME.match(name):
        raise HTTPException(409, "your account has no username a music account can use — ask an admin")
    lock = _create_locks.setdefault(sub, asyncio.Lock())
    async with lock:
        # A second tab may have finished the job while this one waited.
        fresh = (await asyncio.to_thread(crcmz_identity.by_zitadel_id, refresh=True)).get(sub) or {}
        if tag := ((fresh.get("tags") or {}).get(TAG) or "").strip():
            return await resolve_jellyfin(sub, fresh)
        u = (await _jf_users(refresh=True)).get(name.casefold())
        created = u is None
        if u:
            # Their own Zitadel sign-in made it: the SSO link is under the name only their
            # claim carries. Anything else is somebody else's account, or one left
            # unlinked on purpose: never adopt it.
            linked = (claim_name(fresh or person).casefold() == name.casefold()
                      and (await _sso_links(refresh=True)).get(name.casefold()) == u["id"])
            if not linked or await asyncio.to_thread(_tagged_by_other, name, sub):
                raise HTTPException(409, f"a music account named '{name}' already exists — ask an admin to link it")
            logger.info("slap: adopted %s, made by a Jellyfin sign-in", u["name"])
        else:
            u = await _create_jellyfin_user(name)
        if not await asyncio.to_thread(crcmz_identity.set_tag, sub, TAG, u["name"]):
            logger.warning("slap: resolved %s but couldn't write the %s tag", u["name"], TAG)
        await asyncio.to_thread(crcmz_identity.people, refresh=True)
        _forget("users")
        return u, created


async def link_sso_accounts() -> int:
    """Write the `jellyfin_user` tag for everyone who signed in to Jellyfin through
    Zitadel but never opened Slap, so the identity graph knows their account.
    Returns how many it tagged."""
    if not configured():
        return 0
    links = await _sso_links(refresh=True)
    if not links:
        return 0
    by_id = {u["id"]: u for u in (await _jf_users(refresh=True)).values()}
    people = await asyncio.to_thread(crcmz_identity.people, refresh=True)
    tagged = {((p.get("tags") or {}).get(TAG) or "").casefold() for p in people} - {""}
    n = 0
    for p in people:
        if ((p.get("tags") or {}).get(TAG) or "").strip():
            continue
        if not (name := claim_name(p)):
            continue
        u = by_id.get(links.get(name.casefold(), ""))
        if not u or u["name"].casefold() != name.casefold() or name.casefold() in tagged:
            continue
        if await asyncio.to_thread(crcmz_identity.set_tag, p["zitadel_id"], TAG, u["name"]):
            logger.info("slap: tagged %s with Jellyfin account %s", p["zitadel_id"], u["name"])
            tagged.add(name.casefold())
            n += 1
    if n:
        await asyncio.to_thread(crcmz_identity.people, refresh=True)
    return n


# ── Library shaping (allowlisted fields only) ────────────────────────────────
def _track(i: dict) -> dict:
    ud = i.get("UserData") or {}
    return {
        "id": i["Id"],
        "title": i.get("Name") or "",
        "artist": ", ".join(i.get("Artists") or []) or i.get("AlbumArtist") or "",
        "album": i.get("Album") or "",
        "album_id": i.get("AlbumId") or "",
        "album_artist": i.get("AlbumArtist") or "",
        "genres": list(i.get("Genres") or []),
        "year": i.get("ProductionYear"),
        "duration": round((i.get("RunTimeTicks") or 0) / _TICKS, 1),
        "added": i.get("DateCreated") or "",
        "art": i["Id"] if (i.get("ImageTags") or {}).get("Primary") else (i.get("AlbumId") if i.get("AlbumPrimaryImageTag") else None),
        "fav": bool(ud.get("IsFavorite")),
        "plays": int(ud.get("PlayCount") or 0),
    }


async def library_for(user_id: str, refresh: bool = False) -> list[dict]:
    key = f"lib:{user_id}"
    if not refresh and (hit := _cached(key, 45)) is not None:
        return hit
    data = _ok(await _jf("GET", "/Items", params={
        "userId": user_id, "IncludeItemTypes": "Audio", "Recursive": "true",
        "SortBy": "DateCreated", "SortOrder": "Descending",
        "Fields": "DateCreated,Genres", "EnableImageTypes": "Primary",
    })) or {}
    return _store(key, [_track(i) for i in data.get("Items", []) if i.get("Id")])


# ── Playlist ownership ───────────────────────────────────────────────────────
# Jellyfin's API key can't say who owns a playlist, so an edit is allowed on
# playlists created from here (recorded below, keyed by Zitadel id) and on the
# "<name>'s picks" playlists music-importer makes for each person. Admins edit any.
def _owned() -> dict[str, str]:
    try:
        return json.loads(_PLAYLISTS_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _record_owner(pid: str, sub: str) -> None:
    data = _owned()
    data[pid] = sub
    try:
        _PLAYLISTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _PLAYLISTS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(_PLAYLISTS_FILE)
    except OSError as e:
        logger.warning("slap: couldn't record playlist owner: %s", e)


def _names_of(me: dict) -> set[str]:
    p = me["person"]
    return {n.casefold() for n in (me["jf"]["name"], p.get("username"), p.get("mm_username"),
                                   p.get("psn_id")) if n}


# ── Who added a track ────────────────────────────────────────────────────────
# music-importer files every song someone submits into "<name>'s picks", so those
# playlists say who brought a track in. "slapper" is the bot's own playlist (AI
# picks and imports nobody asked for); it only counts when no person claims the song.
_PICKS = re.compile(r"^(.+)'s picks$", re.I)
_BOT_PICKS = {"slapper"}


async def song_adders(track_id: str, people: list[dict]) -> list[dict]:
    """The people whose picks playlist holds this track (identity-graph people, not the bot)."""
    if not _ID.match(track_id or ""):
        return []
    try:
        names = {n.casefold() for n in (await picked_by()).get(track_id, []) if n != "Slap"}
    except HTTPException:
        return []
    if not names:
        return []
    out = []
    for p in people:
        # Names the system gave them (Mattermost, Jellyfin, their login), never a name they
        # picked for themselves: anyone can claim "moiz" as a chosen name.
        tags = p.get("tags") or {}
        login = p.get("username") or ""
        mine = {str(v).casefold() for v in (p.get("mm_username"), tags.get("mm_username"), p.get("jellyfin_user"),
                                             tags.get("jellyfin_user"), "" if "@" in login else login) if v}
        if mine & names and p.get("zitadel_id"):
            out.append(p)
    return out


async def picked_by() -> dict[str, list[str]]:
    """track id → the Slap usernames whose picks playlist holds it ("Slap" for the
    bot). The player shows them by the same short names as the rest of Slap. Cached
    ten minutes."""
    if (hit := _cached("picks", 600)) is not None:
        return hit
    users = await _jf_users()
    if not users:
        return _store("picks", {})
    uid = next(iter(users.values()))["id"]
    data = _ok(await _jf("GET", "/Items", params={
        "userId": uid, "IncludeItemTypes": "Playlist", "Recursive": "true"})) or {}
    people: dict[str, list[str]] = {}
    bots: dict[str, list[str]] = {}
    for pl in data.get("Items", []):
        m = _PICKS.match(pl.get("Name") or "")
        if not m or not pl.get("Id"):
            continue
        owner = m.group(1).strip()
        items = _ok(await _jf("GET", f"/Playlists/{pl['Id']}/Items", params={"userId": uid})) or {}
        into = bots if owner.casefold() in _BOT_PICKS else people
        name = "Slap" if into is bots else owner.casefold()
        for t in items.get("Items", []):
            if (tid := t.get("Id")) and name not in into.setdefault(tid, []):
                into[tid].append(name)
    for tid, names in bots.items():
        people.setdefault(tid, names)
    return _store("picks", people)


# ── Thumbs ───────────────────────────────────────────────────────────────────
# slaptastic keeps thumbs as append-only play events with no way to read them
# back, so the app keeps its own: one row per (track, person), so a thumb shows
# as pressed on every device and everyone sees who rated what.
_THUMBS_DB = Path(os.environ.get("SLAP_THUMBS_DB", "/data/slap_thumbs.db"))
_thumbs_ready = False


def _thumbs() -> sqlite3.Connection:
    global _thumbs_ready
    c = sqlite3.connect(_THUMBS_DB, check_same_thread=False)
    c.row_factory = sqlite3.Row
    if not _thumbs_ready:
        _THUMBS_DB.parent.mkdir(parents=True, exist_ok=True)
        c.execute("""CREATE TABLE IF NOT EXISTS thumbs (
            track_id TEXT NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '',
            value INTEGER NOT NULL, ts REAL NOT NULL, PRIMARY KEY (track_id, sub))""")
        _thumbs_ready = True
    return c


def save_thumb(track_id: str, sub: str, name: str, title: str, artist: str, value: int) -> None:
    with _thumbs() as db:
        if value:
            db.execute("INSERT INTO thumbs(track_id, sub, name, title, artist, value, ts) VALUES (?,?,?,?,?,?,?) "
                       "ON CONFLICT(track_id, sub) DO UPDATE SET value=excluded.value, ts=excluded.ts, "
                       "name=excluded.name", (track_id, sub, name, title, artist, value, time.time()))
        else:
            db.execute("DELETE FROM thumbs WHERE track_id=? AND sub=?", (track_id, sub))


def thumbs_for(track_id: str, sub: str = "") -> dict:
    """Who rated a track up and down, and the caller's own thumb."""
    with _thumbs() as db:
        rows = db.execute("SELECT sub, name, value FROM thumbs WHERE track_id=? ORDER BY ts", (track_id,)).fetchall()
    return {"up": [r["name"] for r in rows if r["value"] > 0],
            "down": [r["name"] for r in rows if r["value"] < 0],
            "mine": next((r["value"] for r in rows if r["sub"] == sub), 0)}


def thumbs_overview(query: str = "", limit: int = 20) -> dict:
    """Recent thumbs by track, for the assistant. Names only, never account ids."""
    q = f"%{query.strip()[:100]}%"
    with _thumbs() as db:
        rows = db.execute(
            "SELECT track_id, MAX(title) title, MAX(artist) artist, MAX(ts) ts, "
            "GROUP_CONCAT(CASE WHEN value > 0 THEN name END, ', ') up, "
            "GROUP_CONCAT(CASE WHEN value < 0 THEN name END, ', ') down "
            "FROM thumbs WHERE title LIKE ? OR artist LIKE ? GROUP BY track_id ORDER BY ts DESC LIMIT ?",
            (q, q, max(1, min(int(limit or 20), 100)))).fetchall()
    return {"tracks": [{"title": r["title"], "artist": r["artist"],
                        "thumbs_up": (r["up"] or "").split(", ") if r["up"] else [],
                        "thumbs_down": (r["down"] or "").split(", ") if r["down"] else [],
                        "last": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"]))} for r in rows]}


def can_edit(me: dict, pid: str, name: str) -> bool:
    if me["admin"] or _owned().get(pid) == me["sub"]:
        return True
    m = re.match(r"^(.+?)['’]s picks$", name or "")
    return bool(m) and m.group(1).casefold() in _names_of(me)


# ── Listen Together ──────────────────────────────────────────────────────────
_QUEUE_MAX = 500


def _now_ms() -> int:
    return int(time.time() * 1000)


class Room:
    """One shared session. ``position`` is the playhead at server time ``at``."""

    def __init__(self) -> None:
        self.queue: list[dict] = []
        self.index = -1
        self.playing = False
        self.position = 0.0
        self.at = _now_ms()
        self.version = 0
        self.by = ""
        self.last = ""
        self.members: dict[str, dict] = {}   # sub → {name, conns, since}
        self._subs: set[asyncio.Queue] = set()

    def head(self) -> float:
        if not self.playing:
            return self.position
        return self.position + (_now_ms() - self.at) / 1000

    def snapshot(self) -> dict:
        return {
            "queue": self.queue, "index": self.index, "playing": self.playing,
            "position": round(self.head(), 2), "at": _now_ms(), "version": self.version,
            "by": self.by, "last": self.last,
            "members": sorted(({"name": m["name"], "since": m["since"]} for m in self.members.values()),
                              key=lambda m: m["since"]),
        }

    def _set_head(self, pos: float, playing: bool | None = None) -> None:
        self.position = max(0.0, pos)
        self.at = _now_ms()
        if playing is not None:
            self.playing = playing

    def _go(self, index: int) -> None:
        if 0 <= index < len(self.queue):
            self.index = index
            self._set_head(0.0, True)
        else:
            self.index = len(self.queue) - 1 if self.queue else -1
            self._set_head(0.0, False)

    def publish(self) -> None:
        self.version += 1
        payload = self.snapshot()
        for q in list(self._subs):
            if q.full():  # a slow client only needs the newest state
                q.get_nowait()
            q.put_nowait(payload)

    def join(self, sub: str, name: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=4)
        self._subs.add(q)
        m = self.members.setdefault(sub, {"name": name, "conns": 0, "since": _now_ms()})
        m["conns"] += 1
        if m["conns"] == 1:
            self.publish()
        else:
            q.put_nowait(self.snapshot())
        return q

    def leave(self, sub: str, q: asyncio.Queue) -> None:
        self._subs.discard(q)
        m = self.members.get(sub)
        if m:
            m["conns"] -= 1
            if m["conns"] <= 0:
                self.members.pop(sub, None)
                if not self.members:
                    # Nobody left to hear it: hold the place rather than run on.
                    self._set_head(self.head(), False)
                self.publish()

    def apply(self, op: str, body: dict, tracks: list[dict], who: str) -> None:
        """Mutate the room. ``tracks`` are server-resolved library rows."""
        n = len(self.queue)
        cur = self.queue[self.index]["qid"] if 0 <= self.index < n else None
        if op == "play":
            if self.index < 0 and self.queue:
                self._go(0)
            else:
                self._set_head(self.head(), bool(self.queue))
            desc = "pressed play"
        elif op == "pause":
            self._set_head(self.head(), False)
            desc = "paused"
        elif op == "seek":
            if self.index < 0:
                raise HTTPException(409, "nothing is playing")
            dur = float(self.queue[self.index].get("duration") or 0) or 1e9
            self._set_head(min(float(body.get("position") or 0), dur))
            desc = "jumped ahead" if self.position else "restarted the track"
        elif op in ("next", "ended"):
            if op == "ended":
                # Every member reports the end; only the first report for this track counts.
                if body.get("qid") != cur:
                    return
            self._go(self.index + 1)
            desc = "skipped" if op == "next" else ""
        elif op == "prev":
            if self.head() > 3 or self.index <= 0:
                self._set_head(0.0)
            else:
                self._go(self.index - 1)
            desc = "went back"
        elif op == "jump":
            i = _int(body.get("index"), -1)
            if not 0 <= i < n:
                raise HTTPException(409, "that track isn't in the queue any more")
            self._go(i)
            desc = f"played {self.queue[i]['title']}"
        elif op in ("add", "next_up", "replace"):
            items = [{**t, "qid": secrets.token_hex(6), "added_by": who} for t in tracks]
            if not items:
                raise HTTPException(400, "no playable tracks")
            if op == "replace":
                self.queue = items[:_QUEUE_MAX]
                self._go(max(0, min(_int(body.get("start"), 0), len(self.queue) - 1)))
                desc = "started a new queue"
            else:
                if n + len(items) > _QUEUE_MAX:
                    raise HTTPException(409, f"the queue holds {_QUEUE_MAX} tracks")
                at = self.index + 1 if op == "next_up" and self.index >= 0 else n
                self.queue[at:at] = items
                if self.index < 0:
                    self._go(0)
                word = "queued" if op == "add" else "put next"
                desc = f"{word} {items[0]['title']}" + (f" +{len(items) - 1}" if len(items) > 1 else "")
        elif op == "remove":
            i = self._find(body.get("qid"))
            gone = self.queue.pop(i)
            if i < self.index:
                self.index -= 1
            elif i == self.index:
                self._go(self.index if self.index < len(self.queue) else -1)
            desc = f"removed {gone['title']}"
        elif op == "move":
            i = self._find(body.get("qid"))
            to = max(0, min(_int(body.get("to"), i), n - 1))
            item = self.queue.pop(i)
            self.queue.insert(to, item)
            self.index = next((k for k, t in enumerate(self.queue) if t["qid"] == cur), -1)
            desc = "reordered the queue"
        elif op == "clear":
            # Keep what's playing; drop everything else.
            self.queue = [self.queue[self.index]] if 0 <= self.index < n else []
            self.index = 0 if self.queue else -1
            if not self.queue:
                self._set_head(0.0, False)
            desc = "cleared the queue"
        else:
            raise HTTPException(400, "unknown command")
        self.by = who
        self.last = f"{who} {desc}" if desc else self.last
        self.publish()

    def _find(self, qid: object) -> int:
        i = next((k for k, t in enumerate(self.queue) if t["qid"] == qid), -1)
        if i < 0:
            raise HTTPException(409, "that track isn't in the queue any more")
        return i


def _int(v: object, default: int) -> int:
    try:
        return int(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


ROOM = Room()
_TOGETHER_OPS = {"play", "pause", "seek", "next", "prev", "ended", "jump", "add", "next_up",
                 "replace", "remove", "move", "clear"}
_QUEUE_FIELDS = ("id", "title", "artist", "album", "album_id", "duration", "art")


def together_status() -> dict:
    """Read-only view of the room for the assistant/MCP."""
    s = ROOM.snapshot()
    cur = s["queue"][s["index"]] if 0 <= s["index"] < len(s["queue"]) else None
    return {
        "active": bool(s["members"]),
        "listeners": [m["name"] for m in s["members"]],
        "playing": s["playing"],
        "now": {k: cur.get(k) for k in ("title", "artist", "album", "added_by")} if cur else None,
        "position_seconds": s["position"],
        "up_next": [{"title": t["title"], "artist": t["artist"], "added_by": t.get("added_by")}
                    for t in s["queue"][s["index"] + 1:s["index"] + 11]],
        "queue_length": len(s["queue"]),
        "last_action": s["last"],
    }


# ── Social (slaptastic) ──────────────────────────────────────────────────────
_SOCIAL_READ = re.compile(
    r"^(dashboard/(stats|hot|listening|leaderboard|recent|genres|timeline|artists|heatmap|"
    r"achievements|hipster|streaks|personalities|hall-of-fame|ai/vibe-check|ai/digest|"
    r"ai/weekly-playlist|user/[\w.@-]{1,64}|ai/recommendations/[\w.@-]{1,64}|"
    r"head-to-head/[\w.@-]{1,64}/[\w.@-]{1,64}|taste-dna/[\w.@-]{1,64}/[\w.@-]{1,64})|"
    r"listening/(now|feed|stats|engagement|insights|comments|user/[\w.@-]{1,64}))$")
_SOCIAL_QUERY = {"limit", "period", "days", "track_id", "offset"}


async def social_get(path: str, params: dict) -> Any:
    if not _SOCIAL_READ.match(path):
        raise HTTPException(404, "not found")
    q = {k: str(v)[:64] for k, v in params.items() if k in _SOCIAL_QUERY}
    key = f"social:{path}?{sorted(q.items())}"
    if (hit := _cached(key, 20)) is not None:
        return hit
    try:
        r = await _social.get(f"/{path}", params=q)
    except httpx.HTTPError as e:
        logger.warning("slap: slaptastic %s failed: %s", path, e)
        raise HTTPException(502, "Slap stats are unreachable")
    if r.status_code >= 400:
        raise HTTPException(404 if r.status_code == 404 else 502, "Slap stats are unavailable")
    return _store(key, r.json())


async def _social_write(method: str, path: str, body: dict) -> Any:
    try:
        r = await _social.request(method, f"/listening/{path}", json=body)
    except httpx.HTTPError as e:
        logger.warning("slap: slaptastic %s failed: %s", path, e)
        raise HTTPException(502, "Slap stats are unreachable")
    if r.status_code >= 400:
        raise HTTPException(502 if r.status_code >= 500 else 400, "Slap didn't take that")
    _forget("social:")
    return r.json() if r.content else {"ok": True}


# ── Reroll: swap a wrong download for the right one ─────────────────────────
# The importer auto-picks a YouTube upload and sometimes picks the wrong song.
# From the player anyone signed in can search again and replace the file; the
# importer keeps the old file, so a bad swap can be put back by hand.
_SOURCE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
                 "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"}
_rerolls: dict[str, dict] = {}   # job id -> {tid, state, error, by, at}
_REROLL_KEEP_S = 3600
_reroll_tasks: set[asyncio.Task] = set()   # held so a running swap isn't garbage-collected


def source_link(url: str) -> str | None:
    """The link if it is an http(s) YouTube or SoundCloud page."""
    from urllib.parse import urlparse
    try:
        u = urlparse((url or "").strip())
    except ValueError:
        return None
    if u.scheme in ("http", "https") and (u.hostname or "").lower() in _SOURCE_HOSTS and len(url) <= 2048:
        return u.geturl()
    return None


def library_rel(path: str) -> str | None:
    """A Jellyfin item path as the importer's library-relative MP3 path."""
    if not path.startswith(_MUSIC_ROOT) or not path.lower().endswith(".mp3") or "/../" in path:
        return None
    return path[len(_MUSIC_ROOT):]


async def _importer(path: str, body: dict, timeout: float) -> dict:
    if not SLAP_ADMIN_TOKEN:
        raise HTTPException(503, "rerolling songs isn't set up yet")
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{SLAP_INTERNAL_URL}{path}", json=body,
                             headers={"Authorization": f"Bearer {SLAP_ADMIN_TOKEN}"})
    except httpx.HTTPError as e:
        logger.warning("slap: importer %s failed: %s", path, e)
        raise HTTPException(502, "the music importer is unreachable")
    if r.status_code >= 400:
        try:
            detail = str(r.json().get("detail") or "")[:200]
        except ValueError:
            detail = ""
        raise HTTPException(409 if r.status_code == 409 else 502 if r.status_code >= 500 else 400,
                            detail or "the music importer didn't take that")
    return r.json()


def reroll_job(jid: str) -> dict | None:
    now = time.time()
    for k in [k for k, v in _rerolls.items() if now - v["at"] > _REROLL_KEEP_S]:
        _rerolls.pop(k, None)
    return _rerolls.get(jid)


# ── @mentions ────────────────────────────────────────────────────────────────
# A comment tags someone with @<handle>. The handle the composer suggests is the
# person's Jellyfin name (what slaptastic keys them by, so its own app agrees);
# their login and Mattermost names, a squashed display name and a unique first
# name work too, because people type what they know.
_MENTION = re.compile(r"(?<![\w@])@([\w.-]{2,64})")


def handle_of(person: dict) -> str:
    # Never the login when it is an email: the composer shows handles to everyone.
    login = person.get("username") or ""
    tags = person.get("tags") or {}
    return re.sub(r"[^\w.-]", "", person.get("jellyfin_user") or tags.get("chosen_username")
                  or person.get("mm_username") or ("" if "@" in login else login))


def _names(v: object) -> list[str]:
    """A comma-separated tag, or the list crcmz_identity already split it into."""
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return re.split(r"[,;]", v) if isinstance(v, str) else []


def _active(p: dict) -> bool:
    return not p.get("state") or p["state"] in ("USER_STATE_ACTIVE", "active")


def aliases(person: dict, public: bool = False) -> list[str]:
    """Every name the identity chart knows someone by, squashed to mention form.

    ``public`` leaves out the login and email, which the composer must not show.
    """
    tags = person.get("tags") or {}
    login = [] if public else [person.get("username"),
                               (person.get("email") or "").split("@")[0] if "@" in (person.get("email") or "") else ""]
    raw = [handle_of(person), *login, person.get("mm_username"), person.get("jellyfin_user"),
           person.get("psn_id"), tags.get("chosen_username"), person.get("display_name"),
           *_names(tags.get("nicknames")), *_names(person.get("wa_names") or tags.get("wa_names"))]
    out: list[str] = []
    for r in raw:
        k = re.sub(r"[^\w.-]", "", r or "").casefold()
        if len(k) >= 2 and k not in out:
            out.append(k)
    return out


def mention_index(people: list[dict]) -> dict[str, dict]:
    """Exact names first, then a unique first name; names two people share are dropped."""
    exact: dict[str, list[dict]] = {}
    firsts: dict[str, list[dict]] = {}
    for p in people:
        if not _active(p):
            continue
        for k in aliases(p):
            if p not in exact.setdefault(k, []):
                exact[k].append(p)
        tags = p.get("tags") or {}
        for name in (p.get("display_name") or "", *_names(p.get("wa_names") or tags.get("wa_names"))):
            if name.split():
                f = re.sub(r"[^\w.-]", "", name.split()[0]).casefold()
                if f and p not in firsts.setdefault(f, []):
                    firsts[f].append(p)
    idx = {k: ps[0] for k, ps in exact.items() if len(ps) == 1}
    for k, ps in firsts.items():
        if len(ps) == 1:
            idx.setdefault(k, ps[0])
    return idx


def mentioned(text: str, people: list[dict]) -> list[dict]:
    """The people a comment tags, once each, in the order they appear.

    ``@moose`` finds themoosecompany: when no name matches exactly, a word that is
    part of exactly one person's names (4+ letters) is taken as them.
    """
    idx = mention_index(people)
    live = [p for p in people if _active(p)]
    out: list[dict] = []
    for m in _MENTION.finditer(text or ""):
        word = m.group(1).rstrip(".-").casefold()
        p = idx.get(word)
        if p is None and len(word) >= 4:
            hits = [q for q in live if any(word in a for a in aliases(q))]
            p = hits[0] if len(hits) == 1 else None
        if p and p not in out:
            out.append(p)
    return out


def mentionable(people: list[dict]) -> list[dict]:
    """Who the composer offers after an @: a handle and the name people know them by."""
    seen, out = set(), []
    for p in people:
        h = handle_of(p)
        if not h or h.casefold() in seen or not _active(p):
            continue
        seen.add(h.casefold())
        # aka: the other names they go by, so typing any of them finds them in the list.
        out.append({"handle": h, "name": p.get("display_name") or p.get("username") or h,
                    "aka": [a for a in aliases(p, public=True) if a != h.casefold()][:8]})
    return sorted(out, key=lambda x: x["name"].casefold())


def _s(v: object, n: int = 300) -> str:
    return str(v or "")[:n]


# ── Router ───────────────────────────────────────────────────────────────────
def build_router(get_session, is_admin) -> APIRouter:
    router = APIRouter(prefix="/api/slap", tags=["slap"])

    async def caller(request: Request) -> dict:
        session = get_session(request)
        sub = (session or {}).get("sub")
        if not sub:
            raise HTTPException(401, "sign in to use Slap")
        people = await asyncio.to_thread(crcmz_identity.by_zitadel_id)
        person = people.get(sub) or (await asyncio.to_thread(crcmz_identity.by_zitadel_id, refresh=True)).get(sub)
        if not person:
            raise HTTPException(403, "your account isn't set up yet")
        jf, created = await resolve_jellyfin(sub, person)
        return {
            "sub": sub, "person": person, "jf": jf, "created": created,
            "slap_user": jf["name"].lower(),
            "name": person.get("display_name") or person.get("username") or jf["name"],
            "admin": await is_admin(sub),
        }

    async def track_rows(me: dict, ids: object) -> list[dict]:
        if not isinstance(ids, list):
            raise HTTPException(400, "ids must be a list")
        lib = {t["id"]: t for t in await library_for(me["jf"]["id"])}
        return [lib[i] for i in ids[:_QUEUE_MAX] if isinstance(i, str) and i in lib]

    async def body_of(request: Request) -> dict:
        try:
            b = await request.json()
        except ValueError:
            raise HTTPException(400, "expected JSON")
        if not isinstance(b, dict):
            raise HTTPException(400, "expected an object")
        return b

    def check_id(i: str) -> str:
        if not _ID.match(i or ""):
            raise HTTPException(404, "not found")
        return i

    @router.get("/me")
    async def me_(request: Request):
        me = await caller(request)
        return {"name": me["name"], "jellyfin_user": me["jf"]["name"], "slap_user": me["slap_user"],
                "created": me["created"], "admin": me["admin"]}

    @router.get("/library")
    async def library(request: Request, refresh: bool = False):
        me = await caller(request)
        tracks = await library_for(me["jf"]["id"], refresh=refresh)
        data = _ok(await _jf("GET", "/Items", params={
            "userId": me["jf"]["id"], "IncludeItemTypes": "Playlist", "Recursive": "true",
            "Fields": "ChildCount,DateCreated", "SortBy": "SortName"})) or {}
        playlists = [{"id": p["Id"], "name": p.get("Name") or "", "count": p.get("ChildCount") or 0,
                      "art": p["Id"] if (p.get("ImageTags") or {}).get("Primary") else None,
                      "editable": can_edit(me, p["Id"], p.get("Name") or "")}
                     for p in data.get("Items", []) if p.get("Id")]
        return {"tracks": tracks, "playlists": playlists}

    @router.get("/playlists/{pid}")
    async def playlist(pid: str, request: Request):
        me = await caller(request)
        check_id(pid)
        info = _ok(await _jf("GET", f"/Items/{pid}", params={"userId": me["jf"]["id"]})) or {}
        items = _ok(await _jf("GET", f"/Playlists/{pid}/Items", params={"userId": me["jf"]["id"]})) or {}
        return {"id": pid, "name": info.get("Name") or "",
                "editable": can_edit(me, pid, info.get("Name") or ""),
                "items": [{"entry": i.get("PlaylistItemId") or "", "id": i["Id"]}
                          for i in items.get("Items", []) if i.get("Id")]}

    @router.post("/playlists")
    async def playlist_new(request: Request):
        me = await caller(request)
        b = await body_of(request)
        name = _s(b.get("name"), 80).strip()
        if not name:
            raise HTTPException(400, "give the playlist a name")
        ids = [t["id"] for t in await track_rows(me, b.get("ids") or [])]
        made = _ok(await _jf("POST", "/Playlists", json={
            "Name": name, "Ids": ids, "UserId": me["jf"]["id"], "MediaType": "Audio"})) or {}
        pid = made.get("Id") or ""
        if not pid:
            raise HTTPException(502, "the playlist wasn't created")
        _record_owner(pid, me["sub"])
        return {"id": pid, "name": name}

    async def editable(me: dict, pid: str) -> None:
        info = _ok(await _jf("GET", f"/Items/{check_id(pid)}", params={"userId": me["jf"]["id"]})) or {}
        if info.get("Type") != "Playlist":
            raise HTTPException(404, "not found")
        if not can_edit(me, pid, info.get("Name") or ""):
            raise HTTPException(403, "that's someone else's playlist")

    @router.post("/playlists/{pid}/items")
    async def playlist_add(pid: str, request: Request):
        me = await caller(request)
        await editable(me, pid)
        ids = [t["id"] for t in await track_rows(me, (await body_of(request)).get("ids"))]
        if not ids:
            raise HTTPException(400, "no playable tracks")
        _ok(await _jf("POST", f"/Playlists/{pid}/Items",
                      params={"ids": ",".join(ids), "userId": me["jf"]["id"]}))
        return {"ok": True, "added": len(ids)}

    @router.post("/playlists/{pid}/remove")
    async def playlist_remove(pid: str, request: Request):
        me = await caller(request)
        await editable(me, pid)
        entries = [e for e in (await body_of(request)).get("entries") or [] if isinstance(e, str) and _ID.match(e)]
        if not entries:
            raise HTTPException(400, "nothing to remove")
        _ok(await _jf("DELETE", f"/Playlists/{pid}/Items", params={"entryIds": ",".join(entries)}))
        return {"ok": True}

    @router.delete("/playlists/{pid}")
    async def playlist_delete(pid: str, request: Request):
        me = await caller(request)
        await editable(me, pid)
        _ok(await _jf("DELETE", f"/Items/{pid}"))
        return {"ok": True}

    @router.post("/favorites/{tid}")
    async def fav_on(tid: str, request: Request):
        me = await caller(request)
        _ok(await _jf("POST", f"/UserFavoriteItems/{check_id(tid)}", params={"userId": me["jf"]["id"]}))
        _forget(f"lib:{me['jf']['id']}")
        return {"ok": True, "fav": True}

    @router.delete("/favorites/{tid}")
    async def fav_off(tid: str, request: Request):
        me = await caller(request)
        _ok(await _jf("DELETE", f"/UserFavoriteItems/{check_id(tid)}", params={"userId": me["jf"]["id"]}))
        _forget(f"lib:{me['jf']['id']}")
        return {"ok": True, "fav": False}

    @router.post("/tracks/{tid}/info")
    async def track_info(tid: str, request: Request):
        """Fix a track's title/artist/album/genre/year (admins, as in slaplayer)."""
        me = await caller(request)
        if not me["admin"]:
            raise HTTPException(403, "only admins can edit track info")
        b = await body_of(request)
        item = _ok(await _jf("GET", f"/Items/{check_id(tid)}", params={"userId": me["jf"]["id"]})) or {}
        if item.get("Type") != "Audio":
            raise HTTPException(404, "not found")
        # Jellyfin's update replaces the whole item, so send it back whole.
        if t := _s(b.get("title"), 200).strip():
            item["Name"] = t
        if a := _s(b.get("artist"), 200).strip():
            item["Artists"] = [a]
            item["ArtistItems"] = [{"Name": a}]
        if "album" in b:
            item["Album"] = _s(b.get("album"), 200).strip()
        if g := _s(b.get("genre"), 80).strip():
            item["Genres"] = [g]
        if (y := _int(b.get("year"), 0)) and 1000 <= y <= 3000:
            item["ProductionYear"] = y
        _ok(await _jf("POST", f"/Items/{tid}", json=item))
        _forget("lib:")
        return {"ok": True}

    async def audio_item(me: dict, tid: str) -> dict:
        item = _ok(await _jf("GET", f"/Items/{check_id(tid)}", params={"userId": me["jf"]["id"], "fields": "Path"})) or {}
        if item.get("Type") != "Audio":
            raise HTTPException(404, "not found")
        return item

    @router.get("/tracks/{tid}/sources")
    async def track_sources(tid: str, request: Request, q: str = ""):
        """Search again for a track: YouTube uploads, best match first."""
        me = await caller(request)
        item = await audio_item(me, tid)
        artist = ", ".join(item.get("Artists") or []) or item.get("AlbumArtist") or ""
        ticks = item.get("RunTimeTicks") or 0
        found = await _importer("/tracks/research", {
            "title": _s(item.get("Name"), 300), "artist": _s(artist, 300),
            "duration_seconds": round(ticks / _TICKS, 1) if ticks else None,
            "query": _s(q, 300).strip(), "limit": 8,
        }, timeout=100)
        return {
            "query": found.get("query", ""),
            "track": {"title": item.get("Name") or "", "artist": artist, "duration": round(ticks / _TICKS) if ticks else 0},
            "candidates": [
                {k: c.get(k) for k in ("url", "title", "channel", "duration_seconds", "view_count", "score")}
                for c in found.get("candidates") or [] if source_link(str(c.get("url") or ""))
            ],
        }

    @router.post("/tracks/{tid}/replace")
    async def track_replace(tid: str, request: Request):
        """Download a YouTube/SoundCloud link in place of this track (for everyone)."""
        me = await caller(request)
        b = await body_of(request)
        url = source_link(_s(b.get("url"), 2048))
        if not url:
            raise HTTPException(400, "use a YouTube or SoundCloud link")
        item = await audio_item(me, tid)
        rel = library_rel(item.get("Path") or "")
        if not rel:
            raise HTTPException(400, "that track can't be replaced from here")
        if any(j["tid"] == tid and j["state"] == "working" for j in _rerolls.values()):
            raise HTTPException(409, "this song is already being replaced")
        jid = secrets.token_urlsafe(9)
        job = _rerolls[jid] = {"tid": tid, "state": "working", "error": "", "by": me["name"], "at": time.time(), "duration": 0}

        async def run() -> None:
            try:
                done = await _importer("/tracks/replace", {"path": rel, "url": url}, timeout=330)
                # Re-read the file so the new length and audio show up.
                await _jf("POST", f"/Items/{tid}/Refresh", params={
                    "Recursive": "false", "MetadataRefreshMode": "Default", "ImageRefreshMode": "None",
                    "ReplaceAllMetadata": "false", "ReplaceAllImages": "false"})
                job.update(state="done", duration=round(float(done.get("duration_seconds") or 0)))
                _forget("lib:")
                logger.info("slap: %s replaced %s (%s) with %s", me["sub"], tid, item.get("Name"), url)
            except HTTPException as e:
                job.update(state="failed", error=str(e.detail))
            except Exception as e:  # noqa: BLE001 - the job must always finish
                logger.warning("slap: reroll of %s failed: %s", tid, e)
                job.update(state="failed", error="the replacement failed")

        task = asyncio.get_running_loop().create_task(run())
        _reroll_tasks.add(task)
        task.add_done_callback(_reroll_tasks.discard)
        return {"job": jid}

    @router.get("/rerolls/{jid}")
    async def reroll_status(jid: str, request: Request):
        await caller(request)
        job = reroll_job(jid)
        if not job:
            raise HTTPException(404, "not found")
        return {k: job[k] for k in ("tid", "state", "error", "duration")}

    async def stream(path: str, request: Request, params: dict | None = None,
                     cache: str = "private, max-age=3600") -> StreamingResponse:
        if not configured():
            raise HTTPException(503, "the music library is not configured")
        # Through Cloudflare the upstream may gzip; ask for the bytes as they are.
        headers = {**_jf_headers(), "Accept-Encoding": "identity"}
        if rng := request.headers.get("range"):
            headers["Range"] = rng
        try:
            up = await _client.send(_client.build_request("GET", path, params=params, headers=headers), stream=True)
        except httpx.HTTPError as e:
            logger.warning("slap: stream %s failed: %s", path, e)
            raise HTTPException(502, "the music library is unreachable")
        if up.status_code >= 400:
            await up.aclose()
            raise HTTPException(404 if up.status_code == 404 else 502, "unavailable")
        out = {k: v for k in _STREAM_HEADERS if (v := up.headers.get(k))}
        out["Cache-Control"] = cache
        # Still encoded anyway: decode it here, so the length no longer applies.
        encoded = up.headers.get("content-encoding", "identity").lower() != "identity"
        if encoded:
            out.pop("content-length", None)
        body = up.aiter_bytes() if encoded else up.aiter_raw()
        return StreamingResponse(body, status_code=up.status_code, headers=out,
                                 background=BackgroundTask(up.aclose))

    @router.get("/stream/{tid}")
    async def audio(tid: str, request: Request):
        await caller(request)
        return await stream(f"/Audio/{check_id(tid)}/stream", request, {"static": "true"})

    @router.get("/art/{iid}")
    async def art(iid: str, request: Request, size: int = 300):
        await caller(request)
        size = 600 if size > 300 else 300 if size > 96 else 96
        return await stream(f"/Items/{check_id(iid)}/Images/Primary", request,
                            {"maxHeight": size, "maxWidth": size, "quality": 85},
                            cache="private, max-age=86400")

    # Social reads, then writes stamped with the caller's own Slap username.
    @router.get("/social/{path:path}")
    async def social(path: str, request: Request):
        await caller(request)
        return await social_get(path, dict(request.query_params))

    def track_fields(b: dict) -> dict:
        return {"track_id": check_id(_s(b.get("track_id"), 32)), "title": _s(b.get("title")),
                "artist": _s(b.get("artist")), "album": _s(b.get("album")) or None}

    @router.post("/listen/{kind}")
    async def listen(kind: str, request: Request):
        if kind not in ("play", "skip"):
            raise HTTPException(404, "not found")
        me = await caller(request)
        b = await body_of(request)
        dur = max(0, min(_int(b.get("duration_seconds"), 0), 36000))
        heard = max(0, min(_int(b.get("listened_seconds"), 0), dur or 36000))
        return await _social_write("POST", kind, {
            **track_fields(b), "username": me["slap_user"], "duration_seconds": dur,
            "listened_seconds": heard, "completed": bool(b.get("completed")) and kind == "play",
            "hour_of_day": max(0, min(_int(b.get("hour_of_day"), 0), 23)),
            "skipped": kind == "skip", "thumbs": max(-1, min(_int(b.get("thumbs"), 0), 1))})

    @router.post("/thumb")
    async def thumb(request: Request):
        me = await caller(request)
        b = await body_of(request)
        f = track_fields(b)
        v = max(-1, min(_int(b.get("thumbs"), 0), 1))
        await asyncio.to_thread(save_thumb, f["track_id"], me["sub"], me["slap_user"], f["title"], f["artist"], v)
        try:  # slaptastic's taste stats learn from it too; the thumb stands either way
            await _social_write("POST", "thumb", {
                "username": me["slap_user"], "track_id": f["track_id"], "title": f["title"],
                "artist": f["artist"], "thumbs": v})
        except HTTPException as e:
            logger.warning("slap: thumb not forwarded to slaptastic: %s", e.detail)
        return await asyncio.to_thread(thumbs_for, f["track_id"], me["sub"])

    # ── Discover: this week's new finds ──────────────────────────────────────
    import slap_discover as discover

    def kick_generate() -> None:
        if discover.needs_finds(discover.week_of()) and not discover._gen_lock.locked():
            task = asyncio.create_task(discover.generate())
            _reroll_tasks.add(task)
            task.add_done_callback(_reroll_tasks.discard)

    @router.get("/discover")
    async def discover_get(request: Request):
        await caller(request)
        kick_generate()
        try:
            await discover.follow_downloads()
        except HTTPException as e:
            logger.info("slap: discover couldn't check downloads: %s", e.detail)
        return {**await asyncio.to_thread(discover.current), "making": discover._gen_lock.locked()}

    @router.post("/discover/download")
    async def discover_download(request: Request):
        me = await caller(request)
        b = await body_of(request)
        fid = _s(b.get("id"), 20)
        if not fid.isdigit():
            raise HTTPException(400, "which song?")
        return await discover.download(me["sub"], me["slap_user"], fid, picks=discover.picks_name(me["person"]),
                                       requester=await asyncio.to_thread(discover.mm_id, me["person"]))

    @router.post("/discover/approve")
    async def discover_approve(request: Request):
        me = await caller(request)
        if not me["admin"]:
            raise HTTPException(403, "admins only")
        fid = _s((await body_of(request)).get("id"), 20)
        return await discover.approve(fid)

    @router.get("/track/{tid}")
    async def track_social(tid: str, request: Request):
        """What the player shows beside a track: who added it and who thumbed it."""
        me = await caller(request)
        check_id(tid)
        try:
            by = (await picked_by()).get(tid, [])
        except HTTPException:
            by = []
        return {"picked_by": by, "thumbs": await asyncio.to_thread(thumbs_for, tid, me["sub"])}

    @router.post("/comment")
    async def comment(request: Request):
        me = await caller(request)
        b = await body_of(request)
        text = _s(b.get("text"), 500).strip()
        if not text:
            raise HTTPException(400, "say something")
        f = track_fields(b)
        reaction = bool(b.get("is_reaction"))
        res = await _social_write("POST", "comment", {
            "username": me["slap_user"], "track_id": f["track_id"], "title": f["title"],
            "artist": f["artist"], "text": text, "is_reaction": reaction})
        people = await asyncio.to_thread(crcmz_identity.people)
        tagged = [] if reaction else [p for p in mentioned(text, people) if p["zitadel_id"] != me["sub"]]
        song = f["title"] or "a track"
        by = f" by {f['artist']}" if f["artist"] else ""
        url = f"/app/slap?track={f['track_id']}" if _ID.match(f["track_id"] or "") else "/app/slap"
        if tagged:
            notifications.route_in_background(
                "mentions", f"{me['name']} mentioned you on Slap", f"“{text[:200]}” · {song}{by}",
                url, exclude=me["sub"], only=[p["zitadel_id"] for p in tagged], tag=f"slap-{f['track_id']}",
                dm_text=f"🎵 {me['name']} mentioned you on Slap: “{text[:300]}” on {song}{by}")
        # Whoever added the song hears about a comment on it, @mention or not (once: a
        # mention already told them). Emoji reactions don't count.
        adders = [] if reaction else await song_adders(f["track_id"], people)
        told = {p["zitadel_id"] for p in tagged} | {me["sub"]}
        adders = [p for p in adders if p["zitadel_id"] not in told]
        if adders:
            notifications.route_in_background(
                "mentions", f"{me['name']} commented on your song", f"“{text[:200]}” · {song}{by}",
                url, exclude=me["sub"], only=[p["zitadel_id"] for p in adders], tag=f"slap-{f['track_id']}",
                dm_text=f"🎵 {me['name']} commented on {song}{by}, a song you added on Slap: “{text[:300]}”")
        if isinstance(res, dict):
            res = {**res, "mentioned": [p.get("display_name") or handle_of(p) for p in tagged]}
        return res

    @router.get("/mentionable")
    async def mentionable_(request: Request):
        if not (get_session(request) or {}).get("sub"):
            raise HTTPException(401, "sign in to use Slap")
        return {"people": mentionable(await asyncio.to_thread(crcmz_identity.people))}

    @router.get("/settings")
    async def settings(request: Request):
        me = await caller(request)
        try:
            r = await _social.get("/listening/settings", params={"username": me["slap_user"]})
        except httpx.HTTPError:
            raise HTTPException(502, "Slap stats are unreachable")
        if r.status_code >= 400:
            raise HTTPException(502, "Slap settings are unavailable")
        return r.json()

    @router.put("/settings")
    async def settings_put(request: Request):
        me = await caller(request)
        b = await body_of(request)
        body: dict[str, Any] = {"username": me["slap_user"]}
        if "display_name" in b:
            body["display_name"] = _s(b.get("display_name"), 40).strip() or None
        if "color" in b:
            c = _s(b.get("color"), 7)
            if c and not re.match(r"^#[0-9a-fA-F]{6}$", c):
                raise HTTPException(400, "colour must look like #22e6ff")
            body["color"] = c or None
        for k in ("notify_mentions", "collect_plays"):
            if k in b:
                body[k] = bool(b[k])
        return await _social_write("PUT", "settings", body)

    # Listen Together
    @router.get("/together")
    async def together(request: Request):
        await caller(request)
        return ROOM.snapshot()

    @router.get("/together/events")
    async def together_events(request: Request):
        me = await caller(request)

        async def events():
            q = ROOM.join(me["sub"], me["name"])
            try:
                yield "retry: 3000\n\n"
                while True:
                    try:
                        state = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"event: state\ndata: {json.dumps(state)}\n\n"
                    except asyncio.TimeoutError:
                        yield f": ping {_now_ms()}\n\n"
            finally:
                ROOM.leave(me["sub"], q)

        return StreamingResponse(events(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

    @router.post("/together")
    async def together_cmd(request: Request):
        me = await caller(request)
        b = await body_of(request)
        op = _s(b.get("op"), 20)
        if op not in _TOGETHER_OPS:
            raise HTTPException(400, "unknown command")
        if me["sub"] not in ROOM.members:
            raise HTTPException(409, "join Listen Together first")
        tracks = []
        if op in ("add", "next_up", "replace"):
            tracks = [{k: t[k] for k in _QUEUE_FIELDS} for t in await track_rows(me, b.get("ids"))]
        ROOM.apply(op, b, tracks, me["name"])
        return ROOM.snapshot()

    return router


# ── Sync helpers for assistant tools (read-only) ─────────────────────────────
def library_search_sync(query: str, limit: int = 20) -> dict:
    if not configured():
        return {"error": "the music library is not configured"}
    try:
        r = httpx.get(f"{JELLYFIN_URL}/Items", headers=_jf_headers(), timeout=15, params={
            "IncludeItemTypes": "Audio", "Recursive": "true", "SearchTerm": query[:100],
            "Limit": limit, "Fields": "DateCreated,Genres"})
        r.raise_for_status()
    except httpx.HTTPError as e:
        return {"error": f"music library unavailable: {e.__class__.__name__}"}
    items = r.json().get("Items", [])
    return {"tracks": [{k: t[k] for k in ("title", "artist", "album", "genres", "year", "duration", "added")}
                       for t in (_track(i) for i in items if i.get("Id"))]}


def social_sync(path: str, params: dict | None = None) -> dict:
    if not _SOCIAL_READ.match(path):
        return {"error": "unknown Slap stats view"}
    try:
        r = httpx.get(f"{SLAP_API_URL}/{path}", params=params or {}, timeout=15)
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        return {"error": f"Slap stats unavailable: {e.__class__.__name__}"}
