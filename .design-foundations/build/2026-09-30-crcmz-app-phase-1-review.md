# Design Review: Phase 1 — CRCMZ App Inventory & IA

**Reviewer:** design-review-agent (independent; did not produce the artifact)
**Date:** 2026-09-30
**Artifact:** `JOURNEY.md` (working-directory root) vs. `_DASHBOARD_TMPL` in `server.py`

---

## Rendered Evidence (Step 0)

- Screenshot: none — spec-only artifact (JOURNEY.md + server.py); no rendered surface to screenshot
- Surface: JOURNEY.md §Inventory and §IA; the rendered surface is the spec document itself and server.py as the source of truth

## Assessment B — Deterministic Detector

- Command: `node scripts/detect.mjs` (no HTML path — spec-only phase)
- Exit: N/A — `scripts/detect.mjs` not present in this worktree; the dispatch prompt explicitly establishes "no rendered surface → the detector is N/A for this phase, not a failure"
- Findings: N/A — no rendered artifact
- Opened only after Assessment A findings were frozen: YES

## Triage

- Baseline (always-on): visual + usability — visual baseline deferred (no rendered pixels); usability applied to IA structure and gesture handling
- Dispatched: `journey` (the artifact is JOURNEY.md — IA, JTBD job stories, journey map, page-spec precursor, JOURNEY.md format); `usability` (navigation structure, gesture-to-visible-equivalent decisions, Hick/Fitts/Miller application in the IA)
- Not applicable: `content-design` (no final product copy to audit — microcopy deferred to Phase 5 per the plan); `data-viz` (no charts in the spec); `behavioral` / `deceptive-patterns` (not a persuasion surface); `design-dna` / `ai-tells` (no rendered pixels)
- Deferred: none — the spec is bounded; both dispatched pillars were applied in full

---

## Assessment A — Findings Frozen Before Opening detect.json

*(Gathered independently from JOURNEY.md + server.py before any detector output was read.)*

### What was independently verified in server.py

| Check | Method | Finding |
|---|---|---|
| `id="p-"` panel inventory | `grep -n 'id="p-'` | 10 panels found: p-squad, p-lb, p-pipeline, p-slap, p-wa, p-coach, p-ai, p-giveaway, p-watch, p-huddle. All 10 have inventory rows. |
| `setInterval` count | `grep -c "setInterval"` | Exactly 13 — matches the Pollers table claim of "all 13 `setInterval`". |
| `fetch()` spot-check | `grep -n "fetch("` | Sampled: `/v2/squad`, `/api/hype`, `/api/pipeline-status`, `/api/assistant/*`, `/api/coaching/*`, `/api/video-uploads/*`, all SLAP endpoints, `/api/giveaway/*`, `/api/soundboard*`, `/api/reels*`. All map to inventory rows. |
| Gesture handlers | `grep -n "bindBoardSwipe\|bindLongPress\|enterOrganize\|wpBindOrbPress"` | All 4 gesture-bound functions confirmed in template. All have inventory rows with visible equivalents. |
| GW-13 auto-reveal side effect | Lines 13954–13955, 14028 | `loadGiveaway` and `gwStartCountdown` both POST `draw-and-reveal`. EXCLUDE disposition with "Rendering must never mutate" is accurate. |
| GW-14 separate lock/draw/reveal | Lines 14169–14171 | Functions `gwLock`, `gwDraw`, `gwReveal` exist but `grep -n "onclick.*gwLock\|onclick.*gwDraw\|onclick.*gwReveal"` returns nothing. EXCLUDE "No legacy UI reaches them" is accurate. |
| ST-11 legacy passkey shortcut | `grep -n "registerPasskey"` | Function defined at line 13082 only. No `onclick` or button connects to it. EXCLUDE "Not reachable from any current control" is accurate. |
| WP-23 watch event endpoint | `grep -n "api/watch/event"` | Route exists at line 5462 (server route). No call site in the template JavaScript. EXCLUDE "No legacy UI" is accurate. |
| CB-12 board hint text | `grep -n "boardHint"` | Line 9937 confirms the exact hint text "swipe left for your own board · tap title to minimize · hold in fullscreen to organize" is present. EXCLUDE "only existed to reveal hidden gestures" is accurate. |
| G-10/G-11 layout workarounds | `grep -n "syncBoardHeight\|board-off\|loadAsk"` | Both confirmed present and tied to the structural problem described. EXCLUDE dispositions are accurate. |
| Research-listed items outside template | CL-29/30/31/32, AD-03, AD-07 | Routes confirmed in server.py (`/clips`, `/api/clips/{uid}`, `/api/video-jobs`, `/status`, `/roast/*`). All have inventory rows with dispositions. |
| `_DASHBOARD_TMPL` line boundaries | `grep -n "_DASHBOARD_TMPL"` | Template starts at line 7557 as stated. |

### Cross-Pillar Findings

No findings that rise to Major or Critical severity.

**Minor — journey / usability:** §IA tree-test deferral. Journey doctrine (Rosenfeld/Morville: validate with card sorting and tree testing before visual design) calls for tree testing before code. The §IA explicitly names 5 squad members + 6 tasks as the follow-up and states "This is a follow-up; it is not blocking Phase 2." The gap is disclosed rather than hidden — this satisfies the theater-risk disclosure requirement of journey.md — but the test is unrun. **Fix:** complete the tree test (target ≥ 80% direct success) before Phase 3 commits to route labels; if any label fails, the §IA URL map will need revision before the frontend is built. This is a planning note, not a spec defect; no requirement prohibits deferring the test to Phase 2.

**Note — journey:** §Journey bases the four-forces switch analysis and the journey map entirely on brief + code audit with no field interviews. The document correctly flags this per the theater-risk requirement: "This is a hypothesis map, not evidence (Watermark 2023 warns maps without an owner and basis become theater)." Owner (Moiz) and update cadence are named. Theater risk is disclosed. This is compliant with journey doctrine §C.5.

**Note — usability:** §IA cites Hick–Hyman 1952 for the 6+3 grouped More sheet layout and Miller/Cowan for the broad-shallow tree. Both citations are correctly applied: visible item count (broad nav) is distinct from working-memory load (Miller/Cowan), and the doc correctly names this distinction ("Miller's law revised to Cowan (~4±1 chunks) governs information chunking… broad navigation can outperform deep navigation"). No error.

---

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|---|---|---|---|---|
| Minor | journey / usability | Tree test is deferred; the 12-destination label set is currently validated only by familiarity ("the squad's existing labels") with no measured direct-success rate | Rosenfeld/Morville: validate IA with card sorting and tree testing before visual design | Run tree test (5 squad members, 6 tasks) before Phase 3 route labels are committed to the frontend; document results in §IA |

No Major or Critical findings.

---

## Requirement Fulfillment

### DW-1.1
PREMISE:  JOURNEY.md §Inventory lists every capability found in `_DASHBOARD_TMPL`, each with a disposition
EVIDENCE: Independent grep audit of server.py confirmed:
  - All 10 `id="p-"` panels are inventoried (p-squad → SQ, p-lb → G-12 EXCLUDE, p-pipeline → CL, p-slap → SL, p-wa → WA, p-coach → CO, p-ai → AI, p-giveaway → GW, p-watch → WP, p-huddle → HU)
  - All 13 `setInterval` pollers match the Pollers section rows (confirmed exact count)
  - `fetch()` calls spot-checked across soundboard, squad, hype, pipeline, AI, coaching, uploads, slap (all 13 SLAP endpoints), giveaway, reels — every sampled call maps to an inventory row
  - All 4 gesture-bound handlers (bindBoardSwipe, bindLongPress, enterOrganize, wpBindOrbPress) have inventory rows
  - All EXCLUDE dispositions independently verified: G-10 (layout workaround), G-11 (chat-board covers composer), CB-12 (hint text present, reason confirmed), GW-13 (auto-reveal side effect confirmed at lines 13954, 14028), GW-14 (helper functions present, no UI button), WP-23 (route present, no template call site), ST-11 (function present, no button wires it)
  - Research-listed capabilities outside the template (CL-29/30/31/32, AD-03/07, PO-01–05) are included with dispositions
  - Pollers table explicitly covers all 13 intervals and maps each to a row
VERDICT:  PASS

### DW-1.2
PREMISE:  §IA places all 12 destinations in both the desktop sidebar and the mobile bottom-bar + More sheet, each reachable in ≤2 taps

The 12 destinations: Squad, Clips, Slap, WhatsApp, Giveaway, Watch, Huddle, AI Coach, Ask AI, Settings, Admin, Portal.

EVIDENCE: From the §IA Destinations table and the Reachability table:

Desktop sidebar (≥ 1024 px):
  - Main list (1 click): Squad, Clips, Slap, WhatsApp, Giveaway, Watch, Huddle, AI Coach, Ask AI
  - Footer group (1 click): Portal ("Link PSN"), Settings, Admin
  - 12/12 destinations present, all at 1 click

Mobile (< 1024 px):
  - Tab bar (1 tap): Squad, Watch, Clips → 3 destinations
  - More sheet (2 taps — tap More then tap destination):
    - Squad group: Slap, WhatsApp, Giveaway, Huddle, AI Coach, Ask AI → 6 destinations
    - Account group: Link PSN (Portal), Settings, Admin → 3 destinations
  - 12/12 destinations present; maximum is 2 taps
  - §IA explicitly states "Result: 12/12 destinations in the sidebar (max 1 click) and 12/12 in the tab bar + More sheet (3 in the tab bar at 1 tap, 9 in More at 2 taps). The maximum is 2 taps."
  - Reachability table provides per-destination evidence for all 12 rows, including Admin (admin persona, confirmed role-gated but listed)

All 12 destinations are present in both nav systems. Maximum reachability depth is 1 click (desktop) and 2 taps (mobile), meeting the ≤2 taps requirement.
VERDICT:  PASS

**All requirements met:** YES

---

## Edge Case Fulfillment

### EC-1: Gesture-only capabilities must have a visible equivalent in the inventory disposition
PREMISE:  Capabilities only reachable by gesture (personal-board horizontal swipe, long-press organize/reorder) must get a visible equivalent in the inventory disposition
EVIDENCE: The §Inventory contains a dedicated "Gesture-only capabilities → visible equivalents" table. Independent verification against server.py:

| Gesture | Row | Visible equivalent in JOURNEY.md | Principle cited | Code confirmed |
|---|---|---|---|---|
| Horizontal swipe shared ⇄ personal board | CB-04 | Labeled **Shared / Mine** tabs | WCAG 2.2 SC 2.5.1; Norman: signifiers | `bindBoardSwipe` at line 10070 ✓ |
| Long-press 600 ms to delete custom tile | CB-06 | **Edit** toggle + ✕ per tile | WCAG 2.5.1; Nielsen #6 | `bindLongPress` at line 10210 ✓ |
| Fullscreen + long-press to organize; drag to reorder | CB-07 | **Organize** button + **Move earlier / Move later** | Nielsen #6; WCAG 2.2 SC 2.5.7 | `enterOrganize` at line 10126 ✓ |
| Drag manual crop box | CL-17 | X-position slider + ◀ ▶ nudge | WCAG 2.5.7 | Crop tool present in Studio ✓ |
| Drag timeline handles | CL-15 | Existing **Start here / End here** buttons | WCAG 2.5.7 (already met) | `renderTimeline` confirmed ✓ |
| Long-press / right-click Watch orb | WP-12 | **⋯** button on every orb | WCAG 2.5.1; Norman: signifiers | `wpBindOrbPress` at line 14862 ✓ |
| Double-click stage / tap to show bar | WP-07 | Fullscreen button; bar reachable by focus | Already met | Control bar confirmed ✓ |
| Tap board title to minimize | CB-08 | Explicit collapse control / sheet handle | Nielsen #1 | `toggleBoard` at line 10106 ✓ |

Every gesture-only capability has a visible equivalent with a cited principle. All equivalents are present in the disposition column of the matching inventory row.
VERDICT:  PASS

---

## Notes (non-blocking)

1. **No pixel evidence.** This is a spec-only artifact (JOURNEY.md + server.py). No screenshot or rendered HTML exists for this phase. Visual-level findings (contrast, spacing, hierarchy) are deferred to the Phase 2 mock review. Coverage gap: pixel-level compliance unverifiable until a rendered surface exists.

2. **Tree test is unrun (timing gap).** Noted under Cross-Pillar Findings (Minor). The §IA acknowledges this explicitly. No requirement in this phase mandates a completed tree test. The five-task, five-member plan is documented and named as a Phase 2 prerequisite.

3. **GW-13 auto-reveal backend replacement.** The EXCLUDE disposition notes "Replaced by the idempotent backend auto-reveal job (follow-on code plan)." This backend change is not yet committed — it is a follow-on task. The Phase 1 spec correctly identifies the problem and the intended solution; the reviewer notes this dependency must be resolved before the Giveaway destination is built in Phase 2.

4. **CL-31 inline playback depends on a planned backend change.** The inventory correctly flags this: "Depends on the backend change" for session-cookie access to `/api/clips/media` (currently bearer-only). The spec carries the dependency forward honestly. No requirement to resolve this in Phase 1.

5. **AD-07 Roast bot has an owner-confirm gate (O-1).** The inventory notes "Owner confirm (O-1). If declined: EXCLUDE (no legacy UI)." This is not yet resolved. The spec correctly holds this open rather than disposing it prematurely.

6. **No card sort data.** §IA notes: "there was no card sort. The labels are the squad's existing ones (continuity: Jakob's law)." Jakob's law (Yablonski, citing Norman 2013: users spend most time on other sites) is a legitimate justification for preserving familiar labels. The omission of the card sort is structurally parallel to the tree-test gap — both are acknowledged rather than hidden.

---

## Issues

None.

**Verdict: PASS**
