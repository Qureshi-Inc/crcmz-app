"""Friend deck: the squad's view of Moiz's Ragnaros stream deck (/app/deck).

A signed-in squad member sees the deck's soundboard page live and can press the
keys meant for friends: three sounds and the Hasaan keys (talk, roast, session,
stop). Volume knobs, the headset mic, the studio light and HDMI are not on it.

The deck keys, strip and live state are a signed-in proxy: the allowlist, the
commands each key runs and the live state live in Deck Manager on opti3
(`frienddeck.py` there), reached over the LAN at FRIEND_DECK_URL.

Custom sounds are web-only tiles the squad adds here (upload, YouTube or a
link), each with a picture they pick. The clip itself goes to the squad Pi
through `audio_sounds` (so it is on the Soundboard page too); this module only
keeps which clips are on the web deck, in what order, and their pictures:
  /data/web-deck.json             {"sounds": [{"name", "by", "at"}]}
  /data/deck-sound-images/<name>.png   the picture someone uploaded (else the AI one)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse

import audio_sounds

WEB_DECK_FILE = Path("/data/web-deck.json")
DECK_IMAGES = Path("/data/deck-sound-images")
WEB_DECK_MAX = 40
IMAGE_MAX_BYTES = 10 * 1024 * 1024
_web_lock = threading.Lock()
_last_play: dict[str, float] = {}
# MyInstants pages and direct audio files go through server.py's fetcher; any other
# link (YouTube, TikTok, Instagram, X, ...) goes through yt-dlp and can be trimmed.
_DIRECT = re.compile(r"(^https?://([a-z0-9-]+\.)*myinstants\.com/)|(\.(mp3|wav|ogg|m4a|aac|opus|flac)(\?.*)?$)", re.I)
_URL_IN_TEXT = re.compile(r"https?://\S+")


def _load_web() -> list[dict]:
    try:
        data = json.loads(WEB_DECK_FILE.read_text())
        return [s for s in data.get("sounds", []) if isinstance(s, dict) and audio_sounds._valid_name(s.get("name", ""))]
    except (OSError, ValueError):
        return []


def _save_web(items: list[dict]) -> None:
    WEB_DECK_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = WEB_DECK_FILE.with_name(f".{WEB_DECK_FILE.name}.tmp")
    tmp.write_text(json.dumps({"sounds": items}, indent=1))
    tmp.replace(WEB_DECK_FILE)


def _square_png(data: bytes) -> bytes:
    """Any picture -> a 256 px square PNG (centre crop), like a deck key. ffmpeg, no Pillow here."""
    with tempfile.TemporaryDirectory() as tmp:
        src, out = f"{tmp}/in", f"{tmp}/out.png"
        open(src, "wb").write(data)
        r = subprocess.run(["ffmpeg", "-nostdin", "-y", "-i", src, "-frames:v", "1", "-vf",
                            "crop='min(iw,ih)':'min(iw,ih)',scale=256:256:flags=lanczos", out],
                           capture_output=True, timeout=30)
        if r.returncode != 0 or not os.path.exists(out):
            raise HTTPException(400, "That picture didn't open; try a PNG or JPG")
        return open(out, "rb").read()


def _video_clip(url: str, start: float, length: float) -> tuple[bytes, str]:
    """Any yt-dlp link -> ([start, start+length] as WAV, the video's title)."""
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run(
            ["yt-dlp", "--no-playlist", "-f", "bestaudio/best", "--max-filesize", "150M",
             "--match-filter", "duration < 3600", "--print", "%(title)s", "--no-simulate",
             "-o", f"{tmp}/in.%(ext)s", "--", url],
            capture_output=True, timeout=240)
        got = [f for f in os.listdir(tmp) if f.startswith("in.") and not f.endswith(".part")]
        if r.returncode != 0 or not got:
            err = (r.stderr or b"").decode(errors="replace")
            if "Sign in" in err or "login" in err.lower() or "age" in err.lower():
                raise HTTPException(400, "That site wants a login for this one; try another link or upload it")
            if "Unsupported URL" in err:
                raise HTTPException(400, "That link has no video or sound we can grab")
            raise HTTPException(400, "Couldn't get that video; check the link")
        title = (r.stdout or b"").decode(errors="replace").strip().splitlines()
        out = f"{tmp}/out.wav"
        r = subprocess.run(["ffmpeg", "-nostdin", "-y", "-ss", str(start), "-i", f"{tmp}/{got[0]}", "-t", str(length),
                            "-vn", "-ar", "48000", "-ac", "1", "-sample_fmt", "s16", out],
                           capture_output=True, timeout=120)
        if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) < 1024:
            raise HTTPException(400, "That part of the video has no sound; try another start time")
        return open(out, "rb").read(), (title[0] if title else "")


def _clean_title(title: str) -> str:
    """'Bruh Sound Effect #2 (HD) | Free download' -> 'Bruh Sound Effect #2'."""
    t = re.sub(r"[\(\[][^)\]]*[\)\]]", "", title or "")
    t = re.split(r"\s[|·•]\s|\s-\s(?=[^-]*$)", t)[0]
    t = re.sub(r"#\w+", "", t)
    return re.sub(r"\s+", " ", t).strip(" -_|")[:40]


def _seconds(raw: str, default: float) -> float:
    """'83', '1:23' or '0:01:23' -> seconds."""
    raw = (raw or "").strip()
    if not raw:
        return default
    try:
        parts = [float(p) for p in raw.split(":")]
    except ValueError:
        raise HTTPException(400, "Times look like 1:23 or 83")
    out = 0.0
    for p in parts:
        out = out * 60 + p
    return max(0.0, out)

DECK_URL = os.getenv("FRIEND_DECK_URL", "http://192.168.5.54:3877/api/friend").rstrip("/")
DECK_TOKEN = os.getenv("FRIEND_DECK_TOKEN", "")


def _headers() -> dict:
    return {"x-friend-token": DECK_TOKEN} if DECK_TOKEN else {}


def build_router(get_session, fetch_clip=None) -> APIRouter:
    """`fetch_clip(url) -> (bytes, stem)` is server.py's MyInstants / direct-link fetcher."""
    router = APIRouter(prefix="/api/deck", tags=["deck"])

    def caller(request: Request) -> dict:
        session = get_session(request)
        if not (session or {}).get("sub"):
            raise HTTPException(401, "sign in to use the deck")
        return session

    def who(session: dict) -> str:
        return (session.get("name") or session.get("preferred_username")
                or (session.get("email") or "").split("@")[0] or session["sub"][:8])

    async def call(method: str, path: str, **kw) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                return await c.request(method, f"{DECK_URL}{path}", headers=_headers(), **kw)
        except httpx.HTTPError:
            raise HTTPException(503, "the deck is offline")

    @router.get("/layout")
    async def layout(request: Request):
        caller(request)
        r = await call("GET", "/layout")
        if r.status_code != 200:
            raise HTTPException(503, "the deck is offline")
        data = r.json()
        # clip names on the deck are often ids; use the squad board's label if it has one
        labels = (await asyncio.to_thread(audio_sounds._load_board))["labels"]
        for k in data.get("keys", []):
            if k.get("sound") and labels.get(k["sound"]):
                k["label"] = labels[k["sound"]]
        return data

    @router.get("/icon/{key}")
    async def icon(key: str, request: Request, state: str = ""):
        caller(request)
        if not key.isdigit():
            raise HTTPException(404, "no such key")
        r = await call("GET", f"/icon/{key}", params={"state": state[:20]})
        if r.status_code != 200:
            raise HTTPException(404, "no icon")
        return Response(r.content, media_type=r.headers.get("content-type", "image/png"),
                        headers={"Cache-Control": "private, max-age=300"})

    @router.get("/events")
    async def events(request: Request):
        caller(request)

        async def stream():
            yield "retry: 3000\n\n"
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(8, read=40)) as c:
                    async with c.stream("GET", f"{DECK_URL}/events", headers=_headers()) as r:
                        async for chunk in r.aiter_text():
                            if await request.is_disconnected():
                                break
                            yield chunk
            except httpx.HTTPError:
                yield "event: offline\ndata: {}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

    @router.post("/press")
    async def press(request: Request):
        session = caller(request)
        try:
            body = await request.json()
        except ValueError:
            body = {}
        key = str(body.get("key", ""))
        if not key.isdigit():
            raise HTTPException(400, "which key?")
        r = await call("POST", "/press", json={"key": key, "down": body.get("down", True) is not False,
                                                "who": who(session)})
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = None
            raise HTTPException(r.status_code if r.status_code < 500 else 503, detail or "the deck didn't take that")
        return {"ok": True}

    @router.get("/strip.jpg")
    async def strip(request: Request, view: str = "main"):
        caller(request)
        r = await call("GET", "/strip.png", params={"view": "reply" if view == "reply" else "main"})
        if r.status_code != 200:
            raise HTTPException(503, "the deck is offline")
        return Response(r.content, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=60"})

    @router.post("/strip")
    async def strip_tap(request: Request):
        session = caller(request)
        try:
            panel = str((await request.json()).get("panel", ""))
        except (ValueError, AttributeError):
            panel = ""
        r = await call("POST", "/strip", json={"panel": panel, "who": who(session)})
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = None
            raise HTTPException(r.status_code if r.status_code < 500 else 503, detail or "the deck didn't take that")
        return {"ok": True}

    # -- custom sounds (web deck only) -------------------------------------
    def sound_view(item: dict, labels: dict) -> dict:
        n = item["name"]
        return {"name": n, "label": labels.get(n) or audio_sounds._pretty(n), "by": item.get("by"),
                "custom_image": (DECK_IMAGES / f"{n}.png").exists()}

    async def clip_from(file: UploadFile | None, url: str, start: str, length: str) -> tuple[bytes, str, str]:
        """(audio bytes, name stem, source) from an upload or a link."""
        if file is not None and file.filename:
            data = await file.read(20 * 1024 * 1024 + 1)
            if len(data) > 20 * 1024 * 1024:
                raise HTTPException(400, "That file is over 20 MB; trim it or paste a link instead")
            return data, (file.filename or "clip").rsplit(".", 1)[0], "upload"
        m = _URL_IN_TEXT.search(url or "")          # share sheets paste "Title https://..."
        url = m.group(0).rstrip(").,") if m else ""
        if not url:
            raise HTTPException(400, "Paste a link or pick a file")
        if not _DIRECT.search(url):
            st = _seconds(start, 0.0)
            ln = min(max(_seconds(length, 8.0), 0.5), float(audio_sounds.MAX_CLIP_SECONDS))
            data, title = await asyncio.to_thread(_video_clip, url, st, ln)
            return data, _clean_title(title) or "clip", "video"
        if fetch_clip is None:
            raise HTTPException(400, "Paste a video link")
        try:
            data, stem = await fetch_clip(url)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(400, "Couldn't download that link")
        return data, stem, "link"

    async def save_image(name: str, image: UploadFile | None) -> None:
        if image is None or not image.filename:
            return
        data = await image.read(IMAGE_MAX_BYTES + 1)
        if len(data) > IMAGE_MAX_BYTES:
            raise HTTPException(400, "That picture is over 10 MB")
        png = await asyncio.to_thread(_square_png, data)
        DECK_IMAGES.mkdir(parents=True, exist_ok=True)
        (DECK_IMAGES / f"{name}.png").write_bytes(png)

    async def add_clip(data: bytes, stem: str, label: str, source: str, session: dict, url: str) -> str:
        try:
            r = await asyncio.to_thread(audio_sounds.add_sound, data, name=label or stem, label=label,
                                        source="link" if source != "upload" else "upload",
                                        by=who(session), url=url.strip()[:300] or None)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except RuntimeError as e:
            raise HTTPException(502, str(e))
        return r["name"]

    @router.get("/sounds")
    async def sounds(request: Request):
        caller(request)
        labels = (await asyncio.to_thread(audio_sounds._load_board))["labels"]
        with _web_lock:
            items = _load_web()
        return {"sounds": [sound_view(i, labels) for i in items], "max": WEB_DECK_MAX}

    @router.post("/sounds")
    async def sound_add(request: Request, file: UploadFile | None = File(None), url: str = Form(""),
                        label: str = Form(""), start: str = Form(""), length: str = Form(""),
                        image: UploadFile | None = File(None)):
        session = caller(request)
        label = label.strip()[:40]
        with _web_lock:
            if len(_load_web()) >= WEB_DECK_MAX:
                raise HTTPException(400, f"The deck is full ({WEB_DECK_MAX} sounds); remove one first")
        data, stem, source = await clip_from(file, url, start, length)
        if not label and source == "video":
            label = stem                              # the video's title
        name = await add_clip(data, stem, label, source, session, url)
        label = label or audio_sounds._pretty(name)
        await save_image(name, image)
        with _web_lock:
            items = _load_web()
            items.append({"name": name, "by": who(session), "at": int(time.time())})
            _save_web(items)
        return {"ok": True, "name": name, "label": label}

    @router.post("/sounds/{name}")
    async def sound_edit(name: str, request: Request, label: str | None = Form(None),
                         file: UploadFile | None = File(None), url: str = Form(""),
                         start: str = Form(""), length: str = Form(""),
                         image: UploadFile | None = File(None), clear_image: bool = Form(False)):
        """Change a custom sound: its name, its picture, or the sound itself."""
        session = caller(request)
        with _web_lock:
            if name not in [i["name"] for i in _load_web()]:
                raise HTTPException(404, "That sound isn't on the deck")
        new = name
        if (file is not None and file.filename) or url.strip():
            data, stem, source = await clip_from(file, url, start, length)
            keep = (label or "").strip()[:40] or (await asyncio.to_thread(audio_sounds._load_board))["labels"].get(name, "")
            new = await add_clip(data, stem, keep, source, session, url)
            old_img = DECK_IMAGES / f"{name}.png"
            if old_img.exists():                       # the picture stays with the tile
                DECK_IMAGES.mkdir(parents=True, exist_ok=True)
                old_img.replace(DECK_IMAGES / f"{new}.png")
            with _web_lock:
                items = _load_web()
                for i in items:
                    if i["name"] == name:
                        i["name"] = new
                _save_web(items)
        if label is not None:
            try:
                await asyncio.to_thread(audio_sounds.rename, new, label)
            except ValueError as e:
                raise HTTPException(400, str(e))
        if clear_image:
            (DECK_IMAGES / f"{new}.png").unlink(missing_ok=True)
        await save_image(new, image)
        return {"ok": True, "name": new}

    @router.delete("/sounds/{name}")
    async def sound_remove(name: str, request: Request):
        """Off the web deck. The clip stays on the Soundboard page."""
        caller(request)
        with _web_lock:
            items = _load_web()
            if name not in [i["name"] for i in items]:
                raise HTTPException(404, "That sound isn't on the deck")
            _save_web([i for i in items if i["name"] != name])
        (DECK_IMAGES / f"{name}.png").unlink(missing_ok=True)
        return {"ok": True}

    @router.post("/sounds/{name}/play")
    async def sound_play(name: str, request: Request):
        caller(request)
        if not audio_sounds._valid_name(name):
            raise HTTPException(404, "no such sound")
        now = time.monotonic()
        if now - _last_play.get(name, 0) < 0.7:
            raise HTTPException(429, "easy, one tap at a time")
        _last_play[name] = now
        if not await asyncio.to_thread(audio_sounds.play_sound, name):
            raise HTTPException(502, "The squad Pi didn't play it")
        return {"ok": True}

    @router.get("/sounds/{name}/icon")
    async def sound_icon(name: str, request: Request):
        caller(request)
        if not audio_sounds._valid_name(name):
            raise HTTPException(404, "no such sound")
        for path, kind in ((DECK_IMAGES / f"{name}.png", "image/png"),
                           (audio_sounds.SOUND_IMAGES_DIR / f"{name}.png", "image/png"),
                           (audio_sounds.SOUND_IMAGES_DIR / f"{name}.svg", "image/svg+xml")):
            if path.exists():
                return Response(path.read_bytes(), media_type=kind,
                                headers={"Cache-Control": "private, max-age=30"})
        raise HTTPException(404, "no picture yet")

    @router.post("/volume")
    async def volume(request: Request):
        session = caller(request)
        try:
            pct = int((await request.json()).get("pct"))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "volume is a number")
        r = await call("POST", "/volume", json={"pct": max(0, min(150, pct)), "who": who(session)})
        if r.status_code >= 400:
            raise HTTPException(503, "couldn't set the volume")
        return r.json()

    @router.get("/models")
    async def models(request: Request):
        caller(request)
        r = await call("GET", "/models")
        if r.status_code != 200:
            raise HTTPException(503, "Hasaan's Pi isn't answering")
        return r.json()

    @router.post("/model")
    async def model(request: Request):
        session = caller(request)
        try:
            body = await request.json()
        except ValueError:
            body = {}
        mid = str(body.get("id", ""))[:32]
        if not mid:
            raise HTTPException(400, "which model?")
        try:
            async with httpx.AsyncClient(timeout=25) as c:
                r = await c.post(f"{DECK_URL}/model", headers=_headers(), json={"id": mid, "who": who(session)})
        except httpx.HTTPError:
            raise HTTPException(503, "the deck is offline")
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = None
            raise HTTPException(r.status_code if r.status_code < 500 else 503, detail or "couldn't switch the model")
        return r.json()

    return router
