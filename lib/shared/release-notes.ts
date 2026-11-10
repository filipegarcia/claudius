/**
 * The release history every build ships with, as per-release changelogs.
 *
 * `scripts/release-notes.mjs` runs at build / dev-server start and writes
 * `public/release-notes.json`: for each release tag, the commits that tag
 * introduced (raw subjects). This module turns that into one
 * `ReleaseChangelog` per release using the same classifier as the
 * pre-download update modal (lib/shared/release-changelog.ts), and decides
 * when the post-update "What's new" window should open.
 *
 * Because the history is bundled rather than fetched, it works offline and a
 * user who skipped several updates can read every release they missed.
 *
 * Pure and dependency-free (browser-safe) so unit tests can cover it.
 */
import {
  RELEASE_TAG_RE,
  buildReleaseChangelog,
  type ReleaseChangelog,
} from "@/lib/shared/release-changelog";

/** Served from `public/`; generated per build, gitignored. */
export const RELEASE_NOTES_URL = "/release-notes.json";
export const GITHUB_RELEASES_URL = "https://github.com/filipegarcia/claudius/releases";
const COMPARE_BASE = "https://github.com/filipegarcia/claudius/compare/";

/** One release as written by scripts/release-notes.mjs. */
export type BundledRelease = {
  tag: string;
  previous: string;
  date: string;
  /** Non-merge commits the release introduced, newest first. */
  commits: { sha: string; subject: string }[];
};

export type ReleaseNote = ReleaseChangelog & {
  /** `v`-prefixed release tag (same as `to`). */
  tag: string;
  /** ISO timestamp the release was tagged. */
  date: string;
  /** User-facing entries across all groups. 0 → maintenance-only release. */
  shown: number;
};

/** A bare `0.3.322.2` / tagged `v0.3.322.2` version, 3 or 4 components. */
const VERSION_RE = /^v?\d{1,6}(?:\.\d{1,6}){2,3}$/;

export function isVersion(v: unknown): v is string {
  return typeof v === "string" && VERSION_RE.test(v);
}

/**
 * Numeric, component-wise compare. Accepts either form (`v` optional); a
 * missing 4th component counts as 0, so `0.3.322` === `0.3.322.0`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".");
  const pb = b.replace(/^v/, "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number.parseInt(pa[i] ?? "0", 10) || 0) - (Number.parseInt(pb[i] ?? "0", 10) || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function isBundledRelease(r: unknown): r is BundledRelease {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.tag === "string" &&
    RELEASE_TAG_RE.test(o.tag) &&
    typeof o.previous === "string" &&
    RELEASE_TAG_RE.test(o.previous) &&
    typeof o.date === "string" &&
    Array.isArray(o.commits)
  );
}

export function toReleaseNote(r: BundledRelease): ReleaseNote {
  const changelog = buildReleaseChangelog({
    from: r.previous,
    to: r.tag,
    // The file lists newest first; the builder wants git's oldest → newest.
    commits: [...r.commits]
      .filter((c) => c && typeof c.sha === "string" && typeof c.subject === "string")
      .reverse()
      .map((c) => ({ sha: c.sha, message: c.subject })),
    compareUrl: `${COMPARE_BASE}${r.previous}...${r.tag}`,
  });
  return {
    ...changelog,
    tag: r.tag,
    date: r.date,
    shown: changelog.groups.reduce((n, g) => n + g.entries.length, 0),
  };
}

/**
 * Parse `release-notes.json` defensively (it's a static file a stale or
 * hand-edited build could have mangled). Returns newest release first.
 */
export function parseReleaseNotes(json: unknown): ReleaseNote[] {
  const releases = (json as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(releases)) return [];
  return releases
    .filter(isBundledRelease)
    .map(toReleaseNote)
    .sort((a, b) => compareVersions(b.tag, a.tag));
}

/**
 * Releases newer than `after` (exclusive) up to and including `upTo`, newest
 * first. `after = null` drops the lower bound.
 */
export function releasesInRange(
  notes: ReleaseNote[],
  after: string | null,
  upTo: string,
): ReleaseNote[] {
  return notes.filter(
    (n) =>
      compareVersions(n.tag, upTo) <= 0 && (after === null || compareVersions(n.tag, after) > 0),
  );
}

export type WhatsNewDecision =
  /** Nothing recorded yet (fresh install / new origin): remember, don't show. */
  | { kind: "first-run" }
  /** Already seen this version — or running an older build than one seen. */
  | { kind: "none" }
  /** Updated since the last launch: show what changed after `since`. */
  | { kind: "show"; since: string };

/**
 * Should launching `current` open the "What's new" window?
 *
 * Only an UPGRADE past the last version the user saw counts. A fresh install
 * has nothing to compare against, so it stays quiet (the window is still one
 * click away from the version label / Help menu). A downgrade, or switching
 * between an older and a newer build, never re-shows notes already seen.
 */
export function decideWhatsNew(lastSeen: string | null, current: string): WhatsNewDecision {
  if (!isVersion(current)) return { kind: "none" };
  if (!isVersion(lastSeen)) return { kind: "first-run" };
  return compareVersions(current, lastSeen) > 0 ? { kind: "show", since: lastSeen } : { kind: "none" };
}

/** The later of two versions — what to persist as "last seen". */
export function laterVersion(a: string | null, b: string): string {
  return isVersion(a) && compareVersions(a, b) > 0 ? a : b;
}
