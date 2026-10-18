"""Tournaments: per-game modes, brackets, leagues, groups, FFA lobbies, screenshot scoring.

State is a pure function of (initial seeding, recorded results): every write stores
a result and then `_rebuild` recomputes who sits in which slot, byes, the reset final,
group qualifiers and the champion. That keeps undo and edits correct by construction.
"""
from __future__ import annotations

import base64
import json
import logging
import math
import os
import random
import re
import sqlite3
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_DB = Path("/data/tournaments.db")
SHOTS_DIR = Path("/data/tourney_shots")
_lock = threading.RLock()
_SCHEMA = 2

# ── catalogue ──────────────────────────────────────────────────────────────────

FORMATS: dict[str, dict] = {
    "knockout": {"label": "Knockout", "blurb": "Single elimination. Lose once and you're out."},
    "double_elim": {"label": "Double elimination",
                    "blurb": "Lose twice to go out. Winners and losers brackets, then a grand final."},
    "league": {"label": "League", "blurb": "Everyone plays everyone. The points table decides it."},
    "groups": {"label": "Groups + knockout",
               "blurb": "World Cup style. Group tables first, the top finishers go to a knockout."},
    "ffa": {"label": "Lobby series",
            "blurb": "Everyone in the same lobby. Points for placement and kills over several games."},
}

_H2H = ["knockout", "double_elim", "league", "groups"]
_COD_FFA_PTS = [10, 8, 6, 5, 4, 3, 2, 1]
_BR_PTS = [15, 12, 10, 8, 6, 5, 4, 3, 2, 1]


def _m(label, blurb, *, team_size=1, sizes=None, kind="h2h", unit="Score", draws=False, pens=False,
       formats=None, best_of=(1,), default_bo=1, legs=False, maps=False, default_format=None,
       placement_points=None, kill_points=0, lobbies=5, target=None, round_bo=(1,)):
    return {
        "label": label, "blurb": blurb, "team_size": team_size, "team_sizes": list(sizes or [team_size]),
        "kind": kind, "unit": unit, "draws": draws, "pens": pens,
        "formats": list(formats or (["ffa"] if kind == "ffa" else _H2H)),
        "best_of": list(best_of), "default_bo": default_bo, "legs": legs, "maps": maps,
        "default_format": default_format or (formats or (["ffa"] if kind == "ffa" else _H2H))[0],
        "placement_points": placement_points or [], "kill_points": kill_points,
        "lobbies": lobbies, "target": target, "round_bo": list(round_bo),
    }


GAMES: dict[str, dict] = {
    "fc": {"name": "EA FC", "short": "FC", "blurb": "FIFA and EA Sports FC", "color": "#8cff2b", "modes": {
        "1v1": _m("1v1", "One controller each. Goals decide it, knockouts go to penalties.",
                  unit="Goals", draws=True, pens=True, legs=True, default_format="groups"),
        "2v2": _m("2v2 Co-op", "Two on one team, sharing the pitch.", team_size=2, sizes=[2],
                  unit="Goals", draws=True, pens=True, legs=True),
        "clubs": _m("Pro Clubs", "Squads of human players, one position each.", team_size=5,
                    sizes=[2, 3, 4, 5, 6, 7, 8, 9, 10, 11], unit="Goals", draws=True, pens=True, legs=True),
    }},
    "cod": {"name": "Call of Duty", "short": "COD", "blurb": "Multiplayer, Gunfight and Warzone",
            "color": "#ff2fd6", "modes": {
        "ffa": _m("Free-for-All", "Everyone for themselves in one lobby. First to 30 kills wins the game.",
                  kind="ffa", unit="Kills", placement_points=_COD_FFA_PTS, kill_points=0, lobbies=5),
        "1v1": _m("1v1", "Head-to-head duels. Rounds decide each map.",
                  unit="Rounds", best_of=(1, 3, 5), default_bo=3, maps=True, default_format="double_elim",
                  round_bo=(1, 3, 5)),
        "gunfight": _m("Gunfight 2v2", "Same loadout, no respawns, first to 6 rounds.", team_size=2,
                       sizes=[2], unit="Rounds", best_of=(1, 3, 5), default_bo=3, maps=True, target=6,
                       round_bo=(1, 3, 5)),
        "snd": _m("Search & Destroy", "One life a round, plant or defuse. First to 6 rounds.",
                  team_size=4, sizes=[2, 3, 4, 5, 6], unit="Rounds", best_of=(1, 3, 5), default_bo=3,
                  maps=True, target=6, round_bo=(1, 3, 5)),
        "hardpoint": _m("Hardpoint", "Hold the rotating hill. First to 250.", team_size=4,
                        sizes=[2, 3, 4, 5, 6], unit="Points", best_of=(1, 3, 5), default_bo=1, maps=True,
                        target=250),
        "tdm": _m("Team Deathmatch", "Team kills race.", team_size=4, sizes=[2, 3, 4, 5, 6],
                  unit="Kills", best_of=(1, 3, 5), default_bo=1, maps=True),
        "warzone": _m("Warzone", "Battle royale lobbies. Placement points plus a point per kill.",
                      team_size=4, sizes=[1, 2, 3, 4], kind="ffa", unit="Kills",
                      placement_points=_BR_PTS, kill_points=1, lobbies=3),
    }},
    "rl": {"name": "Rocket League", "short": "RL", "blurb": "Car football", "color": "#22e6ff", "modes": {
        "1v1": _m("1v1 Duel", "One car each.", unit="Goals", best_of=(1, 3, 5, 7), default_bo=3),
        "2v2": _m("2v2 Doubles", "Two cars a side.", team_size=2, sizes=[2], unit="Goals",
                  best_of=(1, 3, 5, 7), default_bo=3),
        "3v3": _m("3v3 Standard", "Three cars a side.", team_size=3, sizes=[3], unit="Goals",
                  best_of=(1, 3, 5, 7), default_bo=3),
    }},
    "nba2k": {"name": "NBA 2K", "short": "2K", "blurb": "Basketball", "color": "#ffd24a", "modes": {
        "1v1": _m("1v1 Play Now", "Pick a team, play a full game.", unit="Points", best_of=(1, 3, 5)),
    }},
    "madden": {"name": "Madden NFL", "short": "MAD", "blurb": "American football", "color": "#9d5cff",
               "modes": {
        "1v1": _m("1v1 Play Now", "Head-to-head football.", unit="Points", best_of=(1, 3)),
    }},
    "fight": {"name": "Fighting games", "short": "FGC", "blurb": "Tekken, Street Fighter, Mortal Kombat",
              "color": "#ff958d", "modes": {
        "1v1": _m("1v1 Sets", "Best-of sets, double elimination like a real bracket.",
                  unit="Rounds", best_of=(1, 3, 5), default_bo=3, default_format="double_elim",
                  round_bo=(1, 3, 5)),
    }},
    "custom": {"name": "Other game", "short": "GAME", "blurb": "Any game, your rules", "color": "#c1a5ff",
               "modes": {
        "h2h": _m("Head-to-head", "Two sides per match, any team size.", sizes=[1, 2, 3, 4, 5, 6],
                  draws=True, best_of=(1, 3, 5, 7)),
        "ffa": _m("Free-for-all", "Everyone in one lobby, points for placement.", sizes=[1, 2, 3, 4],
                  kind="ffa", placement_points=_COD_FFA_PTS, kill_points=0, lobbies=5),
    }},
}

COLORS = ["#ff2fd6", "#22e6ff", "#8cff2b", "#ffd24a", "#9d5cff", "#ff958d", "#5be9b9", "#ff9f43",
          "#7aa2ff", "#f368e0", "#c8f560", "#48dbfb"]


def catalog() -> dict:
    return {"games": GAMES, "formats": FORMATS, "colors": COLORS}


def _mode(game: str, mode: str) -> dict:
    g = GAMES.get(game)
    if not g or mode not in g["modes"]:
        raise ValueError("Unknown game or mode")
    return g["modes"][mode]


def _int(v, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _clean_settings(game: str, mode: str, fmt: str, raw: dict | None) -> dict:
    md = _mode(game, mode)
    raw = raw or {}
    s: dict = {}
    bo = _int(raw.get("best_of"), 1, 7, md["default_bo"])
    s["best_of"] = bo if bo in md["best_of"] else md["default_bo"]
    rbo_opts = md.get("round_bo", [1])
    rbo = _int(raw.get("round_bo"), 1, 7, 1)
    s["round_bo"] = rbo if rbo in rbo_opts else 1
    s["legs"] = 2 if (md["legs"] and fmt in ("knockout", "groups") and _int(raw.get("legs"), 1, 2, 1) == 2) else 1
    if s["legs"] == 2:
        s["best_of"] = 1
    s["third_place"] = bool(raw.get("third_place", fmt in ("knockout", "groups")))
    s["final_reset"] = bool(raw.get("final_reset", True))
    s["league_legs"] = _int(raw.get("league_legs"), 1, 2, 1)
    s["group_size"] = _int(raw.get("group_size"), 3, 8, 4)
    s["advance"] = _int(raw.get("advance"), 1, 4, 2)
    s["pts_win"] = _int(raw.get("pts_win"), 0, 10, 3)
    s["pts_draw"] = _int(raw.get("pts_draw"), 0, 10, 1 if md["draws"] else 0)
    s["lobbies"] = _int(raw.get("lobbies"), 1, 20, md["lobbies"])
    pp = raw.get("placement_points")
    if isinstance(pp, list) and pp:
        s["placement_points"] = [_int(x, 0, 100, 0) for x in pp[:20]]
    else:
        s["placement_points"] = list(md["placement_points"])
    s["kill_points"] = _int(raw.get("kill_points"), 0, 10, md["kill_points"])
    s["game_name"] = str(raw.get("game_name") or "").strip()[:40]
    s["unit"] = (str(raw.get("unit") or "").strip()[:16] or md["unit"]) if game == "custom" else md["unit"]
    s["whatsapp"] = bool(raw.get("whatsapp", True))
    for k, v in raw.items():  # announcement bookkeeping survives rule edits
        if k.startswith("_wa"):
            s[k] = v
    return s


# ── storage ────────────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB, check_same_thread=False, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init() -> None:
    _DB.parent.mkdir(parents=True, exist_ok=True)
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as db:
        if db.execute("PRAGMA user_version").fetchone()[0] < _SCHEMA:
            # v1 never held real data (shipped and replaced the same day).
            db.executescript("""
            DROP TABLE IF EXISTS matches; DROP TABLE IF EXISTS team_members;
            DROP TABLE IF EXISTS teams; DROP TABLE IF EXISTS players; DROP TABLE IF EXISTS tournaments;
            """)
        db.executescript("""
        CREATE TABLE IF NOT EXISTS tournaments (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, game TEXT NOT NULL, mode TEXT NOT NULL,
            format TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', team_size INTEGER NOT NULL DEFAULT 1,
            settings TEXT NOT NULL DEFAULT '{}', champion_id TEXT, created_by TEXT,
            created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
        );
        CREATE TABLE IF NOT EXISTS players (
            id TEXT PRIMARY KEY, display_name TEXT NOT NULL, zitadel_id TEXT UNIQUE,
            psn_id TEXT NOT NULL DEFAULT '', is_guest INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entrants (
            id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            name TEXT NOT NULL, color TEXT NOT NULL, seed INTEGER NOT NULL DEFAULT 0, group_label TEXT
        );
        CREATE TABLE IF NOT EXISTS entrant_members (
            entrant_id TEXT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
            player_id TEXT NOT NULL REFERENCES players(id), PRIMARY KEY (entrant_id, player_id)
        );
        CREATE TABLE IF NOT EXISTS matches (
            id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            stage TEXT NOT NULL, round INTEGER NOT NULL, slot INTEGER NOT NULL, group_label TEXT,
            init_e1 TEXT, init_e2 TEXT, label1 TEXT, label2 TEXT, e1 TEXT, e2 TEXT,
            next_id TEXT, next_side INTEGER, loser_next_id TEXT, loser_next_side INTEGER,
            games TEXT, score1 INTEGER, score2 INTEGER, pens1 INTEGER, pens2 INTEGER,
            result_side INTEGER, res_e1 TEXT, res_e2 TEXT,
            winner_id TEXT, loser_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
            source TEXT, shot_id TEXT, reported_by TEXT, played_at TEXT
        );
        CREATE INDEX IF NOT EXISTS matches_t ON matches(tournament_id);
        CREATE TABLE IF NOT EXISTS lobbies (
            id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            num INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', source TEXT, shot_id TEXT,
            reported_by TEXT, played_at TEXT
        );
        CREATE TABLE IF NOT EXISTS lobby_results (
            lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
            entrant_id TEXT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
            placement INTEGER, kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER,
            PRIMARY KEY (lobby_id, entrant_id)
        );
        CREATE TABLE IF NOT EXISTS player_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT, shot_id TEXT, tournament_id TEXT, target_id TEXT,
            game_no INTEGER, game TEXT, mode TEXT, player_id TEXT, gamertag TEXT, entrant_id TEXT, team TEXT,
            placement INTEGER, kills INTEGER, deaths INTEGER, assists INTEGER, score INTEGER, won INTEGER,
            extra TEXT, created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS player_stats_p ON player_stats(player_id);
        CREATE TABLE IF NOT EXISTS shots (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, sender TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'image/jpeg', reading TEXT,
            suggestion TEXT, status TEXT NOT NULL DEFAULT 'pending', tournament_id TEXT,
            target_id TEXT, note TEXT
        );
        """)
        cols = {r["name"] for r in db.execute("PRAGMA table_info(players)")}
        if "aliases" not in cols:
            db.execute("ALTER TABLE players ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'")
        cols = {r["name"] for r in db.execute("PRAGMA table_info(matches)")}
        if "partial" not in cols:
            db.execute("ALTER TABLE matches ADD COLUMN partial TEXT")
        db.execute(f"PRAGMA user_version={_SCHEMA}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _id() -> str:
    return uuid.uuid4().hex[:16]


def _t_row(db, tid: str) -> dict:
    r = db.execute("SELECT * FROM tournaments WHERE id=?", (tid,)).fetchone()
    if not r:
        raise LookupError("Tournament not found")
    t = dict(r)
    t["settings"] = json.loads(t["settings"] or "{}")
    return t


# ── players ────────────────────────────────────────────────────────────────────

def identity_aliases(p: dict) -> list[str]:
    """Other names someone goes by (account, chat and WhatsApp names). Never an email address."""
    raw = [p.get("username"), p.get("display_name"), p.get("mm_username"), p.get("steam_id"),
           *(p.get("wa_names") or [])]
    out = []
    for v in raw:
        v = str(v or "").strip()
        if not v:
            continue
        out.append(v.split("@")[0] if "@" in v else v)
    return list(dict.fromkeys(out))


def _merge_aliases(db, pid: str, names: list[str]) -> None:
    r = db.execute("SELECT aliases FROM players WHERE id=?", (pid,)).fetchone()
    have = json.loads(r["aliases"] or "[]") if r else []
    new = list(dict.fromkeys([*have, *[n for n in names if n]]))[:30]
    if new != have:
        db.execute("UPDATE players SET aliases=? WHERE id=?", (json.dumps(new), pid))


def _upsert_person(db, zitadel_id: str, display_name: str, psn_id: str, aliases: list[str] | None = None) -> str:
    r = db.execute("SELECT id FROM players WHERE zitadel_id=?", (zitadel_id,)).fetchone()
    if r:
        db.execute("UPDATE players SET psn_id=? WHERE id=?", (psn_id, r["id"]))
        pid = r["id"]
    else:
        pid = _id()
        db.execute("INSERT INTO players(id,display_name,zitadel_id,psn_id,is_guest,created_at) VALUES(?,?,?,?,0,?)",
                   (pid, display_name, zitadel_id, psn_id, _now()))
    _merge_aliases(db, pid, aliases or [])
    return pid


def refresh_identities(squad: list[dict]) -> None:
    """Keep squad players' PSN ids and aliases current so screenshots match their in-game names."""
    with _lock, _conn() as db:
        known = {r["zitadel_id"]: r["id"] for r in db.execute("SELECT id, zitadel_id FROM players WHERE zitadel_id IS NOT NULL")}
        for p in squad:
            pid = known.get(str(p.get("zitadel_id") or ""))
            if pid:
                db.execute("UPDATE players SET psn_id=? WHERE id=?", (p.get("psn_id") or "", pid))
                _merge_aliases(db, pid, identity_aliases(p))


def friendly_name(p: dict) -> str:
    """What the squad calls someone: a name tag, else their WhatsApp name, else the account name."""
    tags = p.get("tags") or {}
    for v in (p.get("squad_name"), tags.get("picks_name")):
        if v and str(v).strip():
            return str(v).strip()[:32]
    wa = [w for w in (p.get("wa_names") or []) if w and w.strip()]
    if wa:
        return re.sub(r"\s*CRCMZ\s*$", "", wa[0].strip(), flags=re.I)[:32] or wa[0].strip()[:32]
    name = (p.get("display_name") or p.get("username") or "").strip()
    parts = name.split()
    if len(parts) == 2 and parts[0].lower() == parts[1].lower():  # "asamad89 asamad89"
        name = parts[0]
    return name[:32]


def is_player(p: dict) -> bool:
    """Real people only: not the App Review login or Zitadel's own admin."""
    who = f"{p.get('username') or ''} {p.get('email') or ''}".lower()
    return not ("zitadel" in who or "appreview" in who or (p.get("display_name") or "").strip().lower() == "app review")


def people(squad: list[dict]) -> list[dict]:
    """Squad members (from the identity graph) plus guests. Allowlisted fields only."""
    with _lock, _conn() as db:
        known = {r["zitadel_id"]: dict(r) for r in db.execute("SELECT * FROM players WHERE zitadel_id IS NOT NULL")}
        out = []
        for p in squad:
            zid = str(p.get("zitadel_id") or "")
            name = friendly_name(p)
            if not zid or not name or not is_player(p):
                continue
            out.append({"key": f"z:{zid}", "display_name": name, "psn_id": p.get("psn_id") or "",
                        "is_guest": False, "player_id": (known.get(zid) or {}).get("id")})
        for r in db.execute("SELECT * FROM players WHERE is_guest=1 ORDER BY display_name COLLATE NOCASE"):
            out.append({"key": f"p:{r['id']}", "display_name": r["display_name"], "psn_id": r["psn_id"],
                        "is_guest": True, "player_id": r["id"]})
        out.sort(key=lambda x: (x["is_guest"], x["display_name"].lower()))
        return out


def add_guest(name: str, psn_id: str = "") -> dict:
    name = (name or "").strip()[:40]
    if not name:
        raise ValueError("Give the guest a name")
    psn_id = (psn_id or "").strip()[:32]
    with _lock, _conn() as db:
        r = db.execute("SELECT * FROM players WHERE is_guest=1 AND display_name=? COLLATE NOCASE", (name,)).fetchone()
        if r:
            if psn_id and psn_id != r["psn_id"]:
                db.execute("UPDATE players SET psn_id=? WHERE id=?", (psn_id, r["id"]))
            pid = r["id"]
        else:
            pid = _id()
            db.execute("INSERT INTO players(id,display_name,psn_id,is_guest,created_at) VALUES(?,?,?,1,?)",
                       (pid, name, psn_id, _now()))
    return {"key": f"p:{pid}", "display_name": name, "psn_id": psn_id, "is_guest": True, "player_id": pid}


def _resolve_keys(db, keys: list[str], squad_by_id: dict[str, dict]) -> list[str]:
    """Turn picker keys (z:<zitadel id> or p:<player id>) into player ids."""
    out: list[str] = []
    for k in keys or []:
        k = str(k)
        if k.startswith("z:"):
            p = squad_by_id.get(k[2:])
            if not p:
                raise ValueError("Unknown squad member")
            out.append(_upsert_person(db, k[2:], friendly_name(p), p.get("psn_id") or "", identity_aliases(p)))
        elif k.startswith("p:"):
            if not db.execute("SELECT 1 FROM players WHERE id=?", (k[2:],)).fetchone():
                raise ValueError("Unknown player")
            out.append(k[2:])
        else:
            raise ValueError("Bad player key")
    return list(dict.fromkeys(out))


# ── tournaments ────────────────────────────────────────────────────────────────

def create_tournament(*, name: str, game: str, mode: str, fmt: str, team_size: int | None,
                      settings: dict | None, created_by: str) -> dict:
    md = _mode(game, mode)
    if fmt not in md["formats"]:
        raise ValueError(f"{md['label']} can't be played as {FORMATS.get(fmt, {}).get('label', fmt)}")
    size = _int(team_size, 1, 11, md["team_size"])
    if size not in md["team_sizes"]:
        size = md["team_size"]
    s = _clean_settings(game, mode, fmt, settings)
    name = (name or "").strip()[:60]
    if not name:
        raise ValueError("Name the tournament")
    tid = _id()
    with _lock, _conn() as db:
        db.execute("INSERT INTO tournaments(id,name,game,mode,format,team_size,settings,created_by,created_at)"
                   " VALUES(?,?,?,?,?,?,?,?,?)",
                   (tid, name, game, mode, fmt, size, json.dumps(s), created_by, _now()))
    return get_tournament(tid)


def update_tournament(tid: str, *, name: str | None = None, settings: dict | None = None) -> dict:
    with _lock, _conn() as db:
        t = _t_row(db, tid)
        if name is not None:
            n = name.strip()[:60]
            if not n:
                raise ValueError("Name the tournament")
            db.execute("UPDATE tournaments SET name=? WHERE id=?", (n, tid))
        if settings is not None:
            if t["status"] != "draft":
                raise ValueError("Rules are locked once the tournament starts. Reset it to change them.")
            s = _clean_settings(t["game"], t["mode"], t["format"], {**t["settings"], **settings})
            db.execute("UPDATE tournaments SET settings=? WHERE id=?", (json.dumps(s), tid))
    return get_tournament(tid)


def delete_tournament(tid: str) -> None:
    with _lock, _conn() as db:
        db.execute("DELETE FROM player_stats WHERE tournament_id=?", (tid,))
        db.execute("DELETE FROM tournaments WHERE id=?", (tid,))
        db.execute("UPDATE shots SET status='dismissed', tournament_id=NULL WHERE tournament_id=?", (tid,))


def creator_of(tid: str) -> str:
    with _lock, _conn() as db:
        return _t_row(db, tid)["created_by"] or ""


# ── entrants ───────────────────────────────────────────────────────────────────

def _draft(db, tid: str) -> dict:
    t = _t_row(db, tid)
    if t["status"] != "draft":
        raise ValueError("The tournament has started. Reset it to change the line-up.")
    return t


def _check_members(db, t: dict, players: list[str], skip_entrant: str | None = None) -> None:
    if t["team_size"] == 1 and len(players) != 1:
        raise ValueError("Pick one player")
    if len(players) > t["team_size"]:
        raise ValueError(f"Teams are {t['team_size']} players")
    for pid in players:
        clash = db.execute(
            "SELECT e.name FROM entrant_members m JOIN entrants e ON e.id=m.entrant_id "
            "WHERE e.tournament_id=? AND m.player_id=? AND e.id IS NOT ?", (t["id"], pid, skip_entrant)).fetchone()
        if clash:
            who = db.execute("SELECT display_name FROM players WHERE id=?", (pid,)).fetchone()
            raise ValueError(f"{who['display_name'] if who else 'That player'} is already in {clash['name']}")


def add_entrants(tid: str, entries: list[dict], squad_by_id: dict[str, dict]) -> dict:
    """entries: [{name?, color?, members: [key]}]. Solo modes may pass one entry per player."""
    with _lock, _conn() as db:
        t = _draft(db, tid)
        n = db.execute("SELECT COUNT(*) FROM entrants WHERE tournament_id=?", (tid,)).fetchone()[0]
        used = {r["color"] for r in db.execute("SELECT color FROM entrants WHERE tournament_id=?", (tid,))}
        for e in entries[:64]:
            players = _resolve_keys(db, e.get("members") or [], squad_by_id)
            _check_members(db, t, players, None)
            if t["team_size"] == 1:
                name = db.execute("SELECT display_name FROM players WHERE id=?", (players[0],)).fetchone()[0]
            else:
                name = (e.get("name") or "").strip()[:32] or f"Team {n + 1}"
            color = e.get("color") if e.get("color") in COLORS else next(
                (c for c in COLORS if c not in used), COLORS[n % len(COLORS)])
            used.add(color)
            eid = _id()
            n += 1
            db.execute("INSERT INTO entrants(id,tournament_id,name,color,seed) VALUES(?,?,?,?,?)",
                       (eid, tid, name, color, n))
            for pid in players:
                db.execute("INSERT INTO entrant_members(entrant_id,player_id) VALUES(?,?)", (eid, pid))
    return get_tournament(tid)


def update_entrant(eid: str, *, name: str | None, color: str | None, members: list[str] | None,
                   squad_by_id: dict[str, dict]) -> dict:
    with _lock, _conn() as db:
        e = db.execute("SELECT * FROM entrants WHERE id=?", (eid,)).fetchone()
        if not e:
            raise LookupError("Not found")
        t = _t_row(db, e["tournament_id"])
        if name is not None:
            nm = name.strip()[:32]
            if nm:
                db.execute("UPDATE entrants SET name=? WHERE id=?", (nm, eid))
        if color in COLORS:
            db.execute("UPDATE entrants SET color=? WHERE id=?", (color, eid))
        if members is not None:
            _draft(db, t["id"])
            players = _resolve_keys(db, members, squad_by_id)
            if t["team_size"] > 1 and players:
                _check_members(db, t, players, eid)
            elif t["team_size"] == 1:
                _check_members(db, t, players, eid)
            db.execute("DELETE FROM entrant_members WHERE entrant_id=?", (eid,))
            for pid in players:
                db.execute("INSERT INTO entrant_members(entrant_id,player_id) VALUES(?,?)", (eid, pid))
            if t["team_size"] == 1 and players and name is None:
                nm = db.execute("SELECT display_name FROM players WHERE id=?", (players[0],)).fetchone()[0]
                db.execute("UPDATE entrants SET name=? WHERE id=?", (nm, eid))
        _ret = t["id"]
    return get_tournament(_ret)


def remove_entrant(eid: str) -> dict:
    with _lock, _conn() as db:
        e = db.execute("SELECT * FROM entrants WHERE id=?", (eid,)).fetchone()
        if not e:
            raise LookupError("Not found")
        _draft(db, e["tournament_id"])
        db.execute("DELETE FROM entrants WHERE id=?", (eid,))
        _renumber(db, e["tournament_id"])
        _ret = e["tournament_id"]
    return get_tournament(_ret)


def _renumber(db, tid: str, order: list[str] | None = None) -> None:
    ids = [r["id"] for r in db.execute("SELECT id FROM entrants WHERE tournament_id=? ORDER BY seed", (tid,))]
    if order:
        known = set(ids)
        ids = [i for i in order if i in known] + [i for i in ids if i not in set(order)]
    for i, eid in enumerate(ids, 1):
        db.execute("UPDATE entrants SET seed=? WHERE id=?", (i, eid))


def set_seeding(tid: str, order: list[str] | None = None, shuffle: bool = False) -> dict:
    with _lock, _conn() as db:
        _draft(db, tid)
        if shuffle:
            order = [r["id"] for r in db.execute("SELECT id FROM entrants WHERE tournament_id=?", (tid,))]
            random.shuffle(order)
        _renumber(db, tid, order)
    return get_tournament(tid)


def auto_teams(tid: str, keys: list[str], squad_by_id: dict[str, dict]) -> dict:
    """Shuffle the picked players into as many full teams as they make."""
    with _lock, _conn() as db:
        t = _draft(db, tid)
        size = t["team_size"]
        players = _resolve_keys(db, keys, squad_by_id)
        if len(players) < size * 2:
            raise ValueError(f"Pick at least {size * 2} players for two teams of {size}")
        random.shuffle(players)
        count = len(players) // size
        teams = [players[i * size:(i + 1) * size] for i in range(count)]
        for extra, pid in enumerate(players[count * size:]):
            teams[extra % count].append(pid)
    entries = [{"name": f"Team {chr(65 + i)}", "members": [f"p:{p}" for p in team]} for i, team in enumerate(teams)]
    with _lock, _conn() as db:
        db.execute("DELETE FROM entrants WHERE tournament_id=?", (tid,))
        t = _t_row(db, tid)
        if t["team_size"] < max(len(x) for x in teams):
            # Leftover players made a team bigger than the format: widen it rather than drop anyone.
            db.execute("UPDATE tournaments SET team_size=? WHERE id=?", (max(len(x) for x in teams), tid))
    return add_entrants(tid, entries, squad_by_id)


# ── structure generation ──────────────────────────────────────────────────────

def _seed_order(n: int) -> list[int]:
    order = [1]
    while len(order) < n:
        m = len(order) * 2
        order = [x for s in order for x in (s, m + 1 - s)]
    return order


def _new(db, tid, stage, rnd, slot, *, e1=None, e2=None, group=None, label1=None, label2=None) -> str:
    mid = _id()
    db.execute("INSERT INTO matches(id,tournament_id,stage,round,slot,group_label,init_e1,init_e2,label1,label2)"
               " VALUES(?,?,?,?,?,?,?,?,?,?)", (mid, tid, stage, rnd, slot, group, e1, e2, label1, label2))
    return mid


def _link(db, src, dst, side, *, loser=False) -> None:
    col = "loser_next" if loser else "next"
    db.execute(f"UPDATE matches SET {col}_id=?, {col}_side=? WHERE id=?", (dst, side, src))


def _bracket(db, tid, slots: list[tuple[str | None, str | None]], stage: str) -> list[list[str]]:
    rounds = [[_new(db, tid, stage, 1, i // 2, e1=slots[i][0], e2=slots[i + 1][0],
                    label1=slots[i][1], label2=slots[i + 1][1]) for i in range(0, len(slots), 2)]]
    while len(rounds[-1]) > 1:
        prev, r = rounds[-1], len(rounds) + 1
        cur = []
        for j in range(0, len(prev), 2):
            m = _new(db, tid, stage, r, j // 2)
            _link(db, prev[j], m, 1)
            _link(db, prev[j + 1], m, 2)
            cur.append(m)
        rounds.append(cur)
    return rounds


def _seeded_slots(ids: list[str]) -> list[tuple[str | None, None]]:
    size = 1 << max(1, math.ceil(math.log2(len(ids))))
    return [((ids[s - 1] if s <= len(ids) else None), None) for s in _seed_order(size)]


def _gen_knockout(db, t, ids, stage="W", slots=None) -> list[list[str]]:
    rounds = _bracket(db, t["id"], slots or _seeded_slots(ids), stage)
    if t["settings"].get("third_place") and len(rounds) >= 2:
        p = _new(db, t["id"], "P", 1, 0)
        _link(db, rounds[-2][0], p, 1, loser=True)
        _link(db, rounds[-2][1], p, 2, loser=True)
    return rounds


def _gen_double(db, t, ids) -> None:
    tid = t["id"]
    wb = _bracket(db, tid, _seeded_slots(ids), "W")
    big_r = len(wb)
    lb: list[list[str]] = []
    if big_r >= 2:
        first = [_new(db, tid, "L", 1, i) for i in range(len(wb[0]) // 2)]
        for i, m in enumerate(wb[0]):
            _link(db, m, first[i // 2], i % 2 + 1, loser=True)
        lb.append(first)
        for k in range(1, big_r):
            prev, drop = lb[-1], wb[k]
            cur = [_new(db, tid, "L", 2 * k, i) for i in range(len(drop))]
            for i, m in enumerate(prev):
                _link(db, m, cur[i], 1)
            for i, m in enumerate(drop):
                # Reverse every other drop so a loser doesn't meet the team that just beat them.
                _link(db, m, cur[i if k % 2 else len(drop) - 1 - i], 2, loser=True)
            lb.append(cur)
            if k < big_r - 1:
                nxt = [_new(db, tid, "L", 2 * k + 1, i) for i in range(len(cur) // 2)]
                for i, m in enumerate(cur):
                    _link(db, m, nxt[i // 2], i % 2 + 1)
                lb.append(nxt)
    gf = _new(db, tid, "GF", 1, 0)
    _link(db, wb[-1][0], gf, 1)
    if lb:
        _link(db, lb[-1][0], gf, 2)
    else:
        _link(db, wb[-1][0], gf, 2, loser=True)
    if t["settings"].get("final_reset", True):
        _new(db, tid, "GF", 2, 0, label1="If needed", label2="If needed")


def _round_robin(ids: list[str], legs: int) -> list[list[tuple[str, str]]]:
    teams: list[str | None] = list(ids) + ([None] if len(ids) % 2 else [])
    n = len(teams)
    days = []
    for _ in range(n - 1):
        day = []
        for i in range(n // 2):
            a, b = teams[i], teams[n - 1 - i]
            if a and b:
                day.append((a, b))
        days.append(day)
        teams = [teams[0], teams[-1], *teams[1:-1]]
    if legs == 2:
        days += [[(b, a) for a, b in day] for day in days]
    return days


def _gen_league(db, t, ids, stage="R", group=None) -> None:
    for d, day in enumerate(_round_robin(ids, t["settings"].get("league_legs", 1) if stage == "R" else 1), 1):
        for s, (a, b) in enumerate(day):
            _new(db, t["id"], stage, d, s, e1=a, e2=b, group=group)


def _gen_groups(db, t, ids) -> None:
    s = t["settings"]
    n_groups = max(2, math.ceil(len(ids) / s["group_size"]))
    groups: list[list[str]] = [[] for _ in range(n_groups)]
    for i, eid in enumerate(ids):
        lap, pos = divmod(i, n_groups)
        groups[pos if lap % 2 == 0 else n_groups - 1 - pos].append(eid)
    for gi, members in enumerate(groups):
        label = chr(65 + gi)
        for eid in members:
            db.execute("UPDATE entrants SET group_label=? WHERE id=?", (label, eid))
        _gen_league(db, t, members, stage="G", group=label)
    adv = min(s["advance"], min(len(g) for g in groups))
    s["advance"] = adv
    db.execute("UPDATE tournaments SET settings=? WHERE id=?", (json.dumps(s), t["id"]))
    seeds = [f"{chr(65 + g)}{pos}" for pos in range(1, adv + 1) for g in range(n_groups)]
    size = 1 << max(1, math.ceil(math.log2(len(seeds))))
    slots = [(None, seeds[x - 1] if x <= len(seeds) else None) for x in _seed_order(size)]
    _gen_knockout(db, t, ids, stage="K", slots=slots)


def start(tid: str) -> dict:
    with _lock, _conn() as db:
        t = _draft(db, tid)
        ents = [dict(r) for r in db.execute("SELECT * FROM entrants WHERE tournament_id=? ORDER BY seed", (tid,))]
        need = 2 if t["format"] != "groups" else 4
        if len(ents) < need:
            raise ValueError(f"Add at least {need} {'players' if t['team_size'] == 1 else 'teams'} first")
        for e in ents:
            cnt = db.execute("SELECT COUNT(*) FROM entrant_members WHERE entrant_id=?", (e["id"],)).fetchone()[0]
            if cnt == 0:
                raise ValueError(f"{e['name']} has no players")
        ids = [e["id"] for e in ents]
        db.execute("DELETE FROM matches WHERE tournament_id=?", (tid,))
        db.execute("DELETE FROM lobbies WHERE tournament_id=?", (tid,))
        fmt = t["format"]
        if fmt == "knockout":
            _gen_knockout(db, t, ids)
        elif fmt == "double_elim":
            _gen_double(db, t, ids)
        elif fmt == "league":
            _gen_league(db, t, ids)
        elif fmt == "groups":
            _gen_groups(db, t, ids)
        elif fmt == "ffa":
            for i in range(t["settings"]["lobbies"]):
                db.execute("INSERT INTO lobbies(id,tournament_id,num) VALUES(?,?,?)", (_id(), tid, i + 1))
        db.execute("UPDATE tournaments SET status='active', started_at=? WHERE id=?", (_now(), tid))
        _rebuild(db, tid)
        if t["settings"].get("whatsapp", True) and not t["settings"].get("_wa_start"):
            t2 = _t_row(db, tid)
            t2["settings"]["_wa_start"] = True
            db.execute("UPDATE tournaments SET settings=? WHERE id=?", (json.dumps(t2["settings"]), tid))
            _announce("start", tid)
    return get_tournament(tid)


def reset(tid: str) -> dict:
    with _lock, _conn() as db:
        _t_row(db, tid)
        db.execute("DELETE FROM player_stats WHERE tournament_id=?", (tid,))
        db.execute("DELETE FROM matches WHERE tournament_id=?", (tid,))
        db.execute("DELETE FROM lobbies WHERE tournament_id=?", (tid,))
        db.execute("UPDATE entrants SET group_label=NULL WHERE tournament_id=?", (tid,))
        db.execute("UPDATE tournaments SET status='draft', champion_id=NULL, started_at=NULL, finished_at=NULL"
                   " WHERE id=?", (tid,))
    return get_tournament(tid)


# ── derived state ─────────────────────────────────────────────────────────────

_STAGE_ORDER = {"G": 0, "R": 1, "W": 2, "K": 2, "L": 3, "P": 4, "GF": 5}


def _table(t: dict, entrant_ids: list[str], matches: list[dict]) -> list[dict]:
    s = t["settings"]
    rows = {e: {"entrant_id": e, "p": 0, "w": 0, "d": 0, "l": 0, "f": 0, "a": 0, "pts": 0, "form": []}
            for e in entrant_ids}
    for m in sorted(matches, key=lambda x: (x["played_at"] or "", x["round"], x["slot"])):
        if m["status"] != "played" or m["e1"] not in rows or m["e2"] not in rows:
            continue
        games = json.loads(m["games"] or "[]")
        f1 = sum(g.get("s1", 0) for g in games)
        f2 = sum(g.get("s2", 0) for g in games)
        for me, them, ff, aa, side in ((m["e1"], m["e2"], f1, f2, 1), (m["e2"], m["e1"], f2, f1, 2)):
            r = rows[me]
            r["p"] += 1
            r["f"] += ff
            r["a"] += aa
            if m["result_side"] == 0:
                r["d"] += 1
                r["pts"] += s["pts_draw"]
                r["form"].append("D")
            elif m["result_side"] == side:
                r["w"] += 1
                r["pts"] += s["pts_win"]
                r["form"].append("W")
            else:
                r["l"] += 1
                r["form"].append("L")
    out = sorted(rows.values(), key=lambda r: (-r["pts"], -(r["f"] - r["a"]), -r["f"], -r["w"], r["entrant_id"]))
    for i, r in enumerate(out, 1):
        r["pos"] = i
        r["form"] = r["form"][-5:]
    return out


def _decide(t: dict, stage: str, games: list[dict], pens: tuple[int, int] | None, *,
            force: bool = False) -> tuple[int, int, int]:
    """Validate a result. Returns (score1, score2, result_side) with side 0 = draw.
    force=True skips early-win checks (used by nested series which always play all rounds)."""
    md = _mode(t["game"], t["mode"])
    s = t["settings"]
    knockout = stage not in ("R", "G")
    if not games:
        raise ValueError("Enter the score")
    for g in games:
        if g["s1"] < 0 or g["s2"] < 0:
            raise ValueError("Scores can't be negative")
    if s.get("legs") == 2 and knockout:
        if len(games) != 2:
            raise ValueError("Enter both legs")
        a, b = sum(g["s1"] for g in games), sum(g["s2"] for g in games)
        if a != b:
            return a, b, 1 if a > b else 2
        if not pens or pens[0] == pens[1]:
            raise ValueError("Level on aggregate. Enter the penalty shoot-out")
        return a, b, 1 if pens[0] > pens[1] else 2
    bo = s.get("best_of", 1)
    if bo == 1:
        if len(games) != 1:
            raise ValueError("One game per match")
        a, b = games[0]["s1"], games[0]["s2"]
        if a != b:
            return a, b, 1 if a > b else 2
        if not knockout and md["draws"]:
            return a, b, 0
        if md["pens"]:
            if not pens or pens[0] == pens[1]:
                raise ValueError("It's a draw. Enter the penalty shoot-out")
            return a, b, 1 if pens[0] > pens[1] else 2
        raise ValueError(f"{md['label']} can't end level. Check the score")
    need = bo // 2 + 1
    w1 = w2 = 0
    for i, g in enumerate(games):
        if not force and (w1 == need or w2 == need):
            raise ValueError(f"The series was already won after game {i}")
        if g["s1"] == g["s2"]:
            raise ValueError(f"Game {i + 1} can't be level")
        if g["s1"] > g["s2"]:
            w1 += 1
        else:
            w2 += 1
    if not force and w1 < need and w2 < need:
        raise ValueError(f"Best of {bo}: someone needs {need} game wins")
    if w1 == w2:
        raise ValueError("Series tied — cannot determine a winner")
    return w1, w2, 1 if w1 > w2 else 2


def _rebuild(db, tid: str) -> None:
    t = _t_row(db, tid)
    if t["status"] == "draft":
        return
    ms = {r["id"]: dict(r) for r in db.execute("SELECT * FROM matches WHERE tournament_id=?", (tid,))}
    for m in ms.values():
        m.update(e1=m["init_e1"], e2=m["init_e2"], winner_id=None, loser_id=None, status="pending")
    feeders: dict[tuple[str, int], list[str]] = defaultdict(list)
    for m in ms.values():
        if m["next_id"]:
            feeders[(m["next_id"], m["next_side"])].append(m["id"])
        if m["loser_next_id"]:
            feeders[(m["loser_next_id"], m["loser_next_side"])].append(m["id"])
    order = sorted(ms.values(), key=lambda m: (_STAGE_ORDER.get(m["stage"], 9), m["round"], m["slot"]))
    done: set[str] = set()
    k_filled = not any(m["stage"] == "K" for m in ms.values())
    gf1 = next((m for m in ms.values() if m["stage"] == "GF" and m["round"] == 1), None)

    def settle(m, winner, loser, status):
        m["winner_id"], m["loser_id"], m["status"] = winner, loser, status
        done.add(m["id"])
        if winner and m["next_id"] in ms:
            ms[m["next_id"]][f"e{m['next_side']}"] = winner
        if loser and m["loser_next_id"] in ms:
            ms[m["loser_next_id"]][f"e{m['loser_next_side']}"] = loser

    changed = True
    while changed:
        changed = False
        if not k_filled:
            gms = [m for m in ms.values() if m["stage"] == "G"]
            if all(m["id"] in done for m in gms):
                labels: dict[str, str] = {}
                by_group: dict[str, list[str]] = defaultdict(list)
                for r in db.execute("SELECT id, group_label FROM entrants WHERE tournament_id=?", (tid,)):
                    if r["group_label"]:
                        by_group[r["group_label"]].append(r["id"])
                for g, eids in by_group.items():
                    for row in _table(t, eids, [m for m in gms if m["group_label"] == g]):
                        labels[f"{g}{row['pos']}"] = row["entrant_id"]
                for m in ms.values():
                    if m["stage"] == "K" and m["round"] == 1:
                        m["e1"] = labels.get(m["label1"]) if m["label1"] else None
                        m["e2"] = labels.get(m["label2"]) if m["label2"] else None
                k_filled = changed = True
        for m in order:
            if m["id"] in done:
                continue
            if m["stage"] == "GF" and m["round"] == 2:
                if not gf1 or gf1["id"] not in done:
                    continue
                if gf1["status"] != "played" or gf1["winner_id"] == gf1["e1"]:
                    settle(m, None, None, "void")
                    changed = True
                    continue
                m["e1"], m["e2"] = gf1["e1"], gf1["e2"]
            elif m["stage"] == "K" and m["round"] == 1 and not k_filled:
                continue
            if any(f not in done for side in (1, 2) for f in feeders[(m["id"], side)]):
                continue
            has = m["games"] is not None
            if has and (m["res_e1"], m["res_e2"]) != (m["e1"], m["e2"]):
                m.update(games=None, score1=None, score2=None, pens1=None, pens2=None, result_side=None,
                         res_e1=None, res_e2=None, source=None, shot_id=None, played_at=None)
                has = False
            if m["e1"] and m["e2"]:
                if not has:
                    continue
                side = m["result_side"]
                if side == 0:
                    settle(m, None, None, "played")
                else:
                    w, lo = (m["e1"], m["e2"]) if side == 1 else (m["e2"], m["e1"])
                    settle(m, w, lo, "played")
            elif m["e1"] or m["e2"]:
                settle(m, m["e1"] or m["e2"], None, "bye")
            else:
                settle(m, None, None, "void")
            changed = True

    cols = ("e1", "e2", "winner_id", "loser_id", "status", "games", "score1", "score2", "pens1", "pens2",
            "result_side", "res_e1", "res_e2", "source", "shot_id", "played_at")
    for m in ms.values():
        db.execute(f"UPDATE matches SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                   (*[m[c] for c in cols], m["id"]))

    champ = None
    fmt = t["format"]
    if fmt in ("knockout", "groups"):
        stage = "W" if fmt == "knockout" else "K"
        finals = [m for m in ms.values() if m["stage"] == stage]
        third = next((m for m in ms.values() if m["stage"] == "P"), None)
        if finals and (not third or third["id"] in done):
            last = max(finals, key=lambda m: m["round"])
            champ = last["winner_id"] if last["id"] in done else None
    elif fmt == "double_elim":
        gf2 = next((m for m in ms.values() if m["stage"] == "GF" and m["round"] == 2), None)
        if gf2 and gf2["status"] == "played":
            champ = gf2["winner_id"]
        elif gf1 and gf1["status"] == "played" and (not gf2 or gf2["status"] == "void"):
            champ = gf1["winner_id"]
    elif fmt == "league":
        if ms and all(m["status"] in ("played", "bye", "void") for m in ms.values()):
            ids = [r["id"] for r in db.execute("SELECT id FROM entrants WHERE tournament_id=?", (tid,))]
            champ = _table(t, ids, list(ms.values()))[0]["entrant_id"]
    elif fmt == "ffa":
        lob = db.execute("SELECT status FROM lobbies WHERE tournament_id=?", (tid,)).fetchall()
        if lob and all(r["status"] == "played" for r in lob):
            board = _leaderboard(db, t)
            champ = board[0]["entrant_id"] if board else None
    if champ:
        db.execute("UPDATE tournaments SET status='complete', champion_id=?, finished_at=COALESCE(finished_at, ?)"
                   " WHERE id=?", (champ, _now(), tid))
        if t["settings"].get("whatsapp", True) and t["settings"].get("_wa_end") != champ:
            t["settings"]["_wa_end"] = champ
            db.execute("UPDATE tournaments SET settings=? WHERE id=?", (json.dumps(t["settings"]), tid))
            _announce("end", tid)
    else:
        db.execute("UPDATE tournaments SET status='active', champion_id=NULL, finished_at=NULL WHERE id=?", (tid,))


def _dependents(db, tid: str, mid: str) -> list[dict]:
    ms = {r["id"]: dict(r) for r in db.execute("SELECT * FROM matches WHERE tournament_id=?", (tid,))}
    start_m = ms[mid]
    seen, out, stack = {mid}, [], [mid]
    while stack:
        m = ms[stack.pop()]
        nxt = [m["next_id"], m["loser_next_id"]]
        if m["stage"] == "GF" and m["round"] == 1:
            nxt += [x["id"] for x in ms.values() if x["stage"] == "GF" and x["round"] == 2]
        if m["stage"] == "G":
            nxt += [x["id"] for x in ms.values() if x["stage"] == "K"]
        for n in nxt:
            if n and n in ms and n not in seen:
                seen.add(n)
                out.append(ms[n])
                stack.append(n)
    return [d for d in out if d["id"] != start_m["id"]]


def _code(m: dict) -> str:
    st = m["stage"]
    if st == "GF":
        return "GF" if m["round"] == 1 else "GF2"
    if st == "P":
        return "3RD"
    if st in ("R", "G"):
        return f"{m['group_label'] or ''}M{m['round']}.{m['slot'] + 1}"
    return f"{st}{m['round']}.{m['slot'] + 1}"


def report_match(mid: str, games: list[dict], pens: list | None, *, reporter: str, source: str = "manual",
                 shot_id: str | None = None, force: bool = False) -> dict:
    clean = []
    for g in (games or [])[:7]:
        clean.append({"s1": _int(g.get("s1"), 0, 9999, 0), "s2": _int(g.get("s2"), 0, 9999, 0),
                      "map": str(g.get("map") or "").strip()[:32]})
    p = None
    if pens and len(pens) == 2 and pens[0] is not None and pens[1] is not None and str(pens[0]) != "":
        p = (_int(pens[0], 0, 99, 0), _int(pens[1], 0, 99, 0))
    with _lock, _conn() as db:
        m = db.execute("SELECT * FROM matches WHERE id=?", (mid,)).fetchone()
        if not m:
            raise LookupError("Match not found")
        m = dict(m)
        t = _t_row(db, m["tournament_id"])
        if t["status"] == "draft":
            raise ValueError("The tournament hasn't started")
        if not (m["e1"] and m["e2"]) or m["status"] in ("bye", "void"):
            raise ValueError("This match isn't ready yet")
        s1, s2, side = _decide(t, m["stage"], clean, p, force=force)
        if m["status"] == "played":
            played_after = [d for d in _dependents(db, t["id"], mid) if d["games"] is not None]
            if played_after and side != m["result_side"]:
                raise ValueError(f"That changes the winner, but {_code(played_after[0])} is already played."
                                 " Undo the later match first.")
        # For nested series, preserve the raw partial so series_history stays available after completion
        round_bo = t["settings"].get("round_bo", 1)
        keep_partial = m.get("partial") if round_bo > 1 else None
        db.execute("UPDATE matches SET partial=?, games=?, score1=?, score2=?, pens1=?, pens2=?, result_side=?, res_e1=?,"
                   " res_e2=?, source=?, shot_id=?, reported_by=?, played_at=? WHERE id=?",
                   (keep_partial, json.dumps(clean), s1, s2, p[0] if p else None, p[1] if p else None, side, m["e1"], m["e2"],
                    source, shot_id, reporter, _now(), mid))
        _rebuild(db, t["id"])
        _ret = t["id"]
    return get_tournament(_ret)


def undo_match(mid: str) -> dict:
    with _lock, _conn() as db:
        db.execute("DELETE FROM player_stats WHERE target_id=?", (mid,))
        m = db.execute("SELECT * FROM matches WHERE id=?", (mid,)).fetchone()
        if not m:
            raise LookupError("Match not found")
        played_after = [d for d in _dependents(db, m["tournament_id"], mid) if d["games"] is not None]
        if played_after:
            raise ValueError(f"Undo {_code(played_after[0])} first, it depends on this result")
        # For nested series: reconstruct partial without the decisive last round so the
        # match resumes from its previous in-progress state (e.g. 1–1 before round 3).
        t = _t_row(db, m["tournament_id"])
        round_bo = t["settings"].get("round_bo", 1)
        restored_partial = None
        if round_bo > 1 and m["games"]:
            try:
                gs = json.loads(m["games"])
                if isinstance(gs, list) and len(gs) > 1:
                    prev = [{"won": 1 if g.get("s1", 0) > g.get("s2", 0) else 2, "maps": []} for g in gs[:-1]]
                    restored_partial = json.dumps({"rounds": prev, "current": []})
            except Exception:  # noqa: BLE001
                pass
        db.execute("UPDATE matches SET games=NULL, partial=?, score1=NULL, score2=NULL, pens1=NULL, pens2=NULL,"
                   " result_side=NULL, res_e1=NULL, res_e2=NULL, source=NULL, shot_id=NULL, played_at=NULL"
                   " WHERE id=?", (restored_partial, mid))
        _rebuild(db, m["tournament_id"])
        _ret = m["tournament_id"]
    return get_tournament(_ret)


# ── FFA lobbies ───────────────────────────────────────────────────────────────

def _leaderboard(db, t: dict) -> list[dict]:
    s = t["settings"]
    pts_table, kp = s.get("placement_points") or [], s.get("kill_points", 0)
    ents = [r["id"] for r in db.execute("SELECT id FROM entrants WHERE tournament_id=?", (t["id"],))]
    rows = {e: {"entrant_id": e, "points": 0, "kills": 0, "deaths": 0, "wins": 0, "played": 0,
                "place_sum": 0, "games": {}} for e in ents}
    for r in db.execute("SELECT l.num, l.status, r.* FROM lobby_results r JOIN lobbies l ON l.id=r.lobby_id"
                        " WHERE l.tournament_id=?", (t["id"],)):
        if r["entrant_id"] not in rows or r["status"] != "played":
            continue
        row = rows[r["entrant_id"]]
        place = r["placement"]
        pts = (pts_table[place - 1] if place and place <= len(pts_table) else 0) + (r["kills"] or 0) * kp
        row["points"] += pts
        row["kills"] += r["kills"] or 0
        row["deaths"] += r["deaths"] or 0
        if place:
            row["played"] += 1
            row["place_sum"] += place
            row["wins"] += 1 if place == 1 else 0
        row["games"][str(r["num"])] = {"placement": place, "kills": r["kills"], "deaths": r["deaths"], "points": pts}
    out = sorted(rows.values(), key=lambda r: (-r["points"], -r["kills"], -r["wins"], r["entrant_id"]))
    for i, r in enumerate(out, 1):
        r["pos"] = i
        r["avg_place"] = round(r["place_sum"] / r["played"], 1) if r["played"] else None
    return out


def report_lobby(lid: str, rows: list[dict], *, reporter: str, source: str = "manual",
                 shot_id: str | None = None) -> dict:
    with _lock, _conn() as db:
        lob = db.execute("SELECT * FROM lobbies WHERE id=?", (lid,)).fetchone()
        if not lob:
            raise LookupError("Lobby not found")
        tid = lob["tournament_id"]
        ents = {r["id"] for r in db.execute("SELECT id FROM entrants WHERE tournament_id=?", (tid,))}
        clean, places = [], []
        for r in rows or []:
            if r.get("entrant_id") not in ents:
                continue
            place = _int(r.get("placement"), 1, 200, 0) or None
            if place:
                places.append(place)
            deaths = r.get("deaths")
            clean.append((r["entrant_id"], place, _int(r.get("kills"), 0, 999, 0),
                          _int(deaths, 0, 999, 0) if deaths not in (None, "") else None))
        if not places:
            raise ValueError("Enter at least one placement")
        if len(places) != len(set(places)):
            raise ValueError("Two entries can't share a placement")
        db.execute("DELETE FROM lobby_results WHERE lobby_id=?", (lid,))
        for eid, place, kills, deaths in clean:
            db.execute("INSERT INTO lobby_results(lobby_id,entrant_id,placement,kills,deaths) VALUES(?,?,?,?,?)",
                       (lid, eid, place, kills, deaths))
        db.execute("UPDATE lobbies SET status='played', source=?, shot_id=?, reported_by=?, played_at=? WHERE id=?",
                   (source, shot_id, reporter, _now(), lid))
        _rebuild(db, tid)
        _ret = tid
    return get_tournament(_ret)


def undo_lobby(lid: str) -> dict:
    with _lock, _conn() as db:
        db.execute("DELETE FROM player_stats WHERE target_id=?", (lid,))
        lob = db.execute("SELECT * FROM lobbies WHERE id=?", (lid,)).fetchone()
        if not lob:
            raise LookupError("Lobby not found")
        db.execute("DELETE FROM lobby_results WHERE lobby_id=?", (lid,))
        db.execute("UPDATE lobbies SET status='pending', source=NULL, shot_id=NULL, played_at=NULL WHERE id=?", (lid,))
        _rebuild(db, lob["tournament_id"])
        _ret = lob["tournament_id"]
    return get_tournament(_ret)


def add_lobby(tid: str) -> dict:
    with _lock, _conn() as db:
        t = _t_row(db, tid)
        if t["format"] != "ffa" or t["status"] == "draft":
            raise ValueError("Only a running lobby series can add games")
        n = db.execute("SELECT COALESCE(MAX(num),0) FROM lobbies WHERE tournament_id=?", (tid,)).fetchone()[0]
        db.execute("INSERT INTO lobbies(id,tournament_id,num) VALUES(?,?,?)", (_id(), tid, n + 1))
        _rebuild(db, tid)
        _ret = tid
    return get_tournament(_ret)


# ── WhatsApp announcements ────────────────────────────────────────────────────
# server.py sets `wa_send(text) -> bool`. Unset (tests, scripts) means nothing is sent.
wa_send = None
APP_URL = "https://app.crcmz.me/app/tourney"


def _announce(kind: str, tid: str) -> None:
    """Send after the current write commits: the thread waits on the same lock."""
    if not wa_send:
        return

    def run():
        try:
            import time as _t
            _t.sleep(4)  # let the screenshot's player stats land before the results are written up
            text = start_message(tid) if kind == "start" else end_message(tid)
            if text:
                wa_send(text)
        except Exception as e:  # noqa: BLE001 - an announcement must never break scoring
            logger.warning("tourney: WhatsApp %s announcement failed: %s", kind, e)
    threading.Thread(target=run, daemon=True).start()


def _series_notify(tid: str, match_id: str, w1: int, w2: int, bo: int) -> None:
    """Fire a WhatsApp message for mid-series milestones (1-1 tie, sweep)."""
    if not wa_send:
        return
    # Determine which milestone this is before spinning up a thread.
    if w1 == 1 and w2 == 1:
        kind = "heated"
    elif bo >= 2 and (w1 == 0 or w2 == 0) and max(w1, w2) * 2 > bo:
        kind = "sweep"
    else:
        return

    def run():
        try:
            with _lock, _conn() as db:
                row = db.execute("SELECT e1, e2 FROM matches WHERE id=?", (match_id,)).fetchone()
                if not row:
                    return
                names = {}
                for eid in (row["e1"], row["e2"]):
                    if eid:
                        en = db.execute("SELECT name FROM entrants WHERE id=?", (eid,)).fetchone()
                        names[eid] = en["name"] if en else "?"
                t_row = db.execute("SELECT name FROM tournaments WHERE id=?", (tid,)).fetchone()
            t_name = t_row["name"] if t_row else "Tournament"
            a = names.get(row["e1"], "?")
            b = names.get(row["e2"], "?")
            if kind == "heated":
                text = f"🔥 It's all tied up!\n\n{a} vs {b} is 1–1 in {t_name}.\nNext game decides it. Who's taking it? 🎮"
            else:
                # winner is whoever has more wins
                winner = a if w1 > w2 else b
                loser = b if w1 > w2 else a
                text = (f"🧹 SWEEP! {winner} didn't drop a single game!\n\n"
                        f"{winner} {max(w1,w2)}–{min(w1,w2)} {loser} in {t_name}. 👑")
            wa_send(text)
        except Exception as e:  # noqa: BLE001
            logger.warning("tourney: series notify failed: %s", e)
    threading.Thread(target=run, daemon=True).start()


def _round_notify(tid: str, match_id: str, round_n: int, won_side: int,
                  ow1: int, ow2: int, bo: int, round_bo: int, maps: list) -> None:
    """Fire a WhatsApp message after a round completes in a nested series."""
    if not wa_send:
        return

    def run():
        try:
            with _lock, _conn() as db:
                row = db.execute("SELECT e1, e2 FROM matches WHERE id=?", (match_id,)).fetchone()
                if not row:
                    return
                names = {}
                for eid in (row["e1"], row["e2"]):
                    if eid:
                        en = db.execute("SELECT name FROM entrants WHERE id=?", (eid,)).fetchone()
                        names[eid] = en["name"] if en else "?"
                t_row = db.execute("SELECT name FROM tournaments WHERE id=?", (tid,)).fetchone()
            t_name = t_row["name"] if t_row else "Tournament"
            a = names.get(row["e1"], "?")
            b = names.get(row["e2"], "?")
            winner = a if won_side == 1 else b
            mw = sum(1 for g in maps if (won_side == 1 and (g.get("s1") or 0) > (g.get("s2") or 0))
                     or (won_side == 2 and (g.get("s2") or 0) > (g.get("s1") or 0)))
            ml = len(maps) - mw
            if ow1 == 1 and ow2 == 1:
                text = (f"🔥 All square! Series tied 1–1 after round {round_n}.\n"
                        f"Final round decides it! {a} vs {b} in {t_name}.")
            else:
                text = (f"🏁 Round {round_n} done! {winner} takes it {mw}–{ml} in maps.\n"
                        f"Leads the series {ow1}–{ow2} in {t_name}.")
            wa_send(text)
        except Exception as e:  # noqa: BLE001
            logger.warning("tourney: round notify failed: %s", e)
    threading.Thread(target=run, daemon=True).start()


def _fmt_line(t: dict) -> str:
    bits = [t["game_label"], t["mode_label"], t["format_label"]]
    bo = 2 if t["settings"].get("legs") == 2 else t["settings"].get("best_of", 1)
    if t["settings"].get("legs") == 2:
        bits.append("home & away")
    elif bo > 1:
        bits.append(f"best of {bo}")
    return " · ".join(bits)


def start_message(tid: str) -> str:
    t = get_tournament(tid)
    ents = {e["id"]: e for e in t["entrants"]}
    who = ", ".join(e["name"] + (f" ({' & '.join(p['display_name'] for p in e['members'])})" if len(e["members"]) > 1 else "")
                    for e in t["entrants"])
    lines = [f"🏆 *{t['name']}* has started!", _fmt_line(t), "", f"*{len(t['entrants'])} in:* {who}"]
    first = [m for m in t["matches"] if m["playable"]][:4]
    if first:
        lines += ["", "*First up:*"] + [f"⚔️ {ents[m['e1']]['name']} vs {ents[m['e2']]['name']}" for m in first]
    elif t["format"] == "ffa":
        lines += ["", f"{t['settings'].get('lobbies', 1)} lobby games. Placement points"
                  + (f" + {t['settings']['kill_points']} per kill" if t["settings"].get("kill_points") else "")]
    lines += ["", "📸 Post your result screenshots in the PSN group and the bracket updates itself.",
              f"Live chart: {APP_URL}/{tid}"]
    return "\n".join(lines)


def end_message(tid: str) -> str:
    t = get_tournament(tid)
    ents = {e["id"]: e for e in t["entrants"]}
    champ = ents.get(t["champion_id"] or "")
    if not champ:
        return ""
    crew = " & ".join(p["display_name"] for p in champ["members"]) if len(champ["members"]) > 1 else ""
    lines = [f"👑 *{champ['name']}* won *{t['name']}*!" + (f" ({crew})" if crew else ""), _fmt_line(t), ""]
    if t["format"] == "ffa":
        lines.append("*Final standings:*")
        for r in t["leaderboard"][:5]:
            lines.append(f"{['🥇', '🥈', '🥉'][r['pos'] - 1] if r['pos'] <= 3 else str(r['pos']) + '.'} "
                         f"{ents[r['entrant_id']]['name']}: {r['points']} pts, {r['kills']} kills")
    elif t["format"] == "league":
        lines.append("*Final table:*")
        for r in (t["tables"].get("") or [])[:5]:
            lines.append(f"{r['pos']}. {ents[r['entrant_id']]['name']}: {r['pts']} pts ({r['w']}W {r['d']}D {r['l']}L)")
    else:
        stage = "GF" if t["format"] == "double_elim" else ("K" if t["format"] == "groups" else "W")
        finals = [m for m in t["matches"] if m["stage"] == stage and m["status"] == "played"]
        if finals:
            f = max(finals, key=lambda m: m["round"])
            w, l = (f["e1"], f["e2"]) if f["winner_id"] == f["e1"] else (f["e2"], f["e1"])
            ws, ls = (f["score1"], f["score2"]) if w == f["e1"] else (f["score2"], f["score1"])
            pens = f" ({f['pens1']}–{f['pens2']} pens)" if f["pens1"] is not None else ""
            maps = ""
            if len(f["games"]) > 1:
                maps = " [" + ", ".join(f"{g['s1']}–{g['s2']}" if f["winner_id"] == f["e1"] else f"{g['s2']}–{g['s1']}"
                                         for g in f["games"]) + "]"
            sweep = (len(f["games"]) > 1 and ls == 0 and
                     all((g["s1"] > g["s2"]) == (ws > ls) for g in f["games"]))
            sweep_prefix = "🧹 SWEEP! " if sweep else ""
            lines.append(f"*Final:* {sweep_prefix}{ents[w]['name']} {ws}–{ls} {ents[l]['name']}{pens}{maps}")
            third = next((m for m in t["matches"] if m["stage"] == "P" and m["winner_id"]), None)
            if third:
                lines.append(f"🥉 3rd: {ents[third['winner_id']]['name']}")
    stars = []
    try:
        lb = {b["key"]: b for b in leaderboard(tournament_id=tid, limit=1)["boards"]}
        for key, label in (("kills", "Most kills"), ("kd", "Best K/D"), ("score", "Top score"), ("for", "Top scorer")):
            if key in lb and lb[key]["rows"]:
                r = lb[key]["rows"][0]
                stars.append(f"{label}: {r['name']} ({r['value']})")
    except Exception:  # noqa: BLE001
        pass
    if stars:
        lines += ["", "⭐ " + " · ".join(stars)]
    lines += ["", f"Full results: {APP_URL}/{tid}"]
    return "\n".join(lines)


# ── reads ─────────────────────────────────────────────────────────────────────

def _entrants(db, tid: str) -> list[dict]:
    ents = [dict(r) for r in db.execute("SELECT * FROM entrants WHERE tournament_id=? ORDER BY seed", (tid,))]
    for e in ents:
        e["members"] = [{"id": p["id"], "display_name": p["display_name"], "psn_id": p["psn_id"],
                         "is_guest": bool(p["is_guest"])}
                        for p in db.execute("SELECT p.* FROM players p JOIN entrant_members m ON m.player_id=p.id"
                                            " WHERE m.entrant_id=? ORDER BY p.display_name", (e["id"],))]
    return ents


def _labels(t: dict) -> dict:
    g = GAMES[t["game"]]
    md = g["modes"][t["mode"]]
    return {"game_label": t["settings"].get("game_name") or g["name"], "game_short": g["short"],
            "game_color": g["color"], "mode_label": md["label"], "format_label": FORMATS[t["format"]]["label"],
            "kind": md["kind"], "unit": t["settings"].get("unit") or md["unit"], "draws": md["draws"],
            "pens": md["pens"], "maps": md["maps"], "target": md["target"]}


def _parse_partial(m: dict) -> dict:
    """Deserialise the partial column, handling both flat and nested formats."""
    raw = m.get("partial")
    pending = m.get("status") == "pending"
    if not raw:
        return {"partial": [], "series_round": None, "series_maps": None, "series_history": None, "series_rounds": None}
    try:
        parsed = json.loads(raw)
    except Exception:  # noqa: BLE001
        return {"partial": [], "series_round": None, "series_maps": None, "series_history": None, "series_rounds": None}
    if isinstance(parsed, dict) and "rounds" in parsed:
        completed = [r for r in parsed.get("rounds", []) if r.get("won")]
        cur = parsed.get("current", [])
        history = [{"won": r["won"], "rounds": r.get("maps", [])} for r in completed]
        if pending:
            synthetic = [{"s1": 1, "s2": 0} if r["won"] == 1 else {"s1": 0, "s2": 1} for r in completed]
            return {
                "partial": synthetic,
                "series_round": len(completed) + 1,
                "series_maps": {
                    "s1": sum(1 for g in cur if (g.get("s1") or 0) > (g.get("s2") or 0)),
                    "s2": sum(1 for g in cur if (g.get("s2") or 0) > (g.get("s1") or 0)),
                },
                "series_history": history,
                "series_rounds": cur,
            }
        # Played nested series: expose history only
        return {"partial": [], "series_round": None, "series_maps": None,
                "series_history": history, "series_rounds": cur if cur else None}
    return {"partial": parsed if isinstance(parsed, list) else [], "series_round": None, "series_maps": None,
            "series_history": None, "series_rounds": None}


def get_tournament(tid: str) -> dict:
    with _lock, _conn() as db:
        t = _t_row(db, tid)
        t.update(_labels(t))
        ents = _entrants(db, tid)
        t["entrants"] = ents
        ms = [dict(r) for r in db.execute("SELECT * FROM matches WHERE tournament_id=?", (tid,))]
        by_id = {m["id"]: m for m in ms}
        feeders: dict[tuple[str, int], list[tuple[str, bool]]] = defaultdict(list)
        for m in ms:
            if m["next_id"]:
                feeders[(m["next_id"], m["next_side"])].append((m["id"], False))
            if m["loser_next_id"]:
                feeders[(m["loser_next_id"], m["loser_next_side"])].append((m["id"], True))
        out = []
        for m in sorted(ms, key=lambda m: (_STAGE_ORDER.get(m["stage"], 9), m["group_label"] or "", m["round"], m["slot"])):
            waits = []
            for side in (1, 2):
                lab = m[f"label{side}"]
                if m[f"e{side}"]:
                    waits.append(None)
                elif lab and m["stage"] == "K":
                    pos = int(lab[1:])
                    waits.append(f"{'Winner' if pos == 1 else 'Runner-up' if pos == 2 else f'#{pos}'} group {lab[0]}")
                elif lab:
                    waits.append(lab)
                elif feeders[(m["id"], side)] and m["status"] == "pending":
                    src, lost = feeders[(m["id"], side)][0]
                    waits.append(f"{'Loser' if lost else 'Winner'} of {_code(by_id[src])}")
                else:
                    waits.append(None)
            out.append({
                "id": m["id"], "stage": m["stage"], "round": m["round"], "slot": m["slot"], "group": m["group_label"],
                "code": _code(m), "e1": m["e1"], "e2": m["e2"], "wait1": waits[0], "wait2": waits[1],
                "games": json.loads(m["games"]) if m["games"] else [], "score1": m["score1"], "score2": m["score2"],
                "pens1": m["pens1"], "pens2": m["pens2"], "result_side": m["result_side"],
                "winner_id": m["winner_id"], "status": m["status"],
                "playable": m["status"] == "pending" and bool(m["e1"] and m["e2"]),
                "next_id": m["next_id"], "source": m["source"], "played_at": m["played_at"],
                **_parse_partial(m),
            })
        t["matches"] = out
        if t["format"] == "league" and t["status"] != "draft":
            t["tables"] = {"": _table(t, [e["id"] for e in ents], ms)}
        elif t["format"] == "groups" and t["status"] != "draft":
            groups: dict[str, list[str]] = defaultdict(list)
            for e in ents:
                if e["group_label"]:
                    groups[e["group_label"]].append(e["id"])
            t["tables"] = {g: _table(t, ids, [m for m in ms if m["stage"] == "G" and m["group_label"] == g])
                           for g, ids in sorted(groups.items())}
        else:
            t["tables"] = {}
        lobbies = [dict(r) for r in db.execute("SELECT * FROM lobbies WHERE tournament_id=? ORDER BY num", (tid,))]
        for lob in lobbies:
            lob["results"] = [dict(r) for r in db.execute(
                "SELECT entrant_id, placement, kills, deaths FROM lobby_results WHERE lobby_id=? ORDER BY placement",
                (lob["id"],))]
        t["lobbies"] = lobbies
        t["leaderboard"] = _leaderboard(db, t) if t["format"] == "ffa" and t["status"] != "draft" else []
        real = [m for m in out if m["status"] not in ("bye", "void")]
        if t["format"] == "ffa":
            t["progress"] = {"played": sum(1 for x in lobbies if x["status"] == "played"), "total": len(lobbies)}
        else:
            def _gc(m):
                if m["status"] == "played":
                    return len(m["games"])
                p = m["partial"]
                cnt = len(p) if isinstance(p, list) else 0
                sm = m.get("series_maps") or {}
                if m.get("series_round") is not None and (sm.get("s1", 0) + sm.get("s2", 0)) > 0:
                    cnt += 1  # current round has maps played
                return cnt
            t["progress"] = {"games": sum(_gc(m) for m in real),
                             "played": sum(1 for m in real if m["status"] == "played"),
                             "total": len([m for m in real if not (m["stage"] == "GF" and m["round"] == 2
                                                                   and m["status"] == "pending" and not m["e1"])])}
        t["inbox"] = db.execute("SELECT COUNT(*) FROM shots WHERE status='pending' AND"
                                " (tournament_id=? OR tournament_id IS NULL)", (tid,)).fetchone()[0]
        return t


def list_tournaments(status: str | None = None) -> list[dict]:
    with _lock, _conn() as db:
        q = "SELECT * FROM tournaments" + (" WHERE status=?" if status else "") + " ORDER BY created_at DESC"
        rows = [dict(r) for r in db.execute(q, (status,) if status else ())]
        out = []
        for t in rows:
            t["settings"] = json.loads(t["settings"] or "{}")
            t.update(_labels(t))
            t["entrant_count"] = db.execute("SELECT COUNT(*) FROM entrants WHERE tournament_id=?", (t["id"],)).fetchone()[0]
            champ = db.execute("SELECT name, color FROM entrants WHERE id=?", (t["champion_id"],)).fetchone() \
                if t["champion_id"] else None
            t["champion"] = dict(champ) if champ else None
            if t["format"] == "ffa":
                c = db.execute("SELECT SUM(status='played'), COUNT(*) FROM lobbies WHERE tournament_id=?", (t["id"],)).fetchone()
            else:
                c = db.execute("SELECT SUM(status='played'), SUM(status NOT IN ('bye','void')) FROM matches"
                               " WHERE tournament_id=?", (t["id"],)).fetchone()
            t["progress"] = {"played": c[0] or 0, "total": c[1] or 0}
            t["best_of"] = 2 if t["settings"].get("legs") == 2 else t["settings"].get("best_of", 1)
            t["round_bo"] = t["settings"].get("round_bo", 1)
            if t["format"] != "ffa":
                g = 0
                for r in db.execute("SELECT status, games, partial FROM matches WHERE tournament_id=?", (t["id"],)):
                    raw = (r["games"] if r["status"] == "played" else r["partial"]) or "[]"
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict):  # nested series: count rounds, not maps
                        g += len(parsed.get("rounds", [])) + (1 if parsed.get("current") else 0)
                    else:
                        g += len(parsed)
                t["progress"]["games"] = g
            t.pop("settings")
            out.append(t)
        return out


def has_active() -> bool:
    with _lock, _conn() as db:
        return bool(db.execute("SELECT 1 FROM tournaments WHERE status='active' LIMIT 1").fetchone())


def feed() -> dict:
    """Compact live view for the trip site: running tournaments plus the five latest finished."""
    with _lock, _conn() as db:
        ids = [r["id"] for r in db.execute("SELECT id FROM tournaments WHERE status='active' ORDER BY started_at DESC")]
        ids += [r["id"] for r in db.execute(
            "SELECT id FROM tournaments WHERE status='complete' ORDER BY finished_at DESC LIMIT 5")]
    out = []
    for tid in ids:
        t = get_tournament(tid)
        out.append({k: t[k] for k in (
            "id", "name", "status", "game", "game_label", "game_short", "game_color", "mode_label", "format",
            "format_label", "kind", "unit", "champion_id", "entrants", "matches", "tables", "lobbies",
            "leaderboard", "progress", "settings")})
    for t in out:
        for e in t["entrants"]:
            e["members"] = [{"display_name": p["display_name"]} for p in e["members"]]
    return {"tournaments": out}


# ── screenshots ───────────────────────────────────────────────────────────────

_READ_PROMPT = """You read video game result screenshots for a squad tournament app.
Reply with ONLY one JSON object, no prose:
{"kind": "h2h" | "scoreboard" | "unknown",
 "game": "fc" | "cod" | "rl" | "nba2k" | "madden" | "fight" | "other",
 "sides": [{"label": "club, team or player name shown", "gamertags": ["..."], "score": 0,
            "stats": {"possession": 0, "shots": 0, "shots_on_target": 0, "...": 0}}],
 "penalties": [0, 0] or null,
 "rows": [{"gamertag": "...", "team": "side label or null", "placement": 1, "kills": 0, "deaths": 0,
           "assists": 0, "score": 0, "stats": {"damage": 0, "headshots": 0, "objective": 0, "...": 0}}],
 "confidence": 0.0}
Rules:
- "h2h": a final score between exactly two sides (EA FC full time "2 - 1", Search & Destroy rounds "6 - 4",
  Hardpoint "250 - 187", Rocket League goals). Put the LEFT/HOME side first. Gamertags are PSN names printed
  near each side or in that side's scoreboard rows.
- FC penalties appear as small numbers in brackets or "Penalties 4-3": put them in "penalties".
- "scoreboard": a free-for-all or battle royale result listing players with placement/kills. Placement is the
  row order (1 = top) unless shown. Warzone squad placement: give each player of the squad the same placement.
- ALWAYS fill "gamertags" for each side with every PSN name printed near that side (under the club or team
  name, in its scoreboard rows, or next to its score). Leave the list empty only if no names are shown.
- Fill "rows" with EVERY player on any scoreboard shown (both teams), with every number in their row:
  kills, deaths, assists, score, and any other column under "stats" (damage, headshots, captures, plants,
  defuses, time, streak...). For EA FC put team stats (possession %, shots, passes...) in each side's "stats".
- Copy names exactly as printed. Use null for anything you can't read. confidence: how sure you are overall.
- If it isn't a match result at all, kind "unknown"."""


def _vision_config() -> tuple[str, str, str]:
    base = os.environ.get("OLLAMA_BASE_URL", "").strip().rstrip("/")
    if base and not base.endswith("/v1"):
        base += "/v1"
    model = (os.environ.get("TOURNEY_VISION_MODEL") or os.environ.get("OLLAMA_MODEL") or "").strip()
    return base, model, os.environ.get("OLLAMA_API_KEY", "").strip()


def read_image(image: bytes, mime: str = "image/jpeg", hints: list[str] | None = None) -> dict:
    import httpx
    base, model, key = _vision_config()
    prompt = _READ_PROMPT
    if hints:
        prompt += ("\nPlayers in the matches being played right now (PSN names and nicknames): "
                   + ", ".join(dict.fromkeys(h for h in hints if h))[:600]
                   + ". If any of these appear on screen, put them in the right side's gamertags.")
    if not base or not model:
        raise RuntimeError("No vision model configured")
    payload = {
        "model": model, "temperature": 0, "max_tokens": 1500,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(image).decode()}"}},
            {"type": "text", "text": prompt}]}],
    }
    r = httpx.post(f"{base}/chat/completions", json=payload, timeout=180,
                   headers={"Authorization": f"Bearer {key}"} if key else {})
    r.raise_for_status()
    text = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    text = re.sub(r"<think>[\s\S]*?</think>", "", text)
    found = re.search(r"\{[\s\S]*\}", text)
    if not found:
        return {"kind": "unknown", "confidence": 0}
    try:
        data = json.loads(found.group(0))
    except json.JSONDecodeError:
        return {"kind": "unknown", "confidence": 0}
    return data if isinstance(data, dict) else {"kind": "unknown", "confidence": 0}


def _norm(s: str) -> str:
    s = re.sub(r"#\d+\s*$", "", (s or "").strip())  # Activision ids: Name#1234567
    s = re.sub(r"^\s*[\[(][^\])]{1,8}[\])]\s*", "", s)  # clan tags: [CRCMZ]Name
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _alias_hit(name: str, aliases: set[str]) -> bool:
    n = _norm(name)
    if len(n) < 2:
        return False
    return any(n == a or (len(n) >= 4 and len(a) >= 4 and (n in a or a in n)) for a in aliases)


def _alias_map() -> dict[str, list[str]]:
    with _lock, _conn() as db:
        return {r["id"]: json.loads(r["aliases"] or "[]") for r in db.execute("SELECT id, aliases FROM players")}


def _aliases(e: dict, extra: dict[str, list[str]] | None = None) -> set[str]:
    out = {_norm(e["name"])}
    for p in e["members"]:
        out.add(_norm(p["display_name"]))
        if p["psn_id"]:
            out.add(_norm(p["psn_id"]))
        for a in (extra or {}).get(p["id"], []):
            out.add(_norm(a))
    return {a for a in out if len(a) >= 2}


def _side_names(side: dict) -> list[str]:
    tags = side.get("gamertags") or side.get("gametags") or []
    return [n for n in [side.get("label") or "", *tags] if isinstance(n, str) and n.strip()]


def _side_hits(side: dict, aliases: set[str]) -> int:
    return sum(1 for n in _side_names(side) if _alias_hit(n, aliases))


def _int_or_none(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _sides_from(reading: dict) -> list[dict]:
    """Two sides from a reading: its "sides", else two teams or two players from its rows."""
    rows = [r for r in (reading.get("rows") or []) if isinstance(r, dict)]
    sides = [dict(x) for x in (reading.get("sides") or []) if isinstance(x, dict)][:2]
    if len(sides) == 2:
        for sd in sides:
            tags = [x for x in (sd.get("gamertags") or sd.get("gametags") or []) if isinstance(x, str)]
            tags += [r.get("gamertag") for r in rows if isinstance(r.get("gamertag"), str) and r.get("team")
                     and sd.get("label") and _norm(r["team"]) == _norm(sd["label"])]
            sd["gamertags"] = list(dict.fromkeys(tags))
        return sides
    teams = list(dict.fromkeys(_norm(r.get("team") or "") for r in rows if r.get("team")))
    if len(teams) == 2:
        out = []
        for tm in teams:
            mine = [r for r in rows if _norm(r.get("team") or "") == tm]
            out.append({"label": mine[0].get("team"), "gamertags": [r.get("gamertag") for r in mine if r.get("gamertag")],
                        "score": None})
        return out
    if len(rows) == 2:
        return [{"label": "", "gamertags": [r.get("gamertag")] if r.get("gamertag") else [],
                 "score": r.get("score") if r.get("score") is not None else r.get("kills")} for r in rows]
    return []


def suggest(reading: dict, sender: str = "", only_tid: str | None = None, only_target: str | None = None) -> dict:
    """Best guess at which match or lobby a reading belongs to, plus a prefilled result."""
    kind = reading.get("kind")
    tids = [only_tid] if only_tid else [r["id"] for r in _active_ids()]
    extra = _alias_map()
    best: dict | None = None
    best_tie = False
    loaded = [t for t in (get_tournament(tid) for tid in tids) if t["status"] == "active"]
    every = {e["id"]: _aliases(e, extra) for t in loaded for e in t["entrants"]}
    sides = _sides_from(reading)
    for t in loaded:
        tid = t["id"]
        ents = {e["id"]: e for e in t["entrants"]}
        game_ok = reading.get("game") in (None, "other", t["game"]) or t["game"] == "custom"
        if t["kind"] == "h2h" and len(sides) == 2 and kind != "unknown":
            for m in t["matches"]:
                if only_target and m["id"] != only_target:
                    continue
                if not (m["playable"] or (only_target and m["status"] == "played")):
                    continue
                a1, a2 = every[m["e1"]], every[m["e2"]]
                straight = _side_hits(sides[0], a1) + _side_hits(sides[1], a2)
                crossed = _side_hits(sides[0], a2) + _side_hits(sides[1], a1)
                swap = crossed > straight
                order = [m["e2"], m["e1"]] if swap else [m["e1"], m["e2"]]
                sender_e = next((x for x in (m["e1"], m["e2"]) if sender and _alias_hit(sender, every[x])), None)
                # A side's names must fit the entrant it lands on; a name that belongs to someone
                # outside this match rules the match out.
                fits, clash = True, False
                for sd, eid in zip(sides, order):
                    names = _side_names(sd)
                    if not names or _side_hits(sd, every[eid]):
                        continue
                    if any(_alias_hit(n, al) for n in names for oid, al in every.items() if oid not in (m["e1"], m["e2"])):
                        clash = True
                    if eid != sender_e:
                        fits = False
                score = max(straight, crossed) * 2 + (1 if sender_e else 0) + (1 if game_ok else -3) - (4 if clash else 0)
                if score <= 0 and not only_target:
                    continue
                s1, s2 = _int_or_none(sides[0].get("score")), _int_or_none(sides[1].get("score"))
                pens = reading.get("penalties") if isinstance(reading.get("penalties"), list) else None
                if swap:
                    s1, s2 = s2, s1
                    pens = list(reversed(pens)) if pens else None
                cand = {"tournament_id": tid, "target_id": m["id"], "type": "match", "score": score,
                        "oriented": straight != crossed and fits and not clash, "side_entrants": order,
                        "games": [{"s1": s1, "s2": s2}] if s1 is not None and s2 is not None else [],
                        "pens": pens, "label": f"{ents[m['e1']]['name']} vs {ents[m['e2']]['name']}",
                        "best_of": t["settings"].get("best_of", 1), "legs": t["settings"].get("legs", 1)}
                if best is None or cand["score"] > best["score"]:
                    best, best_tie = cand, False
                elif cand["score"] == best["score"]:
                    best_tie = True
        elif t["kind"] == "ffa" and (reading.get("rows") or kind == "scoreboard"):
            lob = next((x for x in t["lobbies"] if (x["id"] == only_target if only_target else x["status"] == "pending")), None)
            if not lob:
                continue
            rows, mapped = [], set()
            for i, r in enumerate(reading.get("rows") or [], 1):
                if not isinstance(r, dict):
                    continue
                for eid, e in ents.items():
                    if eid in mapped:
                        continue
                    if _alias_hit(r.get("gamertag") or "", every[eid]) or (
                            t["team_size"] > 1 and _alias_hit(r.get("team") or "", {_norm(e["name"])})):
                        mapped.add(eid)
                        rows.append({"entrant_id": eid, "placement": _int_or_none(r.get("placement")) or i,
                                     "kills": _int_or_none(r.get("kills")) or 0, "deaths": _int_or_none(r.get("deaths"))})
                        break
            if not rows and not only_target:
                continue
            rows.sort(key=lambda r: r["placement"])
            for i, r in enumerate(rows, 1):
                r["placement"] = i
            cand = {"tournament_id": tid, "target_id": lob["id"], "type": "lobby", "score": len(rows) * 2 + (1 if game_ok else -3),
                    "oriented": len(rows) == len(ents), "rows": rows, "label": f"{t['name']} game {lob['num']}"}
            if best is None or cand["score"] > best["score"]:
                best, best_tie = cand, False
            elif cand["score"] == best["score"]:
                best_tie = True
    if not best:
        return {"found": False}
    best["found"] = True
    best["confident"] = bool(best["oriented"] and not best_tie and (reading.get("confidence") or 0) >= 0.6
                             and (best["games"] if best["type"] == "match" else best["rows"]))
    return best


def _active_ids():
    with _lock, _conn() as db:
        return [dict(r) for r in db.execute("SELECT id FROM tournaments WHERE status='active'")]


def live_names(sender: str = "") -> list[str]:
    """Names of everyone in a match or lobby that's waiting for a result; the sender's matches first."""
    first, rest = [], []
    for row in _active_ids():
        t = get_tournament(row["id"])
        ents = {e["id"]: e for e in t["entrants"]}
        groups = [[m["e1"], m["e2"]] for m in t["matches"] if m["playable"]]
        if t["kind"] == "ffa":
            groups = [list(ents)]
        for g in groups:
            names = []
            for eid in g:
                e = ents.get(eid)
                if not e:
                    continue
                names.append(e["name"])
                for p in e["members"]:
                    names += [p["psn_id"], p["display_name"]]
            mine = bool(sender) and any(_norm(sender) == _norm(n) for n in names if n)
            (first if mine else rest).extend(names)
    return [n for n in dict.fromkeys(first + rest) if n][:40]


def ingest_shot(image: bytes, *, sender: str, source: str, mime: str = "image/jpeg",
                squad: list[dict] | None = None) -> dict | None:
    """A screenshot arrived from PSN. Store it, read it, and score it when the match is unambiguous."""
    if not has_active():
        return None
    if squad:
        refresh_identities(squad)
    sid = _id()
    (SHOTS_DIR / sid).write_bytes(image)
    with _lock, _conn() as db:
        db.execute("INSERT INTO shots(id,created_at,sender,source,mime,status) VALUES(?,?,?,?,?, 'reading')",
                   (sid, _now(), sender[:64], source, mime))
    try:
        reading = read_image(image, mime, live_names(sender))
    except Exception as e:  # noqa: BLE001 - a model blip leaves it in the inbox
        logger.warning("tourney: screenshot read failed: %s", e)
        reading = {"kind": "unknown", "confidence": 0, "error": "read_failed"}
    sug = suggest(reading, sender) if reading.get("kind") in ("h2h", "scoreboard") else {"found": False}
    status, note = "pending", None
    if reading.get("kind") == "unknown" and not sug.get("found"):
        status, note = "dismissed", "Not a match result"
    with _lock, _conn() as db:
        db.execute("UPDATE shots SET reading=?, suggestion=?, status=?, tournament_id=?, target_id=?, note=? WHERE id=?",
                   (json.dumps(reading), json.dumps(sug), status, sug.get("tournament_id"), sug.get("target_id"), note, sid))
    if sug.get("found") and sug.get("confident"):
        try:
            apply_shot(sid, reporter=f"psn:{sender}", auto=True)
        except (ValueError, LookupError) as e:
            with _lock, _conn() as db:
                db.execute("UPDATE shots SET note=? WHERE id=?", (str(e)[:200], sid))
    return shot(sid)


def _learn(sid: str, sug: dict) -> None:
    """A confirmed screenshot teaches the tourney each solo player's in-game name."""
    s = shot(sid)
    if not s or not s["reading"] or len(sug.get("side_entrants") or []) != 2:
        return
    sides = _sides_from(s["reading"])
    with _lock, _conn() as db:
        for sd, eid in zip(sides, sug["side_entrants"]):
            members = [r["player_id"] for r in db.execute("SELECT player_id FROM entrant_members WHERE entrant_id=?", (eid,))]
            if len(members) == 1:
                tags = [n for n in (sd.get("gamertags") or []) if isinstance(n, str) and len(_norm(n)) >= 3]
                _merge_aliases(db, members[0], [re.sub(r"#\d+\s*$", "", n).strip() for n in tags])


def apply_shot(sid: str, *, reporter: str, target_id: str | None = None, games: list | None = None,
               pens: list | None = None, rows: list | None = None, auto: bool = False) -> dict:
    with _lock, _conn() as db:
        s = db.execute("SELECT * FROM shots WHERE id=?", (sid,)).fetchone()
        if not s:
            raise LookupError("Screenshot not found")
        sug = json.loads(s["suggestion"] or "{}")
        target = target_id or sug.get("target_id")
        if not target:
            raise ValueError("Pick the match this screenshot belongs to")
        is_lobby = bool(db.execute("SELECT 1 FROM lobbies WHERE id=?", (target,)).fetchone())
    source = "screenshot-auto" if auto else "screenshot"
    note = "Scored automatically" if auto else None
    game_no = 1
    if is_lobby:
        t = report_lobby(target, rows if rows is not None else sug.get("rows") or [], reporter=reporter,
                         source=source, shot_id=sid)
    else:
        new = games if games is not None else sug.get("games") or []
        p = pens if pens is not None else sug.get("pens")
        with _lock, _conn() as db:
            m = dict(db.execute("SELECT * FROM matches WHERE id=?", (target,)).fetchone())
            tt = _t_row(db, m["tournament_id"])
        series = tt["settings"].get("best_of", 1) > 1 or (tt["settings"].get("legs") == 2 and m["stage"] not in ("R", "G"))
        bo = tt["settings"].get("best_of", 1)
        round_bo = tt["settings"].get("round_bo", 1)
        if round_bo > 1 and series and games is None and m["status"] == "pending":
            # Nested series: each "game" in the outer series is itself a best-of-round_bo.
            raw_p = m.get("partial") or "{}"
            try:
                np = json.loads(raw_p) if isinstance(raw_p, str) else raw_p
                if not isinstance(np, dict) or "rounds" not in np:
                    np = {"rounds": [], "current": []}
            except (json.JSONDecodeError, TypeError):
                np = {"rounds": [], "current": []}
            rounds_done = np.get("rounds", [])
            current = np.get("current", [])
            # Reject exact-duplicate rounds: same score already at the end of current
            # (same screenshot submitted twice in quick succession).
            if new and current and current[-1] == new[0] and len(new) == 1:
                logger.info("tourney: duplicate nested round rejected (score %s already at current[-1])", new[0])
                with _lock, _conn() as db:
                    db.execute("UPDATE shots SET status='dismissed', note='duplicate' WHERE id=?", (sid,))
                return get_tournament(tt["id"])
            current = (current + new)[:7]
            round_need = (round_bo + 1) // 2
            cm1 = sum(1 for g in current if (g.get("s1") or 0) > (g.get("s2") or 0))
            cm2 = sum(1 for g in current if (g.get("s2") or 0) > (g.get("s1") or 0))
            round_just_won = None
            if cm1 >= round_need:
                rounds_done.append({"maps": current, "won": 1})
                current = []
                round_just_won = 1
            elif cm2 >= round_need:
                rounds_done.append({"maps": current, "won": 2})
                current = []
                round_just_won = 2
            ow1 = sum(1 for r in rounds_done if r.get("won") == 1)
            ow2 = sum(1 for r in rounds_done if r.get("won") == 2)
            np_new = {"rounds": rounds_done, "current": current}
            if len(rounds_done) >= bo:
                # All bo rounds played — close the match using total round wins.
                # Write the completed partial first so report_match reads the full history.
                with _lock, _conn() as db:
                    db.execute("UPDATE matches SET partial=? WHERE id=?", (json.dumps(np_new), target))
                syn_games = [{"s1": 1, "s2": 0} if r.get("won") == 1 else {"s1": 0, "s2": 1}
                             for r in rounds_done if r.get("won")]
                try:
                    t = report_match(target, syn_games, p, reporter=reporter, source=source, shot_id=sid, force=True)
                except ValueError:
                    t = get_tournament(tt["id"])
                else:
                    if t["status"] != "complete":
                        _series_notify(tt["id"], target, ow1, ow2, bo)
                game_no = len(rounds_done)
                note = f"Series done: {ow1}–{ow2} rounds (round_bo={round_bo})"
            else:
                with _lock, _conn() as db:
                    db.execute("UPDATE matches SET partial=? WHERE id=?", (json.dumps(np_new), target))
                t = get_tournament(tt["id"])
                game_no = len(rounds_done) + 1
                note = f"Round {game_no} map {len(current)}: {cm1}–{cm2} maps, series {ow1}–{ow2}"
                if round_just_won is not None:
                    _round_notify(tt["id"], target, len(rounds_done), round_just_won, ow1, ow2, bo, round_bo,
                                  maps=rounds_done[-1]["maps"])
        elif series and games is None and m["status"] == "pending":
            # Flat series: one screenshot = one map/leg, accumulate until somebody wins.
            done = json.loads(m.get("partial") or "[]")
            all_games = (done + new)[:7]
            game_no = len(all_games)
            try:
                t = report_match(target, all_games, p, reporter=reporter, source=source, shot_id=sid)
            except ValueError as e:
                if "needs" not in str(e) and "both legs" not in str(e):
                    raise
                with _lock, _conn() as db:
                    db.execute("UPDATE matches SET partial=? WHERE id=?", (json.dumps(all_games), target))
                w1 = sum(1 for g in all_games if (g.get("s1") or 0) > (g.get("s2") or 0))
                w2 = sum(1 for g in all_games if (g.get("s2") or 0) > (g.get("s1") or 0))
                t = get_tournament(tt["id"])
                note = f"Game {len(all_games)} saved: series {w1}–{w2}, best of {tt['settings'].get('best_of', 2)}"
                _series_notify(tt["id"], target, w1, w2, bo)
            else:
                # Series just completed — only notify sweep if tournament didn't just finish (end_message handles it).
                w1 = sum(1 for g in all_games if (g.get("s1") or 0) > (g.get("s2") or 0))
                w2 = sum(1 for g in all_games if (g.get("s2") or 0) > (g.get("s1") or 0))
                if t["status"] != "complete":
                    _series_notify(tt["id"], target, w1, w2, bo)
        else:
            t = report_match(target, new, p, reporter=reporter, source=source, shot_id=sid)
    if games is None and rows is None:
        _learn(sid, sug)
    if is_lobby:
        game_no = next((x["num"] for x in t["lobbies"] if x["id"] == target), 1)
    try:
        _record_stats(sid, t["id"], target, game_no)
    except Exception as e:  # noqa: BLE001 - stats are a bonus; the result is already saved
        logger.warning("tourney: stats not recorded for %s: %s", sid, e)
    with _lock, _conn() as db:
        db.execute("UPDATE shots SET status='applied', tournament_id=?, target_id=?, note=? WHERE id=?",
                   (t["id"], target, note, sid))
    return t


def _num(v) -> int | None:
    try:
        return int(round(float(str(v).replace(",", "").replace("%", "").strip())))
    except (TypeError, ValueError):
        return None


def _record_stats(sid: str, tid: str, target: str, game_no: int) -> int:
    """Store every player's line from a scored screenshot, linked to the person, not the team."""
    sh = shot(sid)
    reading = (sh or {}).get("reading") or {}
    t = get_tournament(tid)
    extra = _alias_map()
    members = [(p["id"], e["id"], _aliases({"name": p["display_name"], "members": [p]}, extra))
               for e in t["entrants"] for p in e["members"]]
    m = next((x for x in t["matches"] if x["id"] == target), None)
    lob = next((x for x in t["lobbies"] if x["id"] == target), None)
    side_e: dict[int, str] = {}
    game_winner = None
    if m:
        g = (m["games"] or m["partial"] or [])
        g = g[game_no - 1] if 0 < game_no <= len(g) else None
        if g and g.get("s1") != g.get("s2"):
            game_winner = m["e1"] if (g.get("s1") or 0) > (g.get("s2") or 0) else m["e2"]

    def who(name: str):
        hit = [(pid, eid) for pid, eid, al in members if _alias_hit(name, al)]
        return hit[0] if len(hit) == 1 else (None, None)

    lines = []
    for r in (reading.get("rows") or []):
        if not isinstance(r, dict) or not isinstance(r.get("gamertag"), str):
            continue
        pid, eid = who(r["gamertag"])
        stats = {k: _num(v) for k, v in (r.get("stats") or {}).items() if _num(v) is not None} if isinstance(r.get("stats"), dict) else {}
        lines.append({"player_id": pid, "entrant_id": eid, "gamertag": r["gamertag"][:40], "team": str(r.get("team") or "")[:40],
                      "placement": _num(r.get("placement")), "kills": _num(r.get("kills")), "deaths": _num(r.get("deaths")),
                      "assists": _num(r.get("assists")), "score": _num(r.get("score")), "extra": stats})
    if not lines and m:
        # No per-player table (EA FC): each side's team stats go to the players on that side.
        for sd in _sides_from(reading):
            stats = {k: _num(v) for k, v in (sd.get("stats") or {}).items() if _num(v) is not None} if isinstance(sd.get("stats"), dict) else {}
            for n in _side_names(sd):
                pid, eid = who(n)
                if pid and eid in (m["e1"], m["e2"]) and not any(x["player_id"] == pid for x in lines):
                    lines.append({"player_id": pid, "entrant_id": eid, "gamertag": n[:40], "team": str(sd.get("label") or "")[:40],
                                  "placement": None, "kills": None, "deaths": None, "assists": None, "score": None, "extra": stats})
    with _lock, _conn() as db:
        db.execute("DELETE FROM player_stats WHERE shot_id=?", (sid,))
        for x in lines:
            won = None
            if lob and x["placement"]:
                won = 1 if x["placement"] == 1 else 0
            elif game_winner and x["entrant_id"]:
                won = 1 if x["entrant_id"] == game_winner else 0
            db.execute("INSERT INTO player_stats(shot_id,tournament_id,target_id,game_no,game,mode,player_id,gamertag,"
                       "entrant_id,team,placement,kills,deaths,assists,score,won,extra,created_at)"
                       " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (sid, tid, target, game_no, t["game"], t["mode"], x["player_id"], x["gamertag"], x["entrant_id"],
                        x["team"], x["placement"], x["kills"], x["deaths"], x["assists"], x["score"], won,
                        json.dumps(x["extra"]), _now()))
    return len(lines)


# ── player leaderboards ───────────────────────────────────────────────────────

_FOR_UNIT = {"fc": "goals", "rl": "goals", "nba2k": "points", "madden": "points", "fight": "rounds"}


def _blank(pid: str, name: str) -> dict:
    return {"player_id": pid, "name": name, "games": 0, "wins": 0, "losses": 0, "draws": 0, "for": 0, "against": 0,
            "clean_sheets": 0, "biggest_win": 0, "titles": 0, "tournaments": set(), "stat_games": 0, "kills": 0,
            "deaths": 0, "assists": 0, "score": 0, "best_kills": 0, "best_score": 0, "lobby_games": 0, "lobby_wins": 0,
            "place_sum": 0, "kill_games": 0, "death_games": 0, "extra": defaultdict(int), "by_game": defaultdict(int)}


def player_totals(game: str | None = None, tournament_id: str | None = None) -> dict[str, dict]:
    """Every player's totals across tournament play: results from every match and lobby, plus the
    per-player lines read off scored screenshots."""
    with _lock, _conn() as db:
        q, args = "SELECT * FROM tournaments WHERE status != 'draft'", []
        if game:
            q += " AND game=?"; args.append(game)
        if tournament_id:
            q += " AND id=?"; args.append(tournament_id)
        ts = [dict(r) for r in db.execute(q, args)]
        names = {r["id"]: r["display_name"] for r in db.execute("SELECT id, display_name FROM players")}
        roster: dict[str, list[str]] = defaultdict(list)
        for r in db.execute("SELECT entrant_id, player_id FROM entrant_members"):
            roster[r["entrant_id"]].append(r["player_id"])
        out: dict[str, dict] = {}

        def row(pid: str) -> dict:
            if pid not in out:
                out[pid] = _blank(pid, names.get(pid, "?"))
            return out[pid]

        for t in ts:
            for pid in roster.get(t["champion_id"] or "", []):
                row(pid)["titles"] += 1
            for m in db.execute("SELECT * FROM matches WHERE tournament_id=? AND status IN ('played','pending')", (t["id"],)):
                games = json.loads((m["games"] if m["status"] == "played" else m["partial"]) or "[]")
                for g in games:
                    for eid, mine, theirs in ((m["e1"], g.get("s1", 0), g.get("s2", 0)), (m["e2"], g.get("s2", 0), g.get("s1", 0))):
                        for pid in roster.get(eid or "", []):
                            r = row(pid)
                            r["games"] += 1
                            r["tournaments"].add(t["id"])
                            r["by_game"][t["game"]] += 1
                            r["for"] += mine or 0
                            r["against"] += theirs or 0
                            if (theirs or 0) == 0:
                                r["clean_sheets"] += 1
                            if mine > theirs:
                                r["wins"] += 1
                                r["biggest_win"] = max(r["biggest_win"], mine - theirs)
                            elif mine < theirs:
                                r["losses"] += 1
                            else:
                                r["draws"] += 1
            shot_lobbies = {x["target_id"] for x in db.execute(
                "SELECT DISTINCT target_id FROM player_stats WHERE tournament_id=? AND kills IS NOT NULL", (t["id"],))}
            for lr in db.execute("SELECT l.id, r.* FROM lobby_results r JOIN lobbies l ON l.id=r.lobby_id"
                                 " WHERE l.tournament_id=? AND l.status='played'", (t["id"],)):
                for pid in roster.get(lr["entrant_id"], []):
                    r = row(pid)
                    r["tournaments"].add(t["id"])
                    r["by_game"][t["game"]] += 1
                    if lr["placement"]:
                        r["lobby_games"] += 1
                        r["place_sum"] += lr["placement"]
                        r["lobby_wins"] += 1 if lr["placement"] == 1 else 0
                    # Hand-entered lobby kills count when no screenshot covered that game (solo only).
                    if lr["id"] not in shot_lobbies and len(roster.get(lr["entrant_id"], [])) == 1 and lr["kills"] is not None:
                        r["kills"] += lr["kills"] or 0
                        r["kill_games"] += 1
                        r["best_kills"] = max(r["best_kills"], lr["kills"] or 0)
                        if lr["deaths"] is not None:
                            r["deaths"] += lr["deaths"]
                            r["death_games"] += 1
            for st in db.execute("SELECT * FROM player_stats WHERE tournament_id=? AND player_id IS NOT NULL", (t["id"],)):
                r = row(st["player_id"])
                r["stat_games"] += 1
                r["tournaments"].add(t["id"])
                for k in ("kills", "deaths", "assists", "score"):
                    if st[k] is not None:
                        r[k] += st[k]
                if st["kills"] is not None:
                    r["kill_games"] += 1
                    r["best_kills"] = max(r["best_kills"], st["kills"])
                if st["deaths"] is not None:
                    r["death_games"] += 1
                if st["score"] is not None:
                    r["best_score"] = max(r["best_score"], st["score"])
                for k, v in json.loads(st["extra"] or "{}").items():
                    if isinstance(v, (int, float)):
                        r["extra"][k] += v
        for r in out.values():
            r["tournaments"] = len(r["tournaments"])
            r["extra"] = dict(r["extra"])
            r["by_game"] = dict(r["by_game"])
            r["kd"] = round(r["kills"] / r["deaths"], 2) if r["deaths"] else (float(r["kills"]) if r["kills"] else 0.0)
            r["kills_per_game"] = round(r["kills"] / r["kill_games"], 1) if r["kill_games"] else 0.0
            r["win_rate"] = round(100 * r["wins"] / r["games"]) if r["games"] else 0
            r["avg_place"] = round(r["place_sum"] / r["lobby_games"], 1) if r["lobby_games"] else None
        return out


def leaderboard(game: str | None = None, tournament_id: str | None = None, limit: int = 10) -> dict:
    """Player leaderboards (never teams). `game` narrows to one game, e.g. "cod" or "fc"."""
    tot = player_totals(game, tournament_id)
    rows = list(tot.values())
    min_g = 3

    def board(key, title, value, *, unit="", keep=lambda r: True, low=False, fmt=None):
        cand = [r for r in rows if keep(r) and value(r) not in (None, 0, 0.0)]
        cand.sort(key=lambda r: (value(r) if not low else -value(r)), reverse=True)
        return {"key": key, "title": title, "unit": unit, "rows": [
            {"player_id": r["player_id"], "name": r["name"], "value": value(r), "games": r["games"] or r["stat_games"] or r["lobby_games"]}
            for r in cand[:limit]]}

    for_unit = _FOR_UNIT.get(game or "", "")
    boards = [
        board("kills", "Most kills", lambda r: r["kills"], unit="kills"),
        board("deaths", "Most deaths", lambda r: r["deaths"], unit="deaths"),
        board("kd", "Best K/D", lambda r: r["kd"], keep=lambda r: r["kill_games"] >= min_g and r["death_games"] >= min_g, unit="K/D"),
        board("kills_per_game", "Kills per game", lambda r: r["kills_per_game"], keep=lambda r: r["kill_games"] >= min_g, unit="per game"),
        board("best_kills", "Most kills in one game", lambda r: r["best_kills"], unit="kills"),
        board("score", "Most score", lambda r: r["score"], unit="score"),
        board("best_score", "Best single-game score", lambda r: r["best_score"], unit="score"),
        board("assists", "Most assists", lambda r: r["assists"], unit="assists"),
        board("wins", "Most game wins", lambda r: r["wins"], unit="wins"),
        board("win_rate", "Win rate", lambda r: r["win_rate"], keep=lambda r: r["games"] >= min_g, unit="%"),
        board("titles", "Tournaments won", lambda r: r["titles"], unit="titles"),
        board("lobby_wins", "Lobby wins (1st place)", lambda r: r["lobby_wins"], unit="wins"),
        board("games", "Most games played", lambda r: r["games"] + r["lobby_games"], unit="games"),
    ]
    if for_unit:
        boards += [
            board("for", f"Most {for_unit}", lambda r: r["for"], unit=for_unit),
            board("for_per_game", f"{for_unit.capitalize()} per game", lambda r: round(r["for"] / r["games"], 2) if r["games"] else 0,
                  keep=lambda r: r["games"] >= min_g, unit="per game"),
            board("against_per_game", f"Fewest {for_unit} conceded per game", lambda r: round(r["against"] / r["games"], 2) if r["games"] else 0,
                  keep=lambda r: r["games"] >= min_g, low=True, unit="per game"),
            board("biggest_win", "Biggest win", lambda r: r["biggest_win"], unit=f"{for_unit} margin"),
        ]
        if game == "fc":
            boards.append(board("clean_sheets", "Clean sheets", lambda r: r["clean_sheets"], unit="games"))
    # Extra screenshot columns (damage, headshots, possession...) get boards when anyone has them.
    extras = defaultdict(int)
    for r in rows:
        for k in r["extra"]:
            extras[k] += 1
    for k in sorted(extras):
        if k in ("possession",):
            continue
        boards.append(board(f"extra:{k}", f"Most {k.replace('_', ' ')}", lambda r, k=k: r["extra"].get(k, 0), unit=k.replace("_", " ")))
    boards = [b for b in boards if b["rows"]]
    for b in boards:
        if b["key"] == "against_per_game":
            b["rows"].sort(key=lambda x: x["value"])
    games = sorted({g for r in rows for g in r["by_game"]})
    return {"game": game, "tournament_id": tournament_id, "games": games, "players": len(rows), "boards": boards,
            "min_games": min_g}


def player_stats(who: str, game: str | None = None) -> dict | None:
    """One player's tournament record, found by player id or any of their names."""
    tot = player_totals(game)
    with _lock, _conn() as db:
        ps = [dict(r) for r in db.execute("SELECT * FROM players")]
    extra = _alias_map()
    pid = next((p["id"] for p in ps if p["id"] == who), None)
    if not pid:
        hits = [p["id"] for p in ps if _alias_hit(who, _aliases({"name": p["display_name"], "members": [
            {"id": p["id"], "display_name": p["display_name"], "psn_id": p["psn_id"]}]}, extra))]
        pid = hits[0] if hits else None
    if not pid:
        return None
    r = tot.get(pid) or _blank(pid, next(p["display_name"] for p in ps if p["id"] == pid))
    if isinstance(r.get("tournaments"), set):
        r["tournaments"] = len(r["tournaments"])
    with _lock, _conn() as db:
        recent = [dict(x) for x in db.execute(
            "SELECT s.game, s.mode, s.game_no, s.kills, s.deaths, s.assists, s.score, s.placement, s.won, s.extra,"
            " s.created_at, t.name AS tournament FROM player_stats s JOIN tournaments t ON t.id=s.tournament_id"
            " WHERE s.player_id=? ORDER BY s.created_at DESC LIMIT 20", (pid,))]
    for x in recent:
        x["extra"] = json.loads(x["extra"] or "{}")
    r = {k: v for k, v in r.items() if k not in ("place_sum",)}
    r["extra"] = dict(r.get("extra") or {})
    r["by_game"] = dict(r.get("by_game") or {})
    r["recent_games"] = recent
    return r


def dismiss_shot(sid: str) -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE shots SET status='dismissed' WHERE id=?", (sid,))


def _shot_dict(r) -> dict:
    d = dict(r)
    d["reading"] = json.loads(d["reading"] or "null")
    d["suggestion"] = json.loads(d["suggestion"] or "null")
    return d


def shot(sid: str) -> dict | None:
    with _lock, _conn() as db:
        r = db.execute("SELECT * FROM shots WHERE id=?", (sid,)).fetchone()
        return _shot_dict(r) if r else None


def shots(tid: str | None = None, include_done: bool = False) -> list[dict]:
    with _lock, _conn() as db:
        q = "SELECT * FROM shots WHERE " + ("1=1" if include_done else "status IN ('pending','reading')")
        args: tuple = ()
        if tid:
            q += " AND (tournament_id=? OR tournament_id IS NULL)"
            args = (tid,)
        return [_shot_dict(r) for r in db.execute(q + " ORDER BY created_at DESC LIMIT 50", args)]


def shot_image(sid: str) -> tuple[bytes, str] | None:
    s = shot(sid)
    p = SHOTS_DIR / sid
    if not s or not re.fullmatch(r"[0-9a-f]{16}", sid) or not p.exists():
        return None
    return p.read_bytes(), s["mime"]
