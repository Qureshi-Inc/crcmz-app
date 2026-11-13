"""Friend deck: the squad's view of Moiz's Ragnaros stream deck (/app/deck).

A signed-in squad member sees the deck's soundboard page live and can press the
keys meant for friends: three sounds and the Hasaan keys (talk, roast, session,
stop). Volume knobs, the headset mic, the studio light and HDMI are not on it.

This module is only a signed-in proxy. The allowlist, the commands each key
runs and the live state live in Deck Manager on opti3 (`frienddeck.py` there),
reached over the LAN at FRIEND_DECK_URL.
"""

from __future__ import annotations

import asyncio
import os

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

import audio_sounds

DECK_URL = os.getenv("FRIEND_DECK_URL", "http://192.168.5.54:3877/api/friend").rstrip("/")
DECK_TOKEN = os.getenv("FRIEND_DECK_TOKEN", "")


def _headers() -> dict:
    return {"x-friend-token": DECK_TOKEN} if DECK_TOKEN else {}


def build_router(get_session) -> APIRouter:
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
