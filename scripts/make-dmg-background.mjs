// Generate the macOS DMG window background for the Claudius desktop release.
//
// What it draws (540×380 canvas; electron-builder's default DMG window):
//   • cream-glow radial backdrop (warm brand tint top, fading to off-white)
//   • headline "Install Claudius" + sublabel
//   • the brand mark (terracotta squircle + archaic 𐌂 glyph) in the corner
//   • a dashed arrow between the two drop zones at y=220 (matches the icon
//     positions wired in electron-builder.yml: app at x=130, link at x=410)
//
// Output:
//   • build/dmg-background.svg          — design source (SVG, vector)
//   • build/background.png              — 540×380 (electron-builder's @1x)
//   • build/background@2x.png           — 1080×760 (electron-builder picks
//                                          this automatically on Retina)
//
// Pipeline (mirrors scripts/make-icons.mjs): compose the SVG, then rasterize
// via headless Chromium. Chromium honours CSS / SVG layout exactly, so the
// rendered PNG matches the design source pixel-for-pixel — no font/SVG quirk
// surprises from a 3rd-party rasterizer.
//
// Run with:  node scripts/make-dmg-background.mjs

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build");

// ── geometry ───────────────────────────────────────────────────────────────
// 540×380 is electron-builder's default DMG window size. The two icon
// centres (in DMG content coordinates) are wired in electron-builder.yml:
//   app  → (130, 220)
//   apps → (410, 220)
// The hint arrow sits between them at y=220.
const W = 540;
const H = 380;
const ICON_Y = 220;
const ARROW_FROM_X = 222;
const ARROW_TO_X = 318;

// ── brand mark ─────────────────────────────────────────────────────────────
// Reuses the SAME archaic 𐌂 glyph baked into scripts/make-icons.mjs so the
// DMG window's corner badge reads as the same identity the desktop dock icon
// does. The glyph is rendered inside a small terracotta squircle in the
// upper-right corner of the DMG window.
const GLYPH =
  "M449 -22Q361 12 289.5 58.5Q218 105 166.5 158.0Q115 211 87.0 264.5Q59 318 59 365Q59 426 103.5 495.0Q148 564 234.0 627.5Q320 691 445 732L485 655Q396 623 333.5 583.0Q271 543 232.0 502.0Q193 461 175.0 424.5Q157 388 157 362Q157 325 193.0 269.5Q229 214 302.0 156.0Q375 98 487 53Z";
const GLYPH_SCALE = 0.74271;
const GLYPH_TX = 309.24;
const GLYPH_TY = 775.66;

const BRAND = 48; // brand-mark squircle edge in DMG-window pixels
const BRAND_X = W - BRAND - 24; // 24px inset from right
const BRAND_Y = 24; // 24px from top
// The glyph inside icon.svg occupies the 1024-unit canvas; scale it to fill
// ~80% of the brand-mark square so it reads at this size.
const GLYPH_FIT = (BRAND / 1024) * 1.25;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="14%" r="78%">
      <stop offset="0%" stop-color="#f7d2bd"/>
      <stop offset="42%" stop-color="#fbeee4"/>
      <stop offset="100%" stop-color="#fbf7f2"/>
    </radialGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e08a64"/>
      <stop offset="1" stop-color="#c9694a"/>
    </linearGradient>
  </defs>

  <!-- Backdrop -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- Headline -->
  <text x="${W / 2}" y="56" text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Helvetica', sans-serif"
        font-size="17" font-weight="600" fill="#5a3a2a"
        letter-spacing="0.4">Install Claudius</text>
  <text x="${W / 2}" y="80" text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Helvetica', sans-serif"
        font-size="12" fill="#8a6a5a">Drag the app into your Applications folder</text>

  <!-- Brand mark, upper right -->
  <g transform="translate(${BRAND_X}, ${BRAND_Y})">
    <rect width="${BRAND}" height="${BRAND}" rx="11" fill="url(#brand)"/>
    <g transform="translate(${BRAND / 2}, ${BRAND / 2}) scale(${GLYPH_FIT}) translate(-512, -512)">
      <path d="${GLYPH}" fill="#fff"
            transform="translate(${GLYPH_TX} ${GLYPH_TY}) scale(${GLYPH_SCALE} -${GLYPH_SCALE})"/>
    </g>
  </g>

  <!-- Dashed hint arrow between the two drop zones (icons at y=${ICON_Y}) -->
  <g opacity="0.7">
    <line x1="${ARROW_FROM_X}" y1="${ICON_Y}" x2="${ARROW_TO_X - 6}" y2="${ICON_Y}"
          stroke="#c9694a" stroke-width="2.4"
          stroke-linecap="round" stroke-dasharray="4 7"/>
    <polygon points="${ARROW_TO_X},${ICON_Y} ${ARROW_TO_X - 12},${ICON_Y - 7} ${ARROW_TO_X - 12},${ICON_Y + 7}"
             fill="#c9694a"/>
  </g>
</svg>`;

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "dmg-background.svg"), svg);
console.log("· wrote build/dmg-background.svg");

const browser = await chromium.launch();
try {
  for (const [name, dpr] of [
    ["background.png", 1],
    ["background@2x.png", 2],
  ]) {
    const page = await browser.newPage({
      viewport: { width: W, height: H },
      deviceScaleFactor: dpr,
    });
    await page.setContent(
      `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
      { waitUntil: "load" },
    );
    const out = path.join(OUT, name);
    await page.locator("svg").screenshot({ path: out });
    console.log(`· wrote build/${name} (${W * dpr}×${H * dpr})`);
  }
} finally {
  await browser.close();
}

console.log("✓ DMG background regenerated.");
