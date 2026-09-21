"""Per-member AI Coach notification preference.

Keyed by Zitadel id, never by display name or PSN online ID — a member can rename
their PSN account and display names collide.

Default is `group`: the coaching review lands in the WhatsApp group, which is how
the squad already shares clips. A member who wants it privately switches to `dm`,
and `off` silences it without disabling the analysis.

Store: /data/coach_prefs.json (same shape as soundboard_personal.json — small,
rarely written, and easy to inspect by hand).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

_PATH = Path(os.environ.get("COACH_PREFS_PATH", "/data/coach_prefs.json"))
_lock = threading.Lock()

MODES = ("group", "dm", "off")
DEFAULT_MODE = "group"

# How much of the review goes in the message. "full" sends the formatted report and
# the link; "link" sends only the link and keeps the report on the platform.
DETAILS = ("full", "link")
DEFAULT_DETAIL = "full"


def _load() -> dict:
    try:
        with _PATH.open() as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:  # noqa: BLE001
        logger.warning("coach_prefs: unreadable at %s (%s) — using defaults", _PATH, e)
        return {}


def _save(data: dict) -> None:
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_suffix(".tmp")
    with tmp.open("w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
    tmp.replace(_PATH)          # atomic: a crash mid-write must not truncate prefs


def get_mode(zitadel_id: str) -> str:
    """Notification mode for a member. Unset members get the group default."""
    if not zitadel_id:
        return DEFAULT_MODE
    with _lock:
        entry = _load().get(zitadel_id) or {}
    mode = entry.get("notify") if isinstance(entry, dict) else None
    return mode if mode in MODES else DEFAULT_MODE


def set_mode(zitadel_id: str, mode: str) -> str:
    """Set and return the stored mode. Raises ValueError on an unknown mode."""
    if not zitadel_id:
        raise ValueError("zitadel_id is required")
    if mode not in MODES:
        raise ValueError("mode must be one of %s" % (", ".join(MODES),))
    with _lock:
        data = _load()
        entry = data.get(zitadel_id)
        if not isinstance(entry, dict):
            entry = {}
        entry["notify"] = mode
        data[zitadel_id] = entry
        _save(data)
    return mode


def get_detail(zitadel_id: str) -> str:
    """Whether to include the report body in the message, or just the link."""
    if not zitadel_id:
        return DEFAULT_DETAIL
    with _lock:
        entry = _load().get(zitadel_id) or {}
    d = entry.get("detail") if isinstance(entry, dict) else None
    return d if d in DETAILS else DEFAULT_DETAIL


def set_detail(zitadel_id: str, detail: str) -> str:
    if not zitadel_id:
        raise ValueError("zitadel_id is required")
    if detail not in DETAILS:
        raise ValueError("detail must be one of %s" % (", ".join(DETAILS),))
    with _lock:
        data = _load()
        entry = data.get(zitadel_id)
        if not isinstance(entry, dict):
            entry = {}
        entry["detail"] = detail
        data[zitadel_id] = entry
        _save(data)
    return detail


def all_modes() -> dict[str, str]:
    """Every explicitly-set preference. Members absent here are on the default."""
    with _lock:
        data = _load()
    out = {}
    for zid, entry in data.items():
        if isinstance(entry, dict) and entry.get("notify") in MODES:
            out[zid] = entry["notify"]
    return out
