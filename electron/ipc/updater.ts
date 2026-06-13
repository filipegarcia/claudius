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
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Where we send macOS users when the in-place self-update is disabled (see
 * `autoUpdateIsSafe`). Mirrors the `publish:` owner/repo in
 * electron-builder.yml; `/releases/latest` always resolves to the newest
 * published release's download page.
 */
const RELEASES_URL = "https://github.com/filipegarcia/claudius/releases/latest";

/**
 * `electron-updater` reads its publish/feed config from `app-update.yml`,
 * which electron-builder only emits for full distributable targets
 * (dmg/nsis/zip with a `publish` block). Local `--dir` builds (e.g.
 * `bun run electron:app`) ARE packaged — `app.isPackaged === true` — but ship
 * no `app-update.yml`, so calling `checkForUpdates()` throws
 * `ENOENT … app-update.yml` and surfaces as a permanent red "Updater error"
 * banner. Treat a packaged-but-unconfigured build like dev: there's nothing
 * to update from, so settle into `idle` instead of erroring.
 */
function hasUpdateConfig(): boolean {
  try {
    return fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
  } catch {
    return false;
  }
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
  // Defer to autoUpdater only in packaged builds that actually carry an
  // update feed config — dev/unpackaged electron has no signed binary to
  // update from, and a local `--dir` package has no `app-update.yml`.
  const packaged = app.isPackaged && hasUpdateConfig();

  ipcMain.on(TOPIC_CHECK, () => {
    if (!packaged) {
      // Dev / unpackaged builds — and packaged `--dir` builds with no
      // `app-update.yml` — have no signed binary or feed to update from.
      // Previously we broadcast `kind: "error"` here which surfaced as
      // a red "Updater error" banner across the top of the window
      // every time the renderer mounted and auto-checked. That's
      // noise — developers know the dev build can't self-update.
      // Settle into `idle` so the banner stays hidden.
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
    if (!packaged) return;
    if (!autoUpdateIsSafe()) {
      // No in-place swap on this build (ad-hoc signed macOS — Squirrel.Mac
      // would reject it). The renderer's "manual-download" banner routes its
      // button here; send the user to the Releases page for the DMG.
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
  if (packaged) {
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

  // On an ad-hoc signed macOS build the in-place swap is impossible (see
  // autoUpdateIsSafe), so we must NOT download or stage an install on quit —
  // doing so only strands the user on a half-applied update. Leaving
  // autoDownload off still lets `update-available` fire (handled below), which
  // is what drives the manual-download prompt. Always true off-darwin and on
  // genuinely Developer ID signed builds.
  const allowSelfUpdate = autoUpdateIsSafe();
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
    if (!autoUpdateIsSafe()) {
      // Ad-hoc signed macOS build — point the user at the DMG instead of
      // kicking off a download Squirrel.Mac would reject post-quit.
      broadcast({
        kind: "manual-download",
        version: info.version,
        url: RELEASES_URL,
      });
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
