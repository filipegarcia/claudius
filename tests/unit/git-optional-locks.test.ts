/**
 * CC 2.1.314 parity — "Fixed background diff refreshes briefly taking the
 * repository's index lock, which could make a git command run at the same
 * moment fail with `Unable to create '.git/index.lock': File exists`".
 *
 * The git panel polls `getStatus` and the chat diff overlay re-reads
 * `getDiff(…, "worktree")` after every edit Claude makes. Neither may
 * rewrite `.git/index`: a stat-dirty file (touched, content unchanged) is
 * exactly what makes porcelain `git status` / `git diff` refresh the index
 * under `index.lock`. A real repo is the only faithful check — the index
 * file's inode changes whenever git rewrites it (lock file + rename).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff, getStatus } from "@/lib/server/git";

function gitEnv(): NodeJS.ProcessEnv {
  // Same isolation as git-diff-no-textconv.test.ts: hooks export GIT_DIR /
  // GIT_INDEX_FILE for the outer repo, and a developer's global config must
  // not leak into the fixture.
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

function indexStamp(repo: string): string {
  const st = statSync(join(repo, ".git", "index"));
  return `${st.ino}:${st.mtimeMs}`;
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "claudius-git-optlocks-"));
  gitSync(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "touched.txt"), "same content\n");
  writeFileSync(join(repo, "edited.txt"), "line one\n");
  gitSync(["add", "."], repo);
  gitSync(["commit", "-qm", "base"], repo);
  // Make `touched.txt` stat-dirty: content unchanged, mtime moved well past
  // the index's own timestamp so git can't treat it as racily clean.
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(repo, "touched.txt"), future, future);
  writeFileSync(join(repo, "edited.txt"), "line one\nline two\n");
  utimesSync(join(repo, "edited.txt"), future, future);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("background git reads leave the index alone (CC 2.1.314)", () => {
  test("getStatus does not rewrite .git/index for a stat-dirty file", async () => {
    const before = indexStamp(repo);
    const status = await getStatus(repo);
    if ("code" in status) throw new Error(`getStatus failed: ${status.message}`);
    expect(status.files.map((f) => f.path).sort()).toEqual(["edited.txt"]);
    expect(indexStamp(repo)).toBe(before);
  });

  test("getDiff (worktree) shows the real change and does not rewrite .git/index", async () => {
    const before = indexStamp(repo);
    const result = await getDiff(repo, "edited.txt", "worktree");
    if ("code" in result) throw new Error(`getDiff failed: ${result.message}`);
    expect(result.diff).toContain("diff --git a/edited.txt b/edited.txt");
    expect(result.diff).toContain("+line two");
    expect(result.binary).toBe(false);
    expect(indexStamp(repo)).toBe(before);
  });

  test("getDiff (worktree) on a stat-only-dirty file is empty, like porcelain git diff", async () => {
    const before = indexStamp(repo);
    const result = await getDiff(repo, "touched.txt", "worktree");
    if ("code" in result) throw new Error(`getDiff failed: ${result.message}`);
    expect(result.diff).toBe("");
    expect(indexStamp(repo)).toBe(before);
  });

  test("control: porcelain `git diff` DOES rewrite the index here (the bug the fix avoids)", () => {
    const before = indexStamp(repo);
    execFileSync("git", ["diff", "--no-color"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...gitEnv(), GIT_OPTIONAL_LOCKS: "0" },
    });
    expect(indexStamp(repo)).not.toBe(before);
  });

  test("getDiff (worktree) still reports binary changes", async () => {
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2]));
    gitSync(["add", "blob.bin"], repo);
    gitSync(["commit", "-qm", "bin"], repo);
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 9, 9]));
    const result = await getDiff(repo, "blob.bin", "worktree");
    if ("code" in result) throw new Error(`getDiff failed: ${result.message}`);
    expect(result.binary).toBe(true);
  });
});
