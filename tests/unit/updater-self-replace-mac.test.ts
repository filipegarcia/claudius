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
  isMissingAssetError,
  latestTagFromReleasesJson,
  pickMacZip,
  releaseAssetUrl,
  sameReleaseTag,
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

  // Regression: auto-tag mints four-part tags (v0.3.268.4) while the feed and
  // package.json carry three-part semver (0.3.268). Deriving the tag from the
  // version produced .../download/v0.3.268/... — a tag that does not exist —
  // so the zip 404'd and the updater dead-ended at "download the DMG".
  test("uses the real four-part release tag verbatim", () => {
    expect(
      releaseAssetUrl("filipegarcia", "claudius", "v0.3.268.4", "Claudius-0.3.268-mac-arm64.zip"),
    ).toBe(
      "https://github.com/filipegarcia/claudius/releases/download/v0.3.268.4/Claudius-0.3.268-mac-arm64.zip",
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

describe("sameReleaseTag", () => {
  test("ignores a leading v on either side", () => {
    expect(sameReleaseTag("v0.3.318.1", "0.3.318.1")).toBe(true);
    expect(sameReleaseTag("0.3.318.1", "v0.3.318.1")).toBe(true);
    expect(sameReleaseTag("v0.3.318.1", "v0.3.318.1")).toBe(true);
  });

  test("the three-part fallback differs from the real four-part tag", () => {
    // The exact pair that 404s: we guess `v0.3.318` when `GithubUpdateInfo.tag`
    // is missing, but this repo's auto-tag published `v0.3.318.1`.
    expect(sameReleaseTag("v0.3.318", "v0.3.318.1")).toBe(false);
  });

  test("distinguishes re-releases of the same version", () => {
    expect(sameReleaseTag("v0.3.318.0", "v0.3.318.1")).toBe(false);
  });

  test("a missing tag is never 'the same' as anything", () => {
    expect(sameReleaseTag(undefined, "v1.0.0")).toBe(false);
    expect(sameReleaseTag("v1.0.0", null)).toBe(false);
    expect(sameReleaseTag(null, undefined)).toBe(false);
  });
});

describe("isMissingAssetError", () => {
  test("matches the 404/403 shapes downloadFile throws", () => {
    expect(isMissingAssetError("download HTTP 404")).toBe(true);
    expect(isMissingAssetError("download HTTP 403")).toBe(true);
  });

  test("ignores transport failures a different tag can't fix", () => {
    expect(isMissingAssetError("download HTTP 500")).toBe(false);
    expect(isMissingAssetError("download HTTP 503")).toBe(false);
    expect(isMissingAssetError("net::ERR_CONNECTION_RESET")).toBe(false);
    expect(isMissingAssetError("downloaded update failed checksum verification")).toBe(false);
  });

  test("does not match a 404 from an unrelated message", () => {
    expect(isMissingAssetError("HTTP 404")).toBe(false);
  });
});

describe("latestTagFromReleasesJson", () => {
  test("reads tag_name from GitHub's /releases/latest payload", () => {
    const raw = JSON.stringify({ id: 432432755, tag_name: "v0.3.318.1" });
    expect(latestTagFromReleasesJson(raw)).toBe("v0.3.318.1");
  });

  test("trims surrounding whitespace", () => {
    expect(latestTagFromReleasesJson('{"tag_name":"  v1.2.3.4  "}')).toBe("v1.2.3.4");
  });

  test("returns null rather than throwing on unusable payloads", () => {
    expect(latestTagFromReleasesJson("<!DOCTYPE html>")).toBeNull();
    expect(latestTagFromReleasesJson("{}")).toBeNull();
    expect(latestTagFromReleasesJson('{"tag_name":""}')).toBeNull();
    expect(latestTagFromReleasesJson('{"tag_name":123}')).toBeNull();
    expect(latestTagFromReleasesJson("null")).toBeNull();
  });
});
