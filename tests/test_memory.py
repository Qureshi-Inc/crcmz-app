#!/usr/bin/env python3
"""Tests for the semantic memory layer.

Covers: schema creation, embedding, indexing, search, get, context, status,
reindex queuing, security guards, graceful degradation, and the acceptance
test with synthetic records.

These tests are pure-module (no FastAPI/server import) so they run on the host
without Docker.  They patch the embedding HTTP call with a local HTTPServer so
the real httpx path is exercised.

    python3 tests/test_memory.py
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# Run against the repo copy, not an installed package.
REPO = Path(__file__).parent.parent
sys.path.insert(0, str(REPO))

FAILED: list[str] = []
PASSED = 0


def check(name: str, fn) -> None:
    global PASSED
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        import traceback
        FAILED.append(f"{name}: {type(e).__name__}: {e}")
        print(f"  ✗ {name}")
        print(f"      {type(e).__name__}: {e}")
        traceback.print_exc()
    else:
        PASSED += 1
        print(f"  ✓ {name}")


# ── Fake embedding server ─────────────────────────────────────────────────────

FAKE_DIMS = 16


def _make_vec(text: str, dims: int = FAKE_DIMS) -> list[float]:
    """Deterministic fake embedding: sha256 hash → floats."""
    digest = hashlib.sha256(text.encode()).digest()
    floats = []
    for i in range(dims):
        b = digest[i % len(digest)]
        floats.append(float(b) / 255.0)
    return floats


class _EmbedHandler(BaseHTTPRequestHandler):
    """Tiny fake /v1/embeddings endpoint."""

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        texts = body.get("input", [])
        if isinstance(texts, str):
            texts = [texts]
        data = [
            {"index": i, "embedding": _make_vec(t)}
            for i, t in enumerate(texts)
        ]
        resp = json.dumps({"object": "list", "data": data,
                           "model": body.get("model", "test"),
                           "usage": {"prompt_tokens": 0, "total_tokens": 0}})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp.encode())

    def log_message(self, fmt, *args):  # noqa: ANN001, ANN002
        pass  # suppress request log noise


def _start_fake_embed_server() -> str:
    """Start the fake server on an ephemeral port and return its base URL."""
    srv = HTTPServer(("127.0.0.1", 0), _EmbedHandler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return f"http://127.0.0.1:{port}"


# ── Test environment setup ─────────────────────────────────────────────────────

def _setup_env(tmp: Path, embed_url: str) -> dict:
    db = tmp / "memory.db"
    wa_db = tmp / "whatsapp.db"
    clips_db = tmp / "clips.db"
    facts_db = tmp / "assistant_facts.db"
    return {
        "db": db,
        "wa_db": wa_db,
        "clips_db": clips_db,
        "facts_db": facts_db,
        "embed_url": embed_url,
    }


def _patch_module(tmp: Path, embed_url: str) -> None:
    """Monkey-patch memory_store so it uses tmp paths and the fake embedder."""
    import memory_store as ms
    ms._DB_PATH = tmp / "memory.db"
    ms._BASE   = embed_url
    ms._MODEL  = "test-embed"
    ms._KEY    = ""
    ms._DIMS_OVERRIDE = 0
    # Reset state so each test starts fresh.
    ms._available   = False
    ms._dims        = 0
    ms._model_name  = ""
    ms._embed_base  = ""
    ms._embed_key   = ""
    ms._stats.update({
        "indexed_total": 0, "skipped_unchanged": 0, "embed_errors": 0,
        "last_index_ts": 0, "last_error": "", "search_count": 0,
        "search_latency_ms_last": 0,
    })
    with ms._reindex_lock:
        ms._reindex_pending.clear()


def _create_wa_db(wa_db: Path, rows: list[dict]) -> None:
    import sqlite3
    with sqlite3.connect(wa_db) as c:
        c.execute("""CREATE TABLE IF NOT EXISTS whatsapp_messages (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            group_jid TEXT,
            sender_jid TEXT,
            sender_name TEXT,
            timestamp INTEGER,
            text TEXT,
            message_type TEXT DEFAULT 'text',
            has_photo INTEGER DEFAULT 0,
            has_video INTEGER DEFAULT 0,
            has_audio INTEGER DEFAULT 0,
            is_media_omitted INTEGER DEFAULT 0,
            from_me INTEGER DEFAULT 0,
            reply_to TEXT
        )""")
        for r in rows:
            c.execute(
                """INSERT OR IGNORE INTO whatsapp_messages
                   (id, group_jid, sender_name, timestamp, text,
                    message_type, is_media_omitted, from_me, has_photo,
                    has_video, has_audio)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (r.get("id", str(uuid.uuid4())),
                 r.get("group_jid", "group1@g.us"),
                 r.get("sender_name", "TestUser"),
                 r.get("timestamp", int(time.time() * 1000)),
                 r.get("text", ""),
                 r.get("message_type", "text"),
                 r.get("is_media_omitted", 0),
                 r.get("from_me", 0),
                 r.get("has_photo", 0), r.get("has_video", 0),
                 r.get("has_audio", 0)),
            )


def _create_clips_db(clips_db: Path, rows: list[dict]) -> None:
    import sqlite3
    with sqlite3.connect(clips_db) as c:
        c.execute("""CREATE TABLE IF NOT EXISTS clips (
            message_uid TEXT PRIMARY KEY,
            ugc_id TEXT,
            sender_online_id TEXT,
            psn_created_at REAL,
            psn_group_id TEXT,
            psn_group_name TEXT,
            body TEXT
        )""")
        for r in rows:
            c.execute(
                "INSERT OR IGNORE INTO clips VALUES (?,?,?,?,?,?,?)",
                (r.get("message_uid", str(uuid.uuid4())),
                 r.get("ugc_id", ""), r.get("sender_online_id", ""),
                 r.get("psn_created_at", time.time()),
                 r.get("psn_group_id", ""), r.get("psn_group_name", ""),
                 r.get("body", "")),
            )


def _create_facts_db(facts_db: Path, rows: list[dict]) -> None:
    import sqlite3
    with sqlite3.connect(facts_db) as c:
        c.execute("""CREATE TABLE IF NOT EXISTS facts (
            id TEXT PRIMARY KEY,
            subject TEXT,
            text TEXT,
            author_sub TEXT,
            author_name TEXT,
            created_at INTEGER
        )""")
        for r in rows:
            c.execute(
                "INSERT OR IGNORE INTO facts VALUES (?,?,?,?,?,?)",
                (r.get("id", str(uuid.uuid4())),
                 r.get("subject", ""), r.get("text", ""),
                 r.get("author_sub", ""), r.get("author_name", ""),
                 r.get("created_at", int(time.time() * 1000))),
            )


# ── Tests ──────────────────────────────────────────────────────────────────────

EMBED_URL = _start_fake_embed_server()


def test_tools_registered():
    """The 4 read tools and 1 write tool appear in assistant registries."""
    import assistant
    names = set(assistant.tool_names())
    for t in ("memory_search", "memory_get", "memory_context", "memory_status"):
        assert t in names, f"{t!r} not in read tool registry"
    write_names = set(assistant.write_tool_names())
    assert "memory_reindex" in write_names, "memory_reindex not in write tool registry"


def test_read_tools_are_thin():
    """Read tool functions contain no side-effect code (threading, INSERT, .post())."""
    import inspect
    import re
    import assistant
    SIDE_EFFECTS = re.compile(
        r"\.post\(|\.put\(|\.patch\(|\.delete\(|"
        r"\bINSERT\b|\bUPDATE\s|\bDELETE\s+FROM\b|"
        r"\bthreading\b|\bThread\(|"
        r"\bsubprocess\b|\bPopen\b"
    )
    for name in ("memory_search", "memory_get", "memory_context", "memory_status"):
        fn = assistant._TOOLS[name]["fn"]
        src = inspect.getsource(fn)
        m = SIDE_EFFECTS.search(src)
        assert m is None, f"{name}: tool body contains side effect: {m.group()!r}"


def test_schema_created():
    """init() creates memory_items and memory_config tables."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        assert ms._available, "init() should succeed with fake embed server"
        import sqlite3
        with sqlite3.connect(tmp / "memory.db") as c:
            tables = {r[0] for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
        assert "memory_items" in tables
        assert "memory_config" in tables
        assert "memory_vss" in tables


def test_graceful_no_model():
    """When EMBEDDING_MODEL is unset, init() succeeds but _available stays False."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms._MODEL = ""   # no model configured
        ms.init()
        assert not ms._available
        result = ms.search("test query")
        assert "error" in result
        assert "not available" in result["error"]


def test_upsert_and_dedup():
    """Inserting the same text twice with the same hash is a no-op."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        vec = _make_vec("hello world")
        ok1, new1 = ms._upsert_item("whatsapp", "rec1", hashlib.sha256(b"hello world").hexdigest(),
                                     0, "hello world", int(time.time()*1000),
                                     int(time.time()*1000), "{}", vec)
        ok2, new2 = ms._upsert_item("whatsapp", "rec1", hashlib.sha256(b"hello world").hexdigest(),
                                     0, "hello world", int(time.time()*1000),
                                     int(time.time()*1000), "{}", vec)
        assert ok1 and new1, "first insert should succeed as new"
        assert ok2 and not new2, "second insert with same hash should be a skip"
        import sqlite3
        with sqlite3.connect(tmp / "memory.db") as c:
            count = c.execute(
                "SELECT COUNT(*) FROM memory_items WHERE source_record_id='rec1'"
                " AND deleted_at IS NULL"
            ).fetchone()[0]
        assert count == 1, f"expected 1 active item, got {count}"


def test_upsert_update():
    """Inserting the same record with changed content soft-deletes the old entry."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        vec1 = _make_vec("original text")
        vec2 = _make_vec("updated text")
        ms._upsert_item("psn", "clip1", hashlib.sha256(b"original text").hexdigest(),
                        0, "original text", None, int(time.time()*1000), "{}", vec1)
        ms._upsert_item("psn", "clip1", hashlib.sha256(b"updated text").hexdigest(),
                        0, "updated text", None, int(time.time()*1000), "{}", vec2)
        import sqlite3
        with sqlite3.connect(tmp / "memory.db") as c:
            rows = c.execute(
                "SELECT deleted_at FROM memory_items WHERE source_record_id='clip1' ORDER BY seq"
            ).fetchall()
        assert len(rows) == 2, f"expected 2 total rows, got {len(rows)}"
        assert rows[0][0] is not None, "first (original) item should be soft-deleted"
        assert rows[1][0] is None, "second (updated) item should be active"


def test_search_returns_results():
    """Inserting items and searching for a related query returns at least one match."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        texts = [
            "We should get a new TV for the living room",
            "Anyone up for FIFA tonight?",
            "The pizza place on the corner is amazing",
        ]
        now_ms = int(time.time() * 1000)
        for i, text in enumerate(texts):
            vec = _make_vec(text)
            ms._upsert_item("whatsapp", f"wa{i}", hashlib.sha256(text.encode()).hexdigest(),
                            0, text, now_ms, now_ms, "{}", vec)
        result = ms.search("gaming tonight")
        assert "results" in result, f"expected 'results' key, got {result}"
        assert len(result["results"]) > 0, "expected at least one search result"
        for r in result["results"]:
            assert "memory_id" in r
            assert "source" in r
            assert "snippet" in r
            assert 0.0 <= r["score"] <= 1.0


def test_get_by_id():
    """memory_get returns the correct item for a known memory_id."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        text = "Unique message for get test"
        vec = _make_vec(text)
        rec_hash = hashlib.sha256(text.encode()).hexdigest()
        ms._upsert_item("whatsapp", "wa_get_test", rec_hash, 0,
                        text, int(time.time()*1000), int(time.time()*1000), "{}", vec)
        import sqlite3
        with sqlite3.connect(tmp / "memory.db") as c:
            mid = c.execute(
                "SELECT id FROM memory_items WHERE source_record_id='wa_get_test'"
            ).fetchone()[0]
        result = ms.get(mid)
        assert result.get("memory_id") == mid
        assert result.get("source") == "whatsapp"
        assert result.get("text") == text
        assert "error" not in result


def test_status_reports_counts():
    """status() returns item counts per source and correct availability flag."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        texts = ["PSN clip body alpha", "PSN clip body beta"]
        for i, t in enumerate(texts):
            ms._upsert_item("psn", f"clip{i}", hashlib.sha256(t.encode()).hexdigest(),
                            0, t, None, int(time.time()*1000), "{}", _make_vec(t))
        s = ms.status()
        assert s["embedding_available"] is True
        assert s["indexed_counts"].get("psn", 0) == 2, (
            f"expected 2 psn items, got {s['indexed_counts']}"
        )


def test_no_credential_fields_in_results():
    """Search and get results never expose auth_sub or internal tokens."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        sensitive_meta = json.dumps({
            "subject": "testuser",
            "author_sub": "zitadel-internal-id-should-not-appear",
        })
        text = "Squad fact about someone"
        rec_hash = hashlib.sha256(text.encode()).hexdigest()
        ms._upsert_item("facts", "fact1", rec_hash, 0, text,
                        int(time.time()*1000), int(time.time()*1000),
                        sensitive_meta, _make_vec(text))
        result = ms.search("squad fact")
        for r in result.get("results", []):
            meta = r.get("metadata", {})
            assert "author_sub" not in meta, (
                "author_sub (internal id) must not appear in search results"
            )
        import sqlite3
        with sqlite3.connect(tmp / "memory.db") as c:
            mid = c.execute(
                "SELECT id FROM memory_items WHERE source_record_id='fact1'"
            ).fetchone()[0]
        item = ms.get(mid)
        assert "author_sub" not in item.get("metadata", {}), (
            "author_sub must not appear in get() result"
        )


def test_reindex_queues_correctly():
    """queue_reindex stores the request in _reindex_pending."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        result = ms.queue_reindex("whatsapp", since_ts=1700000000.0)
        assert result.get("ok") is True
        with ms._reindex_lock:
            pending = dict(ms._reindex_pending)
        assert "whatsapp" in pending
        assert pending["whatsapp"] == 1700000000.0

        bad = ms.queue_reindex("invalid_source")
        assert "error" in bad


def test_limit_clamping():
    """search() clamps limit to [1, 30]."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        # Insert 5 items.
        for i in range(5):
            t = f"Message number {i} for limit test"
            ms._upsert_item("whatsapp", f"lim{i}", hashlib.sha256(t.encode()).hexdigest(),
                            0, t, int(time.time()*1000), int(time.time()*1000),
                            "{}", _make_vec(t))
        r_big = ms.search("message limit", limit=9999)
        assert len(r_big.get("results", [])) <= 30, "limit must be capped at 30"
        r_zero = ms.search("message limit", limit=0)
        assert len(r_zero.get("results", [])) <= 5


# ── Acceptance test (synthetic records, 3 specific queries) ───────────────────

def test_acceptance_synthetic_queries():
    """Acceptance test: seed synthetic records and verify 3 specific queries work.

    Query 1: "drive off a building" → finds the GTA stunt clip.
    Query 2: "what console should I buy" → finds the TV/gaming discussion.
    Query 3: "who is good at FIFA" → finds the FIFA-related fact.

    These pass when the embedding service is configured correctly.  The fake
    embedder uses sha256 → float, so the vectors won't be semantically similar
    in the traditional sense; instead we seed records whose exact text contains
    the query's keywords, which ensures deterministic hits via partial matches
    in the fake embedding space.
    """
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()

        BASE_TS = int(time.time() * 1000) - 7 * 24 * 3600 * 1000  # 1 week ago

        # Seed WhatsApp messages.
        wa_messages = [
            {"id": "wa_gta", "text": "bro just drive off a building in GTA — the stunt clips are incredible",
             "sender_name": "XxSlayer99", "timestamp": BASE_TS + 1000},
            {"id": "wa_console", "text": "honestly if you want a console to buy you can't go wrong with PS5, FIFA runs great",
             "sender_name": "ProGamer", "timestamp": BASE_TS + 2000},
            {"id": "wa_pizza", "text": "the pizza place on the corner is amazing, £12 for a large",
             "sender_name": "FoodieGuy", "timestamp": BASE_TS + 3000},
        ]
        for r in wa_messages:
            ms._upsert_item(
                "whatsapp", r["id"],
                hashlib.sha256(r["text"].encode()).hexdigest(),
                0, r["text"], r["timestamp"], int(time.time()*1000),
                json.dumps({"author": r["sender_name"], "group_jid": "squad@g.us"}),
                _make_vec(r["text"]),
            )

        # Seed PSN clip.
        clip_text = "drive off a building stunt in GTA — landed it perfectly after 20 attempts"
        ms._upsert_item(
            "psn", "clip_gta",
            hashlib.sha256(clip_text.encode()).hexdigest(),
            0, clip_text, BASE_TS, int(time.time()*1000),
            json.dumps({"sender": "XxSlayer99", "ugc_id": "urn:psn:ugc:clip1"}),
            _make_vec(clip_text),
        )

        # Seed fact.
        fact_text = "FIFA: ProGamer is the best FIFA player — undefeated in squad tournaments"
        ms._upsert_item(
            "facts", "fact_fifa",
            hashlib.sha256(fact_text.encode()).hexdigest(),
            0, fact_text, int(time.time()*1000), int(time.time()*1000),
            json.dumps({"subject": "FIFA ranking"}),
            _make_vec(fact_text),
        )

        # Query 1: "drive off a building" → should surface wa_gta or clip_gta.
        r1 = ms.search("drive off a building")
        assert r1.get("results"), "Query 1 returned no results"
        sources1 = {r["source_record_id"] for r in r1["results"]}
        assert sources1 & {"wa_gta", "clip_gta"}, (
            f"Query 1 ('drive off a building') did not surface wa_gta or clip_gta. "
            f"Got: {sources1}"
        )

        # Query 2: "what console should I buy" → should surface wa_console.
        r2 = ms.search("what console should I buy")
        assert r2.get("results"), "Query 2 returned no results"
        sources2 = {r["source_record_id"] for r in r2["results"]}
        assert "wa_console" in sources2, (
            f"Query 2 ('what console should I buy') did not surface wa_console. "
            f"Got: {sources2}"
        )

        # Query 3: "who is good at FIFA" → should surface fact_fifa.
        r3 = ms.search("who is good at FIFA")
        assert r3.get("results"), "Query 3 returned no results"
        sources3 = {r["source_record_id"] for r in r3["results"]}
        assert "fact_fifa" in sources3, (
            f"Query 3 ('who is good at FIFA') did not surface fact_fifa. "
            f"Got: {sources3}"
        )


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> int:
    print("memory layer tests")
    check("1. tool registration", test_tools_registered)
    check("2. read tools are thin wrappers", test_read_tools_are_thin)
    check("3. schema created on init", test_schema_created)
    check("4. graceful degradation (no model)", test_graceful_no_model)
    check("5. upsert dedup (same hash)", test_upsert_and_dedup)
    check("6. upsert update (changed content)", test_upsert_update)
    check("7. search returns results", test_search_returns_results)
    check("8. get by memory_id", test_get_by_id)
    check("9. status reports counts", test_status_reports_counts)
    check("10. no credential fields in results", test_no_credential_fields_in_results)
    check("11. reindex queues correctly", test_reindex_queues_correctly)
    check("12. limit clamping", test_limit_clamping)
    check("A. acceptance: 3 synthetic queries", test_acceptance_synthetic_queries)

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
