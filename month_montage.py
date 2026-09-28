"""Month-end montage support: which clips of a month may go in, a balanced
proposal, and the record of what was actually published.

Muse cuts the montage (a long TikTok cut and a tighter Instagram cut from the
same moments). This module is the backend side of that: it does not render
anything and never sends anything.

Hard exclusions, enforced here and again when a record is saved:

  vetoed           vetoed in Reel Review, or a 🛑 reaction on the clip's
                   WhatsApp message. A byte-identical twin of a vetoed clip is
                   the same video, so it is vetoed too.
  rev_coaching     the message asks for a coaching review (reel_pipeline's
                   word-boundary 'rev' rule), or ingest marked the clip
                   coaching-only (clips.montage_eligible = 0).
  twin             same sha256 as an earlier clip of the month (the earliest
                   copy is the one kept), or as a clip already used in another
                   month's montage record.
  not_archived     no stored MP4, so there is nothing to cut from.

The Reel Review veto list lives in reel-review, not here. If it cannot be
fetched every clip is excluded with `veto_list_unavailable` and saving a record
is refused: a montage is never assembled on the assumption that nothing is
vetoed.

Month edges are local midnight in MONTAGE_TIMEZONE (America/Los_Angeles by
default, the same zone psn-montage builds in), not UTC.

DB: /data/montage_records.db — one row per month, keyed by 'YYYY-MM'.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import reel_pipeline

logger = logging.getLogger(__name__)

_DB_PATH = Path(os.environ.get("MONTAGE_RECORDS_DB", "/data/montage_records.db"))
_lock = threading.Lock()

DEFAULT_TZ = os.environ.get("MONTAGE_TIMEZONE", "America/Los_Angeles")
REEL_REVIEW_URL = os.environ.get("REEL_REVIEW_URL", "http://reel-review:8080").rstrip("/")
REEL_REVIEW_TOKEN = os.environ.get("REEL_REVIEW_TOKEN", "")

CATEGORIES = ("win", "fail", "goop", "untagged")
_MONTH_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
_ROFL = "\U0001f923"

# Reasons that keep a clip out no matter what else is selected. `twin` is
# relative (it depends on which copy is kept) and is checked separately when a
# selection is validated.
HARD_REASONS = ("veto_list_unavailable", "vetoed", "rev_coaching", "not_archived",
                "used_in_montage")


# ── Month window ──────────────────────────────────────────────────────────────

def month_window(month: str, tz_name: str = "") -> tuple[float, float, str]:
    """(start, end, tz) epoch seconds for local midnight-to-midnight of `month`."""
    m = _MONTH_RE.match((month or "").strip())
    if not m:
        raise ValueError("month must be YYYY-MM, e.g. 2026-09")
    tz_name = (tz_name or DEFAULT_TZ).strip()
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f"unknown timezone: {tz_name}") from None
    year, mon = int(m.group(1)), int(m.group(2))
    nxt = (year + 1, 1) if mon == 12 else (year, mon + 1)
    start = datetime(year, mon, 1, tzinfo=tz).timestamp()
    end = datetime(nxt[0], nxt[1], 1, tzinfo=tz).timestamp()
    return start, end, tz_name


# ── Inputs ────────────────────────────────────────────────────────────────────

def fetch_vetoes() -> set[str] | None:
    """Clip ids vetoed in Reel Review, or None when the list can't be read."""
    if not REEL_REVIEW_TOKEN:
        return None
    import httpx
    try:
        r = httpx.get(f"{REEL_REVIEW_URL}/api/vetoes",
                      headers={"X-App-Token": REEL_REVIEW_TOKEN}, timeout=5.0)
        r.raise_for_status()
        return {str(v["clip_id"]) for v in r.json() if v.get("clip_id")}
    except Exception as e:  # noqa: BLE001
        logger.warning("month_montage: veto list unavailable: %s", e)
        return None


def category(body: str | None) -> str:
    """win / fail / untagged from the clip's trigger text.

    'goop' (loot showcase) has no trigger — nothing in the message marks it — so
    it only ever comes from a caller-supplied label.
    """
    if reel_pipeline.wants_fail_tag(body) or (body and _ROFL in body):
        return "fail"
    if reel_pipeline.wants_ig_post(body):
        return "win"
    return "untagged"


def _whatsapp_vetoed(clip_id: str) -> bool:
    import wa_reactions
    rx = wa_reactions.reactions_for_clip(clip_id)
    return any(r.get("emoji") == reel_pipeline.VETO_EMOJI for r in rx.get("reactions", []))


def _used_elsewhere(month: str) -> tuple[dict[str, str], dict[str, str]]:
    """clip_id -> month and sha256 -> month for clips in OTHER months' records."""
    import clips
    by_id: dict[str, str] = {}
    by_sha: dict[str, str] = {}
    for rec in list_records():
        if rec["month"] == month:
            continue
        for cid in rec["clip_ids"]:
            by_id.setdefault(cid, rec["month"])
            row = clips.get(cid)
            if row and row.get("sha256"):
                by_sha.setdefault(row["sha256"], rec["month"])
    return by_id, by_sha


# ── Evaluation ────────────────────────────────────────────────────────────────

def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds") if ts else None


def evaluate(month: str, tz_name: str = "", vetoes: set[str] | None = None,
             fetch: bool = True) -> dict:
    """Every clip of the month, oldest first, each with its exclusion reasons.

    `vetoes` overrides the Reel Review fetch (tests); with fetch=False and no
    vetoes the list counts as unavailable.
    """
    import clips
    start, end, tz_name = month_window(month, tz_name)
    if vetoes is None and fetch:
        vetoes = fetch_vetoes()
    veto_ok = vetoes is not None
    vetoes = vetoes or set()
    rows = clips.list_between(start, end)
    used_id, used_sha = _used_elsewhere(month)
    states = reel_pipeline.classify([r["message_uid"] for r in rows], vetoes) if rows else {}

    out: list[dict] = []
    for r in rows:
        cid = r["message_uid"]
        body = r.get("body") or None
        reasons: list[dict] = []
        if not veto_ok:
            reasons.append({"code": "veto_list_unavailable",
                            "detail": "Reel Review veto list could not be read"})
        if cid in vetoes:
            reasons.append({"code": "vetoed", "detail": "vetoed in Reel Review"})
        elif _whatsapp_vetoed(cid):
            reasons.append({"code": "vetoed", "detail": "🛑 reaction in WhatsApp"})
        if reel_pipeline.wants_coaching(body):
            reasons.append({"code": "rev_coaching", "detail": "'rev' coaching clip"})
        elif not r.get("montage_eligible", 1):
            reasons.append({"code": "rev_coaching", "detail": "marked coaching-only at ingest"})
        if r.get("archive_status") != "archived" or not r.get("storage_key_original"):
            reasons.append({"code": "not_archived", "detail": "no stored MP4"})
        if cid in used_id:
            reasons.append({"code": "used_in_montage", "detail": f"already in the {used_id[cid]} montage"})
        elif r.get("sha256") and r["sha256"] in used_sha:
            reasons.append({"code": "used_in_montage",
                            "detail": f"byte-identical to a clip in the {used_sha[r['sha256']]} montage"})
        when = r.get("psn_created_at") or r.get("discovered_at")
        out.append({
            "clip_id": cid,
            "sender": r.get("sender_online_id"),
            "when": _iso(when),
            "duration_seconds": round(r["duration_seconds"], 2) if r.get("duration_seconds") is not None else None,
            "message": (body or "")[:120] or None,
            "game": r.get("game_name"),
            "category": category(body),
            "sha256": r.get("sha256"),
            "file_size_bytes": r.get("file_size"),
            "pipeline_state": (states.get(cid) or {}).get("state"),
            "_reasons": reasons,
        })

    # Byte-identical twins: a veto on any copy vetoes them all; otherwise the
    # earliest copy is kept and the rest point at it.
    groups: dict[str, list[dict]] = {}
    for c in out:
        if c["sha256"]:
            groups.setdefault(c["sha256"], []).append(c)
    for members in groups.values():
        if len(members) < 2:
            continue
        vetoed_by = next((m for m in members if any(x["code"] == "vetoed" for x in m["_reasons"])), None)
        keeper = members[0]
        for m in members:
            if vetoed_by and m is not vetoed_by and not any(x["code"] == "vetoed" for x in m["_reasons"]):
                m["_reasons"].append({"code": "vetoed",
                                      "detail": f"byte-identical twin of vetoed clip {vetoed_by['clip_id']}"})
            if m is not keeper:
                m["twin_of"] = keeper["clip_id"]
                m["_reasons"].append({"code": "twin", "detail": f"byte-identical twin of {keeper['clip_id']}"})

    for c in out:
        reasons = c.pop("_reasons")
        c["eligible"] = not reasons
        c["excluded_reasons"] = reasons
    return {"month": month, "timezone": tz_name, "veto_list_available": veto_ok,
            "window_start": _iso(start), "window_end": _iso(end), "clips": out}


def month_clips(month: str, tz_name: str = "", limit: int = 50, offset: int = 0,
                eligible_only: bool = False) -> dict:
    ev = evaluate(month, tz_name)
    rows = ev.pop("clips")
    eligible_count = sum(1 for c in rows if c["eligible"])
    if eligible_only:
        rows = [c for c in rows if c["eligible"]]
    page = rows[offset:offset + limit]
    nxt = offset + len(page)
    return {**ev, "total": len(rows), "eligible_count": eligible_count,
            "offset": offset, "has_more": nxt < len(rows),
            "next_offset": nxt if nxt < len(rows) else None, "clips": page}


# ── Proposal ──────────────────────────────────────────────────────────────────

def propose(month: str, tz_name: str = "", target_count: int = 30,
            max_sender_share: float = 0.35, mix: dict | None = None,
            labels: dict | None = None) -> dict:
    """A balanced pick from the month's eligible clips.

    Category quotas come from `mix` (relative weights over win/fail/goop,
    default equal); untagged clips fill whatever the quotas leave. No sender gets
    more than max_sender_share of target_count. Within a category senders are
    taken round-robin, least-picked first, so no one dominates. Shortfalls are
    reported, never papered over by breaking the sender cap.
    """
    ev = evaluate(month, tz_name)
    labels = {k: v for k, v in (labels or {}).items() if v in CATEGORIES}
    pool = [c for c in ev["clips"] if c["eligible"]]
    for c in pool:
        c["category"] = labels.get(c["clip_id"], c["category"])

    cap = max(1, int(target_count * max_sender_share))
    weights = {k: max(0.0, float((mix or {}).get(k, 1.0))) for k in ("win", "fail", "goop")}
    present = {k: w for k, w in weights.items() if w > 0 and any(c["category"] == k for c in pool)}
    total_w = sum(present.values()) or 1.0
    quotas = {k: round(target_count * w / total_w) for k, w in present.items()}

    picked: list[dict] = []
    per_sender: dict[str, int] = {}

    def take(cands: list[dict], n: int) -> int:
        queues: dict[str, list[dict]] = {}
        for c in cands:
            queues.setdefault(c["sender"] or "?", []).append(c)
        got = 0
        while got < n and len(picked) < target_count:
            open_ = [s for s, q in queues.items() if q and per_sender.get(s, 0) < cap]
            if not open_:
                break
            s = min(open_, key=lambda s: (per_sender.get(s, 0), s))
            queue = queues[s]
            # Spread each sender's picks across the month rather than front-loading it.
            c = queue.pop(len(queue) // 2)
            picked.append(c)
            per_sender[s] = per_sender.get(s, 0) + 1
            got += 1
        return got

    shortfalls: dict[str, int] = {}
    for k, q in quotas.items():
        got = take([c for c in pool if c["category"] == k], q)
        if got < q:
            shortfalls[k] = q - got
    chosen = {c["clip_id"] for c in picked}
    take([c for c in pool if c["clip_id"] not in chosen and c["category"] == "untagged"],
         target_count - len(picked))
    chosen = {c["clip_id"] for c in picked}
    take([c for c in pool if c["clip_id"] not in chosen], target_count - len(picked))
    if len(picked) < target_count:
        shortfalls["total"] = target_count - len(picked)

    picked.sort(key=lambda c: c["when"] or "")
    by_cat: dict[str, int] = {}
    for c in picked:
        by_cat[c["category"]] = by_cat.get(c["category"], 0) + 1
    return {
        "month": ev["month"], "timezone": ev["timezone"],
        "veto_list_available": ev["veto_list_available"],
        "eligible_pool": len(pool), "target_count": target_count,
        "max_per_sender": cap, "category_quotas": quotas,
        "selected": [{k: c[k] for k in ("clip_id", "sender", "when", "duration_seconds",
                                         "category", "message", "sha256")} for c in picked],
        "by_sender": dict(sorted(per_sender.items(), key=lambda kv: -kv[1])),
        "by_category": by_cat,
        "total_duration_seconds": round(sum(c["duration_seconds"] or 0 for c in picked), 2),
        "shortfalls": shortfalls,
    }


def validate_selection(month: str, clip_ids: list[str], tz_name: str = "") -> list[dict]:
    """Every reason the selection may not be recorded; empty means it may."""
    ev = evaluate(month, tz_name)
    by_id = {c["clip_id"]: c for c in ev["clips"]}
    problems: list[dict] = []
    if not ev["veto_list_available"]:
        problems.append({"clip_id": None, "code": "veto_list_unavailable",
                         "detail": "Reel Review veto list could not be read; refusing to record"})
    seen_sha: dict[str, str] = {}
    for cid in clip_ids:
        c = by_id.get(cid)
        if not c:
            problems.append({"clip_id": cid, "code": "not_in_month",
                             "detail": f"no clip with this id captured in {month} ({ev['timezone']})"})
            continue
        for r in c["excluded_reasons"]:
            if r["code"] in HARD_REASONS and r["code"] != "veto_list_unavailable":
                problems.append({"clip_id": cid, **r})
        if c["sha256"]:
            if c["sha256"] in seen_sha:
                problems.append({"clip_id": cid, "code": "twin",
                                 "detail": f"byte-identical to {seen_sha[c['sha256']]}, also selected"})
            else:
                seen_sha[c["sha256"]] = cid
    return problems


# ── Store ─────────────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS montage_records (
                month        TEXT PRIMARY KEY,
                timezone     TEXT NOT NULL,
                clip_ids     TEXT NOT NULL,
                ig_url       TEXT,
                tiktok_url   TEXT,
                notes        TEXT,
                recorded_by  TEXT NOT NULL DEFAULT '',
                created_at   REAL NOT NULL,
                updated_at   REAL NOT NULL
            )""")
        db.commit()
    logger.info("month_montage: DB ready at %s", _DB_PATH)


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["clip_ids"] = json.loads(d["clip_ids"] or "[]")
    return d


def get_record(month: str) -> dict | None:
    with _lock, _conn() as db:
        r = db.execute("SELECT * FROM montage_records WHERE month=?", (month,)).fetchone()
    return _row(r) if r else None


def list_records(limit: int = 24) -> list[dict]:
    if not _DB_PATH.exists():
        return []
    with _lock, _conn() as db:
        rows = db.execute("SELECT * FROM montage_records ORDER BY month DESC LIMIT ?",
                          (int(limit),)).fetchall()
    return [_row(r) for r in rows]


def check_url(url: str, hosts: tuple[str, ...]) -> str | None:
    """Error text for a URL that is not https on one of `hosts`, else None."""
    p = urlparse(url)
    host = (p.hostname or "").lower()
    if p.scheme != "https" or not any(host == h or host.endswith("." + h) for h in hosts):
        return f"must be an https URL on {' or '.join(hosts)}"
    return None


def save_record(month: str, tz_name: str, clip_ids: list[str] | None,
                ig_url: str | None, tiktok_url: str | None, notes: str | None,
                recorded_by: str) -> dict:
    """Upsert the month's record. None leaves a field as it was."""
    now = time.time()
    prev = get_record(month)
    merged = {
        "clip_ids": clip_ids if clip_ids is not None else (prev or {}).get("clip_ids", []),
        "ig_url": ig_url if ig_url is not None else (prev or {}).get("ig_url"),
        "tiktok_url": tiktok_url if tiktok_url is not None else (prev or {}).get("tiktok_url"),
        "notes": notes if notes is not None else (prev or {}).get("notes"),
    }
    with _lock, _conn() as db:
        db.execute(
            """INSERT INTO montage_records
                 (month, timezone, clip_ids, ig_url, tiktok_url, notes, recorded_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(month) DO UPDATE SET
                 timezone=excluded.timezone, clip_ids=excluded.clip_ids,
                 ig_url=excluded.ig_url, tiktok_url=excluded.tiktok_url,
                 notes=excluded.notes, recorded_by=excluded.recorded_by,
                 updated_at=excluded.updated_at""",
            (month, tz_name, json.dumps(merged["clip_ids"]), merged["ig_url"] or None,
             merged["tiktok_url"] or None, merged["notes"] or None, recorded_by, now, now))
        db.commit()
    return get_record(month)
