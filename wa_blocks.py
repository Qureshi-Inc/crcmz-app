"""Admin → WhatsApp bot access: people the bot won't answer in WhatsApp.

A blocked member's messages are still stored (stats, memory, catch-ups) like anyone
else's; the bot just never replies to them: no "ai ...", no @mention, no swipe-reply.
Silent on purpose: a "you're blocked" reply is something to argue with.

Who is blocked is a CRCMZ account (Zitadel id), never a phone number. The group
does not send phone numbers: Baileys 7 hands over WhatsApp's `@lid` privacy id,
which can't be derived from the number. So a block records every WhatsApp id
known for that person:

  * `wa_jid` / `wa_phone` / `wa_lids` from the identity graph;
  * every `sender_jid` their linked WhatsApp names (`wa_names`) have posted from.

And it keeps learning: a message from a blocked person's name, from an id
nobody else owns, adds that id. Changing their WhatsApp name later doesn't get
round it. Unblock drops the lot.

DB: /data/wa_blocks.db. Admin-only moderation state; not an assistant/MCP tool
(the person blocked could otherwise ask the bot who is blocked).
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

import crcmz_identity

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("WA_BLOCKS_DB", "/data/wa_blocks.db"))
_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS blocks (
            sub        TEXT PRIMARY KEY,
            name       TEXT NOT NULL DEFAULT '',
            blocked_by TEXT NOT NULL DEFAULT '',
            created    REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS block_ids (
            wa_id TEXT PRIMARY KEY,          -- normalised: digits before @ / :
            sub   TEXT NOT NULL
        );
        """)


def _norm(jid: str) -> str:
    return crcmz_identity._normalise_jid(jid or "")


def _person_name(p: dict) -> str:
    return (p.get("display_name") or p.get("username") or p.get("zitadel_id") or "").strip()


def _known_ids(person: dict) -> set[str]:
    """Every WhatsApp id we can tie to this person, normalised."""
    tags = person.get("tags") or {}
    raw = [person.get("wa_jid", ""), person.get("wa_phone", ""),
           *crcmz_identity._split_tag(tags.get("wa_lids", ""))]
    ids = {_norm(r) for r in raw}

    # Ids their own linked names have posted from. Only names the graph maps to
    # this person (a name two people share is dropped there), never the bot's own
    # rows (from_me rows carry the group's JID), never a group JID.
    sub = person.get("zitadel_id")
    by_name = crcmz_identity.by_wa_name()
    names = [n for n in person.get("wa_names") or []
             if (by_name.get(n.strip().casefold()) or {}).get("zitadel_id") == sub]
    if names:
        try:
            import whatsapp_analytics as wa
            with sqlite3.connect(wa._DB_PATH, timeout=5.0) as db:
                q = ",".join("?" * len(names))
                rows = db.execute(
                    f"SELECT DISTINCT sender_jid FROM whatsapp_messages "
                    f"WHERE from_me=0 AND sender_jid IS NOT NULL AND sender_jid != '' "
                    f"AND sender_jid NOT LIKE '%@g.us' AND lower(sender_name) IN ({q})",
                    [n.strip().lower() for n in names]).fetchall()
            ids.update(_norm(r[0]) for r in rows)
        except Exception as e:  # noqa: BLE001 - the graph ids still block
            logger.warning("wa_blocks: message-history ids unavailable: %s", e)

    # Never claim an id the graph says is someone else's.
    owners = crcmz_identity.by_wa_jid()
    return {i for i in ids if i and (owners.get(i) or {}).get("zitadel_id", sub) == sub}


def block(sub: str, by: str = "") -> dict:
    """Block a CRCMZ account from invoking the WhatsApp bot. Returns the entry."""
    sub = (sub or "").strip()
    person = crcmz_identity.by_zitadel_id(refresh=True).get(sub)
    if not person:
        raise ValueError("unknown user")
    if person.get("is_bot"):
        raise ValueError("that's the bot")
    if by and by == sub:
        raise ValueError("you can't block yourself")
    ids = _known_ids(person)
    with _lock, _conn() as db:
        db.execute("INSERT INTO blocks (sub, name, blocked_by, created) VALUES (?,?,?,?) "
                   "ON CONFLICT(sub) DO UPDATE SET name=excluded.name",
                   (sub, _person_name(person), by or "", time.time()))
        db.executemany("INSERT OR REPLACE INTO block_ids (wa_id, sub) VALUES (?,?)",
                       [(i, sub) for i in ids])
    logger.info("wa_blocks: blocked %s (%d whatsapp ids) by %s", sub, len(ids), by or "?")
    return _entry(sub)


def unblock(sub: str) -> bool:
    with _lock, _conn() as db:
        n = db.execute("DELETE FROM blocks WHERE sub=?", (sub,)).rowcount
        db.execute("DELETE FROM block_ids WHERE sub=?", (sub,))
    if n:
        logger.info("wa_blocks: unblocked %s", sub)
    return bool(n)


def _entry(sub: str) -> dict:
    with _conn() as db:
        r = db.execute("SELECT sub, name, blocked_by, created FROM blocks WHERE sub=?", (sub,)).fetchone()
        n = db.execute("SELECT COUNT(*) FROM block_ids WHERE sub=?", (sub,)).fetchone()[0]
    if not r:
        return {}
    return {"zitadel_id": r["sub"], "name": r["name"], "blocked_by": r["blocked_by"],
            "created": r["created"], "whatsapp_ids": n}


def list_blocks() -> list[dict]:
    with _conn() as db:
        subs = [r[0] for r in db.execute("SELECT sub FROM blocks ORDER BY created DESC")]
    return [_entry(s) for s in subs]


def _blocked_subs() -> set[str]:
    with _conn() as db:
        return {r[0] for r in db.execute("SELECT sub FROM blocks")}


def is_blocked(sender_jid: str, sender_name: str = "") -> bool:
    """Is this WhatsApp sender someone the bot must not answer?

    By id first (the stored ids, then the identity graph), then by their linked
    WhatsApp name. A name match from an id nobody else owns is remembered.
    Fails open: a broken block list must not silence the bot for everyone.
    """
    try:
        subs = _blocked_subs()
        if not subs:
            return False
        jid = _norm(sender_jid)
        if jid:
            with _conn() as db:
                if db.execute("SELECT 1 FROM block_ids WHERE wa_id=?", (jid,)).fetchone():
                    return True
            owner = crcmz_identity.identify_jid(sender_jid)
            if owner:
                hit = owner.get("zitadel_id") in subs
                if hit:
                    _learn(jid, owner["zitadel_id"])
                return hit   # the id belongs to someone: their name doesn't matter
        person = crcmz_identity.identify_sender_name(sender_name) if sender_name else None
        if person and person.get("zitadel_id") in subs:
            if jid:
                _learn(jid, person["zitadel_id"])
            return True
        return False
    except Exception as e:  # noqa: BLE001
        logger.warning("wa_blocks: check failed, allowing: %s", e)
        return False


def _learn(wa_id: str, sub: str) -> None:
    with _lock, _conn() as db:
        if db.execute("INSERT OR IGNORE INTO block_ids (wa_id, sub) VALUES (?,?)", (wa_id, sub)).rowcount:
            logger.info("wa_blocks: learned another whatsapp id for blocked %s", sub)
