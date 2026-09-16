#!/usr/bin/env python3
"""One-shot repair for WhatsApp history imported with the wrong date order.

The importer used to guess day-first ("9/12/26" = 9 December) per line, but the
Goopers export is a North American M/D/YY file, so every date whose two parts
were both <= 12 came out with the day and month swapped -- 1028 messages ended
up dated in the *future*. parse_txt() now decides the order per file
(detect_date_order); this fixes the rows already in the database.

For a row that was mis-swapped, the stored day is the real month and the stored
month is the real day. Rows whose stored day is > 12 could only have come from
the correct branch, so they are left alone.

Run against the live container (nothing is written without --apply):

    docker exec -i <app-container> python - < tools/wa_fix_dates.py
    docker exec -i <app-container> python - --apply < tools/wa_fix_dates.py
"""

import sqlite3
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DB_PATH = Path("/data/whatsapp.db")
TZ = ZoneInfo("America/Los_Angeles")
APPLY = "--apply" in sys.argv[1:]


def main() -> int:
    if not DB_PATH.exists():
        print(f"no database at {DB_PATH}")
        return 1
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    now = int(time.time())

    rows = db.execute(
        "SELECT id, timestamp, sender_name FROM whatsapp_messages "
        "WHERE source='historical_export'"
    ).fetchall()

    fixes: list[tuple[int, str]] = []
    skipped_invalid = 0
    for r in rows:
        dt = datetime.fromtimestamp(r["timestamp"], TZ)
        if dt.day > 12:
            continue                      # unambiguous, already correct
        try:
            fixed = dt.replace(month=dt.day, day=dt.month)
        except ValueError:                # e.g. month=2 day=30
            skipped_invalid += 1
            continue
        fixes.append((int(fixed.timestamp()), r["id"]))

    before = [datetime.fromtimestamp(r["timestamp"], TZ) for r in rows]
    changed = {rid: ts for ts, rid in fixes}
    after = [
        datetime.fromtimestamp(changed.get(r["id"], r["timestamp"]), TZ) for r in rows
    ]

    def summary(label, dates):
        future = sum(1 for d in dates if d.timestamp() > now)
        print(f"  {label}: {len(dates)} rows, {future} in the future, "
              f"newest {max(dates).isoformat(sep=' ')[:16]}")
        print(f"    per month: {sorted(Counter(d.month for d in dates).items())}")

    print(f"historical_export rows: {len(rows)}")
    print(f"day<=12 rows to swap:   {len(fixes)}   (invalid after swap: {skipped_invalid})")
    summary("before", before)
    summary("after ", after)

    old_ts = {r["id"]: r["timestamp"] for r in rows}
    print("  samples (before -> after):")
    for ts, rid in fixes[:5]:
        print("   ", datetime.fromtimestamp(old_ts[rid], TZ).isoformat(sep=" ")[:16],
              "->", datetime.fromtimestamp(ts, TZ).isoformat(sep=" ")[:16])

    still_future = sum(1 for d in after if d.timestamp() > now)
    if still_future:
        print(f"REFUSING: {still_future} rows would still be in the future — "
              "the export is probably not M/D/YY after all.")
        return 2

    if not APPLY:
        print("\ndry run — pass --apply to write these changes")
        return 0

    with db:
        db.executemany(
            "UPDATE whatsapp_messages SET timestamp=? WHERE id=?", fixes
        )
    print(f"\napplied: {len(fixes)} timestamps corrected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
