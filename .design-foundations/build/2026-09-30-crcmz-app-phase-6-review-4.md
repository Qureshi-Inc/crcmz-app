# Design Review: Phase 6 - Data Surfaces (Review 4)

## Rendered Evidence (Step 0)

- Screenshots: data-375.png, data-375-fold.png (confirmed 375px single-column WA stat stacking), data-1440.png, data-1440-fold.png
- Surface: data.html — full data surfaces page covering DS-HY, DS-ST, DS-WA-STATS, DS-WA-TL, DS-WA-HM, DS-WA-MB, DS-WA-WC, DS-WA-RT, DS-WA-EM, DS-WA-AW, DS-SL-TL, DS-SL-PL, DS-SL-HM, DS-CL-MO, DS-SL-01, DS-SL-04, DS-SL-05, DS-SL-06, DS-SL-07, DS-SL-08, DS-SL-09, DS-SL-14, DS-SL-15, DS-SL-16, DS-SL-17, DS-SL-18
- Web fonts: Orbitron renders visibly at all display sizes in both screenshots; Google Fonts link present and fonts loaded.

## Assessment B — Deterministic Detector

- Command: `node /home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/detect.mjs .design-foundations/build/data.html > .design-foundations/build/detect-phase6-review4.json`
- Exit: 0 (ran)
- Findings: 33 total — `nested-cards` × 31, `purple-triplet` × 1, `numbered-section-markers` × 1
- Opened only after Assessment A findings were frozen: YES

## Triage

- Baseline (always-on): visual + usability
- Dispatched: `data-viz` (charts, heatmaps, KPI tiles, bar/split charts throughout); `content-design` (microcopy on award cards, stat labels, empty states)
- Not applicable: `journey` (no multi-step flow), `behavioral` (no conversion surface)
- Deferred: none — surface is bounded in scope

## Live API Spot-Checks

Five Slap endpoints and three WhatsApp/hype handlers checked. All field shapes match the DS-* specs.

| Spec | Endpoint / handler | Fields confirmed |
|------|-------------------|-----------------|
| DS-SL-01 | `GET /stats` | `total_songs, total_contributors, this_week_additions, top_artist, total_artists, most_active_day, peak_hour, longest_streak_user, longest_streak_days` — exact match |
| DS-SL-07 | `GET /leaderboard` | `entries[]{rank, username, song_count, color, latest_addition}` — exact match |
| DS-SL-08 | `GET /streaks` | `entries[]{username, color, current_streak, longest_streak, is_active}` — exact match |
| DS-SL-16 | `GET /hipster` | `entries[]{username, color, unique_artists, hipster_score}` — exact match |
| DS-SL-TL | `GET /timeline` | `{entries:[{date, count}]}` — mock consumes entries array correctly |
| DS-HY | `GET /api/hype` (server.py line 7171) | `{count, pct, label, level}` — exact match |
| DS-WA-WC | `whatsapp_analytics.words()` | `{top_words:[{word, count}], member_top_words}` — exact match |
| DS-WA-EM | `whatsapp_analytics.emojis()` | `{top_emoji:[{emoji, count, pct}], total_emoji, member_top_emoji}` — exact match |
| DS-WA-RT | `whatsapp_analytics.response_times()` | `{distribution:[{label, count}], member_avg_minutes:[{name, avg_minutes, count}], fastest_responder}` — exact match |

Note on DS-WA-STATS `total_media` field: `whatsapp_analytics.stats()` line 601 counts `WHERE is_media_omitted=1`. The mock label "Media Omitted" is correct — `total_media` is the count of media-omitted messages, precisely what the handler counts. No label defect.

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| Major | data-viz | DS-WA-STATS renders 1-column at 375px — pixel evidence in data-375-fold.png shows "12,847 Total Messages", "8 Members", "847 Days Active" each as a full-width card stacked vertically. Spec DS-WA-STATS: "2 columns × 3 rows of glass cards (mobile)." Root cause: `.stat-grid-wa` has no base `grid-template-columns`; the first breakpoint only fires at 640px (`repeat(3,1fr)`). At 375px the grid has a single implicit column track. | Munzner *Visualization Analysis & Design*: position on a common scale (comparative reading across tiles) requires correct spatial grouping. Cairo: presenting six independent KPIs stacked 1-up loses the visual grouping between message-count tiles (cyan) and media tiles (lime). | Add `grid-template-columns: 1fr 1fr` to `.stat-grid-wa` base CSS (no media query), preserving the existing 640px → 3-col and 1024px → 6-col overrides. |
| Minor | data-viz | DS-SL-09 split bars lack a fixed centre axis. With `margin-left:auto` on `.split-bar-left`, the visual meeting point between user1 (magenta) and user2 (cyan) bars floats with the data proportions. For the sample (223 vs 40 tracks), user1 occupies the full 50% left partition; the "centre" is effectively at x=0 from user2's perspective. Munzner: "position on common scale; centre axis = shared reference point." | Munzner *Visualization Analysis & Design* (2014): diverging bars derive their comparative power from a fixed zero/centre anchor, not a floating meeting edge. | Replace the auto-margin approach with a proper two-partition flexbox: left partition is a `flex:1` right-aligned container for user1's bar (direction `row-reverse`); right partition is a `flex:1` left-aligned container for user2's bar. Insert a 1px centre separator. Spec's "grouped bars side-by-side is acceptable on narrow widths" is the 375px fallback if the diverging layout is too narrow. |
| Minor | data-viz | DS-CL-MO clips-count tile uses the `.stat-numeral hero` modifier, rendering at `--text-4xl` (42px mobile) / Orbitron 900. DS-CL-MO specifies `--text-3xl` Orbitron 800 for `clips_this_month`. DESIGN.md reserves `--text-4xl` for "hero numerals: hype count, countdown, giveaway winner" — clips-this-month count is absent from that list. | Few *Information Dashboard Design* (2006): scale tokens signal hierarchy; using a token above specification pushes this KPI to the same visual weight as the hype count, conflating two different hierarchy levels. | Remove the `hero` class from the clips-count `<span>`. The base `.stat-numeral` class already gives `--text-3xl` Orbitron 800 as specified. |
| Note | detector | **nested-cards (31 hits)** — Detector evidence: `<div class="card-label"> is a card inside a card ancestor`, `<button class="chart-toggle active"> is a card inside a card ancestor`, `<select> is a card inside a card ancestor`, `<th class="col-frozen"> is a card inside a card ancestor`, `<div class="hype-bar-fill"> is a card inside a card ancestor`. All 31 are false positives from the rule matching "card" in class-name substrings: `.card-label` is a label utility class, not a card element; `.chart-toggle` are interactive controls; `<select>`, `<th>` are table/form elements. There are no `.card` elements nested inside other `.card` elements in this file — no double-depth glass card pattern exists. Register justified: single-depth section cards housing controls, labels, and data components. | Nielsen #4 (consistency and standards): actual card-within-card nesting creates double-border/double-padding artefacts. No such artefact is present here. | No action required. If the project adds `.card` elements inside other `.card` containers in future, the rule will give a genuine signal. |
| Note | detector | **purple-triplet (1 hit)** — Detector evidence: `AI-default accent #8b5cf6` at line 1690 (slapLeaderboard data: `{username:"moiz", color:"#8b5cf6"}`). This is a per-user colour from the live Slap API (`GET /leaderboard` entries[3].color confirmed as `#8b5cf6` via live fetch). Mock correctly renders it as a 10px decorative dot beside the username only, not as any bar fill or UI accent. DESIGN.md §Chart data-colour rule: "Per-user `color` is decoration only — rendered as a small dot beside the member label, not as the chart bar fill." Register justified: real API data, rendered as specified decoration. | DESIGN.md: "Per-user API colours are decorative only." | No action. The colour is API data, not a designer choice. |
| Note | detector | **numbered-section-markers (advisory)** — Detector evidence: `decorative sequence: 03, 04, 05, 06, 07, 08`. These appear in spec cross-reference labels embedded in the mock for traceability: "Awards · WA-03", "Activity Timeline · DS-WA-TL", section tags `PS-4 · DS-WA-*`. These are intentional design-review markers, not decorative AI-generated numbering in the production UI sense. Register justified: documentation labels on a review mock. | N/A | No action for the mock. Production implementation should not carry these labels. |

## Requirement Fulfillment

### DW-6.1
PREMISE: "each data surface has a mobile and desktop encoding plus an accessible table alternative. Check every DS-* spec in JOURNEY.md §Data specs; for each, confirm all three exist in data.html at the right widths."

EVIDENCE:

DS-HY: Mobile — hype-strip card with `--text-4xl` numeral, level label, 8px bar, threshold ticks at 0/15/40/80/120/150, "/ 150 max" label all visible in data-375-fold.png. Desktop — same strip wider in data-1440-fold.png. Table alt — count + pct + label always-visible text is the specified accessible equivalent. PASS for DS-HY.

DS-ST: Mobile — flex stat chips (24 Platinums / 571 Top Level / ARC Raider Fav Game) visible in data-375-fold.png; desktop stat tiles (`#squad-stat-tiles`) shown at ≥1024px confirmed in data-1440-fold.png. Table alt — tiles are the accessible display. PASS for DS-ST.

DS-WA-STATS: Desktop — 6 tiles in a single row visible in data-1440-fold.png with correct cyan/gold/lime colour assignments. Table alt — tiles are the accessible display. Mobile — **FAIL**: data-375-fold.png shows tiles as a single-column stack (12,847 full-width, 8 full-width, 847 full-width). Spec requires 2×3 grid. CSS root cause confirmed: `.stat-grid-wa` has no base `grid-template-columns`; single-column at 375px. PARTIAL (desktop PASS, mobile FAIL).

DS-WA-TL: Mobile — cyan bar chart with Daily/Monthly toggle, y-axis gridlines, "Show as table" `<details>` visible in data-375.png. Desktop — full-width chart in data-1440.png. Table alt — `<details>` date|count table confirmed in HTML. PASS.

DS-WA-HM: Mobile — 7×24 cyan ramp heatmap, scrollable, hour labels at 0h/6h/12h/18h, day labels Mon–Sun, tap-inspect via click handler confirmed in HTML, "Show as table" `<details>`. Desktop — full non-scrolling grid in data-1440.png with larger cells (`height:32px` at ≥1024px). Table alt — day|hour|count table. PASS.

DS-WA-MB: Mobile — member cards with Messages/Words/Avg chips, sort `<select>`, "Show as table" scrollable sticky-header table. Desktop — full sticky-header sortable table with frozen Member column (`display:none` toggled to `display:block` at ≥1024px). Both confirmed in HTML and screenshots. Table alt — table is the accessible display. PASS.

DS-WA-WC: Mobile — 15 lime horizontal bars (`.hbar-list`), word label left, count right, "Show as table" `<details>`. Desktop — 20 words via `.wc-desktop-only` rows shown at ≥1024px. Table alt — word|count table. PASS.

DS-WA-RT: Mobile — gold vertical histogram (5 buckets) + gold horizontal member-average bars, both with "Show as table" `<details>`. Desktop — two-column `.two-col` layout side-by-side confirmed in data-1440.png. Table alt — both disclosures present. PASS.

DS-WA-AW: Mobile — 2-col award card grid with emoji icons and gold winner names visible in data-375.png. Desktop — 5-col grid at ≥1024px. Table alt — cards are self-labelled (title + winner always visible). PASS.

DS-WA-EM: Mobile — ranked emoji list with rank number, glyph, cyan pct bar, count; per-member rows below; "Show as table" `<details>`. Desktop — two-col `.two-col` layout. Table alt — Emoji|Count|% disclosure. PASS.

DS-SL-TL: Mobile — magenta bar chart, 91-day span, labels every 14 days, tap-to-inspect, "Show as table" `<details>`. Desktop — wider. PASS.

DS-SL-PL: Mobile — horizontal bars coloured magenta/cyan/gold/lime by rank order (Spotify 65%/YouTube 20%/Apple Music 10%/TikTok 5%), percentage at tip, "Show as table" `<details>`. Desktop — wider. PASS.

DS-SL-HM: Mobile — 7×24 lime ramp heatmap, scrollable, hour labels at 0h/6h/12h/18h, tap-to-inspect, "Show as table" `<details>`. Desktop — full non-scrolling grid. PASS.

DS-CL-MO: Mobile — two stat tiles (23 clips-this-month in `--text-4xl` gold [note: spec says `--text-3xl`, minor]; montage summary v2·18 clips·3m 14s in gold/lime); clip manifest table with lime/dim status dots. Desktop — same tiles wider. Table alt — manifest IS a table. PASS with Minor note on numeral size.

DS-SL-01: Mobile — 2×2 grid via `stat-grid-2` (base `grid-template-columns:1fr 1fr` confirmed, no media query needed). Desktop — 4-tile row at ≥1024px. Table alt — tiles are the display. PASS.

DS-SL-04 through DS-SL-18: All present with mobile encodings, desktop variations, and accessible alternatives (table disclosures or self-labelled cards) confirmed in HTML and screenshots. Colour assignments match spec for each: gold bars for DS-SL-07/DS-SL-08/DS-SL-14 (ranked achievement), violet bars for DS-SL-16 (analytical score), magenta/cyan split for DS-SL-09, lime unlocked label for DS-SL-15, gold card titles for DS-SL-18. PASS for all.

VERDICT: PARTIAL — DS-WA-STATS mobile grid is 1-column at 375px; all other DS-* specs pass both mobile and desktop encodings and have accessible table alternatives.

---

### DW-6.2
PREMISE: "chart colors pass AA non-text (≥3:1) against the card surface"

EVIDENCE: `dna-contrast.mjs` run confirms **131/131 gated pairs PASS**. Chart mark section results:

| Mark | Hex | Ratio on glass card | Verdict |
|------|-----|-------------------|---------|
| neon-cyan bar fill | `#22e6ff` | 9.42:1 | PASS |
| neon-lime bar fill | `#8cff2b` | 11.2:1 | PASS |
| neon-gold bar fill | `#ffd24a` | 9.92:1 | PASS |
| neon-magenta bar fill | `#ff2fd6` | 4.51:1 | PASS |
| neon-violet bar fill | `#9d5cff` | 3.68:1 | PASS |
| border-control gridline | `#8d78c4` | 3.82:1 | PASS |
| heatmap cyan α=0.55 | blended | 3.78:1 | PASS |
| heatmap cyan α=0.75 | blended | 5.86:1 | PASS |
| heatmap cyan α=1.0 | `#22e6ff` | 9.42:1 | PASS |
| heatmap lime α=0.50 | blended | 3.77:1 | PASS |
| heatmap lime α=0.75 | blended | 6.83:1 | PASS |
| heatmap lime α=1.0 | `#8cff2b` | 11.2:1 | PASS |

All active heatmap ramp stops ≥3:1. Adjacent-step ratios (1.70–2.02:1) are non-text within the ramp and cells carry tap-to-inspect values per spec, satisfying the accessibility path.

VERDICT: PASS

---

**All requirements met:** NO — DW-6.1 PARTIAL (DS-WA-STATS mobile grid fails; all other DS-* pass)

## Notes (non-blocking)

- **Emoji tofu in awards cards** ("Most [tofu]", "Most [tofu]"): Headless Chromium capture artifact — the markup contains real Unicode emoji characters (`💀`, `🔥`); treatment per review instructions: not a defect, only a capture artifact.
- **Hype level label "ON FIRE" for count 137**: DS-HY scale places 137 in the "overload" range (>120). The label text is sample/mock data and doesn't test real API behaviour. The bar fill colour (lime) is correct for both fire and overload levels. No action needed on the mock.
- **WA timeline y-axis**: Two dynamic gridlines at 25% and 75% of max are computed correctly in JS (lines 1332–1340). Spec says "Two y-axis gridlines at 25% and 75%." ✓
- **DS-SL-09 Compare button**: Full-width, cyan border, min-height 44px (tap-min), visible in both screenshots. Selects wrap vertically at 375px per flex-wrap. ✓
- **"total_media" label**: Confirmed via `whatsapp_analytics.py` line 601 — `total_media` counts `is_media_omitted=1` messages. The mock label "Media Omitted" is factually correct for this field. Previously flagged as a discrepancy; retracted upon handler inspection.

## Issues (blockers)

1. **DS-WA-STATS 375px mobile grid is 1-column** — Severity: Major / Pillar: data-viz / Principle: Munzner position-on-common-scale grouping / Fix: add `grid-template-columns: 1fr 1fr` to `.stat-grid-wa` base CSS (no media query wrapper). This is the sole DW-6.1 blocker; all 24 other DS-* specs pass.

**Verdict: FAIL — 1 blocker: DS-WA-STATS mobile grid is 1-column at 375px (missing base grid-template-columns on .stat-grid-wa), violating the DS-WA-STATS "2 columns × 3 rows (mobile)" spec. DW-6.2 is unaffected (131/131 PASS).**
