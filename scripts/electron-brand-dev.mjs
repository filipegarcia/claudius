#!/usr/bin/env node
// Brand + adhoc-sign the dev Electron binary so `bun run electron:dev`
// delivers macOS notifications to Notification Center.
//
// Why this exists:
//   macOS keys notification authorization on the running bundle's
//   *code-signing identity*. The Electron binary that `electron:dev` launches
//   (node_modules/electron/dist/Electron.app) ships as the generic
//   `com.github.Electron` / signing identifier "Electron". macOS attributes
//   every `new Notification()` to "Electron", which defaults to not-allowed,
//   and silently drops the toast — so notifications fire in JS but never reach
//   Notification Center. (Packaged builds are fixed separately by
//   build/after-pack.js; this is the dev-mode equivalent.)
//
//   Re-stamping the bundle id to the real app id (network.claudius.desktop)
//   and adhoc deep-signing makes macOS attribute dev notifications to
//   "Claudius" — sharing the SAME Notification Center authorization entry as
//   the packaged app. Verified empirically: a `new Notification().show()`
//   under that adhoc identity fires its `show` event (no `failed`/UNError 1).
//
//   No Apple Developer certificate is required — an adhoc signature is enough
//   for macOS to bind the Info.plist and treat the app as a distinct,
//   authorizable identity.
//
// Idempotent: skips the (multi-second) deep-sign when the bundle already
// carries the right identity, so it's cheap to run on every `electron:dev`.
// macOS-only; a no-op elsewhere.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_ID = "network.claudius.desktop";
const APP_NAME = "Claudius";

if (process.platform !== "darwin") {
  // Windows uses the AppUserModelID (set in electron/main.ts) and Linux
  // doesn't gate notifications on code-signing identity — nothing to do.
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const entitlements = path.join(repoRoot, "build", "entitlements.mac.plist");

// Resolve the Electron.app that `electron:dev` will actually launch. The
// `electron` package's main export IS the absolute path to the binary
// (…/Electron.app/Contents/MacOS/Electron); walk up to the .app root.
const require = createRequire(import.meta.url);
let execPath;
try {
  execPath = require("electron");
} catch (err) {
  console.warn("[brand-dev] could not resolve electron binary; skipping:", err.message);
  process.exit(0);
}
if (typeof execPath !== "string") {
  console.warn("[brand-dev] unexpected electron export; skipping");
  process.exit(0);
}
const appRoot = execPath.replace(/\/Contents\/MacOS\/[^/]+$/, "");
if (!appRoot.endsWith(".app")) {
  console.warn(`[brand-dev] electron path is not inside a .app (${execPath}); skipping`);
  process.exit(0);
}
const infoPlist = path.join(appRoot, "Contents", "Info.plist");

function plist(args) {
  return execFileSync("/usr/libexec/PlistBuddy", args, { encoding: "utf8" }).trim();
}
function plistGet(key) {
  try {
    return plist(["-c", `Print :${key}`, infoPlist]);
  } catch {
    return null;
  }
}
function plistSet(key, value) {
  try {
    plist(["-c", `Set :${key} ${value}`, infoPlist]);
  } catch {
    plist(["-c", `Add :${key} string ${value}`, infoPlist]);
  }
}

function currentSigningIdentifier() {
  // `codesign -dv` writes its dump to STDERR (not stdout), so capture both.
  const res = spawnSync("codesign", ["-dv", appRoot], { encoding: "utf8" });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return out.match(/^Identifier=(.+)$/m)?.[1] ?? null;
}

// Fast path: already branded and signed → nothing to do.
if (plistGet("CFBundleIdentifier") === APP_ID && currentSigningIdentifier() === APP_ID) {
  process.exit(0);
}

console.log(`[brand-dev] branding dev Electron as ${APP_ID} for macOS notifications`);
plistSet("CFBundleIdentifier", APP_ID);
plistSet("CFBundleName", APP_NAME);
plistSet("CFBundleDisplayName", APP_NAME);

// Adhoc deep-sign so macOS binds the rewritten Info.plist and treats the
// bundle as the network.claudius.desktop identity. --deep covers the nested
// helper apps + frameworks; for an adhoc dev signature that's acceptable.
execFileSync(
  "codesign",
  ["--force", "--deep", "--sign", "-", "--entitlements", entitlements, appRoot],
  { stdio: "inherit" },
);
console.log("[brand-dev] done");
