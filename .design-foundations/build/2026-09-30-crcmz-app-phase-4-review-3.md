# Design Review: Phase 4 — Component Sheet (Review 3)

**Date:** 2026-09-30
**Reviewer:** Design Review Agent (independent; did not produce this artifact)
**Artifact:** `.design-foundations/build/components.html`
**Widths reviewed:** 375 px (mobile) and 1440 px (desktop)

---

## Rendered Evidence (Step 0)

- Screenshots: `components-375.png`, `components-375-fold.png`, `components-1440.png`, `components-1440-fold.png` — all read. PIL-cropped into 7 sections for close pixel inspection.
- Rendered live via Playwright-Core (Chromium; viewport 375 × 800 then 1440 × 900). Web fonts confirmed loaded **after `document.fonts.ready` + 2 s settle**: Orbitron 700 ✓, Orbitron 800 ✓, Rajdhani 500 ✓, Rajdhani 600 ✓, Rajdhani 700 ✓. First check (before settle) returned false — a timing artefact, not a load failure.
- Contrast: `dna-contrast.mjs` re-run → 113/113 PASS (exit 0).

---

## Assessment B — Deterministic Detector

- Command: `node /home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/detect.mjs .design-foundations/build/components.html > .design-foundations/build/detect-phase4-review3.json`
- Exit: **0 (ran)**
- Findings: **89 total** — `nested-cards` × 88, `em-dash-overuse` × 1
- Opened only after Assessment A findings were frozen: **YES**

---

## Triage

- **Baseline (always-on):** visual + usability
- **Dispatched:** design-systems (token tier, component coverage); interaction (8-state model, focus, hover, tap targets)
- **Not applicable:** data-viz (no charts in the component sheet), content-design (no real product copy — all annotation), behavioral (no conversion surface), journey (not a page flow)
- **Deferred:** none (surface is tightly scoped)

---

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| Minor | design-systems | `--border-control` is absent from the component sheet's `:root` block. The alias `--border-interactive` is set directly to `#8d78c4` instead of through `var(--border-control)`. If the global token is ever overridden, the alias will not follow. Computed value of `--border-control` is empty string. | W3C DTCG tier model (stable Oct 2025): alias tier must reference the global tier, not embed the primitive value directly. | Add `--border-control: #8d78c4;` to `:root` and change `--border-interactive` to `var(--border-control)` to close the chain. |
| Minor | interaction | Double-nested hover guard at sidebar rule: `@media (hover: hover) { @media (hover: hover) { .sidebar-nav-row:hover { … } } }`. Redundant, and some parsers may evaluate the outer block twice under some polyfills. | interaction.md: hover styles gated to `@media (hover: hover)` — one level, not nested. | Collapse to a single `@media (hover: hover) { .sidebar-nav-row:hover { … } }`. |
| Note | design-systems | `--text-4xl` (Orbitron 900, 42 → 56 px) is declared in the token block but no element in the component sheet exercises it. Orbitron 900 is loaded in the Google Fonts request but was not observed in the loaded fonts list (browser only loads faces that are actually used). The type scale is incomplete for a documentation reader. | Design-systems doctrine (Frost, 2013): component tiers are complete when every token can be traced to a visible example. | Add a brief `--text-4xl` specimen row in the type section, similar to `--text-3xl`, so the scale is demonstrable. Not a production-blocking issue. |
| Note | detector / design-systems | Assessment B: `nested-cards` rule fired 88 times. All hits are demo-frame artefacts: every component (tile, stat-tile, clip-card, dialog, toast, minibar-btn, etc.) sits inside a `<section class="component-section">` or similar demo wrapper. The rule treats both the wrapper and the component as "cards." In the product, these components will appear on the page background, the sheet surface, or the chrome — not inside nested glass boxes. No production-layout nesting is present. DESIGN.md explicitly prohibits nested cards in the product. Register: component specification sheet. Severity → Note. |  ai-tells.md: nested-cards. Register-justified (demo layer). | No action on the component sheet. Enforce the "no nested cards" rule during implementation review. |
| Note | detector / copy | Assessment B: `em-dash-overuse` (46 em-dashes). All instances are section-label separators in technical annotations — e.g., "rest state — 72 px · mascot 64 px". This is specification notation, not marketing copy. Register: specification documentation. | ai-tells.md: em-dash-overuse. Register-justified for technical spec copy. | No action required. Watch for em-dash overuse when Phase 5 writes user-facing microcopy. |

---

## Requirement Fulfillment

### DW-4.1

```
PREMISE:  all semantic aliases resolved (--background, --surface, --text, --accent-solid).
          Check all four, by name.
EVIDENCE: Playwright getComputedStyle on <html data-theme="dark">:
            --background  → #05030f           (resolves to --bg)
            --surface     → rgba(18, 10, 38, .66)  (resolves to --glass)
            --text        → #f3ecff           (direct definition)
            --accent-solid→ #ff2fd6           (resolves to --magenta-fill)
          All four return non-empty concrete values. The html element carries
          data-theme="dark" as required for the generated palette tier.
VERDICT:  PASS
```

### DW-4.2

```
PREMISE:  functional colors (--error/success/warning/info-*) defined; interactive
          elements pass AA non-text (≥3:1)
EVIDENCE: Playwright getComputedStyle:
            --error          → #ff958d   (var(--gen-error-11))
            --error-surface  → #391614   (var(--gen-error-3))
            --success        → #71d176   (var(--gen-success-11))
            --success-surface→ #0e2910   (var(--gen-success-3))
            --warning        → #d6b267   (var(--gen-warning-11))
            --warning-surface→ #2a210b   (var(--gen-warning-3))
            --info           → #7bc0f0   (var(--gen-info-11))
            --info-surface   → #112432   (var(--gen-info-3))
          All eight functional tokens resolve to concrete values.
          Interactive element boundaries: --border-interactive (#8d78c4)
          measures 3.82:1 on glass (worst-stacked); 5.19:1 on input fill.
          --focus-ring (2 px #22e6ff) measures 4.21:1 on bare aurora.
          dna-contrast.mjs: 113/113 gated pairs PASS (exit 0).
VERDICT:  PASS
```

### Scope — Component Sheet Coverage

```
PREMISE:  All named components must be present and rendered.
EVIDENCE: Pixel review + Playwright DOM queries at 375 px and 1440 px:

  sidebar                      PRESENT — 1440 view: 240 px fixed left, brand row +
                                         main nav + footer group + mini-bar slot ✓
  bottom bar (tab bar)         PRESENT — 56 px chrome, Squad/Watch/Clips/More,
                                         active-magenta top edge on Squad ✓
  More sheet                   PRESENT — .more-sheet-panel with handle knob,
                                         "MORE" heading, destination rows ✓
  Chat Board panel (desktop)   PRESENT — .panel-demo shows expanded (360 px) and
                                         collapsed (60 px rail) states ✓
  Chat Board bottom sheet      PRESENT — 60 % sheet shown with scrim, handle knob,
                                         "CHAT BOARD" heading, composer ✓
  soundboard button            PRESENT — c1 (cyan), c2 (magenta), c3 (violet),
  (per neon colour)                      c4 (lime), c5 (gold) all rendered; each shows
                                         distinct hue edge, tinted fill gradient ✓
  resting glow                 PRESENT — soft glow at --glow-tile-rest visible on
                                         all five tiles ✓
  fired state                  PRESENT — .tile.c4.fired shows SENT ✓ label,
                                         fire-glow box-shadow ✓
  disabled state               PRESENT — opacity .38, "disabled" sub-label ✓
  loading state                PRESENT — spinner replaces label, aria-busy noted ✓
  presence row                 PRESENT — online (lime dot) + offline (muted dot) +
                                         skeleton row ✓
  stat tile                    PRESENT — three tiles: 14 PLATINUMS (--text-3xl gold),
                                         87 TOP LEVEL, 3 LIVE NOW (lime) ✓
  clip card + player           PRESENT — clip-card with 16:9 thumb, "Included" badge;
                                         player with play/pause, seek track,
                                         elapsed/total, drag-time tip ✓
  clip player states           PRESENT — loading (Buffering…), error (Playback
                                         failed — try again + Retry), 410-purged
                                         (Clip has been purged) ✓
  dialog                       PRESENT — "REMOVE TILE?" centred overlay, scrim,
                                         Cancel + Remove buttons, role=dialog noted ✓
  toast variants               PRESENT — success (lime), error (red), info (blue)
                                         all rendered with left-border accent ✓
  state patterns               PRESENT — skeleton row with shimmer placeholder,
                                         empty state with icon + copy + CTA,
                                         per-panel error strip (amber on dark),
                                         stale marker "Updated 4 min ago" ✓
  call controls                PRESENT — Watch Party toolbar: mic on/off, camera
                                         on/off, share (desktop), Leave (danger) ✓;
                                         Huddle toolbar: auto-muted-by-Huddle banner +
                                         muted-error mic button + Leave ✓
  call mini-bar                PRESENT — two rows: Watch row (Watch… mic Return Leave)
                                         + Huddle row (H Muted Return Leave) ✓
  sheet + scrim                PRESENT — Chat Board sheet shown with scrim label and
                                         inert background annotation ✓
  handle row with call chip    PRESENT — .handle-row "Chat 3" left + "Watch Party ←"
                                         call chip right ✓
  send-state button            PRESENT — all 5 states rendered: Send ▶ (idle, magenta
  (all 5 states)                         fill), ⏳ Sending… (disabled), ✓ Sent
                                         (lime), ✗ Not sent (red border), ? Unknown
                                         (muted); ⌛ 5s countdown (gold) ✓
  stepper                      PRESENT — 4-step: ✓ Link PSN, ✓ Verify, ③ Confirm
                                         (active-magenta), Activate (idle) ✓
  per-panel error              PRESENT — .error-strip "Failed to load squad data —
                                         retrying in 30 s." on amber surface ✓
  stale marker                 PRESENT — "● Updated 4 min ago" in warning colour ✓
  sortable table               PRESENT — desktop: 3 cols with sort-btn + aria-sort
  (with mobile Sort-by)                  attributes; mobile: "Sort by" <label> +
                                         <select> above the table; sort-btn hidden
                                         @media (max-width: 1023px) ✓
  lifecycle strip              PRESENT — 5 pills: Created (idle), Nominations open
                                         (active-magenta), Nominations closed
                                         (active-magenta), Draw (idle), Winner
                                         revealed (idle) — scrollable at 375 px ✓
  top bar — rest 72 px         PRESENT — mascot 64 px, wordmark at --text-lg,
                                         tagline "YES. WE HAVE ONE." visible ✓
  top bar — condensed 48 px    PRESENT — mascot 40 px (still visible), tagline
                                         hidden; both states shown as static specimens
                                         with transition annotation ✓

VERDICT:  PASS
```

### Scope — Interactive State Coverage

```
PREMISE:  Every interactive component must specify default, focus-visible,
          active/pressed, disabled, loading/pending and error states where
          applicable. No information carried by hover alone; hover styles gated
          to hover-capable devices. Tap targets ≥ 44 px. Text must not wrap
          or clip. Glyphs must render (no empty boxes).
EVIDENCE:
  Focus-visible: every interactive element has
    :focus-visible { box-shadow: var(--focus-ring); outline: none; }
    confirmed for topbar-avatar-btn, tab-item, sidebar-nav-row, .tile, send-btn,
    sheet-send, minibar-btn, call-chip, handle-row, btn-primary, btn-secondary,
    toast-close, sort-btn, more-sheet-row, panel-toggle-btn, panel-tab,
    panel-ctrl-btn, panel-send, play-btn, cc-btn — all 20 interactive classes ✓
  Active/pressed: .tile:active { transform: scale(.96) };
    .btn-primary:active { transform: scale(.97) };
    .btn-secondary:active { transform: scale(.97) };
    .play-btn:active { transform: scale(.95) } ✓
  Disabled: tiles at opacity .38 + aria-disabled="true"; buttons at opacity .38;
    play-btn error/purged states disable the control ✓
  Loading: spinner replaces tile label; aria-busy="true" on player ✓
  Error: per-panel strip, toast, player-error state, send-state "Not sent" ✓
  Hover: only ONE hover rule in the entire file (.sidebar-nav-row hover tint),
    correctly gated inside @media (hover: hover). No information is carried by
    hover alone anywhere. ✓
  Tap targets: Playwright getBoundingClientRect over all buttons, tabs, inputs,
    tiles, nav rows, minibar-btns, call-chips → ZERO elements under 44 × 44 px ✓
  Text wrapping: pixel review at 375 px shows no text overflowing its container.
    Longest labels ("YES. WE HAVE ONE.", "CHAT BOARD", presence names) all fit ✓
  Glyphs: all nav icons render as inline SVG strokes (no empty boxes). Emoji
    used only in demo annotations and presence row copy (user content context),
    not in chrome ✓
VERDICT:  PASS
```

**All requirements met: YES**

---

## Notes (non-blocking)

1. **`--border-control` chain gap (Minor finding above).** Functional value is correct; only the tier linkage is broken. Does not affect any rendered pixel or computed contrast ratio.

2. **`--text-4xl` / Orbitron 900 unexercised.** The `--text-4xl` token is in the `:root` block and the Google Fonts request includes weight 900, but no element in the component sheet renders at Orbitron 900. This is a type-scale documentation gap, not a product defect. Add a specimen if the sheet is used as the canonical type reference.

3. **Condensed top bar as static specimen.** Both the rest and condensed states are shown as side-by-side static mockups inside a demo card. This is appropriate for a component sheet and clearly labelled. The CSS for the animated transition is present (scroll-driven or IntersectionObserver fallback). The static presentation is sufficient for review purposes.

4. **Lifecycle strip scrolls at 375 px.** The 5-pill strip overflows its container width at 375 px and is horizontally scrollable. This is consistent with the spec ("right edge may be cut slightly — scroll hint") and the pills are not clipped without indication. Not a defect at this phase.

5. **Orbitron 900 not in browser font list.** Browsers only instantiate face entries that are actually applied to text. Since no element uses Orbitron 900, it shows as "not loaded" even though it is declared in the `@font-face` block. This is correct browser behaviour, not a font-loading failure.

6. **Distinctiveness (ai-tells CHECKER mode).** The aesthetic direction is nameable in three words: "retro-futurist dark arcade." Choices that a generic system would not make: five-hue one-job-per-colour scheme; Rajdhani as the body face (not Inter/Roboto/system-ui); aurora + scanline grid as ambient layer; glass with deep-purple tint rather than neutral grey; knife-through-C mascot as brand mark; scanline sweep as "sent" confirmation. The sheet is distinctively this project. PASS.

---

**Verdict: PASS**

No DW item failed. No Critical or Major defects. Two Minor findings (token chain gap, redundant hover nesting) that do not break any pixel, contrast ratio, or interactive state. Detector hits are all register-justified (demo-frame nesting and spec-notation em-dashes). The component sheet is complete, all 13 component areas are rendered, all interactive states are specified, all token aliases resolve, and all contrast pairs pass.
