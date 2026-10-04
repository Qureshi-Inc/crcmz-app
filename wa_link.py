"""Link a WhatsApp name to a CRCMZ account (Settings → WhatsApp).

WhatsApp messages only count for someone once their WhatsApp display name is in their
`wa_names` tag (crcmz_identity: the export has no phone numbers, so the name is the join).
Settings shows a message to send to the bot, with a one-time code in it:

    @CRCMZ BOT link my WhatsApp, I'm Soup: CRCMZ-K7QF29

When the bot sees a live code (in the group or a DM, mention or not), the sender's
WhatsApp name is added to that account's `wa_names`. The code is what proves who's
asking: "I'm Soup" alone would let anyone claim anyone's messages.

DB: /data/wa_link.db (the codes only; the link itself lives in Zitadel).
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

import crcmz_identity

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("WA_LINK_DB", "/data/wa_link.db"))
_lock = threading.Lock()
CODE_TTL_S = 3600
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # nothing that reads as another letter
CODE_RE = re.compile(r"\bCRCMZ-([A-Z2-9]{6})\b", re.I)
BOT_NAME = os.environ.get("WA_BOT_NAME", "CRCMZ BOT")


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.execute("CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, sub TEXT NOT NULL, created REAL NOT NULL)")


def _person(sub: str, *, refresh: bool = False) -> dict:
    return crcmz_identity.by_zitadel_id(refresh=refresh).get(sub) or {}


def _call_name(p: dict) -> str:
    return (p.get("display_name") or p.get("username") or "me").split()[0][:30]


def status(sub: str) -> dict:
    """What Settings shows: the names linked so far, and the message to send (a live code,
    made if there isn't one)."""
    init()
    now = time.time()
    with _lock, _conn() as db:
        db.execute("DELETE FROM codes WHERE created < ?", (now - CODE_TTL_S,))
        row = db.execute("SELECT code, created FROM codes WHERE sub = ?", (sub,)).fetchone()
        if row:
            code, created = row["code"], row["created"]
        else:
            code, created = "".join(secrets.choice(_ALPHABET) for _ in range(6)), now
            db.execute("INSERT INTO codes (code, sub, created) VALUES (?,?,?)", (code, sub, now))
    p = _person(sub)
    return {"names": list(p.get("wa_names") or []), "bot": BOT_NAME, "code": f"CRCMZ-{code}",
            "message": f"@{BOT_NAME} link my WhatsApp, I'm {_call_name(p)}: CRCMZ-{code}",
            "expires_in": int(created + CODE_TTL_S - now)}


def _owner_of(name: str) -> dict | None:
    want = name.casefold()
    return next((p for p in crcmz_identity.people() if want in {n.casefold() for n in p.get("wa_names") or []}), None)


def _write_names(sub: str, names: list[str]) -> bool:
    if names:
        ok = crcmz_identity.set_tag(sub, "wa_names", ", ".join(names))
    else:
        ok = crcmz_identity.clear_tag(sub, "wa_names")
    crcmz_identity.people(refresh=True)
    return ok


def _record_lid(sub: str, p: dict, sender_jid: str) -> None:
    """Remember the sender's WhatsApp id too (most are privacy "@lid" ids that no tag
    holds), so founder-only bot features can trust the id rather than the name."""
    jid = (sender_jid or "").strip()
    if not jid or crcmz_identity._normalise_jid(jid) in {
            crcmz_identity._normalise_jid(x) for x in (p.get("wa_jid"), p.get("wa_phone")) if x}:
        return
    have = crcmz_identity._split_tag((p.get("tags") or {}).get("wa_lids", ""))
    if jid not in have:
        crcmz_identity.set_tag(sub, "wa_lids", ", ".join(have + [jid]))
        crcmz_identity.people(refresh=True)


def link_from_message(text: str, sender_name: str, sender_jid: str = "") -> str | None:
    """A message with a live code in it: link the sender's WhatsApp name to the code's
    account and return the reply. None when the message has no code (not ours to answer)."""
    m = CODE_RE.search(text or "")
    if not m:
        return None
    init()
    code = m.group(1).upper()
    with _lock, _conn() as db:
        row = db.execute("SELECT sub, created FROM codes WHERE code = ?", (code,)).fetchone()
        if row:
            db.execute("DELETE FROM codes WHERE code = ?", (code,))   # one use
    if not row or time.time() - row["created"] > CODE_TTL_S:
        return "That link code isn't valid any more. Open Settings → WhatsApp in the CRCMZ app for a fresh one."
    name = (sender_name or "").strip()
    if not name or name.isdigit():
        return "I can't see your WhatsApp name. Set a name in WhatsApp's settings and try again with a fresh code."
    sub = row["sub"]
    p = _person(sub, refresh=True)
    other = _owner_of(name)
    if other and other.get("zitadel_id") != sub:
        logger.info("wa_link: %r is already linked to someone else", name)
        return f"“{name}” is already linked to another CRCMZ account. Ask Soup to sort it out."
    _record_lid(sub, p, sender_jid)
    names = list(p.get("wa_names") or [])
    if name.casefold() in {n.casefold() for n in names}:
        return f"You're already linked, {_call_name(p)}: “{name}” counts as you."
    if not _write_names(sub, names + [name]):
        return "Couldn't save that just now. Try again in a minute with a fresh code."
    logger.info("wa_link: linked WhatsApp name %r to %s", name, sub)
    return f"✅ Linked: “{name}” is {p.get('display_name') or _call_name(p)} on CRCMZ. Your WhatsApp messages count for you now."


def unlink(sub: str, name: str) -> dict:
    """Take one WhatsApp name off the caller's account."""
    p = _person(sub, refresh=True)
    names = [n for n in p.get("wa_names") or [] if n.casefold() != (name or "").casefold()]
    if len(names) == len(p.get("wa_names") or []):
        return {"ok": True, "names": names}
    if not _write_names(sub, names):
        raise RuntimeError("couldn't save")
    return {"ok": True, "names": names}
