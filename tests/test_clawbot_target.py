#!/usr/bin/env python3
"""Which site a WhatsApp build request is actually about.

"update the gta6 countdown site" used to deploy to update.buildanator.com — the
subdomain came from the first long word in the message, edit verbs were not
skipped, and the engineer was never told the site already existed. So every edit
produced a new site and the real one never changed. These checks pin the three
behaviours that fix it:

  - an edit that names a live site resolves to THAT site
  - a create request still creates, and never lands on a live subdomain by accident
  - an edit we cannot resolve asks instead of inventing a name

Runs on the host: the resolver is lifted out of server.py so the test needs no
fastapi, no SSH and no live registry.

Plain asserts, no pytest:

    python3 tests/test_clawbot_target.py
"""

import json
import logging
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAILED: list[str] = []
PASSED = 0


def check(name, fn):
    global PASSED
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        FAILED.append(f"{name}: {type(e).__name__}: {e}")
        print(f"  ✗ {name}\n      {type(e).__name__}: {e}")
    else:
        PASSED += 1
        print(f"  ✓ {name}")


# ── Load the real resolver without importing the app ─────────────────────────
# server.py needs fastapi/itsdangerous, which the host does not have. The target
# resolution is pure regex over a list of dicts, so exec just those blocks.
_SRC = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "server.py")).read()
_NS = {"_re": re, "json": json, "_time": time,
       "logger": logging.getLogger("test-clawbot")}
exec(_SRC[_SRC.index("_DEPLOY_REGISTRY = "):_SRC.index("def _run_clawbot_job(")], _NS)
exec(_SRC[_SRC.index("_SUBDOMAIN_RE = _re.compile"):
          _SRC.index("_creator_jids: set[str] = set()")], _NS)

_resolve = _NS["_resolve_existing_site"]
_extract = _NS["_extract_subdomain"]
_EDIT = _NS["_EDIT_INTENT_RE"]
_CREATE = _NS["_CREATE_INTENT_RE"]
_SUB = _NS["_SUBDOMAIN_RE"]

# A snapshot of the real /opt/ai-lab/deployments.json shape, including the awkward
# parts: project "." (shipped from a cwd, so the dir is unknowable), one project
# deployed under two subdomains, and short names that collide with English.
_LIVE = [
    ("maxun", "maxun"), ("dungeon", "dungeon"), ("plant-site", "plant"),
    ("bro-site", "bro"), ("only-site", "only"), ("recaply-site", "really"),
    ("asking-site", "asking"), ("noor-anthem-site", "noor-anthem"),
    ("lyrics-site", "lyrics"), ("samad-site", "samad"), ("crcmz-site", "crcmz"),
    ("resell-site", "resell"), (".", "loadout"),
    ("wzstats-rebuild", "wzstats-rebuild"), ("wzstats-rebuild", "rebuild"),
    (".", "gta6-countdown"), (".", "mcp"),
]
_NS["_deploy_cache"] = (time.time(), [
    {"project": p, "subdomain": s, "url": f"https://{s}.buildanator.com"}
    for p, s in _LIVE
])


def decide(msg: str) -> tuple[str, str]:
    """(mode, subdomain) — mirrors the resolution order in _run_clawbot_job."""
    explicit = bool(_SUB.search(msg))
    existing = None
    if explicit or _EDIT.search(msg):
        existing = _resolve(msg)
        if existing is None and not explicit and not _CREATE.search(msg):
            return ("ask", "")
    sub = existing["subdomain"] if existing else _extract(msg)
    if existing is None:
        existing = next((d for d in _NS["_deploy_cache"][1]
                         if d["subdomain"] == sub.lower()), None)
    return ("edit" if existing else "new", sub)


def edits(msg, sub):
    def _t():
        mode, got = decide(msg)
        assert (mode, got) == ("edit", sub), f"got {mode} -> {got!r} for {msg!r}"
    return _t


def creates(msg, sub=None):
    def _t():
        mode, got = decide(msg)
        assert mode == "new", f"got {mode} -> {got!r} for {msg!r}"
        if sub is not None:
            assert got == sub, f"got subdomain {got!r}, wanted {sub!r}"
    return _t


def asks(msg):
    def _t():
        mode, got = decide(msg)
        assert mode == "ask", f"got {mode} -> {got!r} for {msg!r}"
    return _t


print("clawbot build target")

# The original bug, in the phrasings people actually use.
check("edit verb is never the subdomain",
      edits("update the gta6 countdown site to add a dark mode", "gta6-countdown"))
check("'change the X site' edits X",
      edits("change the plant site so the background is black", "plant"))
check("'add ... to the X site' edits X",
      edits("add a leaderboard to the loadout spinner site", "loadout"))
check("bare subdomain in the message resolves",
      edits("fix the countdown timer on gta6-countdown", "gta6-countdown"))
check("explicit url wins",
      edits("edit plant.buildanator.com to show more plants", "plant"))
check("three-letter name works next to a site noun",
      edits("update the bro site", "bro"))
check("'tell your engineer to update X' edits X",
      edits("tell your engineer to update the samad site", "samad"))
check("hyphenated subdomain survives",
      edits("@claw update wzstats-rebuild with the new api", "wzstats-rebuild"))
check("'rebuild' is a verb, not the rebuild site",
      edits("rebuild the plant site with a new font", "plant"))

# Create phrasing that happens to name a live site is still an edit: a fresh
# scaffold on a live subdomain silently replaces somebody's site.
check("create phrasing on a live subdomain is an edit",
      edits("make the plant site mobile friendly", "plant"))

# Genuine new builds must not be dragged onto an existing site.
check("new build stays new", creates("build me a site that tracks arc raiders loot"))
check("'called X' still names the new site",
      creates("make a dashboard called recaply", "recaply"))
check("new landing page stays new", creates("build a landing page for the clan"))
# "add" trips the edit regex; a clear create must not be turned into a question.
check("create wording beats an incidental edit verb",
      creates("build a site that adds up and can add arc raiders loot scores"))

# Unresolvable edits ask. Guessing here is what produced the junk subdomains.
check("vague edit asks", asks("update the thing we made last week"))
check("short name needs a site noun", asks("change the site so it only shows 5 rows"))
check("no target at all asks", asks("fix the typo on it"))

# Alias hygiene.
check("verbs are never aliases", lambda: (
    lambda a: (_ for _ in ()).throw(AssertionError(f"verb leaked into aliases: {a}"))
    if "rebuild" in a else None)(
        _NS["_deploy_aliases"]({"subdomain": "rebuild", "project": "wzstats-rebuild"})))
check("registry never offers the jobs dashboard as a target", lambda: (
    None if "jobs" in _NS["_NEVER_EDIT"] else (_ for _ in ()).throw(
        AssertionError("the jobs dashboard must not be editable from chat"))))
check("cache invalidation keeps the fallback list", lambda: (
    _NS["_invalidate_deploy_cache"](),
    (None if _NS["_deploy_cache"][1] else (_ for _ in ()).throw(
        AssertionError("invalidation dropped the list; a failed re-read would "
                       "then report nothing deployed"))),
)[-1])

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print(f"  - {f}")
sys.exit(1 if FAILED else 0)
