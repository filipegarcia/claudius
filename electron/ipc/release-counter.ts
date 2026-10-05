/**
 * Same-version re-releases ("rebuilds") and the release counter.
 *
 * Release tags carry a fourth component — `v0.3.289.1` — minted per push to
 * main by auto-tag.yml. The app's semver (`package.json` → `app.getVersion()`
 * and the `version:` in `latest-mac.yml`) stays `0.3.289` across all of them,
 * and electron-updater decides "is there an update?" from that semver alone.
 * So a user on `v0.3.289.0` was told they were up to date while
 * `v0.3.289.1` (e.g. a security fix) sat on the Releases page.
 *
 * The counter IS known on both sides, though:
 *   - the latest release's tag comes back on electron-updater's GitHub
 *     `UpdateInfo.tag`;
 *   - the running build baked its own counter into the Next config as
 *     `NEXT_PUBLIC_CLAUDIUS_RELEASE` (what the footer shows), which Next
 *     serializes to `<standalone>/.next/required-server-files.json`.
 *
 * Everything here is pure so it's unit-testable without Electron.
 */

export type ParsedReleaseTag = {
  /** Semver part, e.g. "0.3.289". */
  version: string;
  /** Fourth component, or null for a plain `v0.3.289` tag. */
  release: number | null;
};

/** `v0.3.289.1` → `{ version: "0.3.289", release: 1 }`; null for anything else. */
export function parseReleaseTag(tag: string | null | undefined): ParsedReleaseTag | null {
  if (typeof tag !== "string") return null;
  const m = /^v?(\d+\.\d+\.\d+)(?:\.(\d+))?$/.exec(tag.trim());
  if (!m) return null;
  return { version: m[1], release: m[2] !== undefined ? Number(m[2]) : null };
}

/**
 * The running build's release counter from the text of
 * `required-server-files.json`, or null when absent / not a whole number
 * (dev builds, local builds that never set it).
 */
export function releaseCounterFromServerFiles(json: string): number | null {
  try {
    const parsed = JSON.parse(json) as { config?: { env?: Record<string, unknown> } };
    const raw = parsed.config?.env?.NEXT_PUBLIC_CLAUDIUS_RELEASE;
    if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
    return Number(raw.trim());
  } catch {
    return null;
  }
}

/** "0.3.289" + 1 → "0.3.289.1"; the counter is dropped when unknown. */
export function buildLabel(version: string, release: number | null | undefined): string {
  return release == null ? version : `${version}.${release}`;
}

/**
 * The label to show for a release electron-updater found: the tag's full
 * `x.y.z.n` when it agrees with the feed's semver, else the semver alone.
 */
export function releaseLabel(info: { version: string; tag?: string }): string {
  const parsed = parseReleaseTag(info.tag);
  return parsed && parsed.version === info.version ? buildLabel(parsed.version, parsed.release) : info.version;
}

export type Rerelease = {
  tag: string;
  /** Semver, equal to the running app's. */
  version: string;
  release: number;
  /** "0.3.289.1" — what the UI shows. */
  label: string;
};

/**
 * A newer build of the SAME semver to offer after electron-updater said
 * "not available", or null.
 *
 * Offered only when the latest tag's semver equals both the feed's and the
 * running app's, and its counter is strictly greater than the running
 * build's. An unknown running counter never offers anything (we'd have no
 * way to stop offering it). `installed` is the last re-release this machine
 * verifiably swapped to (see `detectPostQuitSwapFailure` in updater.ts): if
 * that's the latest tag, don't offer it again — guards against an update
 * loop should a build ever bake a counter that disagrees with its tag.
 */
export function detectSameVersionRerelease(deps: {
  currentVersion: string;
  currentRelease: number | null;
  latestVersion: string | undefined;
  latestTag: string | undefined;
  installed?: { tag: string; version: string } | null;
}): Rerelease | null {
  const { currentVersion, currentRelease, latestVersion, latestTag, installed } = deps;
  if (currentRelease == null || !latestTag || latestVersion !== currentVersion) return null;
  const parsed = parseReleaseTag(latestTag);
  if (!parsed || parsed.release == null || parsed.version !== currentVersion) return null;
  if (parsed.release <= currentRelease) return null;
  if (installed && installed.tag === latestTag && installed.version === currentVersion) return null;
  return {
    tag: latestTag,
    version: parsed.version,
    release: parsed.release,
    label: buildLabel(parsed.version, parsed.release),
  };
}
