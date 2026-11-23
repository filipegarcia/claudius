/**
 * CC 2.1.319 parity — "Fixed `/diff` showing 'Diff unavailable' when a git
 * repository has a file or folder named `HEAD` at its top level".
 *
 * Claudius's own `/diff` (getStatus / getDiff / gitShow) already passes `--`
 * or uses `rev:path` shapes and was verified clean against a top-level `HEAD`
 * file. The same bug class — a revision with no `--` after it — lived at two
 * other Claudius call sites, which git rejects with exit 128 "ambiguous
 * argument … both revision and filename":
 *
 * - `diffBranchAgainstWorktree` (BranchSwitcher "Show Diff with Working
 *   Tree") with a branch named like a top-level file or folder (`docs`);
 * - the updater's `conflictedFiles` (`git diff --check HEAD`) with a top-level
 *   `HEAD` file — which failed *silently* (empty stdout → no conflicts → the
 *   conflict-marker guard turned off).
 *
 * A real git repo is the only faithful reproduction.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffBranchAgainstWorktree } from "@/lib/server/git";
import { conflictedFiles } from "@/lib/server/updater/git";

function gitEnv(): NodeJS.ProcessEnv {
  // Strip GIT_* (pre-commit hooks export GIT_INDEX_FILE for the outer repo)
  // and pin config so a developer's global config can't break the fixture.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_")) delete env[k];
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function gitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

let repo: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // The modules under test spawn git with process.env; scrub GIT_* for them too.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GIT_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  repo = mkdtempSync(join(tmpdir(), "claudius-git-ambiguous-"));
  gitSync(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  gitSync(["add", "."], repo);
  gitSync(["commit", "-q", "-m", "init"], repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
    delete savedEnv[k];
  }
});

describe("CC 2.1.319 — a revision that is also a top-level path", () => {
  test("diffBranchAgainstWorktree works for a branch named like a top-level folder", async () => {
    gitSync(["branch", "docs"], repo);
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "readme.md"), "hi\n");
    gitSync(["add", "."], repo);
    gitSync(["commit", "-q", "-m", "docs folder"], repo);
    writeFileSync(join(repo, "a.txt"), "two\n");

    const r = await diffBranchAgainstWorktree(repo, "docs");
    if ("code" in r) throw new Error(`diffBranchAgainstWorktree failed: ${r.message}`);
    expect(r.output).toContain("+two");
    expect(r.output).toContain("docs/readme.md");
  });

  test("diffBranchAgainstWorktree works with a top-level file named HEAD", async () => {
    writeFileSync(join(repo, "HEAD"), "not a ref\n");
    gitSync(["add", "."], repo);
    gitSync(["commit", "-q", "-m", "HEAD file"], repo);
    writeFileSync(join(repo, "a.txt"), "two\n");

    const r = await diffBranchAgainstWorktree(repo, "HEAD");
    if ("code" in r) throw new Error(`diffBranchAgainstWorktree failed: ${r.message}`);
    expect(r.output).toContain("+two");
  });

  test("conflictedFiles still finds markers when a top-level HEAD file exists", async () => {
    writeFileSync(join(repo, "HEAD"), "not a ref\n");
    gitSync(["add", "."], repo);
    gitSync(["commit", "-q", "-m", "HEAD file"], repo);
    writeFileSync(join(repo, "a.txt"), "<<<<<<< ours\none\n=======\ntwo\n>>>>>>> theirs\n");

    expect(await conflictedFiles(repo)).toEqual(["a.txt"]);
  });
});
