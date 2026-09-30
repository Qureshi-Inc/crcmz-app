#!/usr/bin/env python3
"""Phase 2 evidence: DW-2.1 / DW-2.2 checks against JOURNEY.md, server.py and reels.py.

Run from the worktree root:  python3 .design-foundations/build/phase2-check.py [JOURNEY.md path]
Exits non-zero on any failure.
"""
import re
import sys

J = open(sys.argv[1] if len(sys.argv) > 1 else "JOURNEY.md").read()
SERVER = open("server.py").read()
REELS = open("reels.py").read()

DESTS = ["Squad", "Clips", "Slap", "WhatsApp", "Giveaway", "Watch", "Huddle",
         "AI Coach", "Ask AI", "Settings", "Admin", "Portal"]
STATES = ["loading", "empty", "error", "stale", "429", "signed-out",
          "forbidden", "410-purged", "in-call"]
REQUIRED_PARTS = ["**Purpose:**", "**Rows:**", "**Endpoint contract", "**Mobile 375 (primary):**",
                  "**Desktop 1280 ("]
# Slap endpoints probed live on 2026-09-30 (all HTTP 200).
SLAP = {"/stats", "/ai/vibe-check", "/ai/digest", "/listening", "/leaderboard", "/hot",
        "/streaks", "/head-to-head/{}/{}", "/taste-dna/{}/{}", "/ai/recommendations/{}",
        "/timeline", "/genres", "/heatmap", "/artists", "/achievements", "/hipster",
        "/personalities", "/hall-of-fame", "/recent"}

fails = []


def norm(path: str) -> str:
    path = path.split("?")[0].rstrip("`").rstrip("/") or "/"
    path = re.sub(r"\{[^}]*\}", "{}", path)
    return path


# ── route table ───────────────────────────────────────────────────────────────
routes = set()
for m, p in re.findall(r'^@app\.(get|post|put|delete)\("([^"]+)"', SERVER, re.M):
    routes.add((m.upper(), norm(p)))
for m, p in re.findall(r'@router\.(get|post|put|delete)\("([^"]*)"', REELS):
    routes.add((m.upper(), norm("/api/reels" + p)))


def route_ok(method: str, path: str) -> bool:
    if (method, norm(path)) in routes:
        return True
    # `/api/clips/{uid}/resend` etc: {x:path} params normalise to {} already.
    return False


# ── split page specs ──────────────────────────────────────────────────────────
ps_section = J.split("## §Page specs", 1)[1]
blocks = re.split(r"^### (PS-\d+) · ", ps_section, flags=re.M)
specs = {}
for i in range(1, len(blocks), 2):
    specs[blocks[i]] = blocks[i + 1]

print(f"routes parsed: {len(routes)} (server.py + reels.py)")
dest_hits = 0
for n, name in enumerate(DESTS, start=1):
    key = f"PS-{n}"
    body = specs.get(key)
    if body is None or not body.startswith(name):
        fails.append(f"{key} {name}: spec heading missing")
        continue
    dest_hits += 1
    missing_parts = [p for p in REQUIRED_PARTS if p not in body]
    rows = {s: bool(re.search(rf"^\| {re.escape(s)} \|", body, re.M)) for s in STATES}
    missing_states = [s for s, ok in rows.items() if not ok]
    # endpoints: METHOD /path in backticks (or SLAP GET /path)
    eps = re.findall(r"`(GET|POST|PUT|DELETE) (/[^\s`]*)", body)
    eps += re.findall(r"`(POST)`/`DELETE (/[^\s`]*)", body)
    slap = re.findall(r"`SLAP GET (/[^\s`]*)`", body)
    ok_eps = [(m, p) for m, p in eps if route_ok(m, p)]
    bad_eps = sorted({f"{m} {p}" for m, p in eps if not route_ok(m, p)})
    bad_slap = sorted({p for p in slap if norm(p) not in SLAP})
    ok_slap = [p for p in slap if norm(p) in SLAP]
    na = len(re.findall(r"^\| [\w-]+ \| N/A", body, re.M))
    status = "OK" if not (missing_parts or missing_states or bad_eps or bad_slap) and (ok_eps or ok_slap) else "FAIL"
    print(f"{key:6} {name:9} states {9 - len(missing_states)}/9 (N/A {na})  "
          f"endpoints verified {len(set(ok_eps)) + len(set(ok_slap))}  parts {len(REQUIRED_PARTS) - len(missing_parts)}/{len(REQUIRED_PARTS)}  {status}")
    if missing_parts:
        fails.append(f"{key}: missing parts {missing_parts}")
    if missing_states:
        fails.append(f"{key}: missing states {missing_states}")
    if bad_eps:
        fails.append(f"{key}: endpoints not in server.py/reels.py: {bad_eps}")
    if bad_slap:
        fails.append(f"{key}: SLAP endpoints not in probed list: {bad_slap}")
    if not (ok_eps or ok_slap):
        fails.append(f"{key}: no verified endpoint")

print(f"destinations with a spec: {dest_hits}/12")

# ── inventory coverage ────────────────────────────────────────────────────────
inv = J.split("## §Inventory", 1)[1].split("## §Job", 1)[0]
rows = re.findall(r"^\| ([A-Z]{1,2}-\d\d) \|.*?\| (KEEP|MOVE|EXCLUDE)[^|]*\|", inv, re.M)
keepmove = [i for i, d in rows if d in ("KEEP", "MOVE")]
excluded = [i for i, d in rows if d == "EXCLUDE"]
cited = set(re.findall(r"\b([A-Z]{1,2}-\d\d)\b", ps_section))
uncited = [i for i in keepmove if i not in cited]
print(f"inventory: {len(rows)} rows · KEEP {sum(d == 'KEEP' for _, d in rows)} · "
      f"MOVE {sum(d == 'MOVE' for _, d in rows)} · EXCLUDE {len(excluded)}")
print(f"keep/move rows cited in §Page specs: {len(keepmove) - len(uncited)}/{len(keepmove)}")
if uncited:
    fails.append(f"uncited keep/move rows: {uncited}")

# every keep/move row cited in some page spec's **Rows:** line (stronger than a mention)
rows_lines = " ".join(re.findall(r"\*\*Rows:\*\*(.*)", ps_section))
not_in_rows = [i for i in keepmove if i not in rows_lines]
print(f"keep/move rows listed on a **Rows:** line: {len(keepmove) - len(not_in_rows)}/{len(keepmove)}")
if not_in_rows:
    fails.append(f"keep/move rows not on any **Rows:** line: {not_in_rows}")

# flows present
flows = re.findall(r"^### (F-\d) ", J, re.M)
print(f"flows: {flows}")
need = {f"F-{i}" for i in range(0, 9)}
if not need <= set(flows):
    fails.append(f"missing flows {sorted(need - set(flows))}")

# ── device priority (brief amendment 2026-09-30: mobile first) ────────────────
# Markers: **Mobile 375 (primary):** leads; **Desktop 1280 (reflow):** is the default
# (block <= 3 lines); **Desktop 1280 (bespoke):** only in PS-4, PS-5, and PS-2 as
# "**Desktop 1280 (bespoke) · Studio editor:**". Bespoke specs carry **Mobile fallback:**.
MOBILE = "**Mobile 375 (primary):**"
REFLOW = "**Desktop 1280 (reflow):**"
BESPOKE_RE = re.compile(r"^\*\*Desktop 1280 \(bespoke\)(.*?):\*\*", re.M)
BESPOKE_OK = {"PS-4": "", "PS-5": "", "PS-2": " · Studio editor"}
DESK_RE = re.compile(r"^\*\*Desktop 1280 \((reflow|bespoke)\)", re.M)
dev_fail = 0
for key in sorted(specs, key=lambda k: int(k.split("-")[1])):
    body = specs[key]
    errs = []
    m_at = body.find(MOBILE)
    d = DESK_RE.search(body)
    if m_at < 0:
        errs.append("no mobile-primary marker")
    if not d:
        errs.append("no desktop marker")
    elif m_at >= 0 and d.start() < m_at:
        errs.append("desktop marker comes before the mobile-primary layout")
    for bm in BESPOKE_RE.finditer(body):
        if key not in BESPOKE_OK:
            errs.append("bespoke desktop outside {PS-2 Studio, PS-4, PS-5}")
        elif bm.group(1) != BESPOKE_OK[key]:
            errs.append(f"bespoke marker must read '(bespoke){BESPOKE_OK[key]}'")
    if BESPOKE_RE.search(body) and "**Mobile fallback:**" not in body:
        errs.append("bespoke desktop without a **Mobile fallback:**")
    for rm in re.finditer(re.escape(REFLOW), body):
        block = body[rm.start():].split("\n\n", 1)[0]
        n = len([ln for ln in block.splitlines() if ln.strip()])
        if n > 3:
            errs.append(f"reflow block is {n} lines (max 3)")
    kinds = sorted(set(k for k in DESK_RE.findall(body)))
    print(f"{key:6} device: mobile-first {'yes' if m_at >= 0 else 'NO'} · desktop {'+'.join(kinds) or '-'}"
          f"  {'OK' if not errs else 'FAIL'}")
    for e in errs:
        fails.append(f"{key}: {e}")
        dev_fail += 1
print(f"desktop markers: {'PASS' if not dev_fail else 'FAIL'} ({len(specs)} specs incl. PS-0)")

# ── nothing relies on hover / mouse-only / hotkeys (§Flows + §Page specs) ─────
fl_ps = J.split("## §Flows", 1)[1]
BAD = re.compile(r"hover|mouse|double-click|right-click|hotkey", re.I)
NEG = re.compile(r"\b(no|never|not|nothing|without)\b", re.I)
hov = [ln.strip()[:90] for ln in fl_ps.splitlines() if BAD.search(ln) and not NEG.search(ln)]
print(f"hover/mouse/hotkey lines that are not negations: {len(hov)}")
for ln in hov:
    fails.append(f"hover/mouse/hotkey dependency: {ln}")

if fails:
    print("\nFAIL")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print("\nPASS")
