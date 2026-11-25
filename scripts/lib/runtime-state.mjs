#!/usr/bin/env node
/**
 * scripts/lib/runtime-state.mjs — keep the update pipeline's runtime state
 * out of git.
 *
 * `.claudius/` is gitignored, but the run-notes under
 * `.claudius/{sdk-updater,cc-parity}/run-notes/*.md` ARE tracked, so the
 * prompts tell the agent to `git add -f` them. On 0.3.311, 0.3.318 and
 * 0.3.327 the agent ran `git add -f .claudius` instead. That staged the whole
 * directory: the credentials file (`sdk-updater/env`), both `state.json`
 * files, the run lock and multi-GB logs. The orchestrator's `--no-verify`
 * rescue commit then committed it. Once HEAD tracked `state.json`, every hourly
 * firing rewrote it and `git checkout --detach origin/main` refused to run
 * (issue #383).
 *
 * The rule: under `.claudius/` only run-notes Markdown may be tracked; the
 * repo-root `.claudius.db*` files never may be. Everything else is "runtime
 * state".
 *
 * Used three ways:
 *   - `isRuntimeStatePath()`: imported by the orchestrators (untrack on
 *     preflight, refuse to resume or push a branch that carries it).
 *   - `node scripts/lib/runtime-state.mjs staged`: from .githooks/pre-commit,
 *     refuses a commit that stages runtime state.
 *   - `node scripts/lib/runtime-state.mjs push`: from .githooks/pre-push,
 *     reads the hook's ref lines on stdin and refuses commits that add it.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUN_NOTES_RE = /^\.claudius\/(?:sdk-updater|cc-parity)\/run-notes\/[^/]+\.md$/;

/**
 * True for a repo-relative path that must never be committed: anything under
 * `.claudius/` except run-notes Markdown, plus the per-project SQLite db.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isRuntimeStatePath(path) {
  if (/^\.claudius\.db(?:$|-)/.test(path)) return true;
  return path.startsWith(".claudius/") && !RUN_NOTES_RE.test(path);
}

/**
 * Split `git … -z` output into paths.
 *
 * @param {string} out
 * @returns {string[]}
 */
function splitZ(out) {
  return out.split("\0").filter(Boolean);
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {{ status: number | null; stdout: string; stderr: string }}
 */
function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Runtime-state paths tracked in `rev`'s tree, or in the index when `rev` is
 * omitted. An unknown rev (unborn HEAD, missing ref) yields [].
 *
 * @param {string} [cwd]
 * @param {string} [rev]
 * @returns {string[]}
 */
export function trackedRuntimeStatePaths(cwd, rev) {
  // ls-tree takes literal path prefixes, not globs, so it lists the whole
  // tree and the filter below does the matching.
  const args = rev
    ? ["ls-tree", "-r", "-z", "--name-only", rev]
    : ["ls-files", "-z", "--", ".claudius", ".claudius.db*"];
  const res = git(args, cwd);
  if (res.status !== 0) return [];
  return splitZ(res.stdout).filter(isRuntimeStatePath).sort();
}

/**
 * Runtime-state paths that commits in `base..tip` add or modify, plus any
 * still present in `tip`'s tree. A commit that only deletes them is the fix,
 * not the problem, so deletions don't count.
 *
 * @param {string} base
 * @param {string} tip
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function runtimeStateInRange(base, tip, cwd) {
  const found = new Set(trackedRuntimeStatePaths(cwd, tip));
  const log = git(
    ["log", "--format=", "--name-only", "-z", "--no-renames", "--diff-filter=d", `${base}..${tip}`, "--", ".claudius", ".claudius.db*"],
    cwd,
  );
  if (log.status === 0) {
    for (const p of splitZ(log.stdout.replace(/\n/g, "\0"))) {
      if (isRuntimeStatePath(p)) found.add(p);
    }
  }
  return [...found].sort();
}

/**
 * @param {string[]} paths
 * @returns {string}
 */
function listPaths(paths) {
  const shown = paths.slice(0, 20).map((p) => `    ${p}`);
  if (paths.length > 20) shown.push(`    … +${paths.length - 20} more`);
  return shown.join("\n");
}

/** pre-commit: refuse staged runtime state (additions/modifications; untracking is fine). */
function checkStaged() {
  const res = git(["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=d"]);
  if (res.status !== 0) return 0;
  const bad = splitZ(res.stdout).filter(isRuntimeStatePath);
  if (bad.length === 0) return 0;
  process.stderr.write(
    `✖ Refusing to commit pipeline runtime state (gitignored for a reason):\n${listPaths(bad)}\n\n` +
      "  These can hold credentials (.claudius/sdk-updater/env), the updaters' state and\n" +
      "  multi-GB logs. Only run-notes are tracked: add those by their exact path, e.g.\n" +
      "    git add -f .claudius/sdk-updater/run-notes/<version>.md\n" +
      "  Unstage everything under .claudius/ (it stays on disk), then re-add only your notes:\n" +
      "    git restore --staged -- .claudius\n" +
      "    git add -f .claudius/<sdk-updater|cc-parity>/run-notes/<version>.md\n",
  );
  return 1;
}

/** pre-push: refuse to push commits that add runtime state. Reads the hook's stdin. */
function checkPush(stdin) {
  const ZERO = /^0+$/;
  const bad = new Set();
  for (const line of stdin.split("\n")) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue;
    // Prefer the remote's current tip as the base; fall back to origin/main
    // for a new branch (or a remote tip this clone hasn't fetched).
    let base = "origin/main";
    if (remoteSha && !ZERO.test(remoteSha) && git(["cat-file", "-e", `${remoteSha}^{commit}`]).status === 0) {
      base = remoteSha;
    }
    if (git(["rev-parse", "--verify", "-q", `${base}^{commit}`]).status !== 0) {
      for (const p of trackedRuntimeStatePaths(undefined, localSha)) bad.add(p);
      continue;
    }
    for (const p of runtimeStateInRange(base, localSha)) bad.add(p);
  }
  if (bad.size === 0) return 0;
  process.stderr.write(
    `✖ Refusing to push: these commits add pipeline runtime state:\n${listPaths([...bad].sort())}\n\n` +
      "  It can include credentials (.claudius/sdk-updater/env). Rewrite the branch so no\n" +
      "  commit adds these paths (e.g. `git rebase -i origin/main` and drop or edit those\n" +
      "  commits) before pushing. A later commit that only deletes them is not enough:\n" +
      "  the file would still be in the pushed history.\n",
  );
  return 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const mode = process.argv[2];
  if (mode === "staged") {
    process.exit(checkStaged());
  } else if (mode === "push") {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => process.exit(checkPush(Buffer.concat(chunks).toString("utf8"))));
  } else {
    process.stderr.write("usage: runtime-state.mjs staged | push\n");
    process.exit(2);
  }
}
