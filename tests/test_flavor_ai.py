#!/usr/bin/env python3
"""Chat Board button flavor text — local model (gemma on omlx / LM Studio).

Stands up a stub OpenAI-compatible server so nothing here leaves the machine.
Plain asserts, no pytest — run inside the app image where the deps live:

    docker build -t crcmz-app:test .
    docker run --rm -v "$PWD/tests:/app/tests" crcmz-app:test \
      python tests/test_flavor_ai.py
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAILED: list[str] = []
PASSED = 0
SEEN: list[dict] = []          # every request the stub model received
REPLY = {"text": "hello 🔥"}   # what the stub model answers with


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
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append({"path": self.path, "body": body,
                     "auth": self.headers.get("Authorization")})
        if REPLY.get("status", 200) != 200:
            self.send_response(REPLY["status"])
            self.end_headers()
            self.wfile.write(b'{"error":"nope"}')
            return
        text = REPLY["text"]
        out = ({"choices": [{"message": {"role": "assistant", "content": text}}]}
               if self.path.endswith("/chat/completions")
               else {"message": {"role": "assistant", "content": text}})
        payload = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):  # keep the test output readable
        pass


srv = HTTPServer(("127.0.0.1", 0), _Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
HOST = f"http://127.0.0.1:{srv.server_address[1]}"

import roast_bot  # noqa: E402


def _reset(base, model="gemma-3-12b-it", key="omlx-test-key", flavor_model=""):
    SEEN.clear()
    REPLY.clear()
    REPLY["text"] = "hello 🔥"
    os.environ["OLLAMA_BASE_URL"] = base
    os.environ["OLLAMA_MODEL"] = model
    os.environ["OLLAMA_API_KEY"] = key
    os.environ["FLAVOR_MODEL"] = flavor_model


def t_openai_compatible_path():
    _reset(HOST + "/v1")
    assert roast_bot.flavor_message("hello") == "hello 🔥"
    assert len(SEEN) == 1, SEEN
    req = SEEN[0]
    assert req["path"] == "/v1/chat/completions", req["path"]
    assert req["body"]["model"] == "gemma-3-12b-it", req["body"]
    assert req["body"]["stream"] is False, req["body"]
    assert req["auth"] == "Bearer omlx-test-key", req["auth"]
    # Gemma has no system turn: one user message carrying the whole prompt.
    assert [m["role"] for m in req["body"]["messages"]] == ["user"], req["body"]
    assert "hello" in req["body"]["messages"][0]["content"]


def t_native_ollama_path():
    _reset(HOST)
    assert roast_bot.flavor_message("hello") == "hello 🔥"
    assert SEEN[0]["path"] == "/api/chat", SEEN[0]["path"]
    assert SEEN[0]["body"]["options"]["num_predict"] == 120, SEEN[0]["body"]


def t_flavor_model_overrides():
    _reset(HOST + "/v1", model="llama3.2", flavor_model="gemma-3-27b-it")
    roast_bot.flavor_message("hello")
    assert SEEN[0]["body"]["model"] == "gemma-3-27b-it", SEEN[0]["body"]


def t_no_api_key_sends_no_auth_header():
    _reset(HOST + "/v1", key="")
    roast_bot.flavor_message("hello")
    assert SEEN[0]["auth"] is None, SEEN[0]["auth"]


def t_quotes_and_fences_are_stripped():
    _reset(HOST + "/v1")
    REPLY["text"] = '```\n"water break 💧"\n```'
    assert roast_bot.flavor_message("water break") == "water break 💧"


def t_rambling_answer_falls_back_to_raw():
    _reset(HOST + "/v1")
    REPLY["text"] = "Sure! Here's your message:\n\nwater break 💧"
    assert roast_bot.flavor_message("water break") == "water break"


def t_essay_falls_back_to_raw():
    _reset(HOST + "/v1")
    REPLY["text"] = "x" * 201
    assert roast_bot.flavor_message("water break") == "water break"


def t_local_error_falls_back():
    # Bedrock has no credentials in the test image, so the raw text is the floor.
    _reset(HOST + "/v1")
    REPLY["status"] = 500
    assert roast_bot.flavor_message("water break") == "water break"


def t_unconfigured_skips_local_entirely():
    _reset("")
    assert roast_bot.flavor_message("water break") == "water break"
    assert SEEN == [], SEEN


def t_empty_input_short_circuits():
    _reset(HOST + "/v1")
    assert roast_bot.flavor_message("   ") == ""
    assert SEEN == [], SEEN


print("Chat Board flavor AI tests")
for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

srv.shutdown()
print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("  FAIL " + f)
sys.exit(1 if FAILED else 0)
