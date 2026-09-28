"""My Reels: a per-person view onto the reel-review service.

reel-review holds one shared APP_TOKEN and cannot tell who is asking, so this
module is the ownership boundary. The caller's Zitadel session resolves to a
psn_id through crcmz_identity, and a clip belongs to whoever sent it
(reel-review `sender` == PSN online id == Zitadel `psn_id` tag). Zitadel IAM
admins may act on every clip. Clips someone does not own answer 404, not 403,
so the API does not confirm which clip ids exist.

reel-review is reached over the shared `coolify` Docker network and is never
called from the browser; video bytes are streamed through here with Range
passed along so <video> can seek.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Awaitable, Callable
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

import crcmz_identity

logger = logging.getLogger(__name__)

REEL_REVIEW_URL = os.environ.get("REEL_REVIEW_URL", "http://reel-review:8080").rstrip("/")
REEL_REVIEW_TOKEN = os.environ.get("REEL_REVIEW_TOKEN", "")

_RENDER_ID = re.compile(r"^[0-9a-f]{6,32}$")
_CROP_MODES = {"ai", "center", "manual"}
_STREAM_HEADERS = ("content-type", "content-length", "content-range",
                   "accept-ranges", "last-modified", "etag")

# Cache misses make reel-review download the source from the clip store first.
_client = httpx.AsyncClient(
    base_url=REEL_REVIEW_URL,
    headers={"X-App-Token": REEL_REVIEW_TOKEN},
    timeout=httpx.Timeout(connect=5, read=120, write=30, pool=5),
)


def _q(clip_id: str) -> str:
    return quote(clip_id, safe="")


async def _rr(method: str, path: str, **kw) -> httpx.Response:
    if not REEL_REVIEW_TOKEN:
        raise HTTPException(503, "reel review is not configured")
    try:
        return await _client.request(method, path, **kw)
    except httpx.HTTPError as e:
        logger.warning("reels: %s %s failed: %s", method, path, e)
        raise HTTPException(502, "reel review is unreachable")


def _json_or_raise(r: httpx.Response) -> dict:
    if r.status_code == 404:
        raise HTTPException(404, "not found")
    if r.status_code >= 400:
        logger.warning("reels: upstream %s: %s", r.status_code, r.text[:200])
        raise HTTPException(502, "reel review returned an error")
    return r.json()


def build_router(
    get_session: Callable[[Request], dict | None],
    is_admin: Callable[[str], Awaitable[bool]],
) -> APIRouter:
    router = APIRouter(prefix="/api/reels")

    async def caller(request: Request) -> dict:
        # The global gate also admits machine-token and LAN callers without a
        # session; reels are personal, so they need a real person.
        session = get_session(request)
        sub = (session or {}).get("sub")
        if not sub:
            raise HTTPException(401, "sign in to see your reels")
        people = await asyncio.to_thread(crcmz_identity.by_zitadel_id)
        person = people.get(sub)
        if person is None:
            # Newly created accounts miss the five-minute identity cache.
            person = (await asyncio.to_thread(crcmz_identity.by_zitadel_id, refresh=True)).get(sub)
        person = person or {}
        return {
            "sub": sub,
            "psn_id": person.get("psn_id") or "",
            "display_name": person.get("display_name") or session.get("name") or "",
            "admin": await is_admin(sub),
        }

    def owns(me: dict, sender: str | None) -> bool:
        if me["admin"]:
            return True
        return bool(me["psn_id"]) and (sender or "").casefold() == me["psn_id"].casefold()

    async def owned_clip(me: dict, clip_id: str) -> dict:
        detail = _json_or_raise(await _rr("GET", f"/api/clips/{_q(clip_id)}"))
        if not owns(me, (detail.get("clip") or {}).get("sender")):
            raise HTTPException(404, "not found")
        return detail

    async def owned_render(me: dict, rid: str) -> dict:
        if not _RENDER_ID.match(rid):
            raise HTTPException(404, "not found")
        job = _json_or_raise(await _rr("GET", f"/api/renders/{rid}"))
        await owned_clip(me, job.get("clip_id") or "")
        return job

    def actor(me: dict) -> str:
        return me["psn_id"] or me["sub"]

    async def stream(path: str, request: Request) -> StreamingResponse:
        if not REEL_REVIEW_TOKEN:
            raise HTTPException(503, "reel review is not configured")
        headers = {}
        if rng := request.headers.get("range"):
            headers["Range"] = rng
        try:
            upstream = await _client.send(_client.build_request("GET", path, headers=headers), stream=True)
        except httpx.HTTPError as e:
            logger.warning("reels: stream %s failed: %s", path, e)
            raise HTTPException(502, "reel review is unreachable")
        if upstream.status_code >= 400:
            await upstream.aclose()
            raise HTTPException(404 if upstream.status_code == 404 else 502, "video unavailable")
        out = {k: v for k in _STREAM_HEADERS if (v := upstream.headers.get(k))}
        out["Cache-Control"] = "private, max-age=300"
        return StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code,
                                 headers=out, background=BackgroundTask(upstream.aclose))

    @router.get("")
    async def list_reels(request: Request, all: bool = False):
        me = await caller(request)
        scope = "all" if (all and me["admin"]) else "mine"
        body = {"me": {k: me[k] for k in ("psn_id", "display_name", "admin")}, "scope": scope}
        if scope == "mine" and not me["psn_id"]:
            return {**body, "clips": [], "source": None, "roster": None, "needs_psn_link": True}
        params = {} if scope == "all" else {"sender": me["psn_id"]}
        data = _json_or_raise(await _rr("GET", "/api/eligible", params=params))
        return {**body, "clips": data.get("clips", []), "source": data.get("source"),
                "roster": data.get("roster"), "needs_psn_link": False}

    @router.get("/clips/{clip_id:path}/source")
    async def clip_source(clip_id: str, request: Request):
        me = await caller(request)
        await owned_clip(me, clip_id)
        return await stream(f"/api/clips/{_q(clip_id)}/source", request)

    @router.get("/clips/{clip_id:path}/frame")
    async def clip_frame(clip_id: str, request: Request, t: float = 0.0):
        me = await caller(request)
        await owned_clip(me, clip_id)
        return await stream(f"/api/clips/{_q(clip_id)}/frame?t={max(0.0, t):.2f}", request)

    @router.post("/sync")
    async def sync(request: Request):
        await caller(request)
        return _json_or_raise(await _rr("POST", "/api/sync", params={"limit": 25}))

    @router.post("/clips/{clip_id:path}/render")
    async def clip_render(clip_id: str, request: Request):
        me = await caller(request)
        await owned_clip(me, clip_id)
        payload = _edit(await request.json())
        return _json_or_raise(await _rr("POST", f"/api/clips/{_q(clip_id)}/render", json=payload))

    @router.post("/clips/{clip_id:path}/veto")
    async def clip_veto(clip_id: str, request: Request):
        me = await caller(request)
        await owned_clip(me, clip_id)
        try:
            reason = str((await request.json() or {}).get("reason") or "")[:500]
        except ValueError:
            reason = ""
        payload = {"reason": reason, "source": f"crcmz:{actor(me)}"}
        return _json_or_raise(await _rr("POST", f"/api/clips/{_q(clip_id)}/veto", json=payload))

    @router.delete("/clips/{clip_id:path}/veto")
    async def clip_unveto(clip_id: str, request: Request):
        me = await caller(request)
        await owned_clip(me, clip_id)
        return _json_or_raise(await _rr("DELETE", f"/api/clips/{_q(clip_id)}/veto"))

    @router.post("/clips/{clip_id:path}/override")
    async def clip_override(clip_id: str, request: Request):
        me = await caller(request)
        await owned_clip(me, clip_id)
        payload = {**_edit(await request.json()), "by": actor(me)}
        return _json_or_raise(await _rr("POST", f"/api/clips/{_q(clip_id)}/override", json=payload))

    @router.get("/clips/{clip_id:path}")
    async def clip_detail(clip_id: str, request: Request):
        me = await caller(request)
        return await owned_clip(me, clip_id)

    @router.get("/renders/{rid}")
    async def render_status(rid: str, request: Request):
        me = await caller(request)
        return await owned_render(me, rid)

    @router.get("/renders/{rid}/video")
    async def render_video(rid: str, request: Request):
        me = await caller(request)
        await owned_render(me, rid)
        return await stream(f"/api/renders/{rid}/video", request)

    @router.get("/renders/{rid}/trajectory")
    async def render_trajectory(rid: str, request: Request):
        me = await caller(request)
        await owned_render(me, rid)
        return _json_or_raise(await _rr("GET", f"/api/renders/{rid}/trajectory"))

    return router


def _edit(body: dict) -> dict:
    crop_mode = body.get("crop_mode") or "ai"
    if crop_mode not in _CROP_MODES:
        raise HTTPException(400, "crop_mode must be ai, center or manual")
    crop_box = None
    if crop_mode == "manual":
        box = body.get("crop_box") if isinstance(body.get("crop_box"), dict) else {}
        vals = {k: _num(box.get(k)) for k in ("x", "y", "w", "h")}
        if any(v is None or v > 1 for v in vals.values()) or not vals["w"] or not vals["h"]:
            raise HTTPException(400, "manual crop needs a crop_box of x, y, w, h between 0 and 1")
        crop_box = vals
    return {
        "window_start": _num(body.get("window_start")),
        "window_end": _num(body.get("window_end")),
        "crop_mode": crop_mode,
        "crop_box": crop_box,
        "label": _label(body.get("label")),
        "zooms": _zooms(body.get("zooms")),
        # None = use the AI subtitles; a list (even empty) replaces them.
        "subtitles": _subtitles(body.get("subtitles")),
        "caption": _text(body.get("caption"), 2200),
    }


def _items(v, limit: int) -> list[dict]:
    if not isinstance(v, list) or len(v) > limit:
        raise HTTPException(400, f"expected a list of at most {limit} items")
    return [x for x in v if isinstance(x, dict)]


def _zooms(v) -> list[dict]:
    out = []
    for z in _items(v or [], 20):
        s, e, scale = _num(z.get("start")), _num(z.get("end")), _num(z.get("scale"))
        x, y = _num(z.get("x")), _num(z.get("y"))
        if None in (s, e, scale, x, y) or e <= s or not 1 <= scale <= 4 or x > 1 or y > 1:
            raise HTTPException(400, "each zoom needs start < end, scale 1-4, and x, y between 0 and 1")
        out.append({"start": s, "end": e, "scale": scale, "x": x, "y": y})
    return out


def _subtitles(v) -> list[dict] | None:
    if v is None:
        return None
    out = []
    for s in _items(v, 200):
        start, end, text = _num(s.get("start")), _num(s.get("end")), _text(s.get("text"), 200)
        if start is None or end is None or end <= start:
            raise HTTPException(400, "each subtitle needs start < end")
        if text:
            out.append({"start": start, "end": end, "text": text})
    return out


def _text(v, limit: int) -> str | None:
    return str(v).strip()[:limit] or None if v else None


def _num(v) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if v >= 0 else None


def _label(v) -> str | None:
    return str(v).strip()[:60] or None if v else None
