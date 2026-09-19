"""Cross-system identity graph: Zitadel tags -> PSN, Mattermost, WhatsApp.

Every human in the org carries metadata tags set in the Zitadel console --
`mm_username`, `psn_id`, `wa_jid`, `wa_phone`. Those tags are the only place the
four identities are tied together, and until this module nothing in the app read
them: `/data/users/*.json` links Zitadel to PSN, but WhatsApp was an island
keyed by display name alone, so "who sent this message" could not be answered.

Reading the tags collapses every per-store id onto one person:

    whatsapp_messages.sender_name == tags.wa_names   (not wa_jid -- see below)
    clips.sender_online_id        == tags.psn_id
    soundboard boards[<key>]      == zitadel_id
    giveaway_entries.member_id    == zitadel_id
    facts.author_sub              == zitadel_id
    chat_history.messages.user_sub == zitadel_id

Three deliberate choices:

* Metadata values arrive base64-encoded from Zitadel and are decoded here, so
  callers never deal with the encoding.
* `psn_id` falls back to the portal's own PSN link when the tag is unset, so a
  person who links their account through the portal appears here without anyone
  editing the Zitadel console (see `_portal_links`). Every other tag is
  console-only, because nothing else in the app knows those identities.
* Nothing in this module returns a credential. The per-user PSN files hold live
  NPSSO/access/refresh tokens, so profiles are assembled from an explicit
  allowlist rather than by dropping known-bad keys -- a denylist silently leaks
  whatever field gets added next.

Requests go through httpx, not urllib: auth.crcmz.me sits behind Cloudflare,
which answers urllib's default User-Agent with a 1010 "banned browser
signature" instead of the real response.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

ZITADEL_ISSUER = os.environ.get("ZITADEL_ISSUER", "https://auth.crcmz.me").rstrip("/")
ZITADEL_SERVICE_TOKEN = os.environ.get("ZITADEL_SERVICE_TOKEN", "")

# The tag keys this app understands. Anything else a human adds in the Zitadel
# console still surfaces under Person["tags"], it just gets no dedicated field.
#
# `wa_names` carries the comma-separated WhatsApp display names a person posts
# under, and it is the only tag that can actually join `whatsapp_messages`.
# `wa_jid` cannot, despite looking like it should:
#
#   * 89% of rows are `historical_export` and have no sender_jid at all -- a
#     WhatsApp .txt export only ever contains the display name.
#   * Every live row's sender_jid is WhatsApp's privacy id (`8357...@lid`), not
#     a phone JID, and @lid is not derivable from a phone number.
#
# So wa_jid/wa_phone stay useful for resolving a person from an inbound webhook
# or a human typing a number, while attribution of stored messages goes through
# wa_names. People post under more than one name ("Zubair", "Zubair CRCMZ"), so
# the tag is a list.
TAG_KEYS = ("mm_username", "psn_id", "wa_jid", "wa_phone", "wa_names")

# Separators accepted inside a multi-value tag.
_TAG_SPLIT = ",;|"

# Zitadel is a hard dependency for identity but not for the rest of the bot, so
# a lookup failure degrades to "no people" instead of raising into a reply.
_TTL = 300.0
_HTTP_TIMEOUT = 15.0
_PAGE_SIZE = 200

_cache: dict[str, tuple[float, list[dict]]] = {}

# The bot's own messages (`from_me = 1`) arrive with the *group's* JID as the
# sender -- `120363406504549565` -- because Baileys echoes a send back with the
# destination in the sender slot. Without this, 150 rows of the bot's own output
# look like an unidentified human, and every "who talks most" answer includes a
# phantom member. It is not a Zitadel account, so it gets a synthetic id.
BOT_ID = "crcmz-bot"
BOT_NAME = "CRCMZ Bot"


def bot_person() -> dict:
    """Person-shaped record for the bot itself, so callers need no special case."""
    return {
        "zitadel_id": BOT_ID,
        "display_name": BOT_NAME,
        "username": BOT_ID,
        "email": "",
        "state": "",
        "mm_username": "",
        "psn_id": "",
        "wa_jid": "",
        "wa_phone": "",
        "wa_names": [],
        "tags": {},
        "is_bot": True,
    }


def configured() -> bool:
    """True when a service token exists; callers should skip identity work if not."""
    return bool(ZITADEL_SERVICE_TOKEN)


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}",
        "Content-Type": "application/json",
    }


def _decode_tag(raw: str) -> str:
    """Zitadel returns metadata values base64-encoded; fall back to the literal.

    A value that is not valid base64 (or not UTF-8 once decoded) is far more
    likely to be a plain string written by some other tool than a corrupt blob,
    so it is passed through rather than dropped.
    """
    if not raw:
        return ""
    try:
        return base64.b64decode(raw, validate=True).decode("utf-8").strip()
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return raw.strip()


def _split_tag(raw: str) -> list[str]:
    """Split a multi-value tag on any of `,;|`, dropping blanks."""
    out: list[str] = []
    for chunk in _re_split(raw):
        chunk = chunk.strip()
        if chunk and chunk not in out:
            out.append(chunk)
    return out


def _re_split(raw: str) -> list[str]:
    parts = [raw or ""]
    for sep in _TAG_SPLIT:
        parts = [bit for p in parts for bit in p.split(sep)]
    return parts


def _normalise_jid(jid: str) -> str:
    """Strip a WhatsApp JID down to its comparable core.

    Baileys hands back several shapes for the same person -- `1555…@s.whatsapp.net`,
    `1555…@c.us`, and device-suffixed `1555…:12@s.whatsapp.net`. Comparing the
    bare number is the only form that matches across all of them.
    """
    jid = (jid or "").strip().lower()
    if not jid:
        return ""
    local = jid.split("@", 1)[0]
    return local.split(":", 1)[0].lstrip("+")


def _portal_links() -> dict[str, dict]:
    """zitadel_id -> the PSN link the portal already stores, or {} if unreadable.

    The `psn_id` tag is maintained by hand in the Zitadel console, but linking a
    PSN account through the portal writes `/data/users/<key>.json` and never
    touches Zitadel -- so a freshly linked account would sit here with an empty
    `psn_id` and zero clips until somebody remembered to edit the console. This
    closes that gap: the tag still wins when set, and the portal fills the blank.

    `portal.list_users()` is one directory scan for the whole squad (cheaper than
    a per-person `find_by_zitadel_id`) and its projection is a fixed allowlist, so
    no NPSSO or refresh token can ride along. Imported lazily and wrapped because
    identity must degrade to tags-only rather than fail: `/data/users` does not
    exist in tests, and this module is imported by tools that never touch PSN.
    """
    try:
        import portal
        rows = portal.list_users()
    except Exception as e:  # noqa: BLE001
        logger.debug("identity: portal links unavailable (%s), tags only", e)
        return {}

    out: dict[str, dict] = {}
    for row in rows:
        uid = (row.get("zitadel_user_id") or "").strip()
        if uid:
            out[uid] = row
    return out


def _fetch_people() -> list[dict]:
    """One Zitadel user search plus a metadata read per human."""
    if not configured():
        logger.info("identity: no ZITADEL_SERVICE_TOKEN, identity graph disabled")
        return []

    links = _portal_links()
    people: list[dict] = []
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        r = client.post(
            f"{ZITADEL_ISSUER}/management/v1/users/_search",
            json={"queries": [{"typeQuery": {"type": "TYPE_HUMAN"}}], "pageSize": _PAGE_SIZE},
            headers=_headers(),
        )
        if r.status_code != 200:
            logger.warning("identity: user search failed %s %s", r.status_code, r.text[:200])
            return []

        for u in r.json().get("result", []):
            # Management v1 calls the field "id"; some responses also carry
            # "userId". Preferring "id" matches the fix in commit d11a972.
            uid = u.get("id") or u.get("userId") or ""
            if not uid:
                continue
            human = u.get("human") or {}
            profile = human.get("profile") or {}

            tags: dict[str, str] = {}
            m = client.post(
                f"{ZITADEL_ISSUER}/management/v1/users/{uid}/metadata/_search",
                json={}, headers=_headers(),
            )
            if m.status_code == 200:
                for entry in m.json().get("result", []):
                    key = (entry.get("key") or "").strip()
                    if key:
                        tags[key] = _decode_tag(entry.get("value", ""))
            else:
                logger.debug("identity: metadata read failed for %s: %s", uid, m.status_code)

            # A hand-set tag is authoritative; the portal's own link fills a blank
            # so that linking PSN is enough to show up here (see _portal_links).
            link = links.get(uid) or {}
            psn_id = tags.get("psn_id", "") or (link.get("online_id") or "").strip()
            mm_username = (tags.get("mm_username", "")
                           or (link.get("mm_username") or "").strip())
            if psn_id and not tags.get("psn_id"):
                logger.info("identity: psn_id for %s came from the portal link (%s), "
                            "no psn_id tag set", uid, psn_id)

            people.append({
                "zitadel_id": uid,
                "display_name": (profile.get("displayName") or "").strip(),
                "username": (u.get("userName") or "").strip(),
                "email": ((human.get("email") or {}).get("email") or "").strip(),
                "state": u.get("state") or "",
                "mm_username": mm_username,
                "psn_id": psn_id,
                "wa_jid": tags.get("wa_jid", ""),
                "wa_phone": tags.get("wa_phone", ""),
                "wa_names": _split_tag(tags.get("wa_names", "")),
                "tags": tags,
            })

    logger.info("identity: loaded %d people, %d fully tagged",
                len(people), sum(1 for p in people if p["wa_jid"] and p["psn_id"]))
    return people


def people(*, refresh: bool = False) -> list[dict]:
    """Every human in Zitadel with their tags, cached for five minutes.

    Tags change by hand in the Zitadel console, so a short TTL is plenty and
    keeps a chatty group from issuing one HTTP call per member per message.
    """
    hit = _cache.get("people")
    if hit and not refresh and time.time() - hit[0] < _TTL:
        return hit[1]
    try:
        found = _fetch_people()
    except Exception as e:  # noqa: BLE001 - identity must never sink a reply
        logger.warning("identity: fetch failed: %s", e)
        return hit[1] if hit else []
    # Only replace a good cache with a good result; an empty fetch during a
    # Zitadel blip should not erase a working graph.
    if found or not hit:
        _cache["people"] = (time.time(), found)
        return found
    return hit[1]


def resolve(needle: str, *, refresh: bool = False) -> dict | None:
    """Find one person by any identifier they are known by.

    Accepts a Zitadel id, PSN online id, Mattermost username, WhatsApp JID or
    phone number, login name, email, or display name. Exact identifier matches
    win over name matches, and a name match only counts when it is unambiguous
    -- "who is moiz" should not silently pick one of two Moizes.
    """
    needle = (needle or "").strip()
    if not needle:
        return None
    folded = needle.casefold()
    digits = _normalise_jid(needle)
    roster = people(refresh=refresh)

    for p in roster:
        if needle == p["zitadel_id"]:
            return p

    for p in roster:
        exact = {
            p["psn_id"].casefold(),
            p["mm_username"].casefold(),
            p["username"].casefold(),
            p["email"].casefold(),
        }
        exact.update(n.casefold() for n in p["wa_names"])
        exact.discard("")
        if folded in exact:
            return p
        if digits and digits in {_normalise_jid(p["wa_jid"]), _normalise_jid(p["wa_phone"])}:
            return p

    # Display names are free text, so fall back to them last and only when the
    # match is unique in both the exact and the substring pass.
    named = [p for p in roster if p["display_name"].casefold() == folded]
    if len(named) == 1:
        return named[0]
    partial = [p for p in roster
               if folded in p["display_name"].casefold()
               or folded in p["username"].casefold()]
    if len(partial) == 1:
        return partial[0]
    return None


def by_wa_jid(*, refresh: bool = False) -> dict[str, dict]:
    """Normalised WhatsApp JID -> person, for joining `whatsapp_messages` rows."""
    out: dict[str, dict] = {}
    for p in people(refresh=refresh):
        for raw in (p["wa_jid"], p["wa_phone"]):
            key = _normalise_jid(raw)
            if key:
                out.setdefault(key, p)
    return out


def by_wa_name(*, refresh: bool = False) -> dict[str, dict]:
    """Case-folded WhatsApp display name -> person, for `whatsapp_messages` rows.

    Built from the explicit `wa_names` tag first, then from the other unique
    identifiers as a convenience. A name claimed by two people is dropped
    entirely rather than resolved to whichever was seen first -- misattributing
    someone's messages is worse than admitting the name is unknown.
    """
    counts: dict[str, list[dict]] = {}

    def claim(name: str, person: dict) -> None:
        key = (name or "").strip().casefold()
        if not key:
            return
        bucket = counts.setdefault(key, [])
        if all(p["zitadel_id"] != person["zitadel_id"] for p in bucket):
            bucket.append(person)

    for p in people(refresh=refresh):
        # Tagged names are authoritative; the rest are best-effort conveniences.
        for name in p["wa_names"]:
            claim(name, p)
        for name in (p["display_name"], p["mm_username"], p["psn_id"], p["username"]):
            claim(name, p)

    return {k: v[0] for k, v in counts.items() if len(v) == 1}


def identify_sender_name(name: str, *, refresh: bool = False) -> dict | None:
    """Person behind a `whatsapp_messages.sender_name`, or None if unmapped."""
    key = (name or "").strip().casefold()
    return by_wa_name(refresh=refresh).get(key) if key else None


def attribute_message(
    sender_name: str = "",
    *,
    from_me: int | bool = 0,
    sender_jid: str = "",
    refresh: bool = False,
) -> dict | None:
    """Who sent a `whatsapp_messages` row: a person, the bot, or nobody.

    Tries the three available signals in order of reliability:

    1. `from_me` -- unambiguous, so the bot wins before any name lookup. Its rows
       carry the group JID as `sender_name`, which would otherwise resolve to
       nothing and be counted as a mystery member.
    2. `sender_jid` -- only present on ~11% of rows, and live rows carry an
       `@lid` privacy id that matches no tag, so this rarely fires. Kept because
       it is exact when it does.
    3. `sender_name` -- the `wa_names` tag join, which covers everything else.

    Returns None for a genuinely unknown sender rather than guessing. Callers
    should still count those messages; see `unmapped_wa_names` for the gap list.
    """
    if from_me:
        return bot_person()
    # A sender_name that is a bare 15+ digit run is a JID, not a human: the group
    # id leaks into that column on some Baileys paths even when from_me is unset.
    stripped = (sender_name or "").strip()
    if stripped.isdigit() and len(stripped) >= 15:
        return bot_person()
    if sender_jid:
        hit = identify_jid(sender_jid, refresh=refresh)
        if hit:
            return hit
    return identify_sender_name(stripped, refresh=refresh)


def unmapped_wa_names(names: list[str], *, refresh: bool = False) -> list[str]:
    """Which of these WhatsApp display names resolve to nobody.

    Exists so attribution gaps are visible instead of silent: feed it the
    distinct `sender_name` values and the result is exactly the list of
    `wa_names` tags still missing from the Zitadel console.
    """
    known = by_wa_name(refresh=refresh)
    out: list[str] = []
    for n in names:
        stripped = (n or "").strip()
        # The group JID is the bot, not a person missing a tag.
        if stripped.isdigit() and len(stripped) >= 15:
            continue
        key = stripped.casefold()
        if key and key not in known and n not in out:
            out.append(n)
    return out


def by_psn_id(*, refresh: bool = False) -> dict[str, dict]:
    """Case-folded PSN online id -> person, for joining `clips` rows."""
    return {p["psn_id"].casefold(): p for p in people(refresh=refresh) if p["psn_id"]}


def by_zitadel_id(*, refresh: bool = False) -> dict[str, dict]:
    """Zitadel id -> person, for soundboards, giveaways, facts and chat history."""
    return {p["zitadel_id"]: p for p in people(refresh=refresh)}


def identify_jid(jid: str, *, refresh: bool = False) -> dict | None:
    """Person behind a raw WhatsApp JID, tolerating device suffixes and domains."""
    key = _normalise_jid(jid)
    return by_wa_jid(refresh=refresh).get(key) if key else None
