"""What the squad actually plays: PSN title counters plus observed sessions.

Until this module the platform knew what everyone was playing *right now* and
forgot it three minutes later. `psn_data._presence()` reads `titleName` and
`_recent_game()` reads PSN's game list, both every poll, and neither was ever
written down -- so "what games did we play" had no answer anywhere, and the only
mention of a game title in the whole app was the hardcoded "Arc Raiders, Call of
Duty" prose in a tool description.

Two tables, because PSN gives two genuinely different kinds of truth:

`game_titles` is PSN's own per-account counters -- `playCount`, `playDuration`,
`firstPlayedDateTime`, `lastPlayedDateTime`. This is **retroactive**: the first
successful sweep backfills each person's entire PS4/PS5 history, so the data is
useful immediately rather than only accumulating from today. It is authoritative
for "how long has Zubi played this", and it is stored unfiltered -- unlike the
dashboard, which shows only `GAME_WHITELIST` titles.

`play_sessions` is what *we* observed: consecutive presence samples of the same
title collapsed into one session. PSN's counters cannot tell you that four
people were in Arc Raiders at 1am on a Friday together; sessions can. A gap
longer than SESSION_GAP_SEC starts a new session, so a poll outage splits a
session rather than inventing an eight-hour one.

Rows are keyed by PSN `online_id`, matching `clips.sender_online_id`, and join to
people through `crcmz_identity` (`tags.psn_id`, which now also self-heals from the
portal link). Names are resolved at read time, never stored, so a rename in
Zitadel does not orphan history.

Nothing here reaches the network and nothing here holds a credential: the caller
passes in already-fetched payloads.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

DB_PATH = Path("/data/game_history.db")

_TZ = ZoneInfo("America/Los_Angeles")
_lock = threading.Lock()

# The poller ticks every 180s. Twenty minutes of silence is treated as "they
# stopped", which tolerates a few missed ticks without welding two evenings into
# one session.
SESSION_GAP_SEC = 20 * 60

_RANGES = ("today", "last_7_days", "last_30_days", "last_90_days",
           "this_month", "prev_month", "this_year", "all_time")


def _conn() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def init() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS game_titles (
                online_id       TEXT NOT NULL,
                title_id        TEXT NOT NULL,
                name            TEXT,
                image_url       TEXT,
                category        TEXT,
                platform        TEXT,
                play_count      INTEGER,
                play_seconds    INTEGER,
                first_played_at INTEGER,
                last_played_at  INTEGER,
                updated_at      INTEGER,
                PRIMARY KEY (online_id, title_id)
            );
            CREATE INDEX IF NOT EXISTS idx_titles_last
                ON game_titles (last_played_at DESC);
            CREATE INDEX IF NOT EXISTS idx_titles_name ON game_titles (name);

            CREATE TABLE IF NOT EXISTS play_sessions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                online_id    TEXT NOT NULL,
                game         TEXT NOT NULL,
                started_at   INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                samples      INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_who
                ON play_sessions (online_id, last_seen_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_seen
                ON play_sessions (last_seen_at DESC);
            """
        )
        db.commit()


# ── parsing PSN's payload ─────────────────────────────────────────────────────

_ISO_DUR = re.compile(
    r"^P(?:(?P<d>\d+)D)?T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>[\d.]+)S)?$"
)


def duration_seconds(value: str | None) -> int:
    """`playDuration` arrives as an ISO-8601 duration, e.g. 'PT138H23M11S'.

    Returns 0 rather than raising on anything unexpected -- a weird duration must
    not cost us the rest of a person's library.
    """
    if not value or not isinstance(value, str):
        return 0
    m = _ISO_DUR.match(value.strip())
    if not m:
        return 0
    d, h, mi, s = m.group("d"), m.group("h"), m.group("m"), m.group("s")
    try:
        return int((int(d or 0) * 86400) + (int(h or 0) * 3600)
                   + (int(mi or 0) * 60) + float(s or 0))
    except ValueError:
        return 0


def _epoch(value: str | None) -> int | None:
    """PSN timestamps are ISO-8601 with a trailing Z."""
    if not value or not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def record_titles(online_id: str, titles: list[dict]) -> int:
    """Upsert one person's PSN game list. Returns the number of rows touched.

    Called with the raw `titles` array from the gamelist endpoint, unfiltered, so
    the stored library is everything they own rather than just the whitelisted
    titles the dashboard chooses to show.
    """
    online_id = (online_id or "").strip()
    if not online_id or not titles:
        return 0

    now = int(time.time())
    rows = []
    for t in titles:
        if not isinstance(t, dict):
            continue
        tid = (t.get("titleId") or "").strip()
        name = (t.get("name") or t.get("localizedName") or "").strip()
        if not tid or not name:
            continue
        rows.append((
            online_id, tid, name,
            (t.get("imageUrl") or "").replace("http://", "https://"),
            t.get("category") or "",
            t.get("service") or t.get("platform") or "",
            int(t.get("playCount") or 0),
            duration_seconds(t.get("playDuration")),
            _epoch(t.get("firstPlayedDateTime")),
            _epoch(t.get("lastPlayedDateTime")),
            now,
        ))
    if not rows:
        return 0

    with _lock, _conn() as db:
        # PSN's counters only ever move forward, so a plain upsert is right; but
        # guard with max() anyway so a partial/stale response cannot walk a
        # playtime backwards.
        db.executemany(
            """
            INSERT INTO game_titles (online_id, title_id, name, image_url,
                category, platform, play_count, play_seconds,
                first_played_at, last_played_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(online_id, title_id) DO UPDATE SET
                name           = excluded.name,
                image_url      = excluded.image_url,
                category       = excluded.category,
                platform       = excluded.platform,
                play_count     = MAX(play_count, excluded.play_count),
                play_seconds   = MAX(play_seconds, excluded.play_seconds),
                first_played_at= COALESCE(MIN(first_played_at,
                                     excluded.first_played_at), excluded.first_played_at),
                last_played_at = MAX(COALESCE(last_played_at, 0),
                                     COALESCE(excluded.last_played_at, 0)),
                updated_at     = excluded.updated_at
            """,
            rows,
        )
        db.commit()
    return len(rows)


def record_presence(online_id: str, game: str | None, *, at: int | None = None) -> str:
    """Fold one presence observation into a session.

    Returns "opened", "extended" or "ignored" so the caller (and the tests) can
    see what happened. An empty game is ignored rather than closing anything --
    sessions are closed implicitly by the gap, which means a missed poll cannot
    truncate a session that is still running.
    """
    online_id = (online_id or "").strip()
    game = (game or "").strip()
    if not online_id or not game:
        return "ignored"
    now = int(at if at is not None else time.time())

    with _lock, _conn() as db:
        row = db.execute(
            "SELECT id, game, last_seen_at FROM play_sessions "
            "WHERE online_id = ? ORDER BY last_seen_at DESC LIMIT 1",
            (online_id,),
        ).fetchone()
        if (row and row["game"] == game
                and 0 <= now - row["last_seen_at"] <= SESSION_GAP_SEC):
            db.execute(
                "UPDATE play_sessions SET last_seen_at = ?, samples = samples + 1 "
                "WHERE id = ?",
                (max(now, row["last_seen_at"]), row["id"]),
            )
            db.commit()
            return "extended"
        db.execute(
            "INSERT INTO play_sessions (online_id, game, started_at, last_seen_at, "
            "samples) VALUES (?,?,?,?,1)",
            (online_id, game, now, now),
        )
        db.commit()
        return "opened"


def record_sweep(squad: list[dict]) -> dict:
    """Record presence for a whole `psn_data.squad_status()` result."""
    out = {"opened": 0, "extended": 0, "ignored": 0}
    for m in squad or []:
        if not isinstance(m, dict):
            continue
        # `game` is set by the sweep for anyone in a title, including the
        # lastPlayedDateTime fallback for cross-play titles that report offline.
        out[record_presence(m.get("online_id"), m.get("game"))] += 1
    return out


# ── reading ───────────────────────────────────────────────────────────────────

def _ts_bounds(range_str: str) -> tuple[int | None, int | None]:
    """Same windows as whatsapp_analytics, deliberately duplicated.

    Copying ~20 lines of pure date arithmetic keeps this module standalone; the
    alternative is importing whatsapp_analytics (and opening whatsapp.db) just to
    subtract some days.
    """
    import calendar
    now = datetime.now(_TZ)
    if range_str == "today":
        s = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return int(s.timestamp()), None
    if range_str in ("last_7_days", "last_30_days", "last_90_days"):
        return int(now.timestamp()) - int(range_str.split("_")[1]) * 86400, None
    if range_str == "this_month":
        return int(datetime(now.year, now.month, 1, tzinfo=_TZ).timestamp()), None
    if range_str == "prev_month":
        m = now.month - 1 or 12
        y = now.year if now.month > 1 else now.year - 1
        _, days = calendar.monthrange(y, m)
        return (int(datetime(y, m, 1, tzinfo=_TZ).timestamp()),
                int(datetime(y, m, days, 23, 59, 59, tzinfo=_TZ).timestamp()))
    if range_str == "this_year":
        return int(datetime(now.year, 1, 1, tzinfo=_TZ).timestamp()), None
    return None, None


def _person(online_id: str, cache: dict) -> str:
    """PSN id -> display name via the identity graph, cached per call."""
    if online_id in cache:
        return cache[online_id]
    name = online_id
    try:
        import crcmz_identity
        hit = crcmz_identity.by_psn_id().get(online_id)
        if hit:
            name = hit.get("display_name") or hit.get("username") or online_id
    except Exception as e:  # noqa: BLE001
        logger.debug("game_history: identity lookup failed (%s)", e)
    cache[online_id] = name
    return name


def top_games(range: str = "all_time", limit: int = 20) -> dict:  # noqa: A002
    """Most-played titles across the squad, by PSN's own playtime counters.

    `range` filters on last_played_at, because PSN gives a total playtime with no
    per-day breakdown -- so a windowed result means "titles touched in this
    window, with their lifetime hours", not "hours played in this window". The
    session view is the one that can answer the latter.
    """
    limit = max(1, min(int(limit or 20), 100))
    s, e = _ts_bounds(range)
    where, args = [], []
    if s is not None:
        where.append("COALESCE(last_played_at, 0) >= ?"); args.append(s)
    if e is not None:
        where.append("COALESCE(last_played_at, 0) <= ?"); args.append(e)
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    if not DB_PATH.exists():
        return {"range": range, "games": [], "note": "no game history recorded yet"}

    cache: dict[str, str] = {}
    with _conn() as db:
        rows = db.execute(
            f"""SELECT name,
                       SUM(play_seconds) AS secs,
                       SUM(play_count)   AS plays,
                       COUNT(DISTINCT online_id) AS players,
                       MAX(last_played_at) AS last_at
                FROM game_titles {clause}
                GROUP BY LOWER(name)
                ORDER BY secs DESC LIMIT ?""",
            (*args, limit),
        ).fetchall()
        games = []
        for r in rows:
            who = db.execute(
                "SELECT online_id, play_seconds FROM game_titles "
                "WHERE LOWER(name) = LOWER(?) ORDER BY play_seconds DESC",
                (r["name"],),
            ).fetchall()
            games.append({
                "game": r["name"],
                "hours": round((r["secs"] or 0) / 3600, 1),
                "launches": r["plays"] or 0,
                "players": r["players"],
                "last_played": _iso(r["last_at"]),
                "by_player": [{"who": _person(w["online_id"], cache),
                               "psn_id": w["online_id"],
                               "hours": round((w["play_seconds"] or 0) / 3600, 1)}
                              for w in who],
            })
    return {"range": range, "count": len(games), "games": games,
            "measured_by": "PSN lifetime playtime per account"}


def sessions(range: str = "all_time", who: str = "", limit: int = 20) -> dict:  # noqa: A002
    """Observed play sessions, newest first -- who was in what, and when."""
    limit = max(1, min(int(limit or 20), 100))
    s, e = _ts_bounds(range)
    where, args = [], []
    if s is not None:
        where.append("last_seen_at >= ?"); args.append(s)
    if e is not None:
        where.append("last_seen_at <= ?"); args.append(e)
    if who:
        where.append("online_id = ?"); args.append(who)
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    if not DB_PATH.exists():
        return {"range": range, "sessions": [], "note": "no sessions recorded yet"}

    cache: dict[str, str] = {}
    with _conn() as db:
        rows = db.execute(
            f"""SELECT online_id, game, started_at, last_seen_at, samples
                FROM play_sessions {clause}
                ORDER BY last_seen_at DESC LIMIT ?""",
            (*args, limit),
        ).fetchall()
    return {
        "range": range,
        "count": len(rows),
        "sessions": [{
            "who": _person(r["online_id"], cache),
            "psn_id": r["online_id"],
            "game": r["game"],
            "started": _iso(r["started_at"]),
            "ended": _iso(r["last_seen_at"]),
            "minutes": max(1, round((r["last_seen_at"] - r["started_at"]) / 60)),
            "observations": r["samples"],
        } for r in rows],
        "caveat": ("minutes are observed between the first and last presence "
                   "sample, so a session is accurate to about 3 minutes and a "
                   "gap over 20 minutes is recorded as two sessions"),
    }


def person_games(online_id: str, limit: int = 8) -> dict:
    """One person's library and last session, for person_profile."""
    online_id = (online_id or "").strip()
    if not online_id or not DB_PATH.exists():
        return {"titles": 0, "top": [], "last_session": None}
    limit = max(1, min(int(limit or 8), 50))
    with _conn() as db:
        rows = db.execute(
            "SELECT name, play_seconds, play_count, last_played_at FROM game_titles "
            "WHERE online_id = ? ORDER BY play_seconds DESC LIMIT ?",
            (online_id, limit),
        ).fetchall()
        total = db.execute(
            "SELECT COUNT(*) c, SUM(play_seconds) s FROM game_titles WHERE online_id = ?",
            (online_id,),
        ).fetchone()
        last = db.execute(
            "SELECT game, started_at, last_seen_at FROM play_sessions "
            "WHERE online_id = ? ORDER BY last_seen_at DESC LIMIT 1",
            (online_id,),
        ).fetchone()
    return {
        "titles": total["c"] or 0,
        "total_hours": round((total["s"] or 0) / 3600, 1),
        "top": [{"game": r["name"],
                 "hours": round((r["play_seconds"] or 0) / 3600, 1),
                 "launches": r["play_count"] or 0,
                 "last_played": _iso(r["last_played_at"])} for r in rows],
        "last_session": ({"game": last["game"],
                          "started": _iso(last["started_at"]),
                          "ended": _iso(last["last_seen_at"])} if last else None),
    }


def overview() -> dict:
    """Counts for platform_overview, cheap enough to call on every question."""
    if not DB_PATH.exists():
        return {"titles_known": 0, "sessions_recorded": 0}
    with _conn() as db:
        t = db.execute("SELECT COUNT(*) c, COUNT(DISTINCT online_id) p, "
                       "COUNT(DISTINCT LOWER(name)) g FROM game_titles").fetchone()
        s = db.execute("SELECT COUNT(*) c, MAX(last_seen_at) m "
                       "FROM play_sessions").fetchone()
    return {
        "titles_known": t["c"] or 0,
        "distinct_games": t["g"] or 0,
        "players_with_history": t["p"] or 0,
        "sessions_recorded": s["c"] or 0,
        "last_seen_playing": _iso(s["m"]),
    }


def _iso(epoch: int | None) -> str | None:
    if not epoch:
        return None
    return datetime.fromtimestamp(epoch, _TZ).strftime("%Y-%m-%d %H:%M")
