# Design Review: Phase 3 — Neon Cabinet DNA Specimen

**Date:** 2026-09-30  
**Reviewer:** Design Review Agent (dual-blind)  
**Surface reviewed:** `.design-foundations/build/dna-specimen.html` at 375 and 1440 px

---

## Rendered Evidence (Step 0)

- Screenshots: `dna-specimen-375-fold.png`, `dna-specimen-375.png`, `dna-specimen-1440-fold.png`, `dna-specimen-1440.png` — all four read directly as images
- Surface: DNA specimen HTML, two widths, both folds and full-page scrolls; four distinct pixel views
- DESIGN.md and JOURNEY.md read from the worktree root as the contract

---

## Assessment B — Deterministic Detector

- Command: `node /home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/detect.mjs .design-foundations/build/dna-specimen.html > .design-foundations/build/detect.json`
- Exit: **0 (ran)**
- Findings: 9 total — `nested-cards` ×7, `gradient-text` ×1, `em-dash-overuse` ×1
- Opened only after Assessment A findings were frozen: **YES**

---

## Triage

- **Baseline (always-on):** visual + usability
- **Dispatched:** `design-dna` (four-axis DNA evaluation), `checklists` (ai-tells CHECKER mode), `fonts` (ch03 medium-form), `color` (ch08 contrast), `motion` (prefers-reduced-motion edge case), `responsive` (mobile-first, two breakpoints), `surfaces` (four surface tiers on a phone/desktop surface)
- **Not applicable:** `data-viz` (no charts or quantitative encodings beyond stat numerals), `content-design` (specimen-level copy, no production microcopy to audit), `journey` (single specimen surface, not a multi-step flow), `behavioral` (no conversion or persuasion mechanics)
- **Deferred:** none — all applicable pillars reviewed

---

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| Minor | visual/tokens | `--wordmark-glow` token (`text-shadow: 0 0 18px rgba(255,47,214,.35)`) does not render in Chrome or Safari when `color: transparent` is combined with `-webkit-background-clip: text`. The CSS spec treats text-shadow as computed with the resolved (transparent) color, so the shadow is invisible. The aurora provides ambient glow in that zone but the pinned 18 px magenta halo specified in DESIGN.md §Token block is not delivered. | Foundations §2 harmony test: each layer (token → rendering) must reinforce the others; a token with a defined value that cannot render is a broken layer. CSS rendering constraint (medium-form relationship, ch03 analogue). | On the wordmark wrapper, replace `text-shadow` with `filter: drop-shadow(0 0 18px rgba(255,47,214,.35))`. `filter` is applied after compositing and operates on the rendered gradient pixels, not on the glyph fill color. |
| Notes | detector | **nested-cards ×7** (ai-tells.md `nested-cards`, high): `.seg` segmented control (line 421) and tiles `.c1`–`.c5` plus `.add` (lines 424–429) each flagged as "card inside a card ancestor." Register-justified: (a) tiles are interactive `<button>` controls with mandated per-hue treatment, not content containers; (b) they sit inside `.board.sheet` (the Chat Board aside panel), not inside a `.glass` card; (c) DESIGN.md §Never explicitly prohibits nested cards and tiles are specifically called out as a designed exception with their own surface tokens (`--tile-c1-rgb`, etc.). The `.seg` element is a `role=tablist` control, not a card. Evidence quoted verbatim: `<button class="tile c1"> is a card inside a card ancestor`. | ai-tells.md nested-cards (Fable 5 fingerprint §Rank 1, high). | No action required — structural CSS similarity detected; semantic function is register-correct. |
| Notes | detector | **gradient-text ×1** (ai-tells.md `gradient-text`, medium): `background-clip: text` gradient on the wordmark at line 177. Register-justified: the owner has explicitly pinned the "cyan→magenta gradient wordmark with its neon text-shadow" as a pinned constraint (DESIGN.md §Pins), and DESIGN.md §Never states "Gradient text anywhere but the wordmark." This is the one sanctioned exception. Evidence verbatim: `gradient-filled text (background-clip: text + gradient)`. | ai-tells.md gradient-text (medium — "Gradient text on headings or metrics"). | No action required — the wordmark gradient is owner-pinned; no other gradient text present. Note that this same element is also subject to the Minor finding above (glow non-rendering). |
| Notes | detector | **em-dash-overuse ×1** (ai-tells.md `em-dash-overuse`, medium): detector reports 15 instances. This is a false positive: the `<style>` block contains approximately 60+ CSS custom property declarations, each prefixed with `--`, which the detector's double-hyphen scan counts as em-dash equivalents. The rendered body copy contains zero `—` (U+2014) characters. | ai-tells.md em-dash-overuse (medium). | No action required — false positive from CSS source scanning; not a copy quality issue. |

---

## Requirement Fulfillment

### DW-3.1
PREMISE:  DESIGN.md locked (token block present + user-confirmed)  
EVIDENCE: DESIGN.md line 2 reads `**Status:** locked · owner-confirmed 2026-09-30 (see §Owner confirmation)`. A dedicated `## Owner confirmation (2026-09-30)` section records four numbered decisions. The token block spans the full CSS `:root { ... }` block from `--bg: #05030f` through all motion tokens, verbatim. Line 16 states `**This file is locked** (DW-3.1 closed by the owner on 2026-09-30)`.  
VERDICT: **PASS**

---

### DW-3.2
PREMISE:  all text/background pairs pass WCAG AA (≥4.5:1 body, ≥3:1 large), verified via `palette.mjs`  
EVIDENCE: Two tools documented in DESIGN.md §Contrast report: (1) `palette.mjs` (generated tier) — 9/9 PASS, exit 0, covering neutral and accent ramps on `--gen-neutral-2`. (2) `dna-contrast.mjs` (brand + composite tier, uses palette.mjs luminance function) — 113/113 PASS, exit 0, at the owner-confirmed aurora alphas (.32/.30/.28). The tightest passing pair is `violet-text (large) on bare aurora: 3.07:1` against the 3:1 large-text target. The rendered-pixel check (dna-render.mjs at 375 and 1440) found the brightest real surface pixel to be `#3f113d` — below the analytic bound used in the contrast script, confirming the bound is conservative. The magenta fill + ink label pair (`#ff2fd6` / `#0b0616`) computes to 6.3:1 as documented, independently verified in this review. White-on-magenta = 3.17:1, which the specimen explicitly demonstrates as rejected.  
VERDICT: **PASS**

---

### DW-3.3
PREMISE:  type scale `--text-xs`…`--text-4xl` present  
EVIDENCE: All eight steps present in the `:root` token block of `dna-specimen.html` (lines 85–92), values matching DESIGN.md §Type table: `--text-xs: 0.8125rem` (13 px), `--text-sm: 0.9375rem` (15 px), `--text-base: 1.0625rem` (17 px), `--text-lg: 1.25rem` (20 px), `--text-xl: clamp(1.5rem, 1.412rem + 0.376vw, 1.75rem)` (24→28 px), `--text-2xl: clamp(1.8125rem, 1.658rem + 0.657vw, 2.25rem)` (29→36 px), `--text-3xl: clamp(2.1875rem, 1.967rem + 0.939vw, 2.8125rem)` (35→45 px), `--text-4xl: clamp(2.625rem, 2.317rem + 1.315vw, 3.5rem)` (42→56 px). The 1440 px screenshot shows the full type-scale ladder with all eight steps rendered at both Orbitron display sizes and Rajdhani body sizes, confirming font loading and rendering.  
VERDICT: **PASS**

---

### Edge case: Neon magenta fails AA as a button fill with a white label — fill and text roles must be split
EVIDENCE: The specimen contains an explicit rejected-role demonstration: a magenta-fill button labeled "Squad Up" with a CSS `text-decoration: line-through` and the note "White on magenta = 3.17:1 → rejected. The fill takes the ink label (6.3:1)." The `.btn.primary` class uses `color: var(--accent-on-solid)` which resolves to `var(--on-magenta-fill)` which resolves to `var(--ink)` = `#0b0616`. The DESIGN.md §Color tokens table documents the rejection: "A white label is rejected (3.17:1)." The `--magenta-text` role (`#ff5ce0`) is used only for text on dark surfaces, never on the magenta fill. The fill/text role split is architecturally enforced.  
VERDICT: **PASS**

---

### Edge case: Reduced motion must stop the aurora drift
EVIDENCE: HTML line 157: `@media (prefers-reduced-motion: reduce) { body::before { animation: none; } }` — this sets `animation: none` on the `::before` pseudo-element that carries the drift keyframe animation. The drift keyframe (`@keyframes drift { to { transform: translate3d(4%, 3%, 0) scale(1.12); } }`) is disabled; blobs rest at their start position. Additionally, `*, *::before, *::after { transition-duration: .01ms !important; }` stops the tile sweep and press-scale. The tile `.fired::after { display: none; }` removes the scanline sweep under reduced motion. The static resting glow on tiles is preserved (design decision: a static glow is not motion). DESIGN.md §Motion: `prefers-reduced-motion: reduce` — "The aurora drift stops (`animation: none`)".  
VERDICT: **PASS**

---

**All requirements met:** YES

---

## Notes (non-blocking)

1. **Wordmark glow rendering (also cross-referenced as the Minor finding above).** The `text-shadow` property on a `color: transparent` element does not render in Chrome or Safari. The aurora provides ambient pink haze near the wordmark area so the specimen visually implies a glow, but the token `--wordmark-glow` is not delivered as specified. Recommend switching to `filter: drop-shadow()` on a wrapper span before Phase 4 implementation.

2. **JOURNEY.md / DESIGN.md sync gap — topbar height.** DESIGN.md §Open questions notes that PS-0 and PS-1 in JOURNEY.md say "48 px top bar" while the locked token is `--topbar-h: 72px`. The specimen implements 72 px correctly; JOURNEY.md has not been updated to match. This is tracked in the open questions but is not a Phase 3 failure.

3. **Wordmark label — "CRCMZ" vs "CRCMZ APP".** JOURNEY.md G-01 documents the wordmark as "CRCMZ APP"; the specimen and locked DESIGN.md use "CRCMZ". DESIGN.md is the downstream authority (law once locked). This is a JOURNEY.md sync item, not a design token error.

4. **Nav icons are Unicode symbols in the specimen.** Sidebar and tab bar nav items use text characters (`◉`, `▶`, `▣`, `♪`, etc.) rather than SVG icons. This is a specimen limitation; production Phase 4 will use proper icon assets. No impact on the token or contrast review.

5. **Mascot image path is relative.** `src="footer-avatar.png"` resolves correctly in the specimen context (confirmed by the mascot rendering in all four screenshots), but requires the image to be co-located or served from the right path in production. The screenshots confirm it is present and loading.

---

**Verdict: PASS**

The three done-when items and both listed edge cases all pass with pixel evidence. The single Minor finding (wordmark glow non-rendering) is a CSS rendering gotcha that does not break the experience, does not violate a DW item, and is not a listed edge case. All three deterministic detector hits are register-justified: the nested-cards hits are interactive buttons in a sheet panel (not content cards inside glass cards), the gradient-text hit is the owner-pinned wordmark, and the em-dash hit is a false positive from CSS variable scanning. No Critical cited-principle violations. Distinctiveness check passes: the design has a named aesthetic direction ("Neon Cabinet" — arcade retro-futurist dark), authored choices traceable to the Tron/PlayStation XMB grounding (scanline sweep as sent-confirmation, ink label on neon fill, per-tile glow budgets, five-role color system), and the knife-through-C mascot as an unambiguous visual fingerprint that no generic system would produce.
