import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { createForkWorktree } from "@/lib/server/fork-worktrees";
import { forkConfirmation } from "@/lib/shared/fork-worktree";

const execFileP = promisify(execFile);

/**
 * CC 2.1.321 parity — "Fixed the git status given to Claude at session start
 * reading as clean when git status failed; it now reads as unavailable".
 *
 * Claudius's own copy of that mistake was in `/fork`: `createForkWorktree`
 * started from `dirty = false` and swallowed a failed `git status`, so the
 * fork toast read as if the source tree were clean. A corrupt index is a real
 * way to get there: `rev-parse HEAD` and `worktree add … HEAD` still succeed,
 * only `status` exits 128.
 */
describe("fork worktree when git status fails", () => {
  let home: TmpHome;
  let repo: string;

  beforeEach(async () => {
    home = makeTempHome();
    repo = await fs.mkdtemp(join(tmpdir(), "claudius-fork-status-"));
    await execFileP("git", ["-C", repo, "init", "-q"]);
    await execFileP("git", ["-C", repo, "config", "user.email", "t@t.co"]);
    await execFileP("git", ["-C", repo, "config", "user.name", "T"]);
    await fs.writeFile(join(repo, "a.txt"), "a\n");
    await execFileP("git", ["-C", repo, "add", "-A"]);
    await execFileP("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    home.restore();
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("a corrupt index makes dirty unknown (null), not clean", async () => {
    await fs.writeFile(join(repo, "a.txt"), "edited but not committed\n");
    await fs.writeFile(join(repo, ".git", "index"), "not an index");
    await expect(execFileP("git", ["-C", repo, "status", "--porcelain"])).rejects.toBeTruthy();

    const res = await createForkWorktree(repo, "c0ffee00-0000-0000-0000-000000000000");
    expect(res.ok).toBe(true);
    expect(res.ok && res.worktree.dirty).toBeNull();
  });

  test("a working git status still reports clean as false", async () => {
    const res = await createForkWorktree(repo, "c0ffee11-0000-0000-0000-000000000000");
    expect(res.ok && res.worktree.dirty).toBe(false);
  });
});

describe("forkConfirmation with an unknown dirty state", () => {
  const base = { title: "Spike", sessionId: "8ded11a6-0000-0000-0000-000000000000" };

  test("says the check was unavailable instead of reading as clean", () => {
    const text = forkConfirmation({
      ...base,
      worktree: { path: "/wt", branch: "claudius/fork-8ded11a6", dirty: null },
    });
    expect(text).toBe(
      `Forked as "Spike" (8ded11a6) — in its own worktree claudius/fork-8ded11a6 — couldn't check for uncommitted changes, so any aren't included.`,
    );
  });

  test("clean and dirty copy is unchanged", () => {
    const clean = forkConfirmation({ ...base, worktree: { path: "/wt", branch: "b", dirty: false } });
    expect(clean).toBe(`Forked as "Spike" (8ded11a6) — in its own worktree b.`);
    const dirty = forkConfirmation({ ...base, worktree: { path: "/wt", branch: "b", dirty: true } });
    expect(dirty).toContain("uncommitted changes not included");
  });
});
