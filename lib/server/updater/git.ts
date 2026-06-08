import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { extendedPath } from "./spawn-env";

/**
 * Thin wrapper around `git` for the updater path. We deliberately don't
 * reuse `lib/server/git.ts` — that one targets the workspace cwd (the user's
 * project), while the updater always operates against the Claudius install
 * root. Keeping them separate avoids accidentally pointing the updater at
 * the wrong tree.
 */

const execFileP = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 60_000;

export type GitRunResult = { stdout: string; stderr: string };

export class UpdaterGitError extends Error {
  constructor(
    message: string,
    readonly stderr: string = "",
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "UpdaterGitError";
  }
}

async function git(
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Disable any interactive prompts (credentials, GPG passphrase, etc.).
        // The updater must never block waiting for tty input.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
        // Make sure git itself is findable when the daemon was launched
        // outside a shell (Finder, launchd) — Apple Silicon homebrew git
        // lives at /opt/homebrew/bin which isn't in the minimal kernel PATH.
        PATH: extendedPath(process.env.PATH),
      },
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const code = typeof e.code === "number" ? e.code : null;
    throw new UpdaterGitError(
      e.message ?? `git ${args[0] ?? ""} failed`,
      stderr,
      code,
    );
  }
}

/** True when `cwd` is inside a git work tree. Cheap, no network. */
export async function isGitCheckout(cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const b = stdout.trim();
  return b === "HEAD" ? null : b;
}

export async function headSha(cwd: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "HEAD"], cwd);
  return stdout.trim();
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await git(["rev-parse", ref], cwd);
  return stdout.trim();
}

/**
 * True iff `ancestor` is reachable from `descendant` (i.e. `descendant`
 * contains the commit `ancestor`). Used by the /api/updater/status reconcile
 * path to detect when the user has externally pulled in the commit we last
 * recorded as "pending" — in which case the cached pending state is stale
 * and the banner should drop.
 *
 * `git merge-base --is-ancestor` exits 0 for "yes" and 1 for "no" — both are
 * normal answers. We catch the exit-1 case and return `false`. Any other
 * failure (unknown ref, gc'd commit, missing git binary, …) is treated as
 * "can't tell" and returns `false` so the caller keeps the pending banner
 * up rather than silently hiding a still-real update.
 */
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
    return true;
  } catch (err) {
    if (err instanceof UpdaterGitError && err.exitCode === 1) return false;
    return false;
  }
}

export async function isDirty(cwd: string): Promise<boolean> {
  const { stdout } = await git(["status", "--porcelain"], cwd);
  return stdout.trim().length > 0;
}

/**
 * Network: fetches the configured remote/branch. Bounded timeout so a slow
 * remote doesn't wedge boot.
 */
export async function fetch(cwd: string, remote: string, branch: string): Promise<void> {
  await git(["fetch", "--quiet", "--no-tags", remote, branch], cwd, FETCH_TIMEOUT_MS);
}

export type AheadBehind = { ahead: number; behind: number };

export async function aheadBehind(
  cwd: string,
  local: string,
  upstream: string,
): Promise<AheadBehind> {
  const { stdout } = await git(
    ["rev-list", "--left-right", "--count", `${local}...${upstream}`],
    cwd,
  );
  const [ahead, behind] = stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

/** Subject lines for `local..upstream`, newest-first, capped. */
export async function recentCommits(
  cwd: string,
  local: string,
  upstream: string,
  limit = 8,
): Promise<string[]> {
  try {
    const { stdout } = await git(
      ["log", `--pretty=%s`, `-n`, String(limit), `${local}..${upstream}`],
      cwd,
    );
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function pullFastForward(
  cwd: string,
  remote: string,
  branch: string,
): Promise<void> {
  await git(["pull", "--ff-only", "--quiet", remote, branch], cwd, PULL_TIMEOUT_MS);
}

/**
 * Push the current working tree (tracked + untracked, no ignored) onto the
 * stash with `-u`, tagged with `message`. Returns `false` when there was
 * nothing to stash so the caller doesn't pop something it didn't push.
 *
 * `git stash push` exits 0 even when the tree is clean and prints "No local
 * changes to save" — we detect that by re-querying isDirty afterwards rather
 * than parsing stdout (which is locale-dependent).
 */
export async function stashPushIncludeUntracked(
  cwd: string,
  message: string,
): Promise<{ stashed: boolean }> {
  const dirtyBefore = await isDirty(cwd);
  if (!dirtyBefore) return { stashed: false };
  await git(["stash", "push", "-u", "-m", message], cwd, DEFAULT_TIMEOUT_MS * 2);
  // If still dirty, the stash didn't actually move anything — treat as not
  // stashed so the caller doesn't pop an unrelated entry from before.
  const dirtyAfter = await isDirty(cwd);
  return { stashed: !dirtyAfter };
}

/**
 * Pop the most recent stash entry. Returns `{ ok: true }` when the working
 * tree is clean after the pop, or `{ ok: false, conflicts: true, output }`
 * when git reports merge conflicts (exit code 1 + the per-file conflict
 * markers list). Other failures throw.
 *
 * Note: on a conflicting pop, git does NOT drop the stash entry — the user
 * (or our recovery prompt) can re-run `git stash show` / `git stash drop`
 * later as needed.
 */
export async function stashPop(
  cwd: string,
): Promise<{ ok: true } | { ok: false; conflicts: true; output: string }> {
  try {
    await git(["stash", "pop"], cwd, DEFAULT_TIMEOUT_MS * 2);
    return { ok: true };
  } catch (err) {
    if (err instanceof UpdaterGitError && err.exitCode === 1) {
      // Conflict — the stash entry is still in the list; the working tree
      // has conflict markers. Surface for the caller to render a recovery
      // action.
      return {
        ok: false,
        conflicts: true,
        output: (err.stderr || err.message).trim(),
      };
    }
    throw err;
  }
}


/**
 * Streaming spawn — the caller decides how to handle stdout/stderr. Used by
 * the apply path so long-running operations (`bun install`, `bun run build`)
 * can pipe progress into the updater log without buffering the whole output.
 *
 * Returns a promise that resolves with the exit code; rejects if the process
 * couldn't be spawned at all.
 */
export function spawnStreamed(
  cmd: string,
  args: string[],
  cwd: string,
  onLine: (line: string, stream: "out" | "err") => void,
  // Overrides are spread on top of `process.env` below, so callers should
  // only need to pass the keys they actually want to change. `ProcessEnv`
  // itself is non-partial in Next.js's ambient types (NODE_ENV is required),
  // so we widen with `Partial<>` to allow `{}` and one-key overrides.
  envOverrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Extend PATH with the standard bun/homebrew install locations BEFORE
    // mixing in the caller's overrides — so a caller can still pin a custom
    // PATH if they want to (last write wins). Without this, a daemon
    // launched outside a shell (Finder, launchd, IDE) hits `spawn bun
    // ENOENT` because ~/.bun/bin isn't on the inherited PATH.
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
        PATH: extendedPath(process.env.PATH),
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outBuf = "";
    let errBuf = "";
    const flush = (which: "out" | "err", chunk: string) => {
      const buf = which === "out" ? outBuf + chunk : errBuf + chunk;
      const lines = buf.split(/\r?\n/);
      const tail = lines.pop() ?? "";
      for (const ln of lines) onLine(ln, which);
      if (which === "out") outBuf = tail;
      else errBuf = tail;
    };
    child.stdout.on("data", (d: Buffer) => flush("out", d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => flush("err", d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (outBuf) onLine(outBuf, "out");
      if (errBuf) onLine(errBuf, "err");
      resolve(code ?? 1);
    });
  });
}
