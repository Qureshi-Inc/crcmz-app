"""Trips: a trip's Split (who paid what, who owes whom) and its Moments (what happened,
with photos), for the people invited to it. Only the creator and the invitees see a trip.

Two kinds:
    app      everything lives here (/data/trips.db, photos and receipts under
             /data/trip_media/<trip>/)
    linked   the trip.crcmz.me trip. Its Split and Moments ARE that site's: every read
             and write goes to it through its app bridge (TRIP_SITE_URL, TRIP_APP_TOKEN),
             as the signed-in person, so both stay one ledger. Only who's invited lives
             here. At most one trip is linked.

People are Zitadel ids (`sub`) on app trips; on the linked trip they're the site's Split
roster names (Moiz, Noor, ...), which the site maps from the person's profile.

Receipts shared from a phone's share sheet wait in an inbox (per person, 3 days) until
the page picks the trip and adds them.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path("/data/trips.db")
MEDIA_DIR = Path("/data/trip_media")
_lock = threading.Lock()
_ready = False

SITE_URL = os.environ.get("TRIP_SITE_URL", "https://trip.crcmz.me").rstrip("/")
_APP_TOKEN = os.environ.get("TRIP_APP_TOKEN", "")
INBOX_DAYS = 3
MAX_IMAGE = 12 * 1024 * 1024
RECEIPT_MODEL = os.environ.get("TRIP_RECEIPT_MODEL", "Qwen3-VL-8B-Instruct-MLX-4bit")
_IMAGE_MAGIC = (b"\xff\xd8\xff", b"\x89PNG", b"RIFF", b"GIF8")


def _conn() -> sqlite3.Connection:
    global _ready
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    if not _ready:
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        c.executescript("""
            CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, name TEXT NOT NULL, place TEXT NOT NULL DEFAULT '',
                start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'CAD',
                source TEXT NOT NULL DEFAULT 'app', created_by TEXT NOT NULL, created_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS members (trip_id TEXT NOT NULL, sub TEXT NOT NULL, added_by TEXT NOT NULL,
                added_at REAL NOT NULL, PRIMARY KEY (trip_id, sub));
            CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, payer TEXT NOT NULL,
                descr TEXT NOT NULL, cents INTEGER NOT NULL, currency TEXT NOT NULL, orig_cents INTEGER NOT NULL,
                fx REAL, shares TEXT NOT NULL, receipt TEXT, added_by TEXT NOT NULL, added_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, payer TEXT NOT NULL,
                payee TEXT NOT NULL, cents INTEGER NOT NULL, added_by TEXT NOT NULL, added_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS moments (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, by_sub TEXT NOT NULL,
                text TEXT NOT NULL DEFAULT '', at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS moment_photos (moment_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
                ord INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS moment_likes (moment_id TEXT NOT NULL, sub TEXT NOT NULL, PRIMARY KEY (moment_id, sub));
            CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, sub TEXT NOT NULL, files TEXT NOT NULL, created REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS members_sub ON members(sub);
            CREATE INDEX IF NOT EXISTS expenses_trip ON expenses(trip_id);
            CREATE INDEX IF NOT EXISTS moments_trip ON moments(trip_id);
        """)
        _ready = True
    return c


def init() -> None:
    with _conn():
        pass
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)


def _now() -> float:
    return time.time()


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def _id() -> str:
    return uuid.uuid4().hex[:16]


# ── People ──────────────────────────────────────────────────────────────────
def _people_map() -> dict[str, dict]:
    import crcmz_identity
    try:
        return {sub: p for sub, p in crcmz_identity.by_zitadel_id().items()
                if "INACTIVE" not in str(p.get("state") or "") and "DELETED" not in str(p.get("state") or "")}
    except Exception as e:  # noqa: BLE001
        logger.warning("trips: identity lookup failed: %s", e)
        return {}


def _name(sub: str, people: dict[str, dict] | None = None) -> str:
    import crcmz_identity
    p = (people if people is not None else _people_map()).get(sub)
    return (crcmz_identity.preferred_name(p) if p else "") or "Someone"


def invitable() -> list[dict]:
    people = _people_map()
    out = [{"sub": s, "name": _name(s, people)} for s in people]
    return sorted(out, key=lambda x: x["name"].lower())


def _founder(sub: str) -> bool:
    import crcmz_identity
    try:
        return bool(crcmz_identity.is_founder(sub))
    except Exception:  # noqa: BLE001
        return False


# ── Trips and who's invited ─────────────────────────────────────────────────
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_RECEIPT_NAME = re.compile(r"receipt-[0-9a-f]{16}\.(jpg|png|webp|gif|heic)")


def _clean(name, place, start, end, currency) -> tuple[str, str, str, str, str]:
    name = str(name or "").strip()[:80]
    if not name:
        raise ValueError("Give the trip a name")
    place = str(place or "").strip()[:80]
    start, end = str(start or "").strip(), str(end or "").strip()
    for d in (start, end):
        if d and not _DATE.match(d):
            raise ValueError("Dates are YYYY-MM-DD")
    if start and end and end < start:
        raise ValueError("The trip ends before it starts")
    cur = str(currency or "CAD").strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", cur):
        raise ValueError("Currency is a three-letter code, like CAD")
    return name, place, start, end, cur


def _row(db, tid: str) -> dict:
    r = db.execute("SELECT * FROM trips WHERE id=?", (tid,)).fetchone()
    if not r:
        raise LookupError("Trip not found")
    return dict(r)


def _members(db, tid: str) -> list[str]:
    return [r["sub"] for r in db.execute("SELECT sub FROM members WHERE trip_id=? ORDER BY added_at", (tid,))]


def _visible(db, tid: str, sub: str) -> dict:
    """The trip, if `sub` is invited to it. Anyone else gets "not found", not "forbidden":
    a trip nobody invited you to doesn't exist for you."""
    t = _row(db, tid)
    if not sub or not db.execute("SELECT 1 FROM members WHERE trip_id=? AND sub=?", (tid, sub)).fetchone():
        raise LookupError("Trip not found")
    return t


def _can_manage(t: dict, sub: str) -> bool:
    return sub == t["created_by"] or _founder(sub)


def _view(db, t: dict, sub: str, people: dict | None = None) -> dict:
    people = people if people is not None else _people_map()
    linked = t["source"] == "linked"
    return {"id": t["id"], "name": t["name"], "place": t["place"], "start": t["start_date"], "end": t["end_date"],
            "currency": "CAD" if linked else t["currency"], "linked": linked, "site_url": SITE_URL if linked else None,
            "created_by": t["created_by"], "can_manage": _can_manage(t, sub),
            "members": [{"sub": m, "name": _name(m, people)} for m in _members(db, t["id"])]}


def list_for(sub: str) -> dict:
    people = _people_map()
    with _conn() as db:
        rows = [dict(r) for r in db.execute(
            "SELECT t.* FROM trips t JOIN members m ON m.trip_id=t.id WHERE m.sub=? "
            "ORDER BY CASE WHEN t.start_date='' THEN 1 ELSE 0 END, t.start_date DESC, t.created_at DESC", (sub,))]
        trips = [_view(db, t, sub, people) for t in rows]
        linked = db.execute("SELECT 1 FROM trips WHERE source='linked'").fetchone() is not None
    return {"trips": trips, "can_link": bool(_APP_TOKEN) and not linked}


def _set_members(db, tid: str, creator: str, subs, by: str) -> None:
    keep = {str(s) for s in (subs or []) if str(s).strip()} | {creator}
    known = _people_map()
    if known:
        bad = [s for s in keep if s not in known]
        if bad:
            raise ValueError("Someone in that list isn't a member of the app")
    have = set(_members(db, tid))
    for s in have - keep:
        db.execute("DELETE FROM members WHERE trip_id=? AND sub=?", (tid, s))
    for s in keep - have:
        db.execute("INSERT INTO members(trip_id, sub, added_by, added_at) VALUES (?,?,?,?)", (tid, s, by, _now()))


def create(sub: str, *, name, place="", start="", end="", currency="CAD", members=(), link=False) -> dict:
    name, place, start, end, cur = _clean(name, place, start, end, currency)
    with _lock, _conn() as db:
        if link:
            if not _APP_TOKEN:
                raise ValueError("trip.crcmz.me isn't connected to the app")
            if db.execute("SELECT 1 FROM trips WHERE source='linked'").fetchone():
                raise ValueError("A trip is already linked to trip.crcmz.me")
        tid = _id()
        db.execute("INSERT INTO trips(id, name, place, start_date, end_date, currency, source, created_by, created_at)"
                   " VALUES (?,?,?,?,?,?,?,?,?)", (tid, name, place, start, end, cur, "linked" if link else "app", sub, _now()))
        _set_members(db, tid, sub, members, sub)
        return _view(db, _row(db, tid), sub)


def update(tid: str, sub: str, changes: dict) -> dict:
    with _lock, _conn() as db:
        t = _visible(db, tid, sub)
        if not _can_manage(t, sub):
            raise PermissionError("Only whoever made the trip can change it")
        name, place, start, end, cur = _clean(changes.get("name", t["name"]), changes.get("place", t["place"]),
                                              changes.get("start", t["start_date"]), changes.get("end", t["end_date"]),
                                              changes.get("currency", t["currency"]))
        if cur != t["currency"] and db.execute("SELECT 1 FROM expenses WHERE trip_id=?", (tid,)).fetchone():
            raise ValueError("The currency can't change once there are expenses")
        db.execute("UPDATE trips SET name=?, place=?, start_date=?, end_date=?, currency=? WHERE id=?",
                   (name, place, start, end, cur, tid))
        if "members" in changes:
            _set_members(db, tid, t["created_by"], changes.get("members"), sub)
        return _view(db, _row(db, tid), sub)


def delete(tid: str, sub: str) -> None:
    """An app trip goes with its Split and Moments. The linked trip only leaves the app:
    trip.crcmz.me keeps all of its own."""
    with _lock, _conn() as db:
        t = _visible(db, tid, sub)
        if not _can_manage(t, sub):
            raise PermissionError("Only whoever made the trip can delete it")
        mids = [r["id"] for r in db.execute("SELECT id FROM moments WHERE trip_id=?", (tid,))]
        for mid in mids:
            db.execute("DELETE FROM moment_photos WHERE moment_id=?", (mid,))
            db.execute("DELETE FROM moment_likes WHERE moment_id=?", (mid,))
        for table in ("moments", "expenses", "settlements", "members"):
            db.execute(f"DELETE FROM {table} WHERE trip_id=?", (tid,))
        db.execute("DELETE FROM trips WHERE id=?", (tid,))
    d = MEDIA_DIR / tid
    if d.is_dir():
        for f in d.iterdir():
            f.unlink(missing_ok=True)
        d.rmdir()


def trip_for(tid: str, sub: str) -> dict:
    with _conn() as db:
        return _visible(db, tid, sub)


# ── The trip.crcmz.me bridge ────────────────────────────────────────────────
def _site(method: str, path: str, profile: dict, *, json_body=None, files=None, data=None, timeout=30):
    """One call to trip.crcmz.me's app bridge, as this person (their profile: the site
    maps it to its Split roster, as it does when they sign in there)."""
    import httpx
    if not _APP_TOKEN:
        raise RuntimeError("trip.crcmz.me isn't connected (TRIP_APP_TOKEN)")
    who = base64.b64encode(json.dumps({k: profile.get(k, "") for k in ("sub", "name", "preferred_username", "email")}).encode()).decode()
    r = httpx.request(method, f"{SITE_URL}{path}", headers={"x-trip-app": _APP_TOKEN, "x-trip-user": who},
                      json=json_body, files=files, data=data, timeout=timeout)
    return r


def _site_json(method: str, path: str, profile: dict, **kw) -> dict:
    r = _site(method, path, profile, **kw)
    try:
        body = r.json()
    except ValueError:
        body = {}
    if r.status_code >= 400:
        raise ValueError(body.get("error") or f"trip.crcmz.me said {r.status_code}")
    return body


# ── Money ───────────────────────────────────────────────────────────────────
_fx_cache: dict[tuple[str, str], tuple[float, float]] = {}


def fx(src: str, dst: str) -> float:
    """1 `src` in `dst` (Frankfurter, the ECB's daily rates), cached 12 h."""
    if src == dst:
        return 1.0
    hit = _fx_cache.get((src, dst))
    if hit and _now() - hit[1] < 12 * 3600:
        return hit[0]
    import httpx
    try:
        # It redirects (to api.frankfurter.dev); httpx only follows when told to.
        r = httpx.get("https://api.frankfurter.app/latest", params={"from": src, "to": dst}, timeout=10, follow_redirects=True)
        rate = float(r.json()["rates"][dst])
        _fx_cache[(src, dst)] = (rate, _now())
        return rate
    except Exception as e:  # noqa: BLE001
        if hit:
            return hit[0]
        raise ValueError(f"Couldn't get the {src} rate just now") from e


def _equal(total: int, keys: list[str]) -> dict[str, int]:
    """Equal shares in cents that add up exactly: the leftover cents go to the first few."""
    base, extra = divmod(total, len(keys))
    return {k: base + (1 if i < extra else 0) for i, k in enumerate(keys)}


def _balances(keys: list[str], expenses: list[dict], settlements: list[dict]) -> dict[str, int]:
    bal = {k: 0 for k in keys}
    for e in expenses:
        bal[e["payer"]] = bal.get(e["payer"], 0) + e["cents"]
        for k, c in e["shares"].items():
            bal[k] = bal.get(k, 0) - c
    for s in settlements:
        bal[s["from"]] = bal.get(s["from"], 0) + s["cents"]
        bal[s["to"]] = bal.get(s["to"], 0) - s["cents"]
    return bal


def _settle(bal: dict[str, int]) -> list[dict]:
    """Who pays whom to square it, in as few payments as the greedy match gives."""
    owe = sorted(([k, -v] for k, v in bal.items() if v < 0), key=lambda x: -x[1])
    get = sorted(([k, v] for k, v in bal.items() if v > 0), key=lambda x: -x[1])
    out, i, j = [], 0, 0
    while i < len(owe) and j < len(get):
        c = min(owe[i][1], get[j][1])
        if c > 0:
            out.append({"from": owe[i][0], "to": get[j][0], "cents": c})
        owe[i][1] -= c
        get[j][1] -= c
        if owe[i][1] == 0:
            i += 1
        if get[j][1] == 0:
            j += 1
    return out


def _split_view(currency, currencies, rates, people, me, expenses, settlements) -> dict:
    keys = [p["key"] for p in people]
    bal = _balances(keys, expenses, settlements)
    return {"currency": currency, "currencies": currencies, "fx": rates, "people": people, "me": me,
            "expenses": expenses, "settlements": settlements, "balances": bal, "settle": _settle(bal),
            "total_cents": sum(e["cents"] for e in expenses)}


def split(tid: str, sub: str, profile: dict) -> dict:
    t = trip_for(tid, sub)
    if t["source"] == "linked":
        return _linked_split(tid, profile)
    people_map = _people_map()
    with _conn() as db:
        keys = _members(db, tid)
        ex = [dict(r) for r in db.execute("SELECT * FROM expenses WHERE trip_id=? ORDER BY added_at DESC", (tid,))]
        st = [dict(r) for r in db.execute("SELECT * FROM settlements WHERE trip_id=? ORDER BY added_at DESC", (tid,))]
    for s in {e["payer"] for e in ex} | {k for e in ex for k in json.loads(e["shares"])}:
        if s not in keys:
            keys.append(s)   # someone uninvited later still shows in the money they're part of
    people = [{"key": k, "name": _name(k, people_map)} for k in keys]
    expenses = [{"id": e["id"], "payer": e["payer"], "desc": e["descr"], "cents": e["cents"], "currency": e["currency"],
                 "orig_cents": e["orig_cents"], "shares": json.loads(e["shares"]),
                 "receipt_url": f"/api/trips/{tid}/receipts/{e['receipt']}" if e["receipt"] else None,
                 "added_by_name": _name(e["added_by"], people_map), "added_at": _iso(e["added_at"]),
                 "can_delete": sub in (e["added_by"], e["payer"], t["created_by"])} for e in ex]
    settlements = [{"id": s["id"], "from": s["payer"], "to": s["payee"], "cents": s["cents"], "added_at": _iso(s["added_at"])} for s in st]
    cur = t["currency"]
    others = ["USD", "EUR", "GBP", "CAD", "MXN", "PKR", "AED", "INR"]
    currencies = [cur] + [c for c in others if c != cur]
    rates = {}
    for c in currencies[1:4]:
        try:
            rates[c] = fx(c, cur)
        except ValueError:
            pass
    return _split_view(cur, [cur] + list(rates), {cur: 1.0, **rates}, people, sub, expenses, settlements)


def _linked_split(tid: str, profile: dict) -> dict:
    led = _site_json("GET", "/api/expenses", profile)
    me = _site_json("GET", "/api/me", profile)
    try:
        usd = float(_site_json("GET", "/api/fx", profile).get("usdCad") or 0) or None
    except ValueError:
        usd = None
    roster = list(me.get("people") or [])
    for e in led.get("expenses", []):
        for k in [e.get("payer")] + list((e.get("shares") or {}).keys()):
            if k and k not in roster:
                roster.append(k)
    expenses = [{"id": e["id"], "payer": e["payer"], "desc": e.get("desc") or "Expense", "cents": int(e["amountCentsCAD"]),
                 "currency": e.get("currency") or "CAD", "orig_cents": int(e.get("origCents") or e["amountCentsCAD"]),
                 "shares": {k: int(v) for k, v in (e.get("shares") or {}).items()},
                 "receipt_url": f"/api/trips/{tid}/receipts/{e['receipt']}" if e.get("receipt") else None,
                 "added_by_name": e.get("addedBy") or "", "added_at": e.get("addedAt") or "", "can_delete": True}
                for e in sorted(led.get("expenses", []), key=lambda x: x.get("addedAt") or "", reverse=True)]
    settlements = [{"id": s["id"], "from": s["from"], "to": s["to"], "cents": int(s["amountCentsCAD"]), "added_at": s.get("addedAt") or ""}
                   for s in led.get("settlements", [])]
    rates = {"CAD": 1.0, **({"USD": usd} if usd else {})}
    return _split_view("CAD", list(rates), rates, [{"key": k, "name": k} for k in roster], me.get("person"), expenses, settlements)


def add_expense(tid: str, sub: str, profile: dict, body: dict) -> dict:
    t = trip_for(tid, sub)
    try:
        orig = int(body.get("orig_cents"))
    except (TypeError, ValueError):
        raise ValueError("Amount required") from None
    if not (0 < orig < 10_000_000):
        raise ValueError("Amount required")
    desc = str(body.get("desc") or "").strip()[:80] or "Expense"
    parts = [str(p) for p in (body.get("parts") or []) if str(p)]
    payer = str(body.get("payer") or "")
    currency = str(body.get("currency") or "").upper()
    receipt = str(body.get("receipt") or "") or None
    if not parts:
        raise ValueError("Split it between someone")
    if t["source"] == "linked":
        if currency not in ("CAD", "USD"):
            raise ValueError("This trip's Split is in CAD or USD")
        rate = 1.0
        if currency == "USD":
            rate = float(_site_json("GET", "/api/fx", profile).get("usdCad") or 0)
            if rate <= 0:
                raise ValueError("Couldn't get the USD rate just now")
        cad = round(orig * rate)
        out = _site_json("POST", "/api/expenses", profile, json_body={
            "payer": payer, "desc": desc, "amountCentsCAD": cad, "currency": currency, "origCents": orig,
            "fxRate": rate if currency == "USD" else None, "splitMode": "equal", "shares": _equal(cad, parts), "receipt": receipt})
        return {"ok": True, "expense": out.get("expense")}
    with _conn() as db:
        keys = set(_members(db, tid))
    if payer not in keys or any(p not in keys for p in parts):
        raise ValueError("Everyone in an expense has to be on the trip")
    cur = t["currency"]
    rate = fx(currency, cur) if currency and currency != cur else 1.0
    home = round(orig * rate)
    # Only a name this trip's own receipt store made (no paths, no other files).
    if receipt and (not _RECEIPT_NAME.fullmatch(receipt) or not (MEDIA_DIR / tid / receipt).is_file()):
        raise ValueError("That receipt isn't on this trip")
    eid = _id()
    with _lock, _conn() as db:
        db.execute("INSERT INTO expenses(id, trip_id, payer, descr, cents, currency, orig_cents, fx, shares, receipt, added_by, added_at)"
                   " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   (eid, tid, payer, desc, home, currency or cur, orig, rate if currency != cur else None,
                    json.dumps(_equal(home, parts)), receipt, sub, _now()))
    return {"ok": True, "expense": {"id": eid, "cents": home}}


def list_people(tid: str, sub: str, profile: dict) -> dict:
    """Return the split people for a trip. For linked trips these are the Calgary site's
    people list; for non-linked they are the CRCMZ app members."""
    t = trip_for(tid, sub)
    if t["source"] == "linked":
        result = _site_json("GET", "/api/people", profile)
        return {"linked": True, "people": result.get("people", []), "can_manage": t["can_manage"]}
    with _conn() as db:
        keys = _members(db, tid)
    people_map = _people_map()
    return {"linked": False, "people": [_name(k, people_map) for k in keys], "can_manage": t["can_manage"]}


def set_people(tid: str, sub: str, profile: dict, names) -> dict:
    """Replace the split people for a linked trip. Non-linked trips use Edit trip."""
    t = trip_for(tid, sub)
    if t["source"] != "linked":
        raise ValueError("Non-linked trips: use Edit trip to change who's on it")
    if not t["can_manage"]:
        raise PermissionError("Only the trip creator or a founder can change the people")
    if not isinstance(names, list) or not names:
        raise ValueError("people must be a non-empty list of names")
    names = [str(n).strip() for n in names if str(n).strip()]
    if not names:
        raise ValueError("At least one person required")
    result = _site_json("PUT", "/api/people", profile, json_body={"people": names})
    return {"ok": True, "people": result.get("people", names)}


def redistribute_expenses(tid: str, sub: str, profile: dict) -> dict:
    """Recalculate shares for every equally-split expense so all current members are included."""
    t = trip_for(tid, sub)
    if not t["can_manage"]:
        raise PermissionError("Only the trip creator or a founder can fix past expenses")
    if t["source"] == "linked":
        return _site_json("POST", "/api/expenses/redistribute", profile)
    with _conn() as db:
        keys = _members(db, tid)
    if not keys:
        return {"ok": True, "changed": 0, "total": 0}
    with _lock, _conn() as db:
        rows = db.execute("SELECT id, cents, shares FROM expenses WHERE trip_id=?", (tid,)).fetchall()
        changed = 0
        for row in rows:
            new_shares = _equal(row["cents"], keys)
            old_shares = json.loads(row["shares"])
            if old_shares != new_shares:
                db.execute("UPDATE expenses SET shares=? WHERE id=?", (json.dumps(new_shares), row["id"]))
                changed += 1
    return {"ok": True, "changed": changed, "total": len(rows), "people": keys}


def delete_expense(tid: str, sub: str, profile: dict, eid: str) -> None:
    t = trip_for(tid, sub)
    if t["source"] == "linked":
        _site_json("DELETE", f"/api/expenses/{eid}", profile)
        return
    with _lock, _conn() as db:
        e = db.execute("SELECT * FROM expenses WHERE id=? AND trip_id=?", (eid, tid)).fetchone()
        if not e:
            raise LookupError("That expense is gone")
        if sub not in (e["added_by"], e["payer"], t["created_by"]):
            raise PermissionError("Only whoever added it, paid it or made the trip can delete it")
        db.execute("DELETE FROM expenses WHERE id=?", (eid,))


def add_settlement(tid: str, sub: str, profile: dict, body: dict) -> dict:
    t = trip_for(tid, sub)
    frm, to = str(body.get("from") or ""), str(body.get("to") or "")
    try:
        cents = int(body.get("cents"))
    except (TypeError, ValueError):
        raise ValueError("Amount required") from None
    if cents <= 0 or not frm or not to or frm == to:
        raise ValueError("Who paid whom, and how much")
    if t["source"] == "linked":
        _site_json("POST", "/api/settlements", profile, json_body={"from": frm, "to": to, "amountCentsCAD": cents})
        return {"ok": True}
    with _lock, _conn() as db:
        keys = set(_members(db, tid))
        if frm not in keys or to not in keys:
            raise ValueError("Both have to be on the trip")
        db.execute("INSERT INTO settlements(id, trip_id, payer, payee, cents, added_by, added_at) VALUES (?,?,?,?,?,?,?)",
                   (_id(), tid, frm, to, cents, sub, _now()))
    return {"ok": True}


# ── Receipts and photos ─────────────────────────────────────────────────────
def _check_image(data: bytes) -> str:
    if not data or len(data) > MAX_IMAGE:
        raise ValueError("That photo is too big (12 MB at most)")
    if not data.startswith(_IMAGE_MAGIC) and data[4:12] not in (b"ftypheic", b"ftypheix", b"ftypmif1"):
        raise ValueError("Photos only")
    if data.startswith(b"\x89PNG"):
        return ".png"
    if data.startswith(b"RIFF"):
        return ".webp"
    if data.startswith(b"GIF8"):
        return ".gif"
    return ".heic" if data[4:8] == b"ftyp" else ".jpg"


def _store(tid: str, data: bytes, prefix: str) -> str:
    ext = _check_image(data)
    d = MEDIA_DIR / tid
    d.mkdir(parents=True, exist_ok=True)
    name = f"{prefix}-{_id()}{ext}"
    (d / name).write_bytes(data)
    return name


def add_receipt(tid: str, sub: str, profile: dict, data: bytes) -> dict:
    t = trip_for(tid, sub)
    _check_image(data)
    if t["source"] == "linked":
        out = _site_json("POST", "/api/receipts", profile, files={"receipt": ("receipt.jpg", data, "image/jpeg")}, timeout=60)
        return {"receipt": out.get("name")}
    return {"receipt": _store(tid, data, "receipt")}


def media(tid: str, sub: str, profile: dict, name: str, kind: str) -> tuple[bytes, str]:
    """A receipt or a moment's photo: from here, or from trip.crcmz.me for the linked trip."""
    t = trip_for(tid, sub)
    name = os.path.basename(name)
    if t["source"] == "linked":
        path = f"/uploads/{name}" if kind == "receipt" else f"/moments/photo/{name}"
        r = _site("GET", path + ("?full=1" if kind == "full" else ""), profile, timeout=60)
        if r.status_code != 200:
            raise LookupError("Not found")
        return r.content, r.headers.get("content-type", "image/jpeg")
    p = MEDIA_DIR / tid / name
    if not p.is_file():
        raise LookupError("Not found")
    ext = p.suffix.lower()
    mime = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic",
            ".mp4": "video/mp4", ".mov": "video/quicktime"}.get(ext, "image/jpeg")
    return p.read_bytes(), mime


_RECEIPT_PROMPT = """This is a photo of a receipt or bill. Read it and return ONLY a JSON object, no prose:
{"merchant": "the store or restaurant name, short", "total": the final amount paid as a number (the grand total after tax and tip, not a subtotal or a single item), "currency": "CAD" or "USD" or another ISO code (Canadian addresses, GST/PST or HST mean CAD; a US address or state sales tax means USD), "date": "YYYY-MM-DD" or "", "summary": "what it was for in 2-5 words, e.g. groceries, dinner, gas", "confidence": 0 to 1}
If it is not a receipt or the total can't be read, return {"total": null, "confidence": 0}."""


def scan_receipt(data: bytes) -> dict:
    """Read the total, currency and place off a receipt photo (the AI server's vision
    model, the same prompt as trip.crcmz.me). Stores nothing."""
    import httpx
    _check_image(data)
    base = os.environ.get("OLLAMA_BASE_URL", "").strip().rstrip("/")
    if base and not base.endswith("/v1"):
        base += "/v1"
    if not base:
        raise RuntimeError("The receipt reader isn't set up")
    key = os.environ.get("OLLAMA_API_KEY", "").strip()
    mime = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    r = httpx.post(f"{base}/chat/completions", timeout=120, headers={"Authorization": f"Bearer {key}"} if key else {}, json={
        "model": RECEIPT_MODEL, "temperature": 0, "max_tokens": 400, "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}},
            {"type": "text", "text": _RECEIPT_PROMPT}]}]})
    r.raise_for_status()
    text = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    text = re.sub(r"<think>[\s\S]*?</think>", "", text)
    m = re.search(r"\{[\s\S]*\}", text)
    try:
        got = json.loads(m.group(0)) if m else {}
    except ValueError:
        got = {}
    total = got.get("total")
    try:
        total = float(total if isinstance(total, (int, float)) else re.sub(r"[^0-9.]", "", str(total or "")) or 0)
    except ValueError:
        total = 0
    cents = round(total * 100) if 0 < total < 100000 else 0
    if not cents:
        raise ValueError("Couldn't find a total on that. Try a straighter, closer photo, or type it in.")
    cur = str(got.get("currency") or "").upper()
    return {"ok": True, "cents": cents, "currency": cur if re.fullmatch(r"[A-Z]{3}", cur) else None,
            "other_currency": cur if re.fullmatch(r"[A-Z]{3}", cur) and cur not in ("CAD", "USD") else None,
            "merchant": str(got.get("merchant") or "")[:60], "summary": str(got.get("summary") or "")[:40],
            "date": got.get("date") if _DATE.match(str(got.get("date") or "")) else "",
            "confidence": got.get("confidence") if isinstance(got.get("confidence"), (int, float)) else None}


# ── Moments ─────────────────────────────────────────────────────────────────
def moments(tid: str, sub: str, profile: dict) -> dict:
    t = trip_for(tid, sub)
    if t["source"] == "linked":
        got = _site_json("GET", "/api/moments", profile)
        def fix(p):
            n = p.get("name", "")
            return {"name": n, "kind": p.get("kind", "image"), "thumb": f"/api/trips/{tid}/moments/photo/{n}",
                    "url": f"/api/trips/{tid}/moments/photo/{n}?full=1"}
        reel = got.get("reel") or None
        if reel and reel.get("url"):
            reel = {**reel, "url": f"/api/trips/{tid}/moments/reel"}
        return {"moments": [{**{k: m.get(k) for k in ("id", "by", "text", "at", "likes", "liked", "mine")},
                             "photos": [fix(p) for p in m.get("photos") or []]} for m in got.get("moments") or []],
                "reel": reel}
    people = _people_map()
    with _conn() as db:
        ms = [dict(r) for r in db.execute("SELECT * FROM moments WHERE trip_id=? ORDER BY at DESC", (tid,))]
        out = []
        for m in ms:
            photos = [dict(r) for r in db.execute("SELECT * FROM moment_photos WHERE moment_id=? ORDER BY ord", (m["id"],))]
            likes = [r["sub"] for r in db.execute("SELECT sub FROM moment_likes WHERE moment_id=?", (m["id"],))]
            out.append({"id": m["id"], "by": _name(m["by_sub"], people), "text": m["text"], "at": _iso(m["at"]),
                        "photos": [{"name": p["name"], "kind": p["kind"], "thumb": f"/api/trips/{tid}/moments/photo/{p['name']}",
                                    "url": f"/api/trips/{tid}/moments/photo/{p['name']}?full=1"} for p in photos],
                        "likes": len(likes), "liked": sub in likes, "mine": m["by_sub"] == sub})
    return {"moments": out, "reel": None}


def add_moment(tid: str, sub: str, profile: dict, text: str, photos: list[tuple[str, bytes, str]]) -> dict:
    t = trip_for(tid, sub)
    text = str(text or "").strip()[:1000]
    photos = photos[:10]
    if not text and not photos:
        raise ValueError("Say what happened, or add a photo")
    if t["source"] == "linked":
        files = [("photos", (n or "photo.jpg", d, ct or "image/jpeg")) for n, d, ct in photos]
        return _site_json("POST", "/api/moments", profile, data={"text": text}, files=files or None, timeout=120)
    names = [(_store(tid, d, "moment"), "image") for _, d, _ in photos]
    mid = _id()
    with _lock, _conn() as db:
        db.execute("INSERT INTO moments(id, trip_id, by_sub, text, at) VALUES (?,?,?,?,?)", (mid, tid, sub, text, _now()))
        for i, (n, kind) in enumerate(names):
            db.execute("INSERT INTO moment_photos(moment_id, name, kind, ord) VALUES (?,?,?,?)", (mid, n, kind, i))
    return {"ok": True, "moment": {"id": mid}}


def like_moment(tid: str, sub: str, profile: dict, mid: str) -> dict:
    t = trip_for(tid, sub)
    if t["source"] == "linked":
        return _site_json("POST", f"/api/moments/{mid}/like", profile)
    with _lock, _conn() as db:
        if not db.execute("SELECT 1 FROM moments WHERE id=? AND trip_id=?", (mid, tid)).fetchone():
            raise LookupError("That moment is gone")
        if db.execute("SELECT 1 FROM moment_likes WHERE moment_id=? AND sub=?", (mid, sub)).fetchone():
            db.execute("DELETE FROM moment_likes WHERE moment_id=? AND sub=?", (mid, sub))
        else:
            db.execute("INSERT INTO moment_likes(moment_id, sub) VALUES (?,?)", (mid, sub))
        likes = [r["sub"] for r in db.execute("SELECT sub FROM moment_likes WHERE moment_id=?", (mid,))]
    return {"likes": len(likes), "liked": sub in likes}


def delete_moment(tid: str, sub: str, profile: dict, mid: str) -> None:
    t = trip_for(tid, sub)
    if t["source"] == "linked":
        _site_json("DELETE", f"/api/moments/{mid}", profile)
        return
    with _lock, _conn() as db:
        m = db.execute("SELECT * FROM moments WHERE id=? AND trip_id=?", (mid, tid)).fetchone()
        if not m:
            raise LookupError("That moment is gone")
        if m["by_sub"] != sub and not _can_manage(t, sub):
            raise PermissionError("Only whoever posted it can delete it")
        for r in db.execute("SELECT name FROM moment_photos WHERE moment_id=?", (mid,)).fetchall():
            (MEDIA_DIR / tid / r["name"]).unlink(missing_ok=True)
        db.execute("DELETE FROM moment_photos WHERE moment_id=?", (mid,))
        db.execute("DELETE FROM moment_likes WHERE moment_id=?", (mid,))
        db.execute("DELETE FROM moments WHERE id=?", (mid,))


def reel(tid: str, sub: str, profile: dict) -> tuple[bytes, str]:
    t = trip_for(tid, sub)
    if t["source"] != "linked":
        raise LookupError("No reel")
    r = _site("GET", "/moments/reel.mp4", profile, timeout=120)
    if r.status_code != 200:
        raise LookupError("No reel yet")
    return r.content, "video/mp4"


# ── Shared receipts inbox (the phones' share sheet) ─────────────────────────
def inbox_add(sub: str, files: list[bytes]) -> dict:
    files = [f for f in files if f][:30]
    if not files:
        raise ValueError("No photos came through")
    iid = _id()
    d = MEDIA_DIR / "_inbox" / iid
    d.mkdir(parents=True, exist_ok=True)
    names = []
    for i, data in enumerate(files):
        ext = _check_image(data)
        n = f"{i}{ext}"
        (d / n).write_bytes(data)
        names.append(n)
    with _lock, _conn() as db:
        db.execute("INSERT INTO inbox(id, sub, files, created) VALUES (?,?,?,?)", (iid, sub, json.dumps(names), _now()))
    _inbox_sweep()
    return {"inbox": iid, "count": len(names)}


def inbox_get(sub: str, iid: str) -> dict:
    with _conn() as db:
        r = db.execute("SELECT * FROM inbox WHERE id=? AND sub=?", (iid, sub)).fetchone()
    if not r or _now() - r["created"] > INBOX_DAYS * 86400:
        raise LookupError("Those shared photos are gone. Share them again.")
    names = json.loads(r["files"])
    return {"files": [{"n": i, "url": f"/api/trips/inbox/{iid}/{i}",
                       "type": "image/png" if n.endswith(".png") else "image/jpeg"} for i, n in enumerate(names)]}


def inbox_file(sub: str, iid: str, n: int) -> tuple[bytes, str]:
    with _conn() as db:
        r = db.execute("SELECT * FROM inbox WHERE id=? AND sub=?", (iid, sub)).fetchone()
    if not r:
        raise LookupError("Not found")
    names = json.loads(r["files"])
    if not (0 <= n < len(names)):
        raise LookupError("Not found")
    p = MEDIA_DIR / "_inbox" / iid / names[n]
    if not p.is_file():
        raise LookupError("Not found")
    return p.read_bytes(), "image/png" if p.suffix == ".png" else "image/jpeg"


def _inbox_sweep() -> None:
    cutoff = _now() - INBOX_DAYS * 86400
    with _lock, _conn() as db:
        old = [r["id"] for r in db.execute("SELECT id FROM inbox WHERE created < ?", (cutoff,))]
        for iid in old:
            db.execute("DELETE FROM inbox WHERE id=?", (iid,))
    for iid in old:
        d = MEDIA_DIR / "_inbox" / iid
        if d.is_dir():
            for f in d.iterdir():
                f.unlink(missing_ok=True)
            d.rmdir()


# ── For the assistant (read-only, the asker's trips only) ───────────────────
def summary_for(sub: str) -> dict:
    """The asker's trips: who's going, and each app trip's money in short. Nothing about a
    trip they aren't invited to."""
    if not sub:
        return {"trips": [], "note": "Trips are private to the people invited. Ask from the app, signed in."}
    out = []
    for t in list_for(sub)["trips"]:
        row = {k: t[k] for k in ("name", "place", "start", "end", "currency", "linked")}
        row["going"] = [m["name"] for m in t["members"]]
        if not t["linked"]:
            try:
                s = split(t["id"], sub, {})
                names = {p["key"]: p["name"] for p in s["people"]}
                row["total"] = s["total_cents"] / 100
                row["balances"] = {names.get(k, k): v / 100 for k, v in s["balances"].items()}
                row["to_settle"] = [f"{names.get(x['from'])} pays {names.get(x['to'])} {x['cents'] / 100:.2f}" for x in s["settle"]]
                row["expenses"] = len(s["expenses"])
            except Exception as e:  # noqa: BLE001
                row["error"] = str(e)
        else:
            row["note"] = "The Split and Moments for this one are on trip.crcmz.me (the trip tools there have them)."
        out.append(row)
    return {"trips": out}
