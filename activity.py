"""Lightweight in-memory presence: who is currently in a slap solo session.
Huddle and Watch Party sessions come from LiveKit via /api/sessions/active;
this module only tracks solo Slap listeners so they can be seen and invited."""
import time
from threading import Lock

_TTL = 90

_lock = Lock()
_sessions: dict[str, dict] = {}


def ping(sub: str, name: str, kind: str, room: str = "") -> None:
    with _lock:
        _sessions[sub] = {"name": name, "type": kind, "room": room, "ts": time.time()}


def clear(sub: str) -> None:
    with _lock:
        _sessions.pop(sub, None)


def active() -> list[dict]:
    now = time.time()
    with _lock:
        return [
            {"name": v["name"], "type": v["type"], "room": v["room"]}
            for v in _sessions.values()
            if now - v["ts"] < _TTL
        ]
