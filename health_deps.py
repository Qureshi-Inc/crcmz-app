"""Health of everything the app depends on, one check per dependency.

GET /health/<name> answers 200 when that dependency is fine and 503 when it isn't,
with a short reason. Uptime Kuma (status.crcmz.me, on qcloud) watches each one: most
of these services are only reachable from inside the app's own network, so the app
is the one place that can tell. Nothing secret is returned: just ok, how long the
check took, and a plain reason ("timed out", "expires in 3 days").

Results are cached for CACHE_S, so a status page refreshing often doesn't hammer
anything.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Awaitable, Callable

import httpx

CACHE_S = 30
TIMEOUT_S = 8
WARN_DAYS = 5      # a token or subscription this close to running out counts as down

_cache: dict[str, tuple[float, dict]] = {}


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


async def _get(url: str, *, headers: dict | None = None) -> httpx.Response:
    async with httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=True) as c:
        return await c.get(url, headers=headers or {})


def _ai_base() -> str:
    return _env("OLLAMA_BASE_URL").rstrip("/")


def _ai_headers() -> dict:
    key = _env("OLLAMA_API_KEY")
    return {"Authorization": f"Bearer {key}"} if key else {}


async def _models(base: str, headers: dict) -> list[str]:
    url = base if base.endswith("/v1") else f"{base}/v1"
    r = await _get(f"{url}/models", headers=headers)
    r.raise_for_status()
    return [str(m.get("id") or "") for m in r.json().get("data") or []]


async def check_ai() -> tuple[bool, str]:
    model = _env("OLLAMA_MODEL")
    ids = await _models(_ai_base(), _ai_headers())
    return (model in ids, "model loaded" if model in ids else f"{model} isn't loaded")


async def check_whisper() -> tuple[bool, str]:
    base = (_env("WHISPER_BASE_URL") or _ai_base()).rstrip("/")
    key = _env("WHISPER_API_KEY") or _env("OLLAMA_API_KEY")
    ids = await _models(base, {"Authorization": f"Bearer {key}"} if key else {})
    model = _env("WHISPER_MODEL", "whisper-large-v3-turbo")
    # Some servers serve speech-to-text without listing it with the chat models.
    return True, "model loaded" if any(model in i for i in ids) else "server up"


async def check_embeddings() -> tuple[bool, str]:
    import memory_store
    if not memory_store._available:
        return False, "the squad memory is off (embedding model unreachable at startup)"
    base = (_env("EMBEDDING_BASE_URL") or _ai_base()).rstrip("/")
    ids = await _models(base, _ai_headers())
    model = _env("EMBEDDING_MODEL")
    return (model in ids, "model loaded" if model in ids else f"{model} isn't loaded")


async def check_jellyfin() -> tuple[bool, str]:
    r = await _get(f"{_env('JELLYFIN_URL', 'http://jellyfin:8096').rstrip('/')}/health")
    return (r.status_code == 200 and "Healthy" in r.text, r.text[:40] or str(r.status_code))


async def check_importer() -> tuple[bool, str]:
    base = _env("SLAP_INTERNAL_URL", "http://music-importer:8080/api/v1").rstrip("/")
    root = base[: -len("/api/v1")] if base.endswith("/api/v1") else base
    r = await _get(f"{root}/health")
    ok = r.status_code == 200 and (r.json() or {}).get("status") == "healthy"
    return ok, "healthy" if ok else f"answered {r.status_code}"


async def check_watchparty() -> tuple[bool, str]:
    base = _env("WATCHPARTY_INTERNAL_URL", "http://watchparty-watchparty-1:8080").rstrip("/")
    r = await _get(f"{base}/")
    return r.status_code == 200, f"answered {r.status_code}"


async def check_browser_extract() -> tuple[bool, str]:
    r = await _get(f"{_env('BROWSER_EXTRACT_URL', 'http://crcmz-browser-extract:8091').rstrip('/')}/health")
    ok = r.status_code == 200 and (r.json() or {}).get("ok") is True
    return ok, "ok" if ok else f"answered {r.status_code}"


async def check_whatsapp() -> tuple[bool, str]:
    base = _env("WA_BRIDGE_URL").rstrip("/")
    if not base:
        return False, "no WhatsApp bridge set up"
    r = await _get(f"{base}/health")
    d = r.json() if r.status_code == 200 else {}
    if not d.get("whatsapp"):
        return False, "the bridge is up but WhatsApp is disconnected" if r.status_code == 200 else f"answered {r.status_code}"
    return True, "connected"


async def check_tts() -> tuple[bool, str]:
    base = _env("WA_TTS_URL", "http://100.76.195.46:8880").rstrip("/")
    r = await _get(f"{base}/health")
    return r.status_code < 500, f"answered {r.status_code}"


async def check_zurg() -> tuple[bool, str]:
    base = _env("ZURG_URL", "http://10.0.1.1:9999").rstrip("/")
    r = await _get(f"{base}/")
    return (r.status_code == 200 and "zurg" in r.text.lower(), f"answered {r.status_code}")


async def check_livekit() -> tuple[bool, str]:
    url = _env("LIVEKIT_URL", "wss://huddle.crcmz.me").replace("wss://", "https://").replace("ws://", "http://")
    r = await _get(url)
    return r.status_code == 200, f"answered {r.status_code}"


async def check_realdebrid() -> tuple[bool, str]:
    token = _env("REAL_DEBRID_TOKEN")
    if not token:
        return False, "no Real-Debrid token set"
    r = await _get("https://api.real-debrid.com/rest/1.0/user", headers={"Authorization": f"Bearer {token}"})
    if r.status_code == 401:
        return False, "the Real-Debrid token was refused"
    r.raise_for_status()
    d = r.json()
    if d.get("type") != "premium":
        return False, "the Real-Debrid account isn't premium"
    days = int((d.get("premium") or 0) / 86400)
    return days >= WARN_DAYS, f"premium, {days} days left"


async def check_psn() -> tuple[bool, str]:
    import server
    a = getattr(server, "psn_auth", None)
    left = getattr(a, "_refresh_expires_at", 0) - time.time() if a else 0
    if left <= 0:
        return False, "the PSN sign-in has expired: it needs a new NPSSO"
    days = int(left / 86400)
    return days >= WARN_DAYS, f"PSN sign-in good for {days} more days"


async def check_zitadel() -> tuple[bool, str]:
    r = await _get("https://auth.crcmz.me/debug/healthz")
    return r.status_code == 200, f"answered {r.status_code}"


async def check_mattermost() -> tuple[bool, str]:
    r = await _get(f"{_env('MATTERMOST_URL', 'https://mm.qureshi.io').rstrip('/')}/api/v4/system/ping")
    ok = r.status_code == 200 and (r.json() or {}).get("status") == "OK"
    return ok, "OK" if ok else f"answered {r.status_code}"


async def check_movie_catalogue() -> tuple[bool, str]:
    # The same browser User-Agent the Movies code sends (Torrentio refuses httpx's own).
    from movies import _UA
    r = await _get("https://v3-cinemeta.strem.io/manifest.json", headers={"User-Agent": _UA})
    t = await _get("https://torrentio.strem.fun/stream/movie/tt0113277.json", headers={"User-Agent": _UA})
    ok = r.status_code == 200 and t.status_code == 200
    return ok, "Cinemeta and Torrentio up" if ok else f"Cinemeta {r.status_code}, Torrentio {t.status_code}"


CHECKS: dict[str, tuple[str, Callable[[], Awaitable[tuple[bool, str]]]]] = {
    "ai":            ("AI model (the assistant, Huddle AI, meeting notes)", check_ai),
    "whisper":       ("Speech to text (Huddle transcript)", check_whisper),
    "memory":        ("Squad memory (embeddings)", check_embeddings),
    "jellyfin":      ("Jellyfin (Slap music and Movies)", check_jellyfin),
    "importer":      ("Music importer (Slapshare downloads)", check_importer),
    "watchparty":    ("Watch Party server", check_watchparty),
    "extract":       ("Video link extractor", check_browser_extract),
    "whatsapp":      ("WhatsApp bridge (Baileys)", check_whatsapp),
    "tts":           ("Voice replies (TTS)", check_tts),
    "zurg":          ("Zurg (Real-Debrid movie mount)", check_zurg),
    "livekit":       ("LiveKit (Huddle and Watch Party calls)", check_livekit),
    "realdebrid":    ("Real-Debrid account", check_realdebrid),
    "psn":           ("PlayStation sign-in (NPSSO)", check_psn),
    "zitadel":       ("Sign-in (Zitadel)", check_zitadel),
    "mattermost":    ("Mattermost", check_mattermost),
    "movie-catalogue": ("Movie catalogue (Cinemeta, Torrentio)", check_movie_catalogue),
}


async def run(name: str) -> dict | None:
    """One dependency's health, cached. None when there's no such check."""
    if name not in CHECKS:
        return None
    hit = _cache.get(name)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    label, fn = CHECKS[name]
    t0 = time.monotonic()
    try:
        ok, detail = await asyncio.wait_for(fn(), TIMEOUT_S * 2 + 2)
    except asyncio.TimeoutError:
        ok, detail = False, "timed out"
    except httpx.HTTPError as e:
        ok, detail = False, f"unreachable ({type(e).__name__})"
    except Exception as e:  # noqa: BLE001
        ok, detail = False, f"check failed ({type(e).__name__})"
    out = {"dep": name, "name": label, "ok": ok, "detail": detail[:160], "ms": int((time.monotonic() - t0) * 1000)}
    _cache[name] = (time.time(), out)
    return out
