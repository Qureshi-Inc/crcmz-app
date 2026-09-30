# Design Review: Phase 4 — CRCMZ App Component Sheet

**Reviewer:** Design Review Agent (independent)
**Date:** 2026-09-30
**Artifact:** `.design-foundations/build/components.html` — static component reference sheet
**Contract:** `DESIGN.md` (locked Phase 3), `JOURNEY.md`

---

## Rendered Evidence (Step 0)

- Screenshots captured prior to the session: `components-375.png`, `components-375-fold.png`, `components-1440.png`, `components-1440-fold.png`
- Fold screenshots read as images; full-page scrolling PNGs inspected at both widths
- Fonts: Google Fonts link present for Orbitron 600/700/800/900 and Rajdhani 500/600/700. Web font check (`document.fonts.check("800 20px Orbitron")`) not run via Playwright (shell environment), but fold screenshots confirm Orbitron renders at display sizes in the fold view — wordmark and section headings render in the correct typeface.
- Surface: one-page component reference document, not a product screen

---

## Assessment B — Deterministic Detector

- Command: `node .../detect.mjs .design-foundations/build/components.html > detect.json`
- Exit: **0 (ran)**
- Findings: 51 total — `nested-cards` × 50, `em-dash-overuse` × 1
- Opened only after Assessment A findings were frozen: **YES**

---

## Triage

- **Baseline always-on:** visual + usability
- **Dispatched:** design-systems (component library audit, token tier); interaction (eight states, tap targets, focus management)
- **Not applicable:** data-viz (no charts); content-design (annotation copy is spec labels, not product microcopy); journey (single static doc, not a multi-step flow); behavioral (no conversion surface)
- **Deferred:** none — the surface is a component sheet, two pillars cover it completely

---

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| Critical | design-systems | **More sheet absent.** The requirement names "sidebar, bottom bar, More sheet" as required components. The tab bar's "More" item is present but no sheet specimen exists anywhere in the HTML. A component sheet that omits a required component gives no contract for the build phase. | Frost atomic design (2013): templates must enumerate every organism the build needs; a missing component is a hole in the contract | Add a `More sheet` section showing the sheet overlaying the tab bar, with its nav items (Tools group: Huddle, Music, WhatsApp, Giveaway, Ask AI, Settings, Admin), handle knob, and the scrim behind it |
| Critical | design-systems | **Chat Board desktop panel absent.** The requirement names "Chat Board panel + bottom sheet". The bottom sheet specimen is present (mobile). No right-panel specimen exists. The JOURNEY spec (CB-08) identifies the desktop panel as a collapsible right panel. Without the panel specimen the builder has no spec for its width, header, scroll behaviour, or collapse state. | Frost atomic design: organism-level component; Kholmatova functional pattern (2017) — the structural grid the system is built on | Add a desktop Chat Board panel specimen at `var(--panel-w)` = 360 px, showing the tile grid, composer row, Shared/Mine tabs, Edit/Organize controls, and the collapsed/expanded toggle state |
| Critical | design-systems | **Clip player absent.** Requirement: "clip card + player". Only the clip card thumbnail placeholder is rendered. No player controls are specified — no play/pause, no time display, no seek bar, no mute. CL-31 requires session-cookie clip playback; the player component is the UI contract for it. | Frost atomic design: the player is a molecule that the clip card organism wraps — omitting it breaks the composition chain | Add a player specimen inside or below the clip card: play/pause button (≥44 px), time elapsed/total (Rajdhani `--text-xs`), and seek track using `--border-interactive` for the track and `--accent-solid` for the thumb |
| Critical | design-systems | **Call controls absent.** Requirement: "call controls, mini-bar". The mini-bar is present. No call-controls specimen exists — no overlay control bar showing seek bar, play/pause, volume, mic toggle, camera toggle, leave button, reactions, sync, or fullscreen. WP-07 lists these as required capabilities; the component sheet must show the control bar layout and its button states (muted, camera-off, etc.). | Frost atomic design: separate organism from the mini-bar; the mini-bar is the persistent docked strip, the controls overlay is the in-call surface | Add a call-controls specimen showing the full overlay bar: media controls row + AV controls row, with muted/unmuted and camera-on/off toggle states marked |
| Major | usability | **`toast-close` tap target is 28×28 px.** `.toast-close { width: 28px; height: 28px; }` (line 819). Three dismiss buttons across all toast variants. The spec requirement is explicit: "Tap targets must be ≥44px." The dismiss button appears on mobile where finger precision is lowest. | WCAG 2.5.5 / interaction doctrine: touch target ≥44×44px; Nielsen #4 consistency: the spec sets `--tap-min: 44px` but doesn't apply it here | Raise `toast-close` to `min-width: 44px; min-height: 44px` using a negative-margin or padding trick to preserve visual size while enlarging the hit area |
| Major | usability | **`call-chip` tap target is 28 px.** `.call-chip { height: 28px; }` (line 601). The call-chip is a `role="button" tabindex="0"` element — an independently interactive control — inside the handle-row. At 28 px it falls well below the 44 px floor. | WCAG 2.5.5; interaction doctrine: every interactive element has a ≥44px tap target | Raise call-chip to `min-height: 44px` with vertical padding, or set `padding-block: 8px` inside the handle-row to give it the full 40 px row height plus the padding touch area |
| Major | usability | **`sort-btn` tap target is 28 px.** `.sort-btn { min-height: 28px; }` (line 930). Sort buttons only render at ≥1024 px where a mouse is assumed, but the spec states ≥44 px without device qualification. | Interaction doctrine: touch target ≥44px (WCAG 2.5.5); the sort control may appear on a touch-capable wide display | Raise `sort-btn` to `min-height: var(--tap-min)` and absorb the increase with `padding-block` inside the `<th>` |
| Major | interaction | **`send-btn` non-idle states lack `:focus-visible`.** Only `[data-send="idle"]:focus-visible` is defined (line 476). States `sent`, `notsent`, `unknown`, and `countdown` are keyboard-reachable interactive buttons that do not have a focus ring spec. The `sending` state is `disabled` (exempt). | Interaction doctrine §DESIGN REVIEW CRITERIA: all interactive elements must have visible focus indicators; `outline: none` without a replacement is a Critical flag — here the replacement exists for one state but not four others | Add `.send-btn:not([disabled]):focus-visible { box-shadow: var(--focus-ring); outline: none; }` — a single rule covering all enabled states |
| Major | interaction | **`handle-row` and `call-chip` lack `:focus-visible` styles.** Both are `role="button" tabindex="0"` elements (lines 1259, 1262). No focus ring is defined for either. Keyboard users pressing Tab reach them with no visual indicator. | Interaction doctrine §RED FLAGS: missing focus indicator is Critical; Nielsen #1 visibility of system status | Add `.handle-row:focus-visible { box-shadow: var(--focus-ring); outline: none; }` and `.call-chip:focus-visible { box-shadow: var(--focus-ring); outline: none; }` |
| Major | interaction | **`btn-primary` and `btn-secondary` lack `:active` / pressed state.** The tile has `.tile:active { transform: scale(.96); }` (line 405), showing the pattern is known. Dialog buttons (Cancel / Remove), empty-state CTA (Upload Clip), and every other `btn-primary`/`btn-secondary` render with no tactile pressed feedback. | Interaction doctrine: all 8 states required for primary interactive elements; active/pressed communicates "this is registering" to users who cannot distinguish hover from tap | Add `.btn-primary:active, .btn-secondary:active { transform: scale(.97); filter: brightness(0.92); transition: transform var(--dur-micro); }` — matching the tile's established pattern |
| Minor | usability | **`handle-row` height is 40 px.** `--handle-h: 40px` is a locked DESIGN.md token. The handle-row is a full-width touch target (compensating for reduced height), but 40 px is 4 px below the WCAG 2.5.5 floor. The rule exception in WCAG 2.5.5 allows for offsetting size if the inline dimension is large — which it is. | WCAG 2.5.5; the spec requirement says ≥44px. The locked token is the authoritative source; the deviation is intentional. | Record as a known deviation: the handle-row is full-width which provides an equivalent activation area per WCAG 2.5.5 (b) offset exception. Consider updating the spec note to cite this explicitly so the build doesn't silently add height. |
| Note | detector | **`nested-cards` × 50 (Assessment B).** Evidence: tiles, buttons, toasts, dialogs flagged as "card inside a card ancestor." Register-justified: the entire file is a component specimen, where `.section-card` is a demonstration wrapper, not a product UI card. Every component in a design sheet sits inside a wrapper by construction. The ai-tells rule targets product screens where cards nest inside cards (Impeccable); it does not apply to spec documents. | ai-tells.md: nested-cards rule — register-justified specimen context | No action needed in the spec file. Carry the rule into production code review once the product screens are built. |
| Note | detector | **`em-dash-overuse`: 27 em-dashes (Assessment B).** Evidence: em-dashes in annotation labels such as "rest state — 72 px · mascot 64 px". Register-justified: these are specification annotations, not product body copy. The em-dash serves as a divider between spec label and measurement, a conventional pattern in design documentation. | ai-tells.md: em-dash-overuse — register-justified spec annotations | No action in the spec file. Police em-dash use in product microcopy (Phases 5–6). |

---

## Requirement Fulfillment

### DW-4.1
PREMISE:  all semantic aliases resolved (`--background`, `--surface`, `--text`, `--accent-solid`). Check all four, by name.
EVIDENCE: `components.html` lines 53–60: `--background: var(--bg)` → `#05030f`; `--surface: var(--glass)` → `rgba(18,10,38,.66)`; `--text: #f3ecff` (line 39, brand primitive, resolves to a valid color); `--accent-solid: var(--magenta-fill)` → `#ff2fd6`. All four names are present in `:root` and resolve without dangling references. Component styles reference `--background`, `--surface`, `--accent-solid` directly; `--text` is consumed via `--text-primary: var(--text)` in the semantic alias tier.
VERDICT:  PASS

### DW-4.2
PREMISE:  functional colors (`--error/success/warning/info-*`) defined; interactive elements pass AA non-text (≥3:1)
EVIDENCE: All eight functional tokens defined at lines 68–75: `--error: #ff958d`, `--error-surface: #391614`, `--success: #71d176`, `--success-surface: #0e2910`, `--warning: #d6b267`, `--warning-surface: #2a210b`, `--info: #7bc0f0`, `--info-surface: #112432`. Contrast checks (computed via `dna-contrast.mjs` + manual ratio calculation): `--border-interactive: #8d78c4` vs glass composite `#0e081e` = **5.24:1** (≥3:1 PASS); vs sheet composite `#0b081b` = **5.27:1** (PASS); focus-ring cyan `#22e6ff` vs bg `#05030f` = **13.48:1** (PASS). Functional color text roles (`gen-error-11`, etc.) all confirmed PASS at ≥4.5:1 by `dna-contrast.mjs` output.
VERDICT:  PASS

### Component scope — sidebar
PREMISE:  sidebar present and rendered
EVIDENCE: 1440-fold screenshot shows the desktop sidebar with mascot, "CRCMZ" wordmark, Main / Tools nav groups, mini-bar slot (Watch Party row active), Link PSN / Settings / Admin footer rows. Active item (Squad) shows magenta left-border.
VERDICT:  PASS

### Component scope — bottom bar
PREMISE:  bottom bar present and rendered
EVIDENCE: 375-fold screenshot shows the bottom tab bar at the viewport foot: Squad (active, magenta), Watch, Clips, More — all with SVG icons and labels. Tab bar is hidden at ≥1024 px per `@media (min-width: 1024px) { .tabbar { display: none; } }`.
VERDICT:  PASS

### Component scope — More sheet
PREMISE:  More sheet present and rendered
EVIDENCE: The "More" tab item is present in the tab bar specimen but no "More sheet" component is shown anywhere in the HTML. No `more-sheet` class, no sheet demo with secondary navigation items, no scrim-behind-sheet specimen for this surface. Searched all section headers; section list ends at Lifecycle Strip.
VERDICT:  FAIL

### Component scope — Chat Board panel + bottom sheet
PREMISE:  Chat Board panel + bottom sheet present and rendered
EVIDENCE: Bottom sheet specimen present at lines 1228–1252 (mobile sheet, 60% height, scrim, inert background, sheet-input + sheet-send with focus ring). Desktop Chat Board panel: not found. No right-panel specimen exists for the 360 px desktop panel (CB-08).
VERDICT:  PARTIAL — bottom sheet PASS; desktop panel FAIL

### Component scope — soundboard button per neon colour; resting and fired states
PREMISE:  soundboard buttons for each of the 5 neon colours, resting and fired states
EVIDENCE: Lines 1181–1203: c1 (cyan, resting glow), c2 (magenta, resting), c3 (violet, resting), c4 (lime, `.fired` state showing "Sent ✓" text and `--glow-tile-fire`), c5 (gold, resting). Plus add-tile (no glow). All 5 colour classes and the resting vs fired distinction are shown. Screenshots confirm the rendering.
VERDICT:  PASS

### Component scope — presence row, stat tile, clip card + player
PREMISE:  presence row, stat tile, clip card + player each present and rendered
EVIDENCE: Presence rows: lines 1276–1311, three rows — online (lime dot, game, platform badge), offline (dimmed, border-interactive dot, last game), skeleton (skel-circle + skel-lines). Stat tiles: three tiles with Orbitron 800 numerals (14 / 87 / 3). Clip card: present with thumbnail placeholder, included badge, sender, duration. Player: not present — no play/pause button, no seek track, no time display, no player controls in any section.
VERDICT:  PARTIAL — presence, stat tile, clip card PASS; player FAIL

### Component scope — dialog, toast, state patterns
PREMISE:  dialog, toast, and state patterns present and rendered
EVIDENCE: Dialog: centred overlay with scrim (dark backdrop), `role="dialog" aria-modal="true" aria-labelledby`, title, body, Cancel + Remove buttons. Toast stack: success (lime border-left), error (red border-left), info (blue border-left), each with icon, message, and dismiss button. State patterns: skeleton row, empty state (icon + message + CTA), per-panel error strip (warning + message), stale marker (dot + timestamp). All present.
VERDICT:  PASS

### Component scope — call controls, mini-bar
PREMISE:  call controls and mini-bar present and rendered
EVIDENCE: Mini-bar: two rows (Watch Party + Huddle), each with room label, mute button, ↩ Return, ✕ Leave. Muted state shown on Huddle row (`aria-pressed="true"`, strikethrough-mic icon). Also present in sidebar. Call controls: not found — no specimen for the Watch Party overlay control bar (seek bar, play/pause, AV controls row, reactions, sync, fullscreen) anywhere in the HTML.
VERDICT:  PARTIAL — mini-bar PASS; call controls FAIL

### Component scope — sheet + scrim, handle row with call chip
PREMISE:  sheet + scrim and handle row with call chip present and rendered
EVIDENCE: Sheet + scrim: lines 1228–1252, sheet-demo with `sheet-scrim` (dark overlay annotated "← scrim (--scrim)") and `sheet-panel` (rounded corners, handle knob, composer). Handle row: lines 1255–1267, 40 px row with chat label + count badge and call-chip (`role="button" tabindex="0"` with Watch Party icon and label). Both present.
VERDICT:  PASS

### Component scope — send-state button (Sending / Sent / Not sent / Unknown / countdown)
PREMISE:  send-state button in all 5 states present and rendered
EVIDENCE: Lines 1215–1220: idle (magenta fill, ink label, focus-visible), sending (disabled, `aria-busy="true"`, dimmed), sent (lime border + text), not-sent (error border + text, `aria-live="polite"`), unknown (dimmed), countdown (gold border + text, `aria-label="Cooldown 5 seconds"`). All 6 variants present (idle is the default; the requirement lists 5 named states beyond idle). Screenshot confirms rendering.
VERDICT:  PASS

### Component scope — stepper
PREMISE:  stepper present and rendered
EVIDENCE: Lines 1476–1496: four-step stepper with `role="list"`, step items carrying `data-state` (done/done/active/idle), `aria-current="step"` on the active item. Done steps show ✓ tick; active step has magenta-filled number; idle step has border-interactive number. Step lines between items.
VERDICT:  PASS

### Component scope — per-panel error
PREMISE:  per-panel error present and rendered
EVIDENCE: Lines 1425–1432: `.error-strip` with warning icon + "Failed to load squad data — retrying in 30 s." text using `--error` colour and `--error-surface` background.
VERDICT:  PASS

### Component scope — stale marker
PREMISE:  stale marker present and rendered
EVIDENCE: Lines 1433–1439: `.stale-marker` with `.stale-dot` (amber/gold dot, `aria-hidden="true"`) and "Updated 4 min ago" text.
VERDICT:  PASS

### Component scope — sortable table with mobile Sort-by fallback
PREMISE:  sortable table with a mobile Sort-by fallback present and rendered
EVIDENCE: Lines 1500–1554: table with `sort-btn` in column headers (`aria-sort="none"` / `aria-sort="ascending"`), ascending column highlighted in `--interactive-text`. Mobile sort-select row: `<label for="sort-by">Sort by</label>` + `<select id="sort-by">` with three options, hidden at ≥1024 px per `@media (min-width: 1024px) { .sort-select-row { display: none; } }`. Both mechanisms rendered.
VERDICT:  PASS

### Component scope — lifecycle strip
PREMISE:  lifecycle strip present and rendered
EVIDENCE: Lines 1559–1575: five-step giveaway lifecycle with `role="list"`, done/done/active/idle/idle states, connectors between steps, `aria-current="step"` on active step. Screenshot confirms colour-coded rendering (lime done, magenta active, dim idle).
VERDICT:  PASS

### Component scope — top bar (rest 72 px and condensed 48 px on scroll, mascot visible in both)
PREMISE:  top bar shown in rest (72 px) and condensed (48 px) states, mascot visible in both
EVIDENCE: Lines 1106–1141: rest state `height: 72px`, mascot `width="64" height="64"` (`object-fit: contain`), tagline visible. Condensed state `height: 48px`, mascot sized via `var(--brand-mark-condensed)` = 40 px, tagline hidden. Both states annotated below. Transition note specifies `var(--dur-std) var(--ease-out)`, CSS scroll-driven with IntersectionObserver fallback, reduced-motion instant switch, and content `padding-top: 72px` (no CLS). Fold screenshots at both widths confirm mascot renders in both states.
VERDICT:  PASS

### Component scope — interactive states (default, focus-visible, active/pressed, disabled, loading/pending, error)
PREMISE:  every interactive component must specify default, focus-visible, active/pressed, disabled, loading/pending, and error states where applicable; no information carried by hover alone
EVIDENCE: Tiles: default + resting-glow ✓, focus-visible ✓, active (`.tile:active { transform: scale(.96) }`) ✓, fired state ✓. Tabs: default + active ✓, focus-visible ✓. Sidebar nav: default + active ✓, focus-visible ✓. `btn-primary`/`btn-secondary`: default ✓, focus-visible ✓; `:active` state: not defined. Send-btn: idle/sending/sent/notsent/unknown/countdown ✓; focus-visible for idle only ✓; focus-visible for sent/notsent/unknown/countdown: missing. `handle-row`: default ✓; focus-visible: not defined. `call-chip`: default ✓; focus-visible: not defined. Hover: sidebar nav hover gated with `@media (hover: hover)` — no information carried by hover alone ✓.
VERDICT:  PARTIAL — most components pass; btn-primary/btn-secondary missing :active; send-btn non-idle states, handle-row, call-chip missing :focus-visible → per the requirement this is a FAIL on the stated criterion

### Component scope — tap targets ≥44 px
PREMISE:  tap targets must be ≥44 px
EVIDENCE: `--tap-min: 44px` applied to: topbar-avatar-btn (44 px) ✓, tab items (56 px) ✓, sidebar-nav-row (44 px) ✓, tiles (64 px) ✓, btn-primary/btn-secondary (44 px) ✓, sheet-send (44 px) ✓, sort-select (44 px) ✓, minibar-btn (44 px) ✓, presence-row (56 px) ✓. Violations: `toast-close` = 28×28 px (line 820); `call-chip` = 28 px height (line 601); `sort-btn` = 28 px min-height (line 930).
VERDICT:  PARTIAL — majority PASS; toast-close, call-chip, sort-btn FAIL

### Component scope — no text wrapping or clipping
PREMISE:  rendered text must not wrap or clip where the product would not
EVIDENCE: Screenshots at both widths show spec annotation text wrapping within `.section-card` containers — expected for annotation prose. Product-style components (nav labels, tile labels, toast messages, stat numerals) fit without clipping at both 375 px and 1440 px. No truncation artefacts visible.
VERDICT:  PASS

### Component scope — glyphs and icons render
PREMISE:  glyphs and icons must actually render (no empty boxes)
EVIDENCE: All icons are inline SVG (not font glyphs); they render reliably regardless of font loading. Screenshots confirm icons visible in top bar, sidebar, tab bar, tiles, dialog, and minibar. Footer-avatar.png mascot renders in both top bar states and the sidebar.
VERDICT:  PASS

**All requirements met: NO**

---

## Notes (non-blocking)

- **Pixel-evidence coverage:** Full-page screenshots were available at both 375 and 1440 px. Playwright font-check was not run (no browser MCP in this session). Font rendering is confirmed visually from fold screenshots — Orbitron and Rajdhani are visibly present. This is a coverage note, not a finding.
- **`nested-cards` detector hits (50 instances):** All trace to `.section-card` demo wrappers containing child components. This is the standard component-sheet structure (specimen wrapper → component under test). Not a product screen defect; carry the rule into production code review.
- **`em-dash-overuse` (27 instances):** All in spec annotation labels (e.g., "rest state — 72 px"). Appropriate for documentation; not product copy.
- **`handle-row` at 40 px:** Token is locked (`--handle-h: 40px`). Full-width compensates for reduced height (WCAG 2.5.5 (b) offset exception). Recommend a spec note citing the exception explicitly.
- **Aurora and scanline grid:** Not present in the component sheet's CSS (expected — the sheet uses `--bg` as page background without the full aurora/grid reference implementation). This is intentional for a component reference doc.

---

## Issues (FAIL blockers)

1. **More sheet absent** — Critical / design-systems / Frost atomic design: missing component / Add More sheet section
2. **Chat Board desktop panel absent** — Critical / design-systems / Frost atomic design: missing organism / Add 360 px panel specimen
3. **Clip player absent** — Critical / design-systems / Frost atomic: missing molecule composition / Add player controls specimen
4. **Call controls absent** — Critical / design-systems / Frost atomic: missing organism / Add call-controls overlay bar specimen
5. **`toast-close` tap target 28 px** — Major / usability / WCAG 2.5.5 / Raise to 44 px minimum
6. **`call-chip` tap target 28 px** — Major / usability / WCAG 2.5.5 / Raise to 44 px minimum
7. **`sort-btn` tap target 28 px** — Major / usability / WCAG 2.5.5 / Raise to 44 px minimum
8. **`send-btn` non-idle states missing `:focus-visible`** — Major / interaction / interaction doctrine §RED FLAGS / Add unified `.send-btn:not([disabled]):focus-visible` rule
9. **`handle-row` and `call-chip` missing `:focus-visible`** — Major / interaction / interaction doctrine / Add focus-visible for both
10. **`btn-primary`/`btn-secondary` missing `:active` state** — Major / interaction / interaction doctrine: 8 states / Add `:active` transform matching the tile pattern

---

**Verdict: FAIL**

Blockers: four missing required components (More sheet, Chat Board desktop panel, clip player, call controls); three tap-target violations below 44 px (toast-close, call-chip, sort-btn); three missing focus-visible specifications (send-btn non-idle, handle-row, call-chip); missing `:active` state on primary and secondary buttons.
