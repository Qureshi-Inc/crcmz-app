"""Tournaments — create, teams, roster, bracket, match results."""
from __future__ import annotations
import math, sqlite3, threading, uuid
from datetime import datetime, timezone
from pathlib import Path

_DB = Path("/data/tournaments.db")
_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    _DB.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS tournaments (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            game       TEXT NOT NULL,
            format     TEXT NOT NULL
                           CHECK(format IN ('single_elim','double_elim','round_robin','group_knockout')),
            status     TEXT NOT NULL DEFAULT 'draft'
                           CHECK(status IN ('draft','active','complete')),
            created_by TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS players (
            id           TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            zitadel_id   TEXT,
            is_custom    INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS teams (
            id            TEXT PRIMARY KEY,
            tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            color         TEXT NOT NULL DEFAULT '#6366f1'
        );
        CREATE TABLE IF NOT EXISTS team_members (
            team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            player_id TEXT NOT NULL REFERENCES players(id),
            PRIMARY KEY (team_id, player_id)
        );
        CREATE TABLE IF NOT EXISTS matches (
            id             TEXT PRIMARY KEY,
            tournament_id  TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            round          INTEGER NOT NULL,
            match_num      INTEGER NOT NULL,
            team1_id       TEXT REFERENCES teams(id),
            team2_id       TEXT REFERENCES teams(id),
            score1         INTEGER,
            score2         INTEGER,
            winner_id      TEXT REFERENCES teams(id),
            status         TEXT NOT NULL DEFAULT 'pending'
                               CHECK(status IN ('pending','played','bye')),
            screenshot_url TEXT,
            played_at      TEXT,
            next_match_id  TEXT
        );
        """)


# ── helpers ────────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r else None


def _rows(rs) -> list[dict]:
    return [dict(r) for r in rs]


# ── tournaments ────────────────────────────────────────────────────────────────

def list_tournaments(status: str | None = None) -> list[dict]:
    with _lock, _conn() as db:
        if status:
            rs = db.execute(
                "SELECT * FROM tournaments WHERE status=? ORDER BY created_at DESC", (status,)
            ).fetchall()
        else:
            rs = db.execute(
                "SELECT * FROM tournaments ORDER BY created_at DESC"
            ).fetchall()
        out = []
        for r in rs:
            t = dict(r)
            t["team_count"] = db.execute(
                "SELECT COUNT(*) FROM teams WHERE tournament_id=?", (r["id"],)
            ).fetchone()[0]
            out.append(t)
        return out


def get_tournament(tid: str) -> dict | None:
    with _lock, _conn() as db:
        t = _row(db.execute("SELECT * FROM tournaments WHERE id=?", (tid,)).fetchone())
        if not t:
            return None
        teams = _rows(db.execute("SELECT * FROM teams WHERE tournament_id=?", (tid,)).fetchall())
        for team in teams:
            members = db.execute(
                "SELECT p.* FROM players p JOIN team_members tm ON tm.player_id=p.id WHERE tm.team_id=?",
                (team["id"],),
            ).fetchall()
            team["players"] = _rows(members)
        matches = _rows(db.execute(
            "SELECT * FROM matches WHERE tournament_id=? ORDER BY round, match_num", (tid,)
        ).fetchall())
        team_map = {tm["id"]: tm for tm in teams}
        for m in matches:
            m["team1"] = team_map.get(m["team1_id"])
            m["team2"] = team_map.get(m["team2_id"])
            m["winner"] = team_map.get(m["winner_id"])
        rounds: dict[int, list] = {}
        for m in matches:
            rounds.setdefault(m["round"], []).append(m)
        t["teams"] = teams
        t["rounds"] = [{"round": r, "matches": ms} for r, ms in sorted(rounds.items())]
        return t


def create_tournament(name: str, game: str, format_: str, created_by: str | None) -> dict:
    FORMATS = ("single_elim", "double_elim", "round_robin", "group_knockout")
    if format_ not in FORMATS:
        raise ValueError(f"format must be one of {FORMATS}")
    tid = str(uuid.uuid4())
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO tournaments(id,name,game,format,status,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
            (tid, name.strip(), game.strip(), format_, "draft", created_by, _now()),
        )
    return get_tournament(tid)  # type: ignore[return-value]


def update_tournament_status(tid: str, status: str) -> None:
    STATUSES = ("draft", "active", "complete")
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}")
    with _lock, _conn() as db:
        db.execute("UPDATE tournaments SET status=? WHERE id=?", (status, tid))


# ── players ────────────────────────────────────────────────────────────────────

def list_players() -> list[dict]:
    with _lock, _conn() as db:
        return _rows(db.execute("SELECT * FROM players ORDER BY display_name").fetchall())


def upsert_player(
    display_name: str, zitadel_id: str | None = None, is_custom: bool = False
) -> dict:
    with _lock, _conn() as db:
        if zitadel_id:
            r = _row(db.execute("SELECT * FROM players WHERE zitadel_id=?", (zitadel_id,)).fetchone())
            if r:
                return r
        r = _row(
            db.execute(
                "SELECT * FROM players WHERE display_name=? COLLATE NOCASE", (display_name,)
            ).fetchone()
        )
        if r:
            return r
        pid = str(uuid.uuid4())
        db.execute(
            "INSERT INTO players(id,display_name,zitadel_id,is_custom) VALUES(?,?,?,?)",
            (pid, display_name.strip(), zitadel_id, 1 if is_custom else 0),
        )
        return _row(db.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone())  # type: ignore[return-value]


# ── teams ──────────────────────────────────────────────────────────────────────

def add_team(tournament_id: str, name: str, color: str = "#6366f1") -> dict:
    team_id = str(uuid.uuid4())
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO teams(id,tournament_id,name,color) VALUES(?,?,?,?)",
            (team_id, tournament_id, name.strip(), color),
        )
    return {"id": team_id, "tournament_id": tournament_id, "name": name, "color": color, "players": []}


def remove_team(team_id: str) -> None:
    with _lock, _conn() as db:
        db.execute("DELETE FROM teams WHERE id=?", (team_id,))


def add_player_to_team(team_id: str, player_id: str) -> None:
    with _lock, _conn() as db:
        db.execute(
            "INSERT OR IGNORE INTO team_members(team_id,player_id) VALUES(?,?)", (team_id, player_id)
        )


def remove_player_from_team(team_id: str, player_id: str) -> None:
    with _lock, _conn() as db:
        db.execute(
            "DELETE FROM team_members WHERE team_id=? AND player_id=?", (team_id, player_id)
        )


# ── bracket generation ─────────────────────────────────────────────────────────

def generate_bracket(tournament_id: str) -> None:
    with _lock, _conn() as db:
        t = db.execute("SELECT * FROM tournaments WHERE id=?", (tournament_id,)).fetchone()
        if not t:
            raise ValueError("Tournament not found")
        teams = _rows(db.execute("SELECT id FROM teams WHERE tournament_id=?", (tournament_id,)).fetchall())
        if len(teams) < 2:
            raise ValueError("Need at least 2 teams to generate a bracket")
        db.execute("DELETE FROM matches WHERE tournament_id=?", (tournament_id,))
        team_ids = [r["id"] for r in teams]
        fmt = t["format"]
        if fmt == "single_elim":
            _gen_single_elim(db, tournament_id, team_ids)
        elif fmt == "round_robin":
            _gen_round_robin(db, tournament_id, team_ids)
        elif fmt == "group_knockout":
            _gen_group_knockout(db, tournament_id, team_ids)
        else:
            _gen_single_elim(db, tournament_id, team_ids)
        db.execute("UPDATE tournaments SET status='active' WHERE id=?", (tournament_id,))


def _mid() -> str:
    return str(uuid.uuid4())


def _gen_single_elim(db: sqlite3.Connection, tournament_id: str, team_ids: list[str]) -> None:
    n = len(team_ids)
    rounds = math.ceil(math.log2(n)) if n > 1 else 1
    size = 2 ** rounds
    padded: list[str | None] = list(team_ids) + [None] * (size - n)
    seeded: list[str | None] = []
    for i in range(size // 2):
        seeded.append(padded[i])
        seeded.append(padded[size - 1 - i])
    prev_round_ids: list[str] = []
    for i in range(0, size, 2):
        t1, t2 = seeded[i], seeded[i + 1]
        mid = _mid()
        if t2 is None:
            db.execute(
                "INSERT INTO matches(id,tournament_id,round,match_num,team1_id,team2_id,winner_id,status)"
                " VALUES(?,?,1,?,?,?,?,'bye')",
                (mid, tournament_id, i // 2 + 1, t1, None, t1),
            )
        elif t1 is None:
            db.execute(
                "INSERT INTO matches(id,tournament_id,round,match_num,team1_id,team2_id,winner_id,status)"
                " VALUES(?,?,1,?,?,?,?,'bye')",
                (mid, tournament_id, i // 2 + 1, None, t2, t2),
            )
        else:
            db.execute(
                "INSERT INTO matches(id,tournament_id,round,match_num,team1_id,team2_id,status)"
                " VALUES(?,?,1,?,?,?,'pending')",
                (mid, tournament_id, i // 2 + 1, t1, t2),
            )
        prev_round_ids.append(mid)
    for rnd in range(2, rounds + 1):
        cur_ids: list[str] = []
        for i in range(0, len(prev_round_ids), 2):
            mid = _mid()
            db.execute(
                "INSERT INTO matches(id,tournament_id,round,match_num,status) VALUES(?,?,?,?,'pending')",
                (mid, tournament_id, rnd, i // 2 + 1),
            )
            db.execute("UPDATE matches SET next_match_id=? WHERE id=?", (mid, prev_round_ids[i]))
            if i + 1 < len(prev_round_ids):
                db.execute("UPDATE matches SET next_match_id=? WHERE id=?", (mid, prev_round_ids[i + 1]))
            cur_ids.append(mid)
        prev_round_ids = cur_ids


def _gen_round_robin(db: sqlite3.Connection, tournament_id: str, team_ids: list[str]) -> None:
    n = len(team_ids)
    match_num = 1
    teams: list[str | None] = list(team_ids)
    if n % 2 == 1:
        teams.append(None)
    half = len(teams) // 2
    for rnd in range(len(teams) - 1):
        for i in range(half):
            t1, t2 = teams[i], teams[len(teams) - 1 - i]
            if t1 is None or t2 is None:
                continue
            mid = _mid()
            db.execute(
                "INSERT INTO matches(id,tournament_id,round,match_num,team1_id,team2_id,status)"
                " VALUES(?,?,?,?,?,?,'pending')",
                (mid, tournament_id, rnd + 1, match_num, t1, t2),
            )
            match_num += 1
        teams = [teams[0]] + [teams[-1]] + teams[1:-1]


def _gen_group_knockout(db: sqlite3.Connection, tournament_id: str, team_ids: list[str]) -> None:
    mid_point = len(team_ids) // 2
    group_a = team_ids[:mid_point]
    group_b = team_ids[mid_point:]
    match_num = 1
    for teams in [group_a, group_b]:
        for i, t1 in enumerate(teams):
            for t2 in teams[i + 1:]:
                mid = _mid()
                db.execute(
                    "INSERT INTO matches(id,tournament_id,round,match_num,team1_id,team2_id,status)"
                    " VALUES(?,?,1,?,?,?,'pending')",
                    (mid, tournament_id, match_num, t1, t2),
                )
                match_num += 1
    final_id = _mid()
    db.execute(
        "INSERT INTO matches(id,tournament_id,round,match_num,status) VALUES(?,?,2,1,'pending')",
        (final_id, tournament_id),
    )


# ── match results ──────────────────────────────────────────────────────────────

def record_result(
    match_id: str, score1: int, score2: int, screenshot_url: str | None = None
) -> dict:
    with _lock, _conn() as db:
        m = _row(db.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone())
        if not m:
            raise ValueError("Match not found")
        if score1 == score2:
            raise ValueError("Draws not allowed — one team must win")
        winner_id = m["team1_id"] if score1 > score2 else m["team2_id"]
        db.execute(
            "UPDATE matches SET score1=?,score2=?,winner_id=?,status='played',"
            "screenshot_url=?,played_at=? WHERE id=?",
            (score1, score2, winner_id, screenshot_url, _now(), match_id),
        )
        if m.get("next_match_id"):
            nxt = _row(db.execute("SELECT * FROM matches WHERE id=?", (m["next_match_id"],)).fetchone())
            if nxt:
                if not nxt["team1_id"]:
                    db.execute("UPDATE matches SET team1_id=? WHERE id=?", (winner_id, m["next_match_id"]))
                elif not nxt["team2_id"]:
                    db.execute("UPDATE matches SET team2_id=? WHERE id=?", (winner_id, m["next_match_id"]))
        pending = db.execute(
            "SELECT COUNT(*) FROM matches WHERE tournament_id=? AND status='pending'",
            (m["tournament_id"],),
        ).fetchone()[0]
        if pending == 0:
            db.execute("UPDATE tournaments SET status='complete' WHERE id=?", (m["tournament_id"],))
    return get_tournament(m["tournament_id"]) or {}


def standings(tournament_id: str) -> list[dict]:
    with _lock, _conn() as db:
        teams = _rows(db.execute("SELECT * FROM teams WHERE tournament_id=?", (tournament_id,)).fetchall())
        matches = _rows(db.execute(
            "SELECT * FROM matches WHERE tournament_id=? AND status='played'", (tournament_id,)
        ).fetchall())
        stats: dict[str, dict] = {
            t["id"]: {"team": t, "w": 0, "l": 0, "gf": 0, "ga": 0} for t in teams
        }
        for m in matches:
            if m["team1_id"] and m["team2_id"]:
                s1, s2 = m["score1"] or 0, m["score2"] or 0
                stats[m["team1_id"]]["gf"] += s1
                stats[m["team1_id"]]["ga"] += s2
                stats[m["team2_id"]]["gf"] += s2
                stats[m["team2_id"]]["ga"] += s1
                if m["winner_id"] == m["team1_id"]:
                    stats[m["team1_id"]]["w"] += 1
                    stats[m["team2_id"]]["l"] += 1
                else:
                    stats[m["team2_id"]]["w"] += 1
                    stats[m["team1_id"]]["l"] += 1
        return sorted(stats.values(), key=lambda x: (-x["w"], -(x["gf"] - x["ga"])))
