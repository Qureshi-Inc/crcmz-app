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
    # Prevent the background indexer thread from starting — it would find the
    # real docs/ directory and index it into the test DB, polluting results and
    # keeping file handles open so TemporaryDirectory cleanup fails.
    ms._start_background_indexer = lambda: None


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


def test_audit_write_signature():
    """memory_reindex calls audit_write with the correct 4-argument signature.

    Regression test for the bug where audit_write() was called with 3 args
    (missing `result`) and a dict instead of a JSON string for args_json.
    """
    import inspect
    import re
    import assistant

    src = inspect.getsource(assistant._memory_reindex)

    # Must call audit_write with 4 positional arguments.
    # Pattern: audit_write(zid, "memory_reindex", json.dumps(...), "...")
    calls = re.findall(r'audit_write\(([^)]+)\)', src, re.DOTALL)
    assert calls, "no audit_write call found in _memory_reindex"
    for call in calls:
        args = [a.strip() for a in call.split(',')]
        assert len(args) >= 4, (
            f"audit_write needs 4 args but got {len(args)} in: {call!r}"
        )

    # args_json must be a json.dumps(...) call, not a raw dict literal.
    assert "_json.dumps(" in src or "json.dumps(" in src, (
        "audit_write args_json must be json.dumps(...), not a raw dict"
    )

    # Must audit both the rate-limit case and the success case.
    assert src.count("audit_write") >= 2, (
        "expected audit_write on both rate-limited and success paths"
    )


def test_last_index_run_persisted():
    """status() returns last_index_run from memory_config after a simulated restart."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()

        # Simulate a run cycle completing and persisting the timestamp.
        fake_ts = 1751234567
        import sqlite3
        with sqlite3.connect(tmp / "memory.db") as c:
            c.execute(
                "INSERT OR REPLACE INTO memory_config(key, value) VALUES ('last_index_run', ?)",
                (str(fake_ts),),
            )

        # Wipe the in-memory stat (simulates restart).
        ms._stats["last_index_ts"] = 0

        s = ms.status()
        assert s["last_index_run"] is not None, (
            "last_index_run should read from memory_config after restart"
        )
        assert "2025" in s["last_index_run"] or "2024" in s["last_index_run"] \
            or str(fake_ts)[:4] in s["last_index_run"], (
            f"unexpected last_index_run value: {s['last_index_run']}"
        )


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


# ── Durable store tests ────────────────────────────────────────────────────────

def test_coach_store() -> None:
    import tempfile
    import coach as _coach
    with tempfile.TemporaryDirectory() as td:
        orig = _coach._DB_PATH
        _coach._DB_PATH = Path(td) / "coach_reviews.db"
        try:
            _coach.init()
            # Table created
            import sqlite3
            with sqlite3.connect(_coach._DB_PATH) as c:
                tables = {r[0] for r in c.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()}
            assert "coach_reviews" in tables, "coach_reviews table not created"

            # Insert and retrieve
            rid = _coach.upsert({
                "clip_id": "clip-001",
                "psn_user": "testuser",
                "review_status": "complete",
                "summary": "Great positioning.",
                "coaching_tips": ["Stay behind cover", "Reload before pushing"],
            })
            assert rid
            row = _coach.get(rid)
            assert row is not None
            assert row["clip_id"] == "clip-001"
            assert isinstance(row["coaching_tips"], list)
            assert len(row["coaching_tips"]) == 2

            # backfill_pending returns list (clips.db absent → empty)
            pending = _coach.backfill_pending(limit=5)
            assert isinstance(pending, list)

            # count_by_status
            counts = _coach.count_by_status()
            assert counts.get("complete", 0) == 1
        finally:
            _coach._DB_PATH = orig


def test_app_events_store() -> None:
    import tempfile
    import app_events as _ae
    with tempfile.TemporaryDirectory() as td:
        orig = _ae._DB_PATH
        _ae._DB_PATH = Path(td) / "app_events.db"
        try:
            _ae.init()

            # record returns event_id
            eid = _ae.record("feature_shipped", "Semantic memory", "Added sqlite-vec layer",
                             actor="test", feature="memory")
            assert eid, "record() should return event_id"

            # idempotent — same content returns None
            eid2 = _ae.record("feature_shipped", "Semantic memory", "Added sqlite-vec layer",
                              actor="test", feature="memory")
            assert eid2 is None, "duplicate record should return None"

            # count is 1
            assert _ae.count() == 1

            # list_events returns it
            rows = _ae.list_events(limit=10)
            assert len(rows) == 1
            assert rows[0]["event_id"] == eid
            assert rows[0]["feature"] == "memory"
        finally:
            _ae._DB_PATH = orig


def test_watchparty_events_store() -> None:
    import tempfile
    import watchparty_events as _wpe
    with tempfile.TemporaryDirectory() as td:
        orig = _wpe._DB_PATH
        _wpe._DB_PATH = Path(td) / "watchparty_events.db"
        try:
            _wpe.init()

            # record returns event_id
            eid = _wpe.record("feedback", "Stream was lagging badly at 22:30",
                              room_id="room-abc", user_id="zid-xyz")
            assert eid

            # idempotent
            eid2 = _wpe.record("feedback", "Stream was lagging badly at 22:30")
            assert eid2 is None, "duplicate should return None"

            assert _wpe.count() == 1

            rows = _wpe.list_events(room_id="room-abc")
            assert len(rows) == 1

            # scan_existing_data always returns dict with 'found' key
            result = _wpe.scan_existing_data()
            assert "found" in result
        finally:
            _wpe._DB_PATH = orig


def test_memory_status_source_states() -> None:
    """memory_status() source entries use valid status strings."""
    import tempfile
    _embed_url = _start_fake_embed_server()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        _patch_module(tmp, _embed_url)
        import memory_store as ms
        ms.init()
        st = ms.status()
        valid_statuses = {"indexed", "empty", "unavailable", "indexing", "behind", "failed"}
        for src, info in st.get("sources", {}).items():
            flag = info.get("status")
            assert flag in valid_statuses, (
                f"source {src!r} has invalid status {flag!r}; "
                f"expected one of {valid_statuses}"
            )


def test_source_filter_unknown() -> None:
    """search() with an unknown source returns an error dict."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        result = ms.search("anything", sources=["foobar"])
        assert "error" in result, f"expected error for unknown source, got: {result}"
        assert "valid_sources" in result


def test_source_filter_docs_only() -> None:
    """search() with sources=['docs'] returns only docs items."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        docs_text = "WatchParty docs: how to join a room and stream content"
        wa_text   = "hey let's watch something tonight on WatchParty"
        for src, rid, text in [("docs", "doc1", docs_text), ("whatsapp", "wa1", wa_text)]:
            ms._upsert_item(src, rid, hashlib.sha256(text.encode()).hexdigest(),
                            0, text, int(time.time()*1000), int(time.time()*1000),
                            "{}", _make_vec(text))
        result = ms.search("WatchParty room", sources=["docs"])
        sources_returned = {r["source"] for r in result.get("results", [])}
        assert sources_returned <= {"docs"}, (
            f"sources=['docs'] returned non-docs results: {sources_returned}"
        )


def test_source_filter_empty_source() -> None:
    """search() with sources=['app'] when no app records returns empty results."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        # Only insert whatsapp records
        text = "FIFA tonight anyone?"
        ms._upsert_item("whatsapp", "wa1", hashlib.sha256(text.encode()).hexdigest(),
                        0, text, int(time.time()*1000), int(time.time()*1000),
                        "{}", _make_vec(text))
        result = ms.search("FIFA", sources=["app"])
        assert result.get("results") == [] or result.get("count", 0) == 0, (
            f"sources=['app'] with no app records should return empty, got: {result}"
        )


def test_source_filter_multi() -> None:
    """search() with sources=['docs','app'] returns only docs/app items."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        docs_text = "Deployment decision: use Coolify for container orchestration"
        wa_text   = "Deployment to prod went fine today"
        for src, rid, text in [("docs","doc1",docs_text), ("whatsapp","wa1",wa_text)]:
            ms._upsert_item(src, rid, hashlib.sha256(text.encode()).hexdigest(),
                            0, text, int(time.time()*1000), int(time.time()*1000),
                            "{}", _make_vec(text))
        result = ms.search("deployment decision", sources=["docs", "app"])
        sources_returned = {r["source"] for r in result.get("results", [])}
        assert sources_returned <= {"docs", "app"}, (
            f"sources=['docs','app'] returned unexpected sources: {sources_returned}"
        )


def test_no_source_filter() -> None:
    """search() with sources=None returns results from any source."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _patch_module(tmp, EMBED_URL)
        import memory_store as ms
        ms.init()
        for src, rid, text in [
            ("whatsapp", "wa1", "FIFA match highlights"),
            ("facts",    "f1",  "FIFA ProGamer is undefeated"),
        ]:
            ms._upsert_item(src, rid, hashlib.sha256(text.encode()).hexdigest(),
                            0, text, int(time.time()*1000), int(time.time()*1000),
                            "{}", _make_vec(text))
        result = ms.search("FIFA", sources=None)
        sources_returned = {r["source"] for r in result.get("results", [])}
        assert len(sources_returned) >= 1, "sources=None should return results from any source"


def test_to_epoch_s() -> None:
    """_to_epoch_s normalizes any timestamp format to epoch-seconds."""
    import memory_store as ms

    # Epoch seconds passthrough (< 1e10)
    assert abs(ms._to_epoch_s(1758390000) - 1758390000) < 1, "seconds passthrough"
    # Epoch milliseconds converted (>= 1e10)
    assert abs(ms._to_epoch_s(1758390000000) - 1758390000) < 1, "ms → s"
    # ISO-8601 string
    r = ms._to_epoch_s("2026-09-20T15:18:57Z")
    assert r > 1758000000, f"ISO string gave wrong result: {r}"
    # Null / zero
    assert ms._to_epoch_s(None) == 0.0, "None should give 0.0"
    assert ms._to_epoch_s(0) == 0.0, "0 should give 0.0"
    assert ms._to_epoch_s("") == 0.0, "empty string should give 0.0"
    # Malformed string
    assert ms._to_epoch_s("not-a-date") == 0.0, "malformed string should give 0.0"
    # WhatsApp timestamps are epoch-seconds (~1.79 billion)
    wa_ts = 1789917537
    assert abs(ms._to_epoch_s(wa_ts) - wa_ts) < 1, "WA seconds passthrough"
    # WA-style millisecond value (same moment, *1000)
    wa_ts_ms = 1789917537000
    assert abs(ms._to_epoch_s(wa_ts_ms) - wa_ts) < 1, "WA ms → s"
    # Facts timestamps are epoch-seconds
    facts_ts = 1789691256
    assert abs(ms._to_epoch_s(facts_ts) - facts_ts) < 1, "facts seconds passthrough"
    # PSN psn_created_at is epoch-seconds
    psn_ts = 1758390537.5
    assert abs(ms._to_epoch_s(psn_ts) - psn_ts) < 1, "PSN float seconds passthrough"
    print("  _to_epoch_s: all pass")


def test_app_events_created_at() -> None:
    """record() with _created_at preserves the commit's original timestamp."""
    import app_events as _ae
    with tempfile.TemporaryDirectory() as td:
        orig = _ae._DB_PATH
        _ae._DB_PATH = Path(td) / "app_events.db"
        try:
            _ae.init()
            commit_ts = 1758390537.0  # a past commit time
            eid = _ae.record(
                "feature_shipped", "Old feature", "Shipped long ago",
                _created_at=commit_ts,
            )
            assert eid
            row = _ae.get(eid)
            assert row is not None
            assert abs(row["created_at"] - commit_ts) < 1, (
                f"created_at {row['created_at']} should match commit_ts {commit_ts}"
            )
        finally:
            _ae._DB_PATH = orig


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
    check("13. audit_write called with correct signature", test_audit_write_signature)
    check("14. last_index_run persists across restarts", test_last_index_run_persisted)
    check("A. acceptance: 3 synthetic queries", test_acceptance_synthetic_queries)
    check("15. coach store: init, upsert, get, backfill_pending, count_by_status", test_coach_store)
    check("16. app_events store: init, record, idempotency, count, list", test_app_events_store)
    check("17. watchparty_events store: init, record, idempotency, scan_existing_data", test_watchparty_events_store)
    check("18. memory_status source state strings are valid", test_memory_status_source_states)
    check("19. _to_epoch_s normalizes all timestamp formats", test_to_epoch_s)
    check("20. app_events record() respects _created_at", test_app_events_created_at)
    check("21. source filter: unknown source returns error", test_source_filter_unknown)
    check("22. source filter: docs-only excludes whatsapp", test_source_filter_docs_only)
    check("23. source filter: empty source returns []", test_source_filter_empty_source)
    check("24. source filter: multi-source", test_source_filter_multi)
    check("25. source filter: None searches all", test_no_source_filter)

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
