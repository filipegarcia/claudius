import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { createForkWorktree, forkLinkRefusalReason, worktreeWriteEscape } from "@/lib/server/fork-worktrees";

const execFileP = promisify(execFile);

/**
 * CC 2.1.323 parity — "Changed worktree creation to refuse checkouts whose
 * .git folders are links or hold hard links, such as git-new-workdir layouts
 * and cp -al copies; use a plain clone". Claudius's /fork runs
 * `git worktree add` itself, so it mirrors the engine's check.
 */
const FORK_ID = "d00df00d-0000-0000-0000-000000000000";

async function makeRepo(dir: string, initArgs: string[] = []) {
  await execFileP("git", ["-C", dir, "init", "-q", ...initArgs]);
  await execFileP("git", ["-C", dir, "config", "user.email", "t@t.co"]);
  await execFileP("git", ["-C", dir, "config", "user.name", "T"]);
  await fs.writeFile(join(dir, "a.txt"), "a\n");
  await execFileP("git", ["-C", dir, "add", "-A"]);
  await execFileP("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  // Make sure logs/HEAD and logs/refs/heads exist, as in any working repo.
  await execFileP("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "two"]);
}

describe("fork worktree refuses .git link layouts", () => {
  let home: TmpHome;
  let scratch: string;

  beforeEach(async () => {
    home = makeTempHome();
    scratch = await fs.mkdtemp(join(tmpdir(), "claudius-fork-links-"));
  });
  afterEach(async () => {
    home.restore();
    await fs.rm(scratch, { recursive: true, force: true });
  });

  test("a plain repository forks into a worktree", async () => {
    const repo = join(scratch, "plain");
    await fs.mkdir(repo);
    await makeRepo(repo);
    const res = await createForkWorktree(repo, FORK_ID);
    expect(res.ok).toBe(true);
  });

  test("a git-new-workdir style .git (linked refs) is refused with the path", async () => {
    const origin = join(scratch, "origin");
    await fs.mkdir(origin);
    await makeRepo(origin);
    // git-new-workdir: a real .git folder whose refs/logs/config are links.
    const work = join(scratch, "workdir");
    await fs.mkdir(join(work, ".git"), { recursive: true });
    for (const name of ["config", "refs", "logs", "objects", "packed-refs", "hooks", "info"]) {
      const src = join(origin, ".git", name);
      if (await fs.lstat(src).catch(() => null)) await fs.symlink(src, join(work, ".git", name));
    }
    await fs.copyFile(join(origin, ".git", "HEAD"), join(work, ".git", "HEAD"));
    await execFileP("git", ["-C", work, "checkout", "-q", "-f"]);

    const res = await createForkWorktree(work, FORK_ID);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe(
      ".git/logs is a link or hard link, as in git-new-workdir or cp -al copies — use a plain clone",
    );
    // It reads inside the toast's parenthesis: no semicolon, under the 120 cap.
    expect(!res.ok && res.reason).not.toContain(";");
    expect(forkLinkRefusalReason(".git/logs/refs/heads/claudius").length).toBeLessThanOrEqual(120);
  });

  test("a cp -al copy (hard-linked .git files) is refused", async () => {
    const origin = join(scratch, "origin2");
    await fs.mkdir(origin);
    await makeRepo(origin);
    const copy = join(scratch, "copy");
    await execFileP("cp", ["-R", origin, copy]);
    // Hard-link the reflog the way `cp -al` would.
    const headLog = join(copy, ".git", "logs", "HEAD");
    await fs.rm(headLog);
    await fs.link(join(origin, ".git", "logs", "HEAD"), headLog);

    const escape = await worktreeWriteEscape(join(copy, ".git"), join(copy, ".git"), "claudius/fork-x");
    expect(escape).toBe(headLog);
    const res = await createForkWorktree(copy, FORK_ID);
    expect(res.ok).toBe(false);
  });

  test("hard-linked objects (a local `git clone`) are fine", async () => {
    const origin = join(scratch, "origin3");
    await fs.mkdir(origin);
    await makeRepo(origin);
    const clone = join(scratch, "clone");
    await execFileP("git", ["clone", "-q", origin, clone]);
    expect(await worktreeWriteEscape(join(clone, ".git"), join(clone, ".git"), "claudius/fork-y")).toBeNull();
  });

  test("a .git that is itself a link is refused, though rev-parse prints the real path", async () => {
    const store = join(scratch, "gitstore-origin");
    await fs.mkdir(store);
    await makeRepo(store);
    const work = join(scratch, "linked");
    await fs.mkdir(work);
    await fs.rename(join(store, ".git"), join(scratch, "gitstore"));
    await fs.symlink(join(scratch, "gitstore"), join(work, ".git"));
    await execFileP("git", ["-C", work, "checkout", "-q", "-f"]);

    const res = await createForkWorktree(work, FORK_ID);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe(forkLinkRefusalReason(".git"));
  });

  test("a reftable repository (refs/heads is a stub file) forks into a worktree", async () => {
    const repo = join(scratch, "reftable");
    await fs.mkdir(repo);
    try {
      await makeRepo(repo, ["--ref-format=reftable"]);
    } catch {
      return; // git older than 2.45 has no reftable; nothing to check
    }
    expect((await fs.lstat(join(repo, ".git", "refs", "heads"))).isFile()).toBe(true);
    expect(await worktreeWriteEscape(join(repo, ".git"), join(repo, ".git"), "claudius/fork-z")).toBeNull();
    const res = await createForkWorktree(repo, FORK_ID);
    expect(res.ok).toBe(true);
  });

  test("a hard-linked reftable table list is refused", async () => {
    const origin = join(scratch, "reftable-origin");
    await fs.mkdir(origin);
    try {
      await makeRepo(origin, ["--ref-format=reftable"]);
    } catch {
      return;
    }
    const copy = join(scratch, "reftable-copy");
    await execFileP("cp", ["-R", origin, copy]);
    const list = join(copy, ".git", "reftable", "tables.list");
    await fs.rm(list);
    await fs.link(join(origin, ".git", "reftable", "tables.list"), list);
    expect(await worktreeWriteEscape(join(copy, ".git"), join(copy, ".git"), "claudius/fork-r")).toBe(list);
  });
});
