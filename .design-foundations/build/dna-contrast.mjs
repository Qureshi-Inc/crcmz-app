#!/usr/bin/env node
// dna-contrast.mjs: Phase 3 contrast gate for the CRCMZ DESIGN.md tokens.
//
// palette.mjs verifies the ramps it generates, but it cannot check pinned
// brand hexes or translucent glass over a moving aurora. This script checks
// those pairs using palette.mjs's OWN WCAG 2.x implementation. The
// `luminance` + `contrast` functions are extracted from the palette.mjs
// source at runtime, so there is no re-implemented formula to drift.
//
// Worst case = the "stacked-peak bound": all three aurora blobs at their
// peak alpha composited on the same pixel, plus a scanline crossing, with no
// credit taken for blur falloff. No real pixel can be brighter at any
// viewport, drift phase or scale. Every surface is checked at that bound AND
// over the flat base. The reported ratio is the minimum of the two.
//
// Usage: node dna-contrast.mjs [--json]    exit 0 = all gated pairs pass, 2 = a gated pair fails

import { readFileSync } from "node:fs";

const PALETTE = "/home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/palette.mjs";
const src = readFileSync(PALETTE, "utf8");
const wcag = src.slice(src.indexOf("// ---------- WCAG contrast"), src.indexOf("// ---------- ramp construction"));
const { contrast } = new Function(`${wcag}; return { luminance, contrast };`)();

// ---- colour helpers (0-255 rgb in, palette.mjs wants 0-1) ----
const hex = (h) => { const m = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16)); };
const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
const ratio = (fg, bg) => contrast(fg.map((x) => x / 255), bg.map((x) => x / 255));
const toHex = (c) => "#" + c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");

// ---- DESIGN.md tokens under test (keep in lockstep with DESIGN.md) ----
const T = {
  bg: "#05030f",
  aurora: { magenta: [255, 47, 214, 0.32], cyan: [34, 230, 255, 0.30], violet: [157, 92, 255, 0.28] }, // owner 2026-09-30: back up to the 30-32 band, capped at legacy (.34/.30/.28)
  scan: { cyan: [34, 230, 255, 0.035 * 0.5], magenta: [255, 47, 214, 0.03 * 0.5] }, // body::after opacity .5
  glass: [18, 10, 38, 0.66],      // pinned card fill
  sheet: [12, 8, 28, 0.92],       // bottom sheet / side panel / dialog
  chrome: [8, 5, 20, 0.86],       // top bar, tab bar, sidebar
  input: [6, 4, 18, 0.8],         // field fill (legacy)
  cardBorderPin: [255, 60, 200, 0.22], // pinned, decorative
};
const base = hex(T.bg);
const scanned = (c) => over(T.scan.magenta, over(T.scan.cyan, c));
// Stacked-peak bound. CSS paints the first background layer on top: violet → cyan → magenta.
const auroraWorst = scanned(over(T.aurora.magenta, over(T.aurora.cyan, over(T.aurora.violet, base))));
// Per-blob peaks: a single blob's hue can be the harder background for a same-hue text colour.
const blobPeaks = Object.fromEntries(Object.entries(T.aurora).map(([k, v]) => [k, scanned(over(v, base))]));

const backdrops = { flat: base, stacked: auroraWorst, ...blobPeaks };
const surf = (layer) => Object.fromEntries(Object.entries(backdrops).map(([k, b]) => [k, layer ? over(layer, b) : b]));
const S = {
  "page (bare aurora)": surf(null),
  "glass card": surf(T.glass),
  "sheet/panel": surf(T.sheet),
  chrome: surf(T.chrome),
};

// Text roles.
const X = {
  text: "#f3ecff", "text-dim": "#9d8fc4",
  "magenta-text": "#ff5ce0", "cyan-text": "#22e6ff", "lime-text": "#8cff2b",
  "violet-text": "#c1a5ff", "gold-text": "#ffd24a",
  // palette.mjs generated functional text steps (--gen-*-11), for Phase 4.
  "gen-error-11": "#ff958d", "gen-success-11": "#71d176", "gen-warning-11": "#d6b267", "gen-info-11": "#7bc0f0",
};

const rows = [];
const gate = (group, label, target, fgFn, surfaces) => {
  for (const [sname, variants] of Object.entries(surfaces)) {
    let worst = Infinity, where = "";
    for (const [vk, bg] of Object.entries(variants)) {
      const r = ratio(fgFn(bg), bg);
      if (r < worst) { worst = r; where = vk; }
    }
    rows.push({ group, pair: `${label} on ${sname}`, ratio: +worst.toFixed(2), worstAt: where, target, pass: target == null ? null : worst >= target });
  }
};

// 1. Body/UI text roles: 4.5:1 on every surface text can sit on.
for (const [k, v] of Object.entries(X)) {
  // Role rule (DESIGN.md §Color roles): only --text may sit on bare aurora; every other text role lives on a surface.
  const surfaces = k === "text" ? S : { "glass card": S["glass card"], "sheet/panel": S["sheet/panel"], chrome: S.chrome };
  gate("text 4.5", k, 4.5, () => hex(v), surfaces);
}
// Bare-aurora neon text is limited to large display type (page h1 accent, stat numerals): 3:1.
// Magenta is excluded by rule (2.68:1 at the stacked bound, see the INFO row); it never sets text on bare aurora.
for (const k of ["cyan-text", "lime-text", "violet-text", "gold-text"])
  gate("large 3.0", `${k} (large)`, 3.0, () => hex(X[k]), { "page (bare aurora)": S["page (bare aurora)"] });
// Wordmark gradient ends (Orbitron 900 ≥ 20px = large) on chrome.
for (const [k, v] of Object.entries({ "wordmark cyan end": "#22e6ff", "wordmark magenta end": "#ff2fd6" }))
  gate("large 3.0", k, 3.0, () => hex(v), { chrome: S.chrome, "glass card": S["glass card"], "sheet/panel": S["sheet/panel"] });
// Why the rules above exist (informational, the roles are banned there, not gated).
gate("info", "magenta-text #ff5ce0 on bare aurora (BANNED role)", null, () => hex(X["magenta-text"]), { "page (bare aurora)": S["page (bare aurora)"] });
gate("info", "text-dim on bare aurora (BANNED role)", null, () => hex(X["text-dim"]), { "page (bare aurora)": S["page (bare aurora)"] });
gate("info", "wordmark magenta end on bare aurora (BANNED placement)", null, () => hex("#ff2fd6"), { "page (bare aurora)": S["page (bare aurora)"] });

// 2. Solid fills (opaque, so the backdrop is irrelevant).
const solid = (label, fg, bg, target) => {
  const r = ratio(hex(fg), hex(bg));
  rows.push({ group: `fill ${target}`, pair: `${label}`, ratio: +r.toFixed(2), worstAt: "opaque", target, pass: r >= target });
};
solid("ink #0b0616 label on magenta fill #ff2fd6 (primary button)", "#0b0616", "#ff2fd6", 4.5);
solid("ink #0b0616 label on cyan fill #22e6ff", "#0b0616", "#22e6ff", 4.5);
solid("ink #0b0616 label on lime fill #8cff2b", "#0b0616", "#8cff2b", 4.5);
solid("ink #0b0616 label on gold fill #ffd24a", "#0b0616", "#ffd24a", 4.5);
solid("white label on violet-deep fill #7a3cf0", "#ffffff", "#7a3cf0", 4.5);
// Documented rejection: the edge case the plan names. Informational (target null), not a token.
rows.push({ group: "rejected", pair: "white #ffffff label on magenta fill #ff2fd6 (REJECTED role)", ratio: +ratio(hex("#ffffff"), hex("#ff2fd6")).toFixed(2), worstAt: "opaque", target: null, pass: null });

// 3. Soundboard tiles: tinted fill over the sheet (mobile) or glass panel (desktop). Label 4.5, border 3.0.
const tiles = {
  c1: { name: "cyan", rgb: [34, 230, 255], label: "#c8fbff", edge: "#22e6ff" },
  c2: { name: "magenta", rgb: [255, 47, 214], label: "#ffd6f6", edge: "#ff5ce0" },
  c3: { name: "violet", rgb: [157, 92, 255], label: "#e4d4ff", edge: "#b18cff" },
  c4: { name: "lime", rgb: [140, 255, 43], label: "#e0ffc0", edge: "#8cff2b" },
  c5: { name: "gold", rgb: [255, 210, 74], label: "#fff0c0", edge: "#ffd24a" },
};
const tileHost = { "sheet/panel": S["sheet/panel"], "glass card": S["glass card"] };
for (const [c, t] of Object.entries(tiles)) {
  const fill = (bg) => over([...t.rgb, 0.2], bg); // gradient peak .20 (brightest corner)
  gate("tile label 4.5", `tile .${c} ${t.name} label ${t.label}`, 4.5, () => hex(t.label), Object.fromEntries(Object.entries(tileHost).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([vk, bg]) => [vk, fill(bg)]))])));
  gate("tile edge 3.0", `tile .${c} border ${t.edge} vs host`, 3.0, () => hex(t.edge), tileHost);
  gate("tile edge 3.0", `tile .${c} border ${t.edge} vs its own fill`, 3.0, () => hex(t.edge), Object.fromEntries(Object.entries(tileHost).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([vk, bg]) => [vk, fill(bg)]))])));
}

// 3b. Tile glow (owner 2026-09-30: every tile has a soft resting glow; the fired glow is stronger).
// CSS box-shadow blur B is a Gaussian with sigma = B/2 (CSS Backgrounds 3). At distance d outside the tile edge the
// halo alpha is peak * (1 - Phi(d / sigma)), which is peak/2 AT the edge. Geometry (DESIGN.md tokens): tile gap 8px,
// tile padding >= 8px, so a label glyph sits >= 16px from any neighbour's edge. Worst case = TWO neighbour halos
// (a row and a column neighbour, any hues) stacked at that distance over the host at every aurora bound, then this
// tile's own fill at its brightest corner (.20), then the label. The border is gated against its own halo at d = 0.
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const halo = (peak, blur, d) => peak * (1 - 0.5 * (1 + erf(d / (blur / 2) / Math.SQRT2)));
const GLOW = { rest: { alpha: 0.22, blur: 10 }, fire: { alpha: 0.55, blur: 18 } }; // --glow-tile-{rest,fire}-{alpha,blur}
const LABEL_D = 16, TEXT_D = 16; // label -> neighbour edge; board heading / composer label -> nearest tile edge
for (const [gk, g] of Object.entries(GLOW)) {
  const aL = halo(g.alpha, g.blur, LABEL_D), aE = halo(g.alpha, g.blur, 0);
  for (const [c, t] of Object.entries(tiles)) {
    const variants = {};
    for (const [hk, hv] of Object.entries(tileHost))
      for (const [vk, bg] of Object.entries(hv))
        for (const n1 of Object.values(tiles)) for (const n2 of Object.values(tiles))
          variants[`${hk}/${vk}/${n1.name}+${n2.name}`] = over([...t.rgb, 0.2], over([...n2.rgb, aL], over([...n1.rgb, aL], bg)));
    gate(`tile ${gk}-glow 4.5`, `tile .${c} ${t.name} label, 2 neighbour ${gk} halos @${LABEL_D}px (a=${aL.toFixed(4)} each)`, 4.5, () => hex(t.label), { "any host": variants });
    const edgeVariants = {};
    for (const [hk, hv] of Object.entries(tileHost))
      for (const [vk, bg] of Object.entries(hv)) edgeVariants[`${hk}/${vk}`] = over([...t.rgb, aE], bg);
    gate(`tile ${gk}-glow 3.0`, `tile .${c} border ${t.edge} vs its own ${gk} halo @edge (a=${aE.toFixed(3)})`, 3.0, () => hex(t.edge), { "any host": edgeVariants });
  }
  for (const k of ["text", "text-dim"]) {
    const a = halo(g.alpha, g.blur, TEXT_D), variants = {};
    for (const [vk, bg] of Object.entries(S["sheet/panel"])) for (const n of Object.values(tiles)) variants[`${vk}/${n.name}`] = over([...n.rgb, a], bg);
    gate("text 4.5", `${k} on sheet next to the grid, ${gk} halo @${TEXT_D}px`, 4.5, () => hex(X[k]), { "sheet/panel": variants });
  }
}
// The same checks with NO falloff credit (peak alpha everywhere) are physically unreachable; recorded, not gated.
for (const [gk, g] of Object.entries(GLOW)) {
  let w = Infinity;
  for (const t of Object.values(tiles)) for (const n of Object.values(tiles)) w = Math.min(w, ratio(hex(t.label), over([...t.rgb, 0.2], over([...n.rgb, g.alpha], over(T.glass, auroraWorst)))));
  rows.push({ group: "info", pair: `no-falloff ${gk} halo (peak alpha across a whole neighbour, glass/stacked): worst label`, ratio: +w.toFixed(2), worstAt: "unreachable bound", target: null, pass: null });
}
// Rest must read clearly weaker than fire (owner: firing stays a distinct event). Peak halo lift at the tile edge.
{
  const hostBg = S["sheet/panel"].flat;
  for (const [c, t] of Object.entries(tiles)) {
    const lr = ratio(over([...t.rgb, halo(GLOW.rest.alpha, GLOW.rest.blur, 0)], hostBg), hostBg);
    const lf = ratio(over([...t.rgb, halo(GLOW.fire.alpha, GLOW.fire.blur, 0)], hostBg), hostBg);
    rows.push({ group: "info", pair: `tile .${c} ${t.name} halo lift over sheet at edge: rest ${lr.toFixed(2)}x · fire ${lf.toFixed(2)}x (fire reach ${GLOW.fire.blur}px vs rest ${GLOW.rest.blur}px)`, ratio: +(lf / lr).toFixed(2), worstAt: "fire/rest", target: null, pass: null });
  }
}

// 4. Non-text: interactive boundaries + focus ring (WCAG 1.4.11).
gate("non-text 3.0", "--border-control #8d78c4 vs glass card", 3.0, () => hex("#8d78c4"), { "glass card": S["glass card"], "sheet/panel": S["sheet/panel"] });
gate("non-text 3.0", "--border-control #8d78c4 vs input fill", 3.0, () => hex("#8d78c4"), Object.fromEntries(Object.entries({ "glass card": S["glass card"], "sheet/panel": S["sheet/panel"] }).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([vk, bg]) => [vk, over(T.input, bg)]))])));
gate("non-text 3.0", "--focus-ring #22e6ff (2px)", 3.0, () => hex("#22e6ff"), S);
gate("non-text 3.0", "online dot lime #8cff2b", 3.0, () => hex("#8cff2b"), { "glass card": S["glass card"], "sheet/panel": S["sheet/panel"] });

// 5. Informational: the pinned decorative card hairline (not a UI-component boundary; 1.4.11 N/A).
gate("info", "pinned card border rgba(255,60,200,.22) vs its own card", null, (bg) => over(T.cardBorderPin, bg), { "glass card": S["glass card"] });

// ────────────────────────────────────────────────────────────────────────────
// 6. Phase 6: Chart mark fills — non-text graphical objects (WCAG 1.4.11, ≥3:1).
//    Each neon fill used as a bar/mark colour is checked against the glass card
//    surface (worst-case = stacked aurora).  The sheet/panel host is also checked.
//    These are opaque fills drawn over the card; the backdrop only matters for the
//    card surface they sit on (contrast is fill vs card-surface, not fill vs aurora).
// ────────────────────────────────────────────────────────────────────────────
const chartHost = { "glass card": S["glass card"], "sheet/panel": S["sheet/panel"] };
const chartMarks = {
  "neon-cyan bar fill #22e6ff":     "#22e6ff",
  "neon-lime bar fill #8cff2b":     "#8cff2b",
  "neon-gold bar fill #ffd24a":     "#ffd24a",
  "neon-magenta bar fill #ff2fd6":  "#ff2fd6",
  "neon-violet bar fill #9d5cff":   "#9d5cff",
  "border-control gridline #8d78c4": "#8d78c4",
};
for (const [label, fillHex] of Object.entries(chartMarks))
  gate("chart mark 3.0", label, 3.0, () => hex(fillHex), chartHost);

// ────────────────────────────────────────────────────────────────────────────
// 7. Phase 6: Heatmap ramp steps — single-hue alpha ramps over the glass card
//    surface (worst-case = stacked aurora).  Two ramps are used:
//      • Cyan  (#22e6ff) for the WhatsApp heatmap (WA-08)
//      • Lime  (#8cff2b) for the Slap heatmap    (SL-13)
//    Only the three non-empty alpha stops are gated (the zero-count cell IS the
//    card surface; there is no fill to measure).  Adjacent stops that fall below
//    3:1 against each other are noted as INFO — those cells carry tap-to-inspect
//    count values (DW-6.2 "or the cells must carry value labels").
// ────────────────────────────────────────────────────────────────────────────
const hmRamps = [
  { name: "cyan",  rgb: [34, 230, 255], stops: [0.55, 0.75, 1.0] },
  { name: "lime",  rgb: [140, 255, 43], stops: [0.50, 0.75, 1.0] },
];
for (const ramp of hmRamps) {
  for (const alpha of ramp.stops) {
    const label = `heatmap ${ramp.name} α=${alpha} vs glass card (non-text)`;
    gate("heatmap ramp 3.0", label, 3.0,
      (bg) => over([...ramp.rgb, alpha], bg),
      { "glass card": S["glass card"] });
  }
  // Informational: adjacent stop distinguishability (fill-vs-fill, not vs card).
  for (let i = 0; i < ramp.stops.length - 1; i++) {
    const a1 = ramp.stops[i], a2 = ramp.stops[i + 1];
    // Compare the two alpha-composited fills over glass-on-flat (fixed backdrop).
    const bg = over(T.glass, base);
    const f1 = over([...ramp.rgb, a1], bg), f2 = over([...ramp.rgb, a2], bg);
    const r = ratio(f1, f2);
    rows.push({ group: "info", pair: `heatmap ${ramp.name} α=${a1}→α=${a2} adjacent-step contrast (INFO; cells carry value labels)`, ratio: +r.toFixed(2), worstAt: "glass/flat", target: null, pass: null });
  }
}

const gated = rows.filter((r) => r.pass !== null);
const fails = gated.filter((r) => !r.pass);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ worstCase: { auroraStacked: toHex(auroraWorst), glassOnStacked: toHex(over(T.glass, auroraWorst)) }, rows }, null, 2));
} else {
  console.log(`/* dna-contrast.mjs: WCAG math from ${PALETTE} */`);
  console.log(`/* stacked-peak aurora = ${toHex(auroraWorst)} · glass over it = ${toHex(over(T.glass, auroraWorst))} · glass over flat = ${toHex(over(T.glass, base))} */`);
  for (const r of rows)
    console.log(`${r.pass === null ? "INFO" : r.pass ? "PASS" : "FAIL"}  [${r.group}] ${r.pair}: ${r.ratio}:1${r.target ? ` (target ${r.target}:1)` : ""} · worst at ${r.worstAt}`);
  console.log(`\n${gated.length - fails.length}/${gated.length} gated pairs pass.`);
}
if (fails.length) { console.error(`${fails.length} gated pair(s) below target.`); process.exit(2); }
