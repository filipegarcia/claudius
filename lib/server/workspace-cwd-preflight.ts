/**
 * Pre-flight validation for a Session's workspace cwd, before the SDK's
 * `query()` is called.
 *
 * Why this exists:
 *
 * When the user has moved/deleted/renamed the workspace folder (or rewired
 * their home dir on a fresh OS install), the Session's `cwd` still points
 * at the old path. The SDK then calls `child_process.spawn(claudeBin,
 * args, { cwd })`; posix_spawn `chdir()`s into `cwd` BEFORE exec'ing the
 * binary, so a missing cwd returns ENOENT — and Node's error message
 * attributes ENOENT to the BINARY argument (the first arg of spawn), not
 * to the cwd. The SDK then runs `existsSync(claudeBin)` → true and emits
 * the famously misleading:
 *
 *   "Claude Code native binary at /Applications/Claudius.app/…/claude
 *    exists but failed to launch."
 *
 * The actual problem is the cwd, but the user sees a binary error and has
 * nowhere to go from there. We had a real-world report (v0.3.170.9 on
 * 2026-06-10) where the user's workspace pointed at `~/claudius` but
 * their project actually lived at `~/Projects/claudius` — every session
 * start hit that misleading banner.
 *
 * `validateWorkspaceCwd()` is called from `Session.start()` BEFORE
 * invoking `query()`. On failure the session broadcasts a clear,
 * actionable error and returns without spawning anything.
 *
 * Extracted to its own module so the validation logic can be unit-tested
 * without instantiating the (heavy, DB+SDK-backed) `Session` class. The
 * regression we're guarding against is "future refactor silently drops
 * the pre-flight check," which an integration test on a packaged
 * artifact wouldn't catch — the smoke runs against a fresh temp HOME
 * with no persisted stale workspaces.
 */
import { promises as fsp } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type WorkspaceCwdPreflight =
  | { ok: true }
  | { ok: false; code: "ENOENT" | "NOT_DIR" | "OTHER"; message: string };

/**
 * Validate that `cwd` exists on disk AND is a directory. Returns a
 * structured result the caller can broadcast verbatim — `message` is
 * user-facing copy with the offending path interpolated.
 *
 * Three failure modes, mapped to three distinct error messages:
 *   • ENOENT  → folder doesn't exist (most common: user moved/deleted)
 *   • NOT_DIR → path exists but is a file/symlink/etc.
 *   • OTHER   → anything else (EACCES on a locked-down volume, etc.) —
 *               echo the raw errno so the user can act on it instead of
 *               falling through to the SDK's misleading binary error.
 *
 * Strict refuse rather than auto-mkdir: silently recreating the path
 * would leave the user with an empty workspace and no clue that their
 * real folder is somewhere else.
 */
export async function validateWorkspaceCwd(
  cwd: string,
): Promise<WorkspaceCwdPreflight> {
  // Defensive hardening before we touch the filesystem with a user-provided
  // path. A workspace cwd must be ABSOLUTE: statting a relative cwd would
  // resolve it against the SERVER process's working directory (a footgun that
  // silently probes the wrong tree) rather than the folder the user
  // configured. Reject non-absolute input outright, then stat the normalised
  // (`resolve`d) form.
  //
  // NOTE: this is hardening, NOT a CodeQL `js/path-injection` barrier
  // (alert #47). A workspace is intentionally ANY folder on the operator's own
  // machine, so there is no base directory to confine it to — the recognised
  // `resolve(base, x)` + `startsWith(base + sep)` jail does not apply here.
  // The path-setter is the trusted operator: the same principal the API
  // already trusts to run arbitrary agent shell commands, so a `stat` metadata
  // probe is no escalation. We accept #47 as a false positive in practice;
  // this guard documents the invariant and removes the relative-path footgun.
  if (!isAbsolute(cwd)) {
    return {
      ok: false,
      code: "OTHER",
      message: `Workspace path \`${cwd}\` isn't an absolute folder path. Fix the path or re-add the workspace using its full path.`,
    };
  }
  const target = resolve(cwd);
  try {
    const st = await fsp.stat(target);
    if (!st.isDirectory()) {
      return {
        ok: false,
        code: "NOT_DIR",
        message: `Workspace path \`${cwd}\` exists but isn't a directory. Pick a different folder for this workspace.`,
      };
    }
    return { ok: true };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException)?.code;
    if (errno === "ENOENT") {
      return {
        ok: false,
        code: "ENOENT",
        message: `Workspace folder \`${cwd}\` doesn't exist. The folder was moved or deleted — recreate it, or remove this workspace from the sidebar and re-add the real path.`,
      };
    }
    return {
      ok: false,
      code: "OTHER",
      message: `Can't read workspace folder \`${cwd}\` (${errno ?? "unknown error"}). Fix the path or pick a different folder.`,
    };
  }
}
