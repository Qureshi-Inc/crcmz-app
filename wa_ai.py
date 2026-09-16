"""The "ai …" bot in the WhatsApp group.

Third surface for the same assistant: the Ask AI tab answers on the web, psn_ai
answers in the PSN group, and this answers in WhatsApp. One brain, one set of
squad facts, three doors.

Messages arrive at /api/whatsapp/ingest from the Baileys bridge (they are already
being stored for analytics), so nothing new polls anything -- a triggered message
just gets an extra background job. The reply goes back out through the bridge's
/send endpoint, which is the same path the clip forwarder already uses.
"""

from __future__ import annotations

import logging
import os
import re

import httpx

from psn_ai import parse_trigger      # one trigger for every surface

logger = logging.getLogger(__name__)

MAX_REPLY_CHARS = 900     # WhatsApp is roomier than PSN, but still a chat
_recent_replies: list[str] = []
_RECENT_KEEP = 20

# On WhatsApp the natural way to talk to a bot is to @mention it, which puts the
# mention ahead of everything: "@56767304183939 ai yo". So mentions are stripped
# before the trigger is read, and a mention OF US is itself a trigger -- no "ai"
# needed, because tagging the bot is already asking the bot.
_MENTION = re.compile(r"^\s*(?:@(\d{5,})\s*)+")
_MENTION_ID = re.compile(r"@(\d{5,})")

# Our own numbers. WA_BOT_IDS seeds them; anything the bot sends teaches it the
# rest, since our own messages come back through ingest with from_me set.
_self_ids: set[str] = {i.strip() for i in
                       os.environ.get("WA_BOT_IDS", "").split(",") if i.strip()}


def _digits(jid: str) -> str:
    return re.sub(r"\D", "", (jid or "").split("@")[0].split(":")[0])


def learn_self(msg: dict) -> None:
    """Remember our own id from a message WhatsApp says we sent."""
    if not (msg.get("from_me") or msg.get("fromMe")):
        return
    me = _digits(msg.get("sender_jid") or msg.get("from") or "")
    if me and me not in _self_ids:
        _self_ids.add(me)
        logger.info("wa_ai: learned our own WhatsApp id %s", me)


def self_ids() -> set[str]:
    return set(_self_ids)


def trigger_from(msg: dict, group_jid: str = "") -> str | None:
    """The question in an ingested WhatsApp message, or None.

    Skips our own messages: a reply we send comes straight back through ingest
    with from_me set, and if the model opened with "ai ..." the bot would answer
    itself forever.
    """
    if not isinstance(msg, dict) or msg.get("type") == "reaction":
        return None
    if msg.get("from_me") or msg.get("fromMe"):
        learn_self(msg)
        return None
    jid = msg.get("group_jid") or msg.get("groupJid") or ""
    if group_jid and jid and jid != group_jid:
        return None
    text = (msg.get("text") or msg.get("body") or "").strip()
    if not text or text in _recent_replies:
        return None

    lead = _MENTION.match(text)
    if lead:
        mentioned = set(_MENTION_ID.findall(lead.group(0)))
        rest = text[lead.end():].strip()
        # Tagged us? Then whatever follows is the question, "ai" or not.
        if mentioned & _self_ids and rest:
            return parse_trigger(rest) or rest[:400]
        # We may not know our own number yet (it is learned from our first
        # reply), so "@somebody ai ..." is still treated as ours.
        return parse_trigger(rest)
    return parse_trigger(text)


def sender_name(msg: dict) -> str:
    jid = msg.get("sender_jid") or msg.get("from") or ""
    return (msg.get("sender_name") or msg.get("pushName")
            or (jid.split("@")[0] if jid else "") or "someone")


def send_reply(bridge_url: str, group_jid: str, text: str) -> bool:
    """Send the answer to the group through the Baileys bridge."""
    text = (text or "").strip()
    if not text or not bridge_url or not group_jid:
        return False
    if len(text) > MAX_REPLY_CHARS:
        text = text[:MAX_REPLY_CHARS - 1].rstrip() + "…"
    try:
        r = httpx.post(f"{bridge_url.rstrip('/')}/send",
                       json={"message": text, "groupJid": group_jid}, timeout=30)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        logger.warning("wa_ai: could not send the reply: %s", e)
        return False
    _recent_replies.append(text)
    del _recent_replies[:-_RECENT_KEEP]
    return True
