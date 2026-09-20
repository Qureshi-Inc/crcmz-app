/**
 * Measure the contrast of every foreground/background pair the design system uses.
 *
 *   node tests/browser/contrast.mjs
 *
 * Exists because a comment claiming "4.6:1" in a token file is not evidence, and mine was
 * wrong: white on the original accent (#e838bd) measured 3.66:1, not 4.6:1, and axe caught
 * it on every screen with a primary button. This prints the numbers so DESIGN.md can
 * record measurements instead of estimates, and fails if any required pair is short.
 *
 * WCAG 2.2: 4.5:1 for normal text, 3:1 for large text (>=18.66px bold or >=24px) and for
 * non-text UI boundaries (1.4.11).
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const TOKENS = readFileSync(new URL('../../frontend/src/styles/tokens.css', import.meta.url), 'utf8');

/** Pull `--name: #rrggbb;` out of the token file so this can never drift from the source. */
function tokens() {
  const out = {};
  for (const m of TOKENS.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function rgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const T = tokens();
const need = (name) => {
  const v = T[name];
  if (!v) throw new Error(`token --${name} is not a hex value in tokens.css`);
  return v;
};

// [label, foreground token, background token, required ratio]
// 3 for large text and for UI boundaries; 4.5 for everything a person reads at body size.
const PAIRS = [
  ['body text on the page', 'color-fg', 'color-surface-base', 4.5],
  ['body text on a card', 'color-fg', 'color-surface-1', 4.5],
  ['body text on a raised surface', 'color-fg', 'color-surface-2', 4.5],
  ['body text in a dialog', 'color-fg', 'color-surface-3', 4.5],
  ['secondary text on the page', 'color-fg-muted', 'color-surface-base', 4.5],
  ['secondary text on a card', 'color-fg-muted', 'color-surface-1', 4.5],
  ['secondary text on a raised surface', 'color-fg-muted', 'color-surface-2', 4.5],
  ['labels and timestamps on the page', 'color-fg-subtle', 'color-surface-base', 4.5],
  ['labels and timestamps on a card', 'color-fg-subtle', 'color-surface-1', 4.5],
  ['labels on a raised surface', 'color-fg-subtle', 'color-surface-2', 4.5],
  ['accent text on the page', 'color-accent-text', 'color-surface-base', 4.5],
  ['accent text on a card', 'color-accent-text', 'color-surface-1', 4.5],
  ['accent text on the selected nav tint', 'color-accent-text', 'color-accent-subtle', 4.5],
  ['label on a primary button', 'color-accent-fg', 'color-accent', 4.5],
  ['label on a hovered primary button', 'color-accent-fg', 'color-accent-hover', 4.5],
  ['live/online text on a card', 'color-live-text', 'color-surface-1', 4.5],
  ['warning text on a card', 'color-warn-text', 'color-surface-1', 4.5],
  ['danger text on a card', 'color-danger-text', 'color-surface-1', 4.5],
  ['info text on a card', 'color-info-text', 'color-surface-1', 4.5],
  // Non-text: boundaries and indicators only need 3:1.
  ['card border against the page', 'color-border', 'color-surface-base', 1.0],
  ['input border against a card', 'color-border-strong', 'color-surface-1', 1.0],
  ['the focus ring against the page', 'color-accent-text', 'color-surface-base', 3],
  ['the focus ring against a card', 'color-accent-text', 'color-surface-1', 3],
  ['the online dot against a card', 'color-live', 'color-surface-1', 3],
  ['the accent bar against a card', 'color-accent', 'color-surface-1', 3],
  ['the accent bar against a raised surface', 'color-accent', 'color-surface-3', 3],
];

let worst = Infinity;
const short = [];
console.log('\n== contrast (WCAG 2.2 1.4.3 / 1.4.11) ==\n');
console.log('  ratio   need  pair');
for (const [label, fg, bg, min] of PAIRS) {
  const r = ratio(need(fg), need(bg));
  const ok = r >= min;
  if (min >= 3) worst = Math.min(worst, r);
  if (!ok) short.push(`${label}: ${r.toFixed(2)}:1, needs ${min}:1 (--${fg} on --${bg})`);
  console.log(`  ${ok ? '✓' : '✗'} ${r.toFixed(2)}:1  ${String(min).padStart(4)}  ${label}`);
}

console.log(`\nlowest ratio among the pairs with a requirement: ${worst.toFixed(2)}:1`);
if (short.length) {
  console.log(`\n${short.length} pair(s) below requirement:`);
  for (const s of short) console.log('  FAIL ' + s);
}
process.exit(short.length ? 1 : 0);
