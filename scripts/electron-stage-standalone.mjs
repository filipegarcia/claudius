#!/usr/bin/env node
/**
 * Stage the Next standalone tree for the Electron packaged build.
 *
 * `next build` with `output: "standalone"` emits a self-contained server
 * under `.next/standalone/`, but — by Next's design — it does NOT copy the
 * client assets (`.next/static`) or the `public/` folder into that tree.
 * The deploying app is expected to copy them itself. The embedded server
 * (electron/server.ts) runs `next({ dir: ".next/standalone" })`, so Next
 * looks for those assets at `.next/standalone/.next/static` and
 * `.next/standalone/public`. Without this step `app.prepare()` throws
 * `ENOENT … .next/standalone/.next/static`.
 *
 * Run after `next build`, before `electron-builder`. Idempotent — it
 * removes any prior copy first so repeated builds don't accrete stale
 * assets.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

if (!fs.existsSync(standalone)) {
  console.error(
    `[stage-standalone] ${standalone} not found — run \`next build\` with output:"standalone" first`,
  );
  process.exit(1);
}

/** Copy `src` → `dest`, replacing any existing `dest`. */
function restage(src, dest, label) {
  if (!fs.existsSync(src)) {
    console.warn(`[stage-standalone] skip ${label}: ${src} missing`);
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[stage-standalone] copied ${label} → ${path.relative(root, dest)}`);
}

restage(
  path.join(root, ".next", "static"),
  path.join(standalone, ".next", "static"),
  ".next/static",
);
restage(path.join(root, "public"), path.join(standalone, "public"), "public");

/**
 * Turbopack's standalone output aliases externalized native/runtime packages
 * (e.g. `better-sqlite3`, `shiki`) under `.next/node_modules/` via *symlinks*
 * with content-hashed names — the generated server chunks literally
 * `require("better-sqlite3-90e2652d1716b047")`. electron-builder drops these
 * symlinks when building the asar, so at runtime the embedded server throws
 * `Cannot find module 'better-sqlite3-…'` and `app.prepare()` never resolves.
 *
 * Materialize every symlink under the standalone tree into a real copy of its
 * target so the asar is lossless and the hashed `require(...)` resolves inside
 * the packaged bundle. (Their native `.node` files are still unpacked from the
 * asar by the asarUnpack rules in electron-builder.yml.)
 */
function materializeSymlinks(dir) {
  let count = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(full);
        fs.rmSync(full, { recursive: true, force: true });
        fs.cpSync(target, full, { recursive: true, dereference: true });
        count += 1;
        console.log(
          `[stage-standalone] materialized symlink ${path.relative(root, full)}`,
        );
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  if (count === 0) console.log("[stage-standalone] no symlinks to materialize");
}

materializeSymlinks(standalone);

/**
 * Stage the Claude Agent SDK's native CLI binary package(s).
 *
 * `@anthropic-ai/claude-agent-sdk` ships its actual `claude` executable in
 * per-platform optional deps (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`).
 * The SDK resolves it at runtime via
 * `require.resolve("@anthropic-ai/claude-agent-sdk-<platform>/claude")`.
 * Because that resolution is dynamic, Next/Turbopack's standalone file-tracer
 * does NOT follow it — the platform package is dropped from the standalone
 * bundle, and at runtime the SDK throws "Native CLI binary for <platform> not
 * found" (surfaces as a 500 on `POST /api/sessions`). Copy every installed
 * platform package into the standalone tree so the resolution succeeds.
 *
 * npm only installs the optional dep matching the *host* platform (os/cpu
 * constraints), so on a dev mac this copies just `darwin-arm64`. A real
 * cross-platform `electron:dist` must build each target on its own platform
 * (or force-install all optionals) — see the host-platform guard below, which
 * hard-fails when the binary for the platform we're packaging is absent rather
 * than silently shipping the 500.
 */
function stageSdkNativeBinaries() {
  const anthropicDir = path.join(root, "node_modules", "@anthropic-ai");
  if (!fs.existsSync(anthropicDir)) {
    throw new Error(
      `[stage-standalone] ${anthropicDir} missing — cannot stage the Claude Agent SDK native binary`,
    );
  }
  const platformPkgs = fs
    .readdirSync(anthropicDir)
    .filter((name) => name.startsWith("claude-agent-sdk-"));

  const destAnthropic = path.join(
    standalone,
    "node_modules",
    "@anthropic-ai",
  );
  for (const name of platformPkgs) {
    restage(
      path.join(anthropicDir, name),
      path.join(destAnthropic, name),
      `@anthropic-ai/${name}`,
    );
  }

  // Hard-fail if the package for the platform we're packaging didn't get
  // staged. A silent skip ships a guaranteed-broken build (the 500 above).
  //
  // We guard BOTH the host arch AND — when cross-building — the target arch.
  // On a native build they're the same. On the release's darwin-x64 cross-build
  // (arm64 runner), `bun install` only lands the arm64 optional, so the target
  // x64 package must be force-staged first (scripts/electron-stage-claude-sdk.mjs,
  // mirroring the @next/swc-darwin-x64 dance). If that step is ever skipped, the
  // host-only guard would pass while the shipped x64 app silently lacks its
  // binary — caught only by the late packaged-smoke. Setting
  // CLAUDIUS_TARGET_ARCH (the release job does) makes the miss fail HERE, loudly,
  // at the staging step.
  const targetArch = process.env.CLAUDIUS_TARGET_ARCH || process.arch;
  const targetOs = process.env.CLAUDIUS_TARGET_OS || process.platform;
  const required = new Set([
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    `claude-agent-sdk-${targetOs}-${targetArch}`,
  ]);
  for (const pkg of required) {
    if (!fs.existsSync(path.join(destAnthropic, pkg, "claude"))) {
      throw new Error(
        `[stage-standalone] Claude Agent SDK native binary for @anthropic-ai/${pkg} was not ` +
          `staged into the standalone bundle — the packaged app would 500 on session creation. ` +
          `For a native build, run a clean install (without --omit=optional) on this platform. ` +
          `For a cross-build, force-install the target package first ` +
          `(node scripts/electron-stage-claude-sdk.mjs --arch=${targetArch} --os=${targetOs}).`,
      );
    }
  }
}

stageSdkNativeBinaries();

console.log("[stage-standalone] done");
