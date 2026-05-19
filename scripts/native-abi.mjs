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
 * modules are currently built for, and a `check` mode that emits a
 * friendly warning when the lock is set to the OTHER side. The check
 * is non-blocking — we don't want to surprise a developer with a
 * hard exit, just nudge them toward the right rebuild command.
 *
 * Lockfile lives at `.dist-electron/native-abi.json` (gitignored as
 * part of `/dist-electron/`).
 *
 * Usage:
 *   node scripts/native-abi.mjs write electron
 *   node scripts/native-abi.mjs write node
 *   node scripts/native-abi.mjs check electron   # for electron:dev
 *   node scripts/native-abi.mjs check node       # for bun run dev
 */
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
  default:
    console.error("usage: native-abi.mjs <write|check> <electron|node>");
    process.exit(1);
}
