/**
 * Coverage for the macOS custom self-replace helpers — the certless update path
 * (download from Releases → extract → swap the .app → relaunch) used when the
 * build is ad-hoc/unsigned and Squirrel.Mac can't do the swap.
 *
 * Only the pure helpers are tested here; the electron-coupled orchestration
 * (download/ditto/spawn/quit) lives in updater.ts and needs a live app.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  appBundleFromExecPath,
  buildSwapScript,
  pickMacZip,
  releaseAssetUrl,
  sha512Base64,
  type ReleaseFile,
} from "@/electron/ipc/self-replace-mac";

describe("pickMacZip", () => {
  const files: ReleaseFile[] = [
    { url: "Claudius-1.2.3-mac-arm64.zip", sha512: "a", size: 1 },
    { url: "Claudius-1.2.3-mac-x64.zip", sha512: "b", size: 2 },
    { url: "Claudius-1.2.3-mac-arm64.dmg", sha512: "c", size: 3 },
  ];

  test("picks the zip matching the running arch", () => {
    expect(pickMacZip(files, "arm64")?.url).toBe("Claudius-1.2.3-mac-arm64.zip");
    expect(pickMacZip(files, "x64")?.url).toBe("Claudius-1.2.3-mac-x64.zip");
  });

  test("never returns a .dmg (Squirrel-style feeds swap from the zip)", () => {
    expect(pickMacZip(files, "arm64")?.url.endsWith(".zip")).toBe(true);
  });

  test("falls back to the first zip when no arch matches", () => {
    expect(pickMacZip(files, "ia32")?.url).toBe("Claudius-1.2.3-mac-arm64.zip");
  });

  test("returns null when there's no zip asset", () => {
    expect(pickMacZip([{ url: "Claudius.dmg" }], "arm64")).toBeNull();
    expect(pickMacZip([], "arm64")).toBeNull();
  });
});

describe("releaseAssetUrl", () => {
  test("builds the GitHub download URL with a v-prefixed tag", () => {
    expect(releaseAssetUrl("filipegarcia", "claudius", "1.2.3", "Claudius-1.2.3-mac-arm64.zip")).toBe(
      "https://github.com/filipegarcia/claudius/releases/download/v1.2.3/Claudius-1.2.3-mac-arm64.zip",
    );
  });

  test("doesn't double-prefix a version that already starts with v", () => {
    expect(releaseAssetUrl("o", "r", "v2.0.0", "a.zip")).toBe(
      "https://github.com/o/r/releases/download/v2.0.0/a.zip",
    );
  });
});

describe("appBundleFromExecPath", () => {
  test("derives the .app root from the executable path", () => {
    expect(appBundleFromExecPath("/Applications/Claudius.app/Contents/MacOS/Claudius")).toBe(
      "/Applications/Claudius.app",
    );
  });

  test("works for a user-local install location", () => {
    expect(
      appBundleFromExecPath("/Users/x/Applications/Claudius.app/Contents/MacOS/Claudius"),
    ).toBe("/Users/x/Applications/Claudius.app");
  });

  test("returns null when not inside a .app bundle (dev/unpackaged)", () => {
    expect(appBundleFromExecPath("/usr/local/bin/electron")).toBeNull();
  });
});

describe("sha512Base64", () => {
  test("matches Node's own base64 sha512 (the digest electron-updater records)", () => {
    const buf = Buffer.from("claudius");
    const expected = createHash("sha512").update(buf).digest("base64");
    expect(sha512Base64(buf)).toBe(expected);
  });
});

describe("buildSwapScript", () => {
  const script = buildSwapScript({
    pid: 4242,
    newApp: "/tmp/claudius-update-1.2.3/Claudius.app",
    targetApp: "/Applications/Claudius.app",
    logPath: "/Users/x/Library/Application Support/Claudius/self-replace.log",
  });

  test("waits for the old pid, swaps atomically, de-quarantines, and relaunches", () => {
    expect(script).toContain("PID=4242");
    expect(script).toContain('kill -0 "$PID"'); // waits for exit
    expect(script).toContain("/usr/bin/ditto"); // bundle-safe copy
    expect(script).toContain('STAGE="$TARGET.new"'); // same-dir staging
    expect(script).toContain('mv "$STAGE" "$TARGET"'); // atomic rename
    expect(script).toContain("/usr/bin/xattr -cr"); // strip quarantine
    expect(script).toContain('/usr/bin/open "$TARGET"'); // relaunch
  });

  test("single-quotes interpolated paths and redirects output to the log", () => {
    expect(script).toContain("NEW='/tmp/claudius-update-1.2.3/Claudius.app'");
    expect(script).toContain("TARGET='/Applications/Claudius.app'");
    expect(script).toContain("exec >>'/Users/x/Library/Application Support/Claudius/self-replace.log'");
  });

  test("escapes embedded single quotes in paths", () => {
    const s = buildSwapScript({
      pid: 1,
      newApp: "/tmp/it's here/Claudius.app",
      targetApp: "/Applications/Claudius.app",
      logPath: "/tmp/log",
    });
    expect(s).toContain("NEW='/tmp/it'\\''s here/Claudius.app'");
  });
});
