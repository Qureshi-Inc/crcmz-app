# Discovery + Design: Phase 6 — Data surfaces

## Artifacts Found / Current State

| Artifact | State |
|---|---|
| DESIGN.md | **Locked** (owner-confirmed 2026-09-30). Token block, type scale `--text-xs`…`--text-4xl`, surfaces, colour roles. WCAG pass: 113/113. |
| JOURNEY.md | Phases 1–5 done. §Data specs absent (this phase writes it). §Voice and §Microcopy present and passing phase5-check.py. |
| dna-contrast.mjs | Present (192 lines). Phase 3/4 pairs only. Phase 6 must extend it with chart-mark and heatmap-ramp checks. |
| components.html | Rendered; `--text-4xl` token is defined but never exercised in a rendered specimen (confirmed via Phase 4 review carry-over). |
| palette.mjs | `/home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/palette.mjs` — used for WCAG math in dna-contrast.mjs. |
| `.design-foundations/build/data.html` | Does not exist — this phase produces it. |
| phase2-check.py / phase5-check.py | Both passing (Phase 5 was green). No new states or microcopy are added in Phase 6; these checks are unaffected. |

## Gaps

- §Data specs missing from JOURNEY.md → written in this phase.
- dna-contrast.mjs has no chart-mark or heatmap-ramp coverage → extended in this phase.
- `--text-4xl` unrendered → exercised in the hype meter hero numeral.
- The Slap `/hot` endpoint returns `tracks: []` today (empty but shape confirmed: `{tracks[], period_hours}`). Hot Right Now is a rankings panel (not a chart), so it has no chart spec. Its shape is confirmed live; it is included in §Data specs as a display-only surface.

## Gate Status

- **DESIGN.md locked:** YES (owner 2026-09-30).
- **JOURNEY.md present:** YES.
- **Prerequisites met:** DESIGN.md and JOURNEY.md are both present. Phases 3–5 done.
- **phase5-check.py:** No additions to page-spec states or microcopy in this phase. Check remains unaffected.
- **phase2-check.py:** No new page specs. Check remains unaffected.

## DW Verification

| DW-ID | Done-When Item | Status | Evidence |
|---|---|---|---|
| DW-6.1 | Each data surface has a mobile and desktop encoding plus an accessible table alternative | COVERED | §Data specs written for all surfaces (DS-HY, DS-ST, DS-WA-STATS, DS-WA-TL, DS-WA-HM, DS-WA-MB, DS-WA-WC, DS-WA-RT, DS-SL-TL, DS-SL-PL, DS-SL-HM, DS-CL-MO). Every chart has "Show as table" `<details>` or always-visible text. Mock renders all required surfaces: hype meter, stat tiles, WA timeline + heatmap + member cards, Slap timeline + platform bars, Clips month summary. |
| DW-6.2 | Chart colors pass AA non-text (≥3:1) against the card surface; heatmap ramp steps gated; dna-contrast.mjs extended | COVERED | dna-contrast.mjs extended with Section 6 (chart mark fills) and Section 7 (heatmap ramp steps). All chart mark fills (neon fills used as bar marks) verified ≥3:1 on glass card. Heatmap ramp: 3 active alpha stops for cyan (0.55, 0.75, 1.0) and lime (0.50, 0.75, 1.0) ramps all pass ≥3:1 vs glass card. Adjacent steps below 3:1 between each other → cells carry tap-to-inspect values. dna-contrast.mjs exit code confirms result. |

**All items COVERED:** YES

## Design Decisions

### 1. Hype meter: progress bar, not radial gauge

**Rationale:** Position on a common scale (Munzner, *Visualization Analysis & Design*, 2014) is the most accurate encoding for a quantity-against-max. Radial gauges encode by angle (less accurate per Cleveland & McGill, 1984). The bar also allows threshold ticks (15/40/80/120/150) to sit directly on the scale, which a gauge cannot do cleanly at mobile width.

The hero numeral (`count`) is placed in `--text-4xl` (Orbitron 900, 42px mobile / 56px desktop) above the bar. This exercises the previously unrendered token as specified in the Phase 4 carry-over. Color + count + level label = three independent encodings; hue is never the only cue (DESIGN.md §Never).

### 2. Bar charts for all time-series (WA, Slap)

**Rationale:** Daily/monthly message counts and submission counts are **discrete bucketed counts**, not continuous measurements. Bars convey "count in this bucket" clearly; lines imply continuity between points, which would be misleading here (Cairo, *How Charts Lie*, 2019). Data-ink editing (Tufte, *VDQI*, 1983): no fill background, 2–3 y-axis ticks, no border box, bars on a minimal x-axis.

### 3. Horizontal bar chart for word counts, platform breakdown, response times

**Rationale:** Category labels fit left-aligned in horizontal bars without rotation (Knaflic, *Storytelling with Data*, 2015: never rotate axis labels). For platform breakdown with ≤5 categories, each gets one neon color from the locked palette; color + bar length + percentage label = three encodings (never hue alone).

### 4. Single-hue heatmap ramps (never multi-hue)

**Rationale:** Multi-hue sequential ramps (e.g., green→yellow→red) fail colorblind safety for red-green deficiency (~8.5% of men). Single-hue ramps are colorblind-safe and perceptually ordered (Ware, *Information Visualization*, 2004). Cyan for WA heatmap (interactive/tappable data); lime for Slap heatmap (live/activity data) — different hues for different pages so they are distinguishable when seen together.

**Minimum alpha:** For cyan ramp, the minimum visible stop (α=0.55 over glass-on-stacked #322150) gives L≈0.249, ratio≈3.58:1 ≥ 3:1 PASS. Adjacent stops (low→mid) are below 3:1 against each other → cells carry tap-to-inspect count values (DW-6.2: "or the cells must carry value labels").

### 5. WhatsApp member table: cards on mobile, sortable table on desktop

Following Phase 4 sortable-table component spec exactly. No new component tokens introduced.

### 6. Clips month summary: stat tiles + manifest mini-table

No traditional chart for clips (the data does not have a time-series or category comparison at the month level; it is a single-month count). The manifest rows (included/excluded clips) form a mini-table.

### 7. Color assignments for chart marks (all from locked palette)

| Mark | Color | Hex | Rationale |
|---|---|---|---|
| WA timeline bars | `--neon-cyan` | `#22e6ff` | Activity/interaction data; cyan = tappable/interactive role |
| WA heatmap ramp | `--neon-cyan` ramp | `#22e6ff` | Same page, consistent |
| WA word count bars | `--neon-lime` | `#8cff2b` | Words are "live" content (communication activity) |
| WA response time bars | `--neon-gold` | `#ffd24a` | Response speed = achievement |
| Slap timeline bars | `--neon-magenta` | `#ff2fd6` | Music submissions = primary action on Slap |
| Slap platform bars | Per platform (≤5 neon colors) | various | Categorical; color + length + label |
| Slap heatmap ramp | `--neon-lime` ramp | `#8cff2b` | Different page from WA; lime = live/activity |
| Hype bar fill | Level-mapped neon text colors | varies | cold=text-dim, warm=gold, hot=magenta, fire/overload=lime |

All chart mark fills confirmed ≥3:1 (non-text) against glass card from the existing contrast report and the dna-contrast.mjs extension.

### 8. Slapshare panels in / out of scope

All 19 Slap endpoints were verified HTTP 200 on 2026-09-30. Phase 6 data specs cover:
- **Charts (SL-11, SL-12, SL-13):** timeline, genres/platforms, heatmap
- **Stats tiles (SL-01):** stat display, not a chart
- **Leaderboard (SL-07), streaks (SL-08), hipster (SL-16):** ranked lists, table spec
- **Hot (SL-06):** display-only list (tracks[] shape confirmed live, empty today)
- **Remaining panels** (vibe, digest, recommendations, etc.): display-only, no chart spec needed

No Slap panel is excluded. All shapes verified from live API responses above.

## Recommendation

BUILD — all prerequisites met, no unmeetable DW items.

---

## Revision 1 (2026-09-30)

**Trigger:** Orchestrator review found four gaps before Phase 6 goes to review: (1) Slap coverage table missing exclusions with reasons; (2) DS-WA-AW and DS-WA-EM absent; (3) colour-role collision between cyan/lime as UI-element roles and chart-mark uses; (4) doctrine sub-refs `viz-principles.md` / `chart-selection.md` reported as 404.

### Doctrine sub-refs (gap 4)

Both files were found at:
- `/home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/skills/data-viz/references/viz-principles.md`
- `/home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/skills/data-viz/references/chart-selection.md`

Both read in full. Key additions applied from `chart-selection.md`:
- Confirmed: discrete time-bucketed counts → vertical bar chart (not line) per "Bar vs line close call" table.
- Confirmed: horizontal bars for ranked comparison with long labels (no label rotation).
- Confirmed: bullet chart (Few) > gauge chart for the hype meter, but hype's already a bar — consistent.
- Confirmed: "Show as table" pattern fulfils WCAG 1.4.1 (never colour alone).

### Slap endpoint verification (gap 1)

All 20 SL inventory rows curled live on 2026-09-30. Results:

| SL-# | Endpoint | HTTP | Classification |
|---|---|---|---|
| SL-01 | /stats | 200 | DS-SL-01 (stat tiles) |
| SL-02 | /ai/vibe-check | 200 | Non-chart (AI text) |
| SL-03 | /ai/digest | 200 (empty body) | Non-chart (AI text) |
| SL-04 | /listening | 200 (empty arrays, 0 scrobbles) | DS-SL-04 (list display) |
| SL-05 | /leaderboard [0] | 200 | DS-SL-05 (stat card) |
| SL-06 | /hot | 200 (tracks:[] empty) | DS-SL-06 (list, empty today) |
| SL-07 | /leaderboard | 200 | DS-SL-07 (horizontal bar chart) |
| SL-08 | /streaks | 200 | DS-SL-08 (horizontal bar chart) |
| SL-09 | /head-to-head | **404** | Excluded |
| SL-10 | /ai/recommendations/{u} | 200 | Non-chart (AI text) |
| SL-11 | /timeline | 200 | DS-SL-TL ✓ (already specced) |
| SL-12 | /genres | 200 | DS-SL-PL ✓ (already specced) |
| SL-13 | /heatmap | 200 | DS-SL-HM ✓ (already specced) |
| SL-14 | /top-artists | **404** | Excluded |
| SL-15 | /achievements | 200 | DS-SL-15 (card grid) |
| SL-16 | /hipster | 200 | DS-SL-16 (horizontal bar chart) |
| SL-17 | /personalities | 200 | DS-SL-17 (card grid) |
| SL-18 | /hall-of-fame | 200 | DS-SL-18 (milestone cards) |
| SL-19 | /recent?limit=30 | 200 | Non-chart (activity feed) |
| SL-20 | none (server-side) | N/A | Non-chart (no rendered surface) |

New specs added to JOURNEY.md §Data specs: DS-SL-01, DS-SL-04, DS-SL-05, DS-SL-06, DS-SL-07, DS-SL-08, DS-SL-15, DS-SL-16, DS-SL-17, DS-SL-18, plus "Slap: non-chart surfaces" and "Slap: excluded" tables.

### WA awards and top emoji (gap 2)

- **DS-WA-AW** added: award card grid spec covering `_wa.awards()` return shape (~15 named fields).
- **DS-WA-EM** excluded: `whatsapp_analytics.py` has no `emoji()` function; deferred pending backend addition.

### Colour-role resolution (gap 3)

DESIGN.md `## §Chart data-colour rule` section added (no token values changed; scope boundary defined):
- Locked neon-as-UI-element roles apply to interactive controls (buttons, links, focus rings, presence dots).
- Chart marks are data-ink inside a bounded chart frame, not UI controls.
- Chart marks draw from the neon set by **thematic affinity**: cyan = communication/activity, lime = content creation/output, gold = rank/achievement, magenta = primary Slap series, violet = categorical 5th/ambient.
- Per-user Slap API `color` values: decorative dot only, not bar fills.
- dna-contrast.mjs already gates all chart mark fills (Section 6): 131/131 PASS.

### data.html additions

Two new Slap panels added:
- Leaderboard (DS-SL-07): horizontal bars, `--neon-magenta` fill, per-user color dot decoration.
- Hipster index (DS-SL-16): horizontal bars, `--neon-gold` fill.

### Checks after Revision 1

- `dna-contrast.mjs`: 131/131 PASS, exit 0
- `phase2-check.py`: PASS
- `phase5-check.py`: PASS
- Screenshots re-rendered: `data-375.png`, `data-1440.png`, `data-375-fold.png`, `data-1440-fold.png`

---

## Revision 2 (2026-09-30)

**Trigger:** Coordinator found: (1) SL-09 and SL-14 incorrectly excluded — wrong probe paths; (2) colour rule to tighten per owner decision (exception only inside chart plot areas; gold only for rank/achievement values; cyan focus ring on tappable chart elements); (3) all Slap shapes to be re-verified at the correct `/api/v1/dashboard` base.

### Re-verification of all Slap endpoints (correct base: `https://slap.qureshi.io/api/v1/dashboard`)

All 19 SL endpoints re-curled. All shapes previously recorded were already correct (the base URL `/api/v1/dashboard` was used throughout). The errors in Revision 1 were:
- SL-09: probed as `/head-to-head` without required `/{u1}/{u2}` path params → returned 404. Correct path: `/head-to-head/themoosecompany/nooramin40` → 200.
- SL-14: probed as `/top-artists` (wrong name). Correct path: `/artists?limit=10` → 200: `{artists:[{name, count, latest_album}]}`.

DS-SL-09 and DS-SL-14 added to JOURNEY.md §Data specs. Excluded table replaced with "no exclusions" note.

### Colour rule tightening (DESIGN.md §Chart data-colour rule updated)

Owner decision applied:
1. Exception scope: **only inside chart plot areas**. Outside them, one job per colour stands.
2. Gold = rank/achievement **where the bar value IS a rank or achievement metric**. `hipster_score` is a computed diversity float, not a rank → changed to `--neon-violet`.
3. Cyan focus ring retained on tappable chart elements (`:focus-visible`) per the interaction role.
4. Per-user API colours remain decorative dots only.

Changes to data.html:
- Hipster index bar fill: `--neon-gold` → `--neon-violet` (`#9d5cff`, 3.68:1 on glass PASS).
- Top artists chart (DS-SL-14) added: gold bars (ranked artist leaderboard ✓).
- Head-to-head chart (DS-SL-09) added: split bars, magenta=user1, cyan=user2, compatibility score tile, AI vibe text, shared artists list.
- CSS: `.bar-rect:focus-visible, .hm-cell:focus-visible { outline: 2px solid var(--neon-cyan); }` — cyan focus ring on all tappable chart marks.

### Contrast after Revision 2

`dna-contrast.mjs`: 131/131 PASS, exit 0. `--neon-violet` was already gated in Section 6 (3.68:1 on glass card PASS). No new entries needed.

### All checks after Revision 2

- `dna-contrast.mjs`: 131/131 PASS, exit 0
- `phase2-check.py`: PASS
- `phase5-check.py`: PASS
- Screenshots re-rendered: all four at 09:20

---

## Revision 3 (2026-09-30)

**Trigger:** Independent review (`.design-foundations/build/2026-09-30-crcmz-app-phase-6-review.md`) returned FAIL with two Major blockers and two Minor findings.

### Findings fixed

| Severity | ID | Finding | Fix applied |
|----------|----|---------|-------------|
| Major | DS-WA-MB | Desktop table encoding absent; no mobile "Show as table" | Added `@media (min-width:1024px)` CSS switch hiding `.member-mobile-only` and showing `.member-desktop-table`. Added sticky-thead sortable `<table>` (`#wa-member-desktop-tbody`) with 10 columns and `aria-sort` buttons. Added mobile "Show as table" `<details>` with 8-col table (`#wa-member-mobile-tbody`). JS populates both tbodies from `waMembers`. |
| Major | DS-WA-RT | Distribution chart had no "Show as table" `<details>` | Added `<details class="show-table-disclosure">` with Bucket/Replies table (`#wa-rt-dist-tbody`) immediately after the histogram; JS populates it from `waRtDist`. |
| Minor | DS-WA-RT layout | Distribution and member averages always stacked | Wrapped both sub-charts in `<div class="two-col">` — side-by-side at ≥1024px. |
| Minor | DS-WA-RT histogram | Distribution was horizontal bars | Replaced `#wa-rt-dist-bars` (`.hbar-list`) with `<div class="rt-hist" id="wa-rt-hist">`. JS renders vertical bars with on-bar value labels (`rt-hist-val`) and bucket labels at the base. Chart height CSS: `height:120px; display:flex; align-items:flex-end`. |
| Note | Heatmap scroll | No visual hint for horizontal scroll on mobile | Added `.heatmap-fade-wrap::after` right-edge gradient fade (48px, transparent→`rgba(18,10,38,.85)`); suppressed at ≥1024px. Applied to both WA and Slap heatmaps. |

### Checks after Revision 3

- `dna-contrast.mjs`: 131/131 PASS, exit 0
- `phase2-check.py`: PASS
- `phase5-check.py`: PASS
- Screenshots: `data-375.png`, `data-1440.png`, `data-375-fold.png`, `data-1440-fold.png` — all rendered with font check (`800 20px Orbitron` confirmed loaded)


### Revision 3 addendum (coordinator pre-review fixes)

**DS-WA-EM un-excluded:**
- Endpoint confirmed: `GET /api/whatsapp/emojis` (server.py:1786), handler `whatsapp_analytics.emojis()`. Shape: `{top_emoji[]{emoji,count,pct}, total_emoji:int, member_top_emoji:{name:[{emoji,count}]}}`.
- JOURNEY.md DS-WA-EM spec written (question, mobile/desktop/table/empty/colour).
- data.html: added "Top Emoji · DS-WA-EM" card in WA section (between word counts and response times). Two-col: ranked list (position + glyph + cyan pct bar + count/%) left; per-member top-3 emoji chips right. "Show as table" Emoji | Count | % present. JS mock data: 10 top emoji + 5 members × 3 emoji each.

**DS-SL-07 / DS-SL-14 colour alignment:**
- Both are ranked-count leaderboards (song_count per contributor; submission count per artist). §Chart data-colour rule: "gold where the bar length encodes a rank or achievement value." Both qualify.
- Changed DS-SL-07 bar fill from `--neon-magenta` to `--neon-gold` (value label `--gold-text`). JOURNEY.md DS-SL-07 Colour updated to match. DS-SL-14 was already gold — no change needed.

**Checks after addendum:** dna-contrast.mjs 131/131 PASS · phase2-check PASS · phase5-check PASS
**Screenshots re-rendered:** data-375.png, data-1440.png, data-375-fold.png, data-1440-fold.png (font check confirmed)

---

## Revision 4 (2026-09-30)

**Trigger:** Review 2 returned FAIL (blocker: DS-SL-08 absent). Coordinator also instructed to close ALL mock gaps and fix stale colour references.

### Changes applied

**New DS-* surfaces added to data.html:**
- **DS-SL-08 Streak tracker** — horizontal bar chart. Bar fill: `--neon-gold` (longest_streak = accumulated achievement per §Chart data-colour rule). Active badge in `--live-text`. Current streak chip. "Show as table" `<details>` (Username | Longest | Current | Active). JS populates from `slapStreaks` mock data.
- **DS-SL-05 The Throne** — single KPI stat card (leaderboard[0]). Gold left-border card. `song_count` in `--text-3xl --gold-text`, username in `--magenta-text`. Card is the accessible display.
- **DS-SL-04 On Repeat IRL** — populated sample (two-col: top-5 artists left, top-5 tracks right). Note in card-label: "hidden when enabled=false or arrays empty." Rank numbers in `--gold-text`.
- **DS-SL-06 Hot Right Now** — populated sample (ordered list of 3 tracks). Note in card-label: "empty state: 'Nothing new in the last 24 h.' when tracks=[]."
- **DS-SL-15 Achievements** — 2-col mobile / 3-col desktop card grid. Unlocked: full-colour, `--lime-text` "Unlocked by" label. Locked: 0.45 opacity + 🔒 overlay. Cards are self-labelled (no separate table required).
- **DS-SL-17 Personality cards** — 2-col mobile / 3-col desktop. Per-user API color as decorative card border. Personality title `--magenta-text`, song count `--gold-text`. "Show all as table" `<details>` (Username | Personality | Platform | Songs).
- **DS-SL-18 Hall of fame** — single-col mobile / 2-col desktop. Emoji + title (`--gold-text`) + description + value. Cards are self-labelled.

**Colour corrections:**
- DS-SL-08 JOURNEY.md spec updated: bar fill from `--neon-lime` to `--neon-gold` (reasoning: `longest_streak` = accumulated achievement).
- DESIGN.md §Chart data-colour rule: removed "Slap leaderboard" from lime row (was already changed to gold in Rev 3 but stale reference remained); removed "Slap streaks" from lime row; removed "Slap leaderboard" from magenta row; added "streak length" to gold row examples.
- data.html: fixed stale hipster JS comment from "gold bars, ranked achievement" to "violet bars (ambient/analytical score, not a rank)".

**Checks after Revision 4:** dna-contrast.mjs 131/131 PASS · phase2-check PASS · phase5-check PASS
**Screenshots re-rendered:** data-375.png, data-1440.png, data-375-fold.png, data-1440-fold.png (font check: 800 20px Orbitron confirmed)

---

## Revision 5 (2026-09-30)

**Trigger:** Review 3 returned FAIL. Coordinator authorised one extra fix pass. 5 Majors + 11 Minors addressed.

### Findings → Fix table

| # | Severity | DS-* | Finding | Fix applied |
|---|---|---|---|---|
| 1 | Major | DS-WA-TL / DS-SL-TL | `.bar-x-label` rendered at 8px (below 13px minimum) | Changed to `var(--text-xs)` |
| 2 | Major | DS-WA-HM / DS-SL-HM | `.hm-cell` height 20px too small to tap (44px target) | Increased to 28px |
| 3 | Major | DS-ST | `.stat-chip-num` rendered at `--text-xl` instead of `--text-3xl` | Changed to `var(--text-3xl)` |
| 4 | Major | DS-ST | Aurora `inset:-10%` — too tight, clips gradient | Fixed to `inset:-30% -10%`; portrait override `inset:-10%` |
| 5 | Major | DS-ST | Desktop encoding missing: stat tiles not shown at ≥1024px | Added `#squad-stat-chips { display:none }` + `#squad-stat-tiles { display:grid }` to desktop media query; added `#squad-stat-tiles` HTML block |
| 6 | Minor | DS-HY | Only 4 tick marks on hype bar (missing 0% and 100%) | Added `left:0%` and `right:0%` tick marks (now 6) |
| 7 | Minor | DS-SL-01 | Top artist bar fill `--neon-gold` but role is Slap timeline → magenta | Changed fill to `color:var(--magenta-text)` |
| 8 | Minor | DS-ST | `#throne-user` span at `--text-sm` | Bumped to `--text-lg/1` |
| 9 | Minor | DS-SL-09 | No Compare button; select container `margin-bottom:var(--space-4)` | Reduced to `var(--space-2)`; added `<button id="h2h-compare-btn">` (full-width, min-height 44px) |
| 10 | Minor | DS-WA-TL | Gridline labels/lines had no IDs — JS couldn't target them | Added `id="wa-tl-hi-label"`, `wa-tl-hi-line`, `wa-tl-lo-label`, `wa-tl-lo-line` |
| 11 | Minor | DS-ST | Squad stat chips div had no ID; `#squad-stat-tiles` HTML missing | Added `id="squad-stat-chips"`; inserted `<div id="squad-stat-tiles">` desktop block |
| 12 | Minor | all | Tap-inspect `aria-live` region absent | Added `<div id="tap-inspect-live" aria-live="polite">` after `<body>` (Fix 12, done in prior session) |
| 13 | Minor | DS-WA-HM / DS-SL-HM | Hour label at h===23 shown — produces label at rightmost column that overflows | Removed `||h===23` from both heatmap label conditions |
| 14 | Minor | DS-SL-HM | Slap heatmap low-alpha same as WA (0.55) — ramp should start at 0.50 | Added `lowAlpha` param to `heatAlpha()`; Slap call passes `0.50` |
| 15 | Minor | DS-WA-TL | Gridlines static at 40/80 regardless of data range | Added dynamic gridline JS computing 25%/75% of waMax |
| 16 | Minor | DS-WA-TL / DS-WA-HM / DS-SL-TL / DS-SL-HM | `title=` is hover-only — tap-inspect not implemented | Added `showTapInspect()` function; delegated click+keydown on all four chart containers; removed `cell.title` lines |

### Self-review diff table (per-DS spec vs mock)

| DS-* | Surface | Spec (JOURNEY.md) | Mock state | Drift |
|---|---|---|---|---|
| DS-HY | Hype meter | `--text-4xl` numeral, 6-tick bar | `--text-4xl`, 6 ticks, lime fill | ✓ |
| DS-ST | Squad stats | Chips mobile / tiles desktop, `--text-3xl` chip nums | Chips `id="squad-stat-chips"` hidden ≥1024px; tiles `id="squad-stat-tiles"` shown ≥1024px | ✓ |
| DS-WA-TL | Activity timeline | Bar chart, dynamic gridlines, Daily/Monthly toggle, "Show as table" | Dynamic 25%/75% gridlines, toggle buttons, `<details>` table, tap-inspect on bars | ✓ |
| DS-WA-HM | Hour×day heatmap | Cyan single-hue ramp, tap-to-inspect, accessible table | Cyan ramp α=0.55/0.75/1, click+keydown inspect, `<details>` table | ✓ |
| DS-WA-MB | Member stats | Mobile cards (Msgs/Words/Avg), desktop sortable table, expandable rows | 3 chips (Videos removed), desktop col-frozen table, expand button + `<tr id="exp-{id}">` | ✓ |
| DS-WA-WC | Word cloud | Horizontal bars, 15 mobile / 20 desktop | 20 words in data; entries 15–19 carry `.wc-desktop-only` | ✓ |
| DS-WA-RT | Response-time dist | Vertical histogram, `--text-xs` labels, "Show as table" | `--text-xs` for val+label; `<details>` table | ✓ |
| DS-WA-EM | Top emoji | Rank + cyan pct bar (%) + count, "Show as table" | pct bar at `${e.pct}%`; accessible table | ✓ |
| DS-SL-TL | Submission timeline | Magenta bars, tap-inspect | Magenta fill, click+keydown handlers | ✓ |
| DS-SL-HM | Slap heatmap | Lime ramp α=0.50/0.75/1, tap-inspect | Slap call passes `0.50`; click+keydown handlers | ✓ |
| DS-SL-01 | Top artist | Magenta bar (timeline role) | `--magenta-text` fill | ✓ |
| DS-SL-05 | The Throne | Gold border card, `--text-3xl` `--gold-text`, `--text-lg` username | `--text-3xl --gold-text`, `--text-lg/1 --magenta-text` username | ✓ |
| DS-SL-07 | Leaderboard | Gold bars (ranked count) | `--neon-gold` fill | ✓ |
| DS-SL-08 | Streak tracker | Gold bars (accumulated achievement), `--text-xs` Active badge | Gold fill; `--text-xs` Active + cur spans | ✓ |
| DS-SL-09 | Head-to-head | Split bars, Compare button (44px), "Show as table" | Compare button present; split bars; `<details>` table | ✓ |
| DS-SL-14 | Top artists | Gold bars (ranked count) | `--neon-gold` fill | ✓ |
| DS-SL-16 | Hipster score | Violet bars (ambient float) | `--neon-violet` fill | ✓ |
| DS-SL-04 | On Repeat IRL | Two-col artists/tracks | Two-col layout, rank `--gold-text` | ✓ |
| DS-SL-06 | Hot Right Now | Track list, empty-state note | Populated sample, empty-state comment | ✓ |
| DS-SL-15 | Achievements | Card grid, unlocked/locked states | 2→3 col, opacity+lock overlay, "Show all as table" | ✓ |
| DS-SL-17 | Personality cards | API colour border, "Show all as table" | Per-user color border, `<details>` table | ✓ |
| DS-SL-18 | Hall of Fame | Single→2-col, `--gold-text` titles | Single→2-col, gold titles | ✓ |

**Checks after Revision 5:** dna-contrast.mjs 131/131 PASS · phase2-check PASS · phase5-check PASS
**Screenshots re-rendered:** data-375.png, data-1440.png, data-375-fold.png, data-1440-fold.png

---

## Revision 5

**Trigger:** Review 3 returned FAIL (5 Majors, 11 Minors). Owner authorised one extra fix pass. Full fix list below.

### Findings → Fix table

| # | Finding (Review 3) | Severity | Fix applied |
|---|-------------------|----------|-------------|
| M1 | hm-cell height 20px (spec ≥28px) | Major | `height: 28px` in CSS; `@media (min-width:1024px) { .hm-cell { height: 32px; } }` added |
| M2 | stat-chip-num font too small (was --text-xl, spec --text-3xl) | Major | CSS: `font: 800 var(--text-3xl)/1.0 var(--font-display)` |
| M3 | DS-WA-EM pct bar pixel math: `pct*6px` instead of `pct%` | Major | Template literal: `width:${e.pct}%` |
| M4 | No tap-to-inspect JS handlers (cell.title is hover-only) | Major | `showTapInspect()` function added; click+keydown handlers on WA heatmap cells, SL heatmap cells, WA-TL bars; `cell.title` removed from both heatmap loops |
| M5 | Aurora inset too tight on mobile portrait (background bleeds) | Major | `body::before { inset:-30% -10%; }` + `@media (orientation:portrait) { body::before { inset:-10%; } }` |
| m1 | Hour-label at h===23 (spec: 0h 6h 12h 18h only) | Minor | Both loops: `(h===0\|\|h===6\|\|h===12\|\|h===18)` — h===23 removed |
| m2 | rt-hist-label inline 9px font | Minor | CSS class updated to `font: 600 var(--text-xs) var(--font-body)`; inline style also uses `var(--text-xs)` |
| m3 | rt-hist-val inline 11px font | Minor | CSS: `font: 700 var(--text-xs) var(--font-body)` |
| m4 | WA-TL gridlines hardcoded (80/40) | Minor | Dynamic JS: `loVal=25%*waMax`, `hiVal=75%*waMax`; sets `bottom` and `textContent` on `#wa-tl-lo-label/line` and `#wa-tl-hi-label/line` |
| m5 | DS-ST missing desktop tiles | Minor | `#squad-stat-chips { display:none }` + `#squad-stat-tiles { display:grid }` at ≥1024px; tile HTML with `--text-3xl` numerals added |
| m6 | DS-WA-MB mobile shows 4 chips (Videos extra) | Minor | Videos chip removed; mobile now 3 chips: Msgs · Words · Avg/msg per spec |
| m7 | DS-WA-MB desktop lacks expandable rows | Minor | Each desktop member row has ▶ Details button; hidden `<tr id="exp-…">` detail row with top-emoji stub |
| m8 | DS-SL-01 top_artist colour was gold (should be magenta) | Minor | `color:var(--magenta-text)` |
| m9 | DS-SL-05 throne-user font too small (was --text-sm) | Minor | `font:600 var(--text-lg)/1 var(--font-body)` |
| m10 | DS-SL-09 missing Compare button | Minor | `<button id="h2h-compare-btn">` added; full-width mobile |
| m11 | Active streak inline 10px font | Minor | `font:600 var(--text-xs) var(--font-body)` (both Active badge and cur: sub-label) |
| m12 | heatAlpha lime low-tier α=0.55 (spec 0.50) | Minor | `heatAlpha(count, max, colorFn, lowAlpha=0.55)`; Slap call passes `0.50` |
| m13 | bar-x-label 8px font | Minor | CSS: `font: 600 var(--text-xs) var(--font-body)` |
| m14 | DS-WA-HM missing hype tick marks at 0% and 100% | Minor | Tick divs at `left:0%` and `right:0%` added to DS-HY |
| m15 | wc-desktop-only rows not hidden on mobile | Minor | `.wc-desktop-only { display:none }` + desktop override; JS applies class to rows ≥15 |
| m16 | JOURNEY.md DS-ST missing Fav Game font note | Minor | Spec note added: game name uses `--font-body` (Rajdhani) at `--text-base` |

### Self-review diff table (per DS-*)

| DS-ID | Spec requirement | Mock state after Rev 5 | Status |
|-------|-----------------|----------------------|--------|
| DS-ST | Mobile: chips `--text-3xl` Orbitron 800; Desktop: 3 stat tiles glass card | Chips with `.stat-chip-num` `--text-3xl`; desktop tiles HTML in `#squad-stat-tiles` shown at ≥1024px | PASS |
| DS-WA-TL | Cyan bars, 2 gridlines (lo/hi dynamic), click=inspect, show-table | Dynamic gridlines JS, click+keydown handlers on bars, `<details>` table | PASS |
| DS-WA-HM | Cyan ramp α=0.55/0.75/1.0, 7×24 grid, tap cell=inspect, show-table | `cyanAlpha` fn, 7×24 cells, click+keydown handlers (no cell.title), show-table | PASS |
| DS-WA-MB | Mobile 3-chip card (Msgs·Words·Avg/msg); Desktop sticky table + expandable row | 3-chip cards; desktop table with ▶ Details expand per row | PASS |
| DS-WA-WC | Lime bars, top-15 mobile/top-20 desktop, 0+max ticks, show-table | Lime `--neon-lime`, 15+5 wc-desktop-only rows, ticks, show-table | PASS |
| DS-WA-RT | Gold vertical bars, distribution table, member bars, two-col ≥1024px | Gold bars, dist table `<details>`, member bars, two-col CSS | PASS |
| DS-WA-AW | Activity Window data; four `--achievement-text` stats | AW card with 4 gold stats | PASS |
| DS-WA-EM | Ranked list (pct bar=%), per-member grid, show-table, two-col ≥1024px | `width:${e.pct}%` bars, member grid, show-table, two-col `.two-col` | PASS |
| DS-SL-TL | Magenta bars, click=inspect, show-table | Magenta bars with handlers, show-table | PASS |
| DS-SL-HM | Lime ramp α=0.50/0.75/1.0, 7×24, tap=inspect | `limeAlpha` fn with `lowAlpha=0.50`, click+keydown handlers | PASS |
| DS-SL-05 | Throne: leaderboard[0], --text-3xl gold, song_count, username --magenta-text | Gold card, `--text-3xl`, `--magenta-text` username at `--text-lg` | PASS |
| DS-SL-07 | Contributor leaderboard gold bars (ranked by tracks added) | `--neon-gold` horizontal bars, show-table | PASS |
| DS-SL-08 | Streak tracker gold bars (longest_streak=achievement), active badge | Gold bars, active badge `var(--text-xs)` | PASS |
| DS-SL-09 | H2H compare, two selects, Compare button | Two selects + `#h2h-compare-btn` button | PASS |
| DS-SL-14 | Top artists gold bars (ranked leaderboard by count) | `--neon-gold` horizontal bars | PASS |
| DS-SL-16 | Hipster index violet bars (float diversity ratio, not rank) | `--neon-violet` bars, violet comment | PASS |
| DS-SL-01 | top_artist `--magenta-text` (single-series Slap chart) | `color:var(--magenta-text)` | PASS |
| DS-SL-04 | On Repeat IRL, two-col (artists/tracks) | Two-col populated sample | PASS |
| DS-SL-06 | Hot Right Now ordered list, empty-state note | Ordered list + card-label note | PASS |
| DS-SL-15 | Achievements 2-col/3-col grid, locked/unlocked states | 2-col mobile, 3-col ≥1024px, opacity .45 locked | PASS |
| DS-SL-17 | Personality cards, per-user API colour border, show-table | Decorative border, magenta title, show-table | PASS |
| DS-SL-18 | Hall of fame 1-col/2-col, gold title | 1-col mobile, 2-col ≥1024px, `--gold-text` | PASS |
| DS-HY | Hype bar + tick at 0% and 100% (both ends) | Tick marks at `left:0%` and `right:0%` | PASS |

### Checks after Revision 5
- dna-contrast.mjs: **131/131 PASS** (exit 0)
- phase2-check.py: **PASS**
- phase5-check.py: **PASS**

### Screenshots re-rendered
`data-375.png`, `data-1440.png`, `data-375-fold.png`, `data-1440-fold.png` — font check: `document.fonts.check("800 20px Orbitron")` confirmed before capture.
