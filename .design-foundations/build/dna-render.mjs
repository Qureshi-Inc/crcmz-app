#!/usr/bin/env node
// dna-render.mjs: screenshot the DNA specimen and sample real rendered surface pixels.
// 1. Full-page PNGs at 375 and 1440, plus above-the-fold viewport PNGs (where the fixed aurora renders true to size).
// 2. Surface pass: every descendant of .glass/.sheet/.chrome is hidden, then each surface is scrolled into view and
//    element-screenshotted over the live aurora. The brightest pixel per surface is written to dna-pixels.json.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire("/home/opti3/gstack/node_modules/");
const { chromium } = require("playwright-core");

const DIR = new URL(".", import.meta.url).pathname;
const URL_ = "file://" + DIR + "dna-specimen.html";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const browser = await chromium.launch({ executablePath: exe });
const out = { surfaces: [] };
import { mkdirSync } from "node:fs";
mkdirSync("/tmp/dna", { recursive: true });

for (const [w, h] of [[375, 800], [1440, 900]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.goto(URL_, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  out[`fonts${w}`] = await page.evaluate(() => ["Orbitron", "Rajdhani"].map((f) => `${f}:${document.fonts.check(`16px ${f}`)}`));
  await page.screenshot({ path: `${DIR}dna-specimen-${w}.png`, fullPage: true });
  await page.screenshot({ path: `${DIR}dna-specimen-${w}-fold.png` });
  // Tile rects (for the rest-vs-fire glow pixel check) in fold-screenshot CSS px, after scrolling the board into view.
  await page.locator(".tiles").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/dna/tiles-${w}.png` });
  out[`tiles${w}`] = await page.$$eval(".tile", (els) => els.map((e) => ({ cls: e.className, ...e.getBoundingClientRect().toJSON() })));
  await page.evaluate(() => window.scrollTo(0, 0));
  if (w === 375) {
    // Aurora visibility probe: first screen with ALL content hidden, at the locked alphas vs the rejected draft alphas.
    const hide = await page.addStyleTag({ content: ".app { visibility: hidden !important; }" });
    await page.screenshot({ path: "/tmp/dna/aurora-375-locked.png" });
    const draft = await page.addStyleTag({ content: ":root { --aurora-magenta: rgba(255,47,214,.28) !important; --aurora-cyan: rgba(34,230,255,.26) !important; --aurora-violet: rgba(157,92,255,.25) !important; }" });
    await page.screenshot({ path: "/tmp/dna/aurora-375-draft.png" });
    await draft.evaluate((n) => n.remove()); await hide.evaluate((n) => n.remove());
  }
  await page.addStyleTag({ content: ".glass *, .sheet *, .chrome * { visibility: hidden !important; }" });
  const n = await page.locator(".glass, .sheet, .chrome").count();
  for (let i = 0; i < n; i++) {
    const el = page.locator(".glass, .sheet, .chrome").nth(i);
    if (!(await el.isVisible())) continue;
    await el.scrollIntoViewIfNeeded();
    const cls = await el.evaluate((e) => e.className);
    const file = `/tmp/dna/surf-${w}-${i}.png`;
    await el.screenshot({ path: file });
    out.surfaces.push({ width: w, i, cls, file });
  }
  await page.close();
}
await browser.close();
writeFileSync("/tmp/dna/surfaces.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ fonts375: out.fonts375, fonts1440: out.fonts1440, surfaces: out.surfaces.length }));
