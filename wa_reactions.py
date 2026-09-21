"""Per-clip WhatsApp reaction tracker.

Records clip_id → wa_message_id when a clip is delivered, then maintains the
current reaction set as add/remove events arrive from the bridge.

WhatsApp allows one reaction per user per message, so reactions is keyed by
(wa_message_id, sender_jid). An empty emoji in an incoming event means the
user removed their reaction — the row is deleted.

DB: /data/wa_reactions.db
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("WA_REACTIONS_DB", "/data/wa_reactions.db"))
_lock = threading.Lock()
_ready = False


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    global _ready
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS clip_wa_messages (
                clip_id        TEXT PRIMARY KEY,
                wa_message_id  TEXT NOT NULL,
                wa_chat_jid    TEXT NOT NULL DEFAULT '',
                tracked_at     REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cwm_msg
                ON clip_wa_messages(wa_message_id);

            -- Current reaction state: one row per (message, sender).
            -- Removed reactions are deleted, not tombstoned — this table
            -- always reflects what's actually on the message right now.
            CREATE TABLE IF NOT EXISTS clip_message_reactions (
                wa_message_id  TEXT NOT NULL,
                sender_jid     TEXT NOT NULL,
                sender_name    TEXT NOT NULL DEFAULT '',
                emoji          TEXT NOT NULL,
                reacted_at     REAL NOT NULL,
                PRIMARY KEY (wa_message_id, sender_jid)
            );
            CREATE INDEX IF NOT EXISTS idx_cmr_msg
                ON clip_message_reactions(wa_message_id);
        """)
        db.commit()
    _ready = True
    logger.info("wa_reactions: DB ready at %s", _DB_PATH)


def track_clip(clip_id: str, wa_message_id: str, wa_chat_jid: str = "") -> None:
    """Record that clip_id was delivered as wa_message_id in wa_chat_jid."""
    if not _ready or not clip_id or not wa_message_id:
        return
    now = time.time()
    with _lock, _conn() as db:
        db.execute(
            "INSERT OR REPLACE INTO clip_wa_messages"
            " (clip_id, wa_message_id, wa_chat_jid, tracked_at)"
            " VALUES (?,?,?,?)",
            (clip_id, wa_message_id, wa_chat_jid or "", now))
        db.commit()


def update_reaction(reaction: dict) -> None:
    """Upsert or delete a reaction from a bridge event.

    Called for every type='reaction' event, including removals (empty emoji).
    Swallows exceptions — must never break the webhook handler.
    """
    if not _ready:
        return
    try:
        target     = (reaction.get("target_msg_id") or reaction.get("id") or "").strip()
        sender_jid = (reaction.get("reactor_jid") or reaction.get("from") or "").strip()
        emoji      = (reaction.get("emoji") or reaction.get("text") or "").strip()
        sender_name = (reaction.get("reactor_name") or "").strip() or sender_jid.split("@")[0]
        if not target or not sender_jid:
            return
        now = time.time()
        with _lock, _conn() as db:
            if emoji:
                db.execute(
                    "INSERT OR REPLACE INTO clip_message_reactions"
                    " (wa_message_id, sender_jid, sender_name, emoji, reacted_at)"
                    " VALUES (?,?,?,?,?)",
                    (target, sender_jid, sender_name, emoji, now))
            else:
                # Empty emoji = user removed their reaction
                db.execute(
                    "DELETE FROM clip_message_reactions"
                    " WHERE wa_message_id=? AND sender_jid=?",
                    (target, sender_jid))
            db.commit()
    except Exception as e:  # noqa: BLE001
        logger.debug("wa_reactions: update_reaction failed: %s", e)


def reactions_for_clip(clip_id: str) -> dict:
    """Current reaction state for a clip. Returns tracked=False for unknown clips."""
    clip_id = (clip_id or "").strip()
    base: dict = {"clip_id": clip_id, "tracked": False,
                  "whatsapp_message_id": None, "reaction_count": 0, "reactions": []}
    if not clip_id:
        return base
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT wa_message_id, wa_chat_jid FROM clip_wa_messages WHERE clip_id=?",
            (clip_id,)).fetchone()
        if not row:
            return base
        wa_msg_id = row["wa_message_id"]
        rows = db.execute(
            "SELECT emoji, sender_name, sender_jid, reacted_at"
            " FROM clip_message_reactions WHERE wa_message_id=?"
            " ORDER BY reacted_at",
            (wa_msg_id,)).fetchall()
    import datetime as _dt
    reactions = [
        {
            "emoji":  r["emoji"],
            "sender": r["sender_name"] or r["sender_jid"].split("@")[0],
            "at":     _dt.datetime.fromtimestamp(
                          r["reacted_at"], tz=_dt.timezone.utc).isoformat(),
        }
        for r in rows
    ]
    return {
        "clip_id":             clip_id,
        "tracked":             True,
        "whatsapp_message_id": wa_msg_id,
        "reaction_count":      len(reactions),
        "reactions":           reactions,
    }
