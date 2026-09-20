#!/usr/bin/env python3
"""Auth gate: who gets past `_auth_gate` without a session, and who no longer does.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_auth_gate

Three behaviours are pinned here:

  * The Host header alone is no longer an authentication check. It used to be: any
    request whose Host was not PORTAL_PUBLIC_HOST skipped the gate entirely, so
    `curl -H 'Host: whatever' https://app.crcmz.me/api/squad` was the whole exploit
    if anything would route it.
  * A machine can authenticate explicitly with CRCMZ_MACHINE_TOKEN, from anywhere.
    This is the migration path off the private-network rule for the Stream Deck
    plugin, which today authenticates by virtue of calling a Tailscale IP.
  * A missing SESSION_SECRET fails closed instead of signing cookies with the
    published constant "dev-insecure".
"""

import os
import sys

os.environ.setdefault("SESSION_SECRET", "test-secret-for-auth-gate-tests")
# The app refuses to import without these; nothing in these tests talks to PSN.
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ.setdefault("CRCMZ_MACHINE_TOKEN", "machine-token-for-tests")

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


# A protected endpoint that needs no external service and no request body, so a
# 200 here means "the gate let me through" and nothing else.
PROTECTED = "/api/admin/check"


def gate_tests():
    from fastapi.testclient import TestClient
    import server

    print("auth gate")

    # The peer address is the whole point of these tests, and starlette 0.38's
    # TestClient hardcodes scope["client"] to the literal "testclient". Setting it
    # is the transport's job in production, so setting it here is the same thing a
    # socket would do — the app under test is untouched.
    def client_at(peer, base_url):
        async def with_peer(scope, receive, send):
            if scope["type"] == "http":
                scope = {**scope, "client": (peer, 51234) if peer else None}
            await server.app(scope, receive, send)
        return TestClient(with_peer, base_url=base_url)

    def lan(path=PROTECTED, host="10.0.0.7:8000", peer="10.0.0.7", **kw):
        return client_at(peer, f"http://{host}").get(path, **kw)

    # ── The private-network bypass still works for the callers that need it ──────
    def tailnet_peer_passes():
        # The Stream Deck plugin calls http://100.123.228.75:3021 over Tailscale.
        # 100.64.0.0/10 is CGNAT space, which ipaddress.is_private reports as False —
        # the reason _LOCAL_NETWORKS lists the ranges explicitly instead.
        r = lan(host="100.123.228.75:3021", peer="100.123.228.75")
        assert r.status_code == 200, (r.status_code, r.text[:200])
    check("a real tailnet peer still skips the gate", tailnet_peer_passes)

    def lan_peer_passes():
        r = lan(host="192.168.5.54:3021", peer="192.168.5.54")
        assert r.status_code == 200, (r.status_code, r.text[:200])
    check("a real LAN peer still skips the gate", lan_peer_passes)

    def loopback_passes():
        r = lan(host="127.0.0.1:3000", peer="127.0.0.1")
        assert r.status_code == 200, (r.status_code, r.text[:200])
    check("loopback still skips the gate (container healthcheck)", loopback_passes)

    # ── but a forged Host from anywhere else does not ───────────────────────────
    def public_peer_with_forged_host_is_refused():
        r = lan(host="not-the-public-host", peer="8.8.8.8")
        assert r.status_code == 401, (
            "a public-internet peer sending any Host it likes must not skip auth; "
            f"got {r.status_code}")
    check("forged Host from a public address is refused", public_peer_with_forged_host_is_refused)

    def relayed_request_is_refused():
        # Behind Traefik the peer address is the proxy — private — so the address
        # test alone would pass. The forwarding headers say the real caller is
        # someone else, and that has to win.
        r = lan(host="10.0.0.7:8000", peer="10.0.0.9",
                headers={"X-Forwarded-For": "8.8.8.8"})
        assert r.status_code == 401, (
            "a proxied request must not inherit the proxy's private address; "
            f"got {r.status_code}")
    check("a proxied request does not inherit the proxy's trust", relayed_request_is_refused)

    def unparseable_peer_is_refused():
        # Unknown has to mean no when the thing being gated is an auth bypass.
        # A hostname that is not an IP, and no peer at all (a unix socket).
        assert lan(peer="some-hostname").status_code == 401
        assert lan(peer=None).status_code == 401
    check("an unidentifiable peer is refused", unparseable_peer_is_refused)

    def public_host_still_requires_a_session():
        c = client_at("10.0.0.7", "https://app.crcmz.me")
        # Private peer or not, the public hostname always demands a session.
        assert c.get(PROTECTED).status_code == 401
    check("the public host always requires a session", public_host_still_requires_a_session)

    # ── explicit machine credential ─────────────────────────────────────────────
    def machine_token_works_from_anywhere():
        c = client_at("8.8.8.8", "https://app.crcmz.me")
        for hdr in ({"Authorization": f"Bearer {server.MACHINE_TOKEN}"},
                    {"X-CRCMZ-Machine-Token": server.MACHINE_TOKEN}):
            r = c.get(PROTECTED, headers=hdr)
            assert r.status_code == 200, (hdr, r.status_code, r.text[:200])
    check("CRCMZ_MACHINE_TOKEN authenticates over the public host", machine_token_works_from_anywhere)

    def wrong_machine_token_is_refused():
        c = client_at("8.8.8.8", "https://app.crcmz.me")
        for tok in ("", "wrong", server.MACHINE_TOKEN[:6], server.MACHINE_TOKEN + "x"):
            r = c.get(PROTECTED, headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 401, (tok, r.status_code)
    check("a wrong or truncated machine token is refused", wrong_machine_token_is_refused)

    def unset_machine_token_authorises_nobody():
        saved = server.MACHINE_TOKEN
        server.MACHINE_TOKEN = ""
        try:
            c = client_at("8.8.8.8", "https://app.crcmz.me")
            # Notably: not even an empty Authorization header.
            for hdr in ({"Authorization": "Bearer "}, {"X-CRCMZ-Machine-Token": ""},
                        {"Authorization": "Bearer anything"}):
                assert c.get(PROTECTED, headers=hdr).status_code == 401, hdr
        finally:
            server.MACHINE_TOKEN = saved
    check("no machine token configured means nobody is a machine", unset_machine_token_authorises_nobody)

    # ── session secret fails closed ─────────────────────────────────────────────
    def missing_session_secret_fails_closed():
        saved = server.SESSION_SECRET_MISSING
        server.SESSION_SECRET_MISSING = True
        try:
            c = client_at("8.8.8.8", "https://app.crcmz.me")
            r = c.get(PROTECTED)
            assert r.status_code == 503, (
                f"an unconfigured session key must refuse, not 401 into a login "
                f"loop; got {r.status_code}")
            # Still reachable: the healthcheck must not be taken down by this.
            assert c.get("/health").status_code == 200
        finally:
            server.SESSION_SECRET_MISSING = saved
    check("missing SESSION_SECRET refuses the public host but keeps /health", missing_session_secret_fails_closed)

    def dev_fallback_is_not_a_known_value():
        import itsdangerous
        forged = itsdangerous.URLSafeTimedSerializer(
            "dev-insecure", salt="psn-session").dumps({"sub": "attacker", "email": "a@b.c"})
        c = client_at("8.8.8.8", "https://app.crcmz.me")
        c.cookies.set(server._SESSION_COOKIE, forged)
        assert c.get(PROTECTED).status_code == 401, (
            "a cookie signed with the old published fallback key must not be accepted")
    check("a cookie signed with 'dev-insecure' is not a session", dev_fallback_is_not_a_known_value)

    def open_paths_are_still_open():
        c = client_at("8.8.8.8", "https://app.crcmz.me")
        # These carry their own auth or are deliberately public. Unchanged contract.
        # What matters is that the gate does not intercept these. Some of them then
        # answer 503 because this test env has no ZITADEL_CLIENT_ID, which is the
        # endpoint's own business, not the gate's.
        for path in ("/health", "/v2/health", "/api/watch/jwks.json", "/auth/login",
                     "/.well-known/oauth-authorization-server", "/.well-known/webauthn"):
            r = c.get(path)
            assert r.status_code != 401, (path, r.status_code, r.text[:200])
        # And these two really do answer.
        assert c.get("/health").json().get("status")
        assert c.get("/api/watch/jwks.json").json().get("keys") is not None
    check("the public path allowlist is unchanged", open_paths_are_still_open)


def escaping_tests():
    import server

    print("dashboard output escaping")

    def display_name_is_escaped():
        html = server._dashboard_html(user_email='<img src=x onerror=alert(1)>@evil.com',
                                      psn_id="", personal=[], signed_in=True)
        assert "<img src=x" not in html, "the display name was interpolated as markup"
        assert "&lt;img src=x" in html
    check("the account display name is escaped, not interpolated", display_name_is_escaped)

    def script_values_cannot_close_the_block():
        # A board label is free text that has been through the flavour model, so it
        # can contain anything at all. json.dumps leaves "<" alone, which is enough
        # to end the <script> element early.
        nasty = "</script><img src=x onerror=alert(1)>"
        html = server._dashboard_html(user_email="a@b.c", psn_id=nasty,
                                      personal=[{"label": nasty, "msg": nasty}],
                                      signed_in=True)
        assert "</script><img" not in html, "a board label escaped the script block"
        assert "\\u003c/script" in html or "\\u003c" in html
    check("script-embedded JSON cannot close the script block", script_values_cannot_close_the_block)

    def the_value_still_round_trips():
        # Escaping must not change what the page actually reads back.
        import json
        assert json.loads(server._script_json("a<b>c&d")) == "a<b>c&d"
        assert json.loads(server._script_json([{"label": "</script>"}])) == [{"label": "</script>"}]
    check("escaping does not change the parsed value", the_value_still_round_trips)


print("\n== auth gate ==")
try:
    gate_tests()
    escaping_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not boot the app: {type(e).__name__}: {e}")

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
