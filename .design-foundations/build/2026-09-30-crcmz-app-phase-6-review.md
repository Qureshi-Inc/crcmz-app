# Design Review: Phase 6 — Data Surfaces

**Reviewed:** 2026-09-30  
**Artifact:** `.design-foundations/build/data.html`  
**Widths audited:** 375 px (mobile-first) and 1440 px (desktop)  
**Doctrine loaded:** `data-viz` (SKILL.md + `references/viz-principles.md` + `references/chart-selection.md`)

---

## Rendered Evidence (Step 0)

- Screenshots: `data-375.png`, `data-375-fold.png`, `data-1440.png`, `data-1440-fold.png` — all read and examined
- Web fonts: `Orbitron` and `Rajdhani` render in all screenshots; no glyph fallback observed
- Surface: full-page data dashboard — Squad Strip (hype + stat tiles), WhatsApp Analytics (totals, awards, timeline, heatmap, member table, word counts, response times), Slapshare Music (stat tiles, timeline, platform breakdown, heatmap, head-to-head, leaderboard, hipster index), Clips This Month + montage summary

---

## Assessment B — Deterministic Detector

- Command: `node /home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/detect.mjs .design-foundations/build/data.html > .design-foundations/build/detect-phase6.json`
- Exit: 0 (ran successfully)
- Findings: 22 hits across 3 rules (`nested-cards` ×20, `purple-triplet` ×1, `numbered-section-markers` ×1)
- Opened only after Assessment A findings were frozen: YES

---

## Triage

- Baseline (always-on): visual + usability
- Dispatched: `data-viz` — charts, heatmaps, bar charts, stat tiles, KPI dashboard surfaces throughout
- Not applicable: `content-design` (no long-form product copy to review), `journey` (single-page mock, no flow), `behavioral` (no conversion/persuasion mechanics)
- Deferred: none — surface scope is contained

---

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| **Major** | data-viz / DW-6.1 | DS-WA-MB member table: only mobile cards render at every viewport width. At 1440 px the spec requires a sticky-header sortable table (Member frozen, 11 data columns, `<button aria-sort>` on each header). The HTML has no `@media` switch; `.member-cards` renders `flex-direction:column` at all widths, and there is no `<table>` element in the section. Mobile (375 px) also lacks a "Show as table" disclosure, leaving no accessible table at either width. | Few, *IDD* 2006: cross-dimensional tables beat small multiples when the reader's question is "all dimensions for all people." DW-6.1 requires a desktop encoding + accessible table alternative per surface. | Add a `@media (min-width:1024px)` switch that renders a `<table>` with sticky `<thead>`, `aria-sort` on column `<button>` headers, and all 11 specified columns. At mobile, add a "Show as table" `<details>` that expands the full table for keyboard/AT users. |
| **Major** | data-viz / DW-6.1 | DS-WA-RT distribution chart has no accessible table alternative. The single `show-table-disclosure` at the bottom of the response-times card covers only the member-averages sub-chart (columns: Member | Avg (min) | Responses). The distribution bar list (`#wa-rt-dist-bars`, 5 time-bucket bars) has no table or disclosure. The spec states "Show as table `<details>` on each chart." | DW-6.1: each data surface requires an accessible table alternative reachable without hover. WCAG 1.3.1 (Info and Relationships): time-bucket distribution data is not programmatically determinable from the bar element alone — `aria-label` on the interactive wrapper covers AT but not visual-only users who cannot tap. | Add a second `<details class="show-table-disclosure">` immediately after `#wa-rt-dist-bars` with columns `Bucket | Count` populated from `waRtDist`. This can sit above the existing combined member table, or both tables can be merged under one disclosure with a `<caption>` per section. |
| **Minor** | data-viz / DW-6.1 | DS-WA-RT desktop layout: spec requires distribution and member-averages side-by-side (two columns) at desktop. The card uses a bare `display:grid;gap:var(--space-4)` — always stacked, no `two-col` wrapper or responsive column override at ≥1024 px. | Few, *IDD* 2006: small-multiples grid (side-by-side) reduces eye travel and enables simultaneous comparison. Gestalt proximity (usability-principles.md): horizontally adjacent charts imply they answer a related question. | Wrap the two sub-charts in `<div class="two-col">` so they sit side-by-side at ≥1024 px, matching the DS-WA-RT spec. |
| **Minor** | data-viz | DS-WA-RT distribution rendered as horizontal bars; spec calls for a vertical histogram (buckets on x-axis, count on y-axis). Both chart types correctly encode a comparison/ranking, but the specified form for a 5-bucket count distribution is a vertical histogram because the x-axis time-bucket order carries intrinsic meaning (left = fastest, right = slowest) that a horizontal layout obscures. | Munzner, *VAD* 2014 §7: ordered categorical axis on x correctly encodes left-to-right temporal ordering. Chart-selection.md: "distribution → histogram; buckets on x-axis." | Replace `#wa-rt-dist-bars` (`.hbar-list`) with a small vertical bar chart using the existing `.bar-chart-area` pattern. Height of each bar = count; x-axis labels = time buckets ("0-5m", "5-10m", …). |
| Note | detector | `nested-cards` (20 hits). The detector flagged `.card-label`, `.member-card`, chart-toggle `<button>`, and `<select>` as "card inside a card ancestor." Register: `.card-label` is a styled section-header `<div>` (no `.card` class), not a nested card — false positive from substring matching. `.member-card` items inside the card wrapper are a standard list-in-card containment pattern for data dashboard member lists, not the "section card → page card → layout card" stacking AI-tell. Evidence: `<div class="hype-bar-fill"> is a card inside a card ancestor` (line 538) — the bar fill element has no `.card` class. | ai-tells.md `nested-cards` rule: 3+ levels of card nesting indicate structural over-carding. | No action required. If the detector is updated to use exact-class matching instead of substring, these false positives will resolve. Monitor that production implementation does not introduce true multi-level card stacking. |
| Note | detector | `purple-triplet` (1 hit): "AI-default accent #8b5cf6" at line 1319. Register: this value is a per-user API color from `slap.qureshi.io/api/v1/dashboard/leaderboard` (`"color":"#8b5cf6"` for user "moiz"). It is embedded in the JavaScript data literal, not in UI styling. The rendered output uses it as a 10 px decorative dot with `title="API decoration colour (not data-ink)"` — the bar fill is `var(--neon-magenta)` per the chart colour rule. DESIGN.md §Chart data-colour rule: "per-user API colours are decorative only." | ai-tells.md `purple-triplet`: #8b5cf6 in UI chrome signals the AI default palette. | No action required. The value is data, not chrome. If needed, the data literal could be aliased to `--user-color-moiz` to prevent future confusion, but this is cosmetic. |
| Note | detector | `numbered-section-markers` (advisory): "decorative sequence: 03, 05, 07, 09, 10, 11." Register: these numbers are DS-WA-03, WA-05, DS-SL-07 etc. — spec reference tags in `.tag` and `.card-label` elements used in the mock to cross-reference JOURNEY.md. They are not a design decision; they will not appear in production. | ai-tells.md: numbered section markers as decoration are an AI-tell of algorithmic structure imposition. | No action required for the mock. Production implementation will not carry spec tags. |

---

## Requirement Fulfillment

### DW-6.1
PREMISE:  each data surface has a mobile and desktop encoding plus an accessible table alternative  
EVIDENCE:  
- **Hype meter (DS-HY):** Mobile and desktop both show the hype numeral + linear bar with scale ticks (0 15 40 80 120 150 visible in both screenshots). No chart, so no "Show as table" required; the numeral and label encode all data visually. Mobile: compact single-row strip. Desktop: same strip wider. PASS for this surface.  
- **Stat tiles (DS-ST):** Static numeral tiles (Platinums, Top Level, Fav Game). Same encoding at both widths; desktop shows in a 3-chip horizontal row, mobile stacks. No chart encoding; values are always visible. PASS.  
- **WhatsApp totals (DS-WA-STATS):** 6 stat tiles render at both widths; desktop wraps to a 6-column row, mobile scrolls or wraps. Values always visible. PASS.  
- **WhatsApp awards (DS-WA-AW):** Award cards at both widths (2-col mobile, 5-col desktop). Spec says "The card grid IS the accessible display." Confirmed in HTML and screenshots. PASS.  
- **WhatsApp timeline (DS-WA-TL):** Vertical bar chart at both widths; scrollable at 375 px. "Show as table" `<details>` present with Date | Messages columns, table body populated by JS. PASS.  
- **WhatsApp heatmap (DS-WA-HM):** 7×24 grid with `overflow-x:auto` + `min-width:560px`; scrolls on mobile, fits at 1440. "Show as table" `<details>` present (Day | Hour | Count). Cells have `tabindex="0"` and `aria-label` with count. PASS.  
- **WhatsApp member table (DS-WA-MB):** Mobile cards present. Desktop table absent — HTML renders only `.member-cards` at all widths; no `@media` switch to a `<table>` layout; no accessible table disclosure at mobile. **FAIL** — desktop encoding and accessible table alternative both missing.  
- **WhatsApp word counts (DS-WA-WC):** Horizontal bar chart at both widths; count labels always visible at bar tips. "Show as table" `<details>` present (Word | Count). PASS.  
- **WhatsApp response times (DS-WA-RT):** Distribution and member-averages horizontal bars at both widths. Desktop side-by-side layout not implemented (always stacked). Single combined "Show as table" covers member averages only — distribution data has no table disclosure. **PARTIAL FAIL** — accessible table for distribution missing; desktop layout does not match spec.  
- **Slapshare stat tiles (DS-SL-01):** Tiles at both widths; values always visible. PASS.  
- **Slap timeline (DS-SL-TL):** Vertical bar chart at both widths; scrollable at 375. "Show as table" present. PASS.  
- **Slap platform breakdown (DS-SL-PL):** Horizontal bars with colour+label dual encoding. "Show as table" present (Platform | Count | %). PASS.  
- **Slap heatmap (DS-SL-HM):** Same grid as WA heatmap; `overflow-x:auto`. "Show as table" present. PASS.  
- **Slap leaderboard (DS-SL-07):** Horizontal bars with rank numeral. "Show as table" present. PASS.  
- **Slap hipster index (DS-SL-16):** Horizontal violet bars. "Show as table" present. PASS.  
- **Slap head-to-head (DS-SL-09):** Split bars with colour+value labels. "Show as table" present. PASS.  
- **Clips month + montage summary (DS-CL-MO):** Stat tiles (23 clips, build countdown, last montage) at both widths. Clip manifest renders as a labeled row list (the spec says "The manifest IS a table"). PASS.  
VERDICT:  **FAIL** — DS-WA-MB desktop encoding missing + no accessible table at either width; DS-WA-RT distribution has no "Show as table" disclosure.

---

### DW-6.2
PREMISE:  chart colors pass AA non-text (≥3:1) against the card surface  
EVIDENCE: `dna-contrast.mjs` Section 6 re-run during this review; all 131/131 gated pairs pass (exit 0). Chart mark fills confirmed:  
- `neon-cyan #22e6ff` on glass card: 9.42:1 — PASS  
- `neon-lime #8cff2b` on glass card: 11.2:1 — PASS  
- `neon-gold #ffd24a` on glass card: 9.92:1 — PASS  
- `neon-magenta #ff2fd6` on glass card: 4.51:1 — PASS  
- `neon-violet #9d5cff` on glass card: 3.68:1 — PASS (tightest pair, margin 0.68)  
- `heatmap cyan α=0.55` (lowest step) on glass card: 3.78:1 — PASS  
- `heatmap lime α=0.5` (lowest step) on glass card: 3.77:1 — PASS  
No chart mark color falls below 3:1 at the worst-case stacked glass-card composite.  
VERDICT:  **PASS**

---

**All requirements met:** NO (DW-6.1 FAIL)

---

## Notes (non-blocking)

1. **Heatmap minimum-width scroll (mobile):** `.heatmap-wrap { overflow-x:auto }` with `min-width:560px` means the 7×24 grid scrolls horizontally on 375 px. This is the specified behavior per DS-WA-HM and DS-SL-HM. The scroll affordance is not signaled visually (no fade/shadow on the right edge indicating more content). Consider adding a right-side gradient fade to hint at horizontal scroll — not required by spec but improves discoverability (Gestalt: figure/ground — the clipped grid edge disappears into the card border).

2. **WA timeline bar values:** Vertical bar chart bars carry `aria-label` with the date and count but show no on-bar count label. The "Show as table" disclosure is the specified tap/visible path for non-hover values. This is compliant. If the product team later adds on-bar labels (e.g. for the tallest bars only), data-ink ratio should be watched — labels on 30 bars add noise.

3. **Neon-violet contrast margin:** `#9d5cff on glass card: 3.68:1` passes ≥3:1 but has only a 0.68 margin. In production the glass composite contrast depends on the exact aurora animation frame. The contrast tooling already accounts for worst-case stacked aurora, so this is low risk, but worth monitoring if the aurora opacity bands are ever relaxed upward.

4. **Slap API spot-check (5 endpoints):** `/stats`, `/timeline`, `/heatmap`, `/leaderboard`, `/artists` all return HTTP 200 with the expected shape (verified during review). `/streaks` also verified. Mock data values closely match the live shapes. The `genres` endpoint (used as platform breakdown) returns platform-source names consistent with the "Platforms" section label. Shapes confirmed.

5. **WA member cards — `member-chip-val` uses `--cyan-text`:** All metric values in the member chips render in cyan. At desktop, when the full table is eventually implemented, the sorted-column header should use `--interactive-text` (cyan) per spec and other columns should use `--text`. Current mobile chips are consistent with the cyan = interactive/data role.

---

## Issues (FAIL blockers)

1. **DS-WA-MB desktop table encoding absent** — Major / data-viz / DW-6.1 / Fix: implement `@media (min-width:1024px)` responsive `<table>` with 11 columns, sticky thead, `aria-sort` buttons. At mobile add a "Show as table" `<details>` fallback.

2. **DS-WA-RT distribution chart has no "Show as table"** — Major / data-viz / DW-6.1 / Fix: add a second `<details class="show-table-disclosure">` after `#wa-rt-dist-bars` with Bucket | Count columns.

---

**Verdict: FAIL**

Blockers: (1) DS-WA-MB desktop table encoding not implemented — the entire 11-column sortable table required by the spec is absent at 1440 px, and no accessible table alternative exists at 375 px either. (2) DS-WA-RT distribution chart has no "Show as table" disclosure — the accessible table alternative for the time-bucket distribution data is missing (the single existing disclosure covers only member averages).

DW-6.2 (chart color contrast) passes unconditionally — all 131 gated pairs ≥3:1, tightest at 3.68:1.
