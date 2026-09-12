#!/usr/bin/env python3
"""Watch Party broker tests (Phase 24, PSN side).

Plain asserts, no pytest — run inside the app image where the deps live:

    docker build -t psn-messenger:test .
    docker run --rm -e SESSION_SECRET=test-secret -e WATCH_ROOMS=crcmz \
      -v "$PWD/tests:/app/tests" psn-messenger:test python tests/test_watch.py
"""

import base64
import json
import os
import sys
import time
import unicodedata

os.environ.setdefault("SESSION_SECRET", "test-secret-for-watch-tests")
# The app refuses to import without these; nothing in these tests talks to PSN.
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "psn.crcmz.me")
os.environ.setdefault("WATCH_ROOMS", "crcmz,movies")
os.environ.setdefault("WATCH_AUTH_MODE", "zitadel-ticket")
os.environ.setdefault("WATCH_TICKET_ISSUER", "https://psn.crcmz.me")
os.environ.setdefault("WATCH_TICKET_AUDIENCE", "crcmz-watchparty")
os.environ.setdefault("WATCH_DATA_DIR", "/tmp/watch-test-data")

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


import watch  # noqa: E402


# ── identity ────────────────────────────────────────────────────────────────
def t_viewer_id_stable():
    a = watch.viewer_id("https://auth.crcmz.me", "12345")
    b = watch.viewer_id("https://auth.crcmz.me", "12345")
    assert a == b, "viewerId must be deterministic"
    assert a != watch.viewer_id("https://auth.crcmz.me", "12346")
    assert a != watch.viewer_id("https://other.example", "12345")
    assert "=" not in a and "+" not in a and "/" not in a, "must be base64url"
    assert len(a) == 43, a


def t_viewer_id_no_separator_collision():
    # iss+sub concatenation must not be ambiguous.
    assert watch.viewer_id("https://a/b", "c") != watch.viewer_id("https://a", "b/c")


def t_viewer_id_requires_both():
    for iss, sub in (("", "x"), ("https://a", ""), ("", "")):
        try:
            watch.viewer_id(iss, sub)
        except ValueError:
            continue
        raise AssertionError(f"accepted empty identity {iss!r}/{sub!r}")


# ── display name resolution ─────────────────────────────────────────────────
def t_name_priority():
    assert watch.resolve_display_name(
        nickname="Nick", psn_online_id="PsnGuy",
        zitadel_name="Real Name", preferred_username="login@x") == "Nick"
    assert watch.resolve_display_name(
        psn_online_id="PsnGuy", zitadel_name="Real Name") == "PsnGuy"
    assert watch.resolve_display_name(zitadel_name="Real Name",
                                      preferred_username="login@x") == "Real Name"
    assert watch.resolve_display_name(preferred_username="login@x") == "login@x"
    assert watch.resolve_display_name() == "Viewer"


def t_name_sanitizing():
    assert watch.sanitize_display_name("  spaced  out  ") == "spaced out"
    assert watch.sanitize_display_name("a\u0000b\u001fc") == "abc"
    assert watch.sanitize_display_name("line\nbreak") == "line break"
    assert "<" not in watch.sanitize_display_name("<script>alert(1)</script>")
    assert watch.sanitize_display_name("x" * 200) == "x" * 50
    assert watch.sanitize_display_name("") == ""
    assert watch.sanitize_display_name(None) == ""
    assert watch.sanitize_display_name(1234) == ""
    assert watch.sanitize_display_name("\u200b\u200b") == "", "zero-width only -> empty"
    # blank-ish candidates fall through instead of producing an empty name
    assert watch.resolve_display_name(nickname="   ", psn_online_id="PsnGuy") == "PsnGuy"
    assert watch.resolve_display_name(nickname="<>&") == "Viewer"


def t_name_never_empty():
    for bad in ("", " ", "\n", "\u200b", "<>", "&&&"):
        assert watch.resolve_display_name(nickname=bad) == "Viewer", bad


# ── rooms ───────────────────────────────────────────────────────────────────
def t_canonical_room():
    assert watch.canonical_room("crcmz") == "crcmz"
    assert watch.canonical_room("/crcmz") == "crcmz"
    assert watch.canonical_room("  CRCMZ  ") == "crcmz"
    for bad in ("", None, 5, "../etc", "a b", "room!", "-lead", "x" * 65, "/"):
        assert watch.canonical_room(bad) is None, bad


def t_allowed_rooms():
    assert watch.is_allowed_room("crcmz")
    assert not watch.is_allowed_room("not-a-room")


# ── tickets ─────────────────────────────────────────────────────────────────
def t_ticket_claims():
    viewer = watch.viewer_id("https://auth.crcmz.me", "u1")
    out = watch.mint_ticket(viewer=viewer, room="crcmz", display_name="Tester")
    assert out["expires_in"] <= 90, "TTL must be <= 90s"
    import jwt as pyjwt
    header = pyjwt.get_unverified_header(out["ticket"])
    assert header["alg"] == "ES256", header
    assert header["kid"] == out["kid"]
    claims = pyjwt.decode(
        out["ticket"], watch.public_key_pem(), algorithms=["ES256"],
        audience="crcmz-watchparty", issuer="https://psn.crcmz.me",
    )
    assert claims["sub"] == viewer
    assert claims["room"] == "crcmz"
    assert claims["name"] == "Tester"
    assert claims["jti"] == out["jti"]
    assert claims["exp"] - claims["iat"] == out["expires_in"]
    # No PII in the ticket.
    blob = json.dumps(claims)
    for leak in ("@", "auth.crcmz.me", "preferred_username", "email"):
        assert leak not in blob, f"ticket leaked {leak}: {blob}"


def t_ticket_key_is_not_session_secret():
    pem = watch.public_key_pem()
    assert "PUBLIC KEY" in pem
    assert os.environ["SESSION_SECRET"] not in pem
    from cryptography.hazmat.primitives import serialization
    priv = watch._signing_key()["private"].private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    assert "PRIVATE KEY" in priv
    assert os.environ["SESSION_SECRET"] not in priv
    assert priv != pem and "PRIVATE" not in pem


def t_jwks_is_public_only():
    keys = watch.jwks()["keys"]
    assert len(keys) == 1
    jwk = keys[0]
    assert jwk["kty"] == "EC" and jwk["crv"] == "P-256" and jwk["alg"] == "ES256"
    assert jwk["use"] == "sig" and jwk["kid"]
    assert "d" not in jwk, "JWKS must never contain the private scalar"
    assert set(jwk) <= {"kty", "crv", "x", "y", "alg", "use", "kid"}, jwk


def t_ticket_tamper_detected():
    import jwt as pyjwt
    out = watch.mint_ticket(viewer="v1", room="crcmz", display_name="Tester")
    head, payload, sig = out["ticket"].split(".")
    body = json.loads(base64.urlsafe_b64decode(payload + "=="))
    body["name"] = "Admin"
    forged = (head + "." +
              base64.urlsafe_b64encode(json.dumps(body).encode()).rstrip(b"=").decode() +
              "." + sig)
    try:
        pyjwt.decode(forged, watch.public_key_pem(), algorithms=["ES256"],
                     audience="crcmz-watchparty", issuer="https://psn.crcmz.me")
    except Exception:
        return
    raise AssertionError("tampered ticket verified")


def t_nickname_store():
    sub = "test-sub-" + str(int(time.time()))
    assert watch.get_nickname(sub) == ""
    assert watch.set_nickname(sub, "  My Name  ") == "My Name"
    assert watch.get_nickname(sub) == "My Name"
    assert "<" not in watch.set_nickname(sub, "<b>x</b>")
    assert "<" not in watch.get_nickname(sub)
    assert watch.set_nickname(sub, "") == ""
    assert watch.get_nickname(sub) == ""


def t_client_config_has_no_secrets():
    cfg = json.dumps(watch.client_config())
    assert "PRIVATE" not in cfg
    assert os.environ["SESSION_SECRET"] not in cfg
    assert "d" not in json.loads(cfg).keys()


def t_short_viewer_is_short_and_hashed():
    v = watch.viewer_id("https://auth.crcmz.me", "u1")
    s = watch.short_viewer(v)
    assert s and len(s) <= 12, s
    # It abbreviates the already-hashed viewerId, so logs never carry the
    # Zitadel subject or anything reversible.
    assert v.startswith(s)
    assert "u1" != s and "auth.crcmz.me" not in s
    assert watch.short_viewer("") == ""


# ── HTTP surface ────────────────────────────────────────────────────────────
def http_tests():
    from fastapi.testclient import TestClient
    import server

    client = TestClient(server.app, base_url="https://psn.crcmz.me")
    HDR = {"Origin": "https://psn.crcmz.me", "Content-Type": "application/json"}

    def session_cookie(sub="zit-user-1", **extra):
        data = {"sub": sub, "iss": "https://auth.crcmz.me", **extra}
        return server._signer().dumps(data)

    COOKIE = server._SESSION_COOKIE

    def t_join_requires_login():
        r = client.post("/api/watch/join", json={"roomId": "crcmz"}, headers=HDR)
        assert r.status_code == 401, r.status_code
        assert "ticket" not in r.text

    def t_config_requires_login():
        r = client.get("/api/watch/config", headers={"Accept": "application/json"})
        assert r.status_code == 401, r.status_code

    def t_jwks_is_open():
        r = client.get("/api/watch/jwks.json")
        assert r.status_code == 200, r.status_code
        assert "d" not in r.json()["keys"][0]

    def t_join_issues_ticket():
        import jwt as pyjwt
        client.cookies.set(COOKIE, session_cookie(name="Zed Name"))
        try:
            r = client.post("/api/watch/join", json={"roomId": "crcmz"}, headers=HDR)
            assert r.status_code == 200, (r.status_code, r.text)
            assert r.headers["cache-control"] == "no-store"
            body = r.json()
            assert body["room"] == "crcmz"
            assert body["expiresIn"] <= 90
            assert body["viewer"]["name"] == "Zed Name"
            claims = pyjwt.decode(body["ticket"], watch.public_key_pem(),
                                  algorithms=["ES256"], audience="crcmz-watchparty",
                                  issuer="https://psn.crcmz.me")
            assert claims["sub"] == watch.viewer_id("https://auth.crcmz.me", "zit-user-1")
            assert "zit-user-1" not in json.dumps(claims), "raw Zitadel sub leaked"
        finally:
            client.cookies.clear()

    def t_join_rejects_bad_room():
        client.cookies.set(COOKIE, session_cookie(name="Zed"))
        try:
            for bad in ("../etc", "unknown-room", "", "a b"):
                r = client.post("/api/watch/join", json={"roomId": bad}, headers=HDR)
                assert r.status_code == 400, (bad, r.status_code)
        finally:
            client.cookies.clear()

    def t_join_rejects_cross_origin():
        client.cookies.set(COOKIE, session_cookie(name="Zed"))
        try:
            r = client.post("/api/watch/join", json={"roomId": "crcmz"},
                            headers={"Origin": "https://evil.example",
                                     "Content-Type": "application/json"})
            assert r.status_code == 403, r.status_code
        finally:
            client.cookies.clear()

    def t_join_requires_json():
        client.cookies.set(COOKIE, session_cookie(name="Zed"))
        try:
            r = client.post("/api/watch/join", data="roomId=crcmz",
                            headers={"Origin": "https://psn.crcmz.me",
                                     "Content-Type": "application/x-www-form-urlencoded"})
            assert r.status_code == 400, r.status_code
        finally:
            client.cookies.clear()

    def t_join_rate_limited():
        client.cookies.set(COOKIE, session_cookie("rl-user", name="RL"))
        try:
            codes = [client.post("/api/watch/join", json={"roomId": "crcmz"},
                                 headers=HDR).status_code for _ in range(40)]
            assert 429 in codes, "rate limiter never engaged"
            assert codes[0] == 200
        finally:
            client.cookies.clear()

    def t_nickname_flow():
        client.cookies.set(COOKIE, session_cookie("nick-user", name="Zed"))
        try:
            r = client.post("/api/watch/nickname", json={"nickname": "Popcorn"}, headers=HDR)
            assert r.status_code == 200, r.text
            assert r.json()["name"] == "Popcorn"
            r = client.post("/api/watch/join", json={"roomId": "crcmz"}, headers=HDR)
            assert r.json()["viewer"]["name"] == "Popcorn"
            r = client.post("/api/watch/nickname", json={"nickname": ""}, headers=HDR)
            assert r.json()["name"] == "Zed", r.text
        finally:
            client.cookies.clear()

    def t_config_shape():
        client.cookies.set(COOKIE, session_cookie("cfg-user", name="Zed"))
        try:
            r = client.get("/api/watch/config", headers={"Accept": "application/json"})
            assert r.status_code == 200, r.text
            cfg = r.json()
            assert cfg["authMode"] == "zitadel-ticket"
            assert cfg["defaultRoom"] in cfg["rooms"]
            assert cfg["socketPath"].endswith("/socket.io")
            assert cfg["viewer"]["name"] == "Zed"
            assert "PRIVATE" not in r.text and "BEGIN" not in r.text
        finally:
            client.cookies.clear()

    def t_watch_page_redirects_to_tab():
        client.cookies.set(COOKIE, session_cookie("pg-user", name="Zed"))
        try:
            r = client.get("/watch", follow_redirects=False)
            assert r.status_code in (302, 307), r.status_code
            assert r.headers["location"] == "/?p=watch"
        finally:
            client.cookies.clear()

    def t_dashboard_has_watch_tab_and_no_key():
        client.cookies.set(COOKIE, session_cookie("dash-user", name="Zed"))
        try:
            r = client.get("/", headers={"Accept": "text/html"})
            assert r.status_code == 200, r.status_code
            assert 'data-p="watch"' in r.text
            assert "loadWatch" in r.text
            assert "PRIVATE KEY" not in r.text
            assert "watchTicket" in r.text  # handed over in the handshake auth
            assert "watchTicket=" not in r.text  # ...never as a query param
        finally:
            client.cookies.clear()

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check("http/" + name[2:], fn)


print("watch.py unit tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("\nHTTP endpoint tests")
try:
    http_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"http_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not boot the app: {type(e).__name__}: {e}")

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
