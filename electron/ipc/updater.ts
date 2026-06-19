/**
 * Auto-updater IPC bridge — Phase 7 of
 * docs/electron-conversion/PLAN.md.
 *
 * Wraps `electron-updater`'s `autoUpdater` so the renderer can:
 *   - trigger a check  (`updater:check`)
 *   - kick off the install  (`updater:apply`)
 *   - subscribe to status events  (`updater:status`)
 *
 * Status events are normalized to the `ClaudiusUpdaterStatus` union
 * defined in `lib/shared/electron.d.ts` so the existing
 * `UpdaterBanner` can reuse them without a parallel data shape.
 *
 * Configuration comes from `electron-builder.yml`'s `publish` block
 * (currently GitHub Releases) — `autoUpdater` reads it automatically
 * from the packaged app.yml.
 *
 * Notes:
 *   - This file is only loaded when running inside Electron (the
 *     server-side `lib/server/updater/*` continues to drive the web
 *     build's git-pull updater).
 *   - autoUpdater throws if you call `checkForUpdates()` in dev /
 *     unpackaged. We early-return in that case so calling check during
 *     `electron:dev` doesn't crash.
 *   - macOS App Management denials happen POST-QUIT (the bundle swap
 *     is performed by Squirrel.Mac's `ShipIt` helper after our process
 *     has exited), so `u.on("error", …)` never sees them. To still
 *     surface a remediation banner we persist the target version on
 *     `update-downloaded` and, on the next launch's first
 *     `updater:check`, compare it against `app.getVersion()`. A
 *     mismatch on darwin is the load-bearing trigger for the
 *     `blocked-app-management` status — the live classifier remains a
 *     belt-and-suspenders second source for the rare in-process
 *     denial.
 */
import { app, BrowserWindow, ipcMain, net, shell } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  appBundleFromExecPath,
  buildSwapScript,
  pickMacZip,
  releaseAssetUrl,
  sha512Base64,
  type ReleaseFile,
} from "./self-replace-mac";

/**
 * Where we send macOS users when the in-place self-update is disabled (see
 * `autoUpdateIsSafe`). Mirrors the `publish:` owner/repo in
 * electron-builder.yml; `/releases/latest` always resolves to the newest
 * published release's download page.
 */
const RELEASES_URL = "https://github.com/filipegarcia/claudius/releases/latest";

/** Owner/repo for the GitHub Releases feed — mirrors electron-builder.yml's `publish`. */
const RELEASE_OWNER = "filipegarcia";
const RELEASE_REPO = "claudius";

/**
 * A new build we've downloaded + extracted ourselves and staged for an in-place
 * swap on next quit. Set only on the macOS custom-self-replace path (ad-hoc /
 * unsigned builds, where Squirrel.Mac refuses the swap). When set, `updater:apply`
 * runs the detached swap helper + relaunch instead of `quitAndInstall()`.
 */
let customStaged: { version: string; newAppPath: string } | null = null;

/**
 * `electron-updater` reads its publish/feed config from `app-update.yml`,
 * which electron-builder only emits for full distributable targets
 * (dmg/nsis/zip with a `publish` block). Local `--dir` builds (e.g.
 * `bun run electron:app`) ARE packaged — `app.isPackaged === true` — but ship
 * no `app-update.yml`.
 *
 * This is no longer a reason to give up: when the file is absent, `bootstrap()`
 * synthesizes the same GitHub feed via `setFeedURL(fallbackFeedConfig())` so
 * the build still self-updates from Releases. So `hasUpdateConfig()` now only
 * decides whether we need that fallback — NOT whether we arm at all (see
 * `updaterArming`). The result is still memo-free (a packaged bundle's
 * resources don't change under us).
 */
function hasUpdateConfig(): boolean {
  try {
    return fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
  } catch {
    return false;
  }
}

/**
 * Whether the updater should arm at all, and if so whether it must synthesize a
 * feed.
 *
 * Contract (the "update ALWAYS" guarantee for non-git binaries):
 *   - Unpackaged dev electron (`isPackaged === false`) → never arm. There is no
 *     signed binary or feed to update from; the renderer settles to `idle`.
 *   - Any packaged build → arm. Full distributables carry `app-update.yml`;
 *     sideloaded / local `--dir` builds (e.g. `bun run electron:app`, or a
 *     `.app` built from a git checkout) ship none, so they get a feed
 *     synthesized from the hardcoded publish target (`useFallbackFeed`). Either
 *     way the build can discover + pull published releases.
 *
 * Pure over its inputs so the arming decision is unit-testable without the
 * lazily-required `electron-updater` module.
 */
export function updaterArming(deps: { isPackaged: boolean; hasConfig: boolean }): {
  arm: boolean;
  useFallbackFeed: boolean;
} {
  if (!deps.isPackaged) return { arm: false, useFallbackFeed: false };
  return { arm: true, useFallbackFeed: !deps.hasConfig };
}

/**
 * GitHub Releases feed config, mirroring electron-builder.yml's `publish:`
 * block. Used to point a sideloaded / `--dir` build (which ships no
 * `app-update.yml`) at the same release channel a full distributable reads
 * automatically. Keep owner/repo in sync with `electron-builder.yml`.
 */
export function fallbackFeedConfig(): { provider: "github"; owner: string; repo: string } {
  return { provider: "github", owner: RELEASE_OWNER, repo: RELEASE_REPO };
}

/**
 * Linux only: whether this package format must fall back to a manual Releases
 * download instead of an in-place self-update.
 *
 * electron-updater can self-replace an **AppImage** (it re-execs its own single
 * file), but it cannot swap a system-installed **deb/rpm** — those files live
 * under `/opt` and `/usr` and are owned by apt/dnf. The AppImage runtime sets
 * `$APPIMAGE` to the image path; its absence on Linux means a system package,
 * which we route to the same `manual-download` banner the unsupported-mac path
 * uses. Non-Linux platforms are never affected here.
 *
 * Pure over its inputs for testability; the runtime wrapper threads
 * `process.platform` and `$APPIMAGE` in.
 */
export function linuxNeedsManualDownload(deps: {
  platform: NodeJS.Platform;
  isAppImage: boolean;
}): boolean {
  return deps.platform === "linux" && !deps.isAppImage;
}

function isUnsupportedLinuxPackage(): boolean {
  return linuxNeedsManualDownload({
    platform: process.platform,
    isAppImage: Boolean(process.env.APPIMAGE),
  });
}

// We lazy-load electron-updater inside `bootstrap()` rather than at
// module top because importing it eagerly evaluates a `MacUpdater` /
// `NsisUpdater` constructor that needs a live Electron `app` —
// importing this module under vitest (where `app` is mocked or
// unavailable) would throw. Lazy-loading also keeps the dev /
// unpackaged path cleaner since we never reach the require there.
type AutoUpdater = typeof import("electron-updater").autoUpdater;
let cachedUpdater: AutoUpdater | null = null;
function loadAutoUpdater(): AutoUpdater {
  if (cachedUpdater) return cachedUpdater;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("electron-updater") as typeof import("electron-updater");
  cachedUpdater = mod.autoUpdater;
  return cachedUpdater;
}

const TOPIC_CHECK = "updater:check";
const TOPIC_APPLY = "updater:apply";
const TOPIC_STATUS = "updater:status";
const TOPIC_OPEN_APP_MANAGEMENT = "updater:open-app-management-settings";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string }
  | { kind: "blocked-app-management"; message: string }
  /**
   * macOS-only: an update exists but this build can't install it in place
   * (ad-hoc signed — Squirrel.Mac would reject the swap; see
   * `autoUpdateIsSafe`). The renderer shows a "download from Releases"
   * prompt instead of a "restart to install" button. `url` points at the
   * GitHub Releases page carrying the DMG.
   */
  | { kind: "manual-download"; version: string; url: string };

/**
 * Classify a raw `electron-updater` error message.
 *
 * On macOS Ventura+, "App Management" gates writes to other apps' bundles
 * (including self-replacement of `/Applications/Claudius.app`). When the
 * user hasn't authorized Claudius, the OS surfaces a Privacy & Security
 * notification AND the in-process write fails with `EPERM` / `EACCES` /
 * "Operation not permitted". The raw error is useless to a non-developer
 * — we promote it to a `blocked-app-management` status so the renderer
 * can show a one-click remediation banner.
 *
 * The detector is intentionally broad: any darwin permission-denied error
 * from the updater is overwhelmingly likely to be App Management, since
 * the only thing the updater writes is the app bundle, and `/Applications`
 * itself is writable by the user. False positives just show a slightly
 * over-specific banner — still strictly better than the cryptic raw
 * message.
 *
 * Exported so unit tests can exercise the classifier directly without
 * trying to mock the lazily-required `electron-updater` module (whose
 * CommonJS `require` bypasses `vi.mock`).
 */
export function classifyUpdaterError(message: string): Status {
  if (process.platform === "darwin") {
    // Match EPERM/EACCES codes, the "Operation not permitted" / "not
    // permitted" strings the kernel returns, and any error that explicitly
    // references the .app bundle path getting rejected.
    if (
      /\bEPERM\b|\bEACCES\b|operation not permitted|not permitted|denied by .* policy|App Management/i.test(
        message,
      )
    ) {
      return { kind: "blocked-app-management", message };
    }
  }
  return { kind: "error", message };
}

/**
 * True when a `codesign --display --verbose=4` dump describes a real Developer
 * ID Application signature (the only macOS signing flavour Squirrel.Mac can
 * self-update across builds). Ad-hoc signed bundles — our certless release
 * pipeline (`codesign --sign -` in build/after-pack.js) — print `Signature=adhoc`
 * and carry NO `Authority=` chain, so they fail this test.
 *
 * Mac App Store receipts (`Authority=Apple Mac OS Application Signing`) also fail
 * it, which is correct: we never ship MAS builds and electron-updater can't drive
 * a MAS install anyway.
 *
 * Pure over its input so the codesign-output parsing is unit-testable without
 * shelling out (the production wrapper `autoUpdateIsSafe` runs the command).
 */
export function isDeveloperIdSigned(codesignDetail: string): boolean {
  return /^Authority=Developer ID Application/m.test(codesignDetail);
}

/**
 * Whether electron-updater may perform an in-place macOS self-update.
 *
 * Squirrel.Mac (the `ShipIt` helper) validates that the downloaded update
 * satisfies the INSTALLED app's *designated code requirement*. Ad-hoc signed
 * bundles have no Team ID / Developer ID anchor — every build gets a distinct
 * cdhash-bound signature, so no two ad-hoc bundles ever satisfy each other's
 * requirement. The swap is rejected post-quit with "code failed to satisfy
 * specified code requirement(s)", stranding the user on a half-applied update.
 *
 * So on macOS we only allow the in-place swap when the running app is Developer
 * ID signed; otherwise the caller falls back to a manual-download prompt (open
 * Releases, install the DMG). The probe is runtime (not a build-time flag), so a
 * future signed/notarized build re-enables auto-update with zero code change.
 *
 * Non-darwin platforms are always safe — this gate is macOS/Squirrel-specific.
 * Result is memoised: the running bundle's signature can't change under us.
 *
 * Defaults to UNSAFE on darwin on any error/uncertainty: a needless
 * manual-download prompt on a signed build is a mild annoyance; a false "safe"
 * resurrects the broken ShipIt swap.
 */
let autoUpdateSafeCache: boolean | null = null;
function autoUpdateIsSafe(): boolean {
  if (process.platform !== "darwin") return true;
  if (autoUpdateSafeCache !== null) return autoUpdateSafeCache;
  let safe = false;
  try {
    // codesign writes the signing detail (incl. the `Authority=` chain) to
    // stderr; spawnSync captures both streams and never throws on a non-zero
    // exit, so we scan across stdout+stderr.
    const res = spawnSync(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", app.getPath("exe")],
      { encoding: "utf8" },
    );
    safe = isDeveloperIdSigned(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  } catch {
    safe = false;
  }
  autoUpdateSafeCache = safe;
  return safe;
}

/**
 * Persistent marker for "we downloaded version X and asked the OS to
 * install it on quit." Stored under `userData/` so it survives the quit.
 *
 * Why this exists: the live `error` event from `electron-updater` is
 * almost never the one that catches an App Management denial. The
 * bundle swap is performed by Squirrel.Mac's ShipIt helper AFTER
 * `quitAndInstall()` has terminated our process — by which point
 * neither our `u.on("error", …)` listener nor the renderer's IPC
 * subscription can hear about the failure. The macOS notification the
 * user sees (overlaying System Settings) fires at this same post-quit
 * moment, attributed to Claudius even though Claudius is gone.
 *
 * The reliable signal is at NEXT launch: we wrote down "expected to
 * become version X on next start"; if the running process is still on
 * the previous version, the swap failed. App Management is the
 * overwhelmingly likely cause on darwin.
 */
type PendingUpdate = {
  /** Version we expected to be running after the next launch. */
  targetVersion: string;
  /** When `update-downloaded` fired. */
  attemptedAt: number;
};

function pendingUpdatePath(): string {
  return path.join(app.getPath("userData"), "claudius-pending-update.json");
}

function persistPendingUpdate(version: string): void {
  try {
    const data: PendingUpdate = {
      targetVersion: version,
      attemptedAt: Date.now(),
    };
    fs.writeFileSync(pendingUpdatePath(), JSON.stringify(data), "utf8");
  } catch (err) {
    // Best-effort: a failed persist just means we won't catch a
    // *subsequent* post-quit swap denial. Still worth logging so the
    // user can spot it via the updater log file.
    console.warn("[updater] failed to persist pending update marker", err);
  }
}

/**
 * Read + delete the pending-update marker. Idempotent: returns null if
 * the marker doesn't exist, was already consumed this launch, or is
 * unreadable. The marker is consumed on read because we only want to
 * compare against the FIRST process started after the download — a
 * later attempt creates its own marker.
 */
function consumePendingUpdate(): PendingUpdate | null {
  const p = pendingUpdatePath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone (race with a parallel launch) — fall through and
    // honor whatever we read.
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingUpdate>;
    if (
      typeof parsed.targetVersion !== "string" ||
      typeof parsed.attemptedAt !== "number"
    ) {
      return null;
    }
    return { targetVersion: parsed.targetVersion, attemptedAt: parsed.attemptedAt };
  } catch {
    return null;
  }
}

/**
 * Detect "we downloaded an update but it didn't take effect."
 *
 * Returns a `blocked-app-management` status when the previous launch
 * downloaded version X but the current launch is still on a different
 * version. Returns `null` when:
 *   - no marker (no pending update)
 *   - version matches (swap succeeded — happy path, marker cleared)
 *   - marker is stale (>14d — user probably never restarted; don't
 *     guilt them about an old download)
 *
 * The detector is darwin-only: on Windows the failed-update flow is
 * different (NSIS exit codes, UAC denials surface differently) and
 * conflating the two would produce confusing copy in the banner.
 *
 * Pure function over its deps for testability — the production call
 * site below threads in `process.platform`, `app.getVersion()`,
 * `Date.now()`, and the filesystem-backed `consumePendingUpdate`.
 */
export function detectPostQuitSwapFailure(deps: {
  platform: NodeJS.Platform;
  currentVersion: string;
  now: number;
  consume: () => PendingUpdate | null;
}): Status | null {
  if (deps.platform !== "darwin") return null;
  const pending = deps.consume();
  if (!pending) return null;
  if (pending.targetVersion === deps.currentVersion) {
    // Swap succeeded — marker already consumed.
    return null;
  }
  const STALE_MS = 14 * 24 * 60 * 60 * 1000;
  if (deps.now - pending.attemptedAt > STALE_MS) return null;
  return {
    kind: "blocked-app-management",
    message: `Attempted to install Claudius ${pending.targetVersion} but the running version is still ${deps.currentVersion}. The most common cause on macOS is App Management blocking the bundle replacement.`,
  };
}

/**
 * Best-effort deep link into the macOS App Management pane.
 *
 * On macOS 13+ (Ventura) System Settings exposes this as a dedicated
 * Privacy & Security subpage. The `?Privacy_AppManagement` anchor jumps
 * straight there; if Apple ever renames the anchor the URL still opens
 * the Privacy & Security root, which is one click away from the right
 * panel. On older macOS we'd fall through to the legacy security pane —
 * but App Management itself only exists on 13+, so this code path won't
 * fire in practice on those builds.
 */
function openAppManagementSettings(): void {
  if (process.platform !== "darwin") return;
  void shell
    .openExternal(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppManagement",
    )
    .catch(() => {
      // Fall back to the Privacy & Security root if the deep anchor
      // ever stops resolving — better one extra click than a dead button.
      void shell
        .openExternal(
          "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
        )
        .catch(() => {});
    });
}

let started = false;
// Latched once the post-quit-swap-failure check runs at first
// TOPIC_CHECK after registration. Subsequent checks proceed normally so
// the user can retry the update after fixing their App Management
// permission.
let postQuitSwapChecked = false;

function broadcast(status: Status): void {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (win.isDestroyed()) continue;
    win.webContents.send(TOPIC_STATUS, status);
  }
}

export function registerUpdaterHandlers(): void {
  // Arm for every packaged build. Full distributables read `app-update.yml`;
  // sideloaded / `--dir` builds get a feed synthesized in bootstrap() from the
  // publish target, so they self-update too (the "update ALWAYS" guarantee for
  // non-git binaries). Only dev/unpackaged electron has nothing to update from.
  const canUpdate = updaterArming({
    isPackaged: app.isPackaged,
    hasConfig: hasUpdateConfig(),
  }).arm;

  ipcMain.on(TOPIC_CHECK, () => {
    if (!canUpdate) {
      // Dev / unpackaged electron has no signed binary or feed to update from.
      // Previously we also bailed here for packaged `--dir` builds (no
      // `app-update.yml`); those now arm via the synthesized fallback feed.
      // Broadcasting `idle` (not `error`) keeps the banner hidden in dev —
      // developers know the dev build can't self-update.
      broadcast({ kind: "idle" });
      return;
    }
    // FIRST check after launch is also our chance to surface a swap
    // that the OS denied post-quit on the previous shutdown. Runs once
    // per process — a retry after the user fixes the permission goes
    // straight into the normal check flow below.
    if (!postQuitSwapChecked) {
      postQuitSwapChecked = true;
      const failure = detectPostQuitSwapFailure({
        platform: process.platform,
        currentVersion: app.getVersion(),
        now: Date.now(),
        consume: consumePendingUpdate,
      });
      if (failure) {
        broadcast(failure);
        return;
      }
    }
    bootstrap();
    loadAutoUpdater()
      .checkForUpdates()
      .catch((err) => {
        const msg = errorMessage(err);
        // Belt-and-suspenders: any "not actually updatable" packaging state
        // (missing feed config / update manifest) settles to idle rather than
        // painting a red banner — or a raw stack trace — the user can't act on.
        if (isBenignNoFeedError(msg)) {
          broadcast({ kind: "idle" });
          return;
        }
        broadcast(classifyUpdaterError(msg));
      });
  });

  ipcMain.on(TOPIC_APPLY, () => {
    if (!canUpdate) return;
    // macOS custom self-replace: we downloaded + staged the new bundle
    // ourselves; swap it in place and relaunch (no Squirrel, no signing).
    if (customStaged) {
      applyCustomStaged();
      return;
    }
    if (isUnsupportedLinuxPackage() || !autoUpdateIsSafe()) {
      // No in-place swap available: a Linux deb/rpm (system-owned, can't be
      // replaced by electron-updater) or a macOS build whose staged download
      // failed. Send the user to the Releases page to grab the new package.
      void shell.openExternal(RELEASES_URL).catch(() => {});
      return;
    }
    try {
      loadAutoUpdater().quitAndInstall();
    } catch (err) {
      broadcast(classifyUpdaterError(errorMessage(err)));
    }
  });

  // Deep-link to System Settings → Privacy & Security → App Management
  // so the `blocked-app-management` banner can offer a one-click fix.
  // Registered even on non-darwin: the helper is a no-op there, so a
  // stray renderer call doesn't error.
  ipcMain.on(TOPIC_OPEN_APP_MANAGEMENT, () => {
    openAppManagementSettings();
  });

  // Pre-attach listeners on first window so that an auto-check fired
  // by electron-updater on its own schedule still surfaces to the
  // renderer. We don't call checkForUpdates() automatically here —
  // the renderer decides when to ask. Wrapped in try/catch because
  // require("electron-updater") can throw in some packaging edge
  // cases (missing assets, broken signing) — failing softly preserves
  // the rest of the app.
  if (canUpdate) {
    try {
      bootstrap();
    } catch (err) {
      broadcast({ kind: "error", message: errorMessage(err) });
    }
  }
}

function bootstrap(): void {
  if (started) return;
  started = true;
  const u = loadAutoUpdater();

  // Sideloaded / local `--dir` builds (and `.app`s built from a git checkout)
  // ship no `app-update.yml`. Synthesize the GitHub feed from the same publish
  // target electron-builder bakes into full distributables so these builds can
  // still discover + pull published releases — without this they sit idle
  // forever, since a non-git binary has no other place to learn about a new
  // version. Best-effort: a failed set just leaves the build unable to check.
  if (!hasUpdateConfig()) {
    try {
      u.setFeedURL(fallbackFeedConfig());
    } catch (err) {
      console.warn("[updater] failed to set fallback GitHub feed", err);
    }
  }

  // The in-place swap is impossible on (a) ad-hoc signed macOS builds — see
  // autoUpdateIsSafe — and (b) Linux deb/rpm packages (system-owned files
  // electron-updater can't replace). In both cases we must NOT download or
  // stage an install: doing so only strands the user on a half-applied update.
  // Leaving autoDownload off still lets `update-available` fire (handled
  // below), which drives the manual-download prompt. Always true off-darwin for
  // AppImage and on genuinely Developer ID signed macOS builds.
  const allowSelfUpdate = autoUpdateIsSafe() && !isUnsupportedLinuxPackage();
  u.autoDownload = allowSelfUpdate;
  u.autoInstallOnAppQuit = allowSelfUpdate;
  // Logs go to the OS-specific log path; users can inspect via
  // /api/doctor or by opening the file directly.
  u.logger = {
    info: (...args: unknown[]) => console.log("[updater]", ...args),
    warn: (...args: unknown[]) => console.warn("[updater]", ...args),
    error: (...args: unknown[]) => console.error("[updater]", ...args),
    debug: (...args: unknown[]) => console.debug("[updater]", ...args),
  };

  u.on("checking-for-update", () => broadcast({ kind: "checking" }));
  u.on("update-available", (info) => {
    if (isUnsupportedLinuxPackage()) {
      // Linux deb/rpm — electron-updater can't swap a system package in place.
      // Point the user at Releases to install the new .deb/.rpm themselves.
      broadcast({ kind: "manual-download", version: info.version, url: RELEASES_URL });
      return;
    }
    if (!autoUpdateIsSafe()) {
      // Ad-hoc / unsigned macOS build — Squirrel.Mac would reject the swap
      // post-quit. Instead of dead-ending at a "download the DMG yourself"
      // prompt, run our OWN download + extract + in-place swap + relaunch
      // (no signing required). `startMacSelfReplace` falls back to the
      // manual-download banner if any step fails.
      if (process.platform === "darwin") {
        void startMacSelfReplace({ version: info.version, files: info.files as ReleaseFile[] });
        return;
      }
      broadcast({ kind: "manual-download", version: info.version, url: RELEASES_URL });
      return;
    }
    broadcast({ kind: "available", version: info.version });
  });
  u.on("update-not-available", () => broadcast({ kind: "idle" }));
  u.on("download-progress", (p) =>
    broadcast({ kind: "downloading", percent: Math.round(p.percent) }),
  );
  u.on("update-downloaded", (info) => {
    // Persist FIRST so a synchronous broadcast → "Restart now" click
    // can't race the disk write and let a swap failure go undetected.
    persistPendingUpdate(info.version);
    broadcast({ kind: "downloaded", version: info.version });
  });
  u.on("error", (err) => {
    const msg = errorMessage(err);
    // The autoUpdater's scheduled/event-path errors bypass the
    // checkForUpdates().catch above, so apply the same benign-state filter
    // here — a missing update manifest must never surface to the user.
    if (isBenignNoFeedError(msg)) {
      broadcast({ kind: "idle" });
      return;
    }
    broadcast(classifyUpdaterError(msg));
  });
}

/**
 * macOS custom self-replace, step 1: download the new build's zip and stage it.
 *
 * Runs on ad-hoc/unsigned darwin builds where Squirrel.Mac can't swap. Drives
 * the same `downloading` → `downloaded` renderer states the signed path uses, so
 * the banner and settings card need no special case. Any failure falls back to
 * the manual-download prompt — the user can still grab the DMG.
 */
async function startMacSelfReplace(info: { version: string; files?: ReleaseFile[] }): Promise<void> {
  const asset = pickMacZip(info.files ?? [], process.arch);
  if (!asset) {
    broadcast({ kind: "manual-download", version: info.version, url: RELEASES_URL });
    return;
  }
  const url = releaseAssetUrl(RELEASE_OWNER, RELEASE_REPO, info.version, asset.url);
  const tmp = app.getPath("temp");
  const zipPath = path.join(tmp, `claudius-update-${info.version}.zip`);
  const extractDir = path.join(tmp, `claudius-update-${info.version}`);
  try {
    broadcast({ kind: "downloading", percent: 0 });
    await downloadFile(url, zipPath, asset.size, (pct) =>
      broadcast({ kind: "downloading", percent: pct }),
    );

    // Integrity check (TLS already covers transport; this catches truncation /
    // a mismatched feed). Skip only if the feed didn't record a digest.
    if (asset.sha512) {
      const got = sha512Base64(fs.readFileSync(zipPath));
      if (got !== asset.sha512) throw new Error("downloaded update failed checksum verification");
    }

    // `ditto -x -k` is the macOS-correct unzip — preserves the .app bundle
    // (symlinks, perms, signature structure) which `unzip` mangles.
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    const dit = spawnSync("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], { encoding: "utf8" });
    if (dit.status !== 0) throw new Error(`ditto extract failed: ${dit.stderr || dit.status}`);

    const appName = fs.readdirSync(extractDir).find((e) => e.endsWith(".app"));
    if (!appName) throw new Error("no .app found inside the update archive");
    const newAppPath = path.join(extractDir, appName);
    // Strip any quarantine now so the post-quit relaunch isn't Gatekeeper-blocked.
    spawnSync("/usr/bin/xattr", ["-cr", newAppPath]);

    customStaged = { version: info.version, newAppPath };
    broadcast({ kind: "downloaded", version: info.version });
  } catch (err) {
    customStaged = null;
    console.warn("[updater] mac self-replace download failed:", errorMessage(err));
    broadcast({ kind: "manual-download", version: info.version, url: RELEASES_URL });
  }
}

/**
 * Download `url` to `dest`, reporting integer percent. Uses Electron's `net`
 * (honours system proxy + follows the GitHub→CDN redirect automatically).
 */
function downloadFile(
  url: string,
  dest: string,
  expectedSize: number | undefined,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        reject(new Error(`download HTTP ${status}`));
        return;
      }
      const header = res.headers["content-length"];
      const fromHeader = Array.isArray(header) ? Number(header[0]) : Number(header);
      const total = expectedSize || (Number.isFinite(fromHeader) ? fromHeader : 0);
      const out = fs.createWriteStream(dest);
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        out.write(chunk);
        if (total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)));
      });
      res.on("end", () => out.end(() => resolve()));
      res.on("error", (e: Error) => {
        out.destroy();
        reject(e);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * macOS custom self-replace, step 2: swap the staged bundle in place + relaunch.
 *
 * Writes a detached helper script that waits for us to exit, swaps the bundle,
 * de-quarantines it, and reopens the app — then we quit. We persist the
 * post-quit marker first so the existing `detectPostQuitSwapFailure` check
 * surfaces a `blocked-app-management` banner on next launch if macOS denied the
 * bundle replacement.
 */
function applyCustomStaged(): void {
  if (!customStaged) return;
  const target = appBundleFromExecPath(app.getPath("exe"));
  if (!target) {
    // Not running from a .app bundle (shouldn't happen in a packaged build) —
    // fall back to the Releases page.
    broadcast({ kind: "manual-download", version: customStaged.version, url: RELEASES_URL });
    return;
  }
  try {
    const logPath = path.join(app.getPath("userData"), "claudius-self-replace.log");
    const script = buildSwapScript({
      pid: process.pid,
      newApp: customStaged.newAppPath,
      targetApp: target,
      logPath,
    });
    const scriptPath = path.join(app.getPath("temp"), `claudius-swap-${customStaged.version}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    // Reuse the post-quit-swap-failure detector: if the swap is blocked (App
    // Management), next launch is still on the old version and we surface it.
    persistPendingUpdate(customStaged.version);
    const child = spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" });
    child.unref();
    // Give the helper a beat to start its wait loop, then quit so it can swap.
    setTimeout(() => app.quit(), 250);
  } catch (err) {
    broadcast(classifyUpdaterError(errorMessage(err)));
  }
}

/**
 * True for "nothing to update from / the feed manifest isn't there" states that
 * are NOT user-actionable and must never paint an error. Covers: local `--dir`
 * builds with no app-update.yml; and a release that hasn't attached
 * latest-{linux,mac,win}.yml — electron-updater reports the latter as
 * "Cannot find latest-linux.yml in the latest release artifacts ... 404".
 */
function isBenignNoFeedError(msg: string): boolean {
  return /app-update\.yml|latest-(?:linux|mac|win)\.yml|cannot find .* in the latest release|ENOENT|HttpError: 404/i.test(
    msg,
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown updater error";
  }
}
