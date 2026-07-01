#!/usr/bin/env node
// Build a locally-runnable Claudius.app WITHOUT disturbing your dev server or
// the app you're currently running, and WITHOUT leaving a trail of
// claudius-build2 / -build3 dirs behind.
//
// Run it:  bun run build:app        (unpacked .app, fast)
//          bun run build:app --dmg  (also produce a DMG)
//
// How it avoids the accumulation problem:
//   * Builds in ONE fixed scratch dir next to the repo (claudius-buildcache),
//     reused across runs via `rsync --delete` (warm cache → fast re-runs).
//   * Copies the finished .app back into THIS repo's release/ dir, which is
//     where you actually launch it from. Because nothing is ever launched out
//     of the scratch dir, the scratch is never "busy" and can always be reset
//     in place — so there is never a reason to bump to a new folder name.
//
// It bakes in every gotcha we hit building by hand (see .claude/skills/
// electron-build-local for the long-form rationale):
//   * strips the leaked __NEXT_PRIVATE_* env vars a running packaged Claudius
//     exports — they otherwise crash `next build` with a Turbopack
//     "distDirRoot navigates out of projectPath" panic;
//   * CLAUDIUS_REBUILD_IGNORE_DEV=1 — safe here, the scratch's better-sqlite3
//     is independent of the dev server's;
//   * `bun install --frozen-lockfile` — the rsync'd node_modules can be stale
//     vs package.json (e.g. right after a `git pull` that bumped the SDK),
//     which fails the type-check; this resyncs in seconds when already current;
//   * swaps mac target arch to the HOST arch so we don't try to cross-build
//     x64 from arm64 (which would silently produce a broken bundle).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch as hostArch } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Fixed, dedicated scratch — NOT claudius-build / -build2 / -build3 (those may
// have a running app and can't be reset). Warm cache: kept between runs.
const SCRATCH = join(dirname(REPO_ROOT), `${basename(REPO_ROOT)}-buildcache`);

const wantDmg = process.argv.includes("--dmg");

// Optional customization overlay: bake a customization's edited files into the
// build so the produced .app ships with the customization applied — WITHOUT
// publishing (touching the running app's source). The caller (the
// "Build installable app" action) computes the overlay file list and passes:
//   --overlay-src <customizationSrcDir>   the mirror to copy files FROM
//   --overlay-manifest <file>             newline-separated relative paths
// After the working tree is synced into scratch, each listed file is copied
// from the mirror over the scratch copy, so the build compiles the customized
// source.
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const overlaySrc = argValue("--overlay-src");
const overlayManifest = argValue("--overlay-manifest");
// electron-builder names the mac output dir by arch: mac-arm64 on Apple
// Silicon, plain mac on Intel.
const ARCH = hostArch() === "arm64" ? "arm64" : "x64";
const MAC_SUBDIR = ARCH === "arm64" ? "mac-arm64" : "mac";

// PATH that survives GUI / minimal-env launches (same dirs _runtime.sh adds).
const PATH_DIRS = [
  `${process.env.HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH ?? "",
].join(":");

function step(msg) {
  console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`);
}

function run(bin, args, opts = {}) {
  console.log(`  $ ${bin} ${args.join(" ")}`);
  const res = spawnSync(bin, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, PATH: PATH_DIRS, ...(opts.env ?? {}) },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`\`${bin} ${args[0]}\` exited with ${res.status}`);
}

/** PIDs running out of a given .app bundle (empty if none). */
function pidsRunningFrom(appPath) {
  const res = spawnSync("pgrep", ["-f", `${appPath}/Contents/MacOS/`], { encoding: "utf8" });
  return (res.stdout ?? "").split("\n").filter(Boolean);
}

const srcApp = join(SCRATCH, "release", MAC_SUBDIR, "Claudius.app");
const destDir = join(REPO_ROOT, "release", MAC_SUBDIR);
const destApp = join(destDir, "Claudius.app");

// Early, non-fatal warning so a 5-minute build doesn't end in a surprise.
if (existsSync(destApp) && pidsRunningFrom(destApp).length > 0) {
  console.log(
    `\n\x1b[33m⚠ ${destApp} is currently running. The build will still finish; if it's\n` +
      `  still running at copy time I'll stage the new build beside it instead of\n` +
      `  overwriting (you'll get a one-line command to swap it in).\x1b[0m`,
  );
}

// 1. Sync the working tree into the warm scratch. Excludes are ANCHORED with a
//    leading `/` — an unanchored `release/` would match node_modules/*/release/
//    and corrupt the dep graph.
step(`Syncing working tree → ${SCRATCH}`);
mkdirSync(SCRATCH, { recursive: true });
run("rsync", [
  "-a",
  "--delete",
  "--exclude=/.next/",
  "--exclude=/.next-e2e/",
  "--exclude=/.next-buildtest/",
  "--exclude=/dist-electron/",
  "--exclude=/release/",
  "--exclude=/.codeql/",
  "--exclude=/.claude/worktrees/",
  "--exclude=/test-results/",
  "--exclude=/playwright-report/",
  "--exclude=/blob-report/",
  "--exclude=/playwright/.cache/",
  `${REPO_ROOT}/`,
  `${SCRATCH}/`,
]);

// 1b. Bake the customization overlay into the scratch copy (optional). Runs
//     AFTER the rsync so it overwrites the pristine base with the user's edits,
//     and BEFORE the build so Next compiles the customized source.
if (overlaySrc && overlayManifest) {
  step(`Baking customization overlay into ${SCRATCH}`);
  const srcRoot = resolve(overlaySrc);
  const rels = readFileSync(overlayManifest, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  let applied = 0;
  for (const rel of rels) {
    // Path-safety: both endpoints must stay inside their roots (no traversal).
    const from = resolve(srcRoot, rel);
    const to = resolve(SCRATCH, rel);
    if (!from.startsWith(srcRoot + "/") || !to.startsWith(SCRATCH + "/")) {
      console.log(`  ! skipped out-of-tree path: ${rel}`);
      continue;
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      applied++;
    } catch (err) {
      console.log(`  ! failed to apply ${rel}: ${err?.message ?? err}`);
    }
  }
  console.log(`  applied ${applied}/${rels.length} overlay file(s).`);
}

// 2. Re-apply the host-arch swap (rsync just restored the committed yaml). We
//    only touch the mac target — win/linux already pin [x64].
step(`Pinning mac build to host arch [${ARCH}]`);
const ebPath = join(SCRATCH, "electron-builder.yml");
const ebOrig = readFileSync(ebPath, "utf8");
const ebSwapped = ebOrig.replaceAll("arch: [arm64, x64]", `arch: [${ARCH}]`);
if (ebSwapped === ebOrig) {
  console.log(
    "  (no `arch: [arm64, x64]` line found — electron-builder.yml may have changed;\n" +
      "   build will use whatever it declares, which could cross-build. Check the yaml.)",
  );
} else {
  writeFileSync(ebPath, ebSwapped);
  console.log("  swapped.");
}

// 3. Resync deps — rsync'd node_modules can lag package.json (e.g. post-pull
//    SDK bump). Frozen lockfile = CI-identical, ~seconds when already current.
step("Installing dependencies (frozen lockfile)");
run("bun", ["install", "--frozen-lockfile"], { cwd: SCRATCH });

// 4. Build. Strip the leaked private Next env vars + allow the in-scratch ABI
//    rebuild.
step(`Building ${wantDmg ? "DMG + .app" : ".app"} (this takes a few minutes)`);
// Strip the leaked private Next vars outright (undefined env values misbehave
// on some platforms) and allow the in-scratch native ABI rebuild.
const cleanEnv = { ...process.env, PATH: PATH_DIRS, CLAUDIUS_REBUILD_IGNORE_DEV: "1" };
delete cleanEnv.__NEXT_PRIVATE_STANDALONE_CONFIG;
delete cleanEnv.__NEXT_PRIVATE_ORIGIN;
delete cleanEnv.NEXT_DEPLOYMENT_ID;
{
  const target = wantDmg ? "electron:dist:mac" : "electron:app";
  console.log(`  $ bun run ${target}  (cwd=${SCRATCH}, __NEXT_PRIVATE_* stripped)`);
  const res = spawnSync("bun", ["run", target], { cwd: SCRATCH, stdio: "inherit", env: cleanEnv });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`build exited with ${res.status}`);
}

if (!existsSync(srcApp)) {
  throw new Error(`build finished but ${srcApp} is missing — check the log above.`);
}

// 5. Copy the finished bundle back into THIS repo. ditto preserves symlinks /
//    resource forks / perms (plain cp -R mangles bundles). rm -rf dest first to
//    avoid the cp-into-existing-dir nesting footgun.
step(`Copying app → ${destApp}`);
mkdirSync(destDir, { recursive: true });
const destBusy = existsSync(destApp) && pidsRunningFrom(destApp).length > 0;
let finalApp = destApp;
if (destBusy) {
  finalApp = `${destApp}.new`;
  rmSync(finalApp, { recursive: true, force: true });
  run("ditto", [srcApp, finalApp]);
  console.log(
    `\n\x1b[33m⚠ The existing app is still running, so I staged the new build at:\n` +
      `    ${finalApp}\n` +
      `  Quit the running Claudius, then finish the swap with:\n` +
      `    rm -rf "${destApp}" && mv "${finalApp}" "${destApp}"\x1b[0m`,
  );
} else {
  rmSync(destApp, { recursive: true, force: true });
  run("ditto", [srcApp, destApp]);
}

// 6. Sanity: a bundle symlink whose target resolves into the scratch dir would
//    dangle if the scratch were deleted. We keep the scratch warm anyway, but
//    flag it so a future "reclaim disk" doesn't silently break the app.
const links = (spawnSync("find", [finalApp, "-type", "l"], { encoding: "utf8" }).stdout ?? "")
  .split("\n")
  .filter(Boolean);
const intoScratch = links.filter((link) => {
  // -f resolves the full chain to an absolute path; if it lands inside SCRATCH
  // the link escapes the bundle.
  const resolved = spawnSync("readlink", ["-f", link], { encoding: "utf8" }).stdout?.trim() ?? "";
  return resolved.startsWith(SCRATCH + "/");
});
if (intoScratch.length > 0) {
  console.log(
    `\n\x1b[33m⚠ ${intoScratch.length} symlink(s) in the copied app resolve into ${SCRATCH}.\n` +
      `  Keep that scratch dir around, or this app will break. (Expected: 0.)\x1b[0m`,
  );
} else {
  console.log(`  symlink check: clean (${links.length} link(s), none escape the bundle).`);
}

step("Done");
console.log(`  App:  ${finalApp}`);
console.log(`  Arch: ${ARCH} (unsigned — Gatekeeper will warn; right-click → Open, or`);
console.log(`        xattr -dr com.apple.quarantine "${finalApp}")`);
console.log(`  Open: open "${finalApp}"`);
console.log(`  Scratch kept warm at ${SCRATCH} (rm -rf it to reclaim ~2 GB).`);
