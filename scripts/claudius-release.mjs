#!/usr/bin/env node
/**
 * scripts/claudius-release.mjs
 *
 * Prints the Claudius "release" counter to stdout: the number of commits on
 * MAIN since `package.json`'s `version` field last changed.
 *
 * Flags:
 *   --anchor  print the ANCHOR commit SHA (the oldest commit on main whose
 *             package.json `version` still equals the working-tree value)
 *             instead of the counter. Empty output when no anchor exists
 *             (e.g. the version was bumped but never merged to main). Used
 *             by `.github/workflows/auto-tag.yml` to bootstrap the
 *             `v<version>.0` tag at the same commit that introduced the
 *             current SDK version — without that bootstrap, the very first
 *             auto-tag firing after this workflow lands on main computes
 *             N≥1 and would silently skip the `.0` release.
 *
 * Counting is anchored on `main` (or `origin/main`) rather than `HEAD` on
 * purpose — the displayed version represents what's released, so a feature
 * branch with 30 local commits should not show `v0.3.152.30` while main is
 * still at `v0.3.152.1`. The branch you're on doesn't change the number; it
 * always reflects main's count for the SDK version your working tree carries.
 *
 * The UI renders `${version}.${release}` (see lib/shared/version.ts), so:
 *   - every commit on main after a `version` bump shows .0, .1, .2, …
 *   - bumping the SDK (which changes `version`) resets the counter to .0
 *     automatically — there's no stored counter to reset.
 *   - on a feature/PR branch that hasn't merged yet, the counter still
 *     reflects main's tip, not the branch's distance from anchor.
 *
 * If `version` in the working tree is ahead of what's on main (e.g. an
 * uncommitted/unmerged SDK bump), main has no anchor for that value and the
 * counter falls back to 0 → display `v<new-sdk>.0`, which matches the
 * "first commit at this SDK" intent.
 *
 * Consumed at build/dev-server start by next.config.ts, which bakes the
 * value into the bundle as NEXT_PUBLIC_CLAUDIUS_RELEASE.
 *
 * Robustness:
 *   - Anchors on the *parsed* `version` value at each package.json-touching
 *     commit (not a raw string match), so it's immune to JSON formatting
 *     drift and to the SDK dependency line also containing the number
 *     (e.g. "@anthropic-ai/claude-agent-sdk": "^0.3.152").
 *   - Resolves the main ref as `main` → `origin/main` → falls back to
 *     `HEAD`. The HEAD fallback only fires in degenerate setups (no remote,
 *     no local main); in normal repos main is always findable.
 *   - Returns 0 on any failure (no git, no .git dir, etc.) so a missing
 *     history degrades to v<sdk>.0 rather than failing the build.
 *
 * NOTE for CI/release pipelines: an accurate count needs full git history
 * AND the main ref. `actions/checkout` defaults to a shallow clone
 * (fetch-depth: 1) and on a PR build only fetches the PR head — both starve
 * this script. Any workflow that runs `next build` / `electron:build` for a
 * distributed artifact should set `fetch-depth: 0` on its checkout step so
 * both history and refs/remotes/origin/main are present. The current
 * workflows (ci/pages/codeql) don't build the shipped app, so they're fine
 * as-is — real builds happen locally where history is present.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Run a git command, returning trimmed stdout (stderr suppressed). */
function git(args) {
  return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

/** Parse the `version` field of package.json as it stood at `ref`. */
function versionAt(ref) {
  try {
    const raw = execSync(`git show ${ref}:package.json`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return JSON.parse(raw).version ?? null;
  } catch {
    // package.json absent at that commit, or commit unreachable.
    return null;
  }
}

/**
 * Pick the ref that represents "released history". Local `main` wins so
 * branches that haven't pulled recently still see a stable number; falls
 * back to `origin/main` for CI / fresh clones; returns null when neither
 * exists (degenerate, but possible in test fixtures).
 */
function resolveMainRef() {
  for (const ref of ["main", "origin/main"]) {
    try {
      execSync(`git rev-parse --verify ${ref}`, {
        stdio: ["ignore", "pipe", "ignore"],
      });
      return ref;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Find the anchor commit (oldest commit in main's contiguous run whose
 * `version` equals the working-tree value) and the count of commits on
 * main since that anchor.
 *
 * Returns { anchor: string|null, release: number }. Anchor is null when no
 * commit on main carries the current version yet (e.g. an SDK bump still on
 * a PR branch), in which case release is 0.
 */
function compute() {
  // Working-tree version is the SDK-tracking part; the counter is "commits
  // on main since this value was introduced".
  const current = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (!current) return { anchor: null, release: 0 };

  // Endpoint for the walk + count. Falls back to HEAD only in setups with
  // no main ref at all — keeps the script from going silent in test repos.
  const mainRef = resolveMainRef() ?? "HEAD";

  // Commits ON MAIN that touched package.json, newest first. Restricting to
  // main here is what makes feature-branch commits invisible to the counter.
  const log = git(`log --format=%H ${mainRef} -- package.json`);
  if (!log) return { anchor: null, release: 0 };
  const commits = log.split("\n").filter(Boolean);

  // Walk newest→oldest along main. The anchor is the OLDEST commit in the
  // contiguous run (from main's tip) whose committed version still equals
  // `current`. The commit just before that run is where `version` changed on
  // main, so the anchor is where the current value was first introduced
  // there.
  let anchor = null;
  for (const sha of commits) {
    if (versionAt(sha) === current) {
      anchor = sha;
    } else {
      break;
    }
  }

  // No commit on main carries the current version yet — e.g. an SDK bump
  // that's still on a PR branch, or an uncommitted working-tree change.
  // We're at .0 until the bump lands on main.
  if (!anchor) return { anchor: null, release: 0 };

  // Count every commit on main after the anchor, regardless of what files
  // it touched. The current branch isn't in the picture.
  const n = Number(git(`rev-list --count ${anchor}..${mainRef}`));
  return { anchor, release: Number.isFinite(n) ? n : 0 };
}

const wantAnchor = process.argv.includes("--anchor");

let result = { anchor: null, release: 0 };
try {
  result = compute();
} catch {
  // Already defaulted above.
}
process.stdout.write(wantAnchor ? (result.anchor ?? "") : String(result.release));
