"""Permanent clip archive storage abstraction.

Uses S3/MinIO when CLIP_BUCKET is set (boto3 already in requirements).
Falls back to local filesystem at /data/clips/ otherwise.
"""

import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

CLIP_BUCKET         = os.environ.get("CLIP_BUCKET", "")
CLIP_S3_ENDPOINT    = os.environ.get("CLIP_S3_ENDPOINT_URL", "")
CLIP_LOCAL_DIR      = Path(os.environ.get("CLIP_LOCAL_DIR", "/data/clips"))

# Safety: log storage key but NOT signed URLs
_MAX_CLIP_BYTES     = int(os.environ.get("CLIP_MAX_BYTES", str(500 * 1024 * 1024)))  # 500 MB


def storage_key(message_uid: str, psn_created_at: float | None = None) -> str:
    """Deterministic, filesystem-safe path for a clip.

    message_uid may contain '#' and other special chars, so we replace
    any non-alphanumeric/underscore/hyphen character with underscore.
    """
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", message_uid)
    if psn_created_at:
        dt = datetime.fromtimestamp(psn_created_at, tz=timezone.utc)
        return f"clips/original/{dt.year}/{dt.month:02d}/{safe}.mp4"
    return f"clips/original/undated/{safe}.mp4"


def _s3_client():
    import boto3
    kwargs: dict = {}
    if CLIP_S3_ENDPOINT:
        kwargs["endpoint_url"] = CLIP_S3_ENDPOINT
    return boto3.client("s3", **kwargs)


def archive(key: str, data: bytes) -> bool:
    """Store MP4 bytes at key. Returns True on success."""
    if len(data) > _MAX_CLIP_BYTES:
        logger.error("clip_store: refusing to archive %d bytes (limit %d) key=%s",
                     len(data), _MAX_CLIP_BYTES, key)
        return False

    if CLIP_BUCKET:
        try:
            _s3_client().put_object(
                Bucket=CLIP_BUCKET,
                Key=key,
                Body=data,
                ContentType="video/mp4",
            )
            logger.info("clip_store: archived s3://%s/%s (%d bytes)",
                        CLIP_BUCKET, key, len(data))
            return True
        except Exception as exc:
            logger.error("clip_store: S3 archive failed key=%s: %s", key, exc)
            return False

    path = CLIP_LOCAL_DIR / key
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        logger.info("clip_store: archived local %s (%d bytes)", path, len(data))
        return True
    except Exception as exc:
        logger.error("clip_store: local archive failed key=%s: %s", key, exc)
        return False


def load(key: str) -> bytes | None:
    """Load MP4 bytes by key. Returns None on failure."""
    if CLIP_BUCKET:
        try:
            resp = _s3_client().get_object(Bucket=CLIP_BUCKET, Key=key)
            data = resp["Body"].read()
            logger.info("clip_store: loaded s3://%s/%s (%d bytes)",
                        CLIP_BUCKET, key, len(data))
            return data
        except Exception as exc:
            logger.error("clip_store: S3 load failed key=%s: %s", key, exc)
            return None

    path = CLIP_LOCAL_DIR / key
    if not path.exists():
        logger.error("clip_store: local file not found: %s", path)
        return None
    data = path.read_bytes()
    logger.info("clip_store: loaded local %s (%d bytes)", path, len(data))
    return data


def local_file(key: str) -> Path | None:
    """Resolved on-disk path for a key on the filesystem backend, else None.

    Returning a path lets the caller hand the file to Starlette's FileResponse,
    which serves Range requests — so a client can seek or resume instead of
    pulling a whole 500 MB clip through app memory. S3 has no path, so callers
    must fall back to `stream()` there.

    The key comes from the database, never from a request, but this still
    re-checks containment: one bad key with '..' in it would otherwise read any
    file the process can see.
    """
    if CLIP_BUCKET:
        return None
    root = CLIP_LOCAL_DIR.resolve()
    try:
        path = (root / key).resolve()
        path.relative_to(root)
    except (ValueError, OSError):
        logger.error("clip_store: key escapes the clip root, refusing: %r", key)
        return None
    return path if path.is_file() else None


def stream(key: str, chunk_size: int = 1024 * 256):
    """Yield MP4 bytes for a key without holding the whole clip in memory."""
    if CLIP_BUCKET:
        try:
            body = _s3_client().get_object(Bucket=CLIP_BUCKET, Key=key)["Body"]
        except Exception as exc:
            logger.error("clip_store: S3 stream failed key=%s: %s", key, exc)
            return
        try:
            while True:
                chunk = body.read(chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            body.close()
        return

    path = local_file(key)
    if not path:
        logger.error("clip_store: stream miss for key=%s", key)
        return
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            yield chunk


def available() -> bool:
    """True if storage is configured and writable."""
    if CLIP_BUCKET:
        try:
            _s3_client().head_bucket(Bucket=CLIP_BUCKET)
            return True
        except Exception:
            return False
    try:
        CLIP_LOCAL_DIR.mkdir(parents=True, exist_ok=True)
        return True
    except Exception:
        return False


def usage() -> dict:
    """Storage-level archive usage: total bytes and file count under clips/.

    Local backend walks the clip root; S3 lists the bucket with a paginator
    (capped at 500 pages / ~500k objects with a truncation flag). Returns
    {"bytes": int|None, "files": int|None, ...}; bytes/files are None with an
    "error" key when the scan itself fails, so callers can distinguish "empty"
    from "unknown".
    """
    if CLIP_BUCKET:
        try:
            paginator = _s3_client().get_paginator("list_objects_v2")
            total, files, pages, truncated = 0, 0, 0, False
            for page in paginator.paginate(Bucket=CLIP_BUCKET, Prefix="clips/"):
                pages += 1
                if pages > 500:
                    truncated = True
                    logger.warning("clip_store: usage scan truncated at 500 pages")
                    break
                for obj in page.get("Contents", []):
                    total += obj.get("Size", 0)
                    files += 1
            out = {"bytes": total, "files": files}
            if truncated:
                out["truncated"] = True
            return out
        except Exception as exc:
            logger.error("clip_store: usage scan failed: %s", exc)
            return {"bytes": None, "files": None, "error": str(exc)}

    total, files = 0, 0
    root = CLIP_LOCAL_DIR
    if root.exists():
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                try:
                    total += (Path(dirpath) / fn).stat().st_size
                    files += 1
                except OSError:
                    pass
    return {"bytes": total, "files": files}


def backend() -> str:
    return f"s3://{CLIP_BUCKET}" if CLIP_BUCKET else str(CLIP_LOCAL_DIR)
