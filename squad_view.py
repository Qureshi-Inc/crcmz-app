"""One Squad page across platforms: names, cross-platform stats, ranks, squad numbers.

`/api/squad` is built in three steps:

  1. psn_data.squad_status()      -- PSN presence + trophies per linked account
  2. steam.merge_into_squad()     -- Steam presence/stats joined on, Steam-only rows added
  3. squad_view.build()           -- this module: the person's chosen Squad name,
                                     a ``stats`` block that adds PSN and Steam
                                     together, and a squad-wide ``summary``

Who a row belongs to comes from the identity graph only (the ``_sub`` join key
that steam.merge_into_squad attaches, stripped here before anything is served).

Squad name: the ``squad_name`` Zitadel tag, set by the person in Settings ->
Profile. It must not collide with anyone else's name or handle, so nobody can
show up on Squad as somebody else.

Numbers, and what they mean:

  * hours: PSN's lifetime per-title playtime (game_history) + Steam lifetime
    playtime. Steam counts only when the person's game details are public.
  * hours_2weeks: Steam's own two-week figure + PSN session time our presence
    polling observed in the same window (PSN has no two-week counter).
  * games: PSN titles played + Steam games owned.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

import crcmz_identity
import game_history
import steam

logger = logging.getLogger("squad_view")

NAME_TAG = "squad_name"
NAME_MIN, NAME_MAX = 2, 24


# ── Squad name ───────────────────────────────────────────────────────────────

def clean_name(raw: str) -> str:
    """Whitespace collapsed, control/format characters refused (returns "")."""
    name = " ".join((raw or "").split())
    if any(unicodedata.category(c)[0] == "C" for c in name) or any(c in name for c in "@<>"):
        return ""
    return name if NAME_MIN <= len(name) <= NAME_MAX else ""


def _names_of(p: dict) -> set[str]:
    tags = p.get("tags") or {}
    return {str(v).casefold() for v in (p.get("squad_name"), p.get("display_name"), p.get("psn_id"),
                                        p.get("mm_username"), tags.get("chosen_username")) if v}


def set_name(sub: str, raw: str) -> str:
    """Set (or with an empty ``raw``, clear) the Squad name. "ok" | "invalid" | "taken" | "failed"."""
    if not (raw or "").strip():
        ok = crcmz_identity.clear_tag(sub, NAME_TAG)
        crcmz_identity.people(refresh=True)
        return "ok" if ok else "failed"
    name = clean_name(raw)
    if not name:
        return "invalid"
    folded = name.casefold()
    if any(folded in _names_of(p) for p in crcmz_identity.people(refresh=True) if p["zitadel_id"] != sub):
        return "taken"
    if not crcmz_identity.set_tag(sub, NAME_TAG, name):
        return "failed"
    crcmz_identity.people(refresh=True)
    return "ok"


# ── Cross-platform stats ─────────────────────────────────────────────────────

def _game_key(name: str) -> str:
    """'Call of Duty®: Black Ops' and 'CALL OF DUTY: BLACK OPS' are one game."""
    return " ".join(re.sub(r"[^\w]+", " ", re.sub(r"[®™©]", "", name or "").casefold()).split())


def _add(*vals):
    known = [v for v in vals if v is not None]
    return round(sum(known), 1) if known else None


def _row_stats(m: dict, psn: dict | None) -> dict:
    s = m.get("steam") or {}
    psn = psn or {}
    steam_hours = s.get("hours_total")
    tops = [g for g in (psn.get("top") and {**psn["top"], "platform": "psn"},
                        s.get("top_game") and {**s["top_game"], "platform": "steam"}) if g]
    top = max(tops, key=lambda g: g.get("hours") or 0, default=None)
    return {
        "hours_total": _add(psn.get("hours") if psn else None, steam_hours),
        "hours_2weeks": _add(psn.get("hours_recent") if psn else None, s.get("hours_2weeks")),
        "games": _add(psn.get("titles") if psn else None, s.get("game_count")),
        "psn_hours": psn.get("hours") if psn else None,
        "steam_hours": steam_hours,
        "top_game": top,
        "trophy_level": m.get("trophy_level"),
        "platinum": m.get("platinum"),
        "steam_level": s.get("level"),
        "steam_top_pct": s.get("level_top_pct"),
        # Steam answered with a profile but no library: game details are private.
        "steam_games_private": bool(s) and s.get("game_count") is None,
    }


def _summary(rows: list[dict], libraries: list[tuple[str, list[dict]]]) -> dict:
    """Squad-wide numbers. ``libraries`` is (row name, games) per row."""
    by_game: dict[str, dict[str, Any]] = {}
    for who, games in libraries:
        seen: set[str] = set()
        for g in games:
            k = _game_key(g.get("name") or "")
            if not k:
                continue
            e = by_game.setdefault(k, {"name": g["name"], "hours": 0.0, "players": set(), "icon": None})
            e["hours"] += g.get("hours") or 0
            e["icon"] = e["icon"] or g.get("icon")
            if k not in seen:
                e["players"].add(who)
                seen.add(k)
    games = list(by_game.values())

    def game_out(e: dict | None) -> dict | None:
        return e and {"name": e["name"], "hours": round(e["hours"]), "players": len(e["players"]), "icon": e["icon"]}

    most_played = max(games, key=lambda e: e["hours"], default=None)
    most_shared = max(games, key=lambda e: (len(e["players"]), e["hours"]), default=None)
    if most_shared and len(most_shared["players"]) < 2:
        most_shared = None
    recent = [(r["stats"]["hours_2weeks"] or 0, r) for r in rows]
    grinder = max(recent, key=lambda x: x[0], default=(0, None))
    return {
        "hours_total": _add(*(r["stats"]["hours_total"] for r in rows)),
        "hours_2weeks": _add(*(r["stats"]["hours_2weeks"] for r in rows)),
        "most_played": game_out(most_played),
        "most_shared": game_out(most_shared),
        "grinder": ({"name": _row_name(grinder[1]), "hours": grinder[0]} if grinder[1] and grinder[0] else None),
        "playing_now": sum(1 for r in rows if r.get("playing")),
        "members": len(rows),
    }


def _row_name(m: dict) -> str:
    return m.get("name") or m.get("online_id") or m.get("mm_username") or "Unknown"


# ── Ranks ────────────────────────────────────────────────────────────────────
# mode -> (label, stats key or None for the overall score, unit)
RANK_MODES = {
    "overall": ("Overall", None, "score"),
    "hours": ("Hours played", "hours_total", "h"),
    "recent": ("Last 2 weeks", "hours_2weeks", "h"),
    "games": ("Games", "games", "games"),
    "trophies": ("PSN trophies", "trophy_level", "level"),
    "steam": ("Steam level", "steam_level", "level"),
}
# Overall = the mean of these, each scaled so the squad's best is 100. Only
# cross-platform numbers, so a Steam-only or PSN-only player is not penalised
# for the platform they don't have.
_OVERALL = ("hours_total", "hours_2weeks", "games")


def _detail(mode: str, r: dict) -> str:
    st = r["stats"]
    if mode == "trophies":
        return f"{r.get('platinum') or 0} plat · {r.get('gold') or 0} gold · {r.get('silver') or 0} silver"
    if mode == "steam":
        return f"Top {st['steam_top_pct']}% of Steam" if st.get("steam_top_pct") else ""
    if mode in ("hours", "overall"):
        bits = [f"{st['psn_hours']:,} h PSN" if st.get("psn_hours") else "",
                f"{st['steam_hours']:,} h Steam" if st.get("steam_hours") else ""]
        if st.get("steam_games_private"):
            bits.append("Steam games private")
        return " · ".join(b for b in bits if b)
    if mode == "recent" and st.get("top_game"):
        return f"most: {st['top_game']['name']}"
    return ""


def ranks(rows: list[dict]) -> dict:
    """mode -> ranked entries. Someone with no number for a mode is left out of it."""
    best = {k: max((r["stats"].get(k) or 0 for r in rows), default=0) for k in _OVERALL}
    out: dict[str, Any] = {}
    for mode, (label, key, unit) in RANK_MODES.items():
        entries = []
        for r in rows:
            st = r["stats"]
            if key is None:
                parts = [(st.get(k) or 0) / best[k] * 100 for k in _OVERALL if best[k] and st.get(k) is not None]
                if not parts:
                    continue
                value = round(sum(parts) / len(_OVERALL))
            else:
                value = st.get(key)
                if not value:
                    continue
            entries.append({"name": _row_name(r), "avatar": r.get("avatar"), "value": value,
                            "platforms": r.get("platforms") or [], "detail": _detail(mode, r)})
        entries.sort(key=lambda e: (-e["value"], e["name"].casefold()))
        out[mode] = {"label": label, "unit": unit, "entries": entries}
    return out


def build(rows: list[dict]) -> dict:
    """The /api/squad payload: rows with ``name`` and ``stats``, plus ``summary``."""
    people = crcmz_identity.by_zitadel_id()
    try:
        psn = game_history.squad_totals([r.get("online_id") or "" for r in rows])
    except Exception as e:  # noqa: BLE001 - history is a bonus, never a blocker
        logger.warning("squad_view: game history failed: %s", e)
        psn = {}
    out: list[dict] = []
    libraries: list[tuple[str, list[dict]]] = []
    for r in rows:
        r = dict(r)
        person = people.get(r.pop("_sub", None) or "") or {}
        if person.get("squad_name"):
            r["name"] = person["squad_name"]
        p = psn.get(r.get("online_id") or "")
        r["stats"] = _row_stats(r, p)
        sid = person.get("steam_id")
        owned = (steam.stats(sid).get("owned") or []) if sid and steam.configured() else []
        libraries.append((_row_name(r), [*(p or {}).get("games", []), *owned]))
        out.append(r)
    return {"squad": out, "summary": _summary(out, libraries), "ranks": ranks(out)}
