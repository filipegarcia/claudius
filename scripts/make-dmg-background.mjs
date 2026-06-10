// Generate the macOS DMG window background for the Claudius desktop release.
//
// What it draws (540×380 canvas; electron-builder's default DMG window):
//   • cream-glow radial backdrop (warm brand tint top, fading to off-white)
//   • headline "Install Claudius" + sublabel
//   • the Claudius bust silhouette in the upper-right corner (the SAME mark
//     used by site/index.html and components/brand/claudius-svg.ts — read
//     verbatim from public/claudius.svg so changes there flow through)
//   • a dashed arrow between the two drop zones at y=220 (matches the icon
//     positions wired in electron-builder.yml: app at x=130, link at x=410)
//   • a three-line first-launch helper below the drag row (y≈295–329) that
//     explains the macOS Gatekeeper bypass. The release pipeline is unsigned
//     (no Apple Developer ID — see .github/workflows/release.yml header), so
//     every first-time user hits the "Apple could not verify Claudius" dialog
//     on Sequoia and has nowhere to look for the bypass. By the time that
//     dialog appears, the binary hasn't run, so the app cannot self-document
//     the workaround; the DMG background is the only in-flow surface we
//     control. Wording is the macOS 15 path — older bypasses (right-click →
//     Open) were removed in Sequoia.
//
// Why the bust and not the app squircle: the .app icon (the orange squircle +
// archaic 𐌂 glyph) already sits in the centre-left of the DMG window. Putting
// the same squircle in the corner read as "two logos of the same thing" — the
// bust is the marketing illustration, distinct from the app icon, so it stamps
// identity without competing visually with the drag-this-to-Applications cue.
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// ── bust silhouette ────────────────────────────────────────────────────────
// Source: public/claudius.svg (600×750 viewBox; black-fill silhouette of the
// Roman bust used across the marketing surface). We read the file at build
// time and embed its inner content verbatim — that way edits to the canonical
// SVG flow into the DMG background without manual sync.
//
// Recolour: the on-disk SVG hardcodes fill="#000". On the cream gradient that
// reads too stark, so we swap to the same warm dark-brown the headline uses
// (#5a3a2a) for a softer, more printed-poster feel.
const claudiusSvg = readFileSync(
  path.join(ROOT, "public", "claudius.svg"),
  "utf8",
);
const bustInner = claudiusSvg
  .match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1]
  .replace(/fill="#000"/, 'fill="#5a3a2a"');

const BUST_W = 56; // wider than the old 48px squircle — the bust is tall and slender
const BUST_H = 70; // preserves the source SVG's 4:5 aspect (600×750)
const BUST_X = W - BUST_W - 20; // 20px inset from right edge
const BUST_Y = 18; // 18px from top — visually balances the taller silhouette

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="14%" r="78%">
      <stop offset="0%" stop-color="#f7d2bd"/>
      <stop offset="42%" stop-color="#fbeee4"/>
      <stop offset="100%" stop-color="#fbf7f2"/>
    </radialGradient>
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

  <!-- Claudius bust silhouette, upper right -->
  <svg x="${BUST_X}" y="${BUST_Y}" width="${BUST_W}" height="${BUST_H}"
       viewBox="0 0 600 750" preserveAspectRatio="xMidYMid meet">
    ${bustInner}
  </svg>

  <!-- Dashed hint arrow between the two drop zones (icons at y=${ICON_Y}) -->
  <g opacity="0.7">
    <line x1="${ARROW_FROM_X}" y1="${ICON_Y}" x2="${ARROW_TO_X - 6}" y2="${ICON_Y}"
          stroke="#c9694a" stroke-width="2.4"
          stroke-linecap="round" stroke-dasharray="4 7"/>
    <polygon points="${ARROW_TO_X},${ICON_Y} ${ARROW_TO_X - 12},${ICON_Y - 7} ${ARROW_TO_X - 12},${ICON_Y + 7}"
             fill="#c9694a"/>
  </g>

  <!-- First-launch helper, below the drag row. See the header comment for
       why this lives on the DMG background and not in the app itself.
       Originally rendered at y=285..346; Finder on at least one Sequoia
       config clipped the last line because the visible DMG content area is
       slightly under the 380px canvas. Shifted up by ~17px so the bottom
       line sits at y=329 (50px clearance from canvas bottom). The dashed
       separator is faint (opacity 0.18) so it overlaps the icon-label band
       harmlessly. -->
  <line x1="60" y1="275" x2="480" y2="275"
        stroke="#c9694a" stroke-opacity="0.18" stroke-width="1"
        stroke-dasharray="2 4"/>
  <text x="${W / 2}" y="295" text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Helvetica', sans-serif"
        font-size="11" font-weight="600" fill="#5a3a2a"
        letter-spacing="0.3">First launch on macOS?</text>
  <text x="${W / 2}" y="313" text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Helvetica', sans-serif"
        font-size="10.5" fill="#8a6a5a">If macOS says it can't verify Claudius:</text>
  <text x="${W / 2}" y="329" text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Helvetica', sans-serif"
        font-size="10.5" fill="#8a6a5a">System Settings &#8594; Privacy &amp; Security &#8594; &#8220;Open Anyway&#8221;</text>
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
    // The bust silhouette is itself a nested <svg> now (read verbatim from
    // public/claudius.svg), so the page has two SVGs. Target the outer one
    // (the direct child of <body>) — first() also works but is order-fragile.
    await page.locator("body > svg").screenshot({ path: out });
    console.log(`· wrote build/${name} (${W * dpr}×${H * dpr})`);
  }
} finally {
  await browser.close();
}

console.log("✓ DMG background regenerated.");
