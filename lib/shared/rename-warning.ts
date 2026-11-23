/**
 * CC 2.1.319 parity — "Fixed `/rename` reporting plain success when the new
 * name could not be saved to the session transcript; it now warns that the
 * new name may not last".
 *
 * Claudius's sessions index is authoritative for its own UI, but the JSONL
 * `custom-title` line is what the terminal CLI, `--resume` and other clients
 * read. When that append fails for a reason nothing will retry, the rename
 * still succeeds in Claudius and the toast says so — with the engine's
 * warning instead of a plain "Renamed".
 */

/** The engine's wording (2.1.319 bundle), verbatim. */
export const RENAME_MAY_NOT_LAST_WARNING =
  "The new name may not last: the session transcript could not be updated";

/**
 * The SDK's `renameSession` throws "Session <id> not found …" when no JSONL
 * exists yet (a fresh session before its first turn). That case isn't a lost
 * write: `Session.flushPendingTitleMirror` re-sends the name once the
 * transcript exists, or there is no transcript for anyone else to read.
 * Anything else (EACCES, ENOSPC, EROFS …) is a transcript that exists but
 * could not be updated.
 */
export function isMissingTranscriptError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\bSession \S+ not found\b/.test(msg);
}

/** The toast for a rename that succeeded, with or without the warning. */
export function renameToastText(warning?: string | null): string {
  return warning ? `Renamed — ${warning.charAt(0).toLowerCase()}${warning.slice(1)}` : "Renamed";
}
