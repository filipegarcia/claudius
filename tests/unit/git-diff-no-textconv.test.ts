/**
 * Claude Code 2.1.222 parity: "Improved the `/diff` view, the Remote Control
 * workspace diff, and file-edit diffs ... to use raw git blob content,
 * ignoring workspace-configured diff drivers and textconv."
 *
 * A repo Claudius opens is not one we wrote — a `.gitattributes` file can
 * declare a `diff=<name>` driver whose `diff.<name>.textconv` command git
 * runs *instead of* showing the real file content in a diff. A workspace
 * (accidentally, or adversarially) configuring one of these would otherwise
 * make Claudius's diff views lie about what actually changed. Every
 * raw-content diff call site in `lib/server/git.ts` must pass
 * `--no-textconv` so the diff always reflects the real blob, matching the
 * fix Claude Code shipped for the same class of surface.
 *
 * A real git repo + a real textconv driver is the only faithful way to
 * reproduce this — a mock can't demonstrate that git actually ignored the
 * driver.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff, getDiffForCommit, diffBranchAgainstWorktree } from "@/lib/server/git";

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

const REDACTED = "REDACTED BY TEXTCONV DRIVER";
const SECRET_LINE = "the actual secret line that changed";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "claudius-diff-textconv-"));
  gitSync(["init", "-q", "-b", "main"], repo);

  // A textconv driver that always reports the same fixed string, no matter
  // what the real file content is — the sharpest possible signal that a
  // diff view is (or isn't) using it.
  const driver = join(repo, "textconv-driver.sh");
  writeFileSync(driver, `#!/bin/sh\necho "${REDACTED}"\n`);
  chmodSync(driver, 0o755);
  gitSync(["config", "diff.redact.textconv", driver], repo);
  writeFileSync(join(repo, ".gitattributes"), "*.txt diff=redact\n");

  writeFileSync(join(repo, "file.txt"), "base content\n");
  gitSync(["add", "."], repo);
  gitSync(["commit", "-qm", "base"], repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("git diff raw-content guarantee (no textconv)", () => {
  test("getDiff (worktree mode) shows the real change, not the textconv driver's output", async () => {
    writeFileSync(join(repo, "file.txt"), `base content\n${SECRET_LINE}\n`);

    const result = await getDiff(repo, "file.txt", "worktree");
    if ("code" in result) throw new Error(`getDiff failed: ${result.message}`);

    expect(result.diff).toContain(SECRET_LINE);
    expect(result.diff).not.toContain(REDACTED);
  });

  test("getDiff (staged mode) shows the real change, not the textconv driver's output", async () => {
    writeFileSync(join(repo, "file.txt"), `base content\n${SECRET_LINE}\n`);
    gitSync(["add", "file.txt"], repo);

    const result = await getDiff(repo, "file.txt", "staged");
    if ("code" in result) throw new Error(`getDiff failed: ${result.message}`);

    expect(result.diff).toContain(SECRET_LINE);
    expect(result.diff).not.toContain(REDACTED);
  });

  test("getDiff (untracked mode / diffNoIndex) shows the real new-file content", async () => {
    writeFileSync(join(repo, "new.txt"), `${SECRET_LINE}\n`);

    const result = await getDiff(repo, "new.txt", "untracked");
    if ("code" in result) throw new Error(`getDiff failed: ${result.message}`);

    expect(result.diff).toContain(SECRET_LINE);
    expect(result.diff).not.toContain(REDACTED);
  });

  test("diffBranchAgainstWorktree shows the real change against the working tree", async () => {
    gitSync(["branch", "base-branch"], repo);
    writeFileSync(join(repo, "file.txt"), `base content\n${SECRET_LINE}\n`);

    const result = await diffBranchAgainstWorktree(repo, "base-branch");
    if (!("ok" in result) || !result.ok) {
      throw new Error(`diffBranchAgainstWorktree failed: ${JSON.stringify(result)}`);
    }

    expect(result.output).toContain(SECRET_LINE);
    expect(result.output).not.toContain(REDACTED);
  });

  test("getDiffForCommit (tracked + untracked) shows real content for the model-facing summary diff", async () => {
    writeFileSync(join(repo, "file.txt"), `base content\n${SECRET_LINE}\n`);
    writeFileSync(join(repo, "new.txt"), `${SECRET_LINE}-new\n`);

    const result = await getDiffForCommit(repo, ["file.txt", "new.txt"]);
    if ("code" in result) throw new Error(`getDiffForCommit failed: ${result.message}`);

    expect(result.diff).toContain(SECRET_LINE);
    expect(result.diff).not.toContain(REDACTED);
  });
});
