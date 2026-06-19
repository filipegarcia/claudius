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
    // Some git subcommands write their findings to STDOUT and still exit
    // non-zero (notably `git diff --check`, which lists conflict markers on
    // stdout and exits 2). Carry stdout so callers that key off those findings
    // can read them off the thrown error.
    readonly stdout: string = "",
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
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const code = typeof e.code === "number" ? e.code : null;
    throw new UpdaterGitError(
      e.message ?? `git ${args[0] ?? ""} failed`,
      stderr,
      code,
      stdout,
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
 * Before pushing, any pre-existing `claudius-updater-stash` entries are
 * recovered and dropped: their tracked portion is applied to the working tree
 * (restoring any WIP that was trapped by a previous failed pop), then the
 * entry is removed. This prevents the stash list from accumulating across
 * successive update attempts and ensures leftover WIP from prior cycles is
 * folded into the new stash rather than silently lost.
 *
 * `git stash push` exits 0 even when the tree is clean and prints "No local
 * changes to save" — we detect that by re-querying isDirty afterwards rather
 * than parsing stdout (which is locale-dependent).
 */
export async function stashPushIncludeUntracked(
  cwd: string,
  message: string,
): Promise<{ stashed: boolean }> {
  // Recover any leftover updater stash entries from previous cycles. A prior
  // update may have left a `claudius-updater-stash` whose tracked changes were
  // not restored (e.g. if the pop failed before the new recoverFalseConflictPop
  // logic was in place). Apply the tracked portion back into the working tree
  // first so the upcoming stash captures it, then drop the old entry.
  await recoverUpdaterStashes(cwd).catch(() => {
    // Best-effort — don't abort the update if cleanup fails. A stale stash
    // entry is cosmetic; we'll create the new one on top.
  });

  const dirtyBefore = await isDirty(cwd);
  if (!dirtyBefore) return { stashed: false };
  try {
    await git(["stash", "push", "-u", "-m", message], cwd, DEFAULT_TIMEOUT_MS * 2);
  } catch {
    // A blocked `git stash push` is almost always a tree left WEDGED by a prior
    // failed cycle — git refuses to stash over unmerged index entries or while a
    // merge/rebase is mid-flight. This is the exact "apply failed in init:
    // Command failed: git stash push -u" loop seen in the updater log. Heal it
    // with NON-DESTRUCTIVE actions only (abort the in-progress op, rewind the
    // index to HEAD — both preserve every file's content) and try once more
    // rather than dead-ending the whole update. We never reset --hard / clean:
    // the updater must self-heal without discarding the user's work.
    await clearInProgressMergeState(cwd);
    if (!(await isDirty(cwd))) {
      // Aborting the wedged op restored a clean tree — nothing left to stash.
      return { stashed: false };
    }
    await git(["stash", "push", "-u", "-m", message], cwd, DEFAULT_TIMEOUT_MS * 2);
  }
  // If still dirty, the stash didn't actually move anything — treat as not
  // stashed so the caller doesn't pop an unrelated entry from before.
  const dirtyAfter = await isDirty(cwd);
  return { stashed: !dirtyAfter };
}

/**
 * Non-destructively clear a tree wedged by a PRIOR failed update cycle so the
 * next stash / merge can proceed. Run before retrying a blocked `git stash
 * push`, or any time the updater finds itself unable to act on a dirty tree.
 *
 * Order — each step is a no-op (non-zero exit, swallowed) when it doesn't apply:
 *   1. Abort any in-progress merge / rebase / cherry-pick / revert. This
 *      restores the pre-op snapshot of the working tree.
 *   2. If unmerged index entries still linger (a half-resolved conflict that was
 *      `git add`ed, or stash-pop residue), `git reset` (MIXED) the index back to
 *      HEAD.
 *
 * Every step PRESERVES working-tree file content: `merge --abort` restores it,
 * and a mixed `reset` only rewinds the index — the files (conflict markers and
 * all) stay on disk to be swept into the caller's subsequent `git stash push
 * -u`. We deliberately never run `reset --hard` or `git clean`; healing must not
 * discard the user's work. Idempotent and best-effort — a clean tree passes
 * straight through.
 */
export async function clearInProgressMergeState(cwd: string): Promise<void> {
  await git(["merge", "--abort"], cwd).catch(() => {});
  await git(["rebase", "--abort"], cwd).catch(() => {});
  await git(["cherry-pick", "--abort"], cwd).catch(() => {});
  await git(["revert", "--abort"], cwd).catch(() => {});
  if (await hasUnmergedFiles(cwd).catch(() => false)) {
    // Mixed reset (no --hard): clears the unmerged index entries while leaving
    // every file's content untouched on disk.
    await git(["reset", "--quiet"], cwd).catch(() => {});
  }
}

/**
 * Find all stash entries labeled `claudius-updater-stash`, apply their tracked
 * changes back into the working tree, then drop them. Called before each new
 * stash push so old updater entries don't accumulate.
 *
 * Only the entries with that specific label are touched — user stashes are
 * never modified.
 */
async function recoverUpdaterStashes(cwd: string): Promise<void> {
  const { stdout } = await git(["stash", "list", "--format=%gd %s"], cwd);
  // Lines: "stash@{N} On branch: claudius-updater-stash"
  const entries = stdout
    .split("\n")
    .filter((l) => l.includes("claudius-updater-stash"))
    .map((l) => l.split(" ")[0])   // "stash@{N}"
    .filter(Boolean)
    .reverse(); // apply oldest first so indices stay stable as we drop

  for (const ref of entries) {
    try {
      // Apply tracked changes only (no -u). Exit 0 = clean apply.
      // Exit 1 with no unmerged files = already applied (or nothing to apply).
      // Exit 1 with unmerged files = real conflict — leave this entry alone.
      await git(["stash", "apply", ref], cwd, DEFAULT_TIMEOUT_MS * 2).catch(async (e) => {
        if (e instanceof UpdaterGitError && e.exitCode === 1) {
          if (await hasUnmergedFiles(cwd).catch(() => true)) {
            // Real tracked-file conflict — skip this entry; don't drop it.
            throw e;
          }
          // No unmerged files: changes were already in tree. Safe to drop.
        } else {
          throw e;
        }
      });
      await git(["stash", "drop", ref], cwd, DEFAULT_TIMEOUT_MS).catch(() => {});
    } catch {
      // If apply or drop fails unexpectedly, skip this entry. The new stash
      // will be created on top; the leftover entry is cosmetic noise.
    }
  }
}

/**
 * True when the index contains unmerged entries (i.e. real merge-conflict
 * markers from a `git merge` or `git stash pop`). Used to distinguish a
 * genuine pop conflict from a "file already exists, no checkout" error —
 * the latter also exits 1 but leaves no unmerged index entries.
 */
export async function hasUnmergedFiles(cwd: string): Promise<boolean> {
  const { stdout } = await git(["ls-files", "-u"], cwd);
  return stdout.trim().length > 0;
}

/**
 * Tracked files that carry REAL Git conflict-marker residue — markers that were
 * ADDED relative to HEAD (a stash pop / merge that left `<<<<<<<` … `>>>>>>>`
 * in the working tree or index), as opposed to marker-like strings that
 * legitimately live in committed source.
 *
 * Why `git diff --check HEAD` and not a content grep: an earlier version
 * grepped all tracked content for the marker prefixes, which produced a
 * SELF-REFERENTIAL false positive — this very file contains "<<<<<<< " as a
 * string literal in the detection code, and the unit-test fixtures embed marker
 * text too. On the Claudius repo itself that made `hasConflicts` permanently
 * true, wedging the updater into a fake-conflict loop that repeatedly spawned a
 * resolver agent. `git diff --check` only flags marker lines that differ from
 * HEAD, so committed source (which matches HEAD) is never flagged, while actual
 * conflict residue from a pop/merge — which is always a change vs HEAD — is.
 *
 * This still catches the case `hasUnmergedFiles` misses: markers sitting in
 * tracked content with a clean index (round-tripped through a stash pop, or a
 * half-resolved conflict that was `git add`ed). Feeding such a marker-laden
 * `package.json` to `bun install` dies with the confusing "Operators are not
 * allowed in JSON" parse error that gets misfiled as an install failure.
 *
 * Output of `git diff --check` is `path:line: leftover conflict marker`; it
 * exits non-zero (findings on stdout) when any are present, which `git()`
 * surfaces as a thrown error carrying `stdout`.
 */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  let out = "";
  try {
    out = (await git(["diff", "--check", "HEAD"], cwd)).stdout;
  } catch (err) {
    if (err instanceof UpdaterGitError) out = err.stdout || "";
    else throw err;
  }
  const files = new Set<string>();
  for (const raw of out.split("\n")) {
    const m = /^(.*):\d+: leftover conflict marker$/.exec(raw.trim());
    if (m && m[1]) files.add(m[1]);
  }
  return [...files].sort();
}

/**
 * True when the tree is NOT safe to hand to `bun install` / `bun run build`:
 * either the index has unmerged entries or a tracked file still contains
 * conflict markers. Fail-safe: on any unexpected error returns `true` so the
 * caller treats the tree as conflicted rather than blindly installing.
 */
export async function hasConflicts(cwd: string): Promise<boolean> {
  try {
    if (await hasUnmergedFiles(cwd)) return true;
    return (await conflictedFiles(cwd)).length > 0;
  } catch {
    return true;
  }
}

/**
 * Pop the most recent stash entry. Returns `{ ok: true }` when the pop
 * succeeded. Returns `{ ok: false, conflicts: true, output }` only when there
 * are genuine merge conflict markers in the index. Other failures throw.
 *
 * Background: `git stash pop` exits 1 for two distinct situations:
 *
 *   1. Real merge conflict — content markers in the index, git ls-files -u
 *      is non-empty. The tree needs human (or Claude) resolution.
 *
 *   2. "file already exists, no checkout" — upstream added a file that was
 *      also stashed as untracked. The pull already checked out the upstream
 *      version; the pop can't restore the stash's untracked version on top.
 *      git ls-files -u is EMPTY — no content conflict. git's atomic rollback
 *      means the user's TRACKED changes are still only in the stash (not
 *      applied to the working tree). We detect this case, apply just the
 *      tracked portion (no -u), then drop the stash entry — leaving the user's
 *      working tree at upstream + their tracked modifications, which is exactly
 *      the correct post-update state.
 *
 * Note: on a real conflicting pop, git does NOT drop the stash entry — the
 * user (or our recovery prompt) can re-run `git stash show` / `git stash
 * drop` later as needed.
 */
export async function stashPop(
  cwd: string,
): Promise<{ ok: true } | { ok: false; conflicts: true; output: string }> {
  try {
    await git(["stash", "pop"], cwd, DEFAULT_TIMEOUT_MS * 2);
    return { ok: true };
  } catch (err) {
    if (err instanceof UpdaterGitError && err.exitCode === 1) {
      // Distinguish a real content conflict from the "file already exists"
      // false-conflict. Fall back to conflict=true if the check itself fails.
      const actual = await hasUnmergedFiles(cwd).catch(() => true);
      if (!actual) {
        // False conflict — "file already exists, no checkout". Apply the tracked
        // portion of the stash (without untracked files) so the user's WIP is
        // restored, then drop the entry to leave a clean state.
        return await recoverFalseConflictPop(cwd, err.stderr || "");
      }
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
 * Recovery for "file already exists, no checkout": the stash pop failed
 * because upstream added files that were also stashed as untracked. HEAD is
 * at the correct upstream state. We need to restore the TRACKED changes (user
 * WIP modifications to existing files) that git atomically rolled back.
 *
 *   - `git stash apply` (without -u) re-applies the tracked diff only.
 *   - If it succeeds and leaves no unmerged entries → tracked WIP restored,
 *     drop the stash entry, return ok.
 *   - If apply itself produces merge conflicts in tracked files → real conflict,
 *     leave the stash entry for the user to resolve, return conflicts.
 *   - If apply exits 1 but leaves NO unmerged entries → tracked changes were
 *     already in the working tree (git applied them before failing on the
 *     untracked files — version-dependent behaviour); drop the stash and return ok.
 *   - Any other failure → best-effort drop, return ok (HEAD is still correct,
 *     the only loss is potentially untracked build artifacts that upstream now
 *     owns anyway).
 */
async function recoverFalseConflictPop(
  cwd: string,
  originalOutput: string,
): Promise<{ ok: true } | { ok: false; conflicts: true; output: string }> {
  let applyFailed = false;
  try {
    await git(["stash", "apply"], cwd, DEFAULT_TIMEOUT_MS * 2);
  } catch {
    applyFailed = true;
  }

  // After `git stash apply`, check whether there are real merge conflicts in
  // tracked files. This distinguishes a genuine content conflict (unmerged
  // entries, needs resolution) from "apply exited 1 but nothing to merge"
  // (changes were already in the tree — git applied them before the untracked-
  // file failure).
  const conflictsAfterApply = await hasUnmergedFiles(cwd).catch(() => false);
  if (conflictsAfterApply) {
    // Tracked files have real conflict markers. Leave the stash entry for the
    // user/Claude to resolve; surface both the original pop error and the apply
    // conflict so the recovery prompt has context.
    return {
      ok: false,
      conflicts: true,
      output: originalOutput
        ? `${originalOutput}\n(tracked changes also conflicted during recovery apply)`
        : "tracked changes conflict during stash recovery",
    };
  }

  if (applyFailed) {
    // Apply exited non-zero but left no unmerged entries — the tracked changes
    // were already present in the working tree (git had applied them before
    // failing on the untracked files). Nothing further to do.
  }

  // Clean state: tracked changes are in the working tree (either just applied
  // or already there). Drop the stash entry. The untracked files in the stash
  // are now owned by upstream, so the entry is fully redundant.
  await git(["stash", "drop"], cwd, DEFAULT_TIMEOUT_MS).catch(() => {
    // Best-effort — a stale stash entry is cosmetic, not a correctness issue.
  });
  return { ok: true };
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
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/echo",
      PATH: extendedPath(process.env.PATH),
      ...envOverrides,
    };
    // A spread can only ADD/replace keys, never remove an inherited one. To
    // let a caller *scrub* a variable it inherited from this process, treat an
    // override whose value is `undefined` as a deletion. (Needed because the
    // daemon/standalone server leaks `__NEXT_PRIVATE_STANDALONE_CONFIG`,
    // `TURBOPACK`, etc. into children, which poisons a self-update's
    // `next build` — see envForBunPhase.)
    for (const key of Object.keys(childEnv)) {
      if (childEnv[key] === undefined) delete childEnv[key];
    }
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
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
