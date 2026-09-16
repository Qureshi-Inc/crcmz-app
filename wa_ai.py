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

# Message IDs of messages we've sent — learned from from_me echoes coming back
# through ingest. When someone swipe-replies to one of these, reply_to will
# match and we know it's directed at us.
_recent_sent_ids: list[str] = []
_SENT_IDS_KEEP = 60

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
    """Remember our own id and sent message IDs from messages we sent."""
    if not (msg.get("from_me") or msg.get("fromMe")):
        return
    me = _digits(msg.get("sender_jid") or msg.get("from") or "")
    if me and me not in _self_ids:
        _self_ids.add(me)
        logger.info("wa_ai: learned our own WhatsApp id %s", me)
    msg_id = msg.get("message_id") or msg.get("id") or ""
    if msg_id and msg_id not in _recent_sent_ids:
        _recent_sent_ids.append(msg_id)
        del _recent_sent_ids[:-_SENT_IDS_KEEP]


def self_ids() -> set[str]:
    return set(_self_ids)


def trigger_from(msg: dict, group_jid: str = "") -> str | None:
    """The question in an ingested WhatsApp message, or None.

    Skips our own messages: a reply we send comes straight back through ingest
    with from_me set, and if the model opened with "ai ..." the bot would answer
    itself forever.

    Three trigger paths:
      1. "@<our-id> <anything>" — mentioning the bot is asking the bot.
      2. Quoted reply to one of our messages (the normal WhatsApp reply gesture).
      3. "ai <question>" prefix — for when neither of the above applies.
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

    # Path 2: quoted reply to one of our messages — no prefix needed.
    # The Baileys bridge stores the quoted message ID in reply_to / quotedMessageId.
    # Our own messages come back through ingest with from_me=True; learn_self()
    # records their IDs in _recent_sent_ids so we can match here.
    reply_to = msg.get("reply_to") or msg.get("quotedMessageId") or ""
    if reply_to and reply_to in _recent_sent_ids:
        return text[:400]

    # Path 1: @mention.
    lead = _MENTION.match(text)
    if lead:
        mentioned = set(_MENTION_ID.findall(lead.group(0)))
        rest = text[lead.end():].strip()
        # Tagged us? Then whatever follows is the question, "ai" or not.
        if mentioned & _self_ids and rest:
            return parse_trigger(rest) or rest[:400]
        # Don't know our own ID yet (WA_BOT_IDS not set): treat any @mention
        # with following text as a trigger so the bot responds from day one.
        # Once WA_BOT_IDS is set, only actual @mentions of us fire.
        if not _self_ids and rest:
            return rest[:400]
        # We know our IDs but this mention isn't us — still catch "ai ..." in rest.
        return parse_trigger(rest)

    # Path 3: plain "ai ..." prefix.
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
