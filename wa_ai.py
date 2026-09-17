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

import json
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
# Persisted to disk so docker restarts don't break swipe-reply.
_recent_sent_ids: list[str] = []
_SENT_IDS_KEEP = 60
_SENT_IDS_FILE = os.path.join(os.path.dirname(__file__), "data", "sent_ids.json")


def _load_sent_ids() -> None:
    try:
        with open(_SENT_IDS_FILE) as f:
            ids = json.load(f)
        if isinstance(ids, list):
            _recent_sent_ids.extend(str(i) for i in ids[-_SENT_IDS_KEEP:])
            logger.info("wa_ai: loaded %d sent ids from disk", len(_recent_sent_ids))
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning("wa_ai: could not load sent ids: %s", e)


def _save_sent_ids() -> None:
    try:
        os.makedirs(os.path.dirname(_SENT_IDS_FILE), exist_ok=True)
        with open(_SENT_IDS_FILE, "w") as f:
            json.dump(_recent_sent_ids[-_SENT_IDS_KEEP:], f)
    except Exception as e:
        logger.warning("wa_ai: could not save sent ids: %s", e)


_load_sent_ids()

# name → JID map built from ingest messages so the model can @mention correctly.
_MEMBER_JIDS_FILE = os.path.join(os.path.dirname(__file__), "data", "member_jids.json")
_member_jids: dict[str, str] = {}   # display_name (lowercased) → full JID


def _load_member_jids() -> None:
    try:
        with open(_MEMBER_JIDS_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            _member_jids.update(data)
            logger.info("wa_ai: loaded %d member jids from disk", len(_member_jids))
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning("wa_ai: could not load member jids: %s", e)


def _save_member_jids() -> None:
    try:
        os.makedirs(os.path.dirname(_MEMBER_JIDS_FILE), exist_ok=True)
        with open(_MEMBER_JIDS_FILE, "w") as f:
            json.dump(_member_jids, f)
    except Exception as e:
        logger.warning("wa_ai: could not save member jids: %s", e)


def learn_member(msg: dict) -> None:
    """Build name→JID map from every ingest message."""
    if msg.get("from_me") or msg.get("fromMe"):
        return
    jid = (msg.get("sender_jid") or msg.get("from") or "").strip()
    name = (msg.get("sender_name") or msg.get("pushName") or "").strip()
    if not jid or not name or "@" not in jid:
        return
    key = name.lower()
    if _member_jids.get(key) != jid:
        _member_jids[key] = jid
        _save_member_jids()
        logger.info("wa_ai: learned member jid %s -> %s", name, jid)


def member_jids() -> dict[str, str]:
    """Return a copy of the name→JID map for prompt injection."""
    return dict(_member_jids)


_load_member_jids()

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
        _save_sent_ids()


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
    has_image = bool(msg.get("image_b64") or msg.get("message_type") == "image")
    # An image with no caption still needs a prompt — use a default question.
    if not text:
        if not has_image:
            return None
        text = "what's in this image?"
    if text in _recent_replies:
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

    # Path 4: @mention of us anywhere in the message (middle, end, etc.).
    if _self_ids and set(_MENTION_ID.findall(text)) & _self_ids:
        clean = re.sub(r"@(?:" + "|".join(re.escape(i) for i in _self_ids) + r")", "", text).strip()
        return (clean or text)[:400]

    # Path 3: plain "ai ..." prefix.
    return parse_trigger(text)


def sender_name(msg: dict) -> str:
    jid = msg.get("sender_jid") or msg.get("from") or ""
    return (msg.get("sender_name") or msg.get("pushName")
            or (jid.split("@")[0] if jid else "") or "someone")


# Matches @Name mentions the model writes (e.g. @Mutasif, @moiz).
_MENTION_NAME = re.compile(r"@([A-Za-z][A-Za-z0-9_.]{1,30})")
# Matches raw @number — model should no longer write these but handle defensively.
_MENTION_NUM = re.compile(r"@(\d{7,})")


def resolve_inbound_mentions(text: str) -> str:
    """Replace @<number> in inbound messages with @<DisplayName> so the model
    understands who is being referenced instead of seeing a raw phone number."""
    if not text or "@" not in text:
        return text
    num_to_name = {jid.split("@")[0]: name for name, jid in _member_jids.items()}
    def _replace(m: re.Match) -> str:
        num = m.group(1)
        name = num_to_name.get(num)
        return f"@{name.title()}" if name else m.group(0)
    return _MENTION_NUM.sub(_replace, text)


def send_reply(bridge_url: str, group_jid: str, text: str) -> bool:
    """Send the answer to the group through the Baileys bridge."""
    text = (text or "").strip()
    if not text or not bridge_url or not group_jid:
        return False
    if len(text) > MAX_REPLY_CHARS:
        text = text[:MAX_REPLY_CHARS - 1].rstrip() + "…"

    # Resolve @Name → @number using the learned member JID map.
    # If the name isn't known yet, strip the @ so it reads as plain text.
    num_to_jid = {jid.split("@")[0]: jid for jid in _member_jids.values()}
    mention_jids: list[str] = []

    def _resolve_name(m: re.Match) -> str:
        raw = m.group(1)
        jid = _member_jids.get(raw.lower())
        if jid:
            number = jid.split("@")[0]
            mention_jids.append(jid)
            return f"@{number}"
        return raw   # no JID known — plain name, no @

    text = _MENTION_NAME.sub(_resolve_name, text)

    # Defensive pass: strip any raw @number still present that isn't learned.
    def _sanitize_num(m: re.Match) -> str:
        num = m.group(1)
        jid = f"{num}@s.whatsapp.net"
        if num in num_to_jid:
            mention_jids.append(num_to_jid[num])
            return m.group(0)
        return num  # strip @
    text = _MENTION_NUM.sub(_sanitize_num, text)
    try:
        r = httpx.post(f"{bridge_url.rstrip('/')}/send",
                       json={"message": text, "groupJid": group_jid,
                             "mentions": mention_jids}, timeout=30)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        logger.warning("wa_ai: could not send the reply: %s", e)
        return False
    _recent_replies.append(text)
    del _recent_replies[:-_RECENT_KEEP]
    # Record the message ID from the bridge response so swipe-replies can be
    # matched without relying on from_me echoes through ingest. Baileys bridges
    # typically return {id: "...", key: {id: "..."}, or messageId: "..."}.
    try:
        data = r.json()
        msg_id = (data.get("id") or data.get("messageId") or data.get("message_id")
                  or (data.get("key") or {}).get("id") or "")
        logger.info("wa_ai: bridge /send response: %s (id=%r)", data, msg_id)
        if msg_id and msg_id not in _recent_sent_ids:
            _recent_sent_ids.append(msg_id)
            del _recent_sent_ids[:-_SENT_IDS_KEEP]
            _save_sent_ids()
            logger.info("wa_ai: recorded sent msg id %s", msg_id)
    except Exception:  # noqa: BLE001
        pass
    return True
