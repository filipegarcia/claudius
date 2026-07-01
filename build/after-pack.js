// electron-builder afterPack hook — adhoc-sign the macOS app for certless
// (local / CI-without-Apple-credentials) builds.
//
// Why this exists:
//   macOS gates Notification Center delivery on the app's *code-signing
//   identity*. An unsigned `--dir` build (`bun run electron:app`, which sets
//   CSC_IDENTITY_AUTO_DISCOVERY=false) leaves the raw Electron binary whose
//   signing identifier is the generic "Electron" with the Info.plist NOT
//   bound into the signature. macOS then attributes any `new Notification()`
//   to "Electron", which defaults to not-allowed, and silently drops the
//   toast — the notification fires in JS but never reaches Notification
//   Center. (See memory: project_electron_dev_notifications_blocked.)
//
//   Adhoc deep-signing the bundle (`codesign --sign -`) binds the Info.plist
//   and makes the signing identifier the real bundle id
//   (network.claudius.desktop). Verified empirically: with that identity the
//   notification's `show` event fires and the toast lands in Notification
//   Center — no Apple Developer certificate required.
//
// When this runs:
//   afterPack fires before electron-builder's own signing step. We only
//   adhoc-sign when real Developer ID signing is disabled
//   (CSC_IDENTITY_AUTO_DISCOVERY === "false", set by `electron:app`). For a
//   genuinely signed + notarized build (`electron:dist:mac` with CSC_*/APPLE_*
//   credentials) we do nothing here and let electron-builder apply the real
//   Developer ID signature — re-signing adhoc would clobber it.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// electron-builder's Arch enum → Node's dist arch token.
const ARCH_TOKEN = { 1: "x64", 3: "arm64" };

/**
 * Bundle a RELOCATABLE `node` into `runtimeDir/node`. The build host's node is
 * often Homebrew's, which is a non-relocatable stub linking `@rpath/libnode.*`
 * — copied out of its Cellar it fails with "Library not loaded". The official
 * nodejs.org binary is a single self-contained executable, so fetch that for
 * the target arch (cached in tmp). Matches the build host's node version.
 */
function bundleRelocatableNode(runtimeDir, targetArch) {
  const ver = process.version; // e.g. "v22.22.1"
  const arch = ARCH_TOKEN[targetArch] ?? (os.arch() === "x64" ? "x64" : "arm64");
  const base = `node-${ver}-darwin-${arch}`;
  const cache = path.join(os.tmpdir(), "claudius-preview-node");
  fs.mkdirSync(cache, { recursive: true });
  const tgz = path.join(cache, `${base}.tar.gz`);
  if (!fs.existsSync(tgz)) {
    execFileSync("curl", ["-fsSL", "-o", tgz, `https://nodejs.org/dist/${ver}/${base}.tar.gz`], {
      stdio: "inherit",
    });
  }
  execFileSync("tar", ["-xzf", tgz, "-C", cache], { stdio: "inherit" });
  const extracted = path.join(cache, base, "bin", "node");
  fs.copyFileSync(extracted, path.join(runtimeDir, "node"));
  fs.chmodSync(path.join(runtimeDir, "node"), 0o755);
}

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  // ── Linux: AppImage --no-sandbox launch wrapper ──────────────────────
  //
  // A double-clicked / directly-run AppImage executes its internal AppRun
  // with NO args, so electron-builder's `AppRun --no-sandbox %U` desktop-Exec
  // line (integrated-launcher only) never applies. On hosts without working
  // unprivileged user namespaces (Ubuntu 23.10+ AppArmor restriction —
  // DEFAULT on 24.04 — hardened kernels, running as root) Chromium then aborts
  // at the setuid-sandbox check BEFORE any of our JS runs, so no in-app fix
  // (app.commandLine.appendSwitch / relaunch) can prevent it — verified via
  // the linux-smoke boot marker. The only lever is `--no-sandbox` on the real
  // argv, so replace the executable with a tiny shim that re-execs the real
  // binary with it.
  //
  // Conditioned on $APPIMAGE (exported by the AppImage runtime) so deb/rpm —
  // which install a properly-SUID chrome-sandbox via their postinst and never
  // set $APPIMAGE — keep their full sandbox. afterPack is shared across all
  // Linux targets, hence the runtime guard rather than a target check.
  if (electronPlatformName === "linux") {
    const exe = packager.executableName; // e.g. "claudius"
    const real = path.join(appOutDir, exe);
    const renamed = path.join(appOutDir, `${exe}.bin`);
    if (!exe || !fs.existsSync(real)) {
      // Don't hard-fail the build on an unexpected layout — the linux-smoke
      // job will catch a still-broken AppImage. Just log loudly.
      // eslint-disable-next-line no-console
      console.warn(
        `[after-pack] linux: executable ${real} not found (executableName=${exe}); skipping --no-sandbox wrapper`,
      );
      return;
    }
    if (fs.existsSync(renamed)) return; // already wrapped (idempotent)
    fs.renameSync(real, renamed); // rename preserves the +x bit
    // POSIX sh, not bash — the AppImage doesn't bundle a shell and relies on
    // the host's; /bin/sh is the portable floor and `[ -n ]` is POSIX.
    const wrapper = `#!/bin/sh
# Auto-generated by build/after-pack.js — see that file for the full rationale.
# Add --no-sandbox only for AppImage launches; deb/rpm keep their SUID sandbox.
HERE=$(dirname "$(readlink -f "$0")")
if [ -n "$APPIMAGE" ]; then
  exec "$HERE/${exe}.bin" --no-sandbox "$@"
fi
exec "$HERE/${exe}.bin" "$@"
`;
    fs.writeFileSync(real, wrapper, { mode: 0o755 });
    // eslint-disable-next-line no-console
    console.log(
      `[after-pack] linux: wrapped ${exe} → ${exe}.bin with an AppImage --no-sandbox shim`,
    );
    return;
  }

  // macOS only — Windows/Linux notification identity isn't gated this way.
  if (electronPlatformName !== "darwin") return;

  // ── Bundle a real `node` + `bun` for the customization preview runtime ──
  //
  // The customization live-preview spawns `next dev`; Tailwind v4's native
  // @tailwindcss/oxide SIGTRAPs under Electron-as-node, so the preview MUST run
  // under a REAL node (proven in the de-risk spike). We also ship `bun` to
  // complete the mirror's stripped dev deps on first preview (`bun install`).
  // Shipped at Contents/Resources/preview-runtime/{node,bun}; lib/server/
  // preview-server.ts resolves them via process.resourcesPath.
  //
  // Copied for darwin regardless of signing path (before the adhoc/real signing
  // below) so both certless and notarized builds carry them. The binaries come
  // from the BUILD HOST, which matches the target arch because release.yml runs
  // one native job per arch (mac-arm64 / mac-x64) — a cross-arch copy would ship
  // a broken node. `--deep` adhoc-signing (below) covers them for local builds;
  // for notarized builds electron-builder's signing pass (after afterPack) signs
  // nested Mach-O, and the app entitlements already allow JIT for V8.
  {
    const appName = packager.appInfo.productFilename;
    const runtimeDir = path.join(
      appOutDir,
      `${appName}.app`,
      "Contents",
      "Resources",
      "preview-runtime",
    );
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      // Fetch the official, RELOCATABLE node for the target arch (the build
      // host's node may be a non-relocatable Homebrew stub).
      bundleRelocatableNode(runtimeDir, context.arch);
      // eslint-disable-next-line no-console
      console.log("[after-pack] bundled node → Resources/preview-runtime/node");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[after-pack] could not bundle node: ${e && e.message}`);
    }
    const bunCandidates = [
      path.join(process.env.HOME || "", ".bun", "bin", "bun"),
      ...(process.env.PATH || "").split(":").map((d) => (d ? path.join(d, "bun") : "")),
    ].filter(Boolean);
    const bunBin = bunCandidates.find((p) => fs.existsSync(p));
    if (bunBin) {
      try {
        fs.copyFileSync(bunBin, path.join(runtimeDir, "bun"));
        fs.chmodSync(path.join(runtimeDir, "bun"), 0o755);
        // eslint-disable-next-line no-console
        console.log("[after-pack] bundled bun → Resources/preview-runtime/bun");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[after-pack] could not bundle bun: ${e && e.message}`);
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[after-pack] no bun binary found on the build host — packaged first-preview `bun install` will need a user-installed bun",
      );
    }
  }

  // Skip when a real signing identity will be applied by electron-builder.
  // `electron:app` sets CSC_IDENTITY_AUTO_DISCOVERY=false; signed/notarized
  // release builds (`electron:dist:mac`) leave it unset and provide CSC_*.
  const autoDiscoveryDisabled =
    process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false";
  const hasSigningCreds = Boolean(
    process.env.CSC_LINK ||
      process.env.CSC_NAME ||
      process.env.CSC_KEY_PASSWORD ||
      process.env.APPLE_ID,
  );
  if (!autoDiscoveryDisabled && hasSigningCreds) return;

  const appName = packager.appInfo.productFilename; // "Claudius"
  const appPath = path.join(appOutDir, `${appName}.app`);
  const entitlements = path.join(__dirname, "entitlements.mac.plist");

  // eslint-disable-next-line no-console
  console.log(`[after-pack] adhoc deep-signing ${appPath} for notifications`);
  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--entitlements",
      entitlements,
      appPath,
    ],
    { stdio: "inherit" },
  );
};
