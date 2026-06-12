#!/usr/bin/env node
/**
 * scripts/claudius-release.mjs
 *
 * Prints the Claudius "release" counter to stdout: the ordinal of the latest
 * RELEASE cut for the SDK version in the working tree's `package.json`.
 *
 * Scheme (per-release, NOT per-commit):
 *   The displayed version is `${version}.${release}` (see lib/shared/version.ts).
 *   `version` (3-part semver) mirrors the Claude Agent SDK. `release` is the
 *   4th component and counts RELEASES — one per push to `main`, because
 *   `.github/workflows/auto-tag.yml` fires once per push and creates exactly
 *   one `v<version>.<N>` tag. So:
 *     - the first release at an SDK version is `.0`, the next `.1`, `.2`, …
 *       — each push bumps the counter by exactly ONE, no matter how many
 *       commits that push landed.
 *     - bumping the SDK (`version` changes) resets the counter to `.0`
 *       automatically: there are no `v<new-sdk>.*` tags yet, so max → none → 0.
 *
 *   This replaces the older "commits on main since the version changed"
 *   counter, which jumped by N when a push (or squash/merge) carried N commits
 *   — e.g. an 8-commit push took the line from `.5` straight to `.13`.
 *
 * Source of truth: the release tags themselves. `release` = the highest `N`
 * among the `v<version>.N` tags that exist. One tag is minted per release, so
 * counting tags counts releases. We read LOCAL tags (`git tag`) for speed and
 * offline use; that reflects whatever tags have been fetched. The number baked
 * into a SHIPPED build does NOT depend on this — release.yml takes it from the
 * dispatched tag (`inputs.release` / the tag name). This script is the
 * local-dev / non-tag-build fallback, where "latest fetched release" is the
 * right thing to show in the footer.
 *
 *   - The number reflects the SDK version your working tree carries, not the
 *     branch you're on: a feature branch shows the same `.N` as main for that
 *     SDK version.
 *   - An SDK bump that hasn't been released yet (no `v<new-sdk>.*` tag) shows
 *     `.0`, matching the "first release at this SDK" intent.
 *
 * Consumed at build/dev-server start by next.config.ts, which bakes the value
 * into the bundle as NEXT_PUBLIC_CLAUDIUS_RELEASE.
 *
 * Robustness:
 *   - Parses the trailing `.N` of each `v<version>.N` tag as an integer and
 *     guards that the prefix equals the exact working-tree version (so a glob
 *     over-match or a malformed tag can't corrupt the count).
 *   - Only 4-part tags count: a legacy 3-part `v<version>` tag (no `.N`) is
 *     ignored by the `v<version>.*` glob.
 *   - Returns 0 on any failure (no git, no `.git` dir, no tags) so a missing
 *     history degrades to `v<sdk>.0` rather than failing the build.
 *
 * NOTE for CI/release pipelines: the accurate per-release number for a shipped
 * artifact comes from auto-tag.yml (it computes `max(existing .N)+1` and passes
 * it to release.yml). A workflow that builds the app off a tag should rely on
 * that input; this script is only the fallback for non-tag/local builds, where
 * fetched tags are present.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Run a git command, returning trimmed stdout (stderr suppressed). */
function git(args) {
  return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

/**
 * The latest release ordinal for the working-tree SDK version: the highest `N`
 * among existing `v<version>.N` tags, or 0 when none exist (or on any error).
 */
function computeRelease() {
  let current;
  try {
    current = JSON.parse(readFileSync("package.json", "utf8")).version;
  } catch {
    return 0;
  }
  if (!current) return 0;

  let out;
  try {
    // fnmatch glob — `*` also matches dots, so this catches every 4-part tag
    // at this version. The regex below re-validates each match.
    out = git(`tag --list "v${current}.*"`);
  } catch {
    // No git / no .git / no tags reachable.
    return 0;
  }
  if (!out) return 0;

  let max = -1;
  const prefix = `v${current}.`;
  for (const tag of out.split("\n")) {
    if (!tag.startsWith(prefix)) continue; // belt-and-suspenders vs glob over-match
    const n = tag.slice(prefix.length);
    if (!/^\d+$/.test(n)) continue; // skip nested / malformed (e.g. `v…​.1.2`)
    const value = Number(n);
    if (Number.isInteger(value) && value > max) max = value;
  }
  return max >= 0 ? max : 0;
}

// `--anchor` is retained as a no-op for backward compatibility: the old
// commit-count scheme used it to bootstrap a `.0` tag at the SDK-bump commit.
// The per-release scheme has no anchor commit (the first push after a bump is
// simply `.0`), so we print an empty string. No current caller passes it.
if (process.argv.includes("--anchor")) {
  process.stdout.write("");
} else {
  let release = 0;
  try {
    release = computeRelease();
  } catch {
    release = 0;
  }
  process.stdout.write(String(release));
}
