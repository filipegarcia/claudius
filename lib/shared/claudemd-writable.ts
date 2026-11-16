/**
 * CC 2.1.326 parity — "Fixed /memory opening a read-only file with no warning
 * that changes may not save".
 *
 * Claudius's Memory page edits CLAUDE.md natively (lib/server/claudemd.ts +
 * the `/[workspaceId]/memory` editor). `readScope` now reports whether the
 * file (or, if it doesn't exist yet, the nearest existing parent directory)
 * is writable, the page shows `MEMORY_READONLY_NOTICE` above the editor when
 * it isn't, and a failed PUT returns a JSON `{ error }` built by
 * `formatClaudeMdWriteError` so the page can keep the draft and say why.
 */

export const MEMORY_READONLY_NOTICE = "This file is read-only — changes may not save.";

const ERRNO_HINTS: Readonly<Record<string, string>> = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "read-only file system",
  ENOSPC: "no space left on device",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
};

type WriteErrorLike = { code?: unknown; path?: unknown; message?: unknown };

/**
 * One-line, user-facing description of a failed CLAUDE.md write, naming the
 * file and the errno: `Couldn't save /x/CLAUDE.md: EACCES (permission denied)`.
 * `fallbackPath` is used when the error carries no `path` of its own.
 */
export function formatClaudeMdWriteError(err: unknown, fallbackPath?: string): string {
  const e = (err && typeof err === "object" ? err : {}) as WriteErrorLike;
  const path = typeof e.path === "string" && e.path ? e.path : fallbackPath;
  const code = typeof e.code === "string" && e.code ? e.code : null;
  const target = path ? `Couldn't save ${path}` : "Couldn't save file";
  if (code) {
    const hint = ERRNO_HINTS[code];
    return hint ? `${target}: ${code} (${hint})` : `${target}: ${code}`;
  }
  const message =
    typeof e.message === "string" && e.message
      ? e.message
      : typeof err === "string" && err
        ? err
        : "unknown error";
  return `${target}: ${message}`;
}
