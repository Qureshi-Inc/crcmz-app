"""Semantic memory layer for the CRCMZ assistant.

Indexes WhatsApp messages, PSN clips, and squad facts into a local vector
database so the Qwen model can answer fuzzy questions ("what did we say about
WatchParty last month?" "find the clip where someone drove off a building.")
without ingesting entire tables.

Architecture
============
* Storage: SQLite with the sqlite-vec extension (one extra pip dep, no new service).
  `/data/memory.db` holds two things:
    - `memory_items` — metadata for every indexed chunk (source, record id, text,
      timestamps, metadata JSON, soft-delete flag)
    - `memory_vss` — sqlite-vec virtual table containing the float32 embedding
      for each item; rowid links to memory_items.seq (INTEGER PRIMARY KEY = rowid)

* Embeddings: any OpenAI-compatible `/v1/embeddings` endpoint, configured via
  env vars.  The oMLX server is the default; it must have an embedding model
  loaded.  If no embedding service is reachable at startup the module logs a
  warning and continues — all tools return a clear "not available" message until
  an embedding model is configured.

* Indexing: a background thread wakes every POLL_SECONDS, finds new/changed
  records in each source, embeds them, and inserts/updates the vector store.
  A content-hash prevents re-embedding unchanged records.  Explicit reindex
  requests (from the `memory_reindex` write tool) are honoured on the next
  background cycle.

* Search: embed the query, do a kNN lookup in `memory_vss`, join back to
  `memory_items`, apply metadata filters (source, date range, group, user),
  return top-N results with snippet + score + source reference.

Environment
===========
EMBEDDING_BASE_URL   — base URL of an OpenAI-compatible embeddings API
                        (defaults to OLLAMA_BASE_URL, the oMLX instance)
EMBEDDING_MODEL      — model id, e.g. "mlx-community/nomic-embed-text-v1.5-mlx"
                        (required; no default — the module stays disabled until set)
EMBEDDING_API_KEY    — optional bearer token (defaults to OLLAMA_API_KEY)
EMBEDDING_DIMENSIONS — override vector dimension if the model doesn't report it
                        in the response (leave unset to auto-detect at startup)

Security
========
This module never stores or returns:
  - bearer tokens, API keys, cookies, auth state
  - the raw PSN token JSON
  - password or credential fields

The search results reference source records by ID only; the caller fetches
content through the normal (access-controlled) source tools.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import struct
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────

_BASE = os.environ.get("EMBEDDING_BASE_URL",
                       os.environ.get("OLLAMA_BASE_URL", "")).strip().rstrip("/")
_MODEL = os.environ.get("EMBEDDING_MODEL", "").strip()
_KEY   = os.environ.get("EMBEDDING_API_KEY",
                        os.environ.get("OLLAMA_API_KEY", "")).strip()
_DIMS_OVERRIDE = int(os.environ.get("EMBEDDING_DIMENSIONS", "0") or "0")

POLL_SECONDS   = int(os.environ.get("MEMORY_POLL_SECONDS", "60") or "60")
BATCH_SIZE     = int(os.environ.get("MEMORY_BATCH_SIZE",  "20") or "20")
MAX_TEXT_CHARS = 4000   # truncate before embedding
MAX_RESULTS    = 30     # hard cap on search results
CANDIDATE_K    = 60     # vector candidates fetched before metadata filtering

_DB_PATH = Path("/data/memory.db")
_lock = threading.Lock()

# ── Module-level state (set during init) ──────────────────────────────────────

_available       = False    # True once sqlite-vec loaded AND embedding probed OK
_dims            = 0        # actual embedding dimension
_model_name      = ""       # confirmed embedding model id
_embed_base      = ""       # confirmed base URL
_embed_key       = ""       # confirmed API key

# Reindex requests: source → since_epoch (None = full reindex)
_reindex_pending: dict[str, float | None] = {}
_reindex_lock    = threading.Lock()

# Background stats (no sensitive data)
_stats: dict[str, Any] = {
    "indexed_total": 0,
    "skipped_unchanged": 0,
    "embed_errors": 0,
    "last_index_ts": 0,
    "last_error": "",
    "search_count": 0,
    "search_latency_ms_last": 0,
}


# ── Database helpers ──────────────────────────────────────────────────────────

def _conn():
    """Open (or create) the memory DB.  Caller is responsible for closing."""
    import sqlite3 as _sq3
    c = _sq3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = _sq3.Row
    return c


def _load_vec(conn) -> bool:
    """Attempt to load the sqlite-vec extension.  Returns True on success."""
    try:
        import sqlite_vec as sv
        conn.enable_load_extension(True)
        sv.load(conn)
        conn.enable_load_extension(False)
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("memory: sqlite-vec not available: %s", e)
        return False


def _serialize(vec: list[float]) -> bytes:
    """Pack a float list as little-endian float32 bytes for sqlite-vec."""
    return struct.pack(f"{len(vec)}f", *vec)


# ── Schema ────────────────────────────────────────────────────────────────────

_SCHEMA_BASE = """
CREATE TABLE IF NOT EXISTS memory_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
    seq              INTEGER PRIMARY KEY,   -- links to memory_vss.rowid
    id               TEXT UNIQUE NOT NULL,  -- UUID for external references
    source           TEXT NOT NULL,         -- 'whatsapp' | 'psn' | 'facts' | 'app'
    source_record_id TEXT NOT NULL,         -- e.g. whatsapp_messages.id
    source_hash      TEXT NOT NULL,         -- sha256(text) — dedup key
    chunk_index      INTEGER NOT NULL DEFAULT 0,
    text             TEXT NOT NULL,
    source_ts        INTEGER,               -- original record timestamp (epoch ms)
    created_at       INTEGER NOT NULL,
    deleted_at       INTEGER,               -- soft-delete; hard-deleted from vec table
    metadata_json    TEXT NOT NULL DEFAULT '{}',
    UNIQUE(source, source_record_id, source_hash, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_mem_source_ts  ON memory_items(source, source_ts);
CREATE INDEX IF NOT EXISTS idx_mem_source_rec ON memory_items(source, source_record_id);
CREATE INDEX IF NOT EXISTS idx_mem_active     ON memory_items(source)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_id         ON memory_items(id);

CREATE TABLE IF NOT EXISTS memory_index_log (
    id          INTEGER PRIMARY KEY,
    source      TEXT NOT NULL,
    record_id   TEXT,
    op          TEXT NOT NULL,   -- 'index' | 'skip' | 'delete' | 'error'
    detail      TEXT,
    ts          INTEGER NOT NULL
);
"""

# The vec virtual table requires a fixed dimension; created separately after
# the embedding model is probed.
_SCHEMA_VSS = "CREATE VIRTUAL TABLE IF NOT EXISTS memory_vss USING vec0(embedding float[{dims}])"


def _ensure_schema(conn) -> None:
    conn.executescript(_SCHEMA_BASE)
    conn.commit()


def _ensure_vss(conn, dims: int) -> None:
    """Create the vec virtual table if it does not exist yet."""
    existing = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vss'"
    ).fetchone()
    if existing:
        return
    conn.execute(_SCHEMA_VSS.format(dims=dims))
    conn.commit()
    logger.info("memory: created memory_vss float[%d]", dims)


def _stored_dims(conn) -> int:
    row = conn.execute(
        "SELECT value FROM memory_config WHERE key='embedding_dims'"
    ).fetchone()
    return int(row["value"]) if row else 0


def _store_config(conn, **kv) -> None:
    for k, v in kv.items():
        conn.execute(
            "INSERT OR REPLACE INTO memory_config(key, value) VALUES (?, ?)",
            (k, str(v)),
        )
    conn.commit()


# ── Embedding client ──────────────────────────────────────────────────────────

def _embed(texts: list[str], base: str, model: str, key: str) -> list[list[float]]:
    """Call /v1/embeddings.  Returns one float vector per input text.

    Does NOT log the full text (may contain private messages).
    """
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    start = time.monotonic()
    with httpx.Client(timeout=60.0) as client:
        r = client.post(
            f"{base}/v1/embeddings",
            headers=headers,
            json={"model": model, "input": texts},
        )
        r.raise_for_status()
    data = r.json().get("data", [])
    result = [item["embedding"] for item in sorted(data, key=lambda x: x.get("index", 0))]
    elapsed = (time.monotonic() - start) * 1000
    logger.debug("memory: embed %d texts in %.0fms", len(texts), elapsed)
    return result


def _probe_embedding(base: str, model: str, key: str) -> int:
    """Embed a test sentence and return vector dimension.  Raises on failure."""
    vecs = _embed(["test"], base, model, key)
    if not vecs or not vecs[0]:
        raise ValueError("empty embedding response")
    return len(vecs[0])


# ── Initialisation ────────────────────────────────────────────────────────────

def init() -> None:
    """Create schema, probe the embedding service, start the background indexer.

    Called from server.py at startup alongside the other module inits.
    Never raises — if the embedding service is absent, the module runs in
    degraded mode: tools return a clear "not configured" message.
    """
    global _available, _dims, _model_name, _embed_base, _embed_key

    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as conn:
        _ensure_schema(conn)

    if not _BASE or not _MODEL:
        logger.warning(
            "memory: EMBEDDING_BASE_URL or EMBEDDING_MODEL not set — "
            "semantic memory disabled.  Set both env vars and configure an "
            "embedding model on oMLX (e.g. mlx-community/nomic-embed-text-v1.5-mlx) "
            "to enable it."
        )
        return

    # Probe the embedding endpoint and confirm the dimension.
    try:
        detected = _probe_embedding(_BASE, _MODEL, _KEY)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "memory: embedding probe failed for model %r at %s: %s — "
            "semantic memory disabled until the model is available.",
            _MODEL, _BASE, e,
        )
        return

    dims = _DIMS_OVERRIDE or detected
    if _DIMS_OVERRIDE and _DIMS_OVERRIDE != detected:
        logger.warning(
            "memory: EMBEDDING_DIMENSIONS=%d but model returned %d; using %d",
            _DIMS_OVERRIDE, detected, dims,
        )

    # Check for stored dimension mismatch (model changed).
    with _lock, _conn() as conn:
        stored = _stored_dims(conn)
        if stored and stored != dims:
            logger.error(
                "memory: embedding dimension changed from %d to %d — "
                "the existing index is incompatible.  Delete /data/memory.db "
                "and let it rebuild, or restore EMBEDDING_MODEL to the previous model.",
                stored, dims,
            )
            return

        if not stored:
            _store_config(conn,
                          embedding_model=_MODEL,
                          embedding_base_url=_BASE,
                          embedding_dims=dims)

        if not _load_vec(conn):
            logger.error(
                "memory: sqlite-vec extension could not be loaded — "
                "install the 'sqlite-vec' pip package and ensure Python's "
                "sqlite3 module supports extension loading.  "
                "Semantic memory disabled."
            )
            return

        _ensure_vss(conn, dims)

    _available   = True
    _dims        = dims
    _model_name  = _MODEL
    _embed_base  = _BASE
    _embed_key   = _KEY

    logger.info("memory: ready — model=%s dims=%d db=%s", _MODEL, dims, _DB_PATH)
    _start_background_indexer()


def _start_background_indexer() -> None:
    t = threading.Thread(target=_indexer_loop, name="memory-indexer", daemon=True)
    t.start()
    logger.debug("memory: background indexer started")


# ── Background indexer ────────────────────────────────────────────────────────

def _indexer_loop() -> None:
    """Runs forever in a daemon thread; picks up new records each POLL_SECONDS."""
    while True:
        try:
            _run_index_cycle()
        except Exception as e:  # noqa: BLE001
            logger.error("memory: index cycle error: %s", e)
            _stats["last_error"] = str(e)[:200]
        # Honour any reindex requests that came in during the cycle.
        _flush_reindex_requests()
        time.sleep(POLL_SECONDS)


def _run_index_cycle() -> None:
    """Incremental index: fetch new records from each source since the cursor."""
    _index_whatsapp()
    _index_psn_clips()
    _index_facts()
    ts = int(time.time())
    _stats["last_index_ts"] = ts
    # Persist so status() survives container restarts.
    try:
        with _lock, _conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO memory_config(key, value) VALUES ('last_index_run', ?)",
                (str(ts),),
            )
            conn.commit()
    except Exception as e:  # noqa: BLE001
        logger.debug("memory: could not persist last_index_run: %s", e)


def _flush_reindex_requests() -> None:
    with _reindex_lock:
        reqs = dict(_reindex_pending)
        _reindex_pending.clear()
    for source, since_ts in reqs.items():
        logger.info("memory: reindex requested for source=%s since=%s", source, since_ts)
        if source == "whatsapp":
            _index_whatsapp(since_ts=since_ts)
        elif source == "psn":
            _index_psn_clips(since_ts=since_ts)
        elif source == "facts":
            _index_facts(since_ts=since_ts)
        elif source == "all":
            _index_whatsapp(since_ts=since_ts)
            _index_psn_clips(since_ts=since_ts)
            _index_facts(since_ts=since_ts)


def _get_cursor(source: str) -> float:
    """Return the epoch timestamp we last indexed up to for this source."""
    with _conn() as conn:
        row = conn.execute(
            "SELECT value FROM memory_config WHERE key=?",
            (f"cursor_{source}",),
        ).fetchone()
    return float(row["value"]) if row else 0.0


def _set_cursor(source: str, ts: float) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO memory_config(key, value) VALUES (?, ?)",
            (f"cursor_{source}", str(ts)),
        )
        conn.commit()


# ── WhatsApp indexer ──────────────────────────────────────────────────────────

def _index_whatsapp(since_ts: float | None = None) -> None:
    """Index text messages from whatsapp_messages newer than the cursor."""
    try:
        import whatsapp_analytics as _wa
        wa_db = Path("/data/whatsapp.db")
        if not wa_db.exists():
            return
    except Exception:  # noqa: BLE001
        return

    cursor_key = "whatsapp"
    since = since_ts if since_ts is not None else _get_cursor(cursor_key)
    # Fetch in batches of BATCH_SIZE ordered by timestamp
    import sqlite3 as _sq3
    with _sq3.connect(wa_db, check_same_thread=False) as wa_conn:
        wa_conn.row_factory = _sq3.Row
        rows = wa_conn.execute(
            """SELECT id, sender_name, group_jid, timestamp, text, message_type,
                      from_me, reply_to
               FROM whatsapp_messages
               WHERE timestamp > ?
                 AND text IS NOT NULL
                 AND TRIM(text) != ''
                 AND is_media_omitted = 0
                 AND message_type = 'text'
               ORDER BY timestamp
               LIMIT ?""",
            (since, BATCH_SIZE),
        ).fetchall()

    if not rows:
        return

    texts = [r["text"][:MAX_TEXT_CHARS] for r in rows]
    try:
        vecs = _embed(texts, _embed_base, _model_name, _embed_key)
    except Exception as e:  # noqa: BLE001
        logger.warning("memory: WA embed batch failed: %s", e)
        _stats["embed_errors"] += 1
        return

    now = int(time.time() * 1000)
    max_ts = 0.0
    indexed = skipped = 0

    for row, text, vec in zip(rows, texts, vecs):
        rec_hash = hashlib.sha256(text.encode()).hexdigest()
        meta = json.dumps({
            "group_jid":   row["group_jid"] or "",
            "author":      row["sender_name"] or "",
            "from_me":     bool(row["from_me"]),
            "reply_to":    row["reply_to"] or None,
        })
        ok, was_new = _upsert_item(
            source="whatsapp",
            source_record_id=row["id"],
            source_hash=rec_hash,
            chunk_index=0,
            text=text,
            source_ts=row["timestamp"],
            created_at=now,
            metadata_json=meta,
            vec=vec,
        )
        if ok:
            if was_new:
                indexed += 1
            else:
                skipped += 1
        ts_val = float(row["timestamp"])
        if ts_val > max_ts:
            max_ts = ts_val

    _stats["indexed_total"] += indexed
    _stats["skipped_unchanged"] += skipped
    if max_ts:
        _set_cursor(cursor_key, max_ts)
    if indexed or skipped:
        logger.debug("memory: WA indexed=%d skipped=%d", indexed, skipped)

    # If we hit the batch limit there may be more records; recurse until caught up.
    if len(rows) == BATCH_SIZE:
        _index_whatsapp(since_ts=max_ts)


# ── PSN clips indexer ─────────────────────────────────────────────────────────

def _index_psn_clips(since_ts: float | None = None) -> None:
    """Index clip body/description text from clips.db."""
    clips_db = Path("/data/clips.db")
    if not clips_db.exists():
        return

    cursor_key = "psn"
    since = since_ts if since_ts is not None else _get_cursor(cursor_key)
    import sqlite3 as _sq3
    with _sq3.connect(clips_db, check_same_thread=False) as cdb:
        cdb.row_factory = _sq3.Row
        rows = cdb.execute(
            """SELECT message_uid, ugc_id, sender_online_id,
                      psn_created_at, psn_group_id, psn_group_name, body
               FROM clips
               WHERE body IS NOT NULL
                 AND TRIM(body) != ''
                 AND (psn_created_at * 1000) > ?
               ORDER BY psn_created_at
               LIMIT ?""",
            (since, BATCH_SIZE),
        ).fetchall()

    if not rows:
        return

    texts = [r["body"][:MAX_TEXT_CHARS] for r in rows]
    try:
        vecs = _embed(texts, _embed_base, _model_name, _embed_key)
    except Exception as e:  # noqa: BLE001
        logger.warning("memory: PSN embed batch failed: %s", e)
        _stats["embed_errors"] += 1
        return

    now = int(time.time() * 1000)
    max_ts = 0.0
    indexed = skipped = 0

    for row, text, vec in zip(rows, texts, vecs):
        rec_hash = hashlib.sha256(text.encode()).hexdigest()
        ts_ms = int((row["psn_created_at"] or 0) * 1000)
        meta = json.dumps({
            "ugc_id":       row["ugc_id"] or "",
            "sender":       row["sender_online_id"] or "",
            "group_id":     row["psn_group_id"] or "",
            "group_name":   row["psn_group_name"] or "",
        })
        ok, was_new = _upsert_item(
            source="psn",
            source_record_id=row["message_uid"],
            source_hash=rec_hash,
            chunk_index=0,
            text=text,
            source_ts=ts_ms,
            created_at=now,
            metadata_json=meta,
            vec=vec,
        )
        if ok:
            if was_new:
                indexed += 1
            else:
                skipped += 1
        raw_ts = (row["psn_created_at"] or 0) * 1000
        if raw_ts > max_ts:
            max_ts = raw_ts

    _stats["indexed_total"] += indexed
    _stats["skipped_unchanged"] += skipped
    if max_ts:
        _set_cursor(cursor_key, max_ts)
    if indexed or skipped:
        logger.debug("memory: PSN indexed=%d skipped=%d", indexed, skipped)
    if len(rows) == BATCH_SIZE:
        _index_psn_clips(since_ts=max_ts)


# ── Facts indexer ─────────────────────────────────────────────────────────────

def _index_facts(since_ts: float | None = None) -> None:
    """Index squad facts from assistant_facts.db."""
    facts_db = Path("/data/assistant_facts.db")
    if not facts_db.exists():
        return

    cursor_key = "facts"
    since_ms = int((since_ts or _get_cursor(cursor_key)) * 1000
                    if since_ts is not None else _get_cursor(cursor_key))
    import sqlite3 as _sq3
    with _sq3.connect(facts_db, check_same_thread=False) as fdb:
        fdb.row_factory = _sq3.Row
        rows = fdb.execute(
            """SELECT id, subject, text, author_sub, created_at
               FROM facts
               WHERE created_at > ?
               ORDER BY created_at
               LIMIT ?""",
            (since_ms or since_ts or 0, BATCH_SIZE),
        ).fetchall()

    if not rows:
        return

    texts = [
        (f"{r['subject']}: " if r["subject"] else "") + r["text"]
        for r in rows
    ]
    try:
        vecs = _embed(texts, _embed_base, _model_name, _embed_key)
    except Exception as e:  # noqa: BLE001
        logger.warning("memory: facts embed batch failed: %s", e)
        _stats["embed_errors"] += 1
        return

    now = int(time.time() * 1000)
    max_created = 0
    indexed = skipped = 0

    for row, text, vec in zip(rows, texts, vecs):
        rec_hash = hashlib.sha256(text.encode()).hexdigest()
        meta = json.dumps({
            "subject":    row["subject"] or "",
            "author_sub": row["author_sub"] or "",
        })
        ok, was_new = _upsert_item(
            source="facts",
            source_record_id=row["id"],
            source_hash=rec_hash,
            chunk_index=0,
            text=text,
            source_ts=row["created_at"],
            created_at=now,
            metadata_json=meta,
            vec=vec,
        )
        if ok:
            if was_new:
                indexed += 1
            else:
                skipped += 1
        if row["created_at"] > max_created:
            max_created = row["created_at"]

    _stats["indexed_total"] += indexed
    _stats["skipped_unchanged"] += skipped
    if max_created:
        # facts.created_at is epoch-ms; cursor is epoch-s for consistency with WA
        _set_cursor(cursor_key, max_created / 1000)
    if indexed or skipped:
        logger.debug("memory: facts indexed=%d skipped=%d", indexed, skipped)
    if len(rows) == BATCH_SIZE:
        _index_facts(since_ts=max_created / 1000 if max_created else None)


# ── Core index operations ─────────────────────────────────────────────────────

def _upsert_item(
    source: str,
    source_record_id: str,
    source_hash: str,
    chunk_index: int,
    text: str,
    source_ts: int | None,
    created_at: int,
    metadata_json: str,
    vec: list[float],
) -> tuple[bool, bool]:
    """Insert or update one memory item.  Returns (ok, is_new).

    If the source+record_id+hash+chunk combination already exists, nothing
    changes (is_new=False).  If the record exists with a different hash, the old
    vector is deleted and a new item is inserted.
    """
    vec_bytes = _serialize(vec)
    new_id = str(uuid.uuid4())

    with _lock, _conn() as conn:
        vec_loaded = _load_vec(conn)

        # Check whether this exact (source, record, hash, chunk) already exists.
        existing = conn.execute(
            """SELECT seq, source_hash FROM memory_items
               WHERE source=? AND source_record_id=? AND chunk_index=?
                 AND deleted_at IS NULL""",
            (source, source_record_id, chunk_index),
        ).fetchone()

        if existing:
            if existing["source_hash"] == source_hash:
                # Nothing changed — skip.
                return True, False
            # Content changed — soft-delete old item, hard-delete its vector.
            old_seq = existing["seq"]
            conn.execute(
                "UPDATE memory_items SET deleted_at=? WHERE seq=?",
                (created_at, old_seq),
            )
            if vec_loaded:
                try:
                    conn.execute("DELETE FROM memory_vss WHERE rowid=?", (old_seq,))
                except Exception as e:  # noqa: BLE001
                    logger.debug("memory: vec delete failed for seq=%d: %s", old_seq, e)

        # Insert new item.
        cur = conn.execute(
            """INSERT OR IGNORE INTO memory_items
               (id, source, source_record_id, source_hash, chunk_index,
                text, source_ts, created_at, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (new_id, source, source_record_id, source_hash, chunk_index,
             text, source_ts, created_at, metadata_json),
        )
        new_seq = cur.lastrowid
        if not new_seq:
            conn.commit()
            return True, False  # IGNORE hit (race)

        # Insert vector with the same rowid.
        if vec_loaded:
            try:
                conn.execute(
                    "INSERT INTO memory_vss(rowid, embedding) VALUES (?, ?)",
                    (new_seq, vec_bytes),
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("memory: vec insert failed for seq=%d: %s", new_seq, e)

        conn.execute(
            "INSERT INTO memory_index_log(source, record_id, op, detail, ts) "
            "VALUES (?, ?, 'index', ?, ?)",
            (source, source_record_id, f"dims={len(vec)}", created_at),
        )
        conn.commit()
    return True, True


def deactivate(source: str, source_record_id: str) -> int:
    """Soft-delete all memory items for a source record (e.g. message deleted).

    Returns the count of items deactivated.
    """
    now = int(time.time() * 1000)
    with _lock, _conn() as conn:
        vec_loaded = _load_vec(conn)
        rows = conn.execute(
            """SELECT seq FROM memory_items
               WHERE source=? AND source_record_id=? AND deleted_at IS NULL""",
            (source, source_record_id),
        ).fetchall()
        seqs = [r["seq"] for r in rows]
        if seqs:
            placeholders = ",".join("?" * len(seqs))
            conn.execute(
                f"UPDATE memory_items SET deleted_at=? WHERE seq IN ({placeholders})",
                [now] + seqs,
            )
            if vec_loaded:
                for seq in seqs:
                    try:
                        conn.execute("DELETE FROM memory_vss WHERE rowid=?", (seq,))
                    except Exception:  # noqa: BLE001
                        pass
            conn.commit()
    return len(seqs)


# ── Public API ────────────────────────────────────────────────────────────────

_QUERY_PREFIX = (
    "Instruct: Given a search query about squad gaming activity (WhatsApp messages, "
    "PSN clips, facts), retrieve the most relevant passages.\nQuery: "
)


def _query_with_prefix(query: str) -> str:
    """Prepend the task instruction for instruction-tuned embedding models.

    Qwen3-Embedding, E5-instruct, and similar models use this prefix on
    queries only — documents are embedded raw.  For plain BERT-style models
    the extra text is harmless (slightly longer input, same quality).
    """
    return _QUERY_PREFIX + query


def search(
    query: str,
    sources: list[str] | None = None,
    after_ts: float | None = None,
    before_ts: float | None = None,
    group_id: str = "",
    user_id: str = "",
    limit: int = 10,
) -> dict:
    """Embed `query` and return the top-N nearest memory items.

    Returns a dict suitable for JSON serialisation by the MCP tool.
    """
    limit = max(1, min(int(limit or 10), MAX_RESULTS))

    if not _available:
        return _not_available()

    t0 = time.monotonic()

    # Qwen3-Embedding and similar instruction-tuned models expect a task prefix
    # on queries (not on documents).  The prefix is a no-op for other models.
    query_input = _query_with_prefix(query[:MAX_TEXT_CHARS])

    # Embed the query.
    try:
        vecs = _embed([query_input], _embed_base, _model_name, _embed_key)
    except Exception as e:  # noqa: BLE001
        logger.warning("memory: search embed failed: %s", e)
        _stats["embed_errors"] += 1
        return {"error": f"embedding failed: {e}", "results": []}

    q_bytes = _serialize(vecs[0])

    with _conn() as conn:
        vec_loaded = _load_vec(conn)
        if not vec_loaded:
            return _not_available()

        # kNN from the vec table.
        try:
            vec_rows = conn.execute(
                """SELECT rowid, distance
                   FROM memory_vss
                   WHERE embedding MATCH ?
                     AND k = ?
                   ORDER BY distance""",
                (q_bytes, CANDIDATE_K),
            ).fetchall()
        except Exception as e:  # noqa: BLE001
            logger.warning("memory: vec search failed: %s", e)
            return {"error": f"vector search failed: {e}", "results": []}

        if not vec_rows:
            return {"results": []}

        # Fetch metadata and apply filters.
        seqs = [r["rowid"] for r in vec_rows]
        dist_by_seq = {r["rowid"]: r["distance"] for r in vec_rows}

        placeholders = ",".join("?" * len(seqs))
        meta_rows = conn.execute(
            f"""SELECT seq, id, source, source_record_id, text,
                       source_ts, metadata_json
                FROM memory_items
                WHERE seq IN ({placeholders})
                  AND deleted_at IS NULL""",
            seqs,
        ).fetchall()

    # Filter and build results.
    results = []
    for row in meta_rows:
        meta = json.loads(row["metadata_json"] or "{}")

        if sources and row["source"] not in sources:
            continue
        ts = row["source_ts"]
        if after_ts and ts and ts < after_ts * 1000:
            continue
        if before_ts and ts and ts > before_ts * 1000:
            continue
        if group_id and meta.get("group_id", meta.get("group_jid", "")) != group_id:
            continue
        if user_id:
            uid = meta.get("author", meta.get("sender", meta.get("author_sub", "")))
            if uid != user_id:
                continue

        # Build snippet (first 300 chars).
        text = row["text"] or ""
        snippet = text[:300] + ("…" if len(text) > 300 else "")

        # Title: first sentence or author + opening words.
        author = meta.get("author", meta.get("sender", ""))
        title = f"{author}: {text[:60]}…" if author else text[:80]

        import datetime as _dt
        ts_iso = (
            _dt.datetime.fromtimestamp(ts / 1000, tz=_dt.timezone.utc).isoformat()
            if ts else None
        )

        # sqlite-vec uses L2 distance for float vectors by default; convert
        # to a 0-1 similarity score (closer to 1 = better match).
        dist = dist_by_seq.get(row["seq"], 1.0)
        score = round(max(0.0, 1.0 - dist / 2.0), 4)

        results.append({
            "memory_id":       row["id"],
            "source":          row["source"],
            "source_record_id": row["source_record_id"],
            "timestamp":       ts_iso,
            "title":           title,
            "snippet":         snippet,
            "score":           score,
            "metadata":        {k: v for k, v in meta.items()
                                 if k not in ("author_sub",)},  # no internal ids
        })

    # Sort by original vector distance (best first), truncate to limit.
    results.sort(key=lambda r: -r["score"])
    results = results[:limit]

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    _stats["search_count"] += 1
    _stats["search_latency_ms_last"] = elapsed_ms

    return {"results": results, "count": len(results),
            "search_latency_ms": elapsed_ms}


def get(memory_id: str) -> dict:
    """Return metadata for a single memory item by UUID.  Never returns text credentials."""
    if not memory_id:
        return {"error": "memory_id required"}

    with _conn() as conn:
        row = conn.execute(
            """SELECT id, source, source_record_id, source_hash,
                      chunk_index, text, source_ts, created_at, metadata_json
               FROM memory_items
               WHERE id=? AND deleted_at IS NULL""",
            (memory_id,),
        ).fetchone()

    if not row:
        return {"error": "not found", "memory_id": memory_id}

    import datetime as _dt
    meta = json.loads(row["metadata_json"] or "{}")
    ts = row["source_ts"]

    return {
        "memory_id":       row["id"],
        "source":          row["source"],
        "source_record_id": row["source_record_id"],
        "chunk_index":     row["chunk_index"],
        "timestamp":       (_dt.datetime.fromtimestamp(ts / 1000, tz=_dt.timezone.utc).isoformat()
                            if ts else None),
        "text":            row["text"],
        "metadata":        {k: v for k, v in meta.items() if k not in ("author_sub",)},
        "indexed_at":      _dt.datetime.fromtimestamp(
                               row["created_at"] / 1000, tz=_dt.timezone.utc
                           ).isoformat(),
    }


def context(
    memory_id: str,
    before_count: int = 3,
    after_count: int = 3,
) -> dict:
    """Return the original source records surrounding a matched memory item.

    For WhatsApp items, fetches the nearby messages from whatsapp_messages.
    For other sources, returns just the matched item's text and a pointer to the
    original record.
    """
    before_count = max(0, min(int(before_count or 3), 20))
    after_count  = max(0, min(int(after_count  or 3), 20))

    item = get(memory_id)
    if "error" in item:
        return item

    if item["source"] == "whatsapp":
        return _wa_context(item, before_count, after_count)

    # For other sources, return the item itself.
    return {
        "memory_id":  memory_id,
        "source":     item["source"],
        "context":    [{"role": "match", "text": item["text"],
                        "timestamp": item["timestamp"],
                        "source_record_id": item["source_record_id"]}],
    }


def _wa_context(item: dict, before: int, after: int) -> dict:
    """Fetch before+after messages around the matched WhatsApp message."""
    wa_db = Path("/data/whatsapp.db")
    if not wa_db.exists():
        return {"error": "whatsapp.db not found"}

    rec_id = item["source_record_id"]
    import sqlite3 as _sq3
    import datetime as _dt

    with _sq3.connect(wa_db, check_same_thread=False) as wa_conn:
        wa_conn.row_factory = _sq3.Row

        # Get the timestamp of the matched message.
        anchor = wa_conn.execute(
            "SELECT timestamp, group_jid FROM whatsapp_messages WHERE id=?", (rec_id,)
        ).fetchone()
        if not anchor:
            return {"error": "source record not found in whatsapp.db",
                    "source_record_id": rec_id}

        ts = anchor["timestamp"]
        jid = anchor["group_jid"] or ""

        before_rows = wa_conn.execute(
            """SELECT id, sender_name, timestamp, text, message_type,
                      has_photo, has_video, has_audio, from_me
               FROM whatsapp_messages
               WHERE timestamp < ? AND (? = '' OR group_jid = ?)
               ORDER BY timestamp DESC LIMIT ?""",
            (ts, jid, jid, before),
        ).fetchall()
        before_rows = list(reversed(before_rows))

        anchor_row = wa_conn.execute(
            """SELECT id, sender_name, timestamp, text, message_type,
                      has_photo, has_video, has_audio, from_me
               FROM whatsapp_messages WHERE id=?""",
            (rec_id,),
        ).fetchone()

        after_rows = wa_conn.execute(
            """SELECT id, sender_name, timestamp, text, message_type,
                      has_photo, has_video, has_audio, from_me
               FROM whatsapp_messages
               WHERE timestamp > ? AND (? = '' OR group_jid = ?)
               ORDER BY timestamp ASC LIMIT ?""",
            (ts, jid, jid, after),
        ).fetchall()

    def _fmt(row, role="context") -> dict:
        ts_ms = row["timestamp"]
        return {
            "role":      role,
            "message_id": row["id"],
            "author":    row["sender_name"] or ("(you)" if row["from_me"] else ""),
            "timestamp": (_dt.datetime.fromtimestamp(ts_ms / 1000, tz=_dt.timezone.utc).isoformat()
                          if ts_ms else None),
            "text":      row["text"] or None,
            "media":     (True if any([row["has_photo"], row["has_video"],
                                       row["has_audio"]]) else None),
            "message_type": row["message_type"],
        }

    messages = (
        [_fmt(r) for r in before_rows]
        + ([_fmt(anchor_row, "match")] if anchor_row else [])
        + [_fmt(r) for r in after_rows]
    )

    return {
        "memory_id":  memory_id,
        "source":     "whatsapp",
        "group_jid":  jid,
        "context":    messages,
        "match_index": len(before_rows),
    }


def status() -> dict:
    """Return health and indexing stats.  Never reveals keys or credentials."""
    base_info: dict[str, Any] = {
        "embedding_available": _available,
        "embedding_model":     _model_name or "not configured",
        "embedding_dims":      _dims,
        "db_path":             str(_DB_PATH),
    }

    if not _DB_PATH.exists():
        return {**base_info, "note": "database not yet created"}

    with _conn() as conn:
        counts: dict[str, int] = {}
        for row in conn.execute(
            "SELECT source, COUNT(*) c FROM memory_items "
            "WHERE deleted_at IS NULL GROUP BY source"
        ).fetchall():
            counts[row["source"]] = row["c"]

        cursors: dict[str, Any] = {}
        for row in conn.execute(
            "SELECT key, value FROM memory_config WHERE key LIKE 'cursor_%'"
        ).fetchall():
            source = row["key"][7:]  # strip 'cursor_'
            import datetime as _dt
            try:
                ts = _dt.datetime.fromtimestamp(float(row["value"]),
                                                tz=_dt.timezone.utc).isoformat()
            except Exception:  # noqa: BLE001
                ts = row["value"]
            cursors[source] = ts

        recent_errors = conn.execute(
            """SELECT source, record_id, detail, ts
               FROM memory_index_log
               WHERE op = 'error'
               ORDER BY ts DESC LIMIT 5"""
        ).fetchall()

        # Persist last_index_run so status() survives container restarts.
        _lr = conn.execute(
            "SELECT value FROM memory_config WHERE key='last_index_run'"
        ).fetchone()
        persisted_last_run = int(_lr["value"]) if _lr else 0

    import datetime as _dt
    # In-memory value resets on restart; persisted value is the fallback.
    last_ts = _stats["last_index_ts"] or persisted_last_run

    return {
        **base_info,
        "indexed_counts":   counts,
        "cursors":          cursors,
        "last_index_run":   (_dt.datetime.fromtimestamp(last_ts, tz=_dt.timezone.utc).isoformat()
                             if last_ts else None),
        "stats": {
            "indexed_total":     _stats["indexed_total"],
            "skipped_unchanged": _stats["skipped_unchanged"],
            "embed_errors":      _stats["embed_errors"],
            "search_count":      _stats["search_count"],
            "search_latency_ms": _stats["search_latency_ms_last"],
        },
        "recent_index_errors": [
            {"source": r["source"], "record_id": r["record_id"],
             "detail": r["detail"]} for r in recent_errors
        ],
        "last_error": _stats.get("last_error") or None,
    }


def queue_reindex(source: str, since_ts: float | None = None) -> dict:
    """Enqueue a reindex request for the next background cycle.

    source: 'whatsapp' | 'psn' | 'facts' | 'all'
    since_ts: epoch-seconds lower bound, or None to reindex from the beginning
    """
    valid = {"whatsapp", "psn", "facts", "all"}
    if source not in valid:
        return {"error": f"unknown source {source!r}", "valid": sorted(valid)}

    if not _available:
        return _not_available()

    with _reindex_lock:
        _reindex_pending[source] = since_ts

    return {
        "ok": True,
        "source": source,
        "since": since_ts,
        "note": f"reindex for '{source}' queued; will run within {POLL_SECONDS}s",
    }


# ── Internal helpers ──────────────────────────────────────────────────────────

def _not_available() -> dict:
    return {
        "error": "semantic memory not available",
        "reason": (
            "No embedding model configured.  Set EMBEDDING_BASE_URL and "
            "EMBEDDING_MODEL to an OpenAI-compatible embeddings endpoint "
            "(e.g. mlx-community/nomic-embed-text-v1.5-mlx on oMLX) and "
            "restart the server.  See docs/memory.md."
        ),
    }
