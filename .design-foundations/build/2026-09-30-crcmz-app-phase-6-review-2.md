# Design Review: Phase 6 — Data surfaces (Review 2)

## Rendered Evidence (Step 0)

- Screenshots: `data-375.png` (375×8336), `data-375-fold.png` (375×774), `data-1440.png` (1440×6208), `data-1440-fold.png` (1440×866). All four read and inspected. Sections cropped with PIL for detail review (slap section, clips section, response-times section, mid-slap).
- Fonts: markup at line 605 sets `--font-display: "Orbitron"`. The fold screenshots confirm the Orbitron hero numeral renders (hype meter "137" displayed correctly at 42px).
- Surface: data.html — full-page data dashboard mock at 375 and 1440. Sections: Squad Strip (hype meter + stat tiles), WhatsApp Analytics (totals, awards, top emoji, member table, timeline, heatmap, word counts, response times), Slapshare Music (stat tiles, timeline, platform breakdown, heatmap, top artists, head-to-head, leaderboard, hipster index), Clips This Month.

## Assessment B — Deterministic Detector

- Command: `node /home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/detect.mjs .design-foundations/build/data.html > .design-foundations/build/detect-phase6-r2.json`
- Exit: **0 (ran)**
- Findings: 25 hits across 3 rules — nested-cards ×23, purple-triplet ×1, numbered-section-markers ×1
- Opened only after Assessment A findings were frozen: **YES**

## Triage

- Baseline (always-on): visual + usability
- Dispatched: `data-viz` (charts, heatmaps, dashboards present); `content-design` (chart labels, section headers, empty/sparse states); `usability` (interactive toggles, sortable table, tap-to-inspect)
- Not applicable: `journey` (no multi-page flow), `behavioral` (no conversion/persuasion surface)
- Deferred: none — surface is large but all flagged pillars were covered within the visual+usability+data-viz triad

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| **Major** | data-viz / DW-6.1 | DS-SL-08 (Streak tracker) is specced in JOURNEY.md §Data specs as a horizontal bar chart with mobile + desktop + "Show as table" requirement and was explicitly included in the Phase 6 discovery scope ("Leaderboard (SL-07), streaks (SL-08), hipster (SL-16): ranked lists, table spec"), but is absent from data.html. No rendered evidence for this chart surface. | DW-6.1 requires "each data surface has a mobile and desktop encoding plus an accessible table alternative." Few (*Information Dashboard Design*, 2006): every specced panel must be present and verifiable before the dashboard is considered complete. | Add DS-SL-08 Streak tracker to data.html: horizontal bar chart (same `.hbar-*` pattern as DS-SL-16), `--neon-lime` fill (content creation/output per DESIGN.md), "Show as table" `<details>` with username \| longest streak \| current streak \| active columns. |
| **Minor** | design-dna | DESIGN.md §Chart data-colour rule table lists "Slap leaderboard" in **two contradictory rows**: (1) lime row ("Content creation / output: WA word counts, Slap heatmap, **Slap leaderboard**, Slap streaks") and (2) magenta row ("Primary single-series Slap chart: Slap timeline, **Slap leaderboard**"). The mock correctly uses gold for DS-SL-07 per the gold rule's definition ("ranked achievement count — who added the most tracks"), but the two stale references were not removed after the Revision 3 addendum changed DS-SL-07 from magenta to gold. This creates an inconsistent locked token contract. | DESIGN.md as the locked token contract must be internally consistent (design-dna: specification drift is a maintenance defect). | Remove "Slap leaderboard" from both the lime row and the magenta row in DESIGN.md §Chart data-colour rule table. The gold row definition ("any bar where the encoded value IS a rank-position or accumulated achievement") already covers DS-SL-07 without needing explicit mention. |
| **Minor** | design-dna | data.html CSS comment at line 1560 reads `"Slap hipster index (DS-SL-16) — gold bars, ranked achievement"` but the hipster bars correctly render `--neon-violet` (changed from gold in Revision 2 because `hipster_score` is a float, not a rank ordinal). The comment is a pre-Revision 2 artefact not cleaned up. | Code hygiene: stale comments create false expectations for anyone reading the implementation. | Change comment to `"Slap hipster index (DS-SL-16) — violet bars (ambient/analytical score, not a rank)"`. |
| **Note** | detector / design-dna | Detector `nested-cards` ×23: `.card-label` elements, chart toggle buttons, sort `<select>`, and sticky table headers (`th.col-frozen`) flagged as "card inside a card ancestor." These are intentional data panel structures: each `.card` is a glassmorphic chart panel; `.card-label` is a metadata header inside it; controls are within their chart's bounding region. This is standard dashboard anatomy (Few: chart panel = title region + chart region inside a container). No layout defect. | ai-tells.md: nested-cards. Register-justified (deliberate labeled-panel dashboard structure throughout). | No action required. Class name `card-label` could be renamed `chart-label` or `panel-label` in production code to avoid detector false-positives. |
| **Note** | detector / design-dna | Detector `purple-triplet`: `#8b5cf6` at line 1539 flagged as "AI-default accent." This value is the per-user API `color` field for user "moiz" in the mock Slap leaderboard data — confirmed against the live API (GET `/api/v1/dashboard/hipster` returns `{username:"moiz", color:"#8b5cf6"}`). The value is rendered only as a small decoration dot beside the member label, not as a bar fill. DESIGN.md §Chart data-colour rule explicitly governs this: "Per-user colours from the Slap API are decoration only — rendered as a small dot beside the member label, not as the chart bar fill." | ai-tells.md: purple-triplet. Register-justified (API data value, not a design choice; used as decoration only per locked rule). | No action on color. The mock faithfully replicates the live API response shape, and the rendering is correct. |
| **Note** | detector / content-design | Detector `numbered-section-markers` (advisory): sequence "03, 05, 07, 09, 10, 11" flagged as decorative numbering. These are DS-SL-* spec reference IDs in `.card-label` spans (e.g., "Leaderboard · DS-SL-07 (SL-07)"), not typographic heading counters. They appear only in this review mock's annotation layer. | ai-tells.md: numbered-section-markers. Register-justified (spec reference IDs in a design review mock). | No action. In production, spec IDs would be removed from visible UI labels. |
| **Note** | data-viz | DS-SL-04 (On Repeat IRL), DS-SL-05 (Throne), DS-SL-06 (Hot Right Now), DS-SL-15 (Achievements), DS-SL-17 (Personality cards), DS-SL-18 (Hall of Fame): all specced in JOURNEY.md §Data specs but not rendered in data.html. All six are non-chart display surfaces (lists, card grids, stat tiles). Per DW-6.1's "for the surfaces rendered in data.html" clause, they are out of scope for confirmation. They are a coverage gap in mock fidelity but not a DW failure. | DW-6.1 scope clause. | None for this review. A Phase 6 revision could add rendered previews of these display-only panels if full coverage is desired. |
| **Note** | content-design | Award card emoji glyphs (🗣️🦉🌅📹⚡👻💀🔥) and top-emoji section glyphs render as Unicode replacement boxes in the screenshots. Real Unicode characters are present in markup (lines 684–691, 1321–1324). | Headless Chromium capture artefact — headless browser lacks system emoji font. Review instructions: "treat emoji tofu as a capture artefact, not a defect, only if the markup contains real emoji characters." | No action on the mock. In production the app renders in a browser with emoji font support. |

## Requirement Fulfillment

### DW-6.1
PREMISE:  "each data surface has a mobile and desktop encoding plus an accessible table alternative. Check every DS-* spec in JOURNEY.md §Data specs; for the surfaces rendered in data.html, confirm all three exist in the mock at the right widths."

EVIDENCE (rendered surfaces — all three encodings confirmed):

**DS-HY (Hype meter):**
- Mobile (375): Hero numeral "137" in Orbitron 900 at `--text-4xl` (lime, level=fire), "ON FIRE / 150 max" label, 8px progress bar at 91.3% fill with threshold tick marks 0/15/40/80/120/150 visible. Scale is present. ✓
- Desktop (1440): Same layout wider — bar spans full card width, tick labels clearly legible. ✓
- Table alternative: `count`, `pct`, and `label` always-visible inline text (per DS-HY spec: "bar is redundant visual encoding only"). ✓

**DS-ST (Stat tiles):**
- Mobile (375): Three chips in compact strip — "24 Platinums" (gold), "571 Top Level" (gold), "ARC Raider Fav Game" (lime). ✓
- Desktop (1440): Three glass cards in a row. ✓
- Table alternative: numerals and labels always visible per DS-ST spec. ✓

**DS-WA-STATS (WhatsApp totals):**
- Mobile (375): Six stat tiles stacked — 12,847 / 8 / 847 / 234 / 156 / 89. ✓
- Desktop (1440): Six-up row. ✓
- Table alternative: numerals always visible. ✓

**DS-WA-AW (Awards):**
- Mobile (375): Award card grid (8 awards confirmed in data.html lines 684–691; Certified Yapper, Night Owl, Early Bird, Video King, Fastest Replier, Ghost of Month, Most 💀, Most 🔥). ✓
- Desktop (1440): 5-column grid (`.awards-grid { grid-template-columns:repeat(5,1fr) }` at ≥1024px). ✓
- Table alternative: all award data is always visible as text within the cards. ✓

**DS-WA-TL (Activity timeline):**
- Mobile (375): Vertical bar chart, cyan bars, date labels, "Show as table" `<details>` present. ✓
- Desktop (1440): Wider chart, all dates visible. ✓
- Table alternative: "Show as table" `<details>` (line 711). ✓

**DS-WA-HM (Hour×day heatmap):**
- Mobile (375): 7×24 grid, scrollable x-axis, cyan single-hue ramp, right-edge fade present for scroll hint, tap-to-inspect aria-labels on cells. ✓
- Desktop (1440): Full grid, no scroll, larger cells. ✓
- Table alternative: "Show as table" `<details>` (line 729). ✓

**DS-WA-MB (Member table):**
- Mobile (375): Individual member cards with Msgs/Words/Avg/msg/Videos chips, "Sort by" `<select>`, mobile "Show as table" `<details>` (line 757). Confirmed in screenshot — NightRacer7 (1542, 9.1k, 5.9, 67), BladeSync (892, 4.8k, 5.4, 15), AnonRacer (961, 3.2k, 3.3, 6) visible. ✓
- Desktop (1440): Sticky-thead sortable `<table>` (`#wa-member-desktop-table`) with `aria-sort` buttons, 10-column layout (per Revision 3 fix). ✓
- Table alternative: "Show as table" `<details>` on mobile + sortable table on desktop. ✓

**DS-WA-WC (Word counts):**
- Mobile (375): Horizontal bars, lime fill, word label left, count right. Visible words: game (892), clip (743), night (689)… ✓
- Desktop (1440): Same, wider. ✓
- Table alternative: "Show as table" `<details>` (line 807). ✓

**DS-WA-EM (Top emoji):**
- Mobile (375): Ranked list — position number, emoji glyph (tofu/capture artefact), cyan pct bar, count (1243, 987, 812…), percentage. Per-member section below. ✓
- Desktop (1440): Two-column layout (ranked list left, per-member grid right). ✓
- Table alternative: "Show as table" `<details>` (line 824). ✓

**DS-WA-RT (Response times):**
- Mobile (375): Vertical histogram (5 buckets, gold bars, on-bar count labels: 847, 634, 423, 187, 99 visible in screenshot), then member averages horizontal bars (MoizQ 2.3m → NightRacer7 14.3m, gold fills). ✓
- Desktop (1440): Two-column layout (Revision 3 fix). ✓
- Table alternative: "Show as table" `<details>` on each sub-chart (lines 850, 862). ✓

**DS-SL-01 (Slap stat tiles):**
- Mobile (375): Four tiles — 320 (Tracks Added), 7 (Contributors), Fred Again (Top Artist), 13 (This Week). ✓
- Desktop (1440): Single row. ✓
- Table alternative: always-visible numeral tiles. ✓

**DS-SL-TL (Slap timeline):**
- Mobile (375): Vertical bar chart, magenta bars, "Show as table" `<details>`. ✓
- Desktop (1440): Wider. ✓
- Table alternative: "Show as table" `<details>` (line 917). ✓

**DS-SL-PL (Slap platform breakdown):**
- Mobile (375): Horizontal bars — Spotify Finds (magenta, 65%), YouTube (cyan, 20%), Apple Music (gold, 10%), TikTok (lime, 5%). Platform label + percentage label = dual encoding. ✓
- Desktop (1440): Same, wider. ✓
- Table alternative: "Show as table" `<details>` (line 930). ✓

**DS-SL-HM (Slap submission heatmap):**
- Mobile (375): 7×24 grid, lime ramp, scrollable, "Tap to inspect" label, right-edge fade. ✓
- Desktop (1440): Full grid. ✓
- Table alternative: "Show as table" `<details>` (line 952). ✓

**DS-SL-07 (Leaderboard):**
- Mobile (375): Horizontal bars, gold fill, per-user color dot decoration visible (confirmed in screenshot: themoosecompany 223, nooramin40 40, asamad89 37…), value labels in gold. ✓
- Desktop (1440): Same, wider. ✓
- Table alternative: "Show as table" `<details>` (line 1013). ✓

**DS-SL-14 (Top artists):**
- Mobile (375): Horizontal bars, gold fill, artist + album label, count value. ✓
- Desktop (1440): Same, wider. ✓
- Table alternative: "Show as table" `<details>` (line 1026). ✓

**DS-SL-09 (Head-to-head):**
- Mobile (375): Split bars (magenta=themoosecompany, cyan=nooramin40), user pair dropdowns, Taste Compatibility tile (87%), AI vibe text, shared artists list. "Show as table" `<details>`. ✓
- Desktop (1440): Same, two-column. ✓
- Table alternative: "Show as table" `<details>` (line 1000). ✓

**DS-SL-16 (Hipster index):**
- Mobile (375): Horizontal bars, violet fill (correctly changed from gold in Revision 2), username + score. deception (1.00) → themoosecompany (1.52) ascending. ✓
- Desktop (1440): Same, wider. ✓
- Table alternative: "Show as table" `<details>` (line 1027). ✓

**DS-CL-MO (Clips month + montage summary):**
- Mobile (375): "23 Clips this month" gold numeral, "Build in 3d 4h" countdown, "Last Montage · v2: 18 clips · 3m 14s · ✓ Sent to WhatsApp" tile, clip manifest list (MoizQ 0:38 ✓ In, Gooper99 2:04 ✗ Too long, BladeSync 0:17 ✗ Too short, etc.). ✓
- Desktop (1440): Side-by-side stat tiles + manifest. ✓
- Table alternative: manifest IS the table (always-visible list); no chart requires a separate "Show as table." ✓

**GAP — DS-SL-08 (Streak tracker):**
- JOURNEY.md DS-SL-08 spec: horizontal bar chart, `--neon-lime` fill (Revision 3 uses lime for content/output), "Show as table" `<details>` with username | longest streak | current streak | active columns.
- Phase 6 discovery doc explicitly included SL-08: "Leaderboard (SL-07), streaks (SL-08), hipster (SL-16): ranked lists, table spec."
- Searched data.html for "streak", "SL-08", "DS-SL-08" — no matches. Surface not rendered.
- Evidence: ABSENT from rendered artifact.

VERDICT: **PARTIAL** — All 19 rendered DS-* surfaces confirm mobile + desktop + accessible table alternative. DS-SL-08 (Streak tracker chart) is specced and scoped but absent from data.html; no evidence for this surface.

---

### DW-6.2
PREMISE:  "chart colors pass AA non-text (≥3:1) against the card surface"

EVIDENCE:
- `node .design-foundations/build/dna-contrast.mjs` → exit 0, **131/131 gated pairs pass**.
- Section 6 (chart mark fills) results: neon-gold `#ffd24a` 9.92:1 on glass card PASS; neon-cyan `#22e6ff` (implicit, confirmed from `dna-contrast.mjs` Section 6 output for heatmap ramp α=1: 9.42:1) PASS; neon-lime `#8cff2b` 11.2:1 PASS; neon-magenta `#ff2fd6` 4.51:1 PASS; neon-violet `#9d5cff` 3.68:1 PASS; border-control gridline `#8d78c4` 3.82:1 PASS. All ≥3:1.
- Section 7 (heatmap ramp steps): cyan α=0.55: 3.78:1 PASS; cyan α=0.75: 5.86:1 PASS; cyan α=1: 9.42:1 PASS; lime α=0.5: 3.77:1 PASS; lime α=0.75: 6.83:1 PASS; lime α=1: 11.2:1 PASS. All ≥3:1.
- Adjacent ramp steps (INFO): 1.7:1 and 1.74:1 (cyan); 2.02:1 and 1.77:1 (lime). Below 3:1 against each other — mitigated by tap-to-inspect value labels on all cells (per DESIGN.md §Chart data-colour rule and DS-WA-HM / DS-SL-HM specs). ✓

VERDICT: **PASS** — All chart mark fills and heatmap ramp steps ≥3:1 against card surface. dna-contrast.mjs extended with Section 6 and Section 7 as required. Adjacent ramp step pairs are below 3:1 against each other, correctly mitigated by on-cell value labels.

---

**All requirements met:** NO (DW-6.1 PARTIAL — DS-SL-08 not rendered)

## Notes (non-blocking)

1. **Hype bar warm→gold semantic tension (not visible in demo state)**: DS-HY color mapping assigns `--neon-gold` to "warm" level (count 15–40). The DESIGN.md gold rule says "exclusively where the encoded value is a rank or achievement metric." Hype level "warm" is an activity magnitude, not a rank. This creates a latent tension between DS-HY spec and DESIGN.md §Chart data-colour rule. The demo state renders fire/lime, so this is not visible in the submitted screenshots. Recommend adding a note to DS-HY that the warm→gold mapping is a deliberate semantic choice ("warm threshold crossed = micro-achievement") to pre-empt future review questions.

2. **DS-SL-07 value labels in gold outside chart plot area**: The count values "223, 40, 37, 8, 6, 3, 3" at the right of the leaderboard bars render in gold text. The chart color rule says "outside chart plot areas: one job per colour, no exceptions." However, these labels encode RANK/ACHIEVEMENT values (track counts in a ranked leaderboard), so gold is correctly applied per the global "gold = rank/achievement everywhere" rule. Not a violation — noted for clarity.

3. **"Show as table" nesting inside `.card`**: All 12 chart cards with "Show as table" disclosures use the pattern `<div class="card"> ... <details class="show-table-disclosure"> ... </details></div>`. The summary and table content are inside the card boundary. This is correct pattern.

4. **Spot-check of 5 Slap endpoints against mock data shapes** (read-only GETs performed):
   - `/stats` → `{total_songs:320, total_contributors:7, top_artist:"Arijit Singh…", this_week_additions:13}` — mock uses same field names ✓
   - `/timeline` → `{entries:[{date:"YYYY-MM-DD", count:int}]}` — mock uses `{date, count}` ✓
   - `/genres` → `{genres:[{name, count, percentage}]}` — mock uses same structure, no `color` field in live data (mock adds categorical color assignment, which is the DS-SL-PL spec intent) ✓
   - `/leaderboard` → `{entries:[{rank, username, song_count, color, latest_addition}]}` — mock shape matches; per-user `color` rendered as decoration dot ✓
   - `/heatmap` → `{cells:[{day:0–6, hour:0–23, count:int}], max_count:int}` — mock uses `{day, hour, count}` ✓
   - Also checked: `/artists?limit=10` → `{artists:[{name, count, latest_album}]}` shape matches DS-SL-14 ✓; `/hipster` → `{entries:[{username, color, unique_artists, hipster_score}]}` shape matches DS-SL-16, and live data confirms `#8b5cf6` for user "moiz" (detector purple-triplet hit is API data) ✓

5. **Spot-check of 3 WhatsApp/hype specs against server.py / whatsapp_analytics.py handlers**: The review instructions specify checking handlers. The server.py path is at `/home/opti3/services/streamdeck/crcmz-app/server.py`. Handlers checked via file grep: DS-WA-EM endpoint at server.py:1786 (`GET /api/whatsapp/emojis` → `whatsapp_analytics.emojis()`), confirmed shape `{top_emoji[]{emoji,count,pct}, total_emoji, member_top_emoji}` matches DS-WA-EM mock data (lines 1317–1331). DS-WA-RT endpoint at `/api/whatsapp/response-times` — shape `{distribution[]{label,count}, member_avg_minutes[]{name,avg_minutes,count}, fastest_responder}` matches mock data. DS-HY at `GET /api/hype` — shape `{count, pct, label, level}` matches DS-HY spec.

## Issues (FAIL blockers)

1. **DS-SL-08 (Streak tracker) absent from data.html** — Major / data-viz / Few (*Information Dashboard Design*: all specced panels must be present and verifiable) / DW-6.1
   - The streak tracker horizontal bar chart is specced in JOURNEY.md §Data specs (DS-SL-08) and explicitly scoped in Phase 6 discovery ("streaks (SL-08): ranked lists, table spec"). It is not rendered in data.html.
   - Fix: Add DS-SL-08 section to the Slapshare block in data.html. Pattern mirrors DS-SL-16: horizontal bars using `--neon-lime` fill (content creation/output), username label, longest-streak + current-streak values, per-user color decoration dot, "Show as table" `<details>` with username | longest streak | current streak | active columns. Mock data can use the `/api/v1/dashboard/streaks` endpoint shape. No new tokens.

---

**Verdict: FAIL — 1 blocker.**

Blocker: DW-6.1 is not fully satisfied. DS-SL-08 (Streak tracker), a chart surface with mobile + desktop + "Show as table" specification in JOURNEY.md §Data specs and explicitly included in the Phase 6 discovery scope, is absent from data.html. No rendered evidence exists for this surface.

All other DW-6.1 surfaces (19 rendered) pass with complete evidence. DW-6.2 passes unconditionally (dna-contrast.mjs 131/131 PASS, all ≥3:1). The two minor DESIGN.md housekeeping issues (stale "Slap leaderboard" references in the color table, stale CSS comment) are non-blocking.
