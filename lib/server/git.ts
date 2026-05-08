import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/**
 * Single character status codes from `git status --porcelain=v1`.
 * Two slots: index (staged) and worktree (unstaged).
 *   ' ' = unmodified, M = modified, A = added, D = deleted,
 *   R = renamed,  C = copied, U = unmerged, ? = untracked, ! = ignored
 */
export type GitStatusCode = " " | "M" | "A" | "D" | "R" | "C" | "U" | "?" | "!" | "T";

export type GitFileChange = {
  /** Path relative to repo root, forward-slash. */
  path: string;
  /** Original path for renames/copies. */
  oldPath?: string;
  /** Index (staged) status. */
  index: GitStatusCode;
  /** Worktree (unstaged) status. */
  worktree: GitStatusCode;
  /** Convenience flag: untracked file. */
  untracked: boolean;
};

export type GitStatus = {
  /** True when the workspace root is inside a git work tree. */
  isRepo: boolean;
  /** Absolute path of the repo's top-level directory. */
  repoRoot?: string;
  /** Current branch name, or undefined if detached. */
  branch?: string;
  /** Short SHA at HEAD when detached. */
  head?: string;
  /** Commits ahead of upstream. */
  ahead?: number;
  /** Commits behind upstream. */
  behind?: number;
  /** All changed entries (staged + unstaged + untracked). */
  files: GitFileChange[];
};

export type GitError = {
  code: "not-a-repo" | "git-missing" | "git-failed";
  message: string;
};

async function git(
  args: string[],
  cwd: string,
  opts: { input?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = execFile("git", args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    timeout: TIMEOUT_MS,
    encoding: "utf8",
  });
  if (opts.input != null && child.stdin) {
    child.stdin.write(opts.input);
    child.stdin.end();
  }
  // We can't use `execFileP` here because we need to write to stdin for
  // `commit -F -`. Wrap the child manually and reject on non-zero exit so
  // callers can branch on `GitFailure.exitCode` (e.g. diff --no-index emits
  // exit 1 when files differ — see diffNoIndex below).
  const result = await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", rej);
    child.on("close", (code) => {
      if (code === 0) res({ stdout, stderr });
      else rej(new GitFailure(`git ${args[0]} exited ${code}: ${stderr.trim() || stdout.trim()}`, code ?? -1, stderr));
    });
  });
  return result;
}

class GitFailure extends Error {
  exitCode: number;
  stderr: string;
  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

async function isGitInstalled(): Promise<boolean> {
  try {
    await execFileP("git", ["--version"], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

/** Resolve repo top-level. Returns undefined if cwd isn't inside a work tree. */
export async function getRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: TIMEOUT_MS,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse `git status --porcelain=v1 -z`. Records are NUL-terminated; renames
 * (`R` or `C`) emit a second NUL-terminated record for the original path.
 */
export function parsePorcelainV1Z(buf: string): GitFileChange[] {
  const out: GitFileChange[] = [];
  if (!buf) return out;
  // Split on NUL but keep empties at hand — porcelain produces a trailing
  // NUL after the last record.
  const parts = buf.split("\0");
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i];
    if (!rec) {
      i++;
      continue;
    }
    // Format: "XY <path>" with a single space separator.
    if (rec.length < 4) {
      i++;
      continue;
    }
    const index = rec[0] as GitStatusCode;
    const worktree = rec[1] as GitStatusCode;
    const path = rec.slice(3);
    let oldPath: string | undefined;
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
      // Next record is the rename/copy source.
      i++;
      oldPath = parts[i] ?? undefined;
    }
    out.push({
      path,
      oldPath,
      index,
      worktree,
      untracked: index === "?" && worktree === "?",
    });
    i++;
  }
  return out;
}

/** Parse `## branch...origin/branch [ahead 1, behind 2]` from porcelain header. */
function parseBranchHeader(line: string): {
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
} {
  // Examples:
  //   "## main...origin/main"
  //   "## main...origin/main [ahead 1]"
  //   "## main...origin/main [ahead 1, behind 2]"
  //   "## main"
  //   "## HEAD (no branch)"
  //   "## No commits yet on main"
  if (!line.startsWith("## ")) return {};
  const body = line.slice(3);
  if (body.startsWith("HEAD (no branch)")) {
    return {};
  }
  const noCommits = /^No commits yet on (.+)$/.exec(body);
  if (noCommits) return { branch: noCommits[1] };
  const m = /^([^.\s[]+)(?:\.{3}\S+)?(?:\s+\[([^\]]+)\])?\s*$/.exec(body);
  if (!m) return {};
  const branch = m[1];
  const tracking = m[2];
  let ahead: number | undefined;
  let behind: number | undefined;
  if (tracking) {
    const a = /ahead (\d+)/.exec(tracking);
    const b = /behind (\d+)/.exec(tracking);
    if (a) ahead = Number(a[1]);
    if (b) behind = Number(b[1]);
  }
  return { branch, ahead, behind };
}

export async function getStatus(cwd: string): Promise<GitStatus | GitError> {
  if (!(await isGitInstalled())) {
    return { code: "git-missing", message: "git is not installed or not on PATH" };
  }
  const root = await getRepoRoot(cwd);
  if (!root) {
    return { code: "not-a-repo", message: "workspace is not inside a git repository" };
  }
  // -b for branch info, -uall to surface every untracked file (default
  // collapses untracked dirs into a single entry).
  let branchHeader = "";
  let porcelain = "";
  try {
    const { stdout } = await git(["status", "--porcelain=v1", "-b", "-uall", "-z"], root);
    porcelain = stdout;
  } catch (err) {
    return {
      code: "git-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  // With -z, every record (including the branch header) is NUL-terminated,
  // not newline-terminated. Peel off the leading "## ..." record and pass the
  // rest to the porcelain parser.
  const firstNul = porcelain.indexOf("\0");
  if (firstNul === -1) {
    branchHeader = porcelain;
    porcelain = "";
  } else {
    branchHeader = porcelain.slice(0, firstNul);
    porcelain = porcelain.slice(firstNul + 1);
  }
  const { branch, ahead, behind } = parseBranchHeader(branchHeader);
  let head: string | undefined;
  if (!branch) {
    try {
      const { stdout } = await git(["rev-parse", "--short", "HEAD"], root);
      head = stdout.trim();
    } catch {
      // empty repo — leave undefined
    }
  }
  const files = parsePorcelainV1Z(porcelain);
  return { isRepo: true, repoRoot: root, branch, head, ahead, behind, files };
}

export type DiffMode = "worktree" | "staged" | "untracked";

/**
 * Returns a unified diff for `path`. Mode picks which view:
 *   - worktree: index → working tree (unstaged changes)
 *   - staged:   HEAD  → index       (staged changes)
 *   - untracked: synthesises diff against /dev/null for new files
 */
export async function getDiff(
  cwd: string,
  path: string,
  mode: DiffMode,
): Promise<{ diff: string; binary: boolean } | GitError> {
  const root = await getRepoRoot(cwd);
  if (!root) return { code: "not-a-repo", message: "not a git repository" };
  try {
    if (mode === "untracked") {
      // `git diff --no-index` exits 1 when files differ (the whole point).
      // diffNoIndex() treats 0 and 1 as success and only rejects on >1.
      return await diffNoIndex(root, path);
    }
    const args =
      mode === "staged"
        ? ["diff", "--cached", "--no-color", "--", path]
        : ["diff", "--no-color", "--", path];
    const { stdout } = await git(args, root);
    const binary = /^Binary files /m.test(stdout);
    return { diff: stdout, binary };
  } catch (err) {
    return {
      code: "git-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function diffNoIndex(root: string, path: string): Promise<{ diff: string; binary: boolean }> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = execFile(
      "git",
      ["diff", "--no-index", "--no-color", "--", "/dev/null", path],
      { cwd: root, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, encoding: "utf8" },
    );
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      // 0 = identical (won't happen), 1 = differ (expected), >1 = real error.
      if (code === 0 || code === 1) {
        resolve({ diff: stdout, binary: /^Binary files /m.test(stdout) });
      } else {
        reject(new Error(stderr.trim() || `git diff --no-index exited ${code}`));
      }
    });
  });
}

export type StageOp = "stage" | "unstage" | "discard";

export async function stagePaths(
  cwd: string,
  paths: string[],
  op: StageOp,
): Promise<{ ok: true } | GitError> {
  if (paths.length === 0) return { ok: true };
  const root = await getRepoRoot(cwd);
  if (!root) return { code: "not-a-repo", message: "not a git repository" };
  try {
    if (op === "stage") {
      // `git add -A --` handles untracked, modifications, and deletions in
      // one call.
      await git(["add", "-A", "--", ...paths], root);
    } else if (op === "unstage") {
      // `git restore --staged --` works on all paths, including newly added.
      await git(["restore", "--staged", "--", ...paths], root);
    } else if (op === "discard") {
      // IntelliJ-style "rollback": restore tracked files (staged + unstaged)
      // to their HEAD state and delete anything untracked.
      //
      // We bucket the paths because `git checkout -- a b` aborts the WHOLE
      // command if any path isn't in the index/HEAD (e.g. a staged addition
      // that isn't in HEAD yet). Running per-bucket lets the legit paths
      // succeed even when others wouldn't.
      const status = await getStatus(root);
      if (isGitError(status)) return status;
      const byPath = new Map(status.files.map((f) => [f.path, f]));

      const toUnstage: string[] = []; // anything currently in the index
      const inHead: string[] = []; // paths whose blob exists in HEAD (safe to `checkout --`)
      for (const p of paths) {
        const f = byPath.get(p);
        if (!f) continue;
        if (!f.untracked && f.index !== " ") toUnstage.push(p);
        // index === "A" means a fresh add (no HEAD blob yet) — `checkout --`
        // would fail. Renames/copies (R/C) DO have a HEAD blob (under the
        // old name). Modified, deleted, type-changed all have HEAD blobs.
        if (!f.untracked && f.index !== "A") inHead.push(p);
      }
      const errors: string[] = [];
      if (toUnstage.length > 0) {
        try {
          await git(["reset", "HEAD", "--", ...toUnstage], root);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      if (inHead.length > 0) {
        try {
          await git(["checkout", "--", ...inHead], root);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      // Clean removes whatever's still untracked: pure untracked entries plus
      // staged-additions that became untracked after `reset HEAD` above.
      try {
        await git(["clean", "-fd", "--", ...paths], root);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      if (errors.length > 0) {
        return { code: "git-failed", message: errors.join("; ") };
      }
    }
    return { ok: true };
  } catch (err) {
    return {
      code: "git-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export type CommitResult = { ok: true; sha: string; subject: string } | GitError;

/** Commit whatever is currently staged. Message goes via stdin (-F -). */
export async function commitStaged(cwd: string, message: string): Promise<CommitResult> {
  const root = await getRepoRoot(cwd);
  if (!root) return { code: "not-a-repo", message: "not a git repository" };
  if (!message.trim()) {
    return { code: "git-failed", message: "commit message required" };
  }
  try {
    await git(["commit", "-F", "-", "--cleanup=strip"], root, { input: message });
    const { stdout } = await git(["log", "-1", "--pretty=%H%n%s"], root);
    const [sha, subject] = stdout.split("\n");
    return { ok: true, sha: sha?.trim() ?? "", subject: subject?.trim() ?? "" };
  } catch (err) {
    return {
      code: "git-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True for known GitError shapes. */
export function isGitError(x: unknown): x is GitError {
  return (
    typeof x === "object" &&
    x !== null &&
    "code" in x &&
    typeof (x as { code?: unknown }).code === "string" &&
    "message" in x
  );
}
