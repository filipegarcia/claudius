#!/usr/bin/env node
/**
 * Stage the `@next/swc-${os}-${arch}` package into `node_modules/@next/`
 * straight from the npm registry, bypassing the package manager's
 * platform check.
 *
 * Why this script exists:
 *
 * `bun install` on an arm64 host only resolves the optional `@next/swc-*`
 * package that matches the HOST platform — so we get `@next/swc-darwin-arm64`
 * and never `@next/swc-darwin-x64`. Next then loads the wrong-arch binary
 * at runtime in the packaged x64 app, falls back to its built-in
 * downloader, and that downloader tries to `mkdir` inside the read-only
 * asar (`ENOTDIR /…/app.asar/node_modules/next/next-swc-fallback/
 * @next/swc-darwin-x64`). The embedded server never finishes preparing →
 * the BrowserWindow hangs on a blank URL.
 *
 * Staging the x64 (or any) binding pinned to the EXACT Next version
 * ensures electron-builder packs it (asarUnpack: node_modules/@next/**
 * lives in electron-builder.yml) and Next's runtime loader never reaches
 * the fallback path.
 *
 * Neither `bun add` nor `npm install` can do this:
 *   • Bun honors the package's declared `cpu`/`os` fields and SILENTLY
 *     skips writing mismatched-platform bindings (no error, no warning).
 *   • npm's `--cpu`/`--os` flags only FILTER optionals when the host
 *     matches; on an arm64 host trying to fetch a darwin-x64 package,
 *     npm rejects with EBADPLATFORM regardless of flags (`--force` would
 *     downgrade it to a warning, but the install still skips the tarball).
 *
 * Both behaviors are correct for normal use — they protect users from
 * landing a binary that can't run on their machine. They just actively
 * block what cross-building NEEDS, which is exactly that mismatched
 * binary.
 *
 * So we pull the tarball straight from the registry and unpack it into
 * the spot npm would have. Fully deterministic, no engine checks, no
 * dependency on which package manager's overrides are currently honored.
 *
 * Run via package script:
 *   `bun run electron:dist:mac` (calls this with --arch=x64)
 *   `bun run electron:app`      (calls this with --arch=x64)
 *
 * Or directly:
 *   node scripts/electron-stage-next-swc.mjs --arch=x64
 *   node scripts/electron-stage-next-swc.mjs --arch=arm64 --os=darwin
 *
 * Idempotent: a second run with the same arch and a matching version on
 * disk is a no-op (good for re-running failed builds without paying the
 * tarball-fetch cost again).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ── arg parsing ────────────────────────────────────────────────────────────
// Tiny ad-hoc parser — `--key=value` and `--key value` both work. We don't
// pull in commander/yargs for a script with two flags.
function readArg(name, fallback) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === `--${name}` && i + 1 < argv.length) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

const arch = readArg("arch", "x64");
const platformOs = readArg("os", "darwin");

// Only the {darwin}×{x64,arm64} combinations are wired today — that's what
// the release pipeline cross-builds. Linux/Windows SWC bindings follow a
// different filename convention (`-gnu`/`-musl`/`-msvc` suffixes), and we
// don't currently cross-build for those platforms. Fail loud rather than
// silently produce a broken stage.
const SUPPORTED_OS = new Set(["darwin"]);
const SUPPORTED_ARCH = new Set(["x64", "arm64"]);
if (!SUPPORTED_OS.has(platformOs)) {
  console.error(
    `[stage-next-swc] unsupported --os=${platformOs}; only ${[...SUPPORTED_OS].join(", ")} is wired. ` +
      `Extend SUPPORTED_OS + the filename convention below if you need another platform.`,
  );
  process.exit(1);
}
if (!SUPPORTED_ARCH.has(arch)) {
  console.error(
    `[stage-next-swc] unsupported --arch=${arch}; want one of ${[...SUPPORTED_ARCH].join(", ")}`,
  );
  process.exit(1);
}

// ── version discovery ──────────────────────────────────────────────────────
// We pin the SWC binding to whatever Next version is currently installed
// in node_modules. Reading from node_modules (not package.json) means we
// pick up the LOCKFILE-resolved version, not the semver range — important
// when "next": "^16.2.6" resolves to 16.3.x and we need the SWC to match.
const nextPkgPath = path.join(REPO_ROOT, "node_modules", "next", "package.json");
if (!existsSync(nextPkgPath)) {
  console.error(
    `[stage-next-swc] ${path.relative(REPO_ROOT, nextPkgPath)} missing — run \`bun install\` first.`,
  );
  process.exit(1);
}
const NEXT_VERSION = JSON.parse(readFileSync(nextPkgPath, "utf8")).version;
if (typeof NEXT_VERSION !== "string" || NEXT_VERSION.length === 0) {
  console.error(`[stage-next-swc] no version field in ${nextPkgPath}`);
  process.exit(1);
}

// ── target paths ───────────────────────────────────────────────────────────
const pkgName = `@next/swc-${platformOs}-${arch}`;
const unscopedName = pkgName.split("/")[1]; // npm tarballs strip the @scope/ prefix
const tarballUrl = `https://registry.npmjs.org/${pkgName}/-/${unscopedName}-${NEXT_VERSION}.tgz`;
const targetDir = path.join(REPO_ROOT, "node_modules", pkgName);
const nodeBinary = `next-swc.${platformOs}-${arch}.node`;
const nodeBinaryPath = path.join(targetDir, nodeBinary);
const installedPkgJsonPath = path.join(targetDir, "package.json");

// ── idempotency check ──────────────────────────────────────────────────────
// If the package directory has the right version AND the .node binary is
// on disk, we're done. Re-running the build script is a common loop while
// debugging packaging — paying a ~10 MB tarball fetch per loop is wasteful.
if (existsSync(installedPkgJsonPath) && existsSync(nodeBinaryPath)) {
  try {
    const installedVersion = JSON.parse(
      readFileSync(installedPkgJsonPath, "utf8"),
    ).version;
    if (installedVersion === NEXT_VERSION) {
      const sizeMB = (statSync(nodeBinaryPath).size / (1024 * 1024)).toFixed(1);
      console.log(
        `[stage-next-swc] ${pkgName}@${NEXT_VERSION} already staged (${sizeMB} MB) → skip`,
      );
      process.exit(0);
    }
    console.log(
      `[stage-next-swc] version drift: have ${installedVersion}, want ${NEXT_VERSION} — restaging`,
    );
  } catch {
    // Corrupt package.json — fall through and restage from scratch.
  }
}

// ── fetch + extract ────────────────────────────────────────────────────────
// Two-step fetch + extract without a shell so targetDir is a plain argv
// element passed directly to tar — no shell interpolation possible.
// (Same pattern that closed shell-injection alert #38 in next.config.ts.)
// curl stdout is buffered and piped as stdin to tar; the ~10 MB tarball
// fits easily, 150 MB cap is just a safety ceiling.
//
// We always rm + mkdir the target first — extracting on top of a stale
// directory can leave a hybrid version (new .node + old package.json) that
// silently mis-loads at runtime.
console.log(`[stage-next-swc] fetching ${tarballUrl}`);
rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

const curlResult = spawnSync("curl", ["-fsSL", tarballUrl], {
  encoding: "buffer",
  maxBuffer: 150 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
if (curlResult.status !== 0 || curlResult.error) {
  console.error(
    `[stage-next-swc] curl failed (status=${curlResult.status}, signal=${curlResult.signal ?? "none"})`,
  );
  rmSync(targetDir, { recursive: true, force: true });
  process.exit(curlResult.status ?? 1);
}
const tarResult = spawnSync(
  "tar",
  ["-xz", "--strip-components=1", "-C", targetDir],
  { input: curlResult.stdout, stdio: ["pipe", "inherit", "inherit"] },
);
if (tarResult.status !== 0 || tarResult.error) {
  console.error(
    `[stage-next-swc] tar failed (status=${tarResult.status}, signal=${tarResult.signal ?? "none"})`,
  );
  rmSync(targetDir, { recursive: true, force: true });
  process.exit(tarResult.status ?? 1);
}

// ── sanity-check ───────────────────────────────────────────────────────────
// electron-builder asarUnpacks node_modules/@next/** — if the .node is
// missing here, the packaged app will hit the same runtime fallback this
// script is meant to prevent. Fail loud at build time rather than at
// first-launch.
if (!existsSync(nodeBinaryPath)) {
  console.error(
    `[stage-next-swc] extract completed but ${nodeBinary} not present in ${path.relative(REPO_ROOT, targetDir)}/ — registry layout may have changed.`,
  );
  process.exit(1);
}

const finalSizeMB = (statSync(nodeBinaryPath).size / (1024 * 1024)).toFixed(1);
console.log(
  `[stage-next-swc] ✓ ${pkgName}@${NEXT_VERSION} → ${path.relative(REPO_ROOT, nodeBinaryPath)} (${finalSizeMB} MB)`,
);
