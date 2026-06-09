// Render the marketing social card (site/og-card.html → site/og.png).
//
// Same pattern as scripts/make-icons.mjs: launch headless chromium via
// the bundled Playwright, point it at a `file://` URL for the source
// HTML, take a viewport-sized PNG screenshot. No network access required
// — the card references claudius.svg as a relative path next to it.
//
// The PNG is what crawlers fetch from /og.png. The HTML is the source of
// truth; the PNG is a build artifact (but we commit it so the live site
// can serve it without a render step in CI).
//
// Run with:  node scripts/render-og.mjs
//
// Output is 1200×630, the size LinkedIn / Facebook / Twitter
// summary_large_image all accept without re-cropping. Note: social
// platforms cache OG images aggressively — after deploying, re-scrape
// via LinkedIn Post Inspector, X Card Validator, or the FB Sharing
// Debugger to refresh the cards.

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "site", "og-card.html");
const OUT = path.join(ROOT, "site", "og.png");

const WIDTH = 1200;
const HEIGHT = 630;

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2, // retina-density PNG; platforms display at 1x
  });
  const page = await ctx.newPage();
  await page.goto(`file://${SOURCE}`, { waitUntil: "networkidle" });
  // Belt-and-braces: wait for the bust SVG to actually paint. Without this
  // a fast headless run can screenshot before the image element resolves.
  await page.waitForFunction(() => {
    const img = document.querySelector(".bust img");
    return img && img.complete && img.naturalWidth > 0;
  });
  await page.screenshot({
    path: OUT,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    // omitBackground would give us a transparent PNG; we want the dark
    // background baked in so platforms don't composite onto white.
    omitBackground: false,
    type: "png",
  });
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${WIDTH}×${HEIGHT}@2x)`);
} finally {
  await browser.close();
}
