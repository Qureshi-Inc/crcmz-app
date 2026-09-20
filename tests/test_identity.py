#!/usr/bin/env python3
"""Identity graph: Zitadel tag decoding, resolution precedence, JID matching.

Plain asserts, no pytest -- run inside the app image where the deps live:

    docker build -t crcmz-app:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_identity.py

A local HTTP server stands in for Zitadel so the real httpx path is exercised
(urllib would pass here but fails against the Cloudflare-fronted issuer).
"""

import base64
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ.setdefault("SESSION_SECRET", "test-secret-for-identity")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crcmz_identity as ident  # noqa: E402

FAILED: list[str] = []
PASSED = 0

# How many user-search calls the fake issuer has served, so caching is testable.
SEARCH_CALLS = 0
# Flipped by a test to prove a failing fetch does not erase a good cache.
RETURN_EMPTY = False


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


def b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


# Two fully tagged humans, one with no tags at all (mirrors the real org, where
# 3 of 8 accounts carry none), and two people sharing a display name so the
# ambiguity path is covered.
USERS = [
    {"id": "1001", "userName": "moiz", "state": "USER_STATE_ACTIVE",
     "human": {"profile": {"displayName": "Interesting Soup"},
               "email": {"email": "moiz@crcmz.me"}}},
    {"id": "1002", "userName": "zubair221b", "state": "USER_STATE_ACTIVE",
     "human": {"profile": {"displayName": "ace killerx"},
               "email": {"email": "zubair@crcmz.me"}}},
    {"id": "1003", "userName": "notags", "state": "USER_STATE_ACTIVE",
     "human": {"profile": {"displayName": "Dark Souls"},
               "email": {"email": "dark@crcmz.me"}}},
    {"id": "1004", "userName": "twin_a", "state": "USER_STATE_ACTIVE",
     "human": {"profile": {"displayName": "Twin Person"},
               "email": {"email": "a@crcmz.me"}}},
    {"id": "1005", "userName": "twin_b", "state": "USER_STATE_ACTIVE",
     "human": {"profile": {"displayName": "Twin Person"},
               "email": {"email": "b@crcmz.me"}}},
]

META = {
    "1001": [
        {"key": "mm_username", "value": b64("moiz")},
        {"key": "psn_id", "value": b64("moiiz41510")},
        {"key": "wa_jid", "value": b64("15105550001@s.whatsapp.net")},
        {"key": "wa_phone", "value": b64("+15105550001")},
        # Comma-separated: this person posts under two WhatsApp names.
        {"key": "wa_names", "value": b64("MQ, Moiz Q")},
        # An extra tag nobody has coded for: must survive under ["tags"].
        {"key": "favourite_gun", "value": b64("MCW")},
    ],
    "1002": [
        {"key": "mm_username", "value": b64("zubair221b")},
        {"key": "psn_id", "value": b64("killerx096")},
        {"key": "wa_jid", "value": b64("15875550002@s.whatsapp.net")},
        # Deliberately NOT base64: the literal-passthrough branch.
        {"key": "wa_phone", "value": "+15875550002"},
        # Semicolon-separated, with padding to trim.
        {"key": "wa_names", "value": b64("Zubair CRCMZ ; Zubair")},
    ],
    "1003": [],
    # Both twins claim the same WhatsApp name, so it must map to neither.
    "1004": [{"key": "wa_names", "value": b64("Twinny")}],
    "1005": [{"key": "wa_names", "value": b64("Twinny")}],
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        global SEARCH_CALLS
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        path = self.path

        if path.endswith("/users/_search"):
            SEARCH_CALLS += 1
            body = {"result": [] if RETURN_EMPTY else USERS}
        elif "/metadata/_search" in path:
            uid = path.split("/users/", 1)[1].split("/", 1)[0]
            body = {"result": META.get(uid, [])}
        else:
            self.send_response(404)
            self.end_headers()
            return

        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):  # silence the test server
        pass


def reset():
    """Drop the module cache so each test starts from a cold graph."""
    ident._cache.clear()


def main():
    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ident.ZITADEL_ISSUER = f"http://127.0.0.1:{server.server_port}"
    ident.ZITADEL_SERVICE_TOKEN = "test-token"

    print("identity graph")

    def tags_decoded():
        reset()
        roster = ident.people()
        assert len(roster) == 5, roster
        p = ident.by_zitadel_id()["1001"]
        assert p["psn_id"] == "moiiz41510", p
        assert p["wa_jid"] == "15105550001@s.whatsapp.net", p
        assert p["display_name"] == "Interesting Soup", p
        assert p["email"] == "moiz@crcmz.me", p
    check("base64 tag values are decoded", tags_decoded)

    def literal_tag_passthrough():
        reset()
        p = ident.by_zitadel_id()["1002"]
        # Not valid base64 -> kept verbatim rather than dropped.
        assert p["wa_phone"] == "+15875550002", p
    check("non-base64 tag value passes through", literal_tag_passthrough)

    def unknown_tag_kept():
        reset()
        p = ident.by_zitadel_id()["1001"]
        assert p["tags"].get("favourite_gun") == "MCW", p["tags"]
    check("unrecognised tags survive under ['tags']", unknown_tag_kept)

    def untagged_person_ok():
        reset()
        p = ident.by_zitadel_id()["1003"]
        assert p["psn_id"] == "" and p["wa_jid"] == "", p
        assert p["display_name"] == "Dark Souls", p
    check("untagged account loads with empty tags", untagged_person_ok)

    def resolve_by_ids():
        reset()
        assert ident.resolve("1001")["zitadel_id"] == "1001"
        assert ident.resolve("moiiz41510")["zitadel_id"] == "1001"
        assert ident.resolve("MOIIZ41510")["zitadel_id"] == "1001", "psn id must fold case"
        assert ident.resolve("zubair221b")["zitadel_id"] == "1002"
        assert ident.resolve("moiz@crcmz.me")["zitadel_id"] == "1001"
    check("resolve by zitadel id / psn id / username / email", resolve_by_ids)

    def resolve_by_phone_and_jid():
        reset()
        assert ident.resolve("15105550001@s.whatsapp.net")["zitadel_id"] == "1001"
        assert ident.resolve("+15105550001")["zitadel_id"] == "1001"
        assert ident.resolve("15105550001")["zitadel_id"] == "1001"
    check("resolve by WhatsApp jid and phone", resolve_by_phone_and_jid)

    def jid_variants():
        reset()
        # Baileys emits all three shapes for one person.
        for jid in ("15875550002@s.whatsapp.net",
                    "15875550002@c.us",
                    "15875550002:12@s.whatsapp.net"):
            got = ident.identify_jid(jid)
            assert got and got["zitadel_id"] == "1002", (jid, got)
    check("identify_jid tolerates device suffix and @c.us", jid_variants)

    def resolve_by_display_name():
        reset()
        assert ident.resolve("Interesting Soup")["zitadel_id"] == "1001"
        assert ident.resolve("interesting soup")["zitadel_id"] == "1001"
        assert ident.resolve("Dark")["zitadel_id"] == "1003", "unique substring should match"
    check("resolve by display name when unambiguous", resolve_by_display_name)

    def ambiguous_name_refused():
        reset()
        # Two people share this name: guessing one would misattribute messages.
        assert ident.resolve("Twin Person") is None
        assert ident.resolve("Twin") is None
    check("ambiguous display name resolves to None", ambiguous_name_refused)

    def unknown_and_blank():
        reset()
        assert ident.resolve("") is None
        assert ident.resolve("   ") is None
        assert ident.resolve("nobody-here") is None
        assert ident.identify_jid("") is None
    check("blank and unknown needles return None", unknown_and_blank)

    def wa_names_parsed():
        reset()
        assert ident.by_zitadel_id()["1001"]["wa_names"] == ["MQ", "Moiz Q"]
        # Semicolons split too, and padding is trimmed.
        assert ident.by_zitadel_id()["1002"]["wa_names"] == ["Zubair CRCMZ", "Zubair"]
        assert ident.by_zitadel_id()["1003"]["wa_names"] == []
    check("wa_names splits on comma/semicolon and trims", wa_names_parsed)

    def sender_name_join():
        reset()
        # This is the only join that works for stored messages.
        assert ident.identify_sender_name("MQ")["zitadel_id"] == "1001"
        assert ident.identify_sender_name("mq")["zitadel_id"] == "1001"
        assert ident.identify_sender_name("Moiz Q")["zitadel_id"] == "1001"
        assert ident.identify_sender_name("Zubair")["zitadel_id"] == "1002"
        assert ident.identify_sender_name("  Zubair CRCMZ ")["zitadel_id"] == "1002"
    check("identify_sender_name maps tagged WhatsApp names", sender_name_join)

    def sender_name_fallbacks():
        reset()
        # Untagged people are still reachable by display name / username.
        assert ident.identify_sender_name("Dark Souls")["zitadel_id"] == "1003"
        assert ident.identify_sender_name("killerx096")["zitadel_id"] == "1002"
    check("display name and psn id work as name fallbacks", sender_name_fallbacks)

    def contested_name_dropped():
        reset()
        # Two people tagged "Twinny": mapping either would misattribute.
        assert ident.identify_sender_name("Twinny") is None
        assert "twinny" not in ident.by_wa_name()
    check("a name claimed by two people maps to nobody", contested_name_dropped)

    def resolve_via_wa_name():
        reset()
        assert ident.resolve("MQ")["zitadel_id"] == "1001"
    check("resolve() also accepts a tagged WhatsApp name", resolve_via_wa_name)

    def gaps_reported():
        reset()
        seen = ["MQ", "Mutasif", "Noor ul Amin", "Twinny", "Dark Souls", ""]
        gaps = ident.unmapped_wa_names(seen)
        assert "Mutasif" in gaps, gaps
        assert "Noor ul Amin" in gaps, gaps
        assert "Twinny" in gaps, "contested names must be reported as gaps"
        assert "MQ" not in gaps, gaps
        assert "Dark Souls" not in gaps, gaps
        assert "" not in gaps, gaps
    check("unmapped_wa_names reports attribution gaps", gaps_reported)

    def bot_attribution():
        reset()
        # from_me wins outright: the bot's rows carry the group JID as sender.
        p = ident.attribute_message("120363406504549565", from_me=1)
        assert p["zitadel_id"] == ident.BOT_ID, p
        assert p["display_name"] == "CRCMZ Bot", p
        assert p["is_bot"] is True, p
        # Same shape as a real person, so callers need no special case.
        for key in ("wa_names", "psn_id", "tags", "username"):
            assert key in p, key
    check("from_me messages attribute to CRCMZ Bot", bot_attribution)

    def group_jid_is_bot_not_person():
        reset()
        # A bare long digit run in the sender column is a JID leak, not a human.
        p = ident.attribute_message("120363406504549565", from_me=0)
        assert p and p["zitadel_id"] == ident.BOT_ID, p
        # A short number is a phone-shaped human name and must stay unknown.
        assert ident.attribute_message("5551234", from_me=0) is None
    check("group JID in sender column attributes to the bot", group_jid_is_bot_not_person)

    def attribute_prefers_jid_then_name():
        reset()
        # Exact JID match wins even when the name says someone else.
        p = ident.attribute_message("MQ", sender_jid="15875550002@s.whatsapp.net")
        assert p["zitadel_id"] == "1002", p
        # No JID (the 89% case) -> fall back to the wa_names join.
        assert ident.attribute_message("MQ")["zitadel_id"] == "1001"
        # An @lid privacy id matches no tag, so the name still decides.
        assert ident.attribute_message("MQ", sender_jid="83571234@lid")["zitadel_id"] == "1001"
    check("attribute_message tries jid then name", attribute_prefers_jid_then_name)

    def unknown_sender_not_guessed():
        reset()
        assert ident.attribute_message("+1 (510) 520-2167") is None
        assert ident.attribute_message("") is None
        # Contested names stay unknown here too.
        assert ident.attribute_message("Twinny") is None
    check("unknown sender attributes to nobody", unknown_sender_not_guessed)

    def bot_not_reported_as_gap():
        reset()
        gaps = ident.unmapped_wa_names(["120363406504549565", "MQ", "Stranger"])
        assert gaps == ["Stranger"], gaps
    check("group JID is not reported as a missing tag", bot_not_reported_as_gap)

    def no_credentials_leak():
        reset()
        blob = json.dumps(ident.people())
        for secret in ("npsso", "access_token", "refresh_token"):
            assert secret not in blob, f"{secret} leaked into identity output"
    check("identity output carries no credential fields", no_credentials_leak)

    def caching():
        global SEARCH_CALLS
        reset()
        SEARCH_CALLS = 0
        ident.people()
        ident.people()
        ident.people()
        assert SEARCH_CALLS == 1, f"expected 1 search call, got {SEARCH_CALLS}"
        ident.people(refresh=True)
        assert SEARCH_CALLS == 2, f"refresh should re-fetch, got {SEARCH_CALLS}"
    check("people() caches and refresh= forces a re-fetch", caching)

    def empty_fetch_keeps_cache():
        global RETURN_EMPTY
        reset()
        assert len(ident.people()) == 5
        RETURN_EMPTY = True
        try:
            # A Zitadel blip must not wipe a working graph mid-conversation.
            assert len(ident.people(refresh=True)) == 5
        finally:
            RETURN_EMPTY = False
    check("empty fetch does not erase a good cache", empty_fetch_keeps_cache)

    # ── the portal fallback for psn_id ────────────────────────────────────────
    # User 1003 ("Dark Souls") carries no tags at all, which is the real-world
    # case: somebody links PSN through the portal and nobody edits the Zitadel
    # console, so their clips stayed invisible.

    def portal_dir(records: dict[str, dict]):
        """Point portal at a temp /data/users holding the given records."""
        import json as _json
        import tempfile
        from pathlib import Path
        tmp = Path(tempfile.mkdtemp(prefix="ident-portal-"))
        for key, rec in records.items():
            (tmp / f"{key}.json").write_text(_json.dumps(rec))
        return tmp

    def portal_link_fills_a_missing_psn_id():
        import json as _json
        import portal
        saved = portal.USERS_DIR
        portal.USERS_DIR = portal_dir({"noor": {
            "zitadel_user_id": "1003",
            "online_id": "kaptaannoor",
            "mm_username": "noor",
            # Live credentials sit in the same file as the harmless fields.
            "npsso": "LIVE-NPSSO", "access_token": "LIVE-ACCESS",
            "refresh_token": "LIVE-REFRESH",
        }})
        try:
            reset()
            p = ident.by_zitadel_id()["1003"]
            assert p["psn_id"] == "kaptaannoor", p
            assert p["mm_username"] == "noor", p
            # ...and the person is now reachable by that PSN id, which is what
            # makes their clips join.
            assert ident.by_psn_id()["kaptaannoor"]["display_name"] == "Dark Souls"
            assert ident.resolve("kaptaannoor")["zitadel_id"] == "1003"
            # The tag itself is still empty -- the fallback must not pretend
            # otherwise, or a reader cannot tell what needs setting in Zitadel.
            assert p["tags"].get("psn_id", "") == "", p["tags"]
            blob = _json.dumps(p)
            for secret in ("LIVE-NPSSO", "LIVE-ACCESS", "LIVE-REFRESH"):
                assert secret not in blob, f"{secret} reached the identity graph"
        finally:
            portal.USERS_DIR = saved
            reset()
    check("a portal PSN link fills an unset psn_id tag",
          portal_link_fills_a_missing_psn_id)

    def tag_wins_over_the_portal():
        import portal
        saved = portal.USERS_DIR
        # A stale or duplicate portal record must never rename a tagged person.
        portal.USERS_DIR = portal_dir({"stale": {
            "zitadel_user_id": "1001", "online_id": "WRONG-ID",
            "mm_username": "wrong-mm",
        }})
        try:
            reset()
            p = ident.by_zitadel_id()["1001"]
            assert p["psn_id"] == "moiiz41510", p
            assert p["mm_username"] == "moiz", p
        finally:
            portal.USERS_DIR = saved
            reset()
    check("a hand-set tag beats the portal link", tag_wins_over_the_portal)

    def no_portal_data_degrades_quietly():
        import portal
        saved = portal.USERS_DIR
        portal.USERS_DIR = portal_dir({})          # exists but empty
        try:
            assert ident._portal_links() == {}
            from pathlib import Path
            portal.USERS_DIR = Path("/nope/not/here")
            assert ident._portal_links() == {}     # missing dir is not an error
            reset()
            assert len(ident.people()) == 5, "graph must still load from tags"
        finally:
            portal.USERS_DIR = saved
            reset()
    check("missing portal data falls back to tags only",
          no_portal_data_degrades_quietly)

    def unlinked_person_keeps_an_empty_psn_id():
        # No portal record and no tag: still empty, never guessed from a name.
        reset()
        p = ident.by_zitadel_id()["1003"]
        assert p["psn_id"] == "", p
        assert "kaptaannoor" not in ident.by_psn_id()
    check("no tag and no link leaves psn_id empty",
          unlinked_person_keeps_an_empty_psn_id)

    def disabled_without_token():
        reset()
        saved = ident.ZITADEL_SERVICE_TOKEN
        ident.ZITADEL_SERVICE_TOKEN = ""
        try:
            assert ident.configured() is False
            assert ident.people() == []
            assert ident.resolve("moiz") is None
        finally:
            ident.ZITADEL_SERVICE_TOKEN = saved
            reset()
    check("no service token disables the graph cleanly", disabled_without_token)

    server.shutdown()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
