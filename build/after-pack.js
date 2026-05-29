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
const path = require("node:path");

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  // macOS only — Windows/Linux notification identity isn't gated this way.
  if (electronPlatformName !== "darwin") return;

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
