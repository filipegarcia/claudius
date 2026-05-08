import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type Worktree = {
  /** Absolute path of the worktree. */
  path: string;
  /** Commit SHA at HEAD (or undefined for new worktrees). */
  head?: string;
  /** Short branch name (e.g. "feature/x") if checked out. */
  branch?: string;
  /** Whether this worktree is on a detached HEAD. */
  detached?: boolean;
  /** Whether this worktree is a bare repo (the main one only, usually). */
  bare?: boolean;
  /** Whether this worktree is locked. */
  locked?: boolean;
  /** Whether this worktree is prunable. */
  prunable?: boolean;
};

/**
 * Parses the output of `git worktree list --porcelain`. The format is groups
 * of key/value-or-flag lines separated by blank lines:
 *
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>
 *   bare
 *   detached
 *   locked
 *   prunable [reason]
 */
export function parsePorcelain(text: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      if (cur) {
        out.push(cur);
        cur = null;
      }
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? undefined : line.slice(space + 1);
    if (key === "worktree" && value) {
      cur = { path: value };
    } else if (!cur) {
      continue;
    } else if (key === "HEAD" && value) {
      cur.head = value;
    } else if (key === "branch" && value) {
      cur.branch = value.replace(/^refs\/heads\//, "");
    } else if (key === "bare") {
      cur.bare = true;
    } else if (key === "detached") {
      cur.detached = true;
    } else if (key === "locked") {
      cur.locked = true;
    } else if (key === "prunable") {
      cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  try {
    const { stdout } = await execFileP("git", ["worktree", "list", "--porcelain"], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parsePorcelain(stdout);
  } catch {
    return [];
  }
}
