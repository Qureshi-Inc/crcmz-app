"""Soundboard buttons: the one shared board plus a private board per person.

This lived inline in `server.py` until the assistant needed to read it. It could
not stay there: `server.py` imports `assistant`, so `assistant` importing
`server` back would be circular, and until the store was a module the bot could
not answer "what buttons does Zubair have" at all. `server.py` now delegates
here, which also means the paths have exactly one owner.

Two stores, deliberately shaped differently:

* `/data/soundboard.json` -> `{"buttons": [...]}` -- the shared board everyone
  sees, appended to the built-in `DEFAULTS`.
* `/data/soundboard_personal.json` -> `{"boards": {"<zitadel_sub>": [...]}}` --
  one private board per person, keyed by Zitadel `sub` because email changes and
  the `sub` does not.

A button is `{"label", "msg", "cls"}`: `label` is the short text on the tile,
`msg` is what actually gets posted to the group, `cls` picks a colour.

**Privacy note.** A personal board is private *in the UI* -- no other signed-in
user can list or delete it. The read helpers here intentionally break that for
the bot and MCP, because the whole point is letting the assistant say "you
already have a button for that". Anything exposing `personal_boards()` must be
authenticated; do not hang it off an open endpoint.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import crcmz_identity

logger = logging.getLogger(__name__)

SHARED_FILE = Path("/data/soundboard.json")
PERSONAL_FILE = Path("/data/soundboard_personal.json")

# Colours cycled through for new custom buttons.
COLORS = ["c1", "c2", "c3", "c4", "c5"]
# Per-person cap. The shared board has its own, lower cap in server.py.
PERSONAL_MAX = 24

# The dashboard's built-in buttons. Each posts a canned message to the squad PSN
# group via /v2/squad {message}; `path` instead of `msg` hits a non-message
# action. These are code, not data -- they are not in the JSON file.
DEFAULTS: list[dict] = [
    {"label": "👉👌 Have you ever?", "msg": "Have you ever? 👉👌", "cls": "c1"},
    {"label": "🧊☕ Iced Cap STORY", "msg": "🧊☕ Iced Cap STORRYYY! 📖✨", "cls": "c2"},
    {"label": "🙅‍♂️ Never", "msg": "Never 🙅‍♂️❌", "cls": "c3"},
    {"label": "💧 Water Break", "msg": "💧 Water break! 🚰💦", "cls": "c4"},
    {"label": "🎬 Zubi Clip It", "msg": "🎬 ZUBI CLIP IT!! 📸🔥 That was insane!", "cls": "c5"},
    {"label": "🎮 Squad Up", "msg": "🎮🔥 SQUAD UP! Who's hopping on? 🕹️💥", "cls": "c1"},
    {"label": "🕹️ Game Time", "msg": "🎮🔥 Let's party up y'all. It's GAME TIME! 🕹️💥", "cls": "c2"},
]


# ── Shared board ─────────────────────────────────────────────────────────────


def load_custom() -> list[dict]:
    """Custom shared buttons only. A missing or corrupt file reads as empty."""
    try:
        return json.loads(SHARED_FILE.read_text()).get("buttons", [])
    except Exception:  # noqa: BLE001
        return []


def save_custom(buttons: list[dict]) -> None:
    SHARED_FILE.parent.mkdir(parents=True, exist_ok=True)
    SHARED_FILE.write_text(json.dumps({"buttons": buttons}, indent=2))


def shared() -> list[dict]:
    """Built-in buttons followed by the persisted custom ones."""
    return DEFAULTS + load_custom()


# ── Personal boards ──────────────────────────────────────────────────────────


def load_all_personal() -> dict[str, list[dict]]:
    try:
        return json.loads(PERSONAL_FILE.read_text()).get("boards", {})
    except Exception:  # noqa: BLE001
        return {}


def load_personal(key: str) -> list[dict]:
    """One person's board. `mine` is what tells the dashboard it is deletable."""
    board = load_all_personal().get(key, [])
    return [{**b, "custom": True, "mine": True} for b in board]


def save_personal(key: str, buttons: list[dict]) -> None:
    """Persist one board; an empty list removes the key rather than storing []."""
    boards = load_all_personal()
    if buttons:
        boards[key] = buttons
    else:
        boards.pop(key, None)
    PERSONAL_FILE.parent.mkdir(parents=True, exist_ok=True)
    PERSONAL_FILE.write_text(json.dumps({"boards": boards}, indent=2))


# ── Read API for the assistant and MCP ───────────────────────────────────────


def _describe(button: dict) -> dict[str, Any]:
    """Allowlisted projection. Buttons are user text, but the shape is not fixed,
    so unknown keys are dropped rather than forwarded."""
    return {
        "label": str(button.get("label", "")),
        "msg": str(button.get("msg", "")),
        "colour": str(button.get("cls", "")),
        "custom": bool(button.get("custom", False)),
    }


def overview(*, limit: int = 40) -> dict[str, Any]:
    """The whole button surface: shared board plus who owns a personal one.

    Personal button *text* is not included here -- use `person_buttons()` for
    one named person, so a broad "what buttons exist" question does not dump
    everybody's private board into a group reply.
    """
    limit = max(1, min(int(limit or 40), 200))
    custom = load_custom()
    boards = load_all_personal()
    by_id = crcmz_identity.by_zitadel_id()

    owners = []
    for sub, buttons in boards.items():
        person = by_id.get(sub)
        owners.append({
            "zitadel_id": sub,
            # An orphaned board (person deleted from Zitadel) keeps its count but
            # has no name, which is more honest than hiding the row.
            "name": (person or {}).get("display_name", "") or "",
            "known_person": person is not None,
            "buttons": len(buttons),
        })
    owners.sort(key=lambda o: (-o["buttons"], o["name"].casefold()))

    return {
        "shared": {
            "total": len(DEFAULTS) + len(custom),
            "builtin": len(DEFAULTS),
            "custom": len(custom),
            "buttons": [_describe(b) for b in shared()[:limit]],
        },
        "personal": {
            "boards": len(boards),
            "buttons": sum(len(b) for b in boards.values()),
            "max_per_person": PERSONAL_MAX,
            "owners": owners,
        },
    }


def person_buttons(who: str, *, limit: int = 40) -> dict[str, Any]:
    """One person's private board, resolved by any identifier they are known by.

    Goes through `crcmz_identity.resolve` rather than matching a name against the
    board keys, so "MQ", a PSN id, and a Zitadel sub all work.
    """
    limit = max(1, min(int(limit or 40), 200))
    person = crcmz_identity.resolve(who)
    if not person:
        return {"found": False, "who": who,
                "reason": "no person matches that name or id"}
    buttons = load_personal(person["zitadel_id"])
    return {
        "found": True,
        "name": person["display_name"] or person["username"],
        "zitadel_id": person["zitadel_id"],
        "buttons": [_describe(b) for b in buttons[:limit]],
        "total": len(buttons),
        "max": PERSONAL_MAX,
    }
