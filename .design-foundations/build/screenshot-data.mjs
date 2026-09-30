#!/usr/bin/env node
// screenshot-data.mjs — renders data.html at 375 and 1440px, captures full-page + above-fold
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("/home/opti3/gstack/node_modules/");
const { chromium } = require("playwright-core");

const __dir = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dir, "data.html");
const url = pathToFileURL(htmlPath).href;

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function shoot(width, height, outFile, fullPage) {
  const page = await browser.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: "networkidle" });

  // Confirm Orbitron loaded
  await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check("800 20px Orbitron");
  });

  const opts = fullPage ? { path: outFile, fullPage: true } : { path: outFile, clip: { x: 0, y: 0, width, height } };
  await page.screenshot(opts);
  console.log(`Wrote ${outFile} (${width}px, fullPage=${fullPage})`);
  await page.close();
}

const out = __dir;
// Full-page shots
await shoot(375,  812, join(out, "data-375.png"),  true);
await shoot(1440, 900, join(out, "data-1440.png"), true);
// Above-fold shots
await shoot(375,  812, join(out, "data-375-fold.png"),  false);
await shoot(1440, 900, join(out, "data-1440-fold.png"), false);

await browser.close();
console.log("Done.");
