/**
 * CC 2.1.326 — plain-words hints for the errno codes a failed settings or
 * memory-file write reports, shared by the Memory page
 * (`claudemd-writable.ts`) and the permissions / `/add-dir` save message
 * (`settings-load-error.ts`) so both read the same.
 */
const ERRNO_HINTS: Readonly<Record<string, string>> = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "read-only file system",
  ENOSPC: "no space left on device",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
};

/** The hint for an errno code, or `undefined` for one we don't name. */
export function errnoHint(code: string): string | undefined {
  return Object.hasOwn(ERRNO_HINTS, code) ? ERRNO_HINTS[code] : undefined;
}
