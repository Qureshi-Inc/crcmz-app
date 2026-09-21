"""Squad sightings: cross-player observations mined from review text.

A review is written about the clip sender, but the analysis constantly notices
what squadmates were doing in the same footage ("Deception revived him",
"ZooBeeMama pinged danger"). Sightings turn those mentions into an attributed
squad feed without exposing anyone's private report: only the single sentence,
the observed player, the game, and when it happened.

Matching is roster-driven (crcmz_identity people rows): a mention only becomes
a sighting when it matches a known member's PSN id, display name, username,
Mattermost handle, or WhatsApp name. Killfeed names of enemies and spectators
never match, so they can never be misattributed. Mentions of the reviewed
player themself are skipped — a sighting is always about *someone else*.
"""

import re as _re

_SENT_SPLIT = _re.compile(r"(?<=[.!?])\s+|\n+")
_MAX_SIGHTINGS = 12


def roster_aliases(people):
    """Build matchable alias sets from crcmz_identity people rows."""
    out = []
    for p in people or []:
        aliases = {
            p.get("psn_id") or "",
            p.get("display_name") or "",
            p.get("username") or "",
            p.get("mm_username") or "",
        }
        aliases.update(p.get("wa_names") or [])
        aliases = {a.strip() for a in aliases if a and a.strip()}
        if not aliases:
            continue
        out.append({
            "key": p.get("zitadel_id") or p.get("psn_id") or "",
            "label": p.get("display_name") or p.get("psn_id") or "Squadmate",
            "psn_id": (p.get("psn_id") or "").casefold(),
            "aliases": sorted(aliases, key=len, reverse=True),
        })
    return out


def _compile(entry):
    """One regex per person, split by alias length.

    Long aliases match case-insensitively ("deception" finds "Deception").
    Short ones (<5 chars) match case-sensitively so the word "ace" doesn't
    become the player Ace.
    """
    long = [a for a in entry["aliases"] if len(a) >= 5]
    short = [a for a in entry["aliases"] if len(a) < 5]
    rx_long = _re.compile("|".join(r"\b%s\b" % _re.escape(a) for a in long),
                         _re.IGNORECASE) if long else None
    rx_short = _re.compile("|".join(r"\b%s\b" % _re.escape(a)
                                   for a in short)) if short else None
    return rx_long, rx_short


def _sentences(review):
    texts = [review.get("summary") or "", review.get("overall_assessment") or ""]
    for k in ("strengths", "mistakes", "coaching_tips"):
        v = review.get(k)
        if isinstance(v, list):
            texts.extend(str(x) for x in v if x)
    nm = review.get("notable_moments")
    if isinstance(nm, list):
        for m in nm:
            if isinstance(m, dict):
                texts.append(str(m.get("note") or m.get("text") or ""))
            elif m:
                texts.append(str(m))
    out = []
    for t in texts:
        for s in _SENT_SPLIT.split(t):
            s = " ".join(s.split())
            if len(s) >= 12:
                out.append(s[:280])
    return out


def extract(complete_reviews, roster):
    """Mine squadmate sightings from completed reviews.

    Returns newest-first dicts: player, observation, game, created_at.
    """
    if not roster or not complete_reviews:
        return []
    compiled = [(e, _compile(e)) for e in roster]
    seen = set()
    sightings = []
    for r in complete_reviews:
        self_psn = (r.get("psn_user") or "").casefold()
        self_entry = next(
            (e for e in roster if e["psn_id"] and e["psn_id"] == self_psn), None)
        self_key = (self_entry or {}).get("key") or ""
        game = r.get("game")
        ts = r.get("created_at") or 0
        for s in _sentences(r):
            for e, (rx_long, rx_short) in compiled:
                if e["key"] and e["key"] == self_key:
                    continue
                if not self_entry and self_psn and e["psn_id"] == self_psn:
                    continue
                if ((rx_long and rx_long.search(s)) or
                        (rx_short and rx_short.search(s))):
                    dedup = (e["key"] or e["label"], s)
                    if dedup in seen:
                        continue
                    seen.add(dedup)
                    sightings.append({
                        "player": e["label"],
                        "observation": s,
                        "game": game,
                        "created_at": ts,
                    })
    sightings.sort(key=lambda x: x["created_at"] or 0, reverse=True)
    return sightings[:_MAX_SIGHTINGS]
