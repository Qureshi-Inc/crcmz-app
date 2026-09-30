#!/usr/bin/env python3
"""Phase 5 evidence: DW-5.1 / DW-5.2 checks against JOURNEY.md.

Checks:
  DW-5.1  — every PS-n spec (PS-0 through PS-12) has a §Microcopy block (MC-PS-n),
             and each block covers all 9 states.
  DW-5.2  — no banned button labels ("OK", "Yes", "Submit", "Confirm" as bare labels),
             no urgency/scarcity phrases in Giveaway copy.

Run from the worktree root:  python3 .design-foundations/build/phase5-check.py [JOURNEY.md path]
Exits non-zero on any failure.

Negative-test: pass --mutate to drop one state row and verify the check fails.
"""
import re
import sys

MUTATE = "--mutate" in sys.argv
path = next((a for a in sys.argv[1:] if not a.startswith("-")), "JOURNEY.md")
J = open(path).read()

SPECS = [f"PS-{i}" for i in range(0, 13)]   # PS-0 … PS-12
MC_BLOCKS = [f"MC-PS-{i}" for i in range(0, 13)]
STATES = ["loading", "empty", "error", "stale", "429", "signed-out",
          "forbidden", "410-purged", "in-call"]

# Banned bare button labels (word-boundary match inside button copy)
# Pattern: label appears as a button/link label — look for the pattern in
# backtick-labeled control lines, e.g. [OK], [Yes], [Submit], [Confirm]
BANNED_LABELS_RE = re.compile(
    r"\[(?:OK|Yes|Submit|Confirm)\]",
    re.I
)

# Banned urgency/scarcity phrases — only checked inside the Giveaway microcopy block
BANNED_URGENCY = [
    re.compile(r"\bhurry\b", re.I),
    re.compile(r"\bonly\s+\d+\s+left\b", re.I),
    re.compile(r"\blast\s+chance\b", re.I),
    re.compile(r"\bdon'?t\s+miss\b", re.I),
]

fails = []

# ── split §Microcopy section ──────────────────────────────────────────────────
mc_section_match = re.search(r"^## §Microcopy", J, re.M)
if not mc_section_match:
    print("FAIL: §Microcopy section not found in JOURNEY.md")
    sys.exit(1)
mc_section = J[mc_section_match.start():]

# Split into per-PS blocks
mc_blocks_raw = re.split(r"^### (MC-PS-\d+) ·", mc_section, flags=re.M)
mc_map = {}
for i in range(1, len(mc_blocks_raw), 2):
    key = mc_blocks_raw[i]        # e.g. "MC-PS-0"
    body = mc_blocks_raw[i + 1]
    mc_map[key] = body

print(f"§Microcopy blocks found: {sorted(mc_map.keys())}")

# Optionally mutate: drop one state row from MC-PS-1 to verify the check fails
if MUTATE:
    if "MC-PS-1" in mc_map:
        mc_map["MC-PS-1"] = re.sub(r"^\| loading \|.*\n", "", mc_map["MC-PS-1"], count=1, flags=re.M)
        print("[MUTATE] Dropped 'loading' row from MC-PS-1")
    else:
        print("[MUTATE] MC-PS-1 not found; cannot mutate")

# ── DW-5.1: every PS-n has an MC-PS-n block with all 9 states ────────────────
print("\n--- DW-5.1: microcopy coverage ---")
for ps_idx in range(0, 13):
    ps_key = f"PS-{ps_idx}"
    mc_key = f"MC-PS-{ps_idx}"
    body = mc_map.get(mc_key)
    if body is None:
        fails.append(f"{mc_key}: block missing from §Microcopy")
        print(f"{mc_key:10} FAIL (block missing)")
        continue
    missing = [s for s in STATES if not re.search(rf"^\| {re.escape(s)} \|", body, re.M)]
    status = "OK" if not missing else "FAIL"
    print(f"{mc_key:10} states {len(STATES) - len(missing)}/9  {status}")
    for s in missing:
        fails.append(f"{mc_key}: missing state '{s}'")

# ── DW-5.2: banned labels anywhere in §Microcopy ─────────────────────────────
print("\n--- DW-5.2a: banned button labels ---")
banned_hits = BANNED_LABELS_RE.findall(mc_section)
if banned_hits:
    for hit in banned_hits:
        fails.append(f"banned button label: {hit!r}")
        print(f"  FAIL: {hit!r}")
else:
    print("  OK: no banned labels ([OK], [Yes], [Submit], [Confirm])")

# ── DW-5.2: banned urgency/scarcity in giveaway block ────────────────────────
print("\n--- DW-5.2b: urgency/scarcity in Giveaway (MC-PS-5) ---")
giveaway_body = mc_map.get("MC-PS-5", "")
urgency_hits = []
for pat in BANNED_URGENCY:
    for m in pat.finditer(giveaway_body):
        urgency_hits.append(m.group(0))
if urgency_hits:
    for hit in urgency_hits:
        fails.append(f"urgency/scarcity phrase in Giveaway: {hit!r}")
        print(f"  FAIL: {hit!r}")
else:
    print("  OK: no urgency/scarcity phrases in Giveaway copy")

# ── §Voice section present ────────────────────────────────────────────────────
print("\n--- §Voice section ---")
if "## §Voice" in J:
    print("  OK: §Voice section present")
else:
    fails.append("§Voice section missing from JOURNEY.md")
    print("  FAIL: §Voice section missing")

# ── result ────────────────────────────────────────────────────────────────────
print(f"\n§Microcopy blocks: {len(mc_map)}/13")
if fails:
    print("\nFAIL")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print("\nPASS")
