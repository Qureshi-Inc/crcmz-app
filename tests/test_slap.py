#!/usr/bin/env python3
"""Slap: Jellyfin identity, the proxy's allowlists, stamped social writes, Listen Together.

Plain asserts, no pytest -- run inside the app image where the deps live:

    docker build -t crcmz-app:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_slap.py

Local HTTP servers stand in for Jellyfin and slaptastic, so the real httpx path
runs and every request the proxy makes is recorded.
"""

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

JF_LOG: list[tuple[str, str, dict, dict | None, dict]] = []
SOCIAL_LOG: list[tuple[str, str, dict | None]] = []
USERS = [{"Name": "moiz", "Id": "a" * 32}, {"Name": "shahraiz", "Id": "b" * 32},
         {"Name": "mazino", "Id": "d" * 32}, {"Name": "babefaze", "Id": "e" * 32}]
# "<name>'s picks" contents, and playlists only the who-added test turns on.
PLAYLIST_ITEMS = {"4" * 32: ["1" * 32], "5" * 32: ["1" * 32], "6" * 32: ["1" * 32, "3" * 32]}
EXTRA_PLAYLISTS: list[dict] = []
SSO = "505ce9d1-d916-42fa-86ca-673ef241d7df"
# Made by Zitadel sign-ins to Jellyfin; the plugin stores the GUID with dashes.
LINKS = {"moiz": "a" * 32, "mazino": "dddddddd-dddd-dddd-dddd-dddddddddddd",
         "babefaze": "e" * 32, "shahraiz": "b" * 32}
TRACKS = [
    {"Id": "1" * 32, "Name": "Breezeblocks", "Artists": ["alt-J"], "Album": "An Awesome Wave",
     "AlbumId": "2" * 32, "RunTimeTicks": 2457120000, "ImageTags": {"Primary": "x"},
     "UserData": {"IsFavorite": True, "PlayCount": 3}, "Path": "/secret/path.mp3"},
    {"Id": "3" * 32, "Name": "Tessellate", "Artists": ["alt-J"], "RunTimeTicks": 1820000000},
]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n)) if n else None

    def _send(self, code, obj=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b"")
        self.send_response(code)
        for k, v in (headers or {"Content-Type": "application/json"}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        body = self._body() if method in ("POST", "PUT") else None
        if self.server.kind == "social":
            SOCIAL_LOG.append((method, u.path, body))
            return self._send(200, {"ok": True, "path": u.path, "q": q})
        JF_LOG.append((method, u.path, q, body, dict(self.headers)))
        if self.headers.get("X-Emby-Token") != "jf-key":
            return self._send(401, {})
        p = u.path
        if p.startswith("/Items/") and p.endswith("/Images/Primary"):
            # Like Cloudflare: gzip even an image, whatever the client asked for.
            import gzip
            return self._send(200, raw=gzip.compress(b"\xff\xd8\xffJPEG"), headers={
                "Content-Type": "image/jpeg", "Content-Encoding": "gzip"})
        if p == "/Users" and method == "GET":
            return self._send(200, USERS)
        if p == "/Users/New":
            USERS.append({"Name": body["Name"], "Id": "c" * 32})
            return self._send(200, {"Id": "c" * 32, "Name": body["Name"], "Policy": {"IsAdministrator": True}})
        if p == f"/Plugins/{SSO}/Configuration":
            return self._send(200, {"OidConfigs": {"crcmz": {"CanonicalLinks": LINKS}}})
        if p.startswith("/Users/") and p.endswith("/Policy"):
            return self._send(204)
        if p == "/Library/MediaFolders":
            return self._send(200, {"Items": [{"Id": "m" * 32, "CollectionType": "music"},
                                               {"Id": "v" * 32, "CollectionType": "movies"}]})
        if p == "/Items" and q.get("IncludeItemTypes") == "Audio":
            return self._send(200, {"Items": TRACKS})
        if p == "/Items" and q.get("IncludeItemTypes") == "Playlist":
            return self._send(200, {"Items": [
                {"Id": "4" * 32, "Name": "moiz's picks", "ChildCount": 2},
                {"Id": "5" * 32, "Name": "shahraiz's picks", "ChildCount": 1}, *EXTRA_PLAYLISTS]})
        if p.startswith("/Playlists/") and p.endswith("/Items") and method == "GET":
            return self._send(200, {"Items": [{"Id": i} for i in PLAYLIST_ITEMS.get(p.split("/")[2], [])]})
        if p.startswith("/Items/") and method == "GET":
            iid = p.split("/")[2]
            names = {"4" * 32: "moiz's picks", "5" * 32: "shahraiz's picks"}
            if iid in names:
                return self._send(200, {"Id": iid, "Name": names[iid], "Type": "Playlist"})
            return self._send(200, {"Id": iid, "Name": "Breezeblocks", "Type": "Audio", "Artists": ["alt-J"]})
        if p.startswith("/Audio/"):
            return self._send(206, raw=b"ID3abc", headers={
                "Content-Type": "audio/mpeg", "Content-Range": "bytes 0-5/100", "Accept-Ranges": "bytes"})
        return self._send(200, {})

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")


def serve(kind):
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    srv.kind = kind
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}"


os.environ["JELLYFIN_URL"] = serve("jf")
os.environ["JELLYFIN_TOKEN"] = "jf-key"
os.environ["SLAP_API_URL"] = serve("social")
os.environ["SLAP_PLAYLISTS_FILE"] = os.path.join(tempfile.mkdtemp(), "slap_playlists.json")
os.environ["SLAP_THUMBS_DB"] = os.path.join(tempfile.mkdtemp(), "slap_thumbs.db")
os.environ.setdefault("SESSION_SECRET", "test-secret")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import crcmz_identity  # noqa: E402
import slap  # noqa: E402

PEOPLE = {
    "100": {"zitadel_id": "100", "username": "InterestingSoup", "display_name": "Moiz",
            "mm_username": "moiz", "tags": {"jellyfin_user": "moiz"}},
    "200": {"zitadel_id": "200", "username": "ace", "display_name": "Zubair", "tags": {}},
    "300": {"zitadel_id": "300", "username": "shahraiz", "display_name": "Imposter", "tags": {}},
    # Invited: Zitadel username is the email, the picked name is a tag.
    "400": {"zitadel_id": "400", "username": "rayyan@example.com", "display_name": "Mazino",
            "tags": {"chosen_username": "mazino", "mm_username": "mazino"}},
    "500": {"zitadel_id": "500", "username": "faze@example.com", "display_name": "Faze",
            "tags": {"chosen_username": "babefaze", "mm_username": "babefaze"}},
    # Claims a name someone else's tag already holds.
    "600": {"zitadel_id": "600", "username": "x@example.com", "display_name": "Copycat",
            "tags": {"chosen_username": "moiz"}},
}
TAG_WRITES: list[tuple] = []


def _set_tag(uid, key, value):
    TAG_WRITES.append((uid, key, value))
    PEOPLE[uid]["tags"][key] = value
    return True


crcmz_identity.by_zitadel_id = lambda refresh=False: PEOPLE
crcmz_identity.people = lambda refresh=False: list(PEOPLE.values())
crcmz_identity.set_tag = _set_tag

WHO = {"sub": "100"}
ADMINS: set[str] = set()


async def is_admin(sub):
    return sub in ADMINS


app = FastAPI()
app.include_router(slap.build_router(lambda r: {"sub": WHO["sub"]} if WHO["sub"] else None, is_admin))
client = TestClient(app)

FAILED: list[str] = []
PASSED = 0


def check(name, fn):
    global PASSED
    try:
        fn()
        PASSED += 1
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def as_(sub):
    WHO["sub"] = sub
    slap._forget("")


# ── identity ─────────────────────────────────────────────────────────────────
def t_tagged():
    as_("100")
    r = client.get("/api/slap/me").json()
    assert r["jellyfin_user"] == "moiz" and r["slap_user"] == "moiz" and not r["created"], r


def t_signed_out():
    as_(None)
    assert client.get("/api/slap/me").status_code == 401


def t_autocreate():
    as_("200")
    JF_LOG.clear()
    r = client.get("/api/slap/me").json()
    assert r["created"] and r["jellyfin_user"] == "ace", r
    assert TAG_WRITES == [("200", "jellyfin_user", "ace")], TAG_WRITES
    pol = next(b for m, p, q, b, h in JF_LOG if p.endswith("/Policy"))
    assert pol["IsAdministrator"] is False and pol["EnableAllFolders"] is True, pol
    assert client.get("/api/slap/me").json()["created"] is False  # only once


def t_never_adopts():
    # Linked by somebody's Jellyfin sign-in, but no claim of theirs says "shahraiz".
    as_("300")
    r = client.get("/api/slap/me")
    assert r.status_code == 409 and "already exists" in r.json()["detail"], r.text
    assert PEOPLE["300"]["tags"] == {}


def t_name_matches_the_sso_claim():
    # Same order as the Zitadel jellyfinUser action.
    assert slap.jellyfin_name(PEOPLE["400"]) == "mazino"
    assert slap.jellyfin_name({"username": "ace", "tags": {"mm_username": "zubair221b"}}) == "zubair221b"
    assert slap.jellyfin_name({"username": "ace", "tags": {}}) == "ace"
    assert slap.claim_name({"username": "ace", "tags": {}}) == ""


def t_adopts_own_sso_account():
    as_("400")
    TAG_WRITES.clear()
    JF_LOG.clear()
    r = client.get("/api/slap/me").json()
    assert r["jellyfin_user"] == "mazino" and not r["created"], r
    assert TAG_WRITES == [("400", "jellyfin_user", "mazino")], TAG_WRITES
    assert not any(p == "/Users/New" for m, p, q, b, h in JF_LOG), "made a second account"


def t_never_adopts_a_tagged_account():
    as_("600")
    LINKS["moiz"] = "a" * 32
    r = client.get("/api/slap/me")
    assert r.status_code == 409, r.text
    assert "jellyfin_user" not in PEOPLE["600"]["tags"]


def t_sweep_tags_jellyfin_sign_ins():
    import asyncio
    TAG_WRITES.clear()
    n = asyncio.run(slap.link_sso_accounts())
    assert ("500", "jellyfin_user", "babefaze") in TAG_WRITES, TAG_WRITES
    assert not any(uid in ("300", "600") for uid, k, v in TAG_WRITES), TAG_WRITES
    assert n == len(TAG_WRITES)
    TAG_WRITES.clear()
    assert asyncio.run(slap.link_sso_accounts()) == 0   # once


# ── library + proxy ──────────────────────────────────────────────────────────
def t_library_allowlist():
    as_("100")
    d = client.get("/api/slap/library").json()
    t = d["tracks"][0]
    assert set(t) == {"id", "title", "artist", "album", "album_id", "album_artist", "genres", "year",
                      "duration", "added", "art", "fav", "plays"}, set(t)
    assert t["duration"] == 245.7 and t["fav"] and t["art"] == "1" * 32
    assert "secret" not in json.dumps(d)
    ed = {p["name"]: p["editable"] for p in d["playlists"]}
    assert ed == {"moiz's picks": True, "shahraiz's picks": False}, ed
    q = next(q for m, p, q, b, h in JF_LOG if p == "/Items" and q.get("IncludeItemTypes") == "Audio")
    assert q["userId"] == "a" * 32


def t_stream_range():
    as_("100")
    JF_LOG.clear()
    r = client.get(f"/api/slap/stream/{'1' * 32}", headers={"Range": "bytes=0-5"})
    assert r.status_code == 206 and r.content == b"ID3abc" and r.headers["content-range"] == "bytes 0-5/100"
    assert JF_LOG[-1][4].get("Range") == "bytes=0-5"
    assert "jf-key" not in json.dumps(dict(r.headers))


def t_art_decoded():
    as_("100")
    JF_LOG.clear()
    r = client.get(f"/api/slap/art/{'1' * 32}?size=96")
    assert r.status_code == 200 and r.content == b"\xff\xd8\xffJPEG", r.content[:8]
    assert r.headers["content-type"] == "image/jpeg" and "content-encoding" not in r.headers
    assert JF_LOG[-1][4].get("Accept-Encoding") == "identity"


def t_bad_ids():
    as_("100")
    assert client.get("/api/slap/stream/..%2FUsers").status_code == 404
    assert client.get("/api/slap/art/abc").status_code == 404


def t_playlist_perms():
    as_("100")
    assert client.post(f"/api/slap/playlists/{'5' * 32}/items", json={"ids": ["1" * 32]}).status_code == 403
    assert client.post(f"/api/slap/playlists/{'4' * 32}/items", json={"ids": ["1" * 32, "9" * 32]}).json()["added"] == 1
    ADMINS.add("100")
    assert client.post(f"/api/slap/playlists/{'5' * 32}/items", json={"ids": ["1" * 32]}).status_code == 200
    ADMINS.discard("100")


def t_track_info_admin():
    as_("100")
    assert client.post(f"/api/slap/tracks/{'1' * 32}/info", json={"title": "x"}).status_code == 403


# ── social ───────────────────────────────────────────────────────────────────
def t_social_allowlist():
    as_("100")
    assert client.get("/api/slap/social/dashboard/stats").status_code == 200
    assert client.get("/api/slap/social/dashboard/head-to-head/moiz/noor").status_code == 200
    assert client.get("/api/slap/social/listening/play").status_code == 404
    assert client.get("/api/slap/social/dashboard/ai/generate-playlists").status_code == 404
    assert client.get("/api/slap/social/..%2F..%2Fadmin").status_code == 404


def t_stamped():
    as_("100")
    SOCIAL_LOG.clear()
    base = {"track_id": "1" * 32, "title": "Breezeblocks", "artist": "alt-J", "username": "noor"}
    client.post("/api/slap/listen/play", json={**base, "duration_seconds": 245, "listened_seconds": 9999})
    client.post("/api/slap/thumb", json={**base, "thumbs": 7})
    client.post("/api/slap/comment", json={**base, "text": "tune"})
    client.put("/api/slap/settings", json={"username": "noor", "color": "#22e6ff"})
    users = [b["username"] for m, p, b in SOCIAL_LOG]
    assert users == ["moiz"] * 4, users
    assert SOCIAL_LOG[0][2]["listened_seconds"] == 245 and SOCIAL_LOG[1][2]["thumbs"] == 1


def t_thumbs_persist_and_show_who():
    as_("100")
    SOCIAL_LOG.clear()
    with slap._thumbs() as db:
        db.execute("DELETE FROM thumbs")
    t = {"track_id": "1" * 32, "title": "Breezeblocks", "artist": "alt-J"}
    r = client.post("/api/slap/thumb", json={**t, "thumbs": 1}).json()
    assert r == {"up": ["moiz"], "down": [], "mine": 1}, r
    assert SOCIAL_LOG[-1][2]["thumbs"] == 1, "slaptastic still hears about it"
    as_("200")
    client.post("/api/slap/thumb", json={**t, "thumbs": -1})
    r = client.get("/api/slap/track/" + "1" * 32).json()["thumbs"]
    assert r == {"up": ["moiz"], "down": ["ace"], "mine": -1}, r
    client.post("/api/slap/thumb", json={**t, "thumbs": 1})
    client.post("/api/slap/thumb", json={**t, "thumbs": 0})
    as_("100")
    r = client.get("/api/slap/track/" + "1" * 32).json()["thumbs"]
    assert r == {"up": ["moiz"], "down": [], "mine": 1}, "one thumb each, and 0 takes it back"
    out = slap.thumbs_overview("alt")
    assert out["tracks"][0]["thumbs_up"] == ["moiz"] and "100" not in json.dumps(out)
    assert client.get("/api/slap/track/nope").status_code == 404
    as_(None)
    assert client.get("/api/slap/track/" + "1" * 32).status_code == 401


def t_who_added_comes_from_picks_playlists():
    as_("100")
    EXTRA_PLAYLISTS.append({"Id": "6" * 32, "Name": "slapper's picks"})
    try:
        r = client.get("/api/slap/track/" + "1" * 32).json()
        assert r["picked_by"] == ["moiz", "shahraiz"], "Slap usernames, the bot dropped"
        assert client.get("/api/slap/track/" + "3" * 32).json()["picked_by"] == ["Slap"], "the bot only when nobody else"
        assert client.get("/api/slap/track/" + "f" * 32).json()["picked_by"] == []
    finally:
        EXTRA_PLAYLISTS.clear()


# ── Listen Together ──────────────────────────────────────────────────────────
def room():
    r = slap.Room()
    r.members["x"] = {"name": "Moiz", "conns": 1, "since": 0}
    return r


def trk(n):
    return {"id": str(n) * 32, "title": f"T{n}", "artist": "A", "album": "", "album_id": "",
            "duration": 100.0, "art": None}


def t_room_queue():
    r = room()
    r.apply("add", {}, [trk(1), trk(2)], "Moiz")
    assert r.index == 0 and r.playing and len(r.queue) == 2
    r.apply("next_up", {}, [trk(3)], "Noor")
    assert [t["title"] for t in r.queue] == ["T1", "T3", "T2"]
    assert r.last == "Noor put next T3"
    cur = r.queue[0]["qid"]
    r.apply("move", {"qid": r.queue[2]["qid"], "to": 0}, [], "Moiz")
    assert r.queue[r.index]["qid"] == cur and r.index == 1
    r.apply("remove", {"qid": cur}, [], "Moiz")
    assert r.queue[r.index]["title"] == "T3" and r.playing


def t_room_ended_once():
    r = room()
    r.apply("add", {}, [trk(1), trk(2)], "Moiz")
    q0 = r.queue[0]["qid"]
    v = r.version
    r.apply("ended", {"qid": q0}, [], "Moiz")
    r.apply("ended", {"qid": q0}, [], "Noor")   # second report of the same end
    assert r.index == 1 and r.version == v + 1
    r.apply("ended", {"qid": r.queue[1]["qid"]}, [], "Moiz")
    assert not r.playing


def t_room_seek_pause():
    r = room()
    r.apply("add", {}, [trk(1)], "Moiz")
    r.apply("seek", {"position": 500}, [], "Moiz")
    assert r.position == 100.0
    r.apply("pause", {}, [], "Moiz")
    p = r.head()
    assert not r.playing and r.head() == p
    try:
        slap.Room().apply("seek", {"position": 1}, [], "x")
        raise AssertionError("seek with nothing playing should refuse")
    except HTTPException as e:
        assert e.status_code == 409


def t_room_leave_pauses():
    r = slap.Room()
    q = r.join("a", "Moiz")
    r.apply("add", {}, [trk(1)], "Moiz")
    r.leave("a", q)
    assert not r.members and not r.playing


def t_together_needs_join():
    as_("100")
    r = client.post("/api/slap/together", json={"op": "play"})
    assert r.status_code == 409


def t_together_resolves_server_side():
    as_("100")
    slap.ROOM.members["100"] = {"name": "Moiz", "conns": 1, "since": 0}
    r = client.post("/api/slap/together", json={"op": "add", "ids": ["1" * 32, "f" * 32]}).json()
    assert len(r["queue"]) == 1 and r["queue"][0]["title"] == "Breezeblocks"
    assert r["queue"][0]["added_by"] == "Moiz"
    s = slap.together_status()
    assert s["now"]["title"] == "Breezeblocks" and s["listeners"] == ["Moiz"]  # names, never Zitadel ids
    slap.ROOM.members.clear()


def t_tools_registered():
    import assistant
    names = assistant.tool_names()
    for n in ("slap_library_search", "slap_together", "slap_stats", "slap_thumbs"):
        assert n in names, n
    assert "error" in assistant._slap_stats("nope")


print("slap")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)
print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
