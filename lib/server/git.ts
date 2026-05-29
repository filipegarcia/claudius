import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Read a file's content at a specific git revision via `git show <rev>:<path>`.
 * Used by the side-by-side diff view to populate the "old" pane.
 *
 * Conventions for `rev`:
 *   - `"HEAD"`  → the committed version (left pane when comparing against
 *                 the staged diff)
 *   - `""` (empty) → the index version (left pane when comparing against
 *                    the unstaged diff). `git show :path` resolves to the
 *                    index blob; we expose this as ref=""  so callers don't
 *                    have to know the colon syntax.
 *
 * Resolves with `{ content: "" }` when the file doesn't exist at that
 * revision (e.g. it was newly added and HEAD doesn't have it). git exits
 * non-zero in that case; we catch and translate, because "no blob at HEAD"
 * is a legitimate side-by-side outcome (the left pane is just empty).
 */
export async function gitShow(
  cwd: string,
  rev: string,
  path: string,
): Promise<{ content: string } | GitError> {
  const root = await getRepoRoot(cwd);
  if (!root) return { code: "not-a-repo", message: "not a git repository" };
  // `git show <rev>:<path>` — rev="" means the index (the colon prefix is
  // git's own syntax for "look in the index"). We forward as-is.
  const spec = `${rev}:${path}`;
  try {
    const { stdout } = await git(["show", spec], root);
    return { content: stdout };
  } catch (err) {
    // git's "exists on disk but not at <rev>" failure is exit 128 with
    // "fatal: path '...' exists on disk, but not in '<rev>'" or similar.
    // For the diff viewer this means "no old version" — return empty
    // content so the left pane renders as blank rather than blowing up.
    const msg = err instanceof Error ? err.message : String(err);
    if (/exists on disk, but not in|does not exist|fatal: path/i.test(msg)) {
      return { content: "" };
    }
    return { code: "git-failed", message: msg };
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

export type StageOp = "stage" | "unstage" | "discard" | "remove";

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
      // `git add -A --` handles untracked, modifications, and deletions —
      // except for files that are already *fully* staged with no unstaged
      // divergence (e.g. `D ` — staged-deleted, gone from disk). For those
      // git aborts with `pathspec ... did not match any files` because the
      // file isn't in the worktree AND there's nothing on the unstaged side
      // for `add` to consume. Drop those paths up front: a click on "Stage"
      // for an already-fully-staged entry is semantically a no-op.
      //
      // We use `worktree !== " "` as the keep predicate: anything with an
      // unstaged change (or untracked, `?`) still has work to do; anything
      // with `worktree === " "` is fully staged already and would error.
      const status = await getStatus(root);
      if (isGitError(status)) return status;
      const byPath = new Map(status.files.map((f) => [f.path, f]));
      const toStage = paths.filter((p) => {
        const f = byPath.get(p);
        if (!f) return false; // path unknown to git — nothing to stage
        return f.worktree !== " ";
      });
      if (toStage.length === 0) return { ok: true };
      await git(["add", "-A", "--", ...toStage], root);
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
    } else if (op === "remove") {
      // "Delete file" semantics — distinct from "discard" (revert to HEAD).
      // For tracked files we run `git rm -f` so the deletion is staged and
      // ready to commit; for untracked files we just unlink from disk
      // because git rm refuses untracked paths.
      //
      // We bucket by tracked/untracked first so a mixed selection still
      // makes partial progress when one side errors (e.g. unlink ENOENT on
      // a race) without aborting the rest.
      const status = await getStatus(root);
      if (isGitError(status)) return status;
      const byPath = new Map(status.files.map((f) => [f.path, f]));
      const tracked: string[] = [];
      const untracked: string[] = [];
      for (const p of paths) {
        const f = byPath.get(p);
        if (!f) continue;
        if (f.untracked) untracked.push(p);
        else tracked.push(p);
      }
      const errors: string[] = [];
      if (tracked.length > 0) {
        try {
          // `git rm -f` handles every tracked state: clean, modified, deleted-
          // from-worktree, staged-addition (with -f it strips from index too).
          await git(["rm", "-f", "--", ...tracked], root);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      for (const p of untracked) {
        try {
          // `force: true` would be nicer but Node 22's `unlink` doesn't take
          // that option — wrap in try/catch and swallow ENOENT explicitly.
          await unlink(join(root, p));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          errors.push(err instanceof Error ? err.message : String(err));
        }
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

/**
 * Build a single combined unified diff covering the given paths, suitable
 * for feeding to a model that needs to summarise the change. Tracked paths
 * are diffed `HEAD → working tree` (folds staged + unstaged into one view);
 * untracked paths get a /dev/null diff so new content shows up.
 */
export async function getDiffForCommit(
  cwd: string,
  paths: string[],
): Promise<{ diff: string } | GitError> {
  if (paths.length === 0) return { diff: "" };
  const root = await getRepoRoot(cwd);
  if (!root) return { code: "not-a-repo", message: "not a git repository" };
  const status = await getStatus(cwd);
  if (isGitError(status)) return status;
  const untrackedSet = new Set(status.files.filter((f) => f.untracked).map((f) => f.path));
  const tracked = paths.filter((p) => !untrackedSet.has(p));
  const newFiles = paths.filter((p) => untrackedSet.has(p));
  const parts: string[] = [];
  try {
    if (tracked.length > 0) {
      const { stdout } = await git(["diff", "HEAD", "--no-color", "--", ...tracked], root);
      if (stdout) parts.push(stdout);
    }
  } catch (err) {
    return {
      code: "git-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  for (const p of newFiles) {
    try {
      const { diff } = await diffNoIndex(root, p);
      if (diff) parts.push(diff);
    } catch (err) {
      return {
        code: "git-failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { diff: parts.join("\n") };
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

export type RemoteOp = "fetch" | "pull" | "push";

export type RemoteResult = { ok: true; output: string } | GitError;

/**
 * Run a remote-affecting git operation. Each op is hardcoded to a safe
 * variant so the UI doesn't need to surface flag knobs:
 *   - fetch: `git fetch --all --prune`
 *   - pull:  `git pull --ff-only` (no auto-merge; surface conflicts loudly)
 *   - push:  `git push`, falling back to `git push -u origin <branch>` when
 *            the current branch has no upstream yet.
 */
export async function gitRemote(cwd: string, op: RemoteOp): Promise<RemoteResult> {
  const root = await getRepoRoot(cwd);
  if (!root) return { code: "not-a-repo", message: "not a git repository" };
  try {
    if (op === "fetch") {
      const r = await git(["fetch", "--all", "--prune"], root);
      return { ok: true, output: (r.stdout + r.stderr).trim() };
    }
    if (op === "pull") {
      const r = await git(["pull", "--ff-only"], root);
      return { ok: true, output: (r.stdout + r.stderr).trim() };
    }
    // push: try the plain form first; on "no upstream" fall back to -u origin.
    try {
      const r = await git(["push"], root);
      return { ok: true, output: (r.stdout + r.stderr).trim() };
    } catch (err) {
      const msg =
        err instanceof GitFailure
          ? err.stderr
          : err instanceof Error
            ? err.message
            : String(err);
      if (/no upstream branch|--set-upstream/i.test(msg)) {
        const br = (await git(["rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();
        if (!br || br === "HEAD") {
          return { code: "git-failed", message: "no current branch (detached HEAD)" };
        }
        // Prefer "origin" when present; fall back to the only remote if not.
        // Repos with multiple non-origin remotes are ambiguous — surface the
        // original "no upstream" message so the user can configure tracking.
        const remotes = (await git(["remote"], root)).stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (remotes.length === 0) {
          return { code: "git-failed", message: "no remotes configured" };
        }
        const remote = remotes.includes("origin")
          ? "origin"
          : remotes.length === 1
            ? remotes[0]
            : null;
        if (!remote) return { code: "git-failed", message: msg };
        const r2 = await git(["push", "-u", remote, br], root);
        return { ok: true, output: (r2.stdout + r2.stderr).trim() };
      }
      return { code: "git-failed", message: msg };
    }
  } catch (err) {
    return {
      code: "git-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export type GitBranch = {
  /** Short name. For local branches this is "main"; for remote tracking refs
   * this is "origin/main". */
  name: string;
  /** Local vs remote-tracking. Remote-tracking refs become a tracking local
   * branch on checkout. */
  kind: "local" | "remote";
  /** Short SHA of the tip commit. */
  sha: string;
  /** Upstream tracking ref for local branches (e.g. "origin/main"), if any. */
  upstream?: string;
  /** ISO-8601 commit date of the tip; used for "Recent" sort. */
  committerDate: string;
  /** True when this is HEAD's branch. */
  current: boolean;
};

/**
 * List local + remote branches in a single pass via `for-each-ref`, pre-sorted
 * by committerdate desc. Filters out the `origin/HEAD` symbolic ref because
 * it's an alias for whatever the default branch is, not a real branch.
 */
export async function listBranches(cwd: string): Promise<GitBranch[] | GitError> {
  const root = await getRepoRoot(cwd);
  if (!root) return { code: "not-a-repo", message: "not a git repository" };
  try {
    // %00 is git's literal-NUL field separator. Keeps us consistent with the
    // porcelain -z parser above and dodges any whitespace-in-refname surprises.
    // We pull both refname (long form) and refname:short — the long form's
    // prefix is the unambiguous local/remote signal, since local branches can
    // contain slashes ("feat/foo") that would fool a naive check.
    const fmt = [
      "%(refname)",
      "%(refname:short)",
      "%(objectname:short)",
      "%(upstream:short)",
      "%(committerdate:iso8601)",
      "%(HEAD)",
    ].join("%00");
    const { stdout } = await git(
      ["for-each-ref", `--format=${fmt}`, "--sort=-committerdate", "refs/heads", "refs/remotes"],
      root,
    );
    const out: GitBranch[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [refname, name, sha, upstream, committerDate, head] = line.split("\0");
      if (!refname || !name) continue;
      const kind: "local" | "remote" = refname.startsWith("refs/remotes/") ? "remote" : "local";
      // `origin/HEAD -> origin/main` style symbolic refs come through as
      // "refs/remotes/origin/HEAD"; they're aliases, not real branches.
      if (kind === "remote" && /^[^/]+\/HEAD$/.test(name)) continue;
      out.push({
        name,
        kind,
        sha: sha ?? "",
        upstream: upstream || undefined,
        committerDate: committerDate ?? "",
        current: head === "*",
      });
    }
    return out;
  } catch (err) {
    return {
      code: "git-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Switch to `name`. Behaviour:
 *   - local branch exists → `git switch <name>` (plain checkout)
 *   - remote-only ref ("origin/foo") → `git switch --track <name>` which
 *     creates a local "foo" tracking the remote
 *   - `create: true` → `git switch -c <name> [startPoint]` (new branch);
 *     fails if the branch already exists (no `-C`/force on purpose)
 *
 * Git's own dirty-tree refusal is forwarded verbatim — we deliberately don't
 * stash-and-pop because recovery is messy and surprising.
 */
export async function checkoutBranch(
  cwd: string,
  opts: { name: string; create?: boolean; startPoint?: string },
): Promise<{ ok: true; output: string } | GitError> {
  const root = await getRepoRoot(cwd);
  if (!root) return { code: "not-a-repo", message: "not a git repository" };
  const name = opts.name.trim();
  if (!isValidRefName(name)) {
    return { code: "git-failed", message: "invalid branch name" };
  }
  if (opts.startPoint != null && !isValidRefName(opts.startPoint)) {
    return { code: "git-failed", message: "invalid start point" };
  }
  try {
    let args: string[];
    if (opts.create) {
      args = ["switch", "-c", name];
      if (opts.startPoint) args.push(opts.startPoint);
    } else {
      // Probe whether `name` is already a local branch — if so, just switch.
      // Otherwise see if it matches a remote-tracking ref and create the
      // local tracking branch off it. We can't rely on a regex over the name
      // because local branches can contain slashes too ("feat/foo").
      if (await refExists(root, `refs/heads/${name}`)) {
        args = ["switch", name];
      } else if (await refExists(root, `refs/remotes/${name}`)) {
        // Local branch name strips the remote prefix: "origin/foo" → "foo".
        const localName = name.split("/").slice(1).join("/");
        if (!localName || !isValidRefName(localName)) {
          return { code: "git-failed", message: "could not derive local branch name" };
        }
        // If a local of that bare name happens to exist already (different
        // tip), refuse rather than silently switching to it.
        if (await refExists(root, `refs/heads/${localName}`)) {
          args = ["switch", localName];
        } else {
          args = ["switch", "--track", name];
        }
      } else {
        return { code: "git-failed", message: `unknown branch: ${name}` };
      }
    }
    const r = await git(args, root);
    return { ok: true, output: (r.stdout + r.stderr).trim() };
  } catch (err) {
    const message =
      err instanceof GitFailure
        ? err.stderr.trim() || err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { code: "git-failed", message };
  }
}

async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await execFileP("git", ["show-ref", "--verify", "--quiet", ref], {
      cwd: root,
      timeout: TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull and merge the current branch's upstream, surfacing conflicts as data
 * (not as a stderr blob the caller has to grep). On any merge conflict, the
 * working tree stays in its half-merged state — the caller is expected to
 * hand that off to an interactive resolver (e.g. Claude Code) rather than
 * silently aborting.
 *
 * Failure taxonomy:
 *   - kind: "conflicts" → unmerged paths, working tree mid-merge
 *   - kind: "error"     → no upstream, dirty tree, network, etc. (untouched)
 *
 * `--no-rebase --no-edit` is mandatory: without `--no-edit`, git tries to
 * launch `$EDITOR` for the merge-commit message and either fails immediately
 * (no TTY) or hangs forever in this server route.
 */
export type PullMergeResult =
  | { ok: true; output: string }
  | { ok: false; kind: "conflicts"; conflicts: string[]; output: string }
  | { ok: false; kind: "error"; message: string };

export async function pullWithMerge(cwd: string): Promise<PullMergeResult> {
  const root = await getRepoRoot(cwd);
  if (!root) return { ok: false, kind: "error", message: "not a git repository" };
  try {
    const r = await git(["pull", "--no-rebase", "--no-edit"], root);
    return { ok: true, output: (r.stdout + r.stderr).trim() };
  } catch (err) {
    // `git pull` exits non-zero in two distinct cases we care about: a
    // merge that produced conflicts (working tree mid-merge, paths listed
    // by `git diff --diff-filter=U`) and operational failures (no upstream,
    // dirty tree refusal, network errors). The taxonomy split here matters
    // because the conflict branch is the one we hand off to Claude.
    const stderr =
      err instanceof GitFailure
        ? err.stderr
        : err instanceof Error
          ? err.message
          : String(err);
    const conflicts = await listConflicts(root);
    if (conflicts.length > 0) {
      const output =
        err instanceof GitFailure ? (err.stderr || "").trim() : stderr;
      return { ok: false, kind: "conflicts", conflicts, output };
    }
    return { ok: false, kind: "error", message: stderr.trim() || "git pull failed" };
  }
}

/** Unmerged-path list. Catches all of UU/AA/DD/AU/UA/UD/DU in one query. */
async function listConflicts(root: string): Promise<string[]> {
  try {
    const { stdout } = await git(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      root,
    );
    return stdout
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Reject refnames that would confuse `execFile` arg parsing or violate the
 * git refname grammar. `execFile` itself blocks shell injection, but a name
 * shaped like `--force` would still flow through as an option.
 */
function isValidRefName(name: string): boolean {
  if (!name) return false;
  if (name.startsWith("-")) return false; // would be parsed as a flag
  if (name.length > 255) return false;
  // git-check-ref-format rules, abbreviated to the bits that matter:
  //   no whitespace, ASCII control, or any of:  ~ ^ : ? * [ \
  //   no ".." or "@{" sequences, no trailing "/", no trailing ".lock"
  if (/[\s~^:?*\[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  if (name.endsWith("/") || name.endsWith(".lock")) return false;
  return true;
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
