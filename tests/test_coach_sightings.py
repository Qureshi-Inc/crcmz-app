#!/usr/bin/env python3
"""Squad sightings: cross-player observations mined from review text.

Runs standalone (no fastapi import): python tests/test_coach_sightings.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import coach_sightings as sight

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s: %s" % (name, type(exc).__name__, exc,
                                        str(exc)[:160]))


ROSTER = sight.roster_aliases([
    {"zitadel_id": "z1", "psn_id": "BrendanSoup", "display_name": "BrendanSoup",
     "username": "brendansoup", "mm_username": "",
     "wa_names": ["deception", "Deception"]},
    {"zitadel_id": "z2", "psn_id": "moiiz41510", "display_name": "Moiiz",
     "username": "moiiz", "mm_username": "", "wa_names": ["Interesting Soup"]},
    {"zitadel_id": "z3", "psn_id": "KillerX", "display_name": "KillerX",
     "username": "killerx", "mm_username": "", "wa_names": ["Ace"]},
])


def review(psn_user, created_at=1000, **kw):
    r = {"psn_user": psn_user, "game": "ARC Raiders", "created_at": created_at,
         "review_status": "complete"}
    r.update(kw)
    return r


def test_attributes_roster_alias():
    out = sight.extract([review("moiiz41510",
                                summary="Deception revived him mid-fight.")],
                        ROSTER)
    assert len(out) == 1, out
    assert out[0]["player"] == "BrendanSoup", out[0]
    assert "Deception revived him" in out[0]["observation"]


def test_skips_self_mentions():
    # A review about BrendanSoup mentioning Deception (his own alias) yields
    # nothing for him, but a mention of a squadmate still counts.
    out = sight.extract([review(
        "BrendanSoup",
        summary="Deception pushed ahead. Moiiz trailed behind the wall.")],
        ROSTER)
    players = [s["player"] for s in out]
    assert "BrendanSoup" not in players, players
    assert "Moiiz" in players, players


def test_ignores_non_roster_names():
    out = sight.extract([review(
        "moiiz41510",
        summary="Died to enemy raider VNMCDumb#1998 as the squad wiped.")],
        ROSTER)
    assert out == [], out


def test_case_insensitive_long_alias():
    out = sight.extract([review("moiiz41510",
                                mistakes=["ignored danger pings from squadmate "
                                          "zoobeeMAMA and kept looting"])],
                        sight.roster_aliases([
                            {"zitadel_id": "z9", "psn_id": "ZooBeeMama",
                             "display_name": "ZooBeeMama", "username": "",
                             "mm_username": "", "wa_names": []}]))
    assert len(out) == 1 and out[0]["player"] == "ZooBeeMama", out


def test_short_alias_is_case_sensitive():
    roster = ROSTER
    hit = sight.extract([review("moiiz41510",
                                summary="Ace held the flank during extraction.")],
                        roster)
    assert len(hit) == 1 and hit[0]["player"] == "KillerX", hit
    miss = sight.extract([review(
        "moiiz41510",
        summary="he flew the drone like an ace pilot through the gap.")],
        roster)
    assert miss == [], miss


def test_one_sighting_per_person_per_sentence():
    out = sight.extract([review(
        "moiiz41510",
        summary="Deception and BrendanSoup pushed the tunnel together.")],
        ROSTER)
    # two aliases, one person -> one sighting
    assert len(out) == 1, out


def test_two_squadmates_one_sentence():
    out = sight.extract([review(
        "moiiz41510",
        summary="Deception and Ace were ahead while he hugged a wall behind.")],
        ROSTER)
    players = sorted(s["player"] for s in out)
    assert players == ["BrendanSoup", "KillerX"], players


def test_scans_mistakes_tips_and_moments():
    out = sight.extract([review(
        "moiiz41510",
        mistakes=["Trailed while Deception pushed ahead"],
        coaching_tips=["Stick with Ace on the next push"],
        notable_moments=[{"t": "1:00", "note": "Deception called the rotate"}])],
        ROSTER)
    assert len(out) == 3, out


def test_newest_first_and_capped():
    revs = [review("moiiz41510", created_at=i,
                   summary="Deception did thing number %d." % i)
            for i in range(20)]
    out = sight.extract(revs, ROSTER)
    assert len(out) == 12, len(out)
    assert out[0]["created_at"] == 19
    assert out[-1]["created_at"] == 8


def test_empty_roster_or_reviews():
    assert sight.extract([], ROSTER) == []
    assert sight.extract([review("moiiz41510", summary="Deception ran.")],
                         []) == []


def test_scrub_single_name_and_pronoun():
    out = sight.scrub_names("Deception revived him mid-fight.", ROSTER)
    assert out == "a squadmate revived them mid-fight.", out


def test_scrub_own_name_removed():
    out = sight.scrub_names("Moiiz kept looting with a FULL backpack.",
                            ROSTER)
    assert out == "a squadmate kept looting with a FULL backpack.", out
    assert "Moiiz" not in out and "moiiz" not in out


def test_scrub_two_names_become_squadmates():
    out = sight.scrub_names(
        "Deception and Ace were ahead while he hugged a wall behind.", ROSTER)
    assert out == "squadmates were ahead while they hugged a wall behind.", out


def test_scrub_sentence_start_pronoun():
    out = sight.scrub_names("He pushed alone and his greed got him killed.",
                            ROSTER)
    assert out == "They pushed alone and their greed got them killed.", out


def test_scrub_leaves_plain_text_alone():
    text = ("Kept looting with a FULL backpack (14/14) after the 90-second "
            "extraction warning.")
    assert sight.scrub_names(text, ROSTER) == text


def test_scrub_short_alias_stays_case_sensitive():
    out = sight.scrub_names("He flew like an ace pilot through the gap.",
                            ROSTER)
    assert out == "They flew like an ace pilot through the gap.", out


def test_scrub_enemy_names_untouched():
    out = sight.scrub_names("EnemyPlayer123 downed him in the open.", ROSTER)
    assert out == "EnemyPlayer123 downed them in the open.", out


def test_scrub_empty():
    assert sight.scrub_names("", ROSTER) == ""
    assert sight.scrub_names(None, ROSTER) == ""


if __name__ == "__main__":
    print("squad sightings")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
