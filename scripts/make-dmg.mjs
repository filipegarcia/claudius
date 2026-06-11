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
//   release/mac/Claudius.app          ← from `electron-builder --mac --x64 ...`   (x64)
//   release/mac-arm64/Claudius.app    ← from `electron-builder --mac --arm64 ...` (arm64)
//   build/background.png              ← from `node scripts/make-dmg-background.mjs`
//
// Output:
//   release/Claudius-<version>-mac-<arch>.dmg
//
// Matches electron-builder's artifactName template so downstream tooling
// (GitHub Release upload, latest-mac.yml hand-off) doesn't need to change.
//
// Arch selection:
//   --arch=x64|arm64  (default: process.arch)
// electron-builder convention: x64 builds land in `release/mac/`, arm64
// builds land in `release/mac-arm64/`. We respect both so a single release
// pipeline can produce a DMG per arch.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

// ── arg parsing ────────────────────────────────────────────────────────────
// `--arch=x64|arm64` or `--arch x64` — defaults to the host arch so local
// `bun run electron:dist:mac` keeps working without a flag.
function readArg(name, fallback) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === `--${name}` && i + 1 < argv.length) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

const ARCH = readArg("arch", process.arch);
if (ARCH !== "x64" && ARCH !== "arm64") {
  console.error(`✗ unsupported --arch=${ARCH} (expected x64 or arm64)`);
  process.exit(2);
}

const VERSION = pkg.version;
// electron-builder names the per-arch output dirs `mac` (x64) and `mac-arm64`.
const MAC_DIR = ARCH === "arm64" ? "mac-arm64" : "mac";
const APP_PATH = path.join(ROOT, "release", MAC_DIR, "Claudius.app");
const SRC_DIR = path.dirname(APP_PATH); // create-dmg copies *contents* of this dir
const BACKGROUND = path.join(ROOT, "build", "background.png");
const OUT_PATH = path.join(ROOT, "release", `Claudius-${VERSION}-mac-${ARCH}.dmg`);
const VOL_NAME = `Claudius ${VERSION}`;

// ── pre-flight ─────────────────────────────────────────────────────────────
if (!existsSync(APP_PATH)) {
  console.error(
    `✗ ${path.relative(ROOT, APP_PATH)} not found — run \`bun run electron:build && bunx electron-builder --mac --${ARCH} --dir\` first`,
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
//   • app at  (130, 200)
//   • Applications symlink at (410, 200)
//   • dashed arrow drawn between them at y=200
// Window size matches the rendered background image (540×380).
// Icons are at y=200 (not 220) to leave room for the first-launch helper
// text at the bottom — the Finder title bar + status bar consume ~50px,
// leaving ~330px of visible content; the old y=220 placement pushed the
// bottom text past that boundary.
//
// --hide-extension keeps the bundle label as "Claudius" (no ".app").
// --no-internet-enable skips macOS's old "downloaded from internet" tag
// dance, which is interactive and would hang the script in CI.
//
// --filesystem APFS is the headline fix for the macos-14 hang. The same CI
// job that hung in `create-dmg --filesystem HFS+ (default)` succeeded for
// electron-builder's DMG creator using APFS (`Detected arm64 process, HFS+ is
// unavailable. Creating dmg with APFS`). Empirically, the runner CAN produce
// DMGs there — what hangs is specifically `hdiutil create -srcfolder` on
// HFS+, which is what create-dmg uses by default. Switching to APFS sidesteps
// the failure mode entirely. APFS is supported on macOS 10.12+, comfortably
// below our minimum, so the format change is transparent for users.
const args = [
  "--volname",
  VOL_NAME,
  "--filesystem",
  "APFS",
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
  "200",
  "--hide-extension",
  "Claudius.app",
  "--app-drop-link",
  "410",
  "200",
  "--no-internet-enable",
  OUT_PATH,
  SRC_DIR,
];

// ── retry loop ─────────────────────────────────────────────────────────────
// On hosted macos-14 GitHub runners, `hdiutil create` is flaky for reasons
// outside create-dmg's control — Spotlight (mds), XProtectBehaviorService,
// and other macOS daemons can hold a lock on the freshly-created volume,
// causing either a fast "Resource busy" error OR a silent indefinite hang
// (we saw the latter on v0.3.161.9, killed at the 10-min timeout). See
// https://github.com/actions/runner-images/issues/7522 for the long story.
//
// create-dmg has its OWN `hdiutil_retry` that re-fires when hdiutil returns
// with "Resource busy" in its log file — but a HUNG hdiutil never returns,
// so that built-in retry is dead for our failure mode. We need an external
// kill-and-retry. APFS (above) is the primary defense; this loop is the
// belt-and-braces for any residual flakiness.
//
// MAKE_DMG_TIMEOUT_MS is the PER-ATTEMPT timeout. A successful local run
// takes ~30 s for a 350 MB app; macos-14 cross-arch with a 700 MB bundle
// runs ~1.5–2 min. 5 min per attempt × 3 attempts = 15 min worst case before
// the workflow falls back to electron-builder's DMG creator.
const PER_ATTEMPT_TIMEOUT_MS = Number(process.env.MAKE_DMG_TIMEOUT_MS) || 300_000;
const MAX_ATTEMPTS = Number(process.env.MAKE_DMG_MAX_ATTEMPTS) || 3;

// Watchdog: every 30 s, dump the state of hdiutil-related processes so a
// future hang isn't blind. The advisor's note was sharp: --hdiutil-verbose
// can't help because create-dmg buffers hdiutil's output to a log file and
// only prints it AFTER hdiutil returns — so a hang shows nothing. ps +
// `hdiutil info` give us forward-looking signal: WHICH process is stuck (or
// whether the stall is in create-dmg's pre-hdiutil size estimation, not
// hdiutil at all). Without this, every hung release is another 10 blind
// minutes.
//
// Implementation note: spawnSync below blocks the JS event loop, so a
// setInterval-based watchdog inside this Node process would NOT fire — its
// callbacks would queue but never run until create-dmg returned. The watchdog
// has to be its own child process, running in parallel, writing to our
// inherited stdout.
function startWatchdog() {
  const script = `
    while true; do
      ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      procs=$(ps -Ao pid,pcpu,etime,command | grep -E 'hdiutil|diskimages-helper|create-dmg|mds|XProtect|osascript|Finder' | grep -v grep || echo '  (none)')
      info=$(hdiutil info 2>/dev/null | grep -E '^(/dev/|image-path)' || echo '  (none)')
      printf '· [%s] watchdog\\n  procs:\\n%s\\n  hdiutil info:\\n%s\\n' "$ts" "$procs" "$info"
      sleep 30
    done
  `;
  const proc = spawn("/bin/bash", ["-c", script], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  // The parent intentionally outlives the watchdog: we always SIGTERM it when
  // create-dmg exits (success or fail). If something fatal happens in JS
  // before we reach the cleanup, the child becomes an orphan reparented to
  // launchd and would keep printing — unref() at least frees the parent to
  // exit even if we never explicitly kill it.
  if (typeof proc.unref === "function") proc.unref();
  return () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  };
}

let attempt = 0;
let result;
while (attempt < MAX_ATTEMPTS) {
  attempt += 1;

  // Per-attempt cleanup — leftover state from a prior failed attempt blocks
  // create-dmg ("file exists") or makes the AppleScript drive the wrong window.
  if (existsSync(OUT_PATH)) rmSync(OUT_PATH);
  if (existsSync(blockmap)) rmSync(blockmap);
  if (existsSync(mountPath)) {
    spawnSync("hdiutil", ["detach", mountPath, "-force"], { stdio: "ignore" });
  }

  console.log(
    `· create-dmg attempt ${attempt}/${MAX_ATTEMPTS} → ${path.relative(ROOT, OUT_PATH)} (timeout ${PER_ATTEMPT_TIMEOUT_MS}ms)`,
  );

  const stopWatchdog = startWatchdog();
  try {
    result = spawnSync("create-dmg", args, {
      stdio: "inherit",
      timeout: PER_ATTEMPT_TIMEOUT_MS,
      killSignal: "SIGKILL", // SIGTERM may leave hdiutil children alive
    });
  } finally {
    stopWatchdog();
  }

  if (result.status === 0) break;

  const timedOut = result.error && (result.error.code === "ETIMEDOUT" || result.signal === "SIGKILL");
  console.error(
    `✗ attempt ${attempt} ${timedOut ? `timed out after ${PER_ATTEMPT_TIMEOUT_MS}ms` : `failed (status=${result.status}, signal=${result.signal ?? "none"})`}`,
  );

  if (attempt < MAX_ATTEMPTS) {
    // Best-effort: stomp on suspect daemons that may be holding the volume.
    // We don't have sudo here in CI; killall without -KILL is the most
    // we can do unprivileged. Failures are non-fatal — this is housekeeping.
    spawnSync("killall", ["diskimages-helper"], { stdio: "ignore" });
    console.log("· waiting 10s before retry...");
    spawnSync("sleep", ["10"]);
  }
}

if (result.status !== 0) {
  const timedOut = result.error && (result.error.code === "ETIMEDOUT" || result.signal === "SIGKILL");
  console.error(
    `✗ create-dmg exhausted ${MAX_ATTEMPTS} attempts — ${timedOut ? `last attempt hit the ${PER_ATTEMPT_TIMEOUT_MS}ms timeout` : `last status ${result.status}`}. ` +
      `If this is CI, fall back to electron-builder's DMG target.`,
  );
  // Leave no half-written output for the fallback step to trip over.
  if (existsSync(OUT_PATH)) rmSync(OUT_PATH);
  process.exit(timedOut ? 124 : result.status || 1);
}

console.log(`✓ ${path.relative(ROOT, OUT_PATH)}`);
