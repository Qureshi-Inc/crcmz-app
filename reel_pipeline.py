"""Which highlight pipeline will claim a clip, and the trigger rules behind it.

This is the one place the clip triggers are defined. server.py uses the trigger
predicates at ingest; Reel Review shows the derived state on every clip so owners
spend their edits on clips that can still post. Change a trigger here and both
follow.

States, highest precedence first:

  posted          the clip is already up on @crcmzclan (ig_posts has its URL)
  twin_of_posted  same sender + file_size + duration as a posted clip; PSN
                  sometimes queues one video twice, and the pipeline dedupes the
                  copy, so it can never publish
  vetoed          vetoed in Reel Review, or a 🛑 tap-reaction on its WhatsApp message
  fire            🔥 in the message: the fire pipeline posts it
  fail            'fail' or 😂 in the message: posts once FAIL_REACTION_GATE
                  people react to it in WhatsApp
  daily_eligible  delivered, archived, <= DAILY_MAX_SECONDS, not a coaching clip
  not_eligible    anything else (too long, coaching, not archived yet)
"""

from __future__ import annotations

import re

_REV_RE = re.compile(r"\brev\b", re.IGNORECASE)
_FAIL_RE = re.compile(r"\bfail\b", re.IGNORECASE)
FAIL_REACTION_GATE = 2
DAILY_MAX_SECONDS = 60.0
VETO_EMOJI = "\U0001f6d1"


def wants_ig_post(caption: str | None) -> bool:
    return bool(caption) and "\U0001f525" in caption


def wants_fail_tag(caption: str | None) -> bool:
    """True for texts that tag a clip as a funny fail."""
    return bool(caption) and (bool(_FAIL_RE.search(caption)) or "\U0001f602" in caption)


def wants_coaching(caption: str | None) -> bool:
    """True when the caption asks for a coaching review.

    Word-boundary match on purpose: "rev this one" opts in, "revenge" does not.
    """
    return bool(caption) and bool(_REV_RE.search(caption))


def daily_base_eligible(row: dict) -> bool:
    """Delivered, archived, short, and not a coaching clip. Ignores posted/vetoed."""
    dur = row.get("duration_seconds")
    return (row.get("status") == "delivered" and row.get("archive_status") == "archived"
            and dur is not None and dur <= DAILY_MAX_SECONDS
            and not wants_coaching(row.get("body")))


def _signature(row: dict) -> tuple | None:
    if not row.get("sender_online_id") or row.get("file_size") is None or row.get("duration_seconds") is None:
        return None
    return (row["sender_online_id"].casefold(), int(row["file_size"]), round(float(row["duration_seconds"]), 3))


def _posted() -> tuple[dict[str, str], dict[tuple, str]]:
    """clip_id -> IG URL for every posted clip, and signature -> posted clip_id."""
    import clips
    import ig_posts
    ig_posts.init()
    urls = {r["clip_id"]: r["ig_url"] for r in ig_posts.recent(200) if r.get("ig_url")}
    sigs: dict[tuple, str] = {}
    for cid in urls:
        row = clips.get(cid)
        sig = _signature(row) if row else None
        if sig:
            sigs.setdefault(sig, cid)
    return urls, sigs


def classify(clip_ids: list[str], vetoed: set[str] | None = None) -> dict[str, dict]:
    """Pipeline state for each clip id. `vetoed` holds Reel Review's vetoed ids."""
    import clips
    import wa_reactions
    wa_reactions.init()
    vetoed = vetoed or set()
    urls, sigs = _posted()
    out: dict[str, dict] = {}
    for cid in clip_ids:
        row = clips.get(cid)
        if not row:
            out[cid] = _state("not_eligible", "Not in the clip archive", editable=False)
            continue
        body = row.get("body")
        if cid in urls:
            out[cid] = _state("posted", "Posted on @crcmzclan", ig_url=urls[cid], editable=False)
            continue
        sig = _signature(row)
        if sig and sig in sigs:
            out[cid] = _state("twin_of_posted", "Duplicate of a posted clip — it can't be posted",
                              twin_of=sigs[sig], ig_url=urls.get(sigs[sig]), editable=False)
            continue
        rx = wa_reactions.reactions_for_clip(cid)
        wa_veto = any(r.get("emoji") == VETO_EMOJI for r in rx.get("reactions", []))
        if cid in vetoed or wa_veto:
            out[cid] = _state("vetoed", "Vetoed — kept out of highlights",
                              detail="🛑 reaction in WhatsApp" if wa_veto and cid not in vetoed else None)
            continue
        if wants_ig_post(body):
            out[cid] = _state("fire", "🔥 Fire reel")
        elif wants_fail_tag(body):
            n = int(rx.get("reaction_count") or 0)
            ready = n >= FAIL_REACTION_GATE
            out[cid] = _state("fail", "😂 Fail reel" + (" · ready" if ready else " · waiting on reactions"),
                              reactions=n, gate=FAIL_REACTION_GATE)
        elif daily_base_eligible(row):
            out[cid] = _state("daily_eligible", "📅 Daily highlights")
        else:
            dur = row.get("duration_seconds")
            why = ("coaching clip (rev)" if wants_coaching(body)
                   else f"longer than {int(DAILY_MAX_SECONDS)}s" if dur is not None and dur > DAILY_MAX_SECONDS
                   else "not archived yet")
            out[cid] = _state("not_eligible", "Not eligible", detail=why)
    return out


def _state(state: str, label: str, *, editable: bool = True, **extra) -> dict:
    return {"state": state, "label": label, "editable": editable,
            **{k: v for k, v in extra.items() if v is not None}}
