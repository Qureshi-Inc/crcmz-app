"""Platform assistant — a tool-calling loop over the data this app already has.

The model runs on the local Mac (omlx / LM Studio, OpenAI-compatible), same box
Huddle and the Chat Board buttons use. Nothing leaves the LAN.

Why tools instead of embeddings: this platform's data is SQL and JSON, not prose.
"Who talks most in the mornings" is a GROUP BY, not a nearest-neighbour lookup, so
the model is given read-only functions over the real tables and answers from what
they return. The registry below doubles as the documented read surface of the
platform: every question the assistant can answer is one of these.

Tools are READ ONLY on purpose. Nothing here sends a PSN or WhatsApp message,
mutates a giveaway, or writes to a database -- a jailbroken prompt still cannot
do anything but look.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Callable

import httpx

logger = logging.getLogger(__name__)

# Qwen is the tool-calling model on the omlx box; gemma stays on button flavor.
DEFAULT_MODEL = "Qwen3.6-35B-A3B-MLX-8bit"
MAX_STEPS = 6                 # model turns per question (tool round-trips)
MAX_TOOL_CHARS = 6000         # per-tool result budget handed back to the model
REQUEST_TIMEOUT = 180.0       # a 35B MLX model on a Mac is not instant

_RANGES = ["today", "last_7_days", "last_30_days", "last_90_days",
           "this_month", "prev_month", "this_year", "all_time"]

SYSTEM_PROMPT = (
    "You are the CRCMZ platform assistant, embedded in the squad's private app "
    "(PSN group chat, WhatsApp analytics, clips, trophies).\n"
    "Answer ONLY from the tools. Never invent a number, name, date or quote: if "
    "a tool did not return it, say you do not have it.\n"
    "Call a tool whenever the question touches platform data, and call several "
    "if you need to. Prefer the narrowest range that answers the question.\n"
    "Today is {today}.\n"
    "Style: short, plain, group-chat casual. Give the numbers you actually got, "
    "and name the range they cover. No preamble, no bullet lists unless asked."
)


# ── Tool registry ──────────────────────────────────────────────────────────────
# Each entry: name -> (description, JSON-Schema parameters, callable).
# The callable receives validated kwargs and returns something JSON-serialisable.

_TOOLS: dict[str, dict[str, Any]] = {}


def tool(name: str, description: str, parameters: dict) -> Callable:
    def register(fn: Callable) -> Callable:
        _TOOLS[name] = {"description": description, "parameters": parameters, "fn": fn}
        return fn
    return register


def _range_param(extra: dict | None = None) -> dict:
    props = {
        "range": {"type": "string", "enum": _RANGES,
                  "description": "Time window. Defaults to all_time."},
    }
    props.update(extra or {})
    return {"type": "object", "properties": props, "required": []}


def _wa():
    import whatsapp_analytics
    return whatsapp_analytics


@tool("platform_overview",
      "What data this platform holds right now: WhatsApp message counts and date "
      "span, clip counts, squad size. Call this first when a question is vague.",
      {"type": "object", "properties": {}, "required": []})
def _overview() -> dict:
    from datetime import datetime
    out: dict[str, Any] = {}
    try:
        s = _wa().stats("all_time")
        span = ""
        if s.get("first_ts") and s.get("last_ts"):
            span = (f'{datetime.fromtimestamp(s["first_ts"]).date()} to '
                    f'{datetime.fromtimestamp(s["last_ts"]).date()}')
        out["whatsapp"] = {
            "group": "Professional Goopers",
            "messages": s.get("total_messages"),
            "members": s.get("total_members"),
            "date_span": span,
            "media_messages": s.get("total_media"),
            "photos_known": s.get("total_photos"),
            "videos_known": s.get("total_videos"),
        }
    except Exception as e:  # noqa: BLE001
        out["whatsapp"] = {"error": str(e)}
    try:
        import clips
        out["clips"] = clips.stats()
    except Exception as e:  # noqa: BLE001
        out["clips"] = {"error": str(e)}
    return out


@tool("whatsapp_stats",
      "Totals for the WhatsApp group: message count, member count, active days, "
      "and messages per member. total_media counts messages that carried an "
      "attachment; total_photos/total_videos are only known for messages "
      "received live (an export just says '<Media omitted>'), so a 0 there does "
      "not mean nothing was shared -- quote total_media instead.",
      _range_param())
def _wa_stats(range: str = "all_time") -> dict:  # noqa: A002
    return _wa().stats(range)


@tool("whatsapp_activity",
      "When the group talks: counts by hour of day, by weekday, by month, and "
      "the busiest single days.",
      _range_param())
def _wa_activity(range: str = "all_time") -> dict:  # noqa: A002
    a = _wa().activity(range)
    # `daily` and `member_monthly` are hundreds of rows; the model does not need
    # them to answer "when is the group most active".
    return {k: a[k] for k in ("by_hour", "by_dow", "monthly", "top_days") if k in a}


@tool("whatsapp_search",
      "Find real WhatsApp messages by text and/or sender, newest first. Use this "
      "to quote what someone actually said. Returns at most 50 messages.",
      {"type": "object",
       "properties": {
           "query": {"type": "string", "description": "Text to look for, e.g. 'iced cap'."},
           "sender": {"type": "string", "description": "Sender name, partial match."},
           "range": {"type": "string", "enum": _RANGES},
           "limit": {"type": "integer", "description": "1-50, default 20."},
       },
       "required": []})
def _wa_search(query: str = "", sender: str = "", range: str = "all_time",  # noqa: A002
               limit: int = 20) -> dict:
    return _wa().search(query=query, sender=sender, range_str=range, limit=limit)


@tool("whatsapp_members",
      "Per-member WhatsApp breakdown: message counts, media sent, average "
      "message length, first and last seen.",
      _range_param())
def _wa_members(range: str = "all_time") -> dict:  # noqa: A002
    return _wa().members(range)


@tool("whatsapp_words",
      "Most used words in the group chat, with counts.",
      _range_param({"limit": {"type": "integer", "description": "How many words, default 25."}}))
def _wa_words(range: str = "all_time", limit: int = 25) -> dict:  # noqa: A002
    return _wa().words(range, limit=max(1, min(int(limit or 25), 100)))


@tool("whatsapp_emojis",
      "Most used emojis in the group chat, overall and per member.",
      _range_param())
def _wa_emojis(range: str = "all_time") -> dict:  # noqa: A002
    return _wa().emojis(range)


@tool("whatsapp_awards",
      "The group's computed awards/superlatives (biggest yapper, night owl, "
      "ghost, etc.) with the numbers behind each one.",
      _range_param())
def _wa_awards(range: str = "all_time") -> dict:  # noqa: A002
    return _wa().awards(range)


@tool("whatsapp_response_times",
      "How fast each member replies, and the group's average response time.",
      _range_param())
def _wa_response_times(range: str = "all_time") -> dict:  # noqa: A002
    return _wa().response_times(range)


@tool("psn_squad_status",
      "Live PSN presence for every linked squad member: online/offline, what "
      "they are playing, and trophy level.",
      {"type": "object", "properties": {}, "required": []})
def _squad() -> Any:
    import psn_data
    import server                      # for the shared, already-authed client
    if not getattr(server, "_v2_available", False):
        return {"error": "PSN auth unavailable"}
    squad = psn_data.squad_status(server.psn_auth)
    keep = ("online_id", "online", "status", "playing", "platform", "game",
            "trophy_level", "trophy_tier", "platinum", "trophy_total", "last_online")
    return [{k: m.get(k) for k in keep if k in m} for m in squad]


@tool("recent_clips",
      "Recently captured PSN clips: who shared them, when, how long, and their "
      "status. `sender` must be an exact PSN online ID.",
      {"type": "object",
       "properties": {
           "limit": {"type": "integer", "description": "1-25, default 10."},
           "sender": {"type": "string", "description": "Exact PSN online ID."},
           "month": {"type": "string", "description": "Month as YYYY-MM."},
       },
       "required": []})
def _clips(limit: int = 10, sender: str = "", month: str = "") -> Any:
    from datetime import datetime
    import clips as clips_mod
    rows = clips_mod.list_clips(month=month or None, sender=sender or None,
                                limit=max(1, min(int(limit or 10), 25)))
    out = []
    for r in rows:
        when = r.get("psn_created_at") or r.get("discovered_at")
        out.append({
            "sender": r.get("sender_online_id"),
            "when": datetime.fromtimestamp(when).strftime("%Y-%m-%d %H:%M") if when else None,
            "duration_seconds": r.get("duration_seconds"),
            "status": r.get("status"),
            "archived": r.get("archive_status") == "archived",
        })
    return out


def tool_specs() -> list[dict]:
    """The registry in OpenAI function-calling form."""
    return [
        {"type": "function",
         "function": {"name": name, "description": t["description"],
                      "parameters": t["parameters"]}}
        for name, t in _TOOLS.items()
    ]


def tool_names() -> list[str]:
    return list(_TOOLS)


def call_tool(name: str, args: dict) -> tuple[str, bool]:
    """Run one tool. Returns (json_text, ok) -- errors go back to the model."""
    spec = _TOOLS.get(name)
    if spec is None:
        return json.dumps({"error": f"no such tool: {name}",
                           "available": tool_names()}), False
    allowed = set(spec["parameters"].get("properties", {}))
    clean = {k: v for k, v in (args or {}).items() if k in allowed}
    dropped = sorted(set(args or {}) - allowed)
    try:
        result = spec["fn"](**clean)
    except TypeError as e:
        return json.dumps({"error": f"bad arguments for {name}: {e}"}), False
    except Exception as e:  # noqa: BLE001
        logger.warning("assistant tool %s failed: %s", name, e)
        return json.dumps({"error": f"{name} failed: {e}"}), False
    payload = json.dumps(result, default=str)
    if len(payload) > MAX_TOOL_CHARS:
        payload = payload[:MAX_TOOL_CHARS] + f'… (truncated at {MAX_TOOL_CHARS} chars)'
    if dropped:
        logger.info("assistant tool %s ignored unknown args %s", name, dropped)
    return payload, True


# ── Model plumbing ─────────────────────────────────────────────────────────────

def _config() -> tuple[str, str, str]:
    base = os.environ.get("OLLAMA_BASE_URL", "").strip().rstrip("/")
    model = (os.environ.get("ASSISTANT_MODEL", "").strip() or DEFAULT_MODEL)
    key = os.environ.get("OLLAMA_API_KEY", "").strip()
    return base, model, key


def available() -> bool:
    return bool(_config()[0])


def _chat(messages: list[dict], model: str, base: str, key: str) -> dict:
    """One /v1/chat/completions round trip with the tool registry attached."""
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    payload = {
        "model": model,
        "messages": messages,
        "tools": tool_specs(),
        "tool_choice": "auto",
        "stream": False,
        "temperature": 0.2,
    }
    with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
        r = client.post(f"{base}/chat/completions", json=payload, headers=headers)
        r.raise_for_status()
        return r.json()


def _tool_calls_from(message: dict) -> list[dict]:
    """Native tool_calls, else a bare JSON tool call the model typed as text.

    Small local runtimes sometimes emit {"name": ..., "arguments": {...}} in the
    content instead of a real tool_calls array; treating that as an answer would
    show the user raw JSON, so it is parsed the same way.
    """
    calls = message.get("tool_calls") or []
    if calls:
        return calls
    content = (message.get("content") or "").strip()
    if not (content.startswith("{") and '"name"' in content):
        return []
    try:
        obj = json.loads(content)
    except ValueError:
        return []
    name = obj.get("name") or obj.get("tool")
    if name not in _TOOLS:
        return []
    args = obj.get("arguments") or obj.get("parameters") or {}
    return [{"id": "text-call-1", "type": "function",
             "function": {"name": name, "arguments": json.dumps(args)}}]


def ask(question: str, history: list[dict] | None = None) -> dict:
    """Answer `question` with tools. Returns answer + the trail of tool calls."""
    from datetime import datetime

    question = (question or "").strip()
    if not question:
        raise ValueError("question cannot be empty")
    if len(question) > 1000:
        raise ValueError("question too long (1000 char max)")

    base, model, key = _config()
    if not base:
        raise RuntimeError("no local model configured (set OLLAMA_BASE_URL)")

    messages: list[dict] = [
        {"role": "system",
         "content": SYSTEM_PROMPT.format(today=datetime.now().strftime("%A %Y-%m-%d"))},
    ]
    # Prior turns, trimmed: only user/assistant text, last 3 exchanges.
    for turn in (history or [])[-6:]:
        role = turn.get("role")
        content = (turn.get("content") or "")[:1500]
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": question})

    trail: list[dict] = []
    started = time.time()
    for step in range(MAX_STEPS):
        data = _chat(messages, model, base, key)
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        calls = _tool_calls_from(message)

        if not calls:
            answer = (message.get("content") or "").strip()
            return {
                "answer": answer or "I could not come up with an answer for that.",
                "tools_used": [t["tool"] for t in trail],
                "steps": trail,
                "model": model,
                "elapsed_ms": int((time.time() - started) * 1000),
            }

        messages.append({"role": "assistant",
                         "content": message.get("content") or "",
                         "tool_calls": calls})
        for call in calls:
            fn = call.get("function") or {}
            name = fn.get("name") or ""
            raw_args = fn.get("arguments")
            if isinstance(raw_args, str):
                try:
                    args = json.loads(raw_args or "{}")
                except ValueError:
                    args = {}
            else:
                args = raw_args or {}
            result, ok = call_tool(name, args)
            trail.append({"tool": name, "args": args, "ok": ok,
                          "chars": len(result)})
            messages.append({"role": "tool",
                             "tool_call_id": call.get("id") or name,
                             "name": name,
                             "content": result})

    # Ran out of steps: ask for a final answer with no tools left to call.
    messages.append({"role": "user",
                     "content": "Answer now, using only what the tools returned."})
    data = _chat(messages, model, base, key)
    answer = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return {
        "answer": answer.strip() or "I ran out of steps before finding that out.",
        "tools_used": [t["tool"] for t in trail],
        "steps": trail,
        "model": model,
        "truncated": True,
        "elapsed_ms": int((time.time() - started) * 1000),
    }
