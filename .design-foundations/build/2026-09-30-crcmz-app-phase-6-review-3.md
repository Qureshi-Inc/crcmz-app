# Design Review: Phase 6 — Data Surfaces (Review 3)

**Date:** 2026-09-30 · **Reviewer stance:** Independent; did not produce this design.

---

## Rendered Evidence (Step 0)

- Screenshots: `data-375.png`, `data-375-fold.png`, `data-1440.png`, `data-1440-fold.png` — all read and audited
- Surface: `data.html` — single-page data mock covering all DS-* specs across Squad Strip, WhatsApp Analytics, Slapshare Music, and Clips sections
- Both widths reviewed in full (full-page PNGs, fold PNGs, and source)

---

## Assessment B — Deterministic Detector

- Command: `node /home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/detect.mjs .design-foundations/build/data.html > .design-foundations/build/detect-phase6-r3.json`
- Exit: 0 (ran)
- Findings: 32 total — `nested-cards`: 30, `purple-triplet`: 1, `numbered-section-markers`: 1 (advisory)
- Opened only after Assessment A findings were frozen: YES

---

## Triage

- **Baseline (always-on):** visual + usability
- **Dispatched:** `data-viz` (charts, heatmaps, dashboards throughout), `content-design` (real product copy in labels, empty states, toggles), `usability` (sortable tables, bar-tap interaction, disclosures)
- **Not applicable:** `journey` (no multi-page flow), `behavioral` (no conversion surface)
- **Deferred:** none — surface is a single-page data mock; all present pillars reviewed

---

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| **Major** | data-viz / usability | Bar chart x-axis labels and RT histogram bucket labels rendered at **8 px** and **9 px** respectively (`.bar-x-label`: `font: 600 8px`, `.rt-hist-label`: `font: 600 9px`). Affects WA timeline, Slap timeline, and response-time distribution chart. | DESIGN.md §Type: "Meta text (timestamps, captions) is 13 px, and only at weight 600." 8 px is 38 % below the floor; labels become unreadable at normal phone DPR. | Change to `font: 600 var(--text-xs)` (13 px) throughout. If labels crowd at 13 px, reduce bar width or rotate every-Nth labelling — never go below 13 px. |
| **Major** | data-viz / usability | **Tap-inspect not implemented.** DS-WA-TL, DS-SL-TL, DS-WA-HM, and DS-SL-HM all carry `tabindex="0" role="button"` or `tabindex="0"` on bars/cells but have **no JS click handler**. Heatmap cells carry `title=""` (mouse hover only). Bar elements have no `title` at all. | Scope requirement: "No chart value is readable only via hover; there is a tap/visible path." DS-WA-TL/DS-SL-TL: "Tap any bar to inspect the count (not hover-only)." DS-WA-HM/DS-SL-HM: "tap cell: shows popover." `title` is mouse-hover-only and invisible on touch. | Add click handlers that toggle a visible count label above the bar (or a positioned popover for heatmap cells). The `aria-label` on each element satisfies screen-reader access but not the "visible path" leg of the requirement. |
| **Major** | data-viz | **DS-SL-01 `top_artist` tile colour is gold (`--gold-text`) but spec says `--magenta-text`.** Line 934: `style="color:var(--gold-text);font-size:var(--text-xl)"`. The DESIGN.md locked colour rule assigns gold exclusively to "Achievement: ranks, trophies, plats, the giveaway prize." A top-artist name is a factual datum, not a rank or prize. | DESIGN.md §Color tokens locked rule: "Gold — Achievement: ranks, trophies, plats, the giveaway prize." DS-SL-01 spec explicitly states `top_artist` tile colour as `--magenta-text`. | Change `color` on the `top_artist` numeral to `var(--magenta-text)`. Gold is already used for the compatibility score (87%), streak counts, and leaderboard bars — those are rank/achievement values. The artist name is not. |
| **Major** | data-viz | **DS-ST desktop encoding absent.** JOURNEY.md DS-ST: "Desktop encoding: Three full stat tiles (glass card, `--text-3xl` numeral, `--c-stat-label-sz` label)." At 1440 px the stat chips section still uses the same compact flex-row (`.stat-chip` / `--text-xl`) as on mobile. No breakpoint promotes them to full glass card tiles with `--text-3xl` numerals. DW-6.1 unmet for DS-ST at 1440. | DW-6.1: "each data surface has a mobile and desktop encoding." The spec defines separate desktop behaviour for DS-ST. (Few, *Information Dashboard Design*, 2006: key metrics should be the most visually prominent at the screen size that allows it.) | At `@media (min-width:1024px)`, replace the flex-row chips with `stat-grid stat-grid-3` tiles using `--text-3xl` numerals in `.stat-tile`. |
| **Major** | data-viz | **DS-SL-09 missing [Compare] button.** JOURNEY.md DS-SL-09: "Two `<select>` dropdowns … [Compare] button fires the fetch. Mobile: '[Compare] full-width button.'" No button element exists in the mock; the split bars are populated from static JS without any trigger. | DW-6.1: each DS-* spec requires the specified interactive controls. (Nielsen #7 flexibility and efficiency: provide explicit affordances for user actions.) | Add a `<button>` element after the second `<select>`, styled as a full-width primary control on mobile. On desktop, place it inline beside the selects. Wire a click handler (or note it as JS stub for production). |
| **Minor** | data-viz | **DS-WA-WC desktop word count: 15 instead of 20.** Spec: "Desktop encoding: Same, wider. Top 20 words." The JS data array `waWords` has 15 entries; no additional entries are added at wider breakpoints. | DW-6.1: desktop encoding for DS-WA-WC requires top 20. (Tufte data-ink ratio: show all available data at the resolution the screen allows.) | Extend `waWords` to 20 entries and conditionally render the extra 5 at ≥1024 px, or render all 20 and hide extras on mobile via CSS `display:none` on rows beyond index 14. |
| **Minor** | data-viz | **DS-ST mobile numeral size uses `--text-xl` (24 px) but spec says `--text-3xl` (35 px).** `.stat-chip-num` CSS: `font: 800 var(--text-xl)/1.0 var(--font-display)`. Spec: "numeral in `--text-3xl` (35 px) Orbitron 800 `--c-stat-numeral-sz`." Related: the Fav Game chip applies an inline `font-family:var(--font-body)` override, switching Orbitron to Rajdhani for the game name. | JOURNEY.md DS-ST; DESIGN.md §Type: stat numerals use Orbitron. | Either define `--c-stat-numeral-sz` as `--text-3xl` for the compact strip, or confirm the strip intentionally uses `--text-xl` and update the spec accordingly. For Fav Game, game names are text not numerals so body font is practical — add an explicit spec note rather than a silent override. |
| **Minor** | data-viz | **DS-WA-MB mobile card shows 4 chips (Msgs · Words · Avg/msg · Videos) but spec says 3 (Messages · Words · Avg words/msg).** Line 1385: a Videos chip is appended in the JS `waMembers` rendering loop. | JOURNEY.md DS-WA-MB: "3-chip row (Messages · Words · Avg words/msg)." Adding an unspecified 4th chip is a spec deviation (Few: cross-dimensional tables beat small multiples for "show me all dimensions"; reducing the card chip count to the 3 specified keeps mobile density manageable). | Remove the Videos chip from the mobile card row. Videos data is available in the desktop table. |
| **Minor** | data-viz | **DS-WA-MB desktop missing expandable per-member rows.** Spec: "Top-emoji and top-words per member in an expandable row (no hover)." The desktop `<table>` has no `<tr class="expandable">` or disclosure rows. | JOURNEY.md DS-WA-MB desktop encoding. (Nielsen #1 visibility of system status: users expect the advertised cross-member detail to be accessible.) | Add `<tr>` expansion rows below each member row, toggled by a click/keyboard handler on the member cell. |
| **Minor** | data-viz | **DS-WA-HM hour-axis: 5 labels shown (0h, 6h, 12h, 18h, 23h) but spec says 4 (0, 6, 12, 18).** JS: `(h===0||h===6||h===12||h===18||h===23)`. | JOURNEY.md DS-WA-HM: "Hour axis: labels at 0, 6, 12, 18 only (4 ticks, no crowding)." Same applies to DS-SL-HM (same render logic). | Remove `h===23` from both heatmap label conditions. |
| **Minor** | data-viz | **DS-SL-05 username font uses `--text-sm` (15 px) but spec says `--text-lg` (20 px).** Line 948: `font:600 var(--text-sm) var(--font-body)` on `throne-user`. | JOURNEY.md DS-SL-05: "username in `--text-lg` `--magenta-text`." | Change to `font:600 var(--text-lg)/1 var(--font-body)`. |
| **Minor** | data-viz | **DS-WA-TL y-axis gridlines are hardcoded at `bottom:80px` / `bottom:40px` (labels "80" / "40") instead of dynamic 25 % / 75 % of max.** The sample max is 113; 25 % = 28 and 75 % = 85, so neither label is correct for the data. In production the gridlines will be wrong for any period with a different max. | JOURNEY.md DS-WA-TL: "Two y-axis gridlines at 25 % and 75 % of max." (Tufte VDQI: gridlines must be labelled with the values they represent.) | Compute `const lo = Math.round(waMax * 0.25); const hi = Math.round(waMax * 0.75);` and set both the pixel position and the label text dynamically. |
| **Minor** | design-dna | **Aurora `body::before` uses `inset:-10%` unconditionally.** DESIGN.md reference implementation: `inset: -30% -10%` with a `@media (orientation: portrait)` override to `inset: -10%`. The mock omits the default and the media query, so on landscape/desktop the aurora behaves differently than the locked spec. | DESIGN.md §Aurora + grid (pinned; reference implementation). | Restore to `inset: -30% -10%` with `@media (orientation: portrait) { body::before { inset: -10%; } }` as in the DESIGN.md reference. |
| **Minor** | data-viz | **DS-HY tick marks: 4 marks on bar instead of spec's 6.** The bar track shows tick marks at 15/40/80/120 positions only (left: 10 %, 26.7 %, 53.3 %, 80 %). The 0 and 150 positions (bar edges) have no tick mark. | JOURNEY.md DS-HY: "Six threshold tick marks below the bar at 0/15/40/80/120/150." | Add two more `.hype-tick-mark` elements at `left:0` and `left:100%` (or `right:0`). |
| **Minor** | data-viz | **DS-SL-HM low-alpha stop uses 0.55, spec says 0.50.** `limeAlpha` helper always passes 0.55 for low tier (count ≤ max×0.33). JOURNEY.md DS-SL-HM: "low (≤ max×0.33): `rgba(140,255,43,0.50)`". | JOURNEY.md DS-SL-HM colour spec. | Change `limeAlpha(0.55)` to `limeAlpha(0.50)` for the low tier in `heatAlpha`. |
| **Minor** | data-viz | **Heatmap cell height 20 px vs spec's ~28 px.** `.hm-cell { height: 20 px; }`. JOURNEY.md DS-WA-HM: "Cell size ≈ 14×28px." At 20 px the cells are 29 % shorter than specified; tap targets are below the 44 px row height recommended for comfortable touch. | JOURNEY.md DS-WA-HM; DESIGN.md `--tap-min: 44px`. (Fitts's law: smaller tap targets increase error rate.) | Increase `.hm-cell { height: 28px; }` and verify the grid still fits a min-width of 560 px. |
| Note | detector | **Assessment B — `nested-cards` (30 hits).** The detector flags `.card-label`, `.chart-toggle`, `<select>`, and form controls inside `.card` section containers. Evidence samples: `"<div class=\"card-label\"> is a card inside a card ancestor"`, `"<button class=\"chart-toggle active\"> is a card inside a card ancestor"`. Register justification: `.card` is the section container; `.card-label` is a sub-element label class, not a glass card; form controls and chart toggles inside section containers are legitimate. The one styled sub-div (line 1059 compatibility score tile with its own border-radius and border) is a deliberate KPI highlight within the H2H card — a valid pattern. No glass-on-glass depth violation is present. | ai-tells.md: `nested-cards` rule. | No action required. If the rule is overly broad in this codebase, consider scoping `.card` to the outer container class only and using a non-`.card`-prefixed class (e.g. `.section-card`) for top-level containers. |
| Note | detector | **Assessment B — `purple-triplet` (1 hit).** Evidence: `"AI-default accent #8b5cf6"` at line 1644 (leaderboard data `{username:"moiz", color:"#8b5cf6"}`). Register justification: `#8b5cf6` is the Slap API's per-user assigned colour, rendered as a 10 px decorative dot beside the username. DESIGN.md §Chart data-colour rule: "per-user API colours are decorative only." DS-SL-07: "Per-user `color` from the API: rendered as a 10px decorative dot beside the username only (decoration, not data-ink; per-user colours are not gated, not from the locked palette)." This is not a design choice; it is live API data displayed as an accessibility cue. | ai-tells.md: `purple-triplet` rule; DESIGN.md §Chart data-colour rule. | No action required. If the API ever changes the colour, the dot updates automatically. |
| Note | detector | **Assessment B — `numbered-section-markers` (advisory).** Evidence: `"decorative sequence: 03, 04, 05, 06, 07, 08"`. These are DS-* spec cross-references (`WA-03`, `SL-04`, `SL-05`, etc.) used as development/review annotations in `.card-label` and `.section-title .tag` elements. They are not decorative UI chrome and would not ship to production. | ai-tells.md: `numbered-section-markers` advisory. | No action required in the mock. Remove spec-reference annotations when porting to production HTML. |

---

## Requirement Fulfillment

### DW-6.1
PREMISE: "each data surface has a mobile and desktop encoding plus an accessible table alternative. Check every DS-* spec in JOURNEY.md §Data specs; for each, confirm all three exist in data.html at the right widths."

EVIDENCE:

**DS-HY (hype meter):** Mobile strip (42 px Orbitron 900 numeral, 8 px bar, 6 tick labels) ✓. Desktop (numeral left, bar right spanning remaining width) ✓. Table alternative: count + pct + label always visible as text alongside bar — spec says "bar is redundant visual encoding only" ✓. Minor: only 4 tick marks on bar (spec: 6).

**DS-ST (stat chips):** Mobile (3 flex-row chips, Orbitron, gold/lime) ✓. Desktop encoding: MISSING — spec says "three full stat tiles (glass card, `--text-3xl` numeral)" at desktop; mock keeps compact chips at all widths ✗. Table alternative: always-visible numerals ✓.

**DS-WA-STATS:** Mobile (1-col, then 2-col at ≥640 px per `.stat-grid-wa`) ✓. Desktop (6-up row at ≥1024 px) ✓. Table alternative: tiles are always-visible ✓. Note: 6th tile shown as "Media Omitted (89)" — confirmed against `whatsapp_analytics.py` line 601 where `total_media = COUNT(*) WHERE is_media_omitted=1`. Label is accurate.

**DS-WA-TL:** Mobile (scrollable cyan bar chart with Daily/Monthly toggle) ✓. Desktop (wider, same chart full-width) ✓. Table alternative: "Show as table" `<details>` ✓. Minor: static y-axis gridlines (see Findings).

**DS-WA-HM:** Mobile (7×24 scrollable cyan heatmap with right-edge fade) ✓. Desktop (no scroll, fade hidden) ✓. Table alternative: "Show as table" `<details>` ✓. Tap-inspect: NOT implemented (title attr = hover-only, no click handler) ✗ per scope requirement.

**DS-WA-MB:** Mobile (member cards with 4-chip row + sort select) — 4 chips vs spec's 3 (Minor) ✓ functional. Mobile table: "Show as table" `<details>` ✓. Desktop (sticky-header sortable table, Member column frozen, `aria-sort` on headers) ✓. Desktop expandable per-member rows: MISSING ✗ (Minor).

**DS-WA-WC:** Mobile (15 lime horizontal bars) ✓. Desktop: 15 bars instead of spec's 20 ✗ (Minor). Table alternative: "Show as table" `<details>` ✓.

**DS-WA-RT:** Mobile (histogram stacked above member bars) ✓. Desktop (two-col via `.two-col`) ✓. Table alternative: "Show as table" `<details>` on each chart ✓.

**DS-SL-TL:** Mobile (scrollable magenta bar chart) ✓. Desktop (wider) ✓. Table alternative: `<details>` ✓. Tap-inspect: NOT implemented ✗.

**DS-SL-PL:** Mobile (categorical horizontal bars, 4 neon colours, percentage + count labels) ✓. Desktop (wider) ✓. Table alternative: `<details>` ✓.

**DS-SL-HM:** Mobile (7×24 scrollable lime heatmap) ✓. Desktop (no scroll) ✓. Table alternative: `<details>` ✓. Tap-inspect: NOT implemented (title only) ✗.

**DS-CL-MO:** Mobile (clips-this-month tile + countdown in gold, montage summary card, clip manifest table) ✓. Desktop (2-col grid for tiles, manifest below) ✓. Table alternative: clip manifest IS the table ✓.

**DS-WA-AW:** Mobile (2-col award card grid) ✓. Desktop (5-col at ≥1024 px) ✓. Table alternative: cards are self-labelled per spec ✓.

**DS-WA-EM:** Mobile (ranked emoji list with cyan pct bars + per-member chips) ✓. Desktop (two-col: list left, per-member grid right) ✓. Table alternative: "Show as table" `<details>` ✓.

**DS-SL-01:** Mobile (2×2 tile grid, magenta/cyan/gold colors) ✓. Desktop (4-tile row) ✓. `top_artist` colour deviates: gold used instead of spec's magenta ✗ (see Findings). Table alternative: always-visible ✓.

**DS-SL-04:** Mobile/desktop (two-col ranked lists) ✓. Table alternative: lists are display ✓.

**DS-SL-05:** Mobile/desktop (glass card with gold-border left) ✓. Username at `--text-sm` instead of spec's `--text-lg` (Minor). Table alternative: card is display ✓.

**DS-SL-06:** Mobile/desktop (numbered list, empty state wired) ✓. Table alternative: list is display ✓.

**DS-SL-07:** Mobile/desktop (gold horizontal bars + per-user API colour dot) ✓. Table alternative: `<details>` ✓. Colour correct: gold = ranked-achievement count ✓.

**DS-SL-08:** Mobile/desktop (gold horizontal bars, Active badge, current streak chip) ✓. Table alternative: `<details>` ✓.

**DS-SL-09:** Mobile/desktop (two selects, split bars magenta/cyan, compatibility tile, shared artists, AI vibe text) ✓. Missing [Compare] button ✗ (Major). Table alternative: `<details>` ✓.

**DS-SL-14:** Mobile/desktop (gold horizontal bars, latest_album sub-label) ✓. Table alternative: `<details>` ✓.

**DS-SL-15:** Mobile (2-col card grid, unlocked=full / locked=dimmed 0.45) ✓. Desktop (3-col) ✓. Table alternative: cards self-labelled ✓.

**DS-SL-16:** Mobile/desktop (violet horizontal bars, unique-artists sub-label, `--violet-text` values) ✓. Table alternative: `<details>` ✓.

**DS-SL-17:** Mobile (2-col card grid, personality title `--magenta-text`, song count `--gold-text`, per-user API border decoration) ✓. Desktop (3-col) ✓. Table alternative: "Show all as table" `<details>` ✓.

**DS-SL-18:** Mobile (single-col milestone cards, title `--gold-text`) ✓. Desktop (2-col) ✓. Table alternative: cards self-labelled ✓.

VERDICT: **FAIL** — DS-ST desktop encoding absent; DS-SL-09 missing Compare button; DS-WA-WC desktop word count 15 vs 20; DS-WA-MB mobile chips 4 vs 3 and desktop missing expandable rows; tap-inspect missing on all 4 bar/heatmap charts; DS-SL-01 `top_artist` colour wrong.

---

### DW-6.2
PREMISE: "chart colors pass AA non-text (≥3:1) against the card surface"

EVIDENCE: Verified by running `dna-contrast.mjs` directly. All five chart fill colours confirmed against glass card surface (`rgba(18,10,38,.66)` over stacked-peak aurora):
- `--neon-cyan` `#22e6ff`: **9.42:1** on glass — PASS
- `--neon-magenta` `#ff2fd6`: **4.51:1** on glass — PASS
- `--neon-lime` `#8cff2b`: **11.2:1** on glass — PASS
- `--neon-gold` `#ffd24a`: **9.92:1** on glass — PASS
- `--neon-violet` `#9d5cff`: **3.68:1** on glass — PASS

All values ≥ 3:1 threshold. dna-contrast.mjs output: `PASS` on all five `[chart mark 3.0]` rows. All 5 chart colours in all 13 quantitative charts (WA timeline, WA heatmap, word counts, response-time histogram + member bars, Slap timeline, Slap platform, Slap heatmap, leaderboard, streaks, top artists, head-to-head split bars, hipster index) use exactly these five tokens.

VERDICT: **PASS**

---

**All requirements met:** NO (DW-6.1 FAIL; DW-6.2 PASS)

---

## Notes (non-blocking)

- **Slap API spot-check (5 endpoints):** `/stats`, `/timeline`, `/genres`, `/leaderboard`, `/streaks`, `/heatmap` (6 checked, all HTTP 200). Response shapes match DS-* specs exactly: `entries[]` field in leaderboard/streaks, `cells[]{day,hour,count}` in heatmap, `genres[]{name,count,percentage}` in platform breakdown, `artists[]{name,count,latest_album}` in top-artists. Live data confirms the mock's field-name choices are correct. Sample data values in the mock match the actual leaderboard (themoosecompany: 223 tracks, nooramin40: 40, asamad89: 37), confirming the mock was built from real API responses.

- **3 WhatsApp/hype handlers checked:** `whatsapp_analytics.py` confirms `total_media = COUNT(*) WHERE is_media_omitted=1` (validates "Media Omitted" label as accurate for the `total_media` field). `server.py` confirms `wa_emojis`, `wa_response_times`, `wa_members`, `wa_awards` handlers are present. The `api_hype` handler at line 7167 is present.

- **Distinctiveness (ai-tells.md CHECKER mode):** The aesthetic direction is nameable in 3 words: "neon-on-deep-space." Choices present that a generic system would not make: the 5-role colour lock (each hue has exactly one semantic job), the `rgba(18,10,38,.66)` glass over `#05030f` aurora, the `--neon-violet` hipster index (an ambient/analytical encoding breaking the default cyan-for-everything pattern), and the diverging split bars for head-to-head (a visual choice the spec argues explicitly against the default grouped-bars approach). The design passes the distinctiveness criterion.

- **DS-WA-EM pct bar width calculation** uses `width:${e.pct*6}px` (fixed pixels), not a true percentage relative to container. At 14.5 % that is 87 px; at 100 % it would be 600 px, clipped by `max-width:100%`. This works visually but would produce incorrect relative bar widths if two items are close to 100 %. Switch to `width:${e.pct}%` relative to the container for correctness.

- **DS-WA-TL vertical bar chart:** The spec says bars should respond to tap with a "selected/tapped bar: `--cyan-fill` fill + count label above." The `aria-label` on each `.bar-rect` does provide count to screen readers (e.g. `aria-label="Sep 1: 12 messages"`), satisfying assistive-technology access. The visual tap-inspect gap is the issue (no count shown visually on tap).

---

## Issues (FAIL)

1. **Bar x-axis and histogram labels at 8–9 px** — Major / data-viz / DESIGN.md §Type minimum 13 px / Use `var(--text-xs)` (13 px)
2. **Missing tap-inspect handlers** on bar charts and heatmaps — Major / usability / DW scope: "tap/visible path" / Add click handlers
3. **DS-SL-01 `top_artist` tile colour is gold, spec says magenta** — Major / data-viz / DESIGN.md colour rule + DS-SL-01 / Change to `var(--magenta-text)`
4. **DS-ST desktop encoding absent** — Major / data-viz / DW-6.1 / Add breakpoint stat tiles at ≥1024 px
5. **DS-SL-09 missing [Compare] button** — Major / usability / DW-6.1 / Add button after second select

**Verdict: FAIL**

Blockers: DW-6.1 not fully met (items 2, 3, 4, 5 above) and DESIGN.md typography minimum violated on all bar chart axis labels (item 1). DW-6.2 PASS.
