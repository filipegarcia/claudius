#!/usr/bin/env node
/**
 * Native-module ABI mode-lock.
 *
 * Phase 0 follow-up of docs/electron-conversion/PLAN.md.
 *
 * `better-sqlite3` is a native module. After running
 * `electron-builder install-app-deps` (rebuild for Electron) the
 * resulting .node binary can no longer be loaded by plain Node — and
 * vice versa. Switching between `bun run dev` and `bun run
 * electron:dev` requires a rebuild round-trip.
 *
 * This script writes a tiny lockfile recording which ABI the native
 * modules are currently built for, plus three query modes:
 *
 *   - `check`  — print a friendly warning if the lock points at the
 *                wrong ABI. Non-blocking; mostly historical.
 *   - `ensure` — if the lock is wrong, spawn the matching rebuild
 *                script and BLOCK until the .node is restored. This is
 *                what `bun run dev`'s `predev` step uses: an Electron
 *                build leaves node_modules at Electron's ABI 146; a
 *                later `bun run dev` (Node ABI 127) would throw
 *                ERR_DLOPEN_FAILED on the first SQLite call. `ensure`
 *                makes that recovery automatic instead of "click around
 *                until you find the right rebuild command in the
 *                README".
 *   - `write`  — set the lock to the given ABI (called by the rebuild
 *                scripts themselves; user code shouldn't need this).
 *
 * Lockfile lives at `dist-electron/native-abi.json` (gitignored as
 * part of `/dist-electron/`).
 *
 * Usage:
 *   node scripts/native-abi.mjs write electron
 *   node scripts/native-abi.mjs write node
 *   node scripts/native-abi.mjs check electron     # for electron:dev
 *   node scripts/native-abi.mjs check node         # for bun run dev
 *   node scripts/native-abi.mjs ensure node        # for predev — auto-heals
 *   node scripts/native-abi.mjs ensure electron    # symmetric counterpart
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const LOCK_DIR = path.join(REPO_ROOT, "dist-electron");
const LOCK_FILE = path.join(LOCK_DIR, "native-abi.json");

const [, , subcommand, arg] = process.argv;

function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLock(abi) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const payload = {
    abi,
    timestamp: new Date().toISOString(),
    note:
      abi === "electron"
        ? "Native modules built for Electron's V8. `bun run dev` will segfault until you run `bun run electron:rebuild-native-for-node`."
        : "Native modules built for plain Node. `electron:dev` / `electron:build` will rebuild before launching.",
  };
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[native-abi] wrote ${LOCK_FILE} (abi=${abi})`);
}

function checkLock(expected) {
  const lock = readLock();
  if (!lock) return; // No lock yet — assume the user is on a fresh checkout.
  if (lock.abi === expected) return; // OK.
  const wantedScript =
    expected === "node"
      ? "bun run electron:rebuild-native-for-node"
      : "bun run electron:rebuild-native";
  // Warn but don't block — explicit "do the work" is the user's call.
  console.warn(
    `\n[native-abi] WARNING: native modules are currently built for "${lock.abi}", ` +
      `but this command expects "${expected}".\n` +
      `[native-abi] If you hit a "NODE_MODULE_VERSION" error or a segfault, run:\n` +
      `[native-abi]   ${wantedScript}\n`,
  );
}

/**
 * Auto-fix the lock by spawning the matching rebuild script. Idempotent —
 * a lock already at the requested ABI is a no-op, so `ensure` is cheap to
 * put in front of every `bun run dev` / `bun run electron:dev` invocation.
 *
 * Why this lives here (and not as a one-line `&&` in the dev script):
 *   - The dev script should be readable. "Run rebuild conditionally" is
 *     not expressible in bash one-liners without `case` blocks.
 *   - Spawning `bun run …` from JS gives us a precise exit code and lets
 *     us surface a useful error if the rebuild itself fails (network
 *     issue downloading prebuilt, ABI mismatch in the prebuild lookup,
 *     etc.) without polluting bash's exit-status semantics.
 *
 * Returns the spawned child's exit code so the caller can propagate it.
 */
function ensureLock(expected) {
  const lock = readLock();
  if (lock && lock.abi === expected) return 0;
  const script =
    expected === "node"
      ? "electron:rebuild-native-for-node"
      : "electron:rebuild-native";
  // Loud banner so users running `bun run dev` after a packaging build
  // know exactly what's happening (5–30s rebuild) and don't think the
  // dev server is hung. The recovery path is automatic but visible.
  console.log(
    `\n[native-abi] lock at "${lock?.abi ?? "<unset>"}" but this command needs "${expected}".\n` +
      `[native-abi] auto-running \`bun run ${script}\` to restore the right ABI…\n`,
  );
  const result = spawnSync("bun", ["run", script], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error && result.error.code === "ENOENT") {
    console.error(
      `[native-abi] bun not found on PATH — install bun (https://bun.sh) or rebuild manually: bun run ${script}`,
    );
    process.exit(1);
  }
  return result.status ?? 1;
}

switch (subcommand) {
  case "write": {
    if (arg !== "electron" && arg !== "node") {
      console.error("usage: native-abi.mjs write <electron|node>");
      process.exit(1);
    }
    writeLock(arg);
    break;
  }
  case "check": {
    if (arg !== "electron" && arg !== "node") {
      console.error("usage: native-abi.mjs check <electron|node>");
      process.exit(1);
    }
    checkLock(arg);
    break;
  }
  case "ensure": {
    if (arg !== "electron" && arg !== "node") {
      console.error("usage: native-abi.mjs ensure <electron|node>");
      process.exit(1);
    }
    process.exit(ensureLock(arg));
    break;
  }
  default:
    console.error("usage: native-abi.mjs <write|check|ensure> <electron|node>");
    process.exit(1);
}
