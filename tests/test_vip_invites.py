#!/usr/bin/env python3
"""VIP invites: account creation, the two email kinds, idempotency, and the routes.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_vip_invites

Zitadel is a fake httpx transport and SMTP is replaced, so nothing leaves the box.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-vip-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ["ZITADEL_SERVICE_TOKEN"] = "svc-token"
os.environ["VIP_INVITE_SECRET"] = "vip-secret-for-tests"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402

import vip_invites  # noqa: E402

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


class FakeZitadel:
    """Just enough of the v2 user API."""

    def __init__(self, users=None, auth_methods=None):
        self.users = users or {}            # email -> userId
        self.auth_methods = auth_methods or {}
        self.calls: list[tuple[str, str, dict]] = []
        self.codes: dict[str, str] = {}

    def handler(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        body = json.loads(req.content or b"{}") if req.content else {}
        self.calls.append((req.method, path, body))
        assert req.headers["authorization"] == "Bearer svc-token"
        if path == "/v2/users" and req.method == "POST":
            email = body["queries"][0]["emailQuery"]["emailAddress"].lower()
            uid = self.users.get(email)
            return httpx.Response(200, json={"result": [{"userId": uid, "human": {
                "profile": {"displayName": "Old Name"}}}] if uid else []})
        if path == "/v2/users/human":
            uid = str(1000 + len(self.users))
            self.users[body["email"]["email"]] = uid
            return httpx.Response(201, json={"userId": uid})
        if path.endswith("/authentication_methods"):
            uid = path.split("/")[3]
            return httpx.Response(200, json={"authMethodTypes": self.auth_methods.get(uid, [])})
        if path.endswith("/invite_code/verify"):
            uid = path.split("/")[3]
            ok = self.codes.get(uid) == body["verificationCode"]
            return httpx.Response(200 if ok else 400, json={} if ok else {"message": "code invalid"})
        if path.endswith("/invite_code"):
            uid = path.split("/")[3]
            assert body == {"returnCode": {}}, body
            self.codes[uid] = f"CODE{uid}"
            return httpx.Response(200, json={"inviteCode": self.codes[uid]})
        if path.endswith("/password"):
            return httpx.Response(200, json={})
        if "/metadata/" in path:
            return httpx.Response(200, json={})
        return httpx.Response(404, json={"message": f"unexpected {req.method} {path}"})


class FakeMattermost:
    """Team lookup, user-by-email and team membership."""

    def __init__(self, users=None, members=None):
        self.users = users or {}            # email -> {"id", "username"}
        self.members = set(members or ())
        self.calls: list[tuple[str, str, dict, dict]] = []

    def handler(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        body = json.loads(req.content) if req.content else {}
        self.calls.append((req.method, path, body, dict(req.url.params)))
        if path == "/api/v4/teams/name/crcmz":
            return httpx.Response(200, json={"id": "T1", "invite_id": "INV"})
        if path.startswith("/api/v4/users/email/"):
            u = self.users.get(path.rsplit("/", 1)[1])
            return httpx.Response(200, json=u) if u else httpx.Response(404, json={})
        if path.startswith("/api/v4/teams/T1/members/"):
            return httpx.Response(200 if path.rsplit("/", 1)[1] in self.members else 404, json={})
        if path == "/api/v4/teams/T1/members":
            self.members.add(body["user_id"])
            return httpx.Response(201, json={})
        return httpx.Response(404, json={"message": f"unexpected {req.method} {path}"})


class Both:
    """Routes by host, so one MockTransport serves Zitadel and Mattermost."""

    def __init__(self, z, m):
        self.z, self.m = z, m

    def handler(self, req):
        return (self.m if req.url.host == "mm.test" else self.z).handler(req)


_REAL_CLIENT = httpx.Client


class _Patched:
    """Stands in for the `httpx` name inside vip_invites only. Patching
    httpx.Client itself would also break fastapi's TestClient, which subclasses it."""

    HTTPError = httpx.HTTPError
    Response = httpx.Response

    def __init__(self, fake):
        self.fake = fake

    def Client(self, *a, **kw):  # noqa: N802
        kw["transport"] = httpx.MockTransport(self.fake.handler)
        return _REAL_CLIENT(*a, **kw)


def install(fake: FakeZitadel):
    vip_invites.httpx = _Patched(fake)  # type: ignore[assignment]
    sent: list[dict] = []
    vip_invites.send_email = lambda to, subject, h, t: sent.append(
        {"to": to, "subject": subject, "html": h, "text": t})
    vip_invites.ZITADEL_SERVICE_TOKEN = "svc-token"
    vip_invites.MATTERMOST_URL = "https://mm.test" if isinstance(fake, Both) else ""
    vip_invites.MATTERMOST_TOKEN = "bot-token"
    vip_invites.MATTERMOST_TEAM_NAME = "crcmz"
    return sent


def fresh_db():
    vip_invites.DB_PATH = Path(tempfile.mkdtemp()) / "vip.db"
    vip_invites.init()


def flow_tests():
    print("invite flow")

    def new_member_gets_account_and_invite_link():
        fresh_db()
        fake = FakeZitadel()
        sent = install(fake)
        out = vip_invites.invite_vip("Fan@Example.com", gamer_tag="Baby bottle pop",
                                     platform="Playstation", source="stripe", stripe_session_id="cs_1")
        assert out["kind"] == "invite" and out["created"], out
        create = [c for c in fake.calls if c[1] == "/v2/users/human"][0][2]
        assert create["email"] == {"email": "fan@example.com", "isVerified": True}
        assert create["profile"]["displayName"] == "Baby bottle pop"
        assert len(sent) == 1 and sent[0]["to"] == "fan@example.com"
        link = f"https://app.crcmz.me/invite?userId={out['zitadel_id']}&code=CODE{out['zitadel_id']}"
        assert link in sent[0]["text"], sent[0]["text"]
        assert "Baby bottle pop" in sent[0]["html"]
        assert any("/metadata/vip" in c[1] for c in fake.calls), "vip tag not written"

    def stripe_retry_sends_once():
        fresh_db()
        sent = install(FakeZitadel())
        vip_invites.invite_vip("a@b.co", stripe_session_id="cs_dup")
        again = vip_invites.invite_vip("a@b.co", stripe_session_id="cs_dup")
        assert again.get("duplicate") and len(sent) == 1, (again, sent)

    def existing_account_gets_welcome_and_no_code():
        fresh_db()
        fake = FakeZitadel(users={"old@b.co": "77"},
                           auth_methods={"77": ["AUTHENTICATION_METHOD_TYPE_PASSWORD"]})
        sent = install(fake)
        out = vip_invites.invite_vip("old@b.co")
        assert out["kind"] == "welcome", out
        assert not any(c[1].endswith("/invite_code") for c in fake.calls)
        assert not any(c[1] == "/v2/users/human" for c in fake.calls)
        assert "/invite?" not in sent[0]["text"]

    def existing_account_without_password_gets_invite():
        fresh_db()
        sent = install(FakeZitadel(users={"half@b.co": "88"}))
        out = vip_invites.invite_vip("half@b.co")
        assert out["kind"] == "invite" and not out["created"], out
        assert "code=CODE88" in sent[0]["text"]

    def bad_email_rejected():
        fresh_db()
        install(FakeZitadel())
        try:
            vip_invites.invite_vip("not-an-email")
        except vip_invites.InviteError:
            return
        raise AssertionError("accepted a bad email")

    def smtp_failure_is_logged_and_retryable():
        fresh_db()
        install(FakeZitadel())

        def boom(*a):
            raise OSError("smtp down")
        vip_invites.send_email = boom
        try:
            vip_invites.invite_vip("x@b.co", stripe_session_id="cs_fail")
        except vip_invites.InviteError:
            pass
        else:
            raise AssertionError("no error")
        assert vip_invites.recent()[0]["status"] == "failed"
        sent = install(FakeZitadel())
        assert not vip_invites.invite_vip("x@b.co", stripe_session_id="cs_fail").get("duplicate")
        assert len(sent) == 1

    def accept_checks_password_before_spending_code():
        fresh_db()
        fake = FakeZitadel()
        install(fake)
        out = vip_invites.invite_vip("n@b.co")
        uid = out["zitadel_id"]
        try:
            vip_invites.accept(uid, f"CODE{uid}", "weak")
        except vip_invites.InviteError:
            pass
        assert not any(c[1].endswith("/verify") for c in fake.calls), "spent the code on a weak password"
        vip_invites.accept(uid, f"CODE{uid}", "Str0ng!pass")
        assert vip_invites.recent()[0]["status"] == "accepted"

    def accept_wrong_code():
        fresh_db()
        install(FakeZitadel())
        try:
            vip_invites.accept("1000", "nope", "Str0ng!pass")
        except vip_invites.InviteError as e:
            assert "expired" in str(e)
            return
        raise AssertionError("wrong code accepted")

    def vip_without_mattermost_gets_join_link():
        fresh_db()
        z, m = FakeZitadel(), FakeMattermost()
        sent = install(Both(z, m))
        out = vip_invites.invite_vip("fan@example.com", gamer_tag="Baby bottle pop")
        assert out["mm_username"] == "", out
        # SSO accounts only: the app must never make a password account.
        assert not any(c[0] == "POST" and c[1] == "/api/v4/users" for c in m.calls)
        assert "https://mm.test/signup_user_complete/?id=INV" in sent[0]["text"], sent[0]["text"]
        assert "signup_user_complete/?id=INV" in sent[0]["html"] and "Zitadel" in sent[0]["html"]

    def existing_mattermost_user_linked_and_named():
        fresh_db()
        z, m = FakeZitadel(), FakeMattermost(users={"old@y.co": {"id": "o1", "username": "oldie"}})
        sent = install(Both(z, m))
        out = vip_invites.invite_vip("Old@y.co")
        assert out["mm_username"] == "oldie", out
        assert "o1" in m.members, "not added to the team"
        assert any(c[1].endswith("/metadata/mm_username") for c in z.calls), "no mm_username tag"
        assert "@oldie" in sent[0]["html"] and "signup_user_complete" not in sent[0]["text"]
        assert vip_invites.recent()[0]["mm_username"] == "oldie"

    def sweep_links_after_first_sso_login():
        fresh_db()
        z, m = FakeZitadel(), FakeMattermost()
        install(Both(z, m))
        out = vip_invites.invite_vip("new@y.co")
        assert vip_invites.link_pending_mattermost() == 0
        m.users["new@y.co"] = {"id": "n1", "username": "newbie"}   # they signed in via SSO
        assert vip_invites.link_pending_mattermost() == 1
        assert vip_invites.recent()[0]["mm_username"] == "newbie"
        assert "n1" in m.members
        assert vip_invites.link_pending_mattermost() == 0, "linked twice"
        assert vip_invites.known_mm_username(out["zitadel_id"], "new@y.co") == "newbie"

    def mattermost_failure_still_sends_app_invite():
        fresh_db()

        class Down(FakeMattermost):
            def handler(self, req):
                return httpx.Response(500, json={})
        sent = install(Both(FakeZitadel(), Down()))
        out = vip_invites.invite_vip("n@b.co")
        assert out["kind"] == "invite" and out["mm_username"] == "" and len(sent) == 1

    for fn in (vip_without_mattermost_gets_join_link, existing_mattermost_user_linked_and_named,
               sweep_links_after_first_sso_login, mattermost_failure_still_sends_app_invite,
               new_member_gets_account_and_invite_link, stripe_retry_sends_once,
               existing_account_gets_welcome_and_no_code, existing_account_without_password_gets_invite,
               bad_email_rejected, smtp_failure_is_logged_and_retryable,
               accept_checks_password_before_spending_code, accept_wrong_code):
        check(fn.__name__, fn)


def http_tests():
    from fastapi.testclient import TestClient
    import server

    print("routes")
    server.VIP_INVITE_SECRET = "vip-secret-for-tests"
    calls = []
    server._vip.invite_vip = lambda email, **kw: (calls.append((email, kw)) or
                                                  {"ok": True, "kind": "invite", "zitadel_id": "1"})
    client = TestClient(server.app, base_url="https://app.crcmz.me")

    def invite_api_needs_a_credential():
        r = client.post("/api/invites/vip", json={"email": "a@b.co"})
        assert r.status_code == 401, r.status_code
        r = client.post("/api/invites/vip", json={"email": "a@b.co"},
                        headers={"X-Invite-Secret": "wrong"})
        assert r.status_code == 401, r.status_code
        assert not calls

    def invite_api_with_secret():
        r = client.post("/api/invites/vip", headers={"X-Invite-Secret": "vip-secret-for-tests"},
                        json={"email": "a@b.co", "gamerTag": "GT", "stripeSessionId": "cs_9",
                              "source": "stripe"})
        assert r.status_code == 200, r.text
        email, kw = calls[-1]
        assert email == "a@b.co" and kw["gamer_tag"] == "GT" and kw["stripe_session_id"] == "cs_9"

    def invite_page_is_public():
        r = client.get("/invite?userId=123&code=ABC", headers={"accept": "text/html"})
        assert r.status_code == 200 and 'value="ABC"' in r.text, r.status_code
        assert r.headers.get("referrer-policy") == "no-referrer"

    def invite_page_escapes_code():
        r = client.get('/invite?userId=123&code="><script>x</script>')
        assert "<script>x</script>" not in r.text

    def mismatched_passwords():
        r = client.post("/invite", data={"userId": "123", "code": "ABC", "pw": "Str0ng!pass",
                                         "pw2": "other"})
        assert r.status_code == 400 and "match" in r.text

    def logo_is_public():
        r = client.get("/footer-avatar.png")
        assert r.status_code == 200, r.status_code

    def portal_skips_picker_when_name_known():
        server._vip.known_mm_username = lambda sub, email: "babybottlepop" if sub == "393" else ""
        server.portal_mod.find_by_zitadel_id = lambda sub: None
        cookie = server._signer().dumps(server._make_session("393", "f@b.co"))
        r = client.get("/portal", cookies={server._SESSION_COOKIE: cookie})
        assert r.status_code == 200, r.status_code
        assert 'name="mm_username" value="babybottlepop"' in r.text and "Select your name" not in r.text

    def portal_link_uses_known_name_over_form():
        seen = {}

        def link(npsso, mm_username="", zitadel_user_id=""):
            seen.update(mm=mm_username, sub=zitadel_user_id)
            return {"online_id": "PSN1"}
        server.portal_mod.link_user = link
        cookie = server._signer().dumps(server._make_session("393", "f@b.co"))
        r = client.post("/portal/link", data={"npsso": "tok", "mm_username": "someone_else"},
                        cookies={server._SESSION_COOKIE: cookie})
        assert r.status_code == 200 and seen == {"mm": "babybottlepop", "sub": "393"}, (r.status_code, seen)

    for fn in (portal_skips_picker_when_name_known, portal_link_uses_known_name_over_form,
               invite_api_needs_a_credential, invite_api_with_secret, invite_page_is_public,
               invite_page_escapes_code, mismatched_passwords, logo_is_public):
        check(fn.__name__, fn)


if __name__ == "__main__":
    flow_tests()
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
