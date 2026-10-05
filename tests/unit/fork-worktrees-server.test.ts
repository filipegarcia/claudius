import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { createForkWorktree, forkWorktreeCwd } from "@/lib/server/fork-worktrees";
import { listWorktrees } from "@/lib/server/worktrees";

const execFileP = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "claudius-fork-repo-"));
  await execFileP("git", ["-C", dir, "init", "-q"]);
  await execFileP("git", ["-C", dir, "config", "user.email", "t@t.co"]);
  await execFileP("git", ["-C", dir, "config", "user.name", "T"]);
  await fs.writeFile(join(dir, "README.md"), "hi\n");
  await execFileP("git", ["-C", dir, "add", "-A"]);
  await execFileP("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

/**
 * CC 2.1.221 (DEC3) — createForkWorktree makes a real git worktree off the
 * source repo and records it; a non-git source yields no worktree.
 */
describe("createForkWorktree (DEC3)", () => {
  let home: TmpHome;
  const repos: string[] = [];

  beforeEach(() => {
    home = makeTempHome();
  });
  afterEach(async () => {
    home.restore();
    for (const r of repos.splice(0)) await fs.rm(r, { recursive: true, force: true });
  });

  test("creates a worktree registered with git and remembers it", async () => {
    const repo = await makeRepo();
    repos.push(repo);
    const forkId = "feedface-0000-0000-0000-000000000000";

    const wt = await createForkWorktree(repo, forkId);
    expect(wt).not.toBeNull();
    expect(wt!.branch).toBe("claudius/fork-feedface");
    expect(wt!.dirty).toBe(false);

    // git knows about it… (compare realpaths — git canonicalizes symlinks)
    const listed = await listWorktrees(repo);
    const wtReal = await fs.realpath(wt!.path);
    const listedReal = await Promise.all(
      listed.map((w) => fs.realpath(w.path).catch(() => w.path)),
    );
    expect(listedReal).toContain(wtReal);

    // …and the association resolves back to the worktree cwd. `sourceCwd` is
    // git's canonical toplevel (symlinks resolved), so compare realpaths.
    const resolved = await forkWorktreeCwd(forkId);
    expect(resolved?.cwd).toBe(wt!.path);
    expect(await fs.realpath(resolved!.sourceCwd)).toBe(await fs.realpath(repo));
  });

  test("a dirty source tree sets the dirty flag", async () => {
    const repo = await makeRepo();
    repos.push(repo);
    await fs.writeFile(join(repo, "uncommitted.txt"), "wip\n");

    const wt = await createForkWorktree(repo, "abcd1234-dirty");
    expect(wt?.dirty).toBe(true);
  });

  test("a non-git source yields no worktree", async () => {
    const plain = await fs.mkdtemp(join(tmpdir(), "claudius-fork-plain-"));
    repos.push(plain);
    const wt = await createForkWorktree(plain, "abcd1234");
    expect(wt).toBeNull();
    expect(await forkWorktreeCwd("abcd1234")).toBeNull();
  });
});
