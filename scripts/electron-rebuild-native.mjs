#!/usr/bin/env node
/**
 * Force-rebuild every native module for the Electron version pinned in
 * package.json's `devDependencies.electron`.
 *
 * Why this script exists (and why we don't use `electron-builder install-app-deps`):
 *
 * `electron-builder install-app-deps` invokes `@electron/rebuild` under the
 * hood with `force=false` and `buildFromSource=false`. When the better-sqlite3
 * prebuilds repo doesn't yet ship a binary for the exact Electron version
 * we're on (Electron 42 is too new for better-sqlite3 12.10 as of 2026-06),
 * `electron/rebuild` SILENTLY leaves the existing `.node` file in place — the
 * one built for whatever ABI was installed by `bun install` (typically plain
 * Node 22, ABI 127). Electron 42 then expects ABI 146; the `dlopen` throws
 * `NODE_MODULE_VERSION 127 != 146`; every code path that touches SQLite
 * (notifications, todos, scheduler, …) silently returns 0 because the
 * `openDb` helper catches the load failure and yields null. The packaged
 * app appears to work but every DB feature is dead — the failure mode
 * that produced "no badge, no inbox row, nothing in macOS Notification
 * Center" reports.
 *
 * `@electron/rebuild` with `--force` always rebuilds from source if no
 * prebuilt matches. We pin `--version` to the same Electron we ship so the
 * ABI matches whatever Chromium ships in `node_modules/electron/dist`.
 *
 * Run from package scripts as `bun run electron:rebuild-native` (build flow)
 * or directly: `node scripts/electron-rebuild-native.mjs`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function readElectronVersion() {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const raw = pkg?.devDependencies?.electron;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      "package.json devDependencies.electron is missing — can't rebuild.",
    );
  }
  // Strip semver leaders (^, ~, =, >=, <=) so the value is a bare 42.2.0.
  return raw.replace(/^[\^~=<>]+/, "");
}

function rebuild(electronVersion) {
  console.log(
    `[rebuild-native] forcing @electron/rebuild for electron@${electronVersion}`,
  );
  // `--force` is the load-bearing flag — without it electron-rebuild keeps
  // any existing .node it finds, even when it was compiled for the wrong ABI.
  // `--module-dir` keeps the scope to the project root; we don't want to
  // rebuild dev-only packages that may live elsewhere.
  //
  // We invoke `node_modules/.bin/electron-rebuild` DIRECTLY rather than
  // going through `npx --no @electron/rebuild`. Why: when @electron/rebuild
  // is installed only TRANSITIVELY (via electron-builder, as it is here —
  // there's no direct devDep entry), npm 10's `npx --no` silently exits 0
  // and prints the npm version instead of running the package. Symptom:
  // the entire rebuild step "succeeded" in ~70ms with no compile output,
  // better-sqlite3 was left at its bun-install (Node, not Electron) ABI,
  // and the downstream verify spawned Electron against the wrong-ABI .node
  // — a confusing chain that made the CI failure look like a display-init
  // hang at first glance. Reproducer: `cd /tmp && npx --no @electron/rebuild`
  // → prints the npm version, exits 0. The macOS job dodges this whole
  // path by calling `bunx electron-builder install-app-deps` directly,
  // which is why the bug only fired on Linux.
  //
  // Going direct also means we no longer need the npx preflight check —
  // a missing electron-rebuild binary now means `@electron/rebuild` isn't
  // installed at all, and the error below points the user at that.
  const electronRebuildBin = path.join(
    REPO_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-rebuild.cmd" : "electron-rebuild",
  );
  const args = [
    "--force",
    `--version=${electronVersion}`,
    `--module-dir=${REPO_ROOT}`,
  ];
  const result = spawnSync(electronRebuildBin, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error && result.error.code === "ENOENT") {
    throw new Error(
      `${electronRebuildBin} not found — run \`bun install\` (or \`npm install\`) so the @electron/rebuild binary is staged into node_modules/.bin.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`@electron/rebuild exited with code ${result.status}`);
  }
}

/**
 * Smoke-load the freshly-rebuilt native module inside the **real Electron**
 * runtime and assert it imports without a `NODE_MODULE_VERSION` mismatch.
 *
 * Why this exists: see the file header for the silent-fallback rant. Even
 * with `--force`, a future rebuild could silently leave a stale .node in
 * place if some new electron-rebuild flag changes behaviour or a prebuild
 * gets pulled in for the wrong ABI. The contract of THIS script is "after I
 * exit 0, the native module loads in Electron." Without an executable
 * assertion the only signal we have is a packaged app that boots but
 * silently fails every SQLite call — which is exactly the regression that
 * prompted this script's existence.
 *
 * Throws (process.exit(1)) on mismatch so `bun run electron:rebuild-native`
 * fails loud, blocking the downstream `next build` / packaging steps.
 */
function verifyLoadsInElectron() {
  // Find the Electron binary the package will ship with. Per-platform path
  // under node_modules/electron — we don't shell out to `electron` because
  // PATH won't have it in CI.
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const electronPath = isMac
    ? path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : isWin
      ? path.join(REPO_ROOT, "node_modules/electron/dist/electron.exe")
      : path.join(REPO_ROOT, "node_modules/electron/dist/electron");
  // Cheap upfront existence check. Without it, a missing binary surfaces
  // through `spawnSync` as `status: null, signal: null, error: ENOENT`,
  // and the catch-all error below renders it as "code null (signal=none)"
  // — which reads as a crash/hang but is actually a spawn-never-started.
  //
  // The recovery path: invoke `node node_modules/electron/install.js`
  // directly. That's the script Electron's own postinstall runs, which
  // calls @electron/get to download the platform binary. We do this
  // ourselves rather than relying on `bun install`'s lifecycle hooks
  // because bun's `trustedDependencies` honoring is inconsistent across
  // versions / lockfile states — observed empirically on the Linux CI
  // runner, where adding "electron" to trustedDependencies + a fresh
  // `bun install --frozen-lockfile` STILL left the binary absent. Doing
  // it from here works on any runner, no env tweaks needed.
  if (!existsSync(electronPath)) {
    const installScript = path.join(
      REPO_ROOT,
      "node_modules",
      "electron",
      "install.js",
    );
    if (!existsSync(installScript)) {
      throw new Error(
        `Neither ${electronPath} nor ${installScript} exists — ` +
          `the electron package itself isn't installed. Run \`bun install\` and retry.`,
      );
    }
    console.log(
      `[rebuild-native] electron binary missing; running ${path.relative(REPO_ROOT, installScript)} to download it…`,
    );
    const install = spawnSync(process.execPath, [installScript], {
      cwd: path.dirname(installScript), // install.js reads package.json relatively
      stdio: "inherit",
      env: process.env,
    });
    if (install.status !== 0) {
      throw new Error(
        `electron/install.js exited with code ${install.status} — binary download failed.`,
      );
    }
    if (!existsSync(electronPath)) {
      throw new Error(
        `electron/install.js completed but ${electronPath} is still missing — ` +
          `check @electron/get's download URL / cache for this Electron version.`,
      );
    }
  }

  // Write a one-shot loader to a tmp file. We do `require("better-sqlite3")`
  // from the repo's node_modules — that's the same path electron-builder
  // will pack into the asar/standalone tree, so verifying here covers the
  // packaging step too.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "claudius-rebuild-verify-"));
  const tmpFile = path.join(tmpDir, "verify.js");
  const script = `
    const { app } = require("electron");
    app.whenReady().then(() => {
      try {
        const Database = require(${JSON.stringify(path.join(REPO_ROOT, "node_modules/better-sqlite3"))});
        // Open an in-memory DB so we don't touch disk.
        const db = new Database(":memory:");
        db.prepare("SELECT 1").get();
        db.close();
        console.log("[rebuild-native] verify: better-sqlite3 loads in electron@" + process.versions.electron + " (modules=" + process.versions.modules + ")");
        app.exit(0);
      } catch (err) {
        console.error("[rebuild-native] verify FAILED: " + (err && err.message ? err.message : err));
        app.exit(2);
      }
    });
  `;
  writeFileSync(tmpFile, script);

  try {
    // `--no-sandbox` is required on Linux CI runners. Chromium's SUID
    // sandbox helper (`chrome-sandbox`) needs to be owned by root with
    // mode 4755 to work; npm/bun installs lay it down as the unprivileged
    // runner user, so Electron aborts at startup with
    // "SUID sandbox helper binary was found, but is not configured correctly."
    // For a sandboxed SQLite open/close test in CI this is the standard
    // workaround — we're not loading any user content, just dlopen-ing a
    // .node file against Electron's ABI. The flag is harmless on macOS /
    // Windows (Electron ignores unknown sandbox flags).
    const electronArgs = ["--no-sandbox", tmpFile];

    // Linux: Electron loads Ozone/X11 even before `app.whenReady()` resolves
    // (it eagerly initializes the display subsystem), and on a headless
    // runner there's no $DISPLAY, so we see:
    //   ozone_platform_x11.cc: Missing X server or $DISPLAY
    //   aura/env.cc: The platform failed to initialize.  Exiting.
    // Wrap with `xvfb-run -a` (pre-installed on ubuntu-latest) which
    // spins up a temporary virtual framebuffer for the spawned process.
    // macOS / Windows runners have native window servers so xvfb isn't
    // needed and isn't on PATH — we conditionally wrap on platform.
    const isLinux = process.platform === "linux";
    const cmd = isLinux ? "xvfb-run" : electronPath;
    const args = isLinux ? ["-a", electronPath, ...electronArgs] : electronArgs;

    const result = spawnSync(cmd, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        // Suppress dock activation / sandbox prompts during the verify.
        ELECTRON_NO_ATTACH_CONSOLE: "1",
      },
    });
    if (result.error) {
      // ENOENT / EACCES / EPERM live here, not in `status`. Surfacing the
      // raw error code makes the diff between "binary missing" and
      // "Electron started but died" obvious in CI logs — the previous
      // catch-all "code null" message conflated the two.
      throw new Error(
        `spawn(${cmd}) failed: ${result.error.code ?? "unknown"} ${result.error.message ?? ""}`.trim(),
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `Electron exited with code ${result.status} (signal=${result.signal ?? "none"}). ` +
          `This means the rebuild step produced a binary that cannot load in Electron — ` +
          `most often a NODE_MODULE_VERSION mismatch. Re-check @electron/rebuild's prebuild ` +
          `lookup for this Electron version.`,
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  const electronVersion = readElectronVersion();
  rebuild(electronVersion);
  verifyLoadsInElectron();
  console.log("[rebuild-native] done");
} catch (err) {
  console.error(`[rebuild-native] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
