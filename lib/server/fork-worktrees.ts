import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { getRepoRoot } from "./git";
import {
  forkWorktreeIds,
  worktreeFailureReason,
  type ForkWorktreeInfo,
} from "@/lib/shared/fork-worktree";

const execFileP = promisify(execFile);

/**
 * CC 2.1.221 (DEC3) — `/fork` creates its own git worktree so the fork can be
 * worked on in isolation from the source checkout. This module creates the
 * worktree and remembers which fork lives where, so the session-create cwd
 * resolver (`app/api/sessions/route.ts`) can open a resumed fork in its
 * worktree rather than the source cwd it inherited in its transcript.
 *
 * Worktrees are NOT auto-removed: a fork's worktree may hold uncommitted work,
 * and silently `git worktree remove`-ing it on session delete could destroy
 * it. Cleanup is left to the user (`git worktree prune` / the Worktrees UI).
 */
// Resolved lazily (not baked at module load) so tests that redirect $HOME via
// `makeTempHome()` take effect — see the gotcha in tests/unit/helpers/tmp-home.ts.
function forkWorktreesRoot(): string {
  return join(homedir(), ".claude", ".claudius", "fork-worktrees");
}
function indexFile(): string {
  return join(forkWorktreesRoot(), "index.json");
}

type Association = { cwd: string; branch: string; sourceCwd: string };
type IndexShape = { version: 1; forks: Record<string, Association> };

async function readIndex(): Promise<IndexShape> {
  try {
    const raw = await fs.readFile(indexFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<IndexShape>;
    if (parsed && typeof parsed === "object" && parsed.forks) {
      return { version: 1, forks: parsed.forks };
    }
  } catch {
    // Missing or corrupt index — start fresh.
  }
  return { version: 1, forks: {} };
}

async function writeIndex(idx: IndexShape): Promise<void> {
  await fs.mkdir(forkWorktreesRoot(), { recursive: true });
  await fs.writeFile(indexFile(), JSON.stringify(idx, null, 2), "utf8");
}

/**
 * Outcome of `createForkWorktree`. `reason` is set when the source IS a git
 * repo (or a bare one) but the worktree couldn't be made — the caller shows
 * it instead of the plain non-git "shares your checkout" line. A non-git
 * source fails without a reason: sharing the checkout is the expected path.
 */
export type ForkWorktreeResult =
  | { ok: true; worktree: ForkWorktreeInfo }
  | { ok: false; reason?: string };

async function isBareRepository(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "rev-parse", "--is-bare-repository"], {
      timeout: 5_000,
    });
    return stdout.trim() === "true";
  } catch {
    return false; // not a repo at all
  }
}

/**
 * Create a git worktree for a forked session off the source repo's HEAD, and
 * record the association. Fails (`ok: false`) when the source isn't a git
 * repo or the worktree couldn't be created (e.g. the branch already exists)
 * — in which case the caller falls back to the shared checkout.
 */
export async function createForkWorktree(
  sourceCwd: string,
  forkId: string,
): Promise<ForkWorktreeResult> {
  const repoRoot = await getRepoRoot(sourceCwd);
  if (!repoRoot) {
    // CC 2.1.299 parity — "Improved the error for creating a worktree at a
    // bare-repository layout's root". `--show-toplevel` fails there just as
    // it does outside a repo, so tell the two apart rather than implying the
    // source isn't under git.
    if (await isBareRepository(sourceCwd)) {
      return { ok: false, reason: "this is a bare repository's root, which has no working tree" };
    }
    return { ok: false };
  }

  const { branch, dirName } = forkWorktreeIds(forkId);

  // Path-injection barrier (CLAUDE.md): build the target with `resolve` and
  // assert it stays under the root, inline at the sink. `dirName` is already a
  // hex slug, but the check is kept visible right above the git/fs calls.
  const root = forkWorktreesRoot();
  const target = resolve(root, dirName);
  if (!target.startsWith(root + sep)) return { ok: false };

  // CC 2.1.299 parity — "Improved the error shown when a worktree cannot be
  // created because its base commit does not resolve". In a fresh `git init`
  // HEAD names an unborn branch, and `worktree add … HEAD` only says
  // "invalid reference: HEAD".
  try {
    await execFileP("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      timeout: 5_000,
    });
  } catch {
    return { ok: false, reason: "the repository has no commits yet" };
  }

  // CC 2.1.321 parity — "Fixed the git status given to Claude at session
  // start reading as clean when git status failed; it now reads as
  // unavailable". Same mistake here: a failed or timed-out `git status`
  // (corrupt index, huge repo past the 5 s cap) used to leave `dirty = false`,
  // so the fork toast read as if every change were in the worktree. `null`
  // means "couldn't check"; the fork itself still goes ahead.
  let dirty: boolean | null = null;
  try {
    const { stdout } = await execFileP("git", ["-C", repoRoot, "status", "--porcelain"], {
      timeout: 5_000,
    });
    dirty = stdout.trim().length > 0;
  } catch (err) {
    // Output past execFile's 1 MiB buffer means tens of thousands of changed
    // or untracked paths — that's proof of a dirty tree, not a failed check.
    if ((err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") dirty = true;
    // Anything else (corrupt index, the 5 s timeout) is non-fatal — the toast
    // says the check was unavailable.
  }

  // CC 2.1.323 parity — refuse a checkout whose .git holds links or hard
  // links (git-new-workdir, `cp -al` copies): git could write outside the
  // repository through them. The fork stays on the shared checkout.
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { timeout: 5_000 },
    );
    const [gitDir, commonDir] = stdout.split("\n").map((l) => l.trim());
    const escape = gitDir && commonDir ? await worktreeWriteEscape(gitDir, commonDir, branch) : null;
    if (escape) {
      return {
        ok: false,
        reason: `git could write outside this repository through ${escape}, which is a link or a hard-linked entry (as in git-new-workdir checkouts or cp -al copies) — use a plain clone`,
      };
    }
  } catch {
    // Couldn't resolve the git dirs: `worktree add` below reports its own error.
  }

  await fs.mkdir(root, { recursive: true });
  try {
    await execFileP("git", ["-C", repoRoot, "worktree", "add", "-b", branch, target, "HEAD"], {
      timeout: 20_000,
    });
  } catch (err) {
    // Branch already exists, path taken, etc. — the fork still succeeds on
    // the shared checkout, now saying why.
    const stderr = (err as { stderr?: unknown }).stderr;
    return { ok: false, reason: worktreeFailureReason(typeof stderr === "string" ? stderr : "") };
  }

  const idx = await readIndex();
  idx.forks[forkId] = { cwd: target, branch, sourceCwd: repoRoot };
  await writeIndex(idx);

  return { ok: true, worktree: { path: target, branch, dirty } };
}

/**
 * CC 2.1.323 parity — "Changed worktree creation to refuse checkouts whose
 * .git folders are links or hold hard links, such as git-new-workdir layouts
 * and cp -al copies; use a plain clone". Claudius runs `git worktree add`
 * itself for `/fork`, so the engine's refusal never runs on that path.
 *
 * Mirrors the engine's check (`abt` in the 2.1.323 bundle), scoped to what
 * `worktree add -b <branch>` writes:
 * - the git dir and common dir must not be links;
 * - each folder on the way to the branch's ref and reflog, plus `worktrees/`,
 *   must be a plain folder (not a link);
 * - `packed-refs` and an existing `refs/heads/<branch>` must be plain files
 *   with a single name (no hard link). The ref must also not be a symbolic
 *   `ref:` or hold a path.
 * A missing entry is fine, because git creates it. Returns the offending
 * path, or `null` when nothing would let git write outside the repository.
 * `objects/` is not checked, because `git clone /local/path` hard-links
 * objects on purpose.
 */
export async function worktreeWriteEscape(gitDir: string, commonDir: string, branch: string): Promise<string | null> {
  for (const dir of [commonDir, gitDir]) {
    const st = await fs.lstat(dir).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return dir;
  }
  const parts = branch.split("/");
  const chains: Array<[string, string[]]> = [
    [commonDir, ["logs", "refs", "heads", ...parts]],
    [gitDir, ["logs", "HEAD"]],
    [commonDir, ["refs", "heads", ...parts.slice(0, -1)]],
    [commonDir, ["worktrees"]],
  ];
  for (const [base, chain] of chains) {
    for (let i = 1; i <= chain.length; i++) {
      const p = join(base, ...chain.slice(0, i));
      const st = await fs.lstat(p).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : null));
      if (st === undefined) break; // missing: git creates it
      if (st === null || st.isSymbolicLink()) return p;
      const last = i === chain.length;
      if (last && st.isFile()) {
        if (st.nlink > 1) return p;
      } else if (!st.isDirectory()) {
        return p;
      }
    }
  }
  for (const p of [join(commonDir, "packed-refs"), join(commonDir, "refs", "heads", ...parts)]) {
    const st = await fs.lstat(p).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : null));
    if (st === undefined) continue;
    if (st === null || st.isSymbolicLink() || !st.isFile() || st.nlink > 1) return p;
    if (p.endsWith(join("refs", "heads", ...parts))) {
      const text = await fs.readFile(p, "utf8").catch(() => null);
      if (text === null || text.startsWith("ref:") || /[\\/]/.test(text)) return p;
    }
  }
  return null;
}

/**
 * The worktree cwd registered for a forked session, if it still exists on
 * disk. Server-derived (never from the request), so callers may trust it
 * directly — matching how the session's JSONL cwd is trusted.
 */
export async function forkWorktreeCwd(
  sessionId: string,
): Promise<{ cwd: string; sourceCwd: string } | null> {
  const idx = await readIndex();
  const assoc = idx.forks[sessionId];
  if (!assoc) return null;
  try {
    const st = await fs.stat(assoc.cwd);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  return { cwd: assoc.cwd, sourceCwd: assoc.sourceCwd };
}
