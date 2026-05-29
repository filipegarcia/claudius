// Generate the Claudius desktop-app icon set from a single source design.
//
// The design: a macOS Big Sur "squircle" (continuous-corner superellipse)
// with a terracotta gradient, carrying a thin white lunate / chevron "C"
// (the archaic old-Latin letterform — a crescent that reads as "‹").
//
// Pipeline (mac-first; see docs/electron-conversion for the build):
//   1. compose the SVG (squircle path is computed, not hand-tuned)
//   2. rasterize SVG -> 1024 master PNG via headless chromium (Playwright)
//   3. sips the master into an .iconset, iconutil -> icon.icns
//   4. emit linux PNGs (build/icons/<size>.png) — free via sips
//
// We do NOT build icon.ico here: a mac `.app` never reads it, and a
// hand-rolled PNG-in-ICO encoder is the most fragile thing we could add.
// Add Windows separately if/when a win build is wired up.
//
// Run with:  node scripts/make-icons.mjs   (or `make electron-icons`)

import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build", "icons");
const ICONSET = path.join(OUT, "icon.iconset");

// ── geometry ───────────────────────────────────────────────────────────
const SIZE = 1024; // master canvas
const C = SIZE / 2; // center
// Big Sur app icons don't fill the canvas: the rounded body is inset with
// transparent padding so it matches the visual size of neighbouring dock
// icons. ~824/1024 body with ~100px of breathing room each side.
const BODY = 824;
const A = BODY / 2; // squircle half-extent
const N = 5; // superellipse exponent (higher = squarer corners)

// Build the squircle as a sampled superellipse path so the corners are the
// smooth "continuous" Apple curvature, not a plain rounded-rect arc.
function squirclePath() {
  const steps = 720;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = C + A * Math.sign(ct) * Math.abs(ct) ** (2 / N);
    const y = C + A * Math.sign(st) * Math.abs(st) ** (2 / N);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return "M" + pts.join(" L") + " Z";
}

// The lunate "C": a thin chevron opening to the right, rounded caps, like
// the "‹" in the reference. Tip sits left-of-center; arms reach up/down.
const STROKE = 70;
const tipX = 430;
const armX = 624;
const topY = 352;
const botY = 672;
const chevron = `M ${armX} ${topY} L ${tipX} ${C} L ${armX} ${botY}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e08a64"/>
      <stop offset="1" stop-color="#c9694a"/>
    </linearGradient>
  </defs>
  <path d="${squirclePath()}" fill="url(#bg)"/>
  <path d="${chevron}" fill="none" stroke="#fff" stroke-width="${STROKE}"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ── render ───────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "icon.svg"), svg);
console.log("· wrote build/icons/icon.svg");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
    { waitUntil: "load" },
  );
  const master = path.join(OUT, "icon.png");
  await page.locator("svg").screenshot({ path: master, omitBackground: true });
  console.log("· wrote build/icons/icon.png (1024 master)");
} finally {
  await browser.close();
}

// ── .icns via sips + iconutil ─────────────────────────────────────────────
const master = path.join(OUT, "icon.png");
rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

// iconutil requires these exact filenames.
const iconset = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [px, name] of iconset) {
  execFileSync("sips", ["-z", String(px), String(px), master, "--out", path.join(ICONSET, name)], {
    stdio: "ignore",
  });
}
execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", path.join(OUT, "icon.icns")]);
rmSync(ICONSET, { recursive: true, force: true });
console.log("· wrote build/icons/icon.icns");

// ── linux PNGs (electron-builder reads build/icons/<size>.png) ────────────
for (const px of [512, 256, 128, 64, 32]) {
  execFileSync("sips", ["-z", String(px), String(px), master, "--out", path.join(OUT, `${px}x${px}.png`)], {
    stdio: "ignore",
  });
}
console.log("· wrote build/icons/{512,256,128,64,32}x*.png");
console.log("✓ icons generated. (Windows icon.ico not built — mac/linux only.)");
