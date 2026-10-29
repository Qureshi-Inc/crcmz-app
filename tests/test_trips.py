"""trips.py: invite-only trips, the Split's money, Moments, the shared-receipts inbox, and
the linked trip going through trip.crcmz.me's bridge (a local stub of it here)."""
import base64, json, os, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TMP = Path(tempfile.mkdtemp())
results = []


def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        results.append((name, False, repr(e)))
        print(f"  ✗ {name}\n      {e!r}")


# ── a stub trip.crcmz.me bridge ─────────────────────────────────────────────
SITE = {"expenses": [], "settlements": [], "moments": [], "calls": []}


class Bridge(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _who(self):
        if self.headers.get("x-trip-app") != "bridge-key":
            return None
        return json.loads(base64.b64decode(self.headers.get("x-trip-user", "")))

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        who = self._who()
        SITE["calls"].append(("GET", self.path, who))
        if who is None:
            return self._send(403, {"error": "Not allowed."})
        if self.path == "/api/expenses":
            return self._send(200, {"expenses": SITE["expenses"], "settlements": SITE["settlements"]})
        if self.path == "/api/me":
            return self._send(200, {"person": "Moiz" if "Moiz" in who["name"] else None, "people": ["Mutasif", "Moiz", "Noor"]})
        if self.path == "/api/fx":
            return self._send(200, {"usdCad": 1.4})
        if self.path == "/api/moments":
            return self._send(200, {"moments": [{"id": "m1", "by": "Noor", "text": "hi", "at": "2026-10-30T01:00:00Z",
                                                 "photos": [{"name": "p.jpg", "kind": "image"}], "likes": 1, "liked": False, "mine": False}],
                                    "reel": {"status": "ready", "url": "/moments/reel.mp4?v=1"}})
        if self.path.startswith("/uploads/") or self.path.startswith("/moments/photo/"):
            return self._send(200, b"\xff\xd8\xffJPEG", "image/jpeg")
        return self._send(404, {"error": "no"})

    def do_POST(self):
        who = self._who()
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n)
        SITE["calls"].append(("POST", self.path, who))
        if who is None:
            return self._send(403, {"error": "Not allowed."})
        if self.path == "/api/expenses":
            e = json.loads(raw)
            if e["payer"] not in ("Mutasif", "Moiz", "Noor") or sum(e["shares"].values()) != e["amountCentsCAD"]:
                return self._send(400, {"error": "Invalid expense."})
            e = {**e, "id": f"e{len(SITE['expenses']) + 1}", "addedBy": who["name"], "addedAt": "2026-10-30T02:00:00Z"}
            SITE["expenses"].append(e)
            return self._send(201, {"ok": True, "expense": e})
        if self.path == "/api/receipts":
            return self._send(201, {"ok": True, "name": "receipt-1.jpg"})
        if self.path == "/api/settlements":
            s = json.loads(raw)
            SITE["settlements"].append({**s, "id": "s1", "addedAt": "x"})
            return self._send(201, {"ok": True})
        if self.path == "/api/moments":
            return self._send(201, {"ok": True, "moment": {"id": "m2"}, "multipart": b"Content-Disposition" in raw})
        return self._send(404, {"error": "no"})

    def do_DELETE(self):
        SITE["calls"].append(("DELETE", self.path, self._who()))
        self._send(200, {"ok": True})


srv = HTTPServer(("127.0.0.1", 0), Bridge)
threading.Thread(target=srv.serve_forever, daemon=True).start()
for k, v in (("SESSION_SECRET", "test-secret-for-trips"), ("NPSSO_TOKEN", "test-npsso"), ("GROUP_ID", "test-group"),
             ("PORTAL_PUBLIC_HOST", "app.crcmz.me")):
    os.environ.setdefault(k, v)
os.environ["TRIP_SITE_URL"] = f"http://127.0.0.1:{srv.server_address[1]}"
os.environ["TRIP_APP_TOKEN"] = "bridge-key"

import trips as T  # noqa: E402

T._DB_PATH = TMP / "trips.db"
T.MEDIA_DIR = TMP / "media"
T._ready = False
PEOPLE = {"1": {"display_name": "Moiz Qureshi"}, "2": {"display_name": "Noor X"}, "3": {"display_name": "Samad Y"},
          "4": {"display_name": "Zubi Z"}}
T._people_map = lambda: PEOPLE
T._founder = lambda sub: sub == "4"
T.fx = lambda src, dst: 1.4 if (src, dst) == ("USD", "CAD") else 1.0
T.init()
JPG = b"\xff\xd8\xff\xe0" + b"0" * 200
ME = {"sub": "1", "name": "Moiz Qureshi", "preferred_username": "moiz", "email": "m@x"}


def only_invitees_see_a_trip():
    t = T.create("1", name="Banff", place="Banff", start="2027-02-01", end="2027-02-03", members=["2"])
    assert [m["sub"] for m in t["members"]] == ["1", "2"] or set(m["sub"] for m in t["members"]) == {"1", "2"}
    assert t["can_manage"] and not t["linked"]
    assert [x["name"] for x in T.list_for("2")["trips"]] == ["Banff"]
    assert T.list_for("3")["trips"] == []                                # not invited: not there
    for who in ("3", ""):
        try:
            T.split(t["id"], who, {}); raise AssertionError("an uninvited person read the Split")
        except LookupError:
            pass                                                         # a 404, not a 403
    try:
        T.update(t["id"], "2", {"name": "x"}); raise AssertionError("an invitee changed the trip")
    except PermissionError:
        pass
    globals()["TID"] = t["id"]


def the_creator_manages_who_is_invited():
    t = T.update(TID, "1", {"members": ["2", "3"]})
    assert {m["sub"] for m in t["members"]} == {"1", "2", "3"}
    assert T.list_for("3")["trips"]
    t = T.update(TID, "1", {"members": []})
    assert {m["sub"] for m in t["members"]} == {"1"}                     # the creator always stays
    T.update(TID, "1", {"members": ["2", "3"]})
    for bad in ({"name": ""}, {"start": "tomorrow"}, {"start": "2027-02-05", "end": "2027-02-01"}):
        try:
            T.update(TID, "1", bad); raise AssertionError(f"accepted {bad}")
        except ValueError:
            pass


def the_split_adds_up_and_settles():
    T.add_expense(TID, "1", ME, {"payer": "1", "desc": "Cabin", "currency": "CAD", "orig_cents": 30001, "parts": ["1", "2", "3"]})
    T.add_expense(TID, "2", {}, {"payer": "2", "desc": "Gas", "currency": "USD", "orig_cents": 5000, "parts": ["2", "3"]})
    s = T.split(TID, "1", ME)
    assert s["currency"] == "CAD" and s["total_cents"] == 30001 + 7000, s["total_cents"]
    cabin = next(e for e in s["expenses"] if e["desc"] == "Cabin")
    assert sum(cabin["shares"].values()) == 30001 and sorted(cabin["shares"].values()) == [10000, 10000, 10001]
    gas = next(e for e in s["expenses"] if e["desc"] == "Gas")
    assert gas["currency"] == "USD" and gas["orig_cents"] == 5000 and gas["cents"] == 7000
    assert s["balances"] == {"1": 30001 - 10001, "2": 7000 - 10000 - 3500, "3": -10000 - 3500}, s["balances"]
    assert sum(s["balances"].values()) == 0
    paid = {}
    for x in s["settle"]:
        paid[x["from"]] = paid.get(x["from"], 0) - x["cents"]
        paid[x["to"]] = paid.get(x["to"], 0) + x["cents"]
    assert all(paid.get(k, 0) == v for k, v in s["balances"].items()), (s["settle"], s["balances"])
    x = s["settle"][0]
    T.add_settlement(TID, x["from"], {}, {"from": x["from"], "to": x["to"], "cents": x["cents"]})
    s2 = T.split(TID, "1", ME)
    assert len(s2["settle"]) == len(s["settle"]) - 1
    try:
        T.add_expense(TID, "1", ME, {"payer": "4", "orig_cents": 100, "parts": ["1"], "currency": "CAD"}); raise AssertionError("payer not on trip")
    except ValueError:
        pass
    e = next(e for e in s["expenses"] if e["desc"] == "Gas")
    try:
        T.delete_expense(TID, "3", {}, e["id"]); raise AssertionError("someone else's expense deleted")
    except PermissionError:
        pass
    T.delete_expense(TID, "2", {}, e["id"])


def receipts_are_kept_with_the_trip():
    r = T.add_receipt(TID, "1", ME, JPG)
    assert r["receipt"].startswith("receipt-") and (T.MEDIA_DIR / TID / r["receipt"]).is_file()
    T.add_expense(TID, "1", ME, {"payer": "1", "orig_cents": 999, "parts": ["1", "2"], "currency": "CAD", "receipt": r["receipt"]})
    s = T.split(TID, "2", {})
    url = next(e["receipt_url"] for e in s["expenses"] if e["receipt_url"])
    data, mime = T.media(TID, "2", {}, url.rsplit("/", 1)[1], "receipt")
    assert data == JPG and mime == "image/jpeg"
    for bad in (b"<html>", b""):
        try:
            T.add_receipt(TID, "1", ME, bad); raise AssertionError("a non-image stored")
        except ValueError:
            pass
    try:
        T.add_expense(TID, "1", ME, {"payer": "1", "orig_cents": 5, "parts": ["1"], "currency": "CAD", "receipt": "../../trips.db"})
        raise AssertionError("a receipt outside the trip accepted")
    except ValueError:
        pass


def moments_post_like_and_delete():
    T.add_moment(TID, "2", {}, "First chairlift", [("a.jpg", JPG, "image/jpeg")])
    m = T.moments(TID, "1", ME)["moments"][0]
    assert m["by"] == "Noor" and m["text"] == "First chairlift" and len(m["photos"]) == 1 and not m["mine"]
    assert T.like_moment(TID, "1", ME, m["id"]) == {"likes": 1, "liked": True}
    assert T.like_moment(TID, "1", ME, m["id"]) == {"likes": 0, "liked": False}
    try:
        T.delete_moment(TID, "3", {}, m["id"]); raise AssertionError("someone else's moment deleted")
    except PermissionError:
        pass
    T.delete_moment(TID, "1", ME, m["id"])                              # the trip's creator can
    assert T.moments(TID, "1", ME)["moments"] == []
    try:
        T.add_moment(TID, "1", ME, "  ", []); raise AssertionError("an empty moment posted")
    except ValueError:
        pass


def the_shared_inbox_is_yours_only():
    r = T.inbox_add("1", [JPG, JPG])
    assert r["count"] == 2
    got = T.inbox_get("1", r["inbox"])
    assert [f["n"] for f in got["files"]] == [0, 1]
    assert T.inbox_file("1", r["inbox"], 1)[0] == JPG
    for who in ("2", ""):
        try:
            T.inbox_get(who, r["inbox"]); raise AssertionError("someone else's shares read")
        except LookupError:
            pass
    try:
        T.inbox_add("1", [b"not an image"]); raise AssertionError("a non-image accepted")
    except ValueError:
        pass


def the_linked_trip_goes_through_trip_crcmz_me():
    assert T.list_for("1")["can_link"]
    t = T.create("1", name="Calgary", members=["2"], link=True)
    assert t["linked"] and t["site_url"].startswith("http") and not T.list_for("1")["can_link"]
    try:
        T.create("1", name="Again", link=True); raise AssertionError("two linked trips")
    except ValueError:
        pass
    SITE["calls"].clear()
    T.add_expense(t["id"], "1", ME, {"payer": "Moiz", "desc": "Groceries", "currency": "USD", "orig_cents": 1000, "parts": ["Moiz", "Noor"]})
    e = SITE["expenses"][-1]
    assert e["amountCentsCAD"] == 1400 and e["fxRate"] == 1.4 and e["shares"] == {"Moiz": 700, "Noor": 700}, e
    assert all(c[2] and c[2]["name"] == "Moiz Qureshi" and c[2]["sub"] == "1" for c in SITE["calls"]), SITE["calls"]
    s = T.split(t["id"], "1", ME)
    assert s["me"] == "Moiz" and [p["key"] for p in s["people"]] == ["Mutasif", "Moiz", "Noor"] and s["fx"]["USD"] == 1.4
    assert s["balances"]["Moiz"] == 700 and s["balances"]["Noor"] == -700 and s["settle"] == [{"from": "Noor", "to": "Moiz", "cents": 700}]
    r = T.add_receipt(t["id"], "1", ME, JPG)
    assert r == {"receipt": "receipt-1.jpg"}
    assert T.media(t["id"], "1", ME, "receipt-1.jpg", "receipt")[0].startswith(b"\xff\xd8\xff")
    ms = T.moments(t["id"], "1", ME)
    assert ms["moments"][0]["photos"][0]["thumb"] == f"/api/trips/{t['id']}/moments/photo/p.jpg"
    assert ms["reel"]["url"] == f"/api/trips/{t['id']}/moments/reel"     # through the app, not the site's URL
    out = T.add_moment(t["id"], "1", ME, "Landed", [("a.jpg", JPG, "image/jpeg")])
    assert out["ok"] and out["multipart"]
    try:
        T.split(t["id"], "3", {}); raise AssertionError("an uninvited person reached the linked trip")
    except LookupError:
        pass
    calls = len(SITE["calls"])
    try:
        T.split(t["id"], "3", {})
    except LookupError:
        pass
    assert len(SITE["calls"]) == calls                                   # ...and it never asked the site
    T.delete(t["id"], "1")
    assert SITE["expenses"], "deleting the linked trip in the app leaves the site's Split alone"
    assert T.list_for("1")["can_link"]


def the_assistant_sees_only_your_trips():
    mine = T.summary_for("1")["trips"]
    assert [t["name"] for t in mine] == ["Banff"] and "balances" in mine[0] and "Moiz" in mine[0]["balances"]
    assert T.summary_for("4")["trips"] == []
    assert T.summary_for("")["trips"] == [] and "private" in T.summary_for("")["note"]


def deleting_a_trip_takes_its_things():
    T.delete(TID, "1")
    assert T.list_for("1")["trips"] == [] and not (T.MEDIA_DIR / TID).exists()


def http_routes_check_the_session_and_the_invite():
    try:
        from fastapi.testclient import TestClient
        import server
    except ModuleNotFoundError:
        print("      (skipped: run in the image for the HTTP checks)")
        return
    T._people_map = lambda: PEOPLE
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    hdr = {"Origin": "https://app.crcmz.me", "Accept": "application/json"}
    def as_(sub):
        client.cookies.set(server._SESSION_COOKIE, server._signer().dumps({"sub": sub, "iss": "https://auth.crcmz.me", "name": "x"}))
    client.cookies.clear()
    assert client.get("/api/trips", headers=hdr).status_code == 401
    assert client.post("/api/trips/inbox", headers=hdr, files={"files": ("a.jpg", JPG, "image/jpeg")}).status_code == 401
    as_("1")
    r = client.post("/api/trips", headers=hdr, json={"name": "Jasper", "members": ["2"]})
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    assert client.get(f"/api/trips/{tid}/split", headers=hdr).json()["me"] == "1"
    r = client.post(f"/api/trips/{tid}/receipts", headers=hdr, files={"receipt": ("r.jpg", JPG, "image/jpeg")})
    assert r.status_code == 200 and r.json()["receipt"].startswith("receipt-"), r.text
    r = client.post(f"/api/trips/{tid}/expenses", headers=hdr, json={"payer": "1", "currency": "CAD", "orig_cents": 1200,
                                                                     "parts": ["1", "2"], "receipt": r.json()["receipt"]})
    assert r.status_code == 200, r.text
    r = client.post("/api/trips/inbox", headers=hdr, files=[("files", ("a.jpg", JPG, "image/jpeg")), ("files", ("b.jpg", JPG, "image/jpeg"))])
    assert r.status_code == 200 and r.json()["count"] == 2, r.text
    iid = r.json()["inbox"]
    assert client.get(f"/api/trips/inbox/{iid}/1", headers=hdr).content == JPG
    r = client.post("/api/trips/receipts/scan", headers=hdr, files={"receipt": ("r.jpg", JPG, "image/jpeg")})
    assert r.status_code in (502, 503) and "error" in r.json() or "detail" in r.json(), r.text   # no AI server here: a clear error
    as_("3")
    assert client.get(f"/api/trips/{tid}/split", headers=hdr).status_code == 404                    # not invited
    assert client.get(f"/api/trips/inbox/{iid}", headers=hdr).status_code == 404                    # not your shares
    assert client.patch(f"/api/trips/{tid}", headers=hdr, json={"name": "x"}).status_code == 404
    as_("2")
    assert client.patch(f"/api/trips/{tid}", headers=hdr, json={"name": "x"}).status_code == 403    # invited, not the maker
    assert [t["name"] for t in client.get("/api/trips", headers=hdr).json()["trips"]] == ["Jasper"]
    client.cookies.clear()


print("trips")
for fn in (only_invitees_see_a_trip, the_creator_manages_who_is_invited, the_split_adds_up_and_settles,
           receipts_are_kept_with_the_trip, moments_post_like_and_delete, the_shared_inbox_is_yours_only,
           the_linked_trip_goes_through_trip_crcmz_me, the_assistant_sees_only_your_trips, deleting_a_trip_takes_its_things,
           http_routes_check_the_session_and_the_invite):
    check(fn.__name__, fn)
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
