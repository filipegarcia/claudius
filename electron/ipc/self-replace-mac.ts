/**
 * Pure helpers for the macOS "custom self-replace" updater — the path we use
 * when the build is ad-hoc/unsigned (no Developer ID cert), so Squirrel.Mac
 * can't perform the in-place swap. Instead we download the new build's zip from
 * GitHub Releases ourselves, extract it, strip quarantine, and swap the .app in
 * place via a detached helper script that runs after we quit, then relaunch.
 *
 * Everything here is pure/Node-only (no `electron` import) so it can be unit
 * tested without a live app. The electron-coupled orchestration (download with
 * progress, ditto extraction, spawning the helper, app.quit) lives in
 * `updater.ts`, which is never imported under vitest.
 */
import { createHash } from "node:crypto";

export type ReleaseFile = { url: string; sha512?: string; size?: number };

/**
 * Pick the macOS `.zip` asset matching the running arch from an
 * electron-updater `UpdateInfo.files` list. Squirrel-style mac feeds ship a
 * per-arch zip (e.g. `Claudius-1.2.3-mac-arm64.zip`); we match the arch token
 * and fall back to the only/first zip if the naming ever changes.
 */
export function pickMacZip(files: ReleaseFile[], arch: string): ReleaseFile | null {
  const zips = files.filter((f) => typeof f.url === "string" && f.url.endsWith(".zip"));
  if (zips.length === 0) return null;
  const byArch = zips.find((f) => f.url.includes(`-${arch}.`) || f.url.includes(`_${arch}.`));
  return byArch ?? zips[0];
}

/**
 * Build the GitHub Releases download URL for an asset filename. electron-updater
 * gives us the bare filename in `UpdateInfo.files[].url`; the GitHub provider
 * publishes with tag `v<version>`.
 */
export function releaseAssetUrl(
  owner: string,
  repo: string,
  version: string,
  filename: string,
): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(
    tag,
  )}/${encodeURIComponent(filename)}`;
}

/**
 * Derive the `.app` bundle root from an executable path like
 * `/Applications/Claudius.app/Contents/MacOS/Claudius`. Returns null when the
 * path isn't inside a `.app` bundle (e.g. dev / unpackaged).
 */
export function appBundleFromExecPath(execPath: string): string | null {
  const marker = ".app/";
  const idx = execPath.indexOf(marker);
  if (idx === -1) return null;
  return execPath.slice(0, idx + 4); // include ".app"
}

/** Base64 SHA-512 of a buffer — the digest form electron-updater records. */
export function sha512Base64(buf: Buffer): string {
  return createHash("sha512").update(buf).digest("base64");
}

/** Single-quote a string for safe interpolation into a /bin/bash script. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The detached helper script that performs the swap AFTER the app quits.
 *
 * It waits for the old process to exit, stages the new bundle next to the
 * target (same dir → atomic rename, minimising the window where the app is
 * missing), strips quarantine so Gatekeeper doesn't block the unsigned relaunch,
 * swaps it in, and reopens the app. All output is appended to `logPath` for
 * post-mortem since nothing can observe this once we've quit.
 *
 * Pure (returns the script text) so the exact command sequence is unit-tested.
 */
export function buildSwapScript(opts: {
  pid: number;
  newApp: string;
  targetApp: string;
  logPath: string;
}): string {
  const { pid, newApp, targetApp, logPath } = opts;
  return [
    "#!/bin/bash",
    `exec >>${shq(logPath)} 2>&1`,
    "echo \"[swap] $(date) starting\"",
    `PID=${pid}`,
    `NEW=${shq(newApp)}`,
    `TARGET=${shq(targetApp)}`,
    `STAGE="$TARGET.new"`,
    "# Wait (≤20s) for the old app to exit so the bundle isn't busy.",
    'for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
    "sleep 0.3",
    'rm -rf "$STAGE"',
    '/usr/bin/ditto "$NEW" "$STAGE" || { echo "[swap] ditto failed"; /usr/bin/open "$TARGET"; exit 1; }',
    '/usr/bin/xattr -cr "$STAGE" 2>/dev/null || true',
    'rm -rf "$TARGET"',
    'mv "$STAGE" "$TARGET" || { echo "[swap] mv failed"; exit 1; }',
    '/usr/bin/xattr -cr "$TARGET" 2>/dev/null || true',
    'echo "[swap] swapped; relaunching"',
    '/usr/bin/open "$TARGET"',
  ].join("\n");
}
