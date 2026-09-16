"""AI Roast Bot — generates roasts using Bedrock and sends to PSN group."""

import asyncio
import json
import logging
import os
import random
import time

import boto3
import httpx

logger = logging.getLogger(__name__)

PSN_API_URL = "http://127.0.0.1:3000/v2/send"

INSIDER_LINES = [
    "{name} you hella weakk!",
    "{name}, have you ever? 👉👌",
    "you hear that shit!!",
    "{name} is COOKED 💀",
    "{name} down bad fr fr",
    "bro {name} is free",
    "{name} just vibing in the lobby again",
    "someone check on {name} 😭",
    "iced cap merchant {name}",
    "{name} rage quit incoming",
    "did {name} just die AGAIN?",
    "{name} playing like its his first day",
    "yo {name} extract for once challenge (IMPOSSIBLE)",
]

FRIENDS_CONTEXT = """
You are a savage but funny roast bot in a PSN gaming group chat. Generate short, punchy roasts (1-2 sentences max) about these friends:

MUTASIF:
- Professional services guy (corporate drone energy)
- Always leaves games and takes FOREVER to come back
- Really good at Arc Raiders PvE, learning PvP
- Does well in PvP sometimes but still learning the ropes
- Known for disappearing mid-session

SAMAD:
- Always drives a truck (trucker lifestyle)
- Comes on rarely
- Always wants to play Call of Duty instead of Arc Raiders
- FULL of excuses when he loses: "my R3 is broken", "my screen is tilted"
- King of cope

BRENDEN:
- Very skilled player, typically #1
- In Arc Raiders he pushes too aggressively, causing squad wipes
- At times his aggression costs the team
- Good at all games but his over-confidence gets the squad killed

ZUBI:
- Addicted to iced caps (Tim Hortons)
- Hardcore PvP guy on Arc Raiders
- Recently has been the ONLY one dying and not extracting in trios
- The supposed PvP god who can't survive

RULES:
- Roast ONE random person per message
- MAXIMUM 100 characters. Must fit in a PS notification preview.
- One short sentence only. No essays.
- Be MEAN. Ruthless. Millennial energy. No mercy.
- Profanity is encouraged. Swear freely.
- Reference their specific traits/habits
- Use gaming lingo, slang, and abbreviations
- Don't use hashtags or act like a bot
- Sound like a toxic friend roasting in 10 words or less
- Think Xbox 360 lobby energy meets group chat savagery
- Be vulgar, creative, and absolutely ruthless
"""

_client = boto3.client("bedrock-runtime", region_name="us-east-1")
_running = False
_task = None


def generate_roast() -> str:
    """Generate a roast — mix of AI and insider one-liners."""
    friends = ["Mutasif", "Samad", "Brenden", "Zubi"]
    target = random.choice(friends)

    # 30% chance of insider one-liner, 70% AI generated
    if random.random() < 0.3:
        line = random.choice(INSIDER_LINES).format(name=target)
        logger.info("Insider roast for %s: %s", target, line)
        return line

    response = _client.invoke_model(
        modelId="us.anthropic.claude-sonnet-4-6",
        contentType="application/json",
        accept="application/json",
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 150,
            "temperature": 1.0,
            "messages": [
                {
                    "role": "user",
                    "content": f"{FRIENDS_CONTEXT}\n\nGenerate a roast about {target}. Start the message with their name. Just the roast text, nothing else."
                }
            ]
        }),
    )

    result = json.loads(response["body"].read())
    roast = result["content"][0]["text"].strip()
    logger.info("AI roast for %s: %s", target, roast[:50])
    return roast


def generate_single_roast() -> str:
    """Generate one roast immediately (for on-demand button)."""
    return generate_roast()


_FLAVOR_PROMPT = (
    "You add a little flavor to a group-chat message. Keep the "
    "EXACT same meaning, wording, and intent as the input -- do "
    "NOT turn it into a roast, joke, or a message about someone "
    "else. Just lightly punch it up: keep their words, maybe fix "
    "casing and add 1-2 fitting emojis. If it's already good, "
    "return it almost unchanged. Output ONLY the final message, "
    "nothing else.\n\nMessage: {raw}"
)

# Chat Board buttons are flavored by the local Mac model (gemma on omlx / LM
# Studio) -- the same server Huddle's AI talks to, so there is one place to
# point at a model: OLLAMA_BASE_URL + OLLAMA_MODEL + OLLAMA_API_KEY.
# FLAVOR_MODEL overrides the model for buttons only. Bedrock is the fallback
# for deployments with no local server configured.


def _local_llm(prompt: str, *, max_tokens: int = 120,
               temperature: float = 0.6) -> str:
    """One non-streaming completion from the local model, or "" if unavailable.

    OpenAI-compatible when the base URL ends in /v1 (omlx, LM Studio),
    otherwise native Ollama /api/chat -- the same branching as /api/huddle/ai.
    Gemma has no system turn, so everything goes in one user message.
    """
    base = os.environ.get("OLLAMA_BASE_URL", "").strip().rstrip("/")
    if not base:
        return ""
    model = (os.environ.get("FLAVOR_MODEL", "").strip()
             or os.environ.get("OLLAMA_MODEL", "").strip())
    api_key = os.environ.get("OLLAMA_API_KEY", "").strip()
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    messages = [{"role": "user", "content": prompt}]
    if base.endswith("/v1"):
        url = f"{base}/chat/completions"
        payload = {"model": model, "messages": messages, "stream": False,
                   "max_tokens": max_tokens, "temperature": temperature}
    else:
        url = f"{base}/api/chat"
        payload = {"model": model, "messages": messages, "stream": False,
                   "options": {"temperature": temperature,
                               "num_predict": max_tokens}}
    with httpx.Client(timeout=60) as client:
        r = client.post(url, json=payload, headers=headers)
        r.raise_for_status()
        data = r.json()
    if data.get("choices"):
        return (data["choices"][0].get("message", {}).get("content") or "").strip()
    return ((data.get("message") or {}).get("content") or "").strip()


def _clean_flavor(out: str, raw: str) -> str:
    """Keep only a usable one-line message, else fall back to `raw`.

    Small local models like to add a preamble or fence the answer; anything
    that isn't a single short line is not worth sending to the group.
    """
    out = (out or "").strip()
    if out.startswith("```"):
        out = out.strip("`").split("\n", 1)[-1].strip()
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    if len(lines) != 1:
        return raw
    out = lines[0].strip().strip('"').strip("*").strip()
    # 200 chars is the button input limit; an essay means the model wandered.
    if not out or len(out) > 200:
        return raw
    return out


def flavor_message(raw: str) -> str:
    """Lightly spice up a user-written line WITHOUT changing its meaning.

    This must stay faithful to what the user typed -- same words/intent, just a
    little group-chat energy and a fitting emoji or two. It is NOT the roast bot,
    so it deliberately avoids the roast persona/FRIENDS_CONTEXT. Runs on the
    local model when one is configured, then Bedrock, then the raw text.
    """
    raw = (raw or "").strip()
    if not raw:
        return raw
    prompt = _FLAVOR_PROMPT.format(raw=raw)
    try:
        out = _local_llm(prompt)
        if out:
            out = _clean_flavor(out, raw)
            logger.info("flavored (local) custom message: %s -> %s",
                        raw[:40], out[:50])
            return out
    except Exception as e:  # noqa: BLE001
        logger.warning("local flavor_message failed (%s), trying Bedrock", e)
    try:
        response = _client.invoke_model(
            modelId="us.anthropic.claude-sonnet-4-6",
            contentType="application/json",
            accept="application/json",
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 120,
                "temperature": 0.6,
                "messages": [{"role": "user", "content": prompt}],
            }),
        )
        result = json.loads(response["body"].read())
        out = _clean_flavor(result["content"][0]["text"], raw)
        logger.info("flavored (bedrock) custom message: %s -> %s",
                    raw[:40], out[:50])
        return out or raw
    except Exception as e:  # noqa: BLE001
        logger.warning("flavor_message failed, using raw: %s", e)
        return raw


def send_roast(message: str) -> bool:
    """Send roast to PSN group."""
    with httpx.Client(timeout=10) as client:
        resp = client.post(PSN_API_URL, json={"message": message})
        return resp.status_code < 300


async def roast_loop():
    """Main loop — sends first roast immediately, then every 5-7 minutes."""
    global _running
    logger.info("Roast bot started 🔥")

    # Send first roast immediately
    try:
        roast = await asyncio.to_thread(generate_roast)
        success = await asyncio.to_thread(send_roast, roast)
        if success:
            logger.info("First roast sent: %s", roast[:50])
    except Exception as e:
        logger.error("First roast failed: %s", e)

    while _running:
        delay = random.randint(300, 420)
        logger.info("Next roast in %d seconds", delay)

        # Sleep in small chunks so we can stop quickly
        for _ in range(delay):
            if not _running:
                break
            await asyncio.sleep(1)

        if not _running:
            break

        # Send next roast
        try:
            roast = await asyncio.to_thread(generate_roast)
            success = await asyncio.to_thread(send_roast, roast)
            if success:
                logger.info("Roast sent: %s", roast[:50])
            else:
                logger.error("Failed to send roast")
        except Exception as e:
            logger.error("Roast generation failed: %s", e)

    logger.info("Roast bot stopped")


# The automatic roast loop is DISABLED by default -- it was firing periodic
# roasts (sometimes doubling up) that weren't wanted. Set ROAST_AUTO_ENABLED=1
# to re-enable the scheduled loop; otherwise start() is a no-op.
ROAST_AUTO_ENABLED = os.environ.get("ROAST_AUTO_ENABLED", "0") == "1"


def start():
    """Start the roast loop (only if explicitly enabled via env)."""
    global _running, _task
    if not ROAST_AUTO_ENABLED:
        logger.info("Roast auto-loop is disabled (ROAST_AUTO_ENABLED != 1)")
        return False
    if _running:
        return False
    _running = True
    _task = asyncio.create_task(roast_loop())
    return True


def stop():
    """Stop the roast loop."""
    global _running, _task
    if not _running:
        return False
    _running = False
    if _task:
        _task.cancel()
        _task = None
    return True


def is_running() -> bool:
    return _running
