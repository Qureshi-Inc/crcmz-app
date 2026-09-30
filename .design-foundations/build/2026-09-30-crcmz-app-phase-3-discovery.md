# Discovery + Design: Phase 3 - DNA lock

## Artifacts Found / Current State
- `DESIGN.md` does not exist at the worktree root. This phase establishes it.
- `JOURNEY.md` (root) holds §Inventory, §Job, §Journey, §IA, §Flows and §Page specs (commits 3c0be2a, 44a042d). §Page specs → "Carry-overs to later phases" gives Phase 3 four items (below).
- The legacy identity lives in `server.py` `_DASHBOARD_TMPL` (lines ~7565–7870):
  - `:root`: `--bg #05030f`, `--card rgba(18,10,38,.66)`, `--line rgba(255,60,200,.22)`, `--txt #f3ecff`, `--dim #9d8fc4`, the five neons.
  - `body::before` aurora: three radial gradients, `blur(34px)`, `drift 22s ease-in-out infinite alternate` → `translate3d(4%,3%,0) scale(1.12)`.
  - `body::after`: a 40 px grid, cyan .035 / magenta .03 lines, opacity .5.
  - `h1` wordmark: Orbitron 900, cyan→magenta gradient, `text-shadow 0 0 18px rgba(255,47,214,.35)`.
  - `.snd.c1–c5` tiles: hue gradient fill .16→.04, hue border .55, a near-white tinted label and a resting glow on **every** tile.
  - Body is Rajdhani 15 px, and Orbitron labels go down to 10.5 px.
- `crcmz-logo.png`: 480×480 RGBA, transparent background.
- The approved wireframe `.design-foundations/build/squad.html` is greyscale, so the identity is not represented yet.
- Tooling: `palette.mjs` (4.2.0), the Playwright chromium-1234 headless shell (`/home/opti3/gstack/node_modules/playwright-core`), and PIL for pixel sampling.

## Gaps
1. **palette.mjs cannot check the pinned pairs.** It generates OKLCH ramps from a seed and reports contrast only for its own generated steps. The pinned hexes (the five neons, `#f3ecff`/`#9d8fc4`) and translucent glass over a moving aurora are outside its report. **Resolution:** `dna-contrast.mjs` loads palette.mjs's own `luminance()`/`contrast()` from its source at runtime (no re-implemented formula) and gates every DESIGN.md pair. palette.mjs itself still runs (exit 0) for the generated primitive ramp and the functional colours.
2. **"Worst-case composite" needs a definition.** I use the **stacked-peak bound**: all three blobs at peak alpha on one pixel, plus a scanline crossing, with no credit for blur falloff. No real pixel can be brighter at any viewport, drift phase or scale. It resolves to `#664896`, and glass over it to `#2f1f4c`. The rendered specimen adds a second, empirical check: pixels sampled from the screenshots with text hidden.
3. **Carry-over vs pin: card boundaries ≥ 3:1.** The pinned card border `rgba(255,60,200,.22)` measures 1.31:1 against its own card, so it can never reach 3:1 without changing a pin. The finding behind the carry-over (mock review, line 24) is about **interactive** outlines (the composer input and tab-group outlines). It explicitly allows the light token for decorative dividers. **Resolution:** the pinned hairline stays as a decorative container edge on static cards (WCAG 1.4.11 does not apply to non-component containers). Every interactive boundary gets `--border-control` or a solid neon edge ≥ 3:1. This is flagged for the owner.
4. **The legacy glow is everywhere.** Every tile, the send button and the headers glow, which is the brief's structural complaint #4. A glow budget is needed.
5. **The legacy type has no scale** (complaint #5). Orbitron is used at 10.5 px, which is below where a geometric wide face renders cleanly (typography doctrine: geometric forms fail at small sizes on pixel grids).
6. **Magenta as a fill with a white label is 3.17:1** (plan edge case). The fill and text roles must split.

## Gate Status
- JOURNEY.md present, with page specs: **yes** (Phase 2 committed, 44a042d).
- DESIGN.md: **absent**. This phase produces it with status `draft — awaiting owner confirmation`. It cannot self-lock: the owner confirmation for DW-3.1 is pending and is for the orchestrator to ask.
- Prerequisites met: yes.

## DW Verification
| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-3.1 | DESIGN.md locked (token block present + user-confirmed) | COVERED (token block) · **PENDING owner** (confirmation) | DESIGN.md exists with a `:root` token block. The specimen `.html` uses those tokens verbatim, so the tokens are applied. Screenshots at 375 and 1440 are there for the owner to confirm on real pixels. The owner's confirmation cannot be produced by this agent |
| DW-3.2 | all text/background pairs pass WCAG AA (≥ 4.5:1 body, ≥ 3:1 large), verified via palette.mjs | COVERED | (a) `palette.mjs --seed #9d5cff --chroma vivid --harmony tetradic --scheme dark --prefix gen` exits 0, 9/9 PASS. (b) `dna-contrast.mjs` (palette.mjs WCAG math) exits 0 with every gated pair at the stacked-peak bound. (c) Screenshot pixel sampling of the rendered glass surfaces |
| DW-3.3 | type scale `--text-xs`…`--text-4xl` present | COVERED | All eight steps (`xs sm base lg xl 2xl 3xl 4xl`) are in the DESIGN.md token block, and the specimen renders the ladder at 375 and 1440 |

**All items COVERED:** YES for the artifact parts. The user-confirmation half of DW-3.1 is explicitly pending, because an agent cannot supply it.

## Design Decisions

**Pipeline note (design-dna §Pins).** Every DNA axis is pinned or already settled:
- Type and colour are the research §Taste signals pins.
- Composition is the owner-approved wireframe plus the Phase 2 page specs.
- Motion is pinned (the aurora drift is kept).

So there is no five-candidate diverge or dealer run: dealing a new composition would contradict approved specs, and "pinned axes are user law". Critique still runs (tells scan below), and converge = owner confirmation.

**Archetype → family.** Jester (irreverent, in-jokey, "proud to be weird") inflected by Outlaw. The base is **Retro-Futurist** (wide display type, neon, "one signature ambient motion max", grids implying a horizon = the scanline grid). Content pressure (transactional app UI, mobile) pushes toward Swiss, so the **borrowed axis is composition from Swiss**: flush-left, hierarchy from scale and placement, not glow. The dominant axis is colour strategy (the aurora plus the five hues are the identity). It is pinned, and I record that honestly rather than pretend the borrow dominates.

**Grounding.** Tron: Legacy's light-lines (neon as a thin edge on black, never a fill) + the PlayStation XMB (a calm, glanceable menu over a constantly moving ambient wave). The collision: the backdrop moves, the structure holds still, and neon lives on edges and moments. It fits a PSN squad app that is glanced at mid-session.

**Colour roles: each hue has one job** (the fix for "everything glows, nothing is emphasised"):
- magenta is brand + the one primary action;
- cyan is interactive (links, focus, the selected tab);
- lime is live, online and sent;
- gold is rank, trophy and prize;
- violet is ambient, AI and secondary tags.

The Chat Board tiles are the **only** place all five appear at equal weight (the brand-mandated grid). Fill and text roles are split per hue: the magenta fill takes an ink label (6.3:1), and the magenta text role is lifted to `#ff5ce0`. Only `--text` and large cyan/lime/gold/violet display type may sit on bare aurora. Everything else lives on glass, sheet or chrome.

**Glow budget.** Glow is allowed on four things only:
- the wordmark (pinned);
- the one primary CTA per view;
- the active nav marker;
- a tile's fired-state moment.

Cards never glow. Tiles do not glow at rest.

**Type.**
- Scale ratio 1.2 (phone band 1.2–1.25, surfaces doctrine) from a 17 px base. The steps are `13 / 15 / 17 / 20 / 24 / 29 / 35 / 42` at 375 px.
- `xl`–`4xl` are fluid via `clamp()` to `28 / 36 / 45 / 56` at 1440.
- **Rajdhani floor:** body is 17 px at weight 500, the absolute minimum for running text is 16 px at 500, meta text is 13 px at 600 only, and weights 300/400 are never used. Rajdhani is narrow with a modest x-height, so it reads about 1–2 px smaller than a normal UI sans, and 17 px also keeps inputs above the iOS 16 px zoom threshold.
- **Orbitron floor** is 15 px, uppercase labels, headings and numerals only, never running text. That retires the legacy 10.5 px labels.
- The specimen renders a Rajdhani legibility ladder (15/16/17 px × 500/600) so the owner can verify on pixels.

**Surfaces.** Four tiers, and all text sits on the top three:
- bare aurora;
- glass card (pinned `rgba(18,10,38,.66)` + blur 14 px);
- sheet/panel `rgba(12,8,28,.92)`;
- chrome `rgba(8,5,20,.86)`.

`prefers-reduced-transparency` raises the glass to .9 and drops the blur. There are no nested cards: inside a card, use rows and dividers.

**Motion.**
- The aurora drift is kept verbatim (22 s, transform only). Blob alphas are tuned to magenta .28, cyan .26 and violet .25.
- Timing is 100 / 240 / 400 ms with ease-out-expo; no bounce.
- **Signature move:** a fired tile runs a single scanline sweep, a 2 px bright line crossing the tile in 240 ms. It reuses the backdrop's scanline motif as the "sent" confirmation, so the motion communicates a state change.
- Reduced motion stops the drift (the aurora is static at rest), removes the sweep (a static lime edge for 1.2 s instead), removes the confetti and press-scale, and turns sheets into ≤ 100 ms fades.
- The drift pauses while `document.hidden` (battery on phones).

**Responsive.** Breakpoints are content-driven:
- 1024 px nav switch: 240 sidebar + 360 Chat Board panel + ≥ 424 main (Phase 2 IA);
- 1440 wide media grid;
- tile grid 3-up at ≥ 400 px **container** width (container query).

Tap targets are ≥ 44 px, and tiles are ≥ 64 px.

**Tells scan (ai-tells.md, 2026-07).** The identity knowingly carries catalogued tells:
- neon on dark;
- cyan on dark;
- glassmorphism;
- gradient text;
- dark by default.

Every one is an **owner pin** with a content reason: a late-night gaming session, and continuity with the squad's existing app ("Will it still feel like CRCMZ?" is the Anxiety force in §Job). None is a model default. Mitigations:
- neon on edges and moments only;
- glass used structurally, as the legibility layer over a moving backdrop;
- gradient text on the wordmark only, never on metrics;
- cyan is one of five jobs, not the palette.

The fonts avoid the overused set. The nested-cards rule is stated in DESIGN.md §Never.

**Tool reuse.**
- `palette.mjs` generates the primitive ramp and the functional colours.
- `dna-contrast.mjs` reuses palette.mjs's WCAG functions (no hand-rolled formula).
- The `prototype` skill conventions apply to the specimen.
- The Playwright headless shell takes the screenshots.

## Recommendation
BUILD

---

## Revision 1 (owner feedback, 2026-09-30)

**Input:** the owner reviewed the four specimen screenshots (decision-log row in the plan). Four decisions follow. Doctrine re-read for the touched axes: colour (ch. 8), surfaces, motion, ai-tells (glow tells), design-dna (lock/confirm step).

### Current state → change
| # | Owner decision | Draft | Revision |
|---|---|---|---|
| 1 | Aurora back up to the ~30–32 % band, ≤ legacy | .28 / .26 / .25 | **.32 / .30 / .28**, plus a portrait-only `inset: -10%` |
| 2 | Soft resting glow on soundboard tiles only | no glow at rest | `--glow-tile-rest` (10 px, α .22) + `--glow-tile-fire` (18 px, α .55), composed per tile from its own `--rgb` |
| 3 | Mascot = `footer-avatar.png` | `crcmz-logo.png` at 36 / 44 px (wrong asset) | `footer-avatar.png` at `--brand-mark: 64px`, top bar `--topbar-h: 72px`. The file is copied into the build dir for the specimen |
| 4 | Ink on magenta, colour jobs, type floors, decorative border + `--border-control` | as drafted | unchanged, locked |

### Gaps found while producing
1. **Band vs ceiling for violet.** Legacy violet is .28, which is below the 30–32 band. "Do not exceed legacy" is the hard ceiling, so violet lands at .28. Magenta .32 and cyan .30 are in the band. The mean is .30.
2. **Alpha alone cannot make the aurora visible on a phone.** With `inset: -30% -10%` on 375 × 800, the magenta blob's centre renders about 86 px above the viewport, the violet one about 190 px below it, and the 72 px chrome bar covers the cyan one. **Resolution:** a portrait-only `inset: -10%`. The blobs, positions, alphas, drift and grid are all unchanged. The contrast gate is geometry-independent, because it assumes the stacked peak on every pixel.
3. **Pessimistic glow gate.** A no-falloff model (a neighbour's fire glow at its peak α across the whole next tile) is physically unreachable and fails at 2.46:1. **Resolution:** gate the true Gaussian halo (σ = blur/2, CSS Backgrounds 3) at the real token geometry. Labels are ≥ 16 px from a neighbour's edge, with two neighbour halos stacked. Borders are gated against their own halo at the edge. Targets unchanged. The resting glow passes even with no falloff at all (4.81:1).
4. **Seam: JOURNEY.md PS-0/PS-1 say "48 px top bar".** The 64 px mascot needs 72 px. This is flagged in DESIGN.md §Open questions for the plan to sync into JOURNEY.md. It costs the Squad first screen 24 px; the bottom-chrome budget is unaffected.

### DW Verification (revision)
| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-3.1 | DESIGN.md locked (token block + user-confirmed) | COVERED | Status is `locked · owner-confirmed 2026-09-30`, with a §Owner confirmation section recording decisions 1–4. The specimen's 125 `:root` tokens diff clean against the DESIGN.md block (tokens applied) |
| DW-3.2 | All text/background pairs pass WCAG AA via palette.mjs | COVERED | `palette.mjs` 9/9 PASS, exit 0. `dna-contrast.mjs` (palette.mjs WCAG math): 113/113 PASS, exit 0 at the new stacked-peak bound `#704da2`. Tightest pair: large violet on bare aurora, 3.07:1 / 3. Real pixels: the brightest glass pixel is `#3f113d` → `--text-dim` 5.27:1 |
| DW-3.3 | Type scale `--text-xs`…`--text-4xl` | COVERED | Unchanged, and still rendered in the specimen ladder |

**All items COVERED:** YES (3/3)

### Recommendation
BUILD (applied). Status → locked.
