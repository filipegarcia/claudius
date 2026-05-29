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
function squirclePath(steps = 720) {
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

// The glyph is the actual archaic letterform the user asked for:
// 𐌂 — OLD ITALIC LETTER KE (U+10302), the Etruscan/Old-Latin "C". This is
// the real filled outline of that codepoint taken from Noto Sans Old Italic
// (SIL OFL), extracted once with fontTools and baked in here as a vector
// path so the build needs no font at runtime. It's a pointed crescent with
// flat, angled-cut terminals — deliberately NOT a modern rounded "C".
//
// Source units: 1000 upem, glyph bbox x[59..487] y[-22..732] (font y-up).
// We scale to ~560px tall and centre it on the 1024 canvas, flipping y
// (scale Y is negative) to convert font space → SVG space.
const GLYPH =
  "M449 -22Q361 12 289.5 58.5Q218 105 166.5 158.0Q115 211 87.0 264.5Q59 318 59 365Q59 426 103.5 495.0Q148 564 234.0 627.5Q320 691 445 732L485 655Q396 623 333.5 583.0Q271 543 232.0 502.0Q193 461 175.0 424.5Q157 388 157 362Q157 325 193.0 269.5Q229 214 302.0 156.0Q375 98 487 53Z";
const GLYPH_SCALE = 0.74271; // 560px tall / 754 glyph units
const GLYPH_TX = 309.24; // centres bbox at canvas (512,512)…
const GLYPH_TY = 775.66; // …after the y-flip

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e08a64"/>
      <stop offset="1" stop-color="#c9694a"/>
    </linearGradient>
  </defs>
  <path d="${squirclePath()}" fill="url(#bg)"/>
  <path d="${GLYPH}" fill="#fff"
        transform="translate(${GLYPH_TX} ${GLYPH_TY}) scale(${GLYPH_SCALE} -${GLYPH_SCALE})"/>
</svg>`;

// Web favicon: the SAME mark as the dock icon (identical gradient + 𐌂
// glyph), scaled up so the squircle nearly fills the frame. The Big-Sur
// transparent margin that looks right in the macOS dock just wastes pixels
// in a 16px browser tab, so the favicon trades it for legibility. One SVG;
// browsers downscale it to 16/32/48. Written to app/icon.svg (Next.js
// favicon convention) and site/icon.svg (marketing).
const FAVICON_FILL = 1004; // squircle diameter in the 1024 frame (~10px margin)
const faviconScale = FAVICON_FILL / BODY;
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e08a64"/>
      <stop offset="1" stop-color="#c9694a"/>
    </linearGradient>
  </defs>
  <g transform="translate(${C} ${C}) scale(${faviconScale.toFixed(4)}) translate(${-C} ${-C})">
    <path d="${squirclePath(220)}" fill="url(#bg)"/>
    <path d="${GLYPH}" fill="#fff"
          transform="translate(${GLYPH_TX} ${GLYPH_TY}) scale(${GLYPH_SCALE} -${GLYPH_SCALE})"/>
  </g>
</svg>`;

// ── render ───────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "icon.svg"), svg);
console.log("· wrote build/icons/icon.svg");

// Web favicon (same mark, frame-filling) → the Next.js app and the site.
const FAVICON_SVG_TARGETS = [
  path.join(ROOT, "app", "icon.svg"),
  path.join(ROOT, "site", "icon.svg"),
];
for (const dest of FAVICON_SVG_TARGETS) {
  writeFileSync(dest, faviconSvg);
  console.log(`· wrote ${path.relative(ROOT, dest)}`);
}

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

  // apple-touch icons (180×180) — rasterize the favicon mark for iOS/macOS
  // "add to home screen" + the marketing "App tray" sample. omitBackground
  // keeps the squircle's rounded corners transparent.
  await page.setContent(
    `<!doctype html><html><body style="margin:0">${faviconSvg}</body></html>`,
    { waitUntil: "load" },
  );
  for (const dest of [
    path.join(ROOT, "app", "apple-icon.png"),
    path.join(ROOT, "site", "apple-icon.png"),
  ]) {
    await page.locator("svg").screenshot({ path: dest, omitBackground: true, scale: "css" });
    // normalize to 180×180
    execFileSync("sips", ["-z", "180", "180", dest], { stdio: "ignore" });
    console.log(`· wrote ${path.relative(ROOT, dest)} (180²)`);
  }
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
