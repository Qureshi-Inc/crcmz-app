import os, sys, json, random, tempfile; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pathlib import Path
import tourney as T
_TMP = Path(tempfile.mkdtemp()); T._DB = _TMP / 't.db'; T.SHOTS_DIR = _TMP / 'shots'
if T._DB.exists(): T._DB.unlink()
T.init()
squad = {str(i): {"zitadel_id": str(i), "display_name": f"P{i}", "psn_id": f"psn_p{i}"} for i in range(1, 41)}
def mk(game, mode, fmt, n, settings=None, size=None):
    t = T.create_tournament(name=f"{game} {mode} {fmt}", game=game, mode=mode, fmt=fmt, team_size=size, settings=settings, created_by="1")
    md = T._mode(game, mode); ts = t["team_size"]
    keys = [f"z:{i}" for i in range(1, n*ts+1)]
    entries = [{"members": keys[i*ts:(i+1)*ts], "name": f"T{i}"} for i in range(n)]
    T.add_entrants(t["id"], entries, squad)
    return T.start(t["id"])
def play_all(t, draw_ok=False):
    guard = 0
    while t["status"] == "active" and guard < 200:
        guard += 1
        ready = [m for m in t["matches"] if m["playable"]]
        if t["kind"] == "ffa":
            lob = next(l for l in t["lobbies"] if l["status"] == "pending")
            ids = [e["id"] for e in t["entrants"]]; random.shuffle(ids)
            t = T.report_lobby(lob["id"], [{"entrant_id": e, "placement": i+1, "kills": random.randint(0,30)} for i, e in enumerate(ids)], reporter="x")
            continue
        if not ready: raise SystemExit(f"STUCK {t['name']}: " + json.dumps([(m['code'], m['status'], m['wait1'], m['wait2']) for m in t['matches'] if m['status']=='pending']))
        m = ready[0]; bo = t["settings"]["best_of"]; legs = t["settings"]["legs"]
        knockout = m["stage"] not in ("R","G")
        if legs == 2 and knockout: games=[{"s1":1,"s2":1},{"s1":2,"s2":2}]; pens=[5,4]
        elif bo == 1: games=[{"s1":2,"s2":2}] if (draw_ok and not knockout) else [{"s1":3,"s2":1}]; pens=None
        else:
            need=bo//2+1; games=[{"s1":6,"s2":3}]*need; pens=None
        t = T.report_match(m["id"], games, pens, reporter="x")
    return t
random.seed(4)
for args in [("fc","1v1","knockout",5,{"third_place":True}), ("fc","1v1","knockout",8,{"legs":2}),
             ("cod","1v1","double_elim",6,None), ("cod","snd","double_elim",8,None), ("fight","1v1","double_elim",2,None),
             ("fight","1v1","double_elim",3,None), ("fc","1v1","league",5,{"league_legs":2}), ("fc","1v1","groups",10,None),
             ("rl","2v2","groups",6,{"group_size":3,"advance":1}), ("cod","ffa","ffa",7,None), ("cod","warzone","ffa",4,None)]:
    t = mk(*args); t = play_all(t, draw_ok=True)
    champ = next(e["name"] for e in t["entrants"] if e["id"] == t["champion_id"])
    print(f"OK {t['name']:28} status={t['status']} champ={champ} progress={t['progress']} matches={len(t['matches'])}")
# undo guard + rebuild
t = mk("fc","1v1","knockout",4,None)
r1 = [m for m in t["matches"] if m["stage"]=="W" and m["round"]==1]
t = T.report_match(r1[0]["id"], [{"s1":1,"s2":0}], None, reporter="x")
t = T.report_match(r1[1]["id"], [{"s1":1,"s2":0}], None, reporter="x")
final = next(m for m in t["matches"] if m["stage"]=="W" and m["round"]==2)
t = T.report_match(final["id"], [{"s1":2,"s2":1}], None, reporter="x")
try: T.undo_match(r1[0]["id"]); print("FAIL undo allowed")
except ValueError as e: print("OK guard:", e)
try: T.report_match(r1[0]["id"], [{"s1":0,"s2":4}], None, reporter="x"); print("FAIL flip allowed")
except ValueError as e: print("OK flip guard:", e)
t = T.report_match(r1[0]["id"], [{"s1":5,"s2":0}], None, reporter="x"); print("OK same-winner edit, status", t["status"])
t = T.undo_match(final["id"]); print("OK undo final ->", t["status"], t["champion_id"])
try: T.report_match(r1[0]["id"], [{"s1":1,"s2":1}], None, reporter="x"); print("FAIL KO draw no pens")
except ValueError as e: print("OK ko draw:", e)
# suggestion from a reading
t = mk("fc","1v1","knockout",4,None)
m = next(m for m in t["matches"] if m["playable"])
e = {x["id"]: x for x in t["entrants"]}
rd = {"kind":"h2h","game":"fc","confidence":0.9,"sides":[{"label":"Arsenal","gamertags":[e[m["e2"]]["members"][0]["psn_id"]],"score":3},{"label":"Chelsea","gamertags":[e[m["e1"]]["members"][0]["psn_id"]],"score":1}]}
sg = T.suggest(rd, sender="psn_p1", only_tid=t["id"]); print("suggest", sg["target_id"]==m["id"], sg["games"], sg["oriented"], sg["confident"])
print("feed", len(T.feed()["tournaments"]))
t = mk("fight","1v1","double_elim",4,None)
while t["status"]=="active":
    m = next(m for m in t["matches"] if m["playable"])
    side2 = m["stage"]=="GF" and m["round"]==1
    t = T.report_match(m["id"], [{"s1":1,"s2":2}]*2 if side2 else [{"s1":2,"s2":1}]*2, None, reporter="x")
gf=[m for m in t["matches"] if m["stage"]=="GF"]
print("reset:", [(m["code"], m["status"]) for m in gf], "champ", next(e["name"] for e in t["entrants"] if e["id"]==t["champion_id"]))
# ending early: the leader is champion (none for an unfinished bracket), it stays ended, reset clears it
t = mk("fc","1v1","league",4,None)
first = next(m for m in t["matches"] if m["playable"])
t = T.report_match(first["id"], [{"s1":3,"s2":0}], None, reporter="x")
t = T.end(t["id"])
assert t["status"] == "complete" and t["ended_early"] and t["champion_id"] == first["e1"], (t["status"], t["champion_id"])
assert t["id"] not in [x["id"] for x in T.list_tournaments("active")]          # off the live lists and lock screens
later = next(m for m in t["matches"] if m["playable"])
t = T.report_match(later["id"], [{"s1":0,"s2":5}], None, reporter="x")          # a result after ending doesn't reopen it
assert t["status"] == "complete" and t["champion_id"] == first["e1"], (t["status"], t["champion_id"])
try: T.end(t["id"]); raise SystemExit("FAIL ended twice")
except ValueError: pass
t = T.reset(t["id"])
assert t["status"] == "draft" and not t["ended_early"], t["status"]
t = play_all(T.start(t["id"]))
assert t["status"] == "complete" and t["champion_id"] and not t["ended_early"]  # played out after a reset: a normal finish
k = mk("fc","1v1","knockout",4,None)
k = T.end(k["id"])
assert k["status"] == "complete" and k["champion_id"] is None and k["ended_early"], (k["status"], k["champion_id"])
assert "won" not in T.end_message(k["id"])                                     # no champion: nothing to announce
f = mk("cod","ffa","ffa",4,None)
lob = next(l for l in f["lobbies"] if l["status"] == "pending")
ids = [e["id"] for e in f["entrants"]]
f = T.report_lobby(lob["id"], [{"entrant_id": e, "placement": i+1, "kills": 0} for i, e in enumerate(ids)], reporter="x")
f = T.end(f["id"])
assert f["status"] == "complete" and f["champion_id"] == ids[0], (f["status"], f["champion_id"])
assert "(ended early)" in T.end_message(f["id"])
g = mk("fc","1v1","groups",8,None)
g = T.end(g["id"])
assert g["status"] == "complete" and g["champion_id"] is None                   # nothing played yet: no leader
d = T.create_tournament(name="draft", game="fc", mode="1v1", fmt="knockout", team_size=None, settings=None, created_by="1")
try: T.end(d["id"]); raise SystemExit("FAIL ended a draft")
except ValueError: pass
print("OK end early")
