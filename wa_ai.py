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

import httpx

from psn_ai import parse_trigger      # one trigger for every surface

logger = logging.getLogger(__name__)

MAX_REPLY_CHARS = 900     # WhatsApp is roomier than PSN, but still a chat
_recent_replies: list[str] = []
_RECENT_KEEP = 20


def trigger_from(msg: dict, group_jid: str = "") -> str | None:
    """The question in an ingested WhatsApp message, or None.

    Skips our own messages: a reply we send comes straight back through ingest
    with from_me set, and if the model opened with "ai ..." the bot would answer
    itself forever.
    """
    if not isinstance(msg, dict) or msg.get("type") == "reaction":
        return None
    if msg.get("from_me") or msg.get("fromMe"):
        return None
    jid = msg.get("group_jid") or msg.get("groupJid") or ""
    if group_jid and jid and jid != group_jid:
        return None
    text = msg.get("text") or msg.get("body") or ""
    if text.strip() in _recent_replies:
        return None
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
