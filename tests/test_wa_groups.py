#!/usr/bin/env python3
"""WhatsApp groups: CRCMZ BOYZ for everyone, Professional Goopers for founders.

The bot (clips, coaching, reactions, the AI) lives in CRCMZ BOYZ. Stats are kept
per group; Goopers stats are founders-only on every surface: the HTTP API, the
assistant tools (Ask AI), MCP, memory search -- and the bot answering in a group
must never reveal Goopers data, even when a founder is the one asking.

Plain asserts, no pytest -- run inside the app image:

    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" crcmz-app:test python tests/test_wa_groups.py
"""

import asyncio
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MAIN = "120363334247249772@g.us"   # CRCMZ BOYZ
GOOP = "120363406504549565@g.us"   # Professional Goopers

os.environ.setdefault("SESSION_SECRET", "test-secret-for-wa-groups")
os.environ.setdefault("WA_INGEST_SECRET", "test-ingest-secret")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")
os.environ["WA_MAIN_JID"] = MAIN
os.environ["WA_GOOPERS_JID"] = GOOP
os.environ.pop("WA_BRIDGE_URL", None)

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


# ── Identity: two founders-tagged people and one member ───────────────────────
import crcmz_identity  # noqa: E402

PEOPLE = {
    "zid-founder": {"zitadel_id": "zid-founder", "display_name": "Brenden",
                    "tags": {"founder": "true"}, "founder": True},
    "zid-member": {"zitadel_id": "zid-member", "display_name": "Rayyan",
                   "tags": {}, "founder": False},
    # A forged dict that *claims* founder but whose graph entry says otherwise.
    "zid-liar": {"zitadel_id": "zid-liar", "display_name": "Baby Faze",
                 "tags": {"founder": "false"}, "founder": False},
}
crcmz_identity.by_zitadel_id = lambda refresh=False: PEOPLE

import whatsapp_analytics as wa  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="wa-groups-"))
wa._DB_PATH = TMP / "wa.db"
wa.init()

BOYZ_EXPORT = ("9/12/26, 3:04 PM - Zubi: boyzword lobby up\n"
               "9/12/26, 3:06 PM - Rayyan: boyzword me\n")
GOOP_EXPORT = ("9/10/26, 1:00 PM - Brenden: goopersecret plan\n"
               "9/10/26, 1:01 PM - Noor: goopersecret yes\n"
               "9/10/26, 1:02 PM - Moiz: goopersecret go\n")


def _rows(group_jid):
    import sqlite3
    with sqlite3.connect(wa._DB_PATH) as c:
        return c.execute("SELECT COUNT(*) FROM whatsapp_messages WHERE group_jid=?",
                         (group_jid,)).fetchone()[0]


print("\nanalytics: one group per read")


def t_import_lands_in_the_chosen_group():
    r1 = wa.import_messages(BOYZ_EXPORT.encode(), "boyz.txt", MAIN, "sub-1")
    r2 = wa.import_messages(GOOP_EXPORT.encode(), "goop.txt", GOOP, "sub-1")
    assert r1["message_count"] == 2 and r1["group"] == wa.GROUP_MAIN, r1
    assert r2["message_count"] == 3 and r2["group"] == wa.GROUP_FOUNDERS, r2
    assert _rows(MAIN) == 2 and _rows(GOOP) == 3


def t_same_file_into_two_groups_is_two_imports():
    # The identical export is a separate chat when it targets another group...
    r = wa.import_messages(BOYZ_EXPORT.encode(), "boyz.txt", GOOP, "sub-1")
    assert r.get("status") != "already_imported", r
    assert r["message_count"] == 2, r
    # ...and a re-import into the same group still dedupes as before.
    r = wa.import_messages(BOYZ_EXPORT.encode(), "boyz.txt", MAIN, "sub-1")
    assert r.get("status") == "already_imported", r
    extended = BOYZ_EXPORT + "9/13/26, 9:00 AM - Samad: boyzword late\n"
    r = wa.import_messages(extended.encode(), "boyz2.txt", MAIN, "sub-1")
    assert r["message_count"] == 1 and r["duplicate_count"] == 2, r
    assert _rows(MAIN) == 3 and _rows(GOOP) == 5
    # Undo the cross import so the rest of the file has clean numbers.
    import sqlite3
    with sqlite3.connect(wa._DB_PATH) as c:
        c.execute("DELETE FROM whatsapp_messages WHERE group_jid=? AND text LIKE '%boyzword%'", (GOOP,))
    assert _rows(GOOP) == 3


def t_import_without_a_group_is_refused():
    try:
        wa.import_messages(BOYZ_EXPORT.encode(), "x.txt", "", "sub-1")
    except ValueError:
        return
    raise AssertionError("an import with no group must not land anywhere")


def t_reads_default_to_crcmz_boyz():
    assert wa.stats()["total_messages"] == 3
    assert wa.stats(group_jid=GOOP)["total_messages"] == 3
    hits = wa.search("goopersecret")
    assert hits["count"] == 0 and not hits["messages"], hits
    assert "goopersecret" in json.dumps(wa.search("goopersecret", group_jid=GOOP))
    names = {m["name"] for m in wa.members()["members"]}
    assert "Noor" not in names and "Brenden" not in names, names


def t_resolve_group_is_founder_gated():
    assert wa.resolve_group("", False) == MAIN
    assert wa.resolve_group("crcmz_boyz", False) == MAIN
    assert wa.resolve_group("professional_goopers", True) == GOOP
    try:
        wa.resolve_group("professional_goopers", False)
    except wa.GroupForbidden:
        pass
    else:
        raise AssertionError("non-founder got the Goopers group")
    try:
        wa.resolve_group(GOOP, True)   # a raw JID is not a key
    except ValueError:
        pass
    else:
        raise AssertionError("raw JID accepted as a group key")


def t_main_unset_never_falls_back_to_goopers():
    saved = os.environ.pop("WA_MAIN_JID")
    try:
        assert wa.group_jid(wa.GROUP_MAIN) == ""
        assert wa.stats()["total_messages"] == 0
        os.environ["WA_MAIN_JID"] = GOOP   # mis-set to the founders' group
        assert wa.group_jid(wa.GROUP_MAIN) == ""
        assert wa.stats()["total_messages"] == 0
    finally:
        os.environ["WA_MAIN_JID"] = saved


def t_backfill_tags_legacy_rows_as_goopers():
    import sqlite3
    with sqlite3.connect(wa._DB_PATH) as c:
        c.execute("INSERT INTO whatsapp_messages (id, group_jid, sender_name, timestamp, text, "
                  "message_type, source, created_at) VALUES ('legacy1', NULL, 'Samad', 1757000000, "
                  "'goopersecret old', 'text', 'historical_export', 0)")
    wa.init()
    with sqlite3.connect(wa._DB_PATH) as c:
        g = c.execute("SELECT group_jid FROM whatsapp_messages WHERE id='legacy1'").fetchone()[0]
        c.execute("DELETE FROM whatsapp_messages WHERE id='legacy1'")
    assert g == GOOP, g


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)
        del globals()[name]


# ── HTTP ───────────────────────────────────────────────────────────────────────
from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402

server._chat._DB_PATH = TMP / "chat.db"
server._chat.init()
assert server.WA_MAIN_JID == MAIN, "WA_MAIN_JID must drive the bot"


def _client(sub=None, host="https://app.crcmz.me"):
    c = TestClient(server.app, base_url=host)
    if sub:
        c.cookies.set(server._SESSION_COOKIE, server._signer().dumps({"sub": sub, "email": ""}))
    return c


# A no-session caller: the LAN/tailnet bypass (Stream Deck) reaches the stats with
# no identity at all, so it must get the public view.
server._peer_is_local = lambda request: True
ANON = _client(host="http://testserver")
MEMBER = _client("zid-member")
LIAR = _client("zid-liar")
FOUNDER = _client("zid-founder")
STATS_ROUTES = ["stats", "activity", "heatmap", "words", "emojis",
                "response-times", "members", "awards"]

print("\nhttp: founders-only Goopers stats")


def t_everyone_gets_crcmz_boyz_by_default():
    for c in (ANON, MEMBER, FOUNDER):
        r = c.get("/api/whatsapp/stats")
        assert r.status_code == 200, (r.status_code, r.text)
        assert r.json()["total_messages"] == 3, r.json()


def t_non_founders_are_refused_goopers_on_every_route():
    for c in (ANON, MEMBER, LIAR):
        for route in STATS_ROUTES:
            r = c.get(f"/api/whatsapp/{route}?group=professional_goopers")
            assert r.status_code == 403, (route, r.status_code)
            assert "goopersecret" not in r.text and "Noor" not in r.text


def t_founder_can_switch_groups():
    g = FOUNDER.get("/api/whatsapp/groups").json()
    assert [x["key"] for x in g["groups"]] == ["crcmz_boyz", "professional_goopers"], g
    assert GOOP not in json.dumps(g) and MAIN not in json.dumps(g), "JIDs must not leak"
    r = FOUNDER.get("/api/whatsapp/stats?group=professional_goopers")
    assert r.status_code == 200 and r.json()["total_messages"] == 3, r.text
    w = FOUNDER.get("/api/whatsapp/words?group=professional_goopers").text
    assert "goopersecret" in w, w[:200]
    w = FOUNDER.get("/api/whatsapp/words?group=crcmz_boyz").text
    assert "goopersecret" not in w and "boyzword" in w


def t_non_founders_only_see_one_group():
    for c in (ANON, MEMBER, LIAR):
        g = c.get("/api/whatsapp/groups").json()
        assert [x["key"] for x in g["groups"]] == ["crcmz_boyz"], g


def t_unknown_group_is_a_400_not_a_fallback():
    r = FOUNDER.get("/api/whatsapp/stats?group=" + GOOP)
    assert r.status_code == 400, r.status_code
    r = MEMBER.get("/api/whatsapp/stats?group=everything")
    assert r.status_code == 400, r.status_code


def t_export_is_founder_gated():
    r = MEMBER.get("/api/whatsapp/export?group=professional_goopers")
    assert r.status_code == 403, r.status_code
    r = FOUNDER.get("/api/whatsapp/export?group=professional_goopers")
    assert r.status_code in (200, 501), r.status_code


def t_import_target_group():
    async def yes(session):
        return True
    orig = server._is_whatsapp_importer
    server._is_whatsapp_importer = yes
    try:
        ci = MEMBER.get("/api/whatsapp/can-import").json()
        assert [g["key"] for g in ci["groups"]] == ["crcmz_boyz"], ci
        ci = FOUNDER.get("/api/whatsapp/can-import").json()
        assert len(ci["groups"]) == 2, ci

        f = ("x.txt", b"9/14/26, 1:00 PM - Zubi: boyzimport one\n", "text/plain")
        r = MEMBER.post("/api/whatsapp/import", files={"file": f},
                        data={"group": "professional_goopers"})
        assert r.status_code == 403, r.status_code
        r = MEMBER.post("/api/whatsapp/import", files={"file": f}, data={"group_jid": GOOP})
        assert r.status_code == 403, ("legacy group_jid must be gated too", r.status_code)
        r = MEMBER.post("/api/whatsapp/import", files={"file": f}, data={"group_jid": "x@g.us"})
        assert r.status_code == 400, r.status_code
        before = _rows(MAIN)
        r = MEMBER.post("/api/whatsapp/import", files={"file": f})
        assert r.status_code == 200 and r.json()["group"] == "crcmz_boyz", r.text
        assert _rows(MAIN) == before + 1

        g = ("y.txt", b"9/14/26, 2:00 PM - Noor: goopersecret import\n", "text/plain")
        before = _rows(GOOP)
        r = FOUNDER.post("/api/whatsapp/import", files={"file": g},
                         data={"group": "professional_goopers"})
        assert r.status_code == 200 and r.json()["group"] == "professional_goopers", r.text
        assert _rows(GOOP) == before + 1
    finally:
        server._is_whatsapp_importer = orig


HDR = {"x-ingest-secret": os.environ["WA_INGEST_SECRET"]}


def _live(mid, group, text):
    return {"message_id": mid, "sender_name": "Zubi", "sender_jid": "1@s.whatsapp.net",
            "group_jid": group, "timestamp": int(time.time()), "text": text, "type": "text"}


def t_ingest_routes_each_group():
    b, g = _rows(MAIN), _rows(GOOP)
    r = ANON.post("/api/whatsapp/ingest", headers=HDR,
                  json=[_live("L-MAIN-1", MAIN, "hello boyz"),
                        _live("L-GOOP-1", GOOP, "hello goopers")])
    assert r.status_code == 200 and r.json()["inserted"] == 2, r.text
    assert _rows(MAIN) == b + 1 and _rows(GOOP) == g + 1


def t_bot_answers_in_crcmz_boyz_only():
    asked = []
    orig = server._answer_whatsapp
    server._answer_whatsapp = lambda *a, **k: asked.append(a)
    try:
        ANON.post("/api/whatsapp/ingest", headers=HDR,
                  json=_live("L-GOOP-AI", GOOP, "ai what did we say"))
        ANON.post("/api/whatsapp/ingest", headers=HDR,
                  json=_live("L-MAIN-AI", MAIN, "ai what did we say"))
        end = time.time() + 5
        while time.time() < end and not asked:
            time.sleep(0.05)
        time.sleep(0.2)
    finally:
        server._answer_whatsapp = orig
    assert len(asked) == 1, asked
    assert asked[0][2] == MAIN, asked[0][2]


def t_engagement_paths_use_crcmz_boyz():
    src = Path(server.__file__).read_text()
    # Every send/forward/track goes through WA_MAIN_JID; Goopers is read nowhere else.
    uses = [ln for ln in src.splitlines() if "WA_GOOPERS_JID" in ln]
    assert len(uses) == 2, uses   # the definition + the WA_MAIN_JID fallback
    assert '"groupJid": WA_MAIN_JID' in src
    assert "trigger_from(msg, WA_MAIN_JID)" in src
    assert "track_clip(uid, wa_msg_id, WA_MAIN_JID)" in src
    import assistant
    assert assistant.wa_main_jid() == MAIN


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)
        del globals()[name]


# ── Assistant tools (Ask AI) ───────────────────────────────────────────────────
import assistant  # noqa: E402

WA_TOOLS = ["whatsapp_stats", "whatsapp_activity", "whatsapp_search", "whatsapp_members",
            "whatsapp_words", "whatsapp_emojis", "whatsapp_awards", "whatsapp_response_times"]

print("\nassistant tools: public view unless a founder's own Ask AI")


def _tool(name, args):
    text, ok = assistant.call_tool(name, args)
    return text, ok


def t_tools_refuse_goopers_outside_a_founder_view():
    for viewer in (None, "zid-member", "zid-liar", "zid-nobody"):
        with assistant.wa_viewer(viewer):
            for name in WA_TOOLS:
                args = {"group": "professional_goopers"}
                if name == "whatsapp_search":
                    args["query"] = "goopersecret"
                text, ok = _tool(name, args)
                assert not ok, (viewer, name, text[:200])
                assert "goopersecret" not in text and "Noor" not in text, (viewer, name)


def t_tools_default_to_crcmz_boyz():
    text, ok = _tool("whatsapp_search", {"query": "goopersecret"})
    assert ok and json.loads(text)["count"] == 0, text[:300]
    text, ok = _tool("whatsapp_stats", {})
    assert ok and json.loads(text)["group"] == "CRCMZ BOYZ", text[:200]


def t_founder_view_can_read_goopers():
    with assistant.wa_viewer("zid-founder"):
        text, ok = _tool("whatsapp_search", {"query": "goopersecret", "group": "professional_goopers"})
        assert ok and "goopersecret" in text, text[:300]
        text, ok = _tool("whatsapp_stats", {"group": "professional_goopers"})
        assert ok and json.loads(text)["group"] == "Professional Goopers", text[:200]
        text, ok = _tool("whatsapp_stats", {"group": "crcmz_boyz"})
        assert ok and json.loads(text)["group"] == "CRCMZ BOYZ"


def t_tool_schemas_narrow_outside_the_founder_view():
    def enum():
        spec = next(s for s in assistant.tool_specs() if s["function"]["name"] == "whatsapp_stats")
        return spec["function"]["parameters"]["properties"]["group"]["enum"]
    assert enum() == ["crcmz_boyz"], enum()
    with assistant.wa_viewer("zid-member"):
        assert enum() == ["crcmz_boyz"]
    with assistant.wa_viewer("zid-founder"):
        assert enum() == ["crcmz_boyz", "professional_goopers"], enum()


def t_ask_ai_tab_passes_the_viewer():
    seen = []
    orig = assistant._ask
    assistant._ask = lambda *a, **k: (seen.append(assistant.wa_founder_view())
                                      or {"answer": "ok", "tools_used": []})
    try:
        assistant.ask("hi", [], wa_viewer_sub="zid-founder")
        assistant.ask("hi", [], wa_viewer_sub="zid-member")
        assistant.ask("hi", [])
        reply_id = server._chat.start_turn("zid-founder", "hi")
        server._run_assistant_turn("zid-founder", "hi", reply_id)
        reply_id = server._chat.start_turn("zid-member", "hi")
        server._run_assistant_turn("zid-member", "hi", reply_id)
    finally:
        assistant._ask = orig
    assert seen == [True, False, False, True, False], seen


def t_group_bot_never_reveals_goopers_even_to_a_founder():
    """The WhatsApp group bot runs a real tool loop stand-in: whatever the model
    asks for, the answer posted into CRCMZ BOYZ must not carry Goopers data."""
    sent = []
    orig_ask, orig_avail, orig_send = assistant._ask, assistant.available, server.wa_ai.send_reply

    def fake_ask(question, history=None, **kw):
        parts = []
        for name, args in [("whatsapp_search", {"query": "goopersecret"}),
                           ("whatsapp_search", {"query": "goopersecret", "group": "professional_goopers"}),
                           ("whatsapp_words", {"group": "professional_goopers"}),
                           ("whatsapp_members", {}),
                           ("person_profile", {"name": "Brenden", "group": "professional_goopers"})]:
            text, ok = assistant.call_tool(name, args)
            parts.append(text)
        return {"answer": "\n".join(parts), "tools_used": []}

    assistant._ask = fake_ask
    assistant.available = lambda: True
    server.wa_ai.send_reply = lambda url, jid, text: (sent.append((jid, text)) or True)
    try:
        # Brenden is a founder; the group still only ever sees CRCMZ BOYZ.
        server._answer_whatsapp("what did the goopers say", "Brenden", MAIN,
                                sender_jid="1@s.whatsapp.net")
    finally:
        assistant._ask, assistant.available = orig_ask, orig_avail
        server.wa_ai.send_reply = orig_send
    assert sent and sent[0][0] == MAIN, sent
    body = sent[0][1]
    # Goopers message bodies and members (queries are echoed, so check content).
    for leak in ("goopersecret plan", "goopersecret yes", "goopersecret go", "Noor", "Moiz"):
        assert leak not in body, (leak, body[:400])


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)
        del globals()[name]


# ── MCP ────────────────────────────────────────────────────────────────────────
import mcp_server  # noqa: E402

print("\nmcp: only a founder's personal token opens Goopers")


def _mcp_call(caller, name, args):
    out = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                             "params": {"name": name, "arguments": args}}, caller=caller)
    res = out.get("result") or {}
    text = "".join(c.get("text", "") for c in res.get("content") or [])
    return text, bool(res.get("isError")) or "error" in out


def t_mcp_refuses_goopers_for_everyone_but_a_founder_token():
    callers = [None, {"zitadel_id": "zid-member"}, {"zitadel_id": "zid-liar"},
               {"zitadel_id": "zid-founder", "scopes": ["read"]},
               {"zitadel_id": "service:zid-founder"}]
    for caller in callers:
        for name in WA_TOOLS:
            args = {"group": "professional_goopers"}
            if name == "whatsapp_search":
                args["query"] = "goopersecret"
            text, err = _mcp_call(caller, name, args)
            assert err, (caller, name, text[:200])
            assert "goopersecret" not in text, (caller, name)


def t_mcp_founder_token_can_switch():
    text, err = _mcp_call({"zitadel_id": "zid-founder"}, "whatsapp_search",
                          {"query": "goopersecret", "group": "professional_goopers"})
    assert not err and "goopersecret" in text, text[:300]
    text, err = _mcp_call({"zitadel_id": "zid-founder"}, "whatsapp_search", {"query": "goopersecret"})
    assert not err and json.loads(text)["count"] == 0, text[:300]


def t_mcp_tools_list_matches_the_caller():
    def enum(caller):
        out = mcp_server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, caller=caller)
        t = next(t for t in out["result"]["tools"] if t["name"] == "whatsapp_stats")
        return t["inputSchema"]["properties"]["group"]["enum"]
    assert enum(None) == ["crcmz_boyz"]
    assert enum({"zitadel_id": "zid-member"}) == ["crcmz_boyz"]
    assert enum({"zitadel_id": "zid-founder"}) == ["crcmz_boyz", "professional_goopers"]


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)
        del globals()[name]


# ── Memory search ──────────────────────────────────────────────────────────────
print("\nmemory: WhatsApp items only from visible groups")

DIMS = 16


def _vec(text):
    d = hashlib.sha256(text.encode()).digest()
    return [float(d[i % len(d)]) / 255.0 for i in range(DIMS)]


class _Embed(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        texts = body.get("input", [])
        texts = [texts] if isinstance(texts, str) else texts
        out = json.dumps({"object": "list", "model": "t",
                          "data": [{"index": i, "embedding": _vec(t)} for i, t in enumerate(texts)]})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out.encode())

    def log_message(self, *a):
        pass


def _setup_memory():
    srv = HTTPServer(("127.0.0.1", 0), _Embed)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    import memory_store as ms
    ms._DB_PATH = TMP / "memory.db"
    ms._BASE = f"http://127.0.0.1:{srv.server_address[1]}"
    ms._MODEL, ms._KEY, ms._DIMS_OVERRIDE = "test-embed", "", 0
    ms._available, ms._dims, ms._model_name, ms._embed_base, ms._embed_key = False, 0, "", "", ""
    ms._start_background_indexer = lambda: None
    ms.init()
    now = int(time.time() * 1000)
    ids = {}
    for rec, text, g in [("m1", "goopersecret memory plan", GOOP),
                         ("m2", "boyzword memory lobby", MAIN)]:
        ms._upsert_item("whatsapp", rec, hashlib.sha256(text.encode()).hexdigest(), 0, text,
                        now, now, json.dumps({"group_jid": g}), _vec(text))
    import sqlite3
    with sqlite3.connect(ms._DB_PATH) as c:
        for rec, mid in c.execute("SELECT source_record_id, id FROM memory_items"):
            ids[rec] = mid
    return ms, ids


MS, MIDS = _setup_memory()


def t_memory_search_hides_goopers_from_non_founders():
    for viewer in (None, "zid-member"):
        with assistant.wa_viewer(viewer):
            text, ok = _tool("memory_search", {"query": "goopersecret memory plan", "limit": 30})
            assert ok and "goopersecret" not in text, (viewer, text[:300])
            assert "boyzword" in text, text[:300]
            text, ok = _tool("memory_search", {"query": "x", "group_id": "professional_goopers"})
            assert not ok, text[:200]
            text, ok = _tool("memory_search", {"query": "x", "group_id": GOOP})
            assert not ok, text[:200]
            text, ok = _tool("memory_get", {"memory_id": MIDS["m1"]})
            assert "goopersecret" not in text, text[:200]
            text, ok = _tool("memory_context", {"memory_id": MIDS["m1"]})
            assert "goopersecret" not in text, text[:200]


def t_memory_search_shows_goopers_to_a_founder():
    with assistant.wa_viewer("zid-founder"):
        text, ok = _tool("memory_search", {"query": "goopersecret memory plan", "limit": 30})
        assert ok and "goopersecret" in text, text[:300]
        text, ok = _tool("memory_get", {"memory_id": MIDS["m1"]})
        assert ok and "goopersecret" in text, text[:300]


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:], fn)
        del globals()[name]


print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for f in FAILED:
        print("  -", f)
    sys.exit(1)
