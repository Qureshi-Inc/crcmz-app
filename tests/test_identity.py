#!/usr/bin/env python3
"""Identity graph: Zitadel tag decoding, resolution precedence, JID matching.

Plain asserts, no pytest -- run inside the app image where the deps live:

    docker build -t psn-messenger:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" psn-messenger:test python tests/test_identity.py

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
        # An extra tag nobody has coded for: must survive under ["tags"].
        {"key": "favourite_gun", "value": b64("MCW")},
    ],
    "1002": [
        {"key": "mm_username", "value": b64("zubair221b")},
        {"key": "psn_id", "value": b64("killerx096")},
        {"key": "wa_jid", "value": b64("15875550002@s.whatsapp.net")},
        # Deliberately NOT base64: the literal-passthrough branch.
        {"key": "wa_phone", "value": "+15875550002"},
    ],
    "1003": [],
    "1004": [],
    "1005": [],
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
