"""Steam: sign in with Steam from Settings, then Steam status and stats on Squad.

How a person maps to a Steam account:

  * Settings -> Steam opens Steam's OpenID 2.0 sign-in. Steam sends the browser
    back with a signed assertion; ``verify_assertion`` asks Steam to confirm it
    (``check_authentication``) and only then trusts the 64-bit SteamID in
    ``openid.claimed_id``. Steam's OpenID carries nothing else -- no name, no
    email -- so there is no token to store.
  * The SteamID is written as the ``steam_id`` Zitadel tag, the same identity
    graph that ties PSN, WhatsApp and Mattermost together (crcmz_identity). No
    local store: unlinking deletes the tag.

Everything shown on Squad comes from the Steam Web API with ``STEAM_WEB_API_KEY``
(registered for crcmz.me). The key never leaves the server. A private Steam
profile still answers summaries (name, avatar, online state) but returns no
games, so the per-game fields come back empty rather than as zeros.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any

import httpx

import crcmz_identity

logger = logging.getLogger("steam")

STEAM_WEB_API_KEY = os.environ.get("STEAM_WEB_API_KEY", "")
# Overridable so tests can point both at a local stub.
API_BASE = os.environ.get("STEAM_API_BASE", "https://api.steampowered.com").rstrip("/")
OPENID_URL = os.environ.get("STEAM_OPENID_URL", "https://steamcommunity.com/openid/login")

TAG = "steam_id"
_OPENID_NS = "http://specs.openid.net/auth/2.0"
_IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select"
_CLAIMED_ID = re.compile(r"^https?://steamcommunity\.com/openid/id/(\d{17})$")
_STEAM_ID = re.compile(r"^\d{17}$")

_HTTP_TIMEOUT = 10.0
# Presence changes by the minute; owned games and level barely move in a day.
_SUMMARY_TTL = 60.0
_STATS_TTL = 30 * 60.0

# personastate -> what Squad says.
PERSONA_STATES = {0: "offline", 1: "online", 2: "busy", 3: "away", 4: "snooze",
                  5: "looking to trade", 6: "looking to play"}

_cache: dict[str, tuple[float, Any]] = {}


def configured() -> bool:
    return bool(STEAM_WEB_API_KEY)


# ── OpenID 2.0 sign-in ───────────────────────────────────────────────────────

def login_url(return_to: str, realm: str) -> str:
    """Steam's sign-in page; Steam redirects back to ``return_to`` afterwards."""
    params = {
        "openid.ns": _OPENID_NS,
        "openid.mode": "checkid_setup",
        "openid.return_to": return_to,
        "openid.realm": realm,
        "openid.identity": _IDENTIFIER_SELECT,
        "openid.claimed_id": _IDENTIFIER_SELECT,
    }
    return f"{OPENID_URL}?{httpx.QueryParams(params)}"


def verify_assertion(params: dict[str, str], expected_return_to: str) -> str | None:
    """The SteamID64 Steam vouched for, or None for anything unverified.

    ``expected_return_to`` is the callback URL without its query string. The
    assertion's return_to is part of what Steam signs, so pinning it stops an
    assertion minted for another site being replayed here.
    """
    if params.get("openid.mode") != "id_res":
        return None
    if params.get("openid.op_endpoint") != OPENID_URL:
        return None
    if (params.get("openid.return_to") or "").split("?", 1)[0] != expected_return_to:
        return None
    m = _CLAIMED_ID.match(params.get("openid.claimed_id") or "")
    if not m or params.get("openid.identity") != params.get("openid.claimed_id"):
        return None
    body = {k: v for k, v in params.items() if k.startswith("openid.")}
    body["openid.mode"] = "check_authentication"
    try:
        r = httpx.post(OPENID_URL, data=body, timeout=_HTTP_TIMEOUT)
    except httpx.HTTPError as e:
        logger.warning("steam: openid check failed: %s", e)
        return None
    # Key-value form: one "key:value" per line.
    lines = dict(line.split(":", 1) for line in r.text.splitlines() if ":" in line)
    if r.status_code != 200 or lines.get("is_valid", "").strip() != "true":
        logger.info("steam: openid assertion rejected (%s)", r.status_code)
        return None
    return m.group(1)


# ── Linking (the steam_id tag) ───────────────────────────────────────────────

def steam_id_of(sub: str) -> str:
    person = crcmz_identity.by_zitadel_id().get(sub) or {}
    sid = (person.get("steam_id") or "").strip()
    return sid if _STEAM_ID.match(sid) else ""


def link(sub: str, steam_id: str) -> str:
    """Tag ``sub`` with ``steam_id``. Returns "ok", "taken" or "failed"."""
    if not _STEAM_ID.match(steam_id or ""):
        return "failed"
    for p in crcmz_identity.people(refresh=True):
        if p.get("steam_id") == steam_id and p["zitadel_id"] != sub:
            return "taken"
    if not crcmz_identity.set_tag(sub, TAG, steam_id):
        return "failed"
    crcmz_identity.people(refresh=True)
    return "ok"


PRIMARY_TAG = "primary_platform"
PLATFORMS = ("psn", "steam")


def set_primary(sub: str, platform: str) -> bool:
    """Which platform's stats lead this person's Squad row (the primary_platform tag)."""
    if platform not in PLATFORMS:
        return False
    ok = crcmz_identity.set_tag(sub, PRIMARY_TAG, platform)
    crcmz_identity.people(refresh=True)
    return ok


def primary_of(person: dict | None) -> str:
    return "steam" if (person or {}).get("primary_platform") == "steam" else "psn"


def unlink(sub: str) -> bool:
    ok = crcmz_identity.clear_tag(sub, TAG)
    crcmz_identity.people(refresh=True)
    return ok


# ── Steam Web API ────────────────────────────────────────────────────────────

def _get(path: str, **params: Any) -> dict:
    r = httpx.get(f"{API_BASE}/{path}", params={"key": STEAM_WEB_API_KEY, "format": "json", **params},
                  timeout=_HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json()


def _cached(key: str, ttl: float, fetch):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        val = fetch()
    except Exception as e:  # noqa: BLE001 - one bad call must not blank the card
        logger.warning("steam: %s failed: %s", key.split(":", 1)[0], e)
        return hit[1] if hit else None
    _cache[key] = (time.time(), val)
    return val


def summaries(steam_ids: list[str]) -> dict[str, dict]:
    """SteamID -> raw player summary. One call covers up to 100 ids."""
    ids = sorted({s for s in steam_ids if _STEAM_ID.match(s)})[:100]
    if not ids:
        return {}
    data = _cached("summaries:" + ",".join(ids), _SUMMARY_TTL,
                   lambda: _get("ISteamUser/GetPlayerSummaries/v2/", steamids=",".join(ids)))
    players = ((data or {}).get("response") or {}).get("players") or []
    return {p.get("steamid"): p for p in players if p.get("steamid")}


def _icon(appid: Any, icon_hash: str) -> str | None:
    if not appid or not icon_hash:
        return None
    return f"https://media.steampowered.com/steamcommunity/public/images/apps/{appid}/{icon_hash}.jpg"


def _capsule(appid: Any) -> str | None:
    return f"https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/capsule_184x69.jpg" if appid else None


def stats(steam_id: str) -> dict:
    """Level, library size, total hours and the last two weeks of play."""
    def fetch() -> dict:
        out: dict[str, Any] = {"level": None, "level_top_pct": None, "game_count": None,
                               "hours_total": None, "top_game": None, "recent": [], "hours_2weeks": None,
                               # Internal (squad_view's shared-games count); never copied into a row.
                               "owned": []}
        try:
            out["level"] = (_get("IPlayerService/GetSteamLevel/v1/", steamid=steam_id)
                            .get("response") or {}).get("player_level")
            if out["level"] is not None:
                # Global standing: the share of all Steam accounts at or below this level.
                pct = (_get("IPlayerService/GetSteamLevelDistribution/v1/", player_level=out["level"])
                       .get("response") or {}).get("player_level_percentile")
                if pct is not None:
                    out["level_top_pct"] = max(0.1, round(100 - float(pct), 1))
        except Exception as e:  # noqa: BLE001
            logger.debug("steam: level for %s: %s", steam_id, e)
        owned = (_get("IPlayerService/GetOwnedGames/v1/", steamid=steam_id, include_appinfo=1,
                      include_played_free_games=1).get("response") or {})
        games = owned.get("games") or []
        # A private library answers {} -- unknown, not zero.
        if "game_count" in owned:
            out["game_count"] = owned.get("game_count") or 0
            out["hours_total"] = round(sum(g.get("playtime_forever") or 0 for g in games) / 60)
            out["owned"] = [{"name": g.get("name"), "hours": round((g.get("playtime_forever") or 0) / 60, 1),
                             "icon": _icon(g.get("appid"), g.get("img_icon_url") or "")}
                            for g in games if g.get("name")]
            top = max(games, key=lambda g: g.get("playtime_forever") or 0, default=None)
            if top and top.get("playtime_forever"):
                out["top_game"] = {"name": top.get("name"), "hours": round(top["playtime_forever"] / 60),
                                   "icon": _icon(top.get("appid"), top.get("img_icon_url") or "")}
        recent = (_get("IPlayerService/GetRecentlyPlayedGames/v1/", steamid=steam_id, count=5)
                  .get("response") or {})
        rg = recent.get("games") or []
        out["recent"] = [{"name": g.get("name"), "hours_2weeks": round((g.get("playtime_2weeks") or 0) / 60, 1),
                          "icon": _icon(g.get("appid"), g.get("img_icon_url") or "")} for g in rg[:5]]
        if "total_count" in recent:
            out["hours_2weeks"] = round(sum(g.get("playtime_2weeks") or 0 for g in rg) / 60, 1)
        return out

    return _cached(f"stats:{steam_id}", _STATS_TTL, fetch) or {}


def _member(person: dict, summary: dict | None, st: dict) -> dict:
    """The allowlisted Squad row for one person. Nothing else leaves this module."""
    s = summary or {}
    state = PERSONA_STATES.get(int(s.get("personastate") or 0), "online")
    game = s.get("gameextrainfo") or None
    tags = person.get("tags") or {}
    return {
        "zitadel_id": person["zitadel_id"],
        "display_name": person.get("display_name") or "",
        "mm_username": person.get("mm_username") or tags.get("chosen_username") or "",
        "steam_id": person.get("steam_id"),
        "persona_name": s.get("personaname"),
        "avatar": s.get("avatarfull") or s.get("avatarmedium"),
        "profile_url": s.get("profileurl"),
        "state": state,
        "online": bool(s.get("personastate")),
        "playing": bool(game),
        "game": game,
        "game_image": _capsule(s.get("gameid")) if game else None,
        "last_online": s.get("lastlogoff"),
        "private": s.get("communityvisibilitystate") not in (None, 3),
        "level": st.get("level"),
        "level_top_pct": st.get("level_top_pct"),
        "game_count": st.get("game_count"),
        "hours_total": st.get("hours_total"),
        "hours_2weeks": st.get("hours_2weeks"),
        "top_game": st.get("top_game"),
        "recent": st.get("recent") or [],
    }


def squad_status() -> list[dict]:
    """Every person with a ``steam_id`` tag: presence plus stats, playing first."""
    if not configured():
        return []
    linked = [p for p in crcmz_identity.people() if _STEAM_ID.match(p.get("steam_id") or "")]
    if not linked:
        return []
    sums = summaries([p["steam_id"] for p in linked])
    rows = [_member(p, sums.get(p["steam_id"]), stats(p["steam_id"])) for p in linked]
    return sorted(rows, key=lambda m: (not m["playing"], not m["online"], m["display_name"].casefold()))


async def squad_status_async() -> list[dict]:
    return await asyncio.to_thread(squad_status)


def _game_icon(row: dict) -> str | None:
    """A square icon for the game being played: the library icon when Steam has
    one for it (recent or most-played), otherwise the store capsule."""
    for g in [*(row.get("recent") or []), row.get("top_game") or {}]:
        if g.get("name") and g.get("name") == row.get("game") and g.get("icon"):
            return g["icon"]
    return row.get("game_image")


def _steam_part(row: dict) -> dict:
    keep = ("persona_name", "profile_url", "state", "online", "playing", "game", "private", "level",
            "level_top_pct", "game_count", "hours_total", "hours_2weeks", "top_game")
    return {k: row.get(k) for k in keep}


def merge_into_squad(psn_members: list[dict]) -> list[dict]:
    """One Squad list across platforms.

    Each PSN row is tagged ``platform_source="psn"``; a person who also linked
    Steam gets a ``steam`` block, and when Steam is where they are actually
    playing (or online) the row's presence comes from Steam and the badge says
    Steam. People on Steam only are appended as their own rows. The join is the
    identity graph -- PSN online id -> Zitadel person -> steam_id -- never names.

    ``primary`` is the person's choice in Settings (primary_platform tag): which
    stats lead the row. A live game always wins the badge -- someone whose
    primary is Steam but who is in a PS5 game right now shows PSN -- and the
    choice decides the badge, last game and level whenever nobody's playing.
    """
    rows = squad_status() if configured() else []
    by_sub = {r["zitadel_id"]: r for r in rows}
    by_psn = crcmz_identity.by_psn_id()
    used: set[str] = set()
    out: list[dict] = []
    for m in psn_members:
        m = {**m, "platform_source": "psn", "platforms": ["psn"], "primary": "psn"}
        person = by_psn.get((m.get("online_id") or "").casefold())
        # Internal join key for squad_view; it strips this before anything is served.
        m["_sub"] = person["zitadel_id"] if person else None
        s = by_sub.get(person["zitadel_id"]) if person else None
        if s:
            used.add(s["zitadel_id"])
            primary = primary_of(person)
            m.update(platforms=["psn", "steam"], steam=_steam_part(s), primary=primary)
            if s["playing"] and not m.get("playing"):
                m.update(online=True, playing=True, game=s["game"], game_icon=_game_icon(s),
                         platform_source="steam")
            elif m.get("playing"):
                pass  # in a PSN game right now: PSN leads regardless
            elif primary == "steam":
                recent = (s.get("recent") or [None])[0] or s.get("top_game") or {}
                m.update(online=bool(m.get("online") or s["online"]), platform_source="steam",
                         recent_game=recent.get("name") or m.get("recent_game"),
                         recent_game_icon=recent.get("icon") or m.get("recent_game_icon"))
            elif s["online"] and not m.get("online"):
                m.update(online=True, platform_source="steam")
        out.append(m)
    for s in rows:
        if s["zitadel_id"] in used:
            continue
        recent = (s.get("recent") or [None])[0] or s.get("top_game") or {}
        out.append({
            "name": s["display_name"] or s["persona_name"],
            "mm_username": s["mm_username"] or None,
            "avatar": s["avatar"],
            "online": s["online"],
            "playing": s["playing"],
            "game": s["game"],
            "game_icon": _game_icon(s) if s["playing"] else None,
            "recent_game": recent.get("name"),
            "recent_game_icon": recent.get("icon"),
            "linked": True,
            "_sub": s["zitadel_id"],
            "platform_source": "steam",
            "platforms": ["steam"],
            "primary": "steam",
            "steam": _steam_part(s),
        })
    return out
