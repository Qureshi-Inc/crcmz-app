"""Month-end storage cleanup: after a month's montage is published, drop media
older than KEEP_DAYS.

Nothing is deleted between montages, so the montage always has the whole month
to pick from. Once `montage_record` holds both the Instagram and TikTok links
for a month, `run()` deletes:

* PSN clip archive files        -> clips row flips to archive_status='purged'
* member uploads, once posted or skipped -> video_posts.media_purged_at
* montage renders (master/delivery mp4; manifests are kept)
* reel-review's cached sources, frames and renders (POST /api/prune)

Database rows stay, so stats, history, links and montage records keep working.
The cutoff is also capped at the end of the latest published month, so a run can
never reach into a month whose montage is not out yet.
"""

from __future__ import annotations

import logging
import os
import time

logger = logging.getLogger(__name__)

KEEP_DAYS = 14


def _published_until() -> float | None:
    """End (epoch) of the latest month whose montage has both links, else None."""
    import month_montage
    month_montage.init()
    done = [r for r in month_montage.list_records(limit=240)
            if r.get("ig_url") and r.get("tiktok_url")]
    if not done:
        return None
    latest = max(done, key=lambda r: r["month"])
    return month_montage.month_window(latest["month"], latest.get("timezone") or "")[1]


def _prune_reel_review(keep_days: int) -> dict:
    url = os.environ.get("REEL_REVIEW_URL", "http://reel-review:8080").rstrip("/")
    token = os.environ.get("REEL_REVIEW_TOKEN", "")
    if not token:
        return {"skipped": "reel review is not configured"}
    try:
        import httpx
        r = httpx.post(f"{url}/api/prune", json={"older_than_days": keep_days},
                       headers={"X-App-Token": token}, timeout=60)
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001 - the local purge still counts
        logger.warning("retention: reel-review prune failed: %s", e)
        return {"error": str(e)}


def _prune_montages(cutoff: float) -> dict:
    import clip_store
    if clip_store.CLIP_BUCKET:
        return {"skipped": "montages are only pruned on the local store"}
    root = clip_store.CLIP_LOCAL_DIR / "montages"
    removed = freed = 0
    if root.is_dir():
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.endswith(".mp4"):
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    st = os.stat(p)
                    if st.st_mtime < cutoff:
                        os.unlink(p)
                        removed += 1
                        freed += st.st_size
                except OSError as e:
                    logger.warning("retention: could not remove %s: %s", p, e)
    return {"files": removed, "bytes": freed}


def run(now: float | None = None, keep_days: int = KEEP_DAYS) -> dict:
    """Delete media older than `keep_days`, never past the last published month."""
    import clip_store
    import clips as clips_mod
    import video_uploads as vu

    now = time.time() if now is None else now
    until = _published_until()
    if until is None:
        return {"ok": True, "skipped": "no published montage yet — nothing deleted"}
    cutoff = min(now - keep_days * 86400, until)

    clips_mod.init()
    freed = removed = 0
    for row in clips_mod.archived_before(cutoff):
        size = 0
        for key in (row.get("storage_key_original"), row.get("storage_key_normalized")):
            if key:
                size += clip_store.delete(key)
        clips_mod.set_purged(row["message_uid"])
        removed += 1
        freed += size

    vu.init()
    up_removed = up_freed = 0
    for row in vu.purgeable_before(cutoff):
        up_freed += clip_store.delete(row["storage_key"])
        vu.set_media_purged(row["video_post_id"])
        up_removed += 1

    summary = {
        "ok": True, "cutoff": cutoff,
        "cutoff_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(cutoff)),
        "clips": {"files": removed, "bytes": freed},
        "uploads": {"files": up_removed, "bytes": up_freed},
        "montages": _prune_montages(cutoff),
        "reel_review": _prune_reel_review(keep_days),
    }
    logger.info("retention: %s", summary)
    return summary
