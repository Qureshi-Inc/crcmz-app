"""Discord ↔ PSN text bridge.

PSN → Discord: all plain text messages from the watched PSN groups are
               forwarded to DISCORD_SQUAD_CHANNEL_ID as
               "**[psnusername]** message".

Discord → PSN: all non-bot messages posted in DISCORD_SQUAD_CHANNEL_ID are
               forwarded to the main PSN group as "[discordusername] message"
               via the registered send callback (CRCMZ-BOT account).

Loop prevention:
  • PSN → Discord skips messages whose sender matches the bot's own PSN
    online ID (so Discord-originated echo-backs are dropped).
  • Discord → PSN skips any message whose author has is_bot=true.
"""

import asyncio
import json
import logging
import os
import threading
import time

import requests

logger = logging.getLogger(__name__)

DISCORD_API = "https://discord.com/api/v10"
DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json"
_BOT_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
_SQUAD_CHANNEL = os.environ.get("DISCORD_SQUAD_CHANNEL_ID", "")

# Gateway opcodes
_OP_DISPATCH = 0
_OP_HEARTBEAT = 1
_OP_IDENTIFY = 2
_OP_HELLO = 10

# Intents: GUILDS(1) + GUILD_MESSAGES(512) + MESSAGE_CONTENT(32768)
_INTENTS = 1 | 512 | 32768

_send_psn_fn = None   # callable(text: str) -> bool  — set via configure()
_bot_psn_id: str = "" # PSN online_id of the CRCMZ-BOT account — set via configure()


def configure(send_psn: "callable", bot_psn_id: str = "") -> None:
    """Wire up the PSN send function and the bot's own PSN online ID."""
    global _send_psn_fn, _bot_psn_id
    _send_psn_fn = send_psn
    _bot_psn_id = bot_psn_id


def is_configured() -> bool:
    return bool(_BOT_TOKEN and _SQUAD_CHANNEL)


# ---------------------------------------------------------------------------
# PSN → Discord
# ---------------------------------------------------------------------------

def forward_psn_to_discord(sender: str, text: str) -> None:
    """Non-blocking: post a PSN text message to #the-squad on Discord."""
    if not is_configured():
        return
    if _bot_psn_id and sender == _bot_psn_id:
        return  # don't echo our own Discord-originated messages back
    if not text:
        return
    content = f"**[{sender}]** {text}"
    threading.Thread(
        target=_post_discord_text, args=(content,), daemon=True
    ).start()


def _post_discord_text(content: str) -> None:
    try:
        resp = requests.post(
            f"{DISCORD_API}/channels/{_SQUAD_CHANNEL}/messages",
            headers={
                "Authorization": f"Bot {_BOT_TOKEN}",
                "Content-Type": "application/json",
            },
            json={"content": content},
            timeout=10,
        )
        if resp.status_code not in (200, 201):
            logger.warning("discord_bridge: post failed %d: %s", resp.status_code, resp.text[:120])
    except Exception as exc:
        logger.error("discord_bridge: post error: %s", exc)


# ---------------------------------------------------------------------------
# Discord → PSN  (gateway WebSocket listener)
# ---------------------------------------------------------------------------

async def run_discord_listener() -> None:
    """Long-running async task — reconnects on any error."""
    if not is_configured():
        logger.info("discord_bridge: DISCORD_SQUAD_CHANNEL_ID not set, listener disabled")
        return

    while True:
        try:
            await _gateway_session()
        except Exception as exc:
            logger.error("discord_bridge: gateway error, reconnecting in 15s: %s", exc)
        await asyncio.sleep(15)


async def _gateway_session() -> None:
    import aiohttp

    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(
            DISCORD_GATEWAY,
            heartbeat=None,  # we handle heartbeat manually
        ) as ws:
            heartbeat_interval: float = 41.25
            last_seq: int | None = None
            hb_task: asyncio.Task | None = None

            async def _heartbeat_loop() -> None:
                await asyncio.sleep(heartbeat_interval * (0.5 + 0.5 * (time.monotonic() % 1)))
                while True:
                    await ws.send_str(json.dumps({"op": _OP_HEARTBEAT, "d": last_seq}))
                    await asyncio.sleep(heartbeat_interval)

            async for raw in ws:
                if raw.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(raw.data)
                op = data.get("op")

                if op == _OP_HELLO:
                    heartbeat_interval = data["d"]["heartbeat_interval"] / 1000.0
                    hb_task = asyncio.create_task(_heartbeat_loop())
                    await ws.send_str(json.dumps({
                        "op": _OP_IDENTIFY,
                        "d": {
                            "token": _BOT_TOKEN,
                            "intents": _INTENTS,
                            "properties": {"os": "linux", "browser": "crcmz", "device": "crcmz"},
                        },
                    }))

                elif op == _OP_HEARTBEAT:
                    await ws.send_str(json.dumps({"op": _OP_HEARTBEAT, "d": last_seq}))

                elif op == _OP_DISPATCH:
                    last_seq = data.get("s")
                    if data.get("t") == "MESSAGE_CREATE":
                        _handle_discord_message(data.get("d", {}))

            if hb_task:
                hb_task.cancel()


def _handle_discord_message(d: dict) -> None:
    if d.get("channel_id") != _SQUAD_CHANNEL:
        return
    author = d.get("author", {})
    if author.get("bot"):
        return
    content = (d.get("content") or "").strip()
    if not content:
        return
    username = author.get("username", "Discord")
    psn_text = f"[{username}] {content}"
    logger.info("discord_bridge: Discord→PSN %r", psn_text)
    if _send_psn_fn:
        try:
            _send_psn_fn(psn_text)
        except Exception as exc:
            logger.error("discord_bridge: PSN send failed: %s", exc)
