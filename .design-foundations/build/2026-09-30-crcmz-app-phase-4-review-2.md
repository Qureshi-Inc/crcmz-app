# Design Review: Phase 4 — Component Sheet (Review 2)

**Date:** 2026-09-30
**Reviewer:** design-review-agent (dual-blind, independent)
**Artifact:** `.design-foundations/build/components.html`
**Contract:** DESIGN.md (locked §Tokens, §Components) · JOURNEY.md §Page specs

---

## Rendered Evidence (Step 0)

- Screenshots: `components-375.png` (750×16650), `components-375-fold.png` (750×1194), `components-1440.png` (2880×14836), `components-1440-fold.png` (2880×1200)
- Cropped sections reviewed: `crop-375-nav.png`, `crop-375-soundboard.png`, `crop-375-states.png`, `crop-375-presence.png`, `crop-375-overlays.png`, `crop-375-bottom.png`, `crop-1440-top.png`, `crop-1440-mid.png`, `crop-1440-bottom.png`
- Surface: full-width component catalogue at 375 (mobile) and 1440 (desktop); DPR 2
- Orbitron 800 font load confirmed: `document.fonts.check('800 20px Orbitron')` → `true`
- Playwright measurement run at 375 (67 interactive elements found)

---

## Assessment B — Deterministic Detector

- Command: `node /home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/detect.mjs .design-foundations/build/components.html > .design-foundations/build/detect.json`
- Exit: **0** (ran successfully)
- Findings: **85 total** — `nested-cards` × 84, `em-dash-overuse` × 1
- Opened only after Assessment A findings were frozen: **YES**

---

## Triage

- **Baseline (always-on):** visual + usability
- **Dispatched:** `design-systems` (token tier, component states, atomic design), `interaction` (interactive state completeness, focus, tap targets)
- **Not applicable:** `data-viz` (no charts), `content-design` (annotation copy only, no live product copy), `journey` (no multi-page flow), `behavioral` (no conversion surface)
- **Deferred:** none

---

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| **Major** | usability | `.sidebar-nav-row:hover` (line 318) is a bare hover rule not wrapped in `@media (hover: hover)`. On iOS the last-touched row retains the hover tint after release — the "sticky hover" bug. DESIGN.md §Responsive explicitly states: "Row hover inside `@media (hover: hover)` only: background tint… Never the only affordance." | DESIGN.md §Desktop sidebar (hover gating requirement); Nielsen #4 consistency — platform convention mismatch on touch | Wrap: `@media (hover: hover) { .sidebar-nav-row:hover { background: rgba(255,60,200,.07); } }` |
| **Major** | usability | Chat Board panel "Edit" button measures 39×28 px; "Organize" button measures 65×28 px (Playwright `getBoundingClientRect` at 375). Both are well below `--tap-min: 44px`. The stated scope requirement is "Tap targets must be ≥44px." | Fitts's law (1954): target acquisition cost is inversely proportional to size; WCAG 2.5.8 AA; `--tap-min: 44px` design token | Set `.panel-ctrl-btn { height: var(--tap-min); padding: 0 var(--space-3); align-items: center; }`. Current 28 px height puts both buttons into margin-of-error territory on mobile. |
| **Major** | usability | Chat Board panel Shared/Mine tab buttons measure 40 px height (Playwright at 375). Stated requirement: "Tap targets must be ≥44px." | WCAG 2.5.8; `--tap-min: 44px` token | Set `.panel-tab { min-height: var(--tap-min); }` — 4 px gap, low-effort fix. |
| **Minor** | usability | "Retry" button in the per-panel error strip renders at 55×32 px (Playwright). Below `--tap-min: 44px` height. Error recovery is a high-stakes interaction; a mis-tap is a friction at the worst moment. | Fitts's law (1954); interaction doctrine §CORE PRINCIPLES "full lifecycle of an interaction" | Apply standard button height: `height: var(--tap-min); display: inline-flex; align-items: center;` to all error-strip action buttons. |
| **Minor** | detector | **84 × `nested-cards`**: every component shown inside a section demo container triggers the rule. Evidence sample: `"<div class="tile c1"> is a card inside a card ancestor"` (line 1538); `"<div class="stat-tile"> is a card inside a card ancestor"` (line 1674). Register justification: this is a component-catalogue sheet; tiles appear inside the Chat Board panel demo, stat tiles inside a glass surface demo — both representing correct product placement, not a layout anti-pattern. The DESIGN.md "no nested cards" rule refers to product UI (glass card content inside glass card), not component contextual demos. Severity resolved to Minor for the few cases where the demo wrappers themselves have `--glass` fills stacked on each other (see Note below). | ai-tells.md `nested-cards` rule | In the production UI, honour the DESIGN.md rule: no `.glass` container inside another `.glass` container as content. For the spec sheet, consider using a neutral (`--sheet`) outer wrapper instead of a glass card to avoid triggering the rule in contextual demos. |
| **Minor** | detector | **`em-dash-overuse`**: 45 em-dashes counted in body copy. Evidence: `"45 em-dashes in body copy"`. Register justification: every em-dash appears in spec section labels ("TOP BAR STATES — REST (72 PX) AND CONDENSED (48 PX)"), not in product copy. None of these strings will render in the product. | ai-tells.md `em-dash-overuse` | No action required in product code. If the sheet is exported as documentation, replace em-dash separators in section headings with colons or line breaks. |
| **Note** | usability | "Watch Party ↩" call chip measures 132×38 px within the handle row. The handle row is the documented 40 px deviation (DESIGN.md: "WCAG 2.5.5(b) offset exception"). The chip is a separate interactive element at 38 px height — also below 44 px, relying on the same exception. Both are covered by the full-width exception; no user action blocks. | DESIGN.md documented deviation §Chat Board handle row; WCAG 2.5.5(b) | If the chrome budget allows, raise `--handle-h` to 44 px per DESIGN.md's own suggestion. |
| **Note** | design-systems | Lifecycle strip uses `overflow-x: auto` at mobile (line 963), so the 5 pills scroll horizontally. The static screenshot shows "Nominations closed" and later pills not visible at first render. No visual overflow cue (gradient fade, scroll indicator) reveals that content continues. | Nielsen #1 visibility of system status; Norman: affordance — missing signifier for a scrollable container | Add a `mask-image: linear-gradient(to right, #000 85%, transparent)` right-edge fade to the `.lifecycle-strip` as a scroll affordance. |
| **Note** | design-systems | Soundboard tile disabled and loading states are specified in CSS (`.tile[disabled]` and `.tile.loading`) but no labeled rendered specimen appears in the component sheet. All other required states (default, focus-visible, active/pressed, fire/sent, reduced-motion fire, custom slot) are represented. | design-systems doctrine (Frost, 2013): component state documentation should include visual specimens for each catalogued state, not only CSS declarations | Add two labeled `.tile` specimens: one at `opacity:.38; cursor:not-allowed` (disabled) and one with a spinner replacing the label (loading). |

---

## Requirement Fulfillment

### DW-4.1
PREMISE:  "all semantic aliases resolved (`--background`, `--surface`, `--text`, `--accent-solid`). Check all four, by name."
EVIDENCE: HTML lines 53–60 (grep confirmed):
- `--background: var(--bg)` → resolves to `#05030f` ✓
- `--surface: var(--glass)` → resolves to `rgba(18,10,38,.66)` ✓
- `--text: #f3ecff` defined at line 39 (global primitive); the DESIGN.md Phase 4 semantic tier defines `--text-primary: var(--text)` as the intent-mapped alias at line 57. The token named `--text` IS defined and used in the body rule (`color: var(--text-primary)` which chains to `--text`). The four names DW-4.1 specifies are all resolvable.
- `--accent-solid: var(--magenta-fill)` → resolves to `#ff2fd6` ✓
VERDICT: **PASS** (Note: the semantic alias layer uses `--text-primary` for intent-mapping; `--text` is the underlying global primitive. Both are defined and the chain resolves correctly.)

### DW-4.2
PREMISE:  "functional colors (`--error/success/warning/info-*`) defined; interactive elements pass AA non-text (≥3:1)"
EVIDENCE:
- `--error: #ff958d` (line 68), `--error-surface: #391614` ✓
- `--success: #71d176` (line 70), `--success-surface: #0e2910` ✓
- `--warning: #d6b267` (line 72), `--warning-surface: #2a210b` ✓
- `--info: #7bc0f0` (line 74), `--info-surface: #112432` ✓
- All 8 functional tokens (4 text + 4 surface) defined.
- Interactive element contrast: `--border-control #8d78c4` verified at ≥3.82:1 against glass (dna-contrast.mjs PASS row); focus ring `--neon-cyan` at ≥4.21:1 on bare aurora; tile neon edges ≥4.12:1 (per DESIGN.md contrast report, 113/113 pairs PASS). Toast error left-border uses `--error` at ≥6.76:1 on the sheet surface (DESIGN.md report). Components rendered in the sheet apply these tokens correctly: inputs use `--border-interactive`, call-chip uses `--border-interactive`, tiles use their neon edges.
VERDICT: **PASS**

### DW-scope: component presence
PREMISE: Scope list requires each named component is present and rendered.
EVIDENCE (per component):
- **Sidebar** ✓ — visible at 1440, MAIN group (Squad active, Watch, Clips) + TOOLS group (Huddle, Music, WhatsApp, Giveaway, Ask AI) + footer (Link PSN, Settings, Admin). Mascot 64 px, wordmark `--text-xl`, all rows 44 px (Playwright confirmed).
- **Bottom bar** ✓ — tab bar 56 px shown in 375-fold screenshot and demonstrated in section. Squad/Watch/Clips/More tabs, active Squad with 2 px magenta top edge.
- **More sheet** ✓ — demonstrated with scrim, handle knob, "MORE" header, 5 destination rows (Huddle/Music/WhatsApp/Giveaway/Ask AI), `role="dialog" aria-modal="true"`, note on focus trap and `inert`.
- **Chat Board panel + bottom sheet** ✓ — mobile sheet: 60 % open, scrim, handle knob, title, input + Send; desktop panel: expanded 360 px with Shared/Mine tabs, Edit/Organize, 2-col tile grid, composer; collapsed rail: 60 px with expand toggle.
- **Soundboard button (per neon colour; resting and fired states)** ✓ — c1 cyan (GG EZ), c2 magenta (SQUAD UP), c3 violet (Coach AI), c4 lime (LET'S GO — fired with SENT ✓ and fire glow visible), c5 gold (Gold Watch), plus `add` custom slot (dashed border, no fill, no glow). Resting glow visible on c1–c5, clearly weaker than c4 fire glow. All 5 colour classes rendered.
- **Presence row** ✓ — online (Acquarius, lime dot, game name in cyan), offline (Maximus, grey dot, last online), skeleton (shimmer row). Height 56 px per CSS.
- **Stat tile** ✓ — three tiles: "14 PLATINUMS" (gold numeral), "87 TOP LEVEL" (gold), "3 LIVE NOW" (lime). Orbitron 800 numerals, Rajdhani label, `--text-xs`. Both achievement and live colour roles demonstrated.
- **Clip card + player** ✓ — clip card: 16/9 thumb placeholder, "✓ Included" lime pill badge, sender/duration meta. Player: play/pause button (44 px), seek track with fill and thumb, drag-time readout always visible at thumb (confirmed non-hover per annotation), elapsed/total time. Loading, error, and 410-purged states all rendered.
- **Dialog** ✓ — "REMOVE TILE?" centred dialog: title, body, Cancel (secondary) + Remove (primary danger) buttons. Scrim behind.
- **Toast** ✓ — three variants: success (green left border, "Message sent to the squad."), error (red, "Send failed — may or may not have gone through."), info (blue, "PSN data refreshing in 30 s."). Each with dismiss × button.
- **State patterns** ✓ — skeleton row (shimmer/static), empty state (icon + "No clips this month yet" + "Upload Clip" CTA), per-panel error strip ("Failed to load squad data – retrying in 30 s.", `--error-surface` background, `--error` text), stale marker ("● Updated 4 min ago").
- **Call controls** ✓ — Watch Party bar: mic muted (struck icon), camera on, camera off, share (disabled, `aria-disabled`), leave (danger). Huddle bar: auto-muted icon, mic, leave (danger), plus "Muted by Huddle — you joined while someone was speaking" banner with `--error` border.
- **Mini-bar** ✓ — two call rows: "Watch Party · Alpha +2" with mute/Return/Leave; "Huddle · crcmz · 3" with Muted/Return/Leave. `role="region" aria-label="Active calls"`.
- **Sheet + scrim** ✓ — demonstrated in Chat Board mobile sheet and More sheet sections; `--scrim` overlay, top-corner radius `--radius-xl`.
- **Handle row with call chip** ✓ — "Chat 3" (icon + label + unread badge) on left; "Watch Party ↩" call chip on right. `aria-expanded="false" aria-controls="chat-sheet"`.
- **Send-state button (Sending / Sent / Not sent / Unknown / countdown)** ✓ — all 5 states rendered as labeled row: idle "Send ▶" (magenta fill), "□ Sending..." (dim, `pointer-events:none`), "✓ Sent" (lime), "✕ Not sent" (error colour + border), "? Unknown" (dim), "⏱ 5s" (gold countdown).
- **Stepper** ✓ — "Link PSN" (done/lime), "Verify" (done/lime), "Confirm" (active/magenta), "Done" (idle/dim). Connectors shown. `role="list"`.
- **Per-panel error** ✓ — error strip with `--error-surface` background, `--error` text, warning icon.
- **Stale marker** ✓ — `--warning` dot + "Updated 4 min ago" label at the correct semantic colour.
- **Sortable table** ✓ — desktop: `<thead>` with `<button aria-sort="ascending|none">` on Trophies and Level columns, active sort column in `--interactive-text` (cyan). Mobile: `<select class="sort-select">` "Sort by: Trophies ↑" shown, sort buttons hidden via `@media (max-width:1023px)`. Three data rows.
- **Lifecycle strip** ✓ — 5 steps: Created (done/lime), Nominations open (done/lime), Nominations closed (active/magenta), Draw (idle), Winner revealed (idle). `role="list" aria-label="Giveaway progress"`.
- **Top bar rest 72 px and condensed 48 px** ✓ — both states demonstrated with measurement annotations; mascot 64 px in rest and 40 px in condensed, both visible. Wordmark stays at `--text-lg`; tagline hides in condensed.
VERDICT: **PASS** (all 13 named component groups present and rendered)

### DW-scope: interactive states
PREMISE: "Every interactive component must specify default, focus-visible, active/pressed, disabled, loading/pending and error states where applicable."
EVIDENCE: CSS defines all required states for every interactive component class. Focus-visible states: 21 selectors verified (lines 239–1312), all using `box-shadow: var(--focus-ring); outline: none` — a valid replacement that meets ≥3:1 contrast per the dna-contrast.mjs report. Active/pressed: `.tile:active { transform: scale(.96) }` defined. Disabled: `.tile[disabled] { opacity:.38; cursor:not-allowed }`, `.send-btn[disabled]`, `.cc-btn.disabled` all defined. Loading: `.tile.loading` with spinner defined. Error: send-state `notsent`, clip player error, call auto-mute banner. Rendered demos show the primary states for each component; disabled/loading tile states are defined in CSS but not rendered as labeled specimens (Minor finding above, does not block).
VERDICT: **PARTIAL** — states are fully specified in CSS for all components; two tile states (disabled, loading) lack rendered demo specimens. This is a documentation gap in the spec sheet, not a missing specification.

### DW-scope: no information by hover alone
PREMISE: "No information may be carried by hover alone."
EVIDENCE: The sidebar hover rule at line 318 (`.sidebar-nav-row:hover { background: rgba(255,60,200,.07); }`) is not wrapped in `@media (hover: hover)`. This carries a visual affordance change on hover without the media query guard. While the background tint is decorative (not the only affordance), the DESIGN.md requirement is explicit. All other hover rules in the file appear inside `@media (hover: hover)` blocks.
VERDICT: **FAIL** — sidebar hover not media-query gated (violation of explicit DESIGN.md requirement).

### DW-scope: tap targets ≥44px
PREMISE: "Tap targets must be ≥44px."
EVIDENCE: Playwright `getBoundingClientRect` at 375 px viewport found 9 elements below 44 px on at least one dimension. Failing elements:
1. Handle row: 341×40 px — documented exception in DESIGN.md (WCAG 2.5.5(b), full-width)
2. Call chip within handle: 132×38 px — covered by same documented exception
3. Panel collapse toggle button: 32×32 px — explicitly allowed in DESIGN.md (≥32×32 for this button)
4. Panel collapse expand button: 32×32 px — same exception
5. Chat Board panel "Shared" tab: 180×40 px — **4 px below minimum, no documented exception**
6. Chat Board panel "Mine" tab: 180×40 px — **4 px below minimum, no documented exception**
7. "Edit" button: 39×28 px — **both dimensions failing, 16 px short in height**
8. "Organize" button: 65×28 px — **height failing, 16 px short**
9. "Retry" button in error strip: 55×32 px — **height failing, 12 px short**

Items 5–9 have no documented exception and violate the stated requirement.
VERDICT: **FAIL** — 5 interactive elements below `--tap-min: 44px` without documented exceptions (Edit 39×28, Organize 65×28, Shared tab 40 px, Mine tab 40 px, Retry 32 px height).

### DW-scope: glyphs and icons render
PREMISE: "Glyphs and icons must actually render (no empty boxes)."
EVIDENCE: All SVG icons in the tab bar, sidebar, mini-bar, and More sheet render correctly as stroked monochrome SVG (confirmed in screenshots). No empty boxes observed. The mascot `footer-avatar.png` renders at both 64 px (rest) and 40 px (condensed). Nav icons are inline SVG with `currentColor`, no external image dependencies.
VERDICT: **PASS**

### DW-scope: text wrapping
PREMISE: "Rendered text must not wrap or clip where the product would not."
EVIDENCE: All section headers, nav labels, button labels, toast text, presence names, and stat labels render without unwanted wrapping or clipping at 375 px and 1440 px. The wordmark "CRCMZ APP" has `white-space: nowrap` and fits correctly. The lifecycle strip uses `overflow-x: auto` allowing horizontal scroll for the 5 pills — pills are not clipped, only scrolled off-screen (scroll available per CSS). No text overflow clipping observed beyond intentional ellipsis on long names (`.presence-name` has `overflow: hidden; text-overflow: ellipsis`).
VERDICT: **PASS**

**All requirements met: NO**

---

## Notes (non-blocking)

1. **`--text-primary` vs `--text` naming:** DW-4.1 specifies `--text` as an alias by name; DESIGN.md Phase 4 semantic tier defines `--text-primary: var(--text)` as the intent alias. Both are present and the chain resolves correctly. If downstream code (Phase 5–6) consumes `--text` directly (not `--text-primary`), it will still get the correct value. No fix needed, but Phase 5 code planning should clarify which alias name is canonical for consumers.

2. **More sheet destinations vs DESIGN.md spec:** The rendered More sheet shows 5 rows (Huddle/Music/WhatsApp/Giveaway/Ask AI). The DESIGN.md §More sheet spec lists 7+ destinations (plus Coach, Settings, Admin). The component sheet demonstrates the component structure correctly; the full destination roster is a content concern for the production build, not the component specification.

3. **Lifecycle strip scroll affordance:** `overflow-x: auto` is implemented. No fade-out gradient or scroll indicator signals that more content exists off-screen. Addressable as polish.

4. **Tile disabled/loading states:** Fully specified in CSS; no rendered labeled specimens. Add these in a future component sheet revision.

5. **Detector `nested-cards` structural hits:** 84 hits are all register-justified as component-catalogue presentation structure. The DESIGN.md rule ("no nested cards" in production content layout) is not violated by the product's intended component placement. No production code action needed.

---

## Issues (FAIL)

1. **Sidebar hover not in `@media (hover: hover)`** — Major / usability / DESIGN.md §Desktop sidebar hover gating requirement / Wrap the hover rule.
2. **Edit button 39×28 px; Organize button 65×28 px** — Major / usability / `--tap-min: 44px`; Fitts's law (1954) / Set `.panel-ctrl-btn { height: var(--tap-min); padding: 0 var(--space-3); }`.
3. **Shared/Mine panel tabs at 40 px height** — Major / usability / `--tap-min: 44px`; WCAG 2.5.8 / Set `.panel-tab { min-height: var(--tap-min); }`.

---

**Verdict: FAIL**

Blockers:
- Sidebar hover rule missing `@media (hover: hover)` guard (explicit DESIGN.md requirement)
- Chat Board panel `Edit` (39×28 px) and `Organize` (65×28 px) buttons violate `--tap-min: 44px` with no documented exception
- Chat Board panel `Shared` and `Mine` tabs at 40 px height violate `--tap-min: 44px` with no documented exception

All other DW items pass. The three blockers are concentrated in the Chat Board desktop panel's control row and the sidebar hover CSS — two targeted fixes resolve all three.
