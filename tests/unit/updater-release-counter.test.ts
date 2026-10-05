import { describe, expect, test } from "vitest";
import {
  buildLabel,
  detectSameVersionRerelease,
  parseReleaseTag,
  releaseCounterFromServerFiles,
  releaseLabel,
} from "@/electron/ipc/release-counter";

/**
 * Same-version re-releases. electron-updater compares the semver in
 * `latest-mac.yml` only, and every `v0.3.289.N` build ships `version: 0.3.289`
 * — so a user on `.0` was told "up to date" while `.1` (a security fix) sat
 * on the Releases page. The updater now compares the release counter itself.
 */
describe("parseReleaseTag", () => {
  test("splits the fourth rebuild component off the semver", () => {
    expect(parseReleaseTag("v0.3.289.1")).toEqual({ version: "0.3.289", release: 1 });
    expect(parseReleaseTag("0.3.289.12")).toEqual({ version: "0.3.289", release: 12 });
    expect(parseReleaseTag("v0.3.290")).toEqual({ version: "0.3.290", release: null });
  });

  test("rejects anything that isn't a release tag", () => {
    for (const t of ["", "latest", "v0.3", "v0.3.289-beta.1", "v0.3.289.1.2", undefined, null]) {
      expect(parseReleaseTag(t)).toBeNull();
    }
  });
});

describe("releaseCounterFromServerFiles", () => {
  const files = (release: unknown) =>
    JSON.stringify({ version: 1, config: { env: { NEXT_PUBLIC_CLAUDIUS_RELEASE: release } } });

  test("reads the counter the footer shows", () => {
    expect(releaseCounterFromServerFiles(files("1"))).toBe(1);
    expect(releaseCounterFromServerFiles(files("0"))).toBe(0);
  });

  test("unknown when unset, empty, non-numeric or unparseable", () => {
    expect(releaseCounterFromServerFiles(files(""))).toBeNull();
    expect(releaseCounterFromServerFiles(files("abc"))).toBeNull();
    expect(releaseCounterFromServerFiles(files(undefined))).toBeNull();
    expect(releaseCounterFromServerFiles(JSON.stringify({ config: {} }))).toBeNull();
    expect(releaseCounterFromServerFiles("not json")).toBeNull();
  });
});

describe("labels", () => {
  test("buildLabel joins the counter when known", () => {
    expect(buildLabel("0.3.289", 1)).toBe("0.3.289.1");
    expect(buildLabel("0.3.289", null)).toBe("0.3.289");
  });

  test("releaseLabel shows the tag's build only when it agrees with the feed semver", () => {
    expect(releaseLabel({ version: "0.3.290", tag: "v0.3.290.0" })).toBe("0.3.290.0");
    expect(releaseLabel({ version: "0.3.290", tag: "v0.3.289.4" })).toBe("0.3.290");
    expect(releaseLabel({ version: "0.3.290" })).toBe("0.3.290");
  });
});

describe("detectSameVersionRerelease", () => {
  const base = {
    currentVersion: "0.3.289",
    currentRelease: 0,
    latestVersion: "0.3.289",
    latestTag: "v0.3.289.1",
  };

  test("offers a higher counter of the same version — the v0.3.289.0 → .1 case", () => {
    expect(detectSameVersionRerelease(base)).toEqual({
      tag: "v0.3.289.1",
      version: "0.3.289",
      release: 1,
      label: "0.3.289.1",
    });
  });

  test("nothing when already on that build or newer", () => {
    expect(detectSameVersionRerelease({ ...base, currentRelease: 1 })).toBeNull();
    expect(detectSameVersionRerelease({ ...base, currentRelease: 2 })).toBeNull();
  });

  test("never offers when the running counter is unknown", () => {
    expect(detectSameVersionRerelease({ ...base, currentRelease: null })).toBeNull();
  });

  test("only for the same semver — a different version is electron-updater's job", () => {
    expect(detectSameVersionRerelease({ ...base, latestVersion: "0.3.290", latestTag: "v0.3.290.0" })).toBeNull();
    expect(detectSameVersionRerelease({ ...base, latestTag: "v0.3.288.5" })).toBeNull();
  });

  test("nothing for tags without a counter or when the tag is missing", () => {
    expect(detectSameVersionRerelease({ ...base, latestTag: "v0.3.289" })).toBeNull();
    expect(detectSameVersionRerelease({ ...base, latestTag: undefined })).toBeNull();
  });

  test("doesn't re-offer a release this machine already installed (loop guard)", () => {
    expect(
      detectSameVersionRerelease({ ...base, installed: { tag: "v0.3.289.1", version: "0.3.289" } }),
    ).toBeNull();
    // A newer rebuild than the installed one is still offered.
    expect(
      detectSameVersionRerelease({
        ...base,
        latestTag: "v0.3.289.2",
        installed: { tag: "v0.3.289.1", version: "0.3.289" },
      })?.label,
    ).toBe("0.3.289.2");
  });
});
