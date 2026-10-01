#!/usr/bin/env python3
"""mattermost.py: finding the person to DM when their mm_username tag is wrong.

Plain asserts against a local stand-in for the Mattermost API:

    python3 tests/test_mattermost.py
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

USERS = {"mutasif": {"id": "u1", "username": "mutasif", "email": "goop@example.com"},
         "moiz": {"id": "u2", "username": "moiz", "email": "m@example.com"}}
POSTS: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        p = self.path
        if p == "/api/v4/users/me":
            return self._send(200, {"id": "bot"})
        if p.startswith("/api/v4/users/username/"):
            u = USERS.get(p.rsplit("/", 1)[1])
            return self._send(200 if u else 404, u or {"id": "app.user.get_by_username.app_error"})
        if p.startswith("/api/v4/users/email/"):
            u = next((u for u in USERS.values() if u["email"] == p.rsplit("/", 1)[1]), None)
            return self._send(200 if u else 404, u or {})
        if p.startswith("/api/v4/users/"):
            u = next((u for u in USERS.values() if u["id"] == p.rsplit("/", 1)[1]), None)
            return self._send(200 if u else 404, u or {})
        self._send(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"null")
        if self.path == "/api/v4/channels/direct":
            return self._send(201, {"id": "dm-" + body[1]})
        if self.path == "/api/v4/posts":
            POSTS.append(body)
            return self._send(201, {"id": "p"})
        self._send(404, {})


srv = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["MATTERMOST_URL"] = f"http://127.0.0.1:{srv.server_address[1]}"
os.environ["MATTERMOST_TOKEN"] = "bot-token"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import mattermost  # noqa: E402

FAILED: list[str] = []
PASSED = 0


def check(name, fn):
    global PASSED
    POSTS.clear()
    try:
        fn()
        PASSED += 1
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def t_the_tag_when_it_is_right():
    assert mattermost.dm_user("moiz", "hi", email="other@example.com")
    assert POSTS == [{"channel_id": "dm-u2", "message": "hi"}], POSTS


def t_the_email_when_the_tag_is_wrong():
    assert mattermost.dm_user("themoosecompany", "hi", email="goop@example.com")
    assert POSTS == [{"channel_id": "dm-u1", "message": "hi"}], POSTS


def t_the_email_when_there_is_no_tag():
    assert mattermost.dm_user("", "hi", email="goop@example.com")
    assert POSTS[0]["channel_id"] == "dm-u1"


def t_nobody_when_neither_matches():
    assert not mattermost.dm_user("themoosecompany", "hi")
    assert not mattermost.dm_user("", "hi", email="nobody@example.com")
    assert POSTS == []


def t_username_for():
    assert mattermost.username_for("themoosecompany", "goop@example.com") == "mutasif"
    assert mattermost.username_for("nope") is None


print("mattermost")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)
print(f"\n{PASSED} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
