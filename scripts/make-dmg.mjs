// Build the branded macOS .dmg via Andrey Tarantsov's `create-dmg`
// (the bash tool, `brew install create-dmg`), NOT electron-builder's
// bundled DMG creator.
//
// Why not electron-builder's DMG step:
//   electron-builder writes the DMG's `.DS_Store` with `backgroundType: 2`
//   and a legacy `backgroundImageAlias`. Finder on macOS 14+ (Sonoma /
//   Sequoia / Tahoe) silently ignores that alias variant and falls back to
//   a blank-white window — the embedded TIFF is correct but never resolved.
//   See https://github.com/electron-userland/electron-builder/issues/… for
//   the upstream issue.
//
// What create-dmg does differently:
//   It mounts a writable scratch DMG and drives Finder via AppleScript to
//   "set background picture of viewOptions to file …". Finder writes the
//   .DS_Store itself, producing the alias variant macOS 14+ Finder honours.
//   The 6.9 MB difference vs electron-builder's alias (~844 B vs ~364 B) is
//   the metadata Finder needs to resolve across volume IDs.
//
// Inputs:
//   release/mac/Claudius.app  ← from `electron-builder --mac --dir` or zip
//   build/background.png      ← from `node scripts/make-dmg-background.mjs`
//
// Output:
//   release/Claudius-<version>-mac-x64.dmg
//
// Matches electron-builder's artifactName template so downstream tooling
// (GitHub Release upload, latest-mac.yml hand-off) doesn't need to change.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

const VERSION = pkg.version;
const APP_PATH = path.join(ROOT, "release", "mac", "Claudius.app");
const SRC_DIR = path.dirname(APP_PATH); // release/mac/ — create-dmg copies *contents* of this dir
const BACKGROUND = path.join(ROOT, "build", "background.png");
const OUT_PATH = path.join(ROOT, "release", `Claudius-${VERSION}-mac-x64.dmg`);
const VOL_NAME = `Claudius ${VERSION}`;

// ── pre-flight ─────────────────────────────────────────────────────────────
if (!existsSync(APP_PATH)) {
  console.error(
    `✗ ${path.relative(ROOT, APP_PATH)} not found — run \`bun run electron:build && bunx electron-builder --mac --dir\` first`,
  );
  process.exit(1);
}
if (!existsSync(BACKGROUND)) {
  console.error(
    `✗ ${path.relative(ROOT, BACKGROUND)} not found — run \`node scripts/make-dmg-background.mjs\``,
  );
  process.exit(1);
}
const which = spawnSync("which", ["create-dmg"], { encoding: "utf8" });
if (which.status !== 0) {
  console.error(
    "✗ create-dmg not on PATH — install it with `brew install create-dmg` (the Tarantsov bash tool, not the sindresorhus npm one)",
  );
  process.exit(1);
}

// Stale output blocks create-dmg ("file exists"). Stale mount of the same
// volume name means the AppleScript inside create-dmg drives the WRONG
// window — symptom is the new DMG inheriting the old mount's layout.
if (existsSync(OUT_PATH)) rmSync(OUT_PATH);
const blockmap = OUT_PATH + ".blockmap";
if (existsSync(blockmap)) rmSync(blockmap);
const mountPath = `/Volumes/${VOL_NAME}`;
if (existsSync(mountPath)) {
  spawnSync("hdiutil", ["detach", mountPath, "-force"], { stdio: "ignore" });
}

// ── package ────────────────────────────────────────────────────────────────
// Icon coordinates match the cues in build/dmg-background.png:
//   • app at  (130, 220)
//   • Applications symlink at (410, 220)
//   • dashed arrow drawn between them at y=220
// Window size matches the rendered background image (540×380).
//
// --hide-extension keeps the bundle label as "Claudius" (no ".app").
// --no-internet-enable skips macOS's old "downloaded from internet" tag
// dance, which is interactive and would hang the script in CI.
const args = [
  "--volname",
  VOL_NAME,
  "--background",
  BACKGROUND,
  "--window-pos",
  "200",
  "120",
  "--window-size",
  "540",
  "380",
  "--icon-size",
  "80",
  "--icon",
  "Claudius.app",
  "130",
  "220",
  "--hide-extension",
  "Claudius.app",
  "--app-drop-link",
  "410",
  "220",
  "--no-internet-enable",
  OUT_PATH,
  SRC_DIR,
];

console.log(`· create-dmg → ${path.relative(ROOT, OUT_PATH)}`);

// HARD TIMEOUT. On hosted macos-14 GitHub runners, create-dmg's first step
// (`hdiutil create -srcfolder`) hangs indefinitely — we observed a 6h job
// timeout on the v0.3.160.2 release. The hang is upstream of the AppleScript
// stage, so passing flags or pre-launching Finder doesn't help; the only
// reliable mitigation is to kill the process group and let CI fall back to
// electron-builder's bundled DMG (build/after-pack of the workflow).
//
// MAKE_DMG_TIMEOUT_MS=600000 (10 min) is plenty: a successful local run takes
// ~30 s for a 350 MB app. Unset → no timeout (the default for interactive use).
const timeoutMs = Number(process.env.MAKE_DMG_TIMEOUT_MS) || undefined;
const result = spawnSync("create-dmg", args, {
  stdio: "inherit",
  timeout: timeoutMs,
  killSignal: "SIGKILL", // SIGTERM may leave hdiutil children alive
});

if (result.error && (result.error.code === "ETIMEDOUT" || result.signal === "SIGKILL")) {
  console.error(
    `✗ create-dmg exceeded MAKE_DMG_TIMEOUT_MS=${timeoutMs}ms — aborting. ` +
      `If this is CI, fall back to electron-builder's DMG target.`,
  );
  // Leave the half-written file behind so a fallback step can replace it
  // cleanly (the pre-flight rmSync above already cleared any prior output).
  if (existsSync(OUT_PATH)) rmSync(OUT_PATH);
  process.exit(124); // conventional timeout exit code
}
if (result.status !== 0) {
  console.error(`✗ create-dmg exited with status ${result.status}`);
  process.exit(result.status || 1);
}

console.log(`✓ ${path.relative(ROOT, OUT_PATH)}`);
