#!/usr/bin/env python3
"""Ask AI chat history: persistence, background answering, walking away.

Plain asserts, no pytest — run inside the app image where the deps live:

    docker build -t psn-messenger:test .
    docker run --rm -e SESSION_SECRET=test-secret \
      -v "$PWD/tests:/app/tests" psn-messenger:test python tests/test_chat_history.py
"""

import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-secret-for-chat")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAILED: list[str] = []
PASSED = 0
SEEN: list[dict] = []
REPLY = {"content": "sup bhenchod", "delay": 0.0}


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


class _Stub(BaseHTTPRequestHandler):
    """A slow model, so the background behaviour is observable."""

    def do_POST(self):  # noqa: N802
        SEEN.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        time.sleep(REPLY.get("delay", 0.0))
        payload = json.dumps({"choices": [
            {"message": {"role": "assistant", "content": REPLY["content"]}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), _Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["OLLAMA_BASE_URL"] = f"http://127.0.0.1:{srv.server_address[1]}/v1"

import chat_history as chat  # noqa: E402

chat._DB_PATH = Path(tempfile.mkdtemp(prefix="chat-test-")) / "chat.db"
chat.init()


# ── store ─────────────────────────────────────────────────────────────────────
def t_turn_starts_pending_then_finishes():
    rid = chat.start_turn("u1", "whats up")
    msgs = chat.recent("u1")
    assert [m["role"] for m in msgs] == ["user", "assistant"], msgs
    assert msgs[1]["status"] == "pending" and msgs[1]["content"] == "", msgs[1]
    assert chat.pending("u1")["id"] == rid
    chat.finish_turn(rid, "chillin", ["squad_facts"], 2500)
    msgs = chat.recent("u1")
    assert msgs[1]["status"] == "done" and msgs[1]["content"] == "chillin", msgs[1]
    assert msgs[1]["tools"] == ["squad_facts"] and msgs[1]["elapsed_ms"] == 2500, msgs[1]
    assert chat.pending("u1") is None


def t_threads_are_per_person():
    chat.finish_turn(chat.start_turn("u2", "mine only"), "yours")
    assert all("mine only" not in m["content"] for m in chat.recent("u1")), chat.recent("u1")
    assert any("mine only" in m["content"] for m in chat.recent("u2"))


def t_context_is_the_tail_and_skips_unfinished():
    chat.clear("u3")
    for i in range(6):
        chat.finish_turn(chat.start_turn("u3", f"q{i}"), f"a{i}")
    chat.start_turn("u3", "still going")           # pending, must not be replayed
    ctx = chat.context("u3", turns=4)
    assert len(ctx) == 4, ctx
    assert all(m["content"] for m in ctx), ctx
    assert ctx[-1]["content"] == "a5", ctx
    assert all(m["content"] != "still going" for m in ctx), ctx


def t_thread_is_trimmed():
    chat.clear("u4")
    saved = chat.MAX_KEPT
    chat.MAX_KEPT = 6
    try:
        for i in range(10):
            chat.finish_turn(chat.start_turn("u4", f"q{i}"), f"a{i}")
        assert chat.count("u4") == 6, chat.count("u4")
        assert chat.recent("u4")[-1]["content"] == "a9", chat.recent("u4")[-1]
    finally:
        chat.MAX_KEPT = saved


def t_clear_wipes_only_that_person():
    chat.finish_turn(chat.start_turn("u5", "hi"), "yo")
    n = chat.clear("u5")
    assert n >= 2 and chat.recent("u5") == [], n
    assert chat.recent("u2"), "cleared the wrong thread"


def t_stale_pending_is_released():
    rid = chat.start_turn("u6", "abandoned")
    with chat._conn() as db:                    # backdate it past the stale window
        db.execute("UPDATE messages SET created_at=? WHERE id=?",
                   (int(time.time()) - chat.STALE_PENDING_SEC - 5, rid))
        db.commit()
    assert chat.pending("u6") is None, "a stale pending reply should be released"
    assert chat.recent("u6")[-1]["status"] == "error", chat.recent("u6")[-1]


def t_restart_releases_pending_replies():
    chat.start_turn("u7", "mid-flight when the app died")
    chat.init()                                  # simulates a restart
    last = chat.recent("u7")[-1]
    assert last["status"] == "error", last
    assert "interrupted" in last["content"], last


def t_garbage_input_is_ignored():
    for bad in ("", "   "):
        try:
            chat.start_turn("u8", bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")
    assert chat.recent("") == []


# ── HTTP ──────────────────────────────────────────────────────────────────────
def http_tests():
    from fastapi.testclient import TestClient
    import server

    server._chat._DB_PATH = chat._DB_PATH
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    HDR = {"Origin": "https://app.crcmz.me", "Content-Type": "application/json"}

    def login(sub):
        client.cookies.clear()
        client.cookies.set(server._SESSION_COOKIE, server._signer().dumps(
            {"sub": sub, "iss": "https://auth.crcmz.he"}))

    def wait_for_answer(timeout=10.0):
        end = time.time() + timeout
        while time.time() < end:
            d = client.get("/api/assistant/history").json()
            if not d["pending"]:
                return d
            time.sleep(0.1)
        raise AssertionError("answer never landed")

    def t_history_needs_a_session():
        client.cookies.clear()
        assert client.get("/api/assistant/history",
                          headers={"Accept": "application/json"}).status_code == 401
        assert client.post("/api/assistant/clear", headers=HDR).status_code == 401

    def t_ask_returns_immediately_and_answers_in_the_background():
        login("http-1")
        REPLY["content"] = "chillin bhenchod"
        REPLY["delay"] = 0.6
        t0 = time.time()
        r = client.post("/api/assistant/ask", json={"question": "whats up"}, headers=HDR)
        queued_in = time.time() - t0
        assert r.status_code == 202, (r.status_code, r.text)
        assert r.json()["status"] == "queued" and r.json()["reply_id"], r.json()
        # The point of the change: the caller is not waiting for the model.
        assert queued_in < 0.5, f"ask blocked for {queued_in:.2f}s"
        d = client.get("/api/assistant/history").json()
        assert d["pending"] is True, d
        assert d["messages"][-1]["status"] == "pending", d["messages"][-1]
        d = wait_for_answer()
        assert d["messages"][-1]["content"] == "chillin bhenchod", d["messages"][-1]
        REPLY["delay"] = 0.0

    def t_the_answer_survives_the_client_leaving():
        # Nothing here holds a connection while the model works: the reply is
        # written to the thread and is there whenever the browser comes back.
        login("http-2")
        REPLY["content"] = "still here waiting for you"
        REPLY["delay"] = 0.8
        client.post("/api/assistant/ask", json={"question": "you there?"}, headers=HDR)
        client.cookies.clear()                      # "closed the tab"
        time.sleep(1.2)
        login("http-2")                             # "came back"
        d = client.get("/api/assistant/history").json()
        assert d["pending"] is False, d
        assert d["messages"][-1]["content"] == "still here waiting for you", d["messages"][-1]
        REPLY["delay"] = 0.0

    def t_history_is_replayed_to_the_model():
        login("http-3")
        SEEN.clear()
        client.post("/api/assistant/ask", json={"question": "first"}, headers=HDR)
        wait_for_answer()
        client.post("/api/assistant/ask", json={"question": "second"}, headers=HDR)
        wait_for_answer()
        roles = [m["role"] for m in SEEN[-1]["messages"]]
        assert roles.count("user") == 2, roles      # prior turn plus this one
        assert any("first" in json.dumps(m) for m in SEEN[-1]["messages"]), SEEN[-1]

    def t_second_question_while_busy_is_a_409():
        login("http-4")
        REPLY["delay"] = 0.8
        client.post("/api/assistant/ask", json={"question": "one"}, headers=HDR)
        r = client.post("/api/assistant/ask", json={"question": "two"}, headers=HDR)
        assert r.status_code == 409, (r.status_code, r.text)
        REPLY["delay"] = 0.0
        wait_for_answer()

    def t_model_failure_is_stored_not_lost():
        login("http-5")
        saved = os.environ["OLLAMA_BASE_URL"]
        os.environ["OLLAMA_BASE_URL"] = "http://127.0.0.1:9/v1"   # nothing listens
        try:
            r = client.post("/api/assistant/ask", json={"question": "boom"}, headers=HDR)
            assert r.status_code == 202, r.text
            d = wait_for_answer()
            last = d["messages"][-1]
            assert last["status"] == "error", last
            assert last["content"], "an error still owes the user a message"
        finally:
            os.environ["OLLAMA_BASE_URL"] = saved

    def t_empty_question_is_a_400():
        login("http-6")
        r = client.post("/api/assistant/ask", json={"question": "  "}, headers=HDR)
        assert r.status_code == 400, (r.status_code, r.text)

    def t_clear_empties_the_thread():
        login("http-7")
        client.post("/api/assistant/ask", json={"question": "hi"}, headers=HDR)
        wait_for_answer()
        r = client.post("/api/assistant/clear", headers=HDR)
        assert r.status_code == 200 and r.json()["removed"] >= 2, r.text
        assert client.get("/api/assistant/history").json()["messages"] == []

    def t_facts_listing_suggests_subjects():
        login("http-8")
        server._facts.add("test subject fact", "Zubi", "http-8", "tester")
        d = client.get("/api/assistant/facts").json()
        assert "subjects" in d, list(d)
        assert "Zubi" in d["subjects"], d["subjects"]

    for name, fn in list(locals().items()):
        if name.startswith("t_") and callable(fn):
            check("http/" + name[2:], fn)


print("Chat history store tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("\nHTTP endpoint tests")
try:
    http_tests()
except Exception as e:  # noqa: BLE001
    FAILED.append(f"http_tests bootstrap: {type(e).__name__}: {e}")
    print(f"  ✗ could not boot the app: {type(e).__name__}: {e}")

srv.shutdown()
print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
