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

    const res = await createForkWorktree(repo, forkId);
    expect(res.ok).toBe(true);
    const wt = res.ok ? res.worktree : null;
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

    const res = await createForkWorktree(repo, "abcd1234-dirty");
    expect(res.ok && res.worktree.dirty).toBe(true);
  });

  test("a non-git source yields no worktree", async () => {
    const plain = await fs.mkdtemp(join(tmpdir(), "claudius-fork-plain-"));
    repos.push(plain);
    const res = await createForkWorktree(plain, "abcd1234");
    // No reason: a non-git source sharing the checkout is the normal path.
    expect(res).toEqual({ ok: false });
    expect(await forkWorktreeCwd("abcd1234")).toBeNull();
  });

  // CC 2.1.299 parity — "Improved the error shown when a worktree cannot be
  // created because its base commit does not resolve" + "…at a
  // bare-repository layout's root".
  test("a repo with no commits reports why instead of failing silently", async () => {
    const repo = await fs.mkdtemp(join(tmpdir(), "claudius-fork-unborn-"));
    repos.push(repo);
    await execFileP("git", ["-C", repo, "init", "-q"]);

    const res = await createForkWorktree(repo, "abcd1234-unborn");
    expect(res).toEqual({ ok: false, reason: "the repository has no commits yet" });
    expect(await forkWorktreeCwd("abcd1234-unborn")).toBeNull();
  });

  test("a bare-repository layout's root reports it has no working tree", async () => {
    // The `.bare` + `.git: gitdir: ./.bare` layout people use for
    // worktree-only checkouts — its root is a bare repo, not a work tree.
    const layout = await fs.mkdtemp(join(tmpdir(), "claudius-fork-bare-"));
    repos.push(layout);
    await execFileP("git", ["-C", layout, "init", "-q", "--bare", ".bare"]);
    await fs.writeFile(join(layout, ".git"), "gitdir: ./.bare\n");

    const res = await createForkWorktree(layout, "abcd1234-bare");
    expect(res).toEqual({
      ok: false,
      reason: "this is a bare repository's root, which has no working tree",
    });
  });

  test("a git failure surfaces git's first stderr line", async () => {
    const repo = await makeRepo();
    repos.push(repo);
    // The fork branch already exists → `worktree add -b` refuses.
    await execFileP("git", ["-C", repo, "branch", "claudius/fork-abcd1234"]);

    const res = await createForkWorktree(repo, "abcd1234-taken");
    expect(res.ok).toBe(false);
    const reason = res.ok ? "" : (res.reason ?? "");
    expect(reason).toMatch(/already exists/);
    expect(reason).not.toMatch(/^fatal:/);
    expect(reason).not.toContain("\n");
  });
});
