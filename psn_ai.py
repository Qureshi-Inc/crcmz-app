"""The "ai …" bot in The Squad PSN group.

Descended from the standalone psn-gpt script (github.com/InterestingSoup/psn-gpt),
which polled the group with its own PSNAWP session and asked Azure OpenAI with a
fixed persona. Folded in here instead of ported, for two reasons:

- a second PSNAWP session on the same account means a second copy of the NPSSO
  token to keep alive, and this app already owns and refreshes that token;
- the answer should come from the same brain as the Ask AI tab — the local
  uncensored model with the tools, the squad facts and the group's own history —
  which is exactly what a standalone script cannot reach.

So: same trigger, same group-chat feel, and now it can actually look things up.
Azure stays available in roast_bot-style fallback order (local first) via
assistant.py; nothing here talks to a model directly.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

logger = logging.getLogger(__name__)

SEEN_FILE = Path("/data/psn_ai_seen.json")
SEEN_KEEP = 300            # message uids remembered, so a reply never repeats
MAX_REPLY_CHARS = 700      # PSN truncates long messages in notifications anyway
MAX_REPLIES_PER_TICK = 2   # one person spamming "ai" cannot fan out
PROMPT_MAX = 400

# "ai what's the meta" / "ai, who yaps most" / "AI: settle this" / "@ai wyd"
_TRIGGER = re.compile(r"^\s*@?ai\s*[,:>-]?\s+(?P<prompt>.+)$", re.IGNORECASE | re.DOTALL)

# PSN writes these itself; they are never someone talking to the bot.
_SYSTEM_BODY = re.compile(r".+ sent a (video clip|screenshot)\.$", re.IGNORECASE)


def parse_trigger(body: str, max_chars: int = PROMPT_MAX) -> str | None:
    """The question after an "ai" prefix, or None if this is not for the bot.

    `max_chars` defaults to the PSN limit, which suits questions. WhatsApp passes a
    much larger one: a build brief is not a question, and truncating it at 400 chars
    silently amputated the spec mid-sentence before the engineer ever saw it.
    """
    body = (body or "").strip()
    if not body or _SYSTEM_BODY.match(body):
        return None
    m = _TRIGGER.match(body)
    if not m:
        return None
    prompt = " ".join(m.group("prompt").split())[:max_chars]
    return prompt or None


SENT_KEEP = 20             # recent replies remembered, to never answer ourselves


def _load_state() -> tuple[list[str], list[str]]:
    """(seen message uids, recent reply texts)."""
    try:
        data = json.loads(SEEN_FILE.read_text())
    except Exception:  # noqa: BLE001
        return [], []
    if isinstance(data, list):            # the original format: uids only
        return [str(u) for u in data][-SEEN_KEEP:], []
    if isinstance(data, dict):
        return ([str(u) for u in (data.get("uids") or [])][-SEEN_KEEP:],
                [str(t) for t in (data.get("sent") or [])][-SENT_KEEP:])
    return [], []


def _save_state(uids: list[str], sent: list[str]) -> None:
    try:
        SEEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        SEEN_FILE.write_text(json.dumps({"uids": uids[-SEEN_KEEP:],
                                         "sent": sent[-SENT_KEEP:]}))
    except Exception as e:  # noqa: BLE001
        logger.warning("psn_ai: could not save state: %s", e)


def poll_once(messenger, ask, *, limit: int = 10, send: bool = True,
              self_names: set[str] | None = None) -> list[dict]:
    """One pass over the group. Returns what it answered.

    `ask(prompt, author)` returns the reply text. Everything is injected so this
    is testable without PSN or a model.

    The first pass after a boot only records what is already in the group: nobody
    wants the bot waking up and answering a three-day-old "ai" from the backlog.
    """
    if messenger is None:
        return []
    first_run = not SEEN_FILE.exists()
    seen, sent_texts = _load_state()
    seen_set = set(seen)
    # The bot's own reply comes back on the next read. If the model happened to
    # open with "ai ..." that would be a trigger, and it would answer itself
    # forever, spamming the group -- so our own recent replies are never input.
    sent_set = set(sent_texts)
    own = {n.strip().lower() for n in (self_names or set()) if n}

    try:
        messages = messenger.get_messages(limit)
    except Exception as e:  # noqa: BLE001
        logger.warning("psn_ai: could not read the group: %s", e)
        return []

    # Oldest first, so a burst of questions is answered in the order asked.
    answered: list[dict] = []
    for msg in sorted(messages, key=lambda m: str(m.get("messageUid", ""))):
        uid = str(msg.get("messageUid") or "")
        if not uid or uid in seen_set:
            continue
        seen.append(uid)
        seen_set.add(uid)

        if first_run:
            continue
        body = (msg.get("body") or "").strip()
        author = msg.get("sender") or "someone"
        if body in sent_set or str(author).strip().lower() in own:
            continue
        prompt = parse_trigger(body)
        if not prompt:
            continue
        if len(answered) >= MAX_REPLIES_PER_TICK:
            # Leave it unseen so it gets picked up on the next tick.
            seen.pop()
            seen_set.discard(uid)
            break

        logger.info("psn_ai: %s asked %r", author, prompt[:80])
        try:
            reply = (ask(prompt, author) or "").strip()
        except Exception as e:  # noqa: BLE001
            logger.warning("psn_ai: answering failed: %s", e)
            reply = "my brain just crashed, ask me again in a sec"
        if not reply:
            continue
        if len(reply) > MAX_REPLY_CHARS:
            reply = reply[:MAX_REPLY_CHARS - 1].rstrip() + "…"
        if send:
            try:
                messenger.send_message(reply)
            except Exception as e:  # noqa: BLE001
                logger.warning("psn_ai: sending the reply failed: %s", e)
                continue
        sent_texts.append(reply)
        sent_set.add(reply)
        answered.append({"uid": uid, "author": author, "prompt": prompt,
                         "reply": reply, "at": int(time.time())})

    _save_state(seen, sent_texts)
    if first_run:
        logger.info("psn_ai: first pass — noted %d existing message(s), "
                    "answering from here on", len(seen))
    return answered
