/**
 * Non-destructive self-heal for a tree WEDGED by a prior failed update cycle.
 *
 * The updater log on a real install showed this loop:
 *
 *   apply (stash-ff) … apply failed in init:
 *     Command failed: git stash push -u -m claudius-updater-stash
 *
 * Root cause: a previous cycle left the working tree mid-conflict (unmerged
 * index entries / an in-progress merge). `git stash push` refuses to run over
 * that, so every subsequent update threw in the `init` phase and dead-ended —
 * with NOTHING in the user's visible change set. Per product intent the updater
 * must heal a dirty/wedged tree itself, using non-destructive actions first and
 * without prompting.
 *
 * A real git repo is the only faithful way to reproduce `git stash push`'s
 * refusal over unmerged paths — mocks can't.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearInProgressMergeState,
  hasUnmergedFiles,
  isDirty,
  stashPushIncludeUntracked,
} from "@/lib/server/updater/git";

function gitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "claudius-heal-"));
  gitSync(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "file.txt"), "base\n");
  gitSync(["add", "."], repo);
  gitSync(["commit", "-qm", "base"], repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/**
 * Leave the repo with a conflicted, in-progress merge — the exact wedge a
 * failed cc-merge / interrupted update produces. After this, `git ls-files -u`
 * is non-empty and `git stash push` refuses to run.
 */
function wedgeWithConflictedMerge(): void {
  gitSync(["checkout", "-q", "-b", "other"], repo);
  writeFileSync(join(repo, "file.txt"), "other side\n");
  gitSync(["commit", "-qam", "other change"], repo);
  gitSync(["checkout", "-q", "main"], repo);
  writeFileSync(join(repo, "file.txt"), "main side\n");
  gitSync(["commit", "-qam", "main change"], repo);
  // Conflicting merge — leaves MERGE_HEAD + unmerged index entries, exits 1.
  try {
    gitSync(["merge", "other"], repo);
  } catch {
    // expected conflict
  }
}

describe("clearInProgressMergeState", () => {
  test("aborts an in-progress conflicted merge and clears unmerged entries", async () => {
    wedgeWithConflictedMerge();
    expect(await hasUnmergedFiles(repo)).toBe(true);

    await clearInProgressMergeState(repo);

    expect(await hasUnmergedFiles(repo)).toBe(false);
    // merge --abort restored the pre-merge HEAD content — non-destructive.
    expect(await isDirty(repo)).toBe(false);
  });

  test("is a harmless no-op on a clean tree", async () => {
    expect(await isDirty(repo)).toBe(false);
    await expect(clearInProgressMergeState(repo)).resolves.toBeUndefined();
    expect(await isDirty(repo)).toBe(false);
  });
});

describe("stashPushIncludeUntracked self-heals a wedged tree", () => {
  test("does not throw in `init` when the tree is mid-conflict — heals instead", async () => {
    wedgeWithConflictedMerge();
    expect(await hasUnmergedFiles(repo)).toBe(true);

    // Pre-fix this threw `Command failed: git stash push -u` and dead-ended the
    // whole update. Now it heals (aborts the merge) and reports nothing to
    // stash, without throwing.
    const res = await stashPushIncludeUntracked(repo, "claudius-updater-stash");

    expect(res.stashed).toBe(false);
    expect(await hasUnmergedFiles(repo)).toBe(false);
  });

  test("a normally dirty tree still stashes cleanly (heal path is inert)", async () => {
    writeFileSync(join(repo, "file.txt"), "uncommitted local edit\n");
    writeFileSync(join(repo, "untracked.txt"), "new artifact\n");
    expect(await isDirty(repo)).toBe(true);

    const res = await stashPushIncludeUntracked(repo, "claudius-updater-stash");

    expect(res.stashed).toBe(true);
    expect(await isDirty(repo)).toBe(false);
    // The work is preserved in the stash, recoverable by the caller's pop.
    expect(gitSync(["stash", "list"], repo)).toContain("claudius-updater-stash");
  });
});
