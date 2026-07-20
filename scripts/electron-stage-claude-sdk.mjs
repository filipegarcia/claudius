#!/usr/bin/env node
/**
 * Stage the `@anthropic-ai/claude-agent-sdk-${os}-${arch}` package into
 * `node_modules/@anthropic-ai/` straight from the npm registry, bypassing the
 * package manager's platform check.
 *
 * Why this script exists (the exact sibling of electron-stage-next-swc.mjs):
 *
 * `@anthropic-ai/claude-agent-sdk` ships its `claude` executable in per-platform
 * optional deps (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`). `bun install` on
 * an arm64 host only resolves the optional matching the HOST platform — so a
 * `macos-14` runner gets `claude-agent-sdk-darwin-arm64` and never the
 * `-darwin-x64` package. When the release CROSS-builds the x64 macOS app on that
 * arm64 runner, `scripts/electron-stage-standalone.mjs` finds no darwin-x64
 * package to copy, and its hard-fail guard only checks the HOST arch — so the
 * x64 `claude` binary is silently dropped from the standalone bundle. The
 * packaged x64 app then 500s on session creation ("Native CLI binary for
 * darwin-x64 not found"), and the packaged smoke's arch assertion fails
 * (tests/electron-packaged/mac-smoke.spec.ts).
 *
 * Neither `bun add` nor `npm install` can pull the mismatched-platform tarball
 * (bun silently skips it on os/cpu mismatch; npm rejects EBADPLATFORM) — both
 * correct for normal use, both blocking exactly what cross-building needs. So we
 * pull the tarball straight from the registry and unpack it where the package
 * manager would have. Pinned to the EXACT installed SDK version (read from
 * node_modules, i.e. lockfile-resolved) so it matches `claude-agent-sdk`'s own
 * optionalDependencies pin.
 *
 * Run via the release workflow's macos-x64 job (before the standalone stage):
 *   node scripts/electron-stage-claude-sdk.mjs --arch=x64
 *
 * Or directly:
 *   node scripts/electron-stage-claude-sdk.mjs --arch=arm64 --os=darwin
 *
 * Idempotent: a second run with the same arch and a matching on-disk version is
 * a no-op (cheap to re-run failed builds without re-fetching the tarball).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ── arg parsing ────────────────────────────────────────────────────────────
// Tiny ad-hoc parser — `--key=value` and `--key value` both work (mirrors
// electron-stage-next-swc.mjs; not worth a yargs dep for two flags).
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

// Only {darwin}×{x64,arm64} is wired — that's what the release cross-builds (an
// arm64 runner producing the x64 macOS app). Linux/Windows build on their own
// native runners, so their host-arch optional is already installed and needs no
// cross-staging; and the SDK's linux packages carry `-musl` variants that this
// simple "one tarball" fetch doesn't model. Fail loud rather than stage wrong.
const SUPPORTED_OS = new Set(["darwin"]);
const SUPPORTED_ARCH = new Set(["x64", "arm64"]);
if (!SUPPORTED_OS.has(platformOs)) {
  console.error(
    `[stage-claude-sdk] unsupported --os=${platformOs}; only ${[...SUPPORTED_OS].join(", ")} is wired.`,
  );
  process.exit(1);
}
if (!SUPPORTED_ARCH.has(arch)) {
  console.error(
    `[stage-claude-sdk] unsupported --arch=${arch}; want one of ${[...SUPPORTED_ARCH].join(", ")}`,
  );
  process.exit(1);
}

// ── version discovery ──────────────────────────────────────────────────────
// Pin to whatever `@anthropic-ai/claude-agent-sdk` version is installed in
// node_modules — the lockfile-resolved version, not the semver range in
// package.json — so the platform package matches the SDK's own optionalDeps pin
// (they're locked to the exact same version).
const sdkPkgPath = path.join(
  REPO_ROOT,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "package.json",
);
if (!existsSync(sdkPkgPath)) {
  console.error(
    `[stage-claude-sdk] ${path.relative(REPO_ROOT, sdkPkgPath)} missing — run \`bun install\` first.`,
  );
  process.exit(1);
}
const SDK_VERSION = JSON.parse(readFileSync(sdkPkgPath, "utf8")).version;
if (typeof SDK_VERSION !== "string" || SDK_VERSION.length === 0) {
  console.error(`[stage-claude-sdk] no version field in ${sdkPkgPath}`);
  process.exit(1);
}

// ── target paths ───────────────────────────────────────────────────────────
const pkgName = `@anthropic-ai/claude-agent-sdk-${platformOs}-${arch}`;
const unscopedName = pkgName.split("/")[1]; // npm tarballs strip the @scope/ prefix
const tarballUrl = `https://registry.npmjs.org/${pkgName}/-/${unscopedName}-${SDK_VERSION}.tgz`;
const targetDir = path.join(REPO_ROOT, "node_modules", pkgName);
const claudeBinPath = path.join(targetDir, "claude");
const installedPkgJsonPath = path.join(targetDir, "package.json");

// ── idempotency check ──────────────────────────────────────────────────────
// Right version already on disk with the binary present → done. Re-running the
// build loop shouldn't re-pay the tarball fetch.
if (existsSync(installedPkgJsonPath) && existsSync(claudeBinPath)) {
  try {
    const installedVersion = JSON.parse(readFileSync(installedPkgJsonPath, "utf8")).version;
    if (installedVersion === SDK_VERSION) {
      ensureExecutable(claudeBinPath);
      const sizeMB = (statSync(claudeBinPath).size / (1024 * 1024)).toFixed(1);
      console.log(
        `[stage-claude-sdk] ${pkgName}@${SDK_VERSION} already staged (${sizeMB} MB) → skip`,
      );
      process.exit(0);
    }
    console.log(
      `[stage-claude-sdk] version drift: have ${installedVersion}, want ${SDK_VERSION} — restaging`,
    );
  } catch {
    // Corrupt package.json — fall through and restage from scratch.
  }
}

// ── fetch + extract ────────────────────────────────────────────────────────
// Two-step fetch + extract without a shell (targetDir is a plain argv element
// passed to tar — no shell interpolation). curl stdout buffered → tar stdin.
// Always rm + mkdir first so a stale dir can't leave a hybrid version.
console.log(`[stage-claude-sdk] fetching ${tarballUrl}`);
rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

const curlResult = spawnSync("curl", ["-fsSL", tarballUrl], {
  encoding: "buffer",
  maxBuffer: 150 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
if (curlResult.status !== 0 || curlResult.error) {
  console.error(
    `[stage-claude-sdk] curl failed (status=${curlResult.status}, signal=${curlResult.signal ?? "none"})`,
  );
  rmSync(targetDir, { recursive: true, force: true });
  process.exit(curlResult.status ?? 1);
}
const tarResult = spawnSync("tar", ["-xz", "--strip-components=1", "-C", targetDir], {
  input: curlResult.stdout,
  stdio: ["pipe", "inherit", "inherit"],
});
if (tarResult.status !== 0 || tarResult.error) {
  console.error(
    `[stage-claude-sdk] tar failed (status=${tarResult.status}, signal=${tarResult.signal ?? "none"})`,
  );
  rmSync(targetDir, { recursive: true, force: true });
  process.exit(tarResult.status ?? 1);
}

// ── sanity-check ───────────────────────────────────────────────────────────
// The whole point is a runnable `claude` binary in the staged package. If it's
// missing the packaged app 500s at first session; if it's not +x the SDK spawn
// fails EACCES. Fail loud at build time rather than at first launch. The
// packaged-smoke arch assertion (mac-smoke.spec.ts) is the belt to this braces.
if (!existsSync(claudeBinPath)) {
  console.error(
    `[stage-claude-sdk] extract completed but 'claude' not present in ${path.relative(REPO_ROOT, targetDir)}/ — registry layout may have changed.`,
  );
  process.exit(1);
}
ensureExecutable(claudeBinPath);

const finalSizeMB = (statSync(claudeBinPath).size / (1024 * 1024)).toFixed(1);
console.log(
  `[stage-claude-sdk] ✓ ${pkgName}@${SDK_VERSION} → ${path.relative(REPO_ROOT, claudeBinPath)} (${finalSizeMB} MB)`,
);

/**
 * Guarantee the +x bit. npm platform tarballs ship `claude` executable and
 * `tar` preserves mode, but a registry-layout or tar-flag change could quietly
 * drop it — and the packaged app's SDK spawn would then fail EACCES. Cheap to
 * enforce; matches what `mac-smoke.spec.ts` asserts (`mode & 0o111`).
 */
function ensureExecutable(binPath) {
  try {
    const mode = statSync(binPath).mode;
    if ((mode & 0o111) === 0) {
      chmodSync(binPath, mode | 0o755);
      console.log(`[stage-claude-sdk] set +x on ${path.relative(REPO_ROOT, binPath)}`);
    }
  } catch (err) {
    console.error(`[stage-claude-sdk] could not ensure +x on ${binPath}: ${String(err)}`);
    process.exit(1);
  }
}
