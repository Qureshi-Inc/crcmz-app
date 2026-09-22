"""Weekly coaching feedback digest.

Groups review_feedback rows by game and surfaces patterns (2+ players sharing
the same tag on the same game). Writes a dated markdown digest.

Output path: /data/feedback_digests/YYYY-Www.md (e.g. 2026-W40.md)
Note: the contract path in the Muse task spec is
  /opt/ai-lab/projects/ai-coach-dashboard/feedback_digests/
but this platform runs in Docker where /opt/ai-lab is not mounted. Digests are
written to /data/feedback_digests/ instead. Muse's cron should pull from there.

Run manually: python3 coach_digest.py
Run via cron: add a weekly CronJob that runs this script.

Privacy: no player names, PSN IDs, or identifying comment text in the output.
"""

from __future__ import annotations

import datetime
import logging
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_OUTPUT_DIR = Path("/data/feedback_digests")
_LOOKBACK_DAYS = 7


def run(lookback_days: int = _LOOKBACK_DAYS) -> Path:
    import time
    import coach

    coach.init()
    since = time.time() - lookback_days * 86400
    patterns = coach.feedback_patterns(since, min_count=2)

    now = datetime.datetime.now(tz=datetime.timezone.utc)
    iso_week = now.strftime("%G-W%V")
    _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = _OUTPUT_DIR / f"{iso_week}.md"

    lines = [
        f"# Coaching feedback digest — {iso_week}",
        f"\nGenerated {now.strftime('%Y-%m-%d %H:%M UTC')} "
        f"covering the last {lookback_days} day(s).",
        "\nPatterns shown where 2+ players share the same tag on the same game.",
        "\n---\n",
    ]

    if not patterns:
        lines.append("_No patterns found in this period._\n")
    else:
        current_game = None
        for p in patterns:
            game = p["game"]
            if game != current_game:
                if current_game is not None:
                    lines.append("")
                lines.append(f"## {game}")
                current_game = game
            review_refs = ", ".join(f"`{rid[:8]}`" for rid in p["review_ids"][:5])
            suffix = f" *(+{len(p['review_ids'])-5} more)*" if len(p["review_ids"]) > 5 else ""
            lines.append(
                f"- **{p['tag']}** — {p['count']} player(s) · "
                f"reviews: {review_refs}{suffix}"
            )
        lines.append("")

    content = "\n".join(lines)
    out_path.write_text(content, encoding="utf-8")
    logger.info("digest written to %s (%d patterns)", out_path, len(patterns))
    return out_path


if __name__ == "__main__":
    path = run()
    print(f"Digest: {path}")
    sys.exit(0)
