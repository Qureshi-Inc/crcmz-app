#!/usr/bin/env node
// components-render.mjs: screenshot the component sheet at 375 and 1440.
// Waits for fonts.ready AND confirms Orbitron before screenshotting.
import { createRequire } from "node:module";
const require = createRequire("/home/opti3/gstack/node_modules/");
const { chromium } = require("playwright-core");

const DIR = new URL(".", import.meta.url).pathname;
const URL_ = "file://" + DIR + "components.html";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";

const browser = await chromium.launch({ executablePath: exe });
const results = {};

for (const [w, h] of [[375, 800], [1440, 900]]) {
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
  });

  await page.goto(URL_, { waitUntil: "networkidle" });

  // Wait for fonts.ready (DOM API)
  await page.evaluate(() => document.fonts.ready);

  // Extra wait: Google Fonts may need another tick after networkidle
  await page.waitForTimeout(800);

  // Check font load status
  const fonts = await page.evaluate(() => [
    `Orbitron-800:${document.fonts.check('800 20px "Orbitron"')}`,
    `Orbitron-700:${document.fonts.check('700 16px "Orbitron"')}`,
    `Rajdhani-500:${document.fonts.check('500 17px "Rajdhani"')}`,
  ]);
  results[`fonts${w}`] = fonts;
  console.log(`[${w}] font checks: ${fonts.join(", ")}`);

  // Full-page screenshot
  const fullPath = `${DIR}components-${w}.png`;
  await page.screenshot({ path: fullPath, fullPage: true });
  results[`screenshot${w}`] = fullPath;

  // Above-the-fold viewport screenshot (shows top bar + aurora)
  const foldPath = `${DIR}components-${w}-fold.png`;
  await page.screenshot({ path: foldPath, fullPage: false });
  results[`fold${w}`] = foldPath;

  console.log(`[${w}] full → ${fullPath}  fold → ${foldPath}`);
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
