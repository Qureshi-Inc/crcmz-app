"""Speaker voice-print enrollment and identification using librosa MFCC features.

Lightweight alternative to neural speaker embeddings: extracts a 40-dim mean
MFCC vector from the audio and uses cosine similarity for matching. No PyTorch,
no compiler — just librosa + soundfile (libsndfile1 system dep).

Accuracy is sufficient for a small closed-set squad (5-15 people) in a
consistent recording environment. Below-threshold matches return None so
anonymous speakers stay anonymous.
"""
from __future__ import annotations

import io
import logging
import sqlite3
import struct
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/voice_prints.db")
_lock = threading.Lock()

THRESHOLD = 0.92   # cosine similarity floor (MFCC vectors cluster tighter than GE2E)
EMBED_DIM = 40     # n_mfcc


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS voice_prints (
                zitadel_id   TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                embedding    BLOB NOT NULL,
                enrolled_at  INTEGER NOT NULL
            );
        """)


def _to_wav(audio_bytes: bytes) -> bytes:
    """Convert any browser audio (WebM/Opus/MP4) to 16 kHz mono WAV via ffmpeg."""
    import os, subprocess, tempfile
    with tempfile.NamedTemporaryFile(suffix='.input', delete=False) as f:
        f.write(audio_bytes)
        in_path = f.name
    out_path = in_path + '.wav'
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-i', in_path, '-ac', '1', '-ar', '16000', '-f', 'wav', out_path],
            check=True, capture_output=True,
        )
        with open(out_path, 'rb') as f:
            return f.read()
    except subprocess.CalledProcessError as e:
        raise ValueError(f"ffmpeg conversion failed: {e.stderr[-200:].decode(errors='replace')}") from e
    finally:
        os.unlink(in_path)
        if os.path.exists(out_path):
            os.unlink(out_path)


def _embed(audio_bytes: bytes) -> list[float]:
    """Extract a 40-dim mean MFCC vector from raw audio bytes (any format ffmpeg handles)."""
    import librosa
    import numpy as np
    try:
        wav_bytes = _to_wav(audio_bytes)
        y, sr = librosa.load(io.BytesIO(wav_bytes), sr=16000, mono=True)
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"audio load failed: {e}") from e
    if len(y) < sr:  # < 1 second
        raise ValueError("audio too short for voice enrollment (need at least 1 second)")
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=EMBED_DIM)
    vec = mfcc.mean(axis=1)  # (40,) — mean across time frames
    return vec.tolist()


def _cosine(a: list[float], b: list[float]) -> float:
    import numpy as np
    va, vb = np.array(a, dtype=np.float32), np.array(b, dtype=np.float32)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom == 0:
        return 0.0
    return float(np.dot(va, vb) / denom)


def _pack(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack(blob: bytes) -> list[float]:
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


def enroll(sub: str, name: str, audio_bytes: bytes) -> None:
    """Embed audio and upsert the voice print for this user."""
    vec = _embed(audio_bytes)
    blob = _pack(vec)
    now = int(time.time())
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO voice_prints(zitadel_id, display_name, embedding, enrolled_at) "
            "VALUES(?,?,?,?) ON CONFLICT(zitadel_id) DO UPDATE SET "
            "display_name=excluded.display_name, embedding=excluded.embedding, enrolled_at=excluded.enrolled_at",
            (sub, name, blob, now),
        )


def identify(audio_bytes: bytes) -> dict | None:
    """Return the best-matching enrolled user, or None if confidence < THRESHOLD."""
    try:
        query_vec = _embed(audio_bytes)
    except ValueError as e:
        logger.debug("voice_id identify: %s", e)
        return None
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT zitadel_id, display_name, embedding FROM voice_prints"
        ).fetchall()
    if not rows:
        return None
    best_sub, best_name, best_score = None, None, -1.0
    for row in rows:
        vec = _unpack(row["embedding"])
        score = _cosine(query_vec, vec)
        if score > best_score:
            best_score, best_sub, best_name = score, row["zitadel_id"], row["display_name"]
    if best_score < THRESHOLD:
        return None
    return {"sub": best_sub, "name": best_name, "confidence": round(best_score, 4)}


def delete(sub: str) -> bool:
    with _lock, _conn() as db:
        c = db.execute("DELETE FROM voice_prints WHERE zitadel_id = ?", (sub,))
        return c.rowcount > 0


def has_print(sub: str) -> bool:
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT enrolled_at FROM voice_prints WHERE zitadel_id = ?", (sub,)
        ).fetchone()
        return row is not None


def get_enrolled_at(sub: str) -> int | None:
    with _lock, _conn() as db:
        row = db.execute(
            "SELECT enrolled_at FROM voice_prints WHERE zitadel_id = ?", (sub,)
        ).fetchone()
        return row["enrolled_at"] if row else None


def count() -> int:
    with _lock, _conn() as db:
        return db.execute("SELECT COUNT(*) FROM voice_prints").fetchone()[0]
