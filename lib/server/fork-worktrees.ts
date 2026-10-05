import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { getRepoRoot } from "./git";
import { forkWorktreeIds, type ForkWorktreeInfo } from "@/lib/shared/fork-worktree";

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
 * Create a git worktree for a forked session off the source repo's HEAD, and
 * record the association. Returns the worktree info, or `null` when the source
 * isn't a git repo or the worktree couldn't be created (e.g. the branch already
 * exists) — in which case the caller falls back to the shared checkout.
 */
export async function createForkWorktree(
  sourceCwd: string,
  forkId: string,
): Promise<ForkWorktreeInfo | null> {
  const repoRoot = await getRepoRoot(sourceCwd);
  if (!repoRoot) return null;

  const { branch, dirName } = forkWorktreeIds(forkId);

  // Path-injection barrier (CLAUDE.md): build the target with `resolve` and
  // assert it stays under the root, inline at the sink. `dirName` is already a
  // hex slug, but the check is kept visible right above the git/fs calls.
  const root = forkWorktreesRoot();
  const target = resolve(root, dirName);
  if (!target.startsWith(root + sep)) return null;

  let dirty = false;
  try {
    const { stdout } = await execFileP("git", ["-C", repoRoot, "status", "--porcelain"], {
      timeout: 5_000,
    });
    dirty = stdout.trim().length > 0;
  } catch {
    // Non-fatal — proceed without the dirty note.
  }

  await fs.mkdir(root, { recursive: true });
  try {
    await execFileP("git", ["-C", repoRoot, "worktree", "add", "-b", branch, target, "HEAD"], {
      timeout: 20_000,
    });
  } catch {
    // Branch already exists, path taken, detached HEAD, etc. — fork still
    // succeeds on the shared checkout.
    return null;
  }

  const idx = await readIndex();
  idx.forks[forkId] = { cwd: target, branch, sourceCwd: repoRoot };
  await writeIndex(idx);

  return { path: target, branch, dirty };
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
