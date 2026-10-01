#!/usr/bin/env python3
"""The notification centre (notifications.py), Slap @mentions and their routes.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_notifications

Nothing leaves the box: webpush._send_one, the WhatsApp sender and the Mattermost
sender are fakes in every test, and slaptastic writes are stubbed.
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-notify-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crcmz_identity  # noqa: E402
import notifications  # noqa: E402
import webpush  # noqa: E402

TMP = Path(tempfile.mkdtemp())
webpush._DB_PATH = TMP / "push.db"
webpush._KEY_PATH = TMP / "vapid_private.pem"
notifications._DB_PATH = TMP / "notifications.db"
webpush.init()
notifications.init()

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


PEOPLE = [
    {"zitadel_id": "u-moiz", "display_name": "Moiz Qureshi", "username": "moiz", "state": "USER_STATE_ACTIVE",
     "mm_username": "moiz", "wa_jid": "", "wa_phone": "+1 (555) 010-0001", "jellyfin_user": "Moiz", "email": "m@x.co"},
    {"zitadel_id": "u-noor", "display_name": "Noor Amin", "username": "nooramin40", "state": "USER_STATE_ACTIVE",
     "mm_username": "", "wa_jid": "15550100002@s.whatsapp.net", "wa_phone": "", "jellyfin_user": "", "email": ""},
    {"zitadel_id": "u-zub", "display_name": "Zubair", "username": "zubair221b", "state": "USER_STATE_ACTIVE",
     "mm_username": "zubair", "wa_jid": "abc@lid", "wa_phone": "", "jellyfin_user": "zubair221b", "email": ""},
    {"zitadel_id": "u-zed", "display_name": "Zubair Two", "username": "zed", "state": "USER_STATE_ACTIVE",
     "mm_username": "", "wa_jid": "", "wa_phone": "", "jellyfin_user": "", "email": ""},
    # The real chart: Zitadel login, a wrong mm tag, Jellyfin/PSN/WhatsApp names all differ.
    {"zitadel_id": "u-moose", "display_name": "themoosecompany thegoopcompany", "username": "themoosecompany",
     "state": "USER_STATE_ACTIVE", "mm_username": "themoosecompany", "wa_jid": "", "wa_phone": "",
     "jellyfin_user": "mutasif", "psn_id": "mutasif", "wa_names": ["Mutasif"], "email": "goop@example.com"},
    # crcmz_identity hands wa_names over as a list; the raw tag is a string.
    {"zitadel_id": "u-sam", "display_name": "asamad89 asamad89", "username": "asamad89", "state": "USER_STATE_ACTIVE",
     "mm_username": "asamad89", "wa_jid": "", "wa_phone": "", "jellyfin_user": "Samad", "email": "",
     "tags": {"wa_names": "Abdul Samad,AbdulSamad Bawany"}},
    {"zitadel_id": "u-gone", "display_name": "Old Account", "username": "old", "state": "USER_STATE_INACTIVE",
     "mm_username": "old", "wa_jid": "", "wa_phone": "", "jellyfin_user": "", "email": ""},
]
crcmz_identity.people = lambda refresh=False: list(PEOPLE)
crcmz_identity.by_zitadel_id = lambda refresh=False: {p["zitadel_id"]: p for p in PEOPLE}
crcmz_identity.resolve = lambda needle, refresh=False: next(
    (p for p in PEOPLE if needle.casefold() in (p["username"].casefold(), p["display_name"].casefold(), p["zitadel_id"])), None)

WA: list[tuple[str, str]] = []
MM: list[tuple[str, str]] = []
PUSHED: list[str] = []
notifications.wa_send = lambda jid, text: WA.append((jid, text)) or True
notifications.mm_dm = lambda user, text, email="": MM.append((user, text)) or True
webpush._send_one = lambda row, payload, **kw: PUSHED.append(row["sub"]) or 201


def reset():
    with notifications._conn() as db:
        db.executescript("DELETE FROM items; DELETE FROM reads; DELETE FROM cursors; DELETE FROM channels;")
    with webpush._conn() as db:
        db.executescript("DELETE FROM subscriptions; DELETE FROM prefs; DELETE FROM sent;")
    notifications._dm_quiet = webpush.Debounce(90)
    WA.clear(); MM.clear(); PUSHED.clear()


def device(sub: str, n: int):
    webpush.subscribe(sub, {"endpoint": f"https://fcm.googleapis.com/fcm/send/{sub}-{n}",
                            "keys": {"p256dh": "B" + "x" * 86, "auth": "a" * 22}})


# ── The store ────────────────────────────────────────────────────────────────
def store_tests():
    print("inbox")

    def a_broadcast_reaches_everyone_but_whoever_caused_it():
        reset()
        notifications.record("squad", "Moiz: Squad Up", "Get on", "/app/squad", exclude="u-moiz")
        assert [i["title"] for i in notifications.inbox("u-noor")["items"]] == ["Moiz: Squad Up"]
        assert notifications.inbox("u-moiz")["items"] == []
        assert notifications.unread_count("u-noor") == 1 and notifications.unread_count("brand-new") == 1

    def a_personal_alert_reaches_only_its_people():
        reset()
        notifications.record("mentions", "Moiz mentioned you", only=["u-noor", "u-moiz"], exclude="u-moiz")
        box = notifications.inbox("u-noor")
        assert len(box["items"]) == 1 and box["items"][0]["personal"] is True and box["items"][0]["source"] == "slap"
        assert notifications.inbox("u-zub")["items"] == [] and notifications.inbox("u-moiz")["items"] == []

    def reading_one_and_reading_all():
        reset()
        a, = notifications.record("watch", "one")
        notifications.record("huddle", "two")
        notifications.record("mentions", "for zub", only=["u-zub"])
        assert notifications.mark_read("u-noor", [a]) == 1
        items = {i["title"]: i["read"] for i in notifications.inbox("u-noor")["items"]}
        assert items == {"one": True, "two": False}, items
        assert notifications.mark_read("u-noor", None) == 0
        notifications.record("clips", "three")
        assert notifications.unread_count("u-noor") == 1, "a new alert after Mark all read is unread"
        assert notifications.unread_count("u-zub") == 4, "Noor reading does not read Zubair's"

    def you_cannot_mark_someone_elses_alert():
        reset()
        mine, = notifications.record("mentions", "for zub", only=["u-zub"])
        notifications.mark_read("u-noor", [mine, "x", True, 10**9])
        with notifications._conn() as db:
            assert db.execute("SELECT COUNT(*) FROM reads").fetchone()[0] == 0
        assert notifications.unread_count("u-zub") == 1

    def urls_stay_inside_the_app_and_categories_are_known():
        reset()
        for bad in ("https://evil.example", "//evil.example/app", "/app//evil", "javascript:alert(1)"):
            notifications.record("squad", "x", url=bad)
        assert {i["url"] for i in notifications.inbox("u-noor")["items"]} == {"/app"}
        try:
            notifications.record("nope", "x")
        except ValueError:
            pass
        else:
            raise AssertionError("unknown category accepted")

    def paging_and_source_filter():
        reset()
        for n in range(5):
            notifications.record("squad" if n % 2 else "clips", f"n{n}")
        page = notifications.inbox("u-noor", limit=2)
        assert [i["title"] for i in page["items"]] == ["n4", "n3"] and page["more"] is True
        nxt = notifications.inbox("u-noor", limit=2, before=page["items"][-1]["id"])
        assert [i["title"] for i in nxt["items"]] == ["n2", "n1"]
        assert [i["title"] for i in notifications.inbox("u-noor", source="squad")["items"]] == ["n3", "n1"]

    def old_alerts_are_pruned():
        reset()
        notifications.record("squad", "ancient")
        with notifications._conn() as db:
            db.execute("UPDATE items SET ts = ts - ?", (notifications.KEEP_DAYS * 86400 + 60,))
        notifications.record("squad", "fresh")
        assert [i["title"] for i in notifications.inbox("u-noor")["items"]] == ["fresh"]

    for fn in (a_broadcast_reaches_everyone_but_whoever_caused_it, a_personal_alert_reaches_only_its_people,
               reading_one_and_reading_all, you_cannot_mark_someone_elses_alert,
               urls_stay_inside_the_app_and_categories_are_known, paging_and_source_filter, old_alerts_are_pruned):
        check(fn.__name__, fn)


# ── Routing ──────────────────────────────────────────────────────────────────
def route_tests():
    print("routing")

    def a_mention_goes_to_inbox_push_whatsapp_and_mattermost():
        reset()
        device("u-moiz", 1); device("u-noor", 1); device("u-zub", 1)
        out = notifications.route("mentions", "Zubair mentioned you on Slap", "“@moiz banger”", "/app/slap?track=" + "a" * 32,
                                  exclude="u-zub", only=["u-moiz"], tag="slap-x", dm_text="🎵 Zubair mentioned you")
        assert out["inbox"] == 1 and out["push"]["delivered"] == 1 and PUSHED == ["u-moiz"], (out, PUSHED)
        assert WA == [("15550100001@s.whatsapp.net", "🎵 Zubair mentioned you\nhttps://app.crcmz.me/app/slap?track=" + "a" * 32)], WA
        assert MM and MM[0][0] == "moiz" and "app.crcmz.me/app/slap" in MM[0][1]

    def mattermost_gets_the_email_to_fall_back_on():
        reset()
        calls = []
        old = notifications.mm_dm
        notifications.mm_dm = lambda user, text, email="": calls.append((user, email)) or True
        try:
            notifications.route("mentions", "x", only=["u-moose"], exclude="u-zub")
        finally:
            notifications.mm_dm = old
        assert calls == [("themoosecompany", "goop@example.com")], calls

    def a_broadcast_never_dms():
        reset()
        device("u-noor", 1)
        notifications.route("squad", "Moiz: Squad Up", "on", "/app/squad", exclude="u-moiz")
        notifications.route("watch", "Party", only=["u-noor"])
        assert WA == [] and MM == [] and PUSHED == ["u-noor", "u-noor"]

    def switched_off_channels_are_respected():
        reset()
        notifications.save_channels("u-moiz", {"whatsapp": False, "nonsense": True})
        assert notifications.get_channels("u-moiz") == {"whatsapp": False, "mattermost": True}
        notifications.route("mentions", "x", only=["u-moiz"], exclude="u-zub")
        assert WA == [] and [u for u, _ in MM] == ["moiz"]
        webpush.save_prefs("u-noor", {"mentions": False})
        device("u-noor", 1)
        notifications.route("mentions", "y", only=["u-noor"], exclude="u-zub")
        assert PUSHED == [], "push off for mentions means no push"
        assert notifications.inbox("u-noor")["items"][0]["title"] == "y", "the inbox still has it"

    def a_burst_of_mentions_dms_once():
        reset()
        for _ in range(4):
            out = notifications.route("mentions", "x", only=["u-moiz"], exclude="u-zub", tag="slap-t1")
        assert len(WA) == 1 and len(MM) == 1 and out["dms"]["quiet"] == 1
        notifications.route("mentions", "x", only=["u-moiz"], exclude="u-zub", tag="slap-t2")
        assert len(WA) == 2, "a different track is a new thread"
        assert notifications.unread_count("u-moiz") == 5, "every one still lands in the inbox"

    def nobody_is_dmed_about_their_own_mention_or_without_a_contact():
        reset()
        notifications.route("mentions", "x", only=["u-zub", "u-zed", "u-unknown"], exclude="u-zub")
        assert WA == [] and MM == [], (WA, MM)

    def whatsapp_targets():
        assert notifications.wa_jid_for({"wa_phone": "+44 7700 900123"}) == "447700900123@s.whatsapp.net"
        assert notifications.wa_jid_for({"wa_jid": "15550100002:12@s.whatsapp.net"}) == "15550100002@s.whatsapp.net"
        assert notifications.wa_jid_for({"wa_jid": "1203630000@g.us"}) == "", "never a group"
        assert notifications.wa_jid_for({"wa_jid": "abc@lid"}) == ""
        assert notifications.wa_jid_for({}) == ""

    def a_failing_sender_does_not_stop_the_rest():
        reset()
        def boom(*a):
            raise RuntimeError("bridge down")
        old = notifications.wa_send
        notifications.wa_send = boom
        try:
            out = notifications.route("mentions", "x", only=["u-moiz"], exclude="u-zub")
        finally:
            notifications.wa_send = old
        assert out["dms"]["whatsapp"] == 0 and len(MM) == 1

    def a_test_dm_ignores_the_quiet_window_and_reports_each_channel():
        reset()
        notifications.route("mentions", "x", only=["u-moiz"], exclude="u-zub", tag="t")
        out = notifications.test_dm("u-moiz")
        assert out == {"whatsapp": True, "mattermost": True} and len(WA) == 2 and len(MM) == 2, (out, WA, MM)
        assert notifications.test_dm("u-zed") == {"whatsapp": None, "mattermost": None}, "no contacts, nothing sent"
        notifications.save_channels("u-moiz", {"whatsapp": False})
        assert notifications.test_dm("u-moiz")["whatsapp"] is None

    def a_new_movie_reaches_inbox_push_whatsapp_and_mattermost_with_the_library_link():
        reset()
        device("u-moiz", 1); device("u-noor", 1)
        url = "/app/watch?library=downloaded"
        out = notifications.route("movies", "Zubair added Dune", "downloading", url, only=["u-moiz", "u-noor"],
                                  exclude="u-zub", tag="movie-added-tt1", dm_text="🎬 Zubair added Dune")
        assert out["inbox"] == 2 and sorted(PUSHED) == ["u-moiz", "u-noor"], (out, PUSHED)
        assert [t for _, t in WA] == ["🎬 Zubair added Dune\nhttps://app.crcmz.me" + url] * 2, WA
        assert [u for u, _ in MM] == ["moiz"] and MM[0][1].endswith(url)
        item = notifications.inbox("u-noor")["items"][0]
        assert item["source"] == "watch" and item["url"] == url and item["personal"]

    def added_then_ready_both_dm_but_a_repeat_does_not():
        reset()
        notifications.route("movies", "Zubair added Dune", only=["u-moiz"], exclude="u-zub", tag="movie-added-tt1")
        notifications.route("movies", "Dune is ready", only=["u-moiz", "u-zub"], tag="movie-ready-tt1")
        assert len(WA) == 2 and len(MM) == 3, (WA, MM)    # Zubair has Mattermost but no WhatsApp it can reach
        out = notifications.route("movies", "Dune is ready", only=["u-moiz"], tag="movie-ready-tt1")
        assert out["dms"]["quiet"] == 1 and len(WA) == 2

    def switching_movies_off_stops_push_and_dms_but_not_the_inbox():
        reset()
        device("u-moiz", 1)
        webpush.save_prefs("u-moiz", {"movies": False})
        out = notifications.route("movies", "Dune is ready", only=["u-moiz"], tag="movie-ready-tt1")
        assert PUSHED == [] and WA == [] and MM == [] and out["dms"]["off"] == 1, (out, WA, MM)
        assert notifications.inbox("u-moiz")["items"][0]["title"] == "Dune is ready"
        webpush.save_prefs("u-moiz", {"movies": True, "mentions": False})
        notifications.route("mentions", "x", only=["u-moiz"], exclude="u-zub")
        assert len(WA) == 1, "a mention's DMs only follow the channel switches"

    def movies_is_a_category_people_can_switch():
        assert notifications.SOURCES["movies"] == "watch" and "movies" in notifications.DIRECT
        assert "movies" in webpush.CATEGORIES and webpush.get_prefs("brand-new")["movies"] is True

    for fn in (a_test_dm_ignores_the_quiet_window_and_reports_each_channel, a_mention_goes_to_inbox_push_whatsapp_and_mattermost, mattermost_gets_the_email_to_fall_back_on, a_broadcast_never_dms,
               switched_off_channels_are_respected, a_burst_of_mentions_dms_once,
               nobody_is_dmed_about_their_own_mention_or_without_a_contact, whatsapp_targets,
               a_failing_sender_does_not_stop_the_rest,
               a_new_movie_reaches_inbox_push_whatsapp_and_mattermost_with_the_library_link,
               added_then_ready_both_dm_but_a_repeat_does_not,
               switching_movies_off_stops_push_and_dms_but_not_the_inbox, movies_is_a_category_people_can_switch):
        check(fn.__name__, fn)


# ── Slap @mentions ───────────────────────────────────────────────────────────
def mention_tests():
    import slap
    print("slap mentions")

    def handles_resolve_by_any_name_people_know():
        got = slap.mentioned("@Moiz @nooramin40 and @zubair221b, also @noor.", PEOPLE)
        assert [p["zitadel_id"] for p in got] == ["u-moiz", "u-noor", "u-zub"], got
        assert [p["zitadel_id"] for p in slap.mentioned("@MoizQureshi @moiz again", PEOPLE)] == ["u-moiz"]

    def ambiguous_first_names_unknown_and_emails_are_not_mentions():
        assert slap.mentioned("@zubair", PEOPLE)[0]["zitadel_id"] == "u-zub", "mm_username wins over a shared first name"
        assert slap.mentioned("mail me@moiz or @nobody or @@moiz", PEOPLE) == []
        assert slap.mentioned("@old", PEOPLE) == [], "inactive accounts are not taggable"

    def every_name_in_the_identity_chart_tags_them():
        for word in ("mutasif", "themoosecompany", "Mutasif", "moose", "goop"):
            got = slap.mentioned(f"yo @{word} listen", PEOPLE)
            assert [p["zitadel_id"] for p in got] == ["u-moose"], (word, got)
        # A fragment two people share is nobody, not a guess.
        assert [p["zitadel_id"] for p in slap.mentioned("@abdulsamad @Bawany", PEOPLE)] == ["u-sam"]
        assert slap.mentioned("@ubai", PEOPLE) == []
        assert slap.mentioned("@mo", PEOPLE) == [], "too short to guess from"

    def the_composer_list_has_handles_names_and_public_akas():
        people = slap.mentionable(PEOPLE)
        moiz = next(p for p in people if p["handle"] == "Moiz")
        assert moiz["name"] == "Moiz Qureshi"
        assert all(set(p) == {"handle", "name", "aka"} for p in people)
        moose = next(p for p in people if p["handle"] == "mutasif")
        assert "themoosecompany" in moose["aka"]
        assert not any("goop@" in a or a == "goop" for p in people for a in p["aka"]), "no email in the list"
        invited = {"zitadel_id": "u-inv", "username": "ray@example.com", "display_name": "Mazino", "state": "USER_STATE_ACTIVE",
                   "mm_username": "mazino", "tags": {"chosen_username": "mazino"}}
        assert slap.handle_of(invited) == "mazino" and "example" not in str(slap.mentionable([invited]))
        assert "old" not in {p["handle"] for p in people}
        handles = {p["handle"] for p in people}
        assert all(slap.mentioned(f"@{h}", PEOPLE) for h in handles), "every suggested handle resolves"

    for fn in (handles_resolve_by_any_name_people_know, ambiguous_first_names_unknown_and_emails_are_not_mentions,
               every_name_in_the_identity_chart_tags_them, the_composer_list_has_handles_names_and_public_akas):
        check(fn.__name__, fn)


# ── HTTP ─────────────────────────────────────────────────────────────────────
def http_tests():
    from fastapi.testclient import TestClient
    import server
    import assistant
    import slap

    print("routes")
    notifications._DB_PATH = TMP / "notifications.db"  # server's import ran init() on /data
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    cookie = {server._SESSION_COOKIE: server._signer().dumps(server._make_session("u-zub", "z@b.co"))}
    origin = {"Origin": "https://app.crcmz.me"}

    def the_inbox_needs_a_session():
        for path in ("/api/notifications", "/api/notifications/unread", "/api/notifications/channels"):
            assert client.get(path).status_code == 401, path
        assert client.post("/api/notifications/read", json={"all": True}, headers=origin).status_code == 401

    def inbox_read_and_unread():
        reset()
        notifications.record("squad", "rally")
        notifications.record("mentions", "you", only=["u-zub"])
        r = client.get("/api/notifications", cookies=cookie)
        assert r.status_code == 200 and r.json()["unread"] == 2 and r.headers["cache-control"] == "no-store"
        first = r.json()["items"][0]
        assert client.post("/api/notifications/read", json={"ids": [first["id"]]}, cookies=cookie,
                           headers={"Origin": "https://evil.example"}).status_code == 403
        assert client.post("/api/notifications/read", json={"nope": 1}, cookies=cookie, headers=origin).status_code == 400
        r = client.post("/api/notifications/read", json={"ids": [first["id"]]}, cookies=cookie, headers=origin)
        assert r.json()["unread"] == 1
        r = client.post("/api/notifications/read", json={"all": True}, cookies=cookie, headers=origin)
        assert r.json()["unread"] == 0 and client.get("/api/notifications/unread", cookies=cookie).json()["unread"] == 0

    def channels_show_what_can_reach_you():
        reset()
        r = client.get("/api/notifications/channels", cookies=cookie).json()
        assert r["prefs"] == {"whatsapp": True, "mattermost": True}
        assert r["reachable"]["whatsapp"] is False, "an @lid alone cannot be DMed"
        r = client.post("/api/notifications/channels", json={"mattermost": False}, cookies=cookie, headers=origin)
        assert r.json()["prefs"] == {"whatsapp": True, "mattermost": False}
        assert "mentions" in {c["id"] for c in client.get("/api/push/config", cookies=cookie).json()["categories"]}

    def a_slap_comment_routes_its_mentions():
        reset()
        routed, written = [], []

        async def fake_write(method, path, body):
            written.append(body)
            return {"id": "c1", "text": body["text"]}

        async def fake_jf(sub, person):
            return {"id": "f" * 32, "name": "zubair221b"}, False

        old = (slap._social_write, slap.resolve_jellyfin, notifications.route_in_background)
        slap._social_write, slap.resolve_jellyfin = fake_write, fake_jf
        notifications.route_in_background = lambda *a, **k: routed.append((a, k))
        try:
            t = {"track_id": "a" * 32, "title": "Hotline Bling", "artist": "Drake"}
            r = client.post("/api/slap/comment", json={**t, "text": "@moiz @noor @zubair221b tune"}, cookies=cookie, headers=origin)
            assert r.status_code == 200, r.text
            assert r.json()["mentioned"] == ["Moiz Qureshi", "Noor Amin"], r.json()
            (cat, title, body, url), kw = routed[0]
            assert cat == "mentions" and kw["only"] == ["u-moiz", "u-noor"] and kw["exclude"] == "u-zub"
            assert url == "/app/slap?track=" + "a" * 32 and "Hotline Bling" in body and "Drake" in kw["dm_text"]
            assert written[0]["username"] == "zubair221b", "still stamped with the caller"
            client.post("/api/slap/comment", json={**t, "text": "🔥", "is_reaction": True}, cookies=cookie, headers=origin)
            client.post("/api/slap/comment", json={**t, "text": "no tags here"}, cookies=cookie, headers=origin)
            assert len(routed) == 1, "reactions and untagged comments notify nobody"
            people = client.get("/api/slap/mentionable", cookies=cookie).json()["people"]
            assert any(p["handle"] == "Moiz" and p["name"] == "Moiz Qureshi" for p in people), people
            assert "m@x.co" not in str(people), "no emails in the composer list"
            assert client.get("/api/slap/mentionable").status_code == 401
        finally:
            slap._social_write, slap.resolve_jellyfin, notifications.route_in_background = old

    def assistant_tool_is_registered_and_reveals_no_contacts():
        reset()
        notifications.record("mentions", "Moiz mentioned you", only=["u-noor"])
        assert "notification_inbox" in assistant.tool_names()
        out, ok = assistant.call_tool("notification_inbox", {"limit": 5000})
        assert ok and "Noor Amin" in out, out
        out, ok = assistant.call_tool("notification_inbox", {"person": "nooramin40"})
        assert ok and "Moiz mentioned you" in out and '"unread": 1' in out, out
        for leak in ("15550100002", "s.whatsapp.net", "u-noor", "m@x.co"):
            assert leak not in out, leak
        assert notifications.unread_count("u-noor") == 1, "looking does not mark read"

    for fn in (the_inbox_needs_a_session, inbox_read_and_unread, channels_show_what_can_reach_you,
               a_slap_comment_routes_its_mentions, assistant_tool_is_registered_and_reveals_no_contacts):
        check(fn.__name__, fn)


if __name__ == "__main__":
    store_tests()
    route_tests()
    mention_tests()
    http_tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
