// Render the marketing social cards. Two output PNGs:
//
//   site/og-card.html        → site/og.png        (1200×630, the OG default)
//   site/og-square-card.html → site/og-square.png (1080×1080, Instagram)
//
// Same pattern as scripts/make-icons.mjs: launch headless chromium via
// the bundled Playwright, point it at a `file://` URL for each source
// HTML, take a viewport-sized PNG screenshot. No network access required
// — the cards reference claudius.svg as a relative path next to them.
//
// The PNGs are what crawlers fetch from /og.png and /og-square.png. The
// HTML is the source of truth; the PNGs are build artifacts that we
// commit so the live site serves them without a render step in CI.
//
// Run with:  node scripts/render-og.mjs
//
// 1200×630 is the size LinkedIn / Facebook / Twitter summary_large_image
// all accept without re-cropping. 1080×1080 is the size Instagram and
// other 1:1-cropping surfaces use without slicing the layout in half.
//
// Note: social platforms cache OG images aggressively — after deploying,
// re-scrape via LinkedIn Post Inspector, X Card Validator, or the FB
// Sharing Debugger to refresh the cards.

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CARDS = [
  {
    source: path.join(ROOT, "site", "og-card.html"),
    out: path.join(ROOT, "site", "og.png"),
    width: 1200,
    height: 630,
    label: "1200×630",
  },
  {
    source: path.join(ROOT, "site", "og-square-card.html"),
    out: path.join(ROOT, "site", "og-square.png"),
    width: 1080,
    height: 1080,
    label: "1080×1080",
  },
];

const browser = await chromium.launch();
try {
  for (const card of CARDS) {
    const ctx = await browser.newContext({
      viewport: { width: card.width, height: card.height },
      deviceScaleFactor: 2, // retina-density PNG; platforms display at 1x
    });
    const page = await ctx.newPage();
    await page.goto(`file://${card.source}`, { waitUntil: "networkidle" });
    // Belt-and-braces: wait for the bust SVG to actually paint. Without
    // this a fast headless run can screenshot before the image element
    // resolves.
    await page.waitForFunction(() => {
      const img = document.querySelector(".bust img");
      return img && img.complete && img.naturalWidth > 0;
    });
    await page.screenshot({
      path: card.out,
      clip: { x: 0, y: 0, width: card.width, height: card.height },
      // omitBackground would give us a transparent PNG; we want the dark
      // background baked in so platforms don't composite onto white.
      omitBackground: false,
      type: "png",
    });
    console.log(`Wrote ${path.relative(ROOT, card.out)} (${card.label}@2x)`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
