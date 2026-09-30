# Design: Neon Cabinet
**Date:** 2026-09-30 · **Status:** locked · owner-confirmed 2026-09-30 (see §Owner confirmation)
**Archetype:** Jester, inflected by Outlaw · **Register:** calm product structure · expressive at: the Chat Board fire moment, the wordmark and aurora, and giveaway reveal / Squad Up success
**Grounding:** Tron: Legacy's light-lines (neon as a thin edge on black, never a fill) + the PlayStation XMB (a calm, glanceable menu over a constantly moving ambient wave)
**DNA:** Retro-Futurist base + composition borrowed from Swiss / International · **Dominant axis:** colour strategy (owner-pinned)
**Composition:** not dealt. It is pinned by the owner-approved wireframe (`.design-foundations/build/squad.html`) and the JOURNEY.md Phase 2 page specs. Pinned axes are user law.
**Pins:** research §Taste signals, all verbatim:
- background `#05030f` with a 3-blob aurora at magenta .32 / cyan .30 / violet .28 (owner: back up to the 30–32 % band, never above legacy .34 / .30 / .28), the drift animation and the scanline grid;
- the palette `#ff2fd6 #22e6ff #8cff2b #9d5cff #ffd24a`;
- Orbitron + Rajdhani;
- glass `rgba(18,10,38,.66)` with border `rgba(255,60,200,.22)`;
- multi-colour soundboard tiles, each with a soft resting glow in its own hue;
- the cyan→magenta gradient wordmark with its neon text-shadow;
- the mascot `footer-avatar.png` (the "C" with a knife) as the brand mark. `crcmz-logo.png` is **not** the mascot (see §Brand mark).

> **Law once locked.** Nothing downstream (Phases 4–6, the mock, the code plan) re-derives these values. A deviation means editing this file first, through the plan. **This file is locked** (DW-3.1 closed by the owner on 2026-09-30).

## Owner confirmation (2026-09-30)
The owner reviewed the specimen screenshots and confirmed the file with these decisions:
1. **Aurora back up.** At the draft's .28 / .26 / .25 it was barely visible on the phone. It is now **magenta .32 / cyan .30 / violet .28**. That is inside the 30–32 % band where the legacy ceiling allows it: cyan and violet sit at their legacy values, which are the ceiling (violet's legacy value .28 is below the band, and the ceiling wins). All three blobs, the drift and the scanline grid are kept. A portrait-only `inset: -10%` pulls the magenta and violet blob centres onto a phone screen: at the legacy `-30% -10%` they rendered about 86 px above and 190 px below a 375 × 800 viewport. Every contrast pair was re-gated at the new stacked-peak bound: 113/113 PASS, and no token or role needed to change.
2. **Soundboard tiles keep a soft resting glow** (`--glow-tile-rest`, per tile, in its own neon). It is clearly weaker than `--glow-tile-fire`: alpha .22 vs .55 and reach 10 vs 18 px. Measured on the render, the halo lifts 9–11/255 at rest vs 37/255 when fired, so firing is still a distinct event. Every other element keeps the restrained glow budget. Reduced motion keeps the resting glow, because a static glow is not motion.
3. **Brand mark = `/footer-avatar.png`** (the mascot the legacy header shows, `server.py` ~589), at 64 px in the top bar and the sidebar. `crcmz-logo.png` is a mostly-empty white wordmark ("QUICK, CLEAN, GONE") and is not used as the mark.
4. **Locked as shown, no change:**
   - the ink label on the magenta fill;
   - one job per colour (magenta = brand/main action, cyan = tappable, lime = live, gold = ranks/prizes, violet = ambient/AI);
   - Rajdhani body at 17 px (16 px minimum, weight ≥ 500), and Orbitron never below 15 px;
   - the faint pinned card border as decorative, with `--border-control` (≥ 3:1) on interactive items.

## Direction
A late-night arcade cabinet in your pocket. The aurora breathes and the scanline grid hums behind everything, and that alone makes the app feel alive when no data is moving. The UI on top holds still: flush-left, sized by importance, with neon kept for edges and the moments that matter. It serves ten friends glancing at a phone mid-session: who's on, fire a tile, back to the game. The Tron/XMB collision fits because the squad lives inside a PlayStation all night. A moving ambient layer under a calm menu is the grammar they already read fluently.

## Signature move
**The scanline sweep.** When a Chat Board tile fires, one 2 px line in the tile's own neon crosses the tile top-to-bottom in 240 ms (`transform: translateY` only). At the same moment the tile's soft resting glow steps up to its fire glow (`--glow-tile-fire`, 2.5× the alpha and nearly twice the reach). This is the backdrop's scanline motif used as the "sent" confirmation, so motion answers "what changed?". It appears **only** on a successful fire (F-0 `Sent`): not on hover, not on load, not on other buttons. Under reduced motion there is no sweep; the tile shows a static lime `--live` edge plus a "Sent" label for 1.2 s.

## Expressive moments
Everything else holds the calm structure register.
1. **Chat Board fire** (PS-1, F-1): the scanline sweep plus the tile's fire glow, 240 ms. This is the dial's highest point in daily use.
2. **Wordmark + aurora** (shell, always): the gradient wordmark with its neon text-shadow on chrome, and the aurora drifting at 22 s. It is ambient and constant, so it never competes with content.
3. **Big wins** (giveaway reveal PS-5, Squad Up success F-2): a 4xl Orbitron numeral or name in gold or lime, and the primary CTA glow. Confetti is allowed here only, ≤ 1.2 s, and is off under reduced motion.

## Type
- **Display:** Orbitron 600 / 800 / 900 (Google Fonts), fallback `"Orbitron", "Eurostile", "Arial Black", sans-serif`. Use it for the wordmark, page and section headings, uppercase labels and stat numerals, **never for running text**. **Floor: 15 px (`--text-sm`)**, which retires the legacy 10.5 px labels. A geometric wide face breaks up on the pixel grid below this. Uppercase labels are tracked +0.06em. Numerals use `font-variant-numeric: tabular-nums`.
- **Body:** Rajdhani 500 / 600 / 700 (Google Fonts), fallback `"Rajdhani", "Barlow Semi Condensed", "Arial Narrow", sans-serif`. Use it for body text, buttons, inputs and row names.
  - **Minimum body size: 16 px at weight 500.** Default body is 17 px at 500 (`--text-base`).
  - Meta text (timestamps, captions) is 13 px, and only at weight 600.
  - Rajdhani 300/400 are never loaded or used.
  - Why: Rajdhani is narrow and squarish with a modest x-height, so it reads about 1–2 px smaller than a normal UI sans. 17 px also keeps inputs above iOS's 16 px focus-zoom threshold.
  - The specimen's legibility ladder (15/16/17 px × 500/600 at 375 px) is the evidence.
- **Scale:** ratio 1.2 (phone band) from a 17 px base, mobile first. `xs`–`lg` are fixed. `xl`–`4xl` are fluid via `clamp()` from 375 px to 1440 px.

| Token | 375 px | 1440 px | Family / weight | Use |
|---|---|---|---|---|
| `--text-xs` | 13 | 13 | Rajdhani 600 | meta, timestamps, captions (never Orbitron) |
| `--text-sm` | 15 | 15 | Rajdhani 600 / Orbitron 600 caps | secondary lines, chips, tab labels, eyebrow labels |
| `--text-base` | 17 | 17 | Rajdhani 500 (buttons 700) | body, inputs, buttons |
| `--text-lg` | 20 | 20 | Rajdhani 700 / Orbitron 700 caps | row names, card titles, section `h2`, top-bar wordmark |
| `--text-xl` | 24 | 28 | Orbitron 800 | compact stat numerals, sidebar wordmark |
| `--text-2xl` | 29 | 36 | Orbitron 800 | page `h1` |
| `--text-3xl` | 35 | 45 | Orbitron 800 | stat-tile numerals |
| `--text-4xl` | 42 | 56 | Orbitron 900 | hero numerals: hype count, countdown, giveaway winner |

- **Leading:** body 1.45 · snug 1.25 (lg) · display 1.1 (Orbitron). **Measure:** 60–75ch for reading-width pages (Ask AI, Settings, Portal ≤ 760 px).

## Brand mark
- **Mark:** `/footer-avatar.png` (581 × 582 RGBA, transparent). It is the knife-through-"C" mascot the legacy header shows (`server.py` ~589: `background-image:url('/footer-avatar.png');background-size:90%`). Serve it from the existing `/footer-avatar.png` route.
- **`crcmz-logo.png` is not the mascot.** It is a mostly-empty white wordmark ("QUICK, CLEAN, GONE"). It is not used as the brand mark anywhere in `/app`.
- **Size:** `--brand-mark: 64px` (`object-fit: contain`) in both the mobile top bar and the desktop sidebar brand row, which is what the legacy mobile header showed (about 64–72 px). The top bar grows to `--topbar-h: 72px` to hold it. The wordmark sits to its right (`--text-lg` in the top bar, `--text-xl` in the sidebar), with the tagline under the wordmark.
- **Treatment:** no plate, no glow, no border. The sticker's white outline separates it from the chrome. It carries `alt=""` because the adjacent wordmark carries the name. It is never recoloured or tinted.

## Color tokens
**Colour roles: each hue has one job.** This is the fix for "everything glows, nothing is emphasised".

| Hue | Pinned hex | Job | Fill role (label) | Text role |
|---|---|---|---|---|
| Magenta | `#ff2fd6` | Brand + **the one primary action per view**, the active nav marker, the wordmark end | `--magenta-fill #ff2fd6` + **ink label `#0b0616`** (6.3:1). A white label is rejected (3.17:1) | `--magenta-text #ff5ce0`, never on bare aurora |
| Cyan | `#22e6ff` | Interactive: links, focus ring, the selected tab, secondary (outline) buttons | `--cyan-fill` + ink label (13.15:1) | `--cyan-text #22e6ff` |
| Lime | `#8cff2b` | Live: online and in-game presence, "Sent", the success moment | `--lime-fill` + ink label (15.64:1) | `--lime-text #8cff2b` |
| Gold | `#ffd24a` | Achievement: ranks, trophies, plats, the giveaway prize | `--gold-fill` + ink label (13.85:1) | `--gold-text #ffd24a` |
| Violet | `#9d5cff` | Ambient: the aurora, AI surfaces (Ask AI, Coach), secondary tags | `--violet-fill-deep #7a3cf0` + white label (5.63:1) | `--violet-text #c1a5ff` (= palette.mjs `--gen-accent-11`) |

**Placement rules:**
- Only `--text` and **large** (≥ `--text-xl`) cyan, lime, gold or violet display type may sit on bare aurora (the page `h1`, a bare stat numeral).
- Every other text role sits on glass, sheet or chrome.
- The wordmark sits on chrome or glass only, never on bare aurora (its magenta end is 2.26:1 there).
- The Chat Board tiles are the only place all five hues appear at equal weight.
- Hue is never the only cue: tiles carry text labels, and status carries text plus a dot.

**Glow budget:** glow appears on the wordmark, the one primary CTA per view (a magenta fill), the active nav marker and a tile's fired moment. **The one owner-confirmed exception:** Chat Board tiles carry a soft resting glow (`--glow-tile-rest`) in their own neon. It is always weaker than the fire glow (`--glow-tile-fire`), and the "+ Custom" slot has none. Nothing else glows. Cards never glow. There is no gradient text except the wordmark. Any other filled action in the same view (for example the Chat Board composer Send) is a **cyan fill + ink label with no glow**, so a view never has two magenta glowing CTAs.

**Surfaces** (all text sits on the top three):

| Tier | Token | Value | Use |
|---|---|---|---|
| 0 | `--bg` + aurora + grid | `#05030f` | page |
| 1 | `--glass` | `rgba(18,10,38,.66)` + `backdrop-filter: blur(14px) saturate(1.2)` (pinned fill) | cards, rows, strips |
| 2 | `--sheet` | `rgba(12,8,28,.92)` | bottom sheet, Chat Board panel, More sheet, dialogs |
| 3 | `--chrome` | `rgba(8,5,20,.86)` + blur 18 px | top bar, tab bar, sidebar, handle row |

`prefers-reduced-transparency: reduce` raises `--glass` to `.9`, removes the blur and lets the drift continue.

### Token block (brand + semantic layer, law once locked)
```css
:root {
  color-scheme: dark;
  /* --- pinned brand primitives --- */
  --bg: #05030f;
  --neon-magenta: #ff2fd6;
  --neon-cyan: #22e6ff;
  --neon-lime: #8cff2b;
  --neon-violet: #9d5cff;
  --neon-gold: #ffd24a;
  --aurora-magenta: rgba(255, 47, 214, .32);  /* legacy .34 · owner 2026-09-30 */
  --aurora-cyan: rgba(34, 230, 255, .30);     /* legacy .30 */
  --aurora-violet: rgba(157, 92, 255, .28);   /* legacy .28 (ceiling) */
  --grid-cyan: rgba(34, 230, 255, .035);
  --grid-magenta: rgba(255, 47, 214, .03);
  --grid-opacity: .5;
  --glass: rgba(18, 10, 38, .66);
  --glass-border: rgba(255, 60, 200, .22);    /* decorative container edge, see Space/shape */
  --sheet: rgba(12, 8, 28, .92);
  --chrome: rgba(8, 5, 20, .86);
  --input-fill: rgba(6, 4, 18, .8);
  --ink: #0b0616;                             /* label on neon fills */
  --wordmark-gradient: linear-gradient(90deg, #22e6ff, #ff2fd6);
  --wordmark-glow: 0 0 18px rgba(255, 47, 214, .35);

  /* --- text roles --- */
  --text: #f3ecff;            /* any surface incl. bare aurora */
  --text-dim: #9d8fc4;        /* glass / sheet / chrome only; also placeholders */
  --magenta-text: #ff5ce0;
  --cyan-text: #22e6ff;
  --lime-text: #8cff2b;
  --gold-text: #ffd24a;
  --violet-text: #c1a5ff;

  /* --- fill roles (opaque; label colour fixed per fill) --- */
  --magenta-fill: #ff2fd6;   --on-magenta-fill: var(--ink);
  --cyan-fill: #22e6ff;      --on-cyan-fill: var(--ink);
  --lime-fill: #8cff2b;      --on-lime-fill: var(--ink);
  --gold-fill: #ffd24a;      --on-gold-fill: var(--ink);
  --violet-fill-deep: #7a3cf0; --on-violet-fill: #ffffff;

  /* --- semantic (Phase 4 extends; these names are the seam) --- */
  --background: var(--bg);
  --surface: var(--glass);
  --surface-raised: var(--sheet);
  --accent-solid: var(--magenta-fill);
  --accent-on-solid: var(--on-magenta-fill);
  --accent-text: var(--magenta-text);
  --interactive: var(--cyan-text);
  --live: var(--lime-text);
  --achievement: var(--gold-text);
  --ambient: var(--violet-text);
  --border-control: #8d78c4;  /* inputs, outline buttons, tappable cards: ≥3:1 */
  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--neon-cyan);

  /* --- soundboard tiles c1–c5 (fill tint over host, solid edge, tinted label) --- */
  --tile-c1-rgb: 34 230 255;  --tile-c1-edge: #22e6ff; --tile-c1-label: #c8fbff; /* cyan */
  --tile-c2-rgb: 255 47 214;  --tile-c2-edge: #ff5ce0; --tile-c2-label: #ffd6f6; /* magenta */
  --tile-c3-rgb: 157 92 255;  --tile-c3-edge: #b18cff; --tile-c3-label: #e4d4ff; /* violet */
  --tile-c4-rgb: 140 255 43;  --tile-c4-edge: #8cff2b; --tile-c4-label: #e0ffc0; /* lime */
  --tile-c5-rgb: 255 210 74;  --tile-c5-edge: #ffd24a; --tile-c5-label: #fff0c0; /* gold */
  --tile-fill-hi: .20;  --tile-fill-lo: .05;   /* 135deg gradient alpha */

  /* --- glow (budgeted: wordmark, primary CTA, active nav, fired tile; + soft resting glow on Chat Board tiles only) --- */
  --glow-tile-rest-blur: 10px; --glow-tile-rest-alpha: .22;   /* composed per tile as --glow-tile-rest */
  --glow-tile-fire-blur: 18px; --glow-tile-fire-alpha: .55;   /* composed per tile as --glow-tile-fire */
  --glow-magenta: 0 0 18px rgba(255, 47, 214, .45);
  --glow-cyan: 0 0 16px rgba(34, 230, 255, .40);
  --glow-lime: 0 0 16px rgba(140, 255, 43, .45);

  /* --- type --- */
  --font-display: "Orbitron", "Eurostile", "Arial Black", sans-serif;
  --font-body: "Rajdhani", "Barlow Semi Condensed", "Arial Narrow", sans-serif;
  --text-xs: 0.8125rem;                                  /* 13 */
  --text-sm: 0.9375rem;                                  /* 15 */
  --text-base: 1.0625rem;                                /* 17 */
  --text-lg: 1.25rem;                                    /* 20 */
  --text-xl: clamp(1.5rem, 1.412rem + 0.376vw, 1.75rem);      /* 24 → 28 */
  --text-2xl: clamp(1.8125rem, 1.658rem + 0.657vw, 2.25rem);  /* 29 → 36 */
  --text-3xl: clamp(2.1875rem, 1.967rem + 0.939vw, 2.8125rem);/* 35 → 45 */
  --text-4xl: clamp(2.625rem, 2.317rem + 1.315vw, 3.5rem);    /* 42 → 56 */
  --leading-body: 1.45;
  --leading-snug: 1.25;
  --leading-display: 1.1;
  --tracking-caps: 0.06em;
  --weight-body: 500;         /* floor for running text */

  /* --- space (4px base) --- */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
  --space-12: 48px; --space-16: 64px;
  --gutter: var(--space-4);   /* 16 mobile; 24 at ≥1024 */

  /* --- shape --- */
  --radius-sm: 8px;    /* chips' inner parts, avatars' squircle */
  --radius-md: 12px;   /* buttons, inputs, tiles */
  --radius-lg: 16px;   /* cards */
  --radius-xl: 22px;   /* sheet top corners */
  --radius-pill: 999px;

  /* --- sizing (mobile first) --- */
  --tap-min: 44px;
  --tile-min: 64px;
  --brand-mark: 64px;         /* footer-avatar.png mascot, top bar + sidebar */
  --topbar-h: 72px;           /* holds the 64px mascot (owner 2026-09-30; was 48) */
  --tabbar-h: 56px;
  --handle-h: 40px;           /* Squad bottom chrome = 96px = 12% of 800 */
  --sidebar-w: 240px;
  --panel-w: 360px;
  --reading-w: 760px;

  /* --- depth (hue-shifted, never pure black) --- */
  --shadow-card: 0 8px 24px rgba(4, 2, 14, .45);
  --shadow-sheet: 0 -12px 40px rgba(4, 2, 14, .65);
  --scrim: rgba(3, 1, 10, .62);

  /* --- motion --- */
  --dur-micro: 100ms;
  --dur-std: 240ms;
  --dur-large: 400ms;
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-in: cubic-bezier(.7, 0, .84, 0);
  --ease-inout: cubic-bezier(.65, 0, .35, 1);
  --aurora-dur: 22s;
}
@media (min-width: 1024px) { :root { --gutter: var(--space-6); } }
@media (prefers-reduced-transparency: reduce) { :root { --glass: rgba(18, 10, 38, .9); --chrome: rgba(8, 5, 20, .97); } }
/* tile glow tokens resolve per tile, because they read the tile's own --rgb (c1–c5) */
.tile { --glow-tile-rest: 0 0 var(--glow-tile-rest-blur) rgb(var(--rgb) / var(--glow-tile-rest-alpha));
        --glow-tile-fire: 0 0 var(--glow-tile-fire-blur) rgb(var(--rgb) / var(--glow-tile-fire-alpha));
        box-shadow: var(--glow-tile-rest); }
.tile.fired { box-shadow: var(--glow-tile-fire); }
.tile.add { box-shadow: none; }
@media (prefers-reduced-motion: reduce) { .tile.fired { box-shadow: var(--glow-tile-rest), inset 0 0 0 2px var(--neon-lime); } }
```

### Aurora + grid (pinned; reference implementation)
```css
body { background: var(--bg); color: var(--text); font: var(--weight-body) var(--text-base)/var(--leading-body) var(--font-body); letter-spacing: .01em; }
body::before { /* aurora */
  content: ""; position: fixed; inset: -30% -10%; z-index: -2; pointer-events: none;
  background:
    radial-gradient(38% 40% at 18% 12%, var(--aurora-magenta), transparent 60%),
    radial-gradient(40% 40% at 84% 18%, var(--aurora-cyan), transparent 60%),
    radial-gradient(46% 42% at 55% 96%, var(--aurora-violet), transparent 62%);
  filter: blur(34px); will-change: transform;
  animation: drift var(--aurora-dur) ease-in-out infinite alternate; }
@keyframes drift { to { transform: translate3d(4%, 3%, 0) scale(1.12); } }
@media (orientation: portrait) { body::before { inset: -10%; } } /* phone: magenta + violet blob centres on-screen */
body::after { /* scanline grid */
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none; opacity: var(--grid-opacity);
  background-image: linear-gradient(var(--grid-cyan) 1px, transparent 1px), linear-gradient(90deg, var(--grid-magenta) 1px, transparent 1px);
  background-size: 40px 40px; }
.is-hidden-doc body::before { animation-play-state: paused; } /* toggle on visibilitychange (battery) */
@media (prefers-reduced-motion: reduce) { body::before { animation: none; } }
```

### Generated primitive tier (palette.mjs, pasted verbatim)
Command: `node palette.mjs --seed "#9d5cff" --chroma vivid --harmony tetradic --scheme dark --prefix gen` → **exit 0**. The `gen-` prefix keeps these primitives from colliding with the brand layer. Phase 4 draws its functional colours (`--error/success/warning/info-*`) and the violet ramp from here. The `-11` text steps are also verified on glass below. Apply with `<html data-theme="dark">`.
```css
/* Generated by design-for-ai palette.mjs */
/* seed: derived from #9d5cff (oklch 0.63 0.231 297.7) · chroma: vivid · harmony: tetradic */

[data-theme="dark"] {
  --gen-neutral-1: #131313;
  --gen-neutral-2: #19191a;
  --gen-neutral-3: #222224;
  --gen-neutral-4: #2a292d;
  --gen-neutral-5: #333136;
  --gen-neutral-6: #3c3b41;
  --gen-neutral-7: #4a484f;
  --gen-neutral-8: #615f68;
  --gen-neutral-9: #706d78;
  --gen-neutral-10: #817e89;
  --gen-neutral-11: #b8b6be;
  --gen-neutral-12: #e8e7ec;
  --gen-accent-1: #131119;
  --gen-accent-2: #1b1724;
  --gen-accent-3: #261b3a;
  --gen-accent-4: #301f4d;
  --gen-accent-5: #3b2064;
  --gen-accent-6: #47207c;
  --gen-accent-7: #57249a;
  --gen-accent-8: #7332c6;
  --gen-accent-9: #862cee;
  --gen-accent-10: #964bfd;
  --gen-accent-11: #c1a5ff;
  --gen-accent-12: #eae3ff;
  --gen-accent-on-solid: #fbf9ff;
  --gen-orange-3: #391612;
  --gen-orange-9: #ff0719;
  --gen-orange-11: #ff9689;
  --gen-orange-on-solid: #150a09;
  --gen-lime-3: #20250a;
  --gen-lime-9: #afc500;
  --gen-lime-11: #b1c264;
  --gen-lime-on-solid: #0c0e05;
  --gen-cyan-3: #0d262a;
  --gen-cyan-9: #00cee3;
  --gen-cyan-11: #6ec7d4;
  --gen-cyan-on-solid: #031012;
  --gen-error-3: #391614;
  --gen-error-9: #ff002b;
  --gen-error-11: #ff958d;
  --gen-success-3: #0e2910;
  --gen-success-9: #00dd3e;
  --gen-success-11: #71d176;
  --gen-warning-3: #2a210b;
  --gen-warning-9: #e6ad00;
  --gen-warning-11: #d6b267;
  --gen-info-3: #112432;
  --gen-info-9: #0eafff;
  --gen-info-11: #7bc0f0;
  --gen-background: var(--gen-neutral-1);
  --gen-surface: var(--gen-neutral-2);
  --gen-surface-hover: var(--gen-neutral-3);
  --gen-surface-active: var(--gen-neutral-4);
  --gen-border-subtle: var(--gen-neutral-6);
  --gen-border: var(--gen-neutral-7);
  --gen-border-strong: var(--gen-neutral-8);
  --gen-text-secondary: var(--gen-neutral-11);
  --gen-text: var(--gen-neutral-12);
  --gen-accent-bg-subtle: var(--gen-accent-3);
  --gen-accent-solid: var(--gen-accent-9);
  --gen-accent-solid-hover: var(--gen-accent-10);
  --gen-accent-text: var(--gen-accent-11);
}
```

### Contrast report
**1. palette.mjs (generated tier):** 9/9 PASS, exit 0.
```
/* Contrast report (WCAG 2.x)
   PASS  [dark] neutral-11 on neutral-2: 8.73:1 (target 4.5:1)
   PASS  [dark] neutral-12 on neutral-2: 14.24:1 (target 7:1)
   PASS  [dark] neutral-12 on neutral-3: 12.94:1 (target 4.5:1)
   PASS  [dark] accent-11 on neutral-2: 8.42:1 (target 4.5:1)
   PASS  [dark] accent-11 on accent-2: 8.46:1 (target 4.5:1)
   PASS  [dark] accent-on-solid on accent-9: 5.57:1 (target 4.5:1)
   PASS  [dark] orange-11 on neutral-2: 8.32:1 (target 4.5:1)
   PASS  [dark] lime-11 on neutral-2: 8.97:1 (target 4.5:1)
   PASS  [dark] cyan-11 on neutral-2: 9.03:1 (target 4.5:1)
*/
```

**2. `dna-contrast.mjs` (brand + composite tier):** 113/113 gated pairs PASS, exit 0, re-run at the owner-confirmed aurora (.32 / .30 / .28). The tightest pair is large violet display type on bare aurora at 3.07:1 (target 3:1).
- The script is `.design-foundations/build/dna-contrast.mjs`. Its WCAG math is palette.mjs's own `luminance()`/`contrast()`, loaded from the palette.mjs source at runtime.
- **Worst case = stacked-peak bound:** all three blobs at peak alpha on one pixel, plus a scanline crossing, with no blur-falloff credit. Aurora `#704da2`; glass over it `#322150`; glass over flat `#0e081e`. No real pixel is brighter at any viewport, drift phase, scale or inset.
- **Tile glow:** CSS blur B is a Gaussian with σ = B/2, so a halo is at half its peak at the tile edge. Labels sit ≥ 16 px from a neighbour's edge (8 px gap + ≥ 8 px padding). Each label is gated under **two** stacked neighbour halos of any hue at that distance, at every aurora bound, with its own fill at the brightest corner. Each border is gated against its own halo at the edge. Both the resting glow and the fire glow are gated. The resting glow passes even with no falloff credit at all (4.81:1, INFO row).
- Each ratio below is the minimum across flat, stacked and each single-blob peak.
```
/* stacked-peak aurora = #704da2 · glass over it = #322150 · glass over flat = #0e081e */
PASS  [text 4.5] text on page (bare aurora): 5.55:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] text on glass card: 12.43:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] text on sheet/panel: 16.31:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] text on chrome: 16.08:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] text-dim on glass card: 4.87:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] text-dim on sheet/panel: 6.4:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] text-dim on chrome: 6.31:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] magenta-text on glass card: 5.35:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] magenta-text on sheet/panel: 7.02:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] magenta-text on chrome: 6.92:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] cyan-text on glass card: 9.42:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] cyan-text on sheet/panel: 12.36:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] cyan-text on chrome: 12.18:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] lime-text on glass card: 11.2:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] lime-text on sheet/panel: 14.7:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] lime-text on chrome: 14.5:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] violet-text on glass card: 6.87:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] violet-text on sheet/panel: 9.02:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] violet-text on chrome: 8.89:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gold-text on glass card: 9.92:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gold-text on sheet/panel: 13.02:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gold-text on chrome: 12.84:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-error-11 on glass card: 6.76:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-error-11 on sheet/panel: 8.88:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-error-11 on chrome: 8.75:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-success-11 on glass card: 7.55:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-success-11 on sheet/panel: 9.9:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-success-11 on chrome: 9.76:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-warning-11 on glass card: 7.1:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-warning-11 on sheet/panel: 9.31:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-warning-11 on chrome: 9.18:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-info-11 on glass card: 7.24:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-info-11 on sheet/panel: 9.51:1 (target 4.5:1) · worst at stacked
PASS  [text 4.5] gen-info-11 on chrome: 9.37:1 (target 4.5:1) · worst at stacked
PASS  [large 3.0] cyan-text (large) on page (bare aurora): 4.21:1 (target 3:1) · worst at stacked
PASS  [large 3.0] lime-text (large) on page (bare aurora): 5.01:1 (target 3:1) · worst at stacked
PASS  [large 3.0] violet-text (large) on page (bare aurora): 3.07:1 (target 3:1) · worst at stacked
PASS  [large 3.0] gold-text (large) on page (bare aurora): 4.43:1 (target 3:1) · worst at stacked
PASS  [large 3.0] wordmark cyan end on chrome: 12.18:1 (target 3:1) · worst at stacked
PASS  [large 3.0] wordmark cyan end on glass card: 9.42:1 (target 3:1) · worst at stacked
PASS  [large 3.0] wordmark cyan end on sheet/panel: 12.36:1 (target 3:1) · worst at stacked
PASS  [large 3.0] wordmark magenta end on chrome: 5.84:1 (target 3:1) · worst at stacked
PASS  [large 3.0] wordmark magenta end on glass card: 4.51:1 (target 3:1) · worst at stacked
PASS  [large 3.0] wordmark magenta end on sheet/panel: 5.92:1 (target 3:1) · worst at stacked
INFO  [info] magenta-text #ff5ce0 on bare aurora (BANNED role) on page (bare aurora): 2.39:1 · worst at stacked
INFO  [info] text-dim on bare aurora (BANNED role) on page (bare aurora): 2.18:1 · worst at stacked
INFO  [info] wordmark magenta end on bare aurora (BANNED placement) on page (bare aurora): 2.02:1 · worst at stacked
PASS  [fill 4.5] ink #0b0616 label on magenta fill #ff2fd6 (primary button): 6.3:1 (target 4.5:1) · worst at opaque
PASS  [fill 4.5] ink #0b0616 label on cyan fill #22e6ff: 13.15:1 (target 4.5:1) · worst at opaque
PASS  [fill 4.5] ink #0b0616 label on lime fill #8cff2b: 15.64:1 (target 4.5:1) · worst at opaque
PASS  [fill 4.5] ink #0b0616 label on gold fill #ffd24a: 13.85:1 (target 4.5:1) · worst at opaque
PASS  [fill 4.5] white label on violet-deep fill #7a3cf0: 5.63:1 (target 4.5:1) · worst at opaque
INFO  [rejected] white #ffffff label on magenta fill #ff2fd6 (REJECTED role): 3.17:1 · worst at opaque
PASS  [tile label 4.5] tile .c1 cyan label #c8fbff on sheet/panel: 10.75:1 (target 4.5:1) · worst at stacked
PASS  [tile label 4.5] tile .c1 cyan label #c8fbff on glass card: 8.11:1 (target 4.5:1) · worst at stacked
PASS  [tile edge 3.0] tile .c1 border #22e6ff vs host on sheet/panel: 12.36:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c1 border #22e6ff vs host on glass card: 9.42:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c1 border #22e6ff vs its own fill on sheet/panel: 7.95:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c1 border #22e6ff vs its own fill on glass card: 6:1 (target 3:1) · worst at stacked
PASS  [tile label 4.5] tile .c2 magenta label #ffd6f6 on sheet/panel: 11.26:1 (target 4.5:1) · worst at stacked
PASS  [tile label 4.5] tile .c2 magenta label #ffd6f6 on glass card: 8.5:1 (target 4.5:1) · worst at stacked
PASS  [tile edge 3.0] tile .c2 border #ff5ce0 vs host on sheet/panel: 7.02:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c2 border #ff5ce0 vs host on glass card: 5.35:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c2 border #ff5ce0 vs its own fill on sheet/panel: 5.46:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c2 border #ff5ce0 vs its own fill on glass card: 4.12:1 (target 3:1) · worst at stacked
PASS  [tile label 4.5] tile .c3 violet label #e4d4ff on sheet/panel: 10.66:1 (target 4.5:1) · worst at stacked
PASS  [tile label 4.5] tile .c3 violet label #e4d4ff on glass card: 8.02:1 (target 4.5:1) · worst at stacked
PASS  [tile edge 3.0] tile .c3 border #b18cff vs host on sheet/panel: 7.21:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c3 border #b18cff vs host on glass card: 5.49:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c3 border #b18cff vs its own fill on sheet/panel: 5.67:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c3 border #b18cff vs its own fill on glass card: 4.27:1 (target 3:1) · worst at stacked
PASS  [tile label 4.5] tile .c4 lime label #e0ffc0 on sheet/panel: 10.55:1 (target 4.5:1) · worst at stacked
PASS  [tile label 4.5] tile .c4 lime label #e0ffc0 on glass card: 7.97:1 (target 4.5:1) · worst at stacked
PASS  [tile edge 3.0] tile .c4 border #8cff2b vs host on sheet/panel: 14.7:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c4 border #8cff2b vs host on glass card: 11.2:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c4 border #8cff2b vs its own fill on sheet/panel: 9.03:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c4 border #8cff2b vs its own fill on glass card: 6.82:1 (target 3:1) · worst at stacked
PASS  [tile label 4.5] tile .c5 gold label #fff0c0 on sheet/panel: 10.36:1 (target 4.5:1) · worst at stacked
PASS  [tile label 4.5] tile .c5 gold label #fff0c0 on glass card: 7.72:1 (target 4.5:1) · worst at stacked
PASS  [tile edge 3.0] tile .c5 border #ffd24a vs host on sheet/panel: 13.02:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c5 border #ffd24a vs host on glass card: 9.92:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c5 border #ffd24a vs its own fill on sheet/panel: 8.17:1 (target 3:1) · worst at stacked
PASS  [tile edge 3.0] tile .c5 border #ffd24a vs its own fill on glass card: 6.09:1 (target 3:1) · worst at stacked
PASS  [tile rest-glow 4.5] tile .c1 cyan label, 2 neighbour rest halos @16px (a=0.0002 each) on any host: 8.11:1 (target 4.5:1) · worst at glass card/stacked/lime+lime
PASS  [tile rest-glow 3.0] tile .c1 border #22e6ff vs its own rest halo @edge (a=0.110) on any host: 7.48:1 (target 3:1) · worst at glass card/stacked
PASS  [tile rest-glow 4.5] tile .c2 magenta label, 2 neighbour rest halos @16px (a=0.0002 each) on any host: 8.5:1 (target 4.5:1) · worst at glass card/stacked/gold+gold
PASS  [tile rest-glow 3.0] tile .c2 border #ff5ce0 vs its own rest halo @edge (a=0.110) on any host: 4.68:1 (target 3:1) · worst at glass card/stacked
PASS  [tile rest-glow 4.5] tile .c3 violet label, 2 neighbour rest halos @16px (a=0.0002 each) on any host: 8.01:1 (target 4.5:1) · worst at glass card/stacked/gold+gold
PASS  [tile rest-glow 3.0] tile .c3 border #b18cff vs its own rest halo @edge (a=0.110) on any host: 4.8:1 (target 3:1) · worst at glass card/stacked
PASS  [tile rest-glow 4.5] tile .c4 lime label, 2 neighbour rest halos @16px (a=0.0002 each) on any host: 7.97:1 (target 4.5:1) · worst at glass card/stacked/lime+lime
PASS  [tile rest-glow 3.0] tile .c4 border #8cff2b vs its own rest halo @edge (a=0.110) on any host: 8.71:1 (target 3:1) · worst at glass card/stacked
PASS  [tile rest-glow 4.5] tile .c5 gold label, 2 neighbour rest halos @16px (a=0.0002 each) on any host: 7.72:1 (target 4.5:1) · worst at glass card/stacked/gold+gold
PASS  [tile rest-glow 3.0] tile .c5 border #ffd24a vs its own rest halo @edge (a=0.110) on any host: 7.7:1 (target 3:1) · worst at glass card/stacked
PASS  [text 4.5] text on sheet next to the grid, rest halo @16px on sheet/panel: 16.31:1 (target 4.5:1) · worst at stacked/gold
PASS  [text 4.5] text-dim on sheet next to the grid, rest halo @16px on sheet/panel: 6.4:1 (target 4.5:1) · worst at stacked/gold
PASS  [tile fire-glow 4.5] tile .c1 cyan label, 2 neighbour fire halos @16px (a=0.0207 each) on any host: 7.44:1 (target 4.5:1) · worst at glass card/stacked/lime+lime
PASS  [tile fire-glow 3.0] tile .c1 border #22e6ff vs its own fire halo @edge (a=0.275) on any host: 4.95:1 (target 3:1) · worst at glass card/stacked
PASS  [tile fire-glow 4.5] tile .c2 magenta label, 2 neighbour fire halos @16px (a=0.0207 each) on any host: 7.89:1 (target 4.5:1) · worst at glass card/stacked/gold+gold
PASS  [tile fire-glow 3.0] tile .c2 border #ff5ce0 vs its own fire halo @edge (a=0.275) on any host: 3.68:1 (target 3:1) · worst at glass card/stacked
PASS  [tile fire-glow 4.5] tile .c3 violet label, 2 neighbour fire halos @16px (a=0.0207 each) on any host: 7.44:1 (target 4.5:1) · worst at glass card/stacked/gold+gold
PASS  [tile fire-glow 3.0] tile .c3 border #b18cff vs its own fire halo @edge (a=0.275) on any host: 3.86:1 (target 3:1) · worst at glass card/stacked
PASS  [tile fire-glow 4.5] tile .c4 lime label, 2 neighbour fire halos @16px (a=0.0207 each) on any host: 7.26:1 (target 4.5:1) · worst at glass card/stacked/lime+lime
PASS  [tile fire-glow 3.0] tile .c4 border #8cff2b vs its own fire halo @edge (a=0.275) on any host: 5.51:1 (target 3:1) · worst at glass card/stacked
PASS  [tile fire-glow 4.5] tile .c5 gold label, 2 neighbour fire halos @16px (a=0.0207 each) on any host: 7.07:1 (target 4.5:1) · worst at glass card/stacked/gold+gold
PASS  [tile fire-glow 3.0] tile .c5 border #ffd24a vs its own fire halo @edge (a=0.275) on any host: 4.98:1 (target 3:1) · worst at glass card/stacked
PASS  [text 4.5] text on sheet next to the grid, fire halo @16px on sheet/panel: 15.8:1 (target 4.5:1) · worst at stacked/gold
PASS  [text 4.5] text-dim on sheet next to the grid, fire halo @16px on sheet/panel: 6.2:1 (target 4.5:1) · worst at stacked/gold
INFO  [info] no-falloff rest halo (peak alpha across a whole neighbour, glass/stacked): worst label: 4.81:1 · worst at unreachable bound
INFO  [info] no-falloff fire halo (peak alpha across a whole neighbour, glass/stacked): worst label: 2.46:1 · worst at unreachable bound
INFO  [info] tile .c1 cyan halo lift over sheet at edge: rest 1.20x · fire 1.90x (fire reach 18px vs rest 10px): 1.58:1 · worst at fire/rest
INFO  [info] tile .c2 magenta halo lift over sheet at edge: rest 1.11x · fire 1.44x (fire reach 18px vs rest 10px): 1.3:1 · worst at fire/rest
INFO  [info] tile .c3 violet halo lift over sheet at edge: rest 1.11x · fire 1.39x (fire reach 18px vs rest 10px): 1.26:1 · worst at fire/rest
INFO  [info] tile .c4 lime halo lift over sheet at edge: rest 1.22x · fire 2.03x (fire reach 18px vs rest 10px): 1.67:1 · worst at fire/rest
INFO  [info] tile .c5 gold halo lift over sheet at edge: rest 1.21x · fire 1.95x (fire reach 18px vs rest 10px): 1.61:1 · worst at fire/rest
PASS  [non-text 3.0] --border-control #8d78c4 vs glass card on glass card: 3.82:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] --border-control #8d78c4 vs glass card on sheet/panel: 5.02:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] --border-control #8d78c4 vs input fill on glass card: 5.19:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] --border-control #8d78c4 vs input fill on sheet/panel: 5.36:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] --focus-ring #22e6ff (2px) on page (bare aurora): 4.21:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] --focus-ring #22e6ff (2px) on glass card: 9.42:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] --focus-ring #22e6ff (2px) on sheet/panel: 12.36:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] --focus-ring #22e6ff (2px) on chrome: 12.18:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] online dot lime #8cff2b on glass card: 11.2:1 (target 3:1) · worst at stacked
PASS  [non-text 3.0] online dot lime #8cff2b on sheet/panel: 14.7:1 (target 3:1) · worst at stacked
INFO  [info] pinned card border rgba(255,60,200,.22) vs its own card on glass card: 1.3:1 · worst at cyan
```
The INFO rows are not gated. They document why a role is banned from a placement, and they record the pinned decorative hairline.

**3. Rendered-pixel check:** `.design-foundations/build/dna-render.mjs` renders the specimen in Chromium at 375 and 1440 (DPR 2), with both fonts loaded.
- **Surfaces:** it hides every descendant of each glass, sheet and chrome surface, then screenshots each of the 17 surfaces over the live aurora and takes its brightest pixel inside the corner radius. The brightest is `#3f113d` (a 375 px glass card near the magenta blob, luminance 0.0179). That is below the analytic bound `#322150`, so the bound is conservative. Against that real pixel: `--text` 13.43:1 · `--text-dim` 5.27:1 · `--magenta-text` 5.78:1 · `--violet-text` 7.43:1 · `--border-control` 4.13:1. All PASS.
- **Aurora visibility, 375 × 800 first screen, content hidden:** the draft (.28 / .26 / .25, legacy inset) had a mean lift of 4.8/255 over `--bg`, and 15 % of the screen lifted ≥ 12/255. Locked (.32 / .30 / .28 + portrait inset) has a mean lift of 9.6/255, 28 % of the screen lifted ≥ 12/255, and a peak of 58/255. For comparison, the draft alphas with the portrait inset give 8.3/255 and 26 %. So on a phone the inset does most of the work, and the alpha increase adds about 16 % on top. The magenta blob shows beside the page `h1` and the violet blob at the bottom right (`dna-specimen-375-fold.png`).
- **Tile glow:** the halo 4 px outside each tile's outer edge, against the host 15 px out, lifts 9–11/255 at rest vs 37/255 on the fired tile, at both widths. The "+ Custom" slot lifts 0.

## Space, shape, depth
- **Spacing:** a 4 px base (`--space-1`…`--space-16`). Space is tight within a group (8–12) and generous between groups (24–32); rhythm comes from grouping, not uniform padding. The gutter is 16 on mobile and 24 at ≥ 1024.
- **Radius:**
  - 12 for controls and tiles;
  - 16 for cards;
  - 22 for sheet tops;
  - pill for chips and status.
  - Avatars are round (they carry no card border or fill combo).
- **Borders:**
  - The pinned `--glass-border` (`rgba(255,60,200,.22)`, 1.31:1) is the **decorative edge of static containers**. WCAG 1.4.11 does not apply to a non-component container, and the card also reads by its fill and blur.
  - **Every interactive boundary is ≥ 3:1:**
    - inputs, outline buttons, tappable cards and segmented controls use `--border-control #8d78c4`: ≥ 3.82:1 against glass, 5.19:1 against the input fill;
    - tiles use their solid neon edge: ≥ 4.12:1 on every host and against their own fill, and ≥ 3.68:1 against their own fire halo;
    - the focus ring is 2 px `--neon-cyan` with a 2 px `--bg` gap: ≥ 4.71:1 even on bare aurora.
  - This resolves the Phase 2 carry-over "input and card boundaries ≥ 3:1" as the underlying mock-review finding framed it: interactive outlines ≥ 3:1, decorative dividers exempt.
- **No nested cards.** Inside a glass card, use rows with 1 px `--glass-border` dividers, never another glass box. Stat chips inside the compact strip are unboxed columns.
- **Shadows** are hue-shifted (`rgba(4,2,14,…)`), never pure black. There are three depths only: card, sheet and dialog (dialog = sheet + scrim).
- **Layering (z):** aurora −2 · grid −1 · content 0 · chrome 10 · mini-bar 20 · scrim 30 · sheet/dialog 40 · toast 50.

## Responsive
- **Mobile first, min-width queries only.** It is designed at 375 × 800; nothing is removed at larger widths, only reflowed.
- **Breakpoints (content-driven):**
  - **1024 px:** the nav switches from tab bar to sidebar. 240 sidebar + 360 Chat Board panel + ≥ 424 main means this is where the three coexist.
  - **1440 px:** the wide media grid (Clips).
  - Clips Studio aligns to 1024 (the shipped 960 moves, per the Phase 2 carry-over).
- **Container queries:** the soundboard grid is 2-up and becomes 3-up at ≥ 400 px container width. Presence and ranks sit side by side at a main width ≥ 880 px (PS-1).
- **Touch:** targets are ≥ 44 × 44 (`--tap-min`), and tiles are ≥ 64 px tall. Nothing relies on hover. `:hover` styles exist only inside `@media (hover: hover)` and are never the only affordance.
- **Safe areas:** `env(safe-area-inset-*)` padding on the top bar, tab bar, handle row and sheet.
- **Desktop type:** `xl`–`4xl` grow fluidly (see Type), and body stays 17 px.

## Motion
- **Timing:** micro 100 ms (press, toggle) · standard 240 ms (sheet, tab, tile sweep) · large 400 ms (dialog, page-level). The aurora runs 22 s alternate.
- **Easing:** `--ease-out` for entries, `--ease-in` for exits, `--ease-inout` for toggles. No bounce or elastic curves.
- **Allowed:** only `transform` and `opacity` are animated.
  - The aurora drift (the one ambient motion).
  - Tile press `scale(.96)` at 100 ms.
  - The scanline sweep on fire.
  - Sheet slide-up at 240 ms.
  - The skeleton shimmer.
  - Value count-ups on the hype meter (Phase 6).
  - The live pip pulse: at most one per screen, 1.2 s.
- **Never:**
  - staggered fade-up on page load;
  - hover glows;
  - animating width, height or top;
  - a second ambient animation;
  - glow pulses on cards.
- **`prefers-reduced-motion: reduce`:**
  - The **aurora drift stops** (`animation: none`); the blobs rest at their start position, and the grid is static anyway.
  - There is no sweep, no confetti and no press-scale. The tiles' **resting glow stays**, because a static glow is not motion.
  - Sheets and dialogs become opacity fades of ≤ 100 ms.
  - The skeleton shimmer becomes a static tint.
  - The live pip does not pulse.
- **Battery:** the drift pauses while `document.hidden`. The aurora is one fixed, blurred layer, rasterised once and moved with `transform` (`will-change: transform`).

## Never (this project's tells at risk)
- Neon as a **surface**: no neon-filled cards, no neon section backgrounds. A neon fill is allowed only on the one primary CTA and on small status pills.
- A white label on the magenta fill (3.17:1). Also magenta text, `--text-dim` or the wordmark placed on bare aurora.
- Glow outside the budget: the wordmark, the one primary CTA, the active nav marker, a fired tile, and the tiles' soft resting glow. A resting glow as strong as the fire glow is also out of budget.
- Gradient text anywhere but the wordmark. Metrics are solid colour.
- Nested cards (the measured #1 default tell), or the same card treatment on every block. Mix rows, strips, lists and one dominant element per screen.
- Orbitron below 15 px or in running text. Rajdhani below 16 px for running text, or at weights 300/400.
- Hue as the only differentiator: tiles, status and ranks always carry text.
- Cyan as "the" palette. It is one of five jobs, and cyan-on-dark dashboard chrome is the tell to avoid.
- A second ambient animation, bounce easing, or the load-in fade-up cascade.
- Inter, Roboto, Space Grotesk, or system-ui as a visible face. System fonts are fallback only.
- Pure `#000`/`#fff` surfaces. `#fff` is allowed only as the label on `--violet-fill-deep`.

## Open questions
- **JOURNEY.md sync (for the plan):** PS-0 and PS-1 say "48 px top bar". The owner's 64 px mascot needs `--topbar-h: 72px`. That costs the Squad first screen 24 px (3 % of 800), and the 12 % bottom-chrome budget is unaffected. JOURNEY.md should be updated to 72 px so the two files agree.
- Error/warning hue: the brand has no red. The palette.mjs `--gen-error-*` (hue 25) is the default. Phase 4 decides whether "warning" borrows gold, which would collide with achievement.
- Light theme: none. The dark theme is a content decision (late-night play, the identity), not a default. Revisit only if the owner asks.
