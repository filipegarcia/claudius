/**
 * CC 2.1.221 + 2.1.216 (DEC3) — `/fork` gets its own git worktree plus a
 * one-line confirmation. Pure helpers (id→branch/dir slug, confirmation text)
 * so they're unit-testable without git or the DB.
 */

/** Short, filesystem/branch-safe suffix derived from a fork's session UUID. */
export function forkSlug(sessionId: string): string {
  // UUIDs are already safe, but a fork id could in theory be any string — keep
  // only hex-ish chars and take the first 8, matching `<id8>` elsewhere.
  const cleaned = sessionId.replace(/[^a-zA-Z0-9]/g, "");
  return (cleaned.slice(0, 8) || "session").toLowerCase();
}

/** The branch name and worktree directory name for a fork. */
export function forkWorktreeIds(sessionId: string): { branch: string; dirName: string } {
  const slug = forkSlug(sessionId);
  return { branch: `claudius/fork-${slug}`, dirName: `fork-${slug}` };
}

export type ForkWorktreeInfo = { path: string; branch: string; dirty: boolean };

const MAX_REASON_CHARS = 120;

/**
 * CC 2.1.299 parity — a short, toast-safe reason from a failed
 * `git worktree add`'s stderr: its first `fatal:` / `error:` line (git
 * prints "Preparing worktree …" progress ahead of it), else the first
 * non-empty line — prefix stripped, whitespace collapsed, capped. Falls back
 * to a generic phrase when git printed nothing usable.
 */
export function worktreeFailureReason(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0];
  const cleaned = (line ?? "")
    .replace(/^(fatal|error):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "git worktree add failed";
  return cleaned.length > MAX_REASON_CHARS ? `${cleaned.slice(0, MAX_REASON_CHARS - 1)}…` : cleaned;
}

/**
 * The single-line confirmation shown after a fork. Names the new session and
 * states where it lives: its own worktree (2.1.221) or the shared checkout
 * (2.1.216, non-git source). A dirty source tree gets a note that only
 * committed work (HEAD) is in the worktree. When the source is a repo but the
 * worktree couldn't be made, `worktreeError` says why (CC 2.1.299 parity —
 * "Improved the error shown when a worktree cannot be created…").
 */
export function forkConfirmation(opts: {
  title?: string;
  sessionId: string;
  worktree: ForkWorktreeInfo | null;
  worktreeError?: string;
}): string {
  const { title, sessionId, worktree, worktreeError } = opts;
  const name = title?.trim() ? `"${title.trim()}"` : "untitled";
  const id8 = forkSlug(sessionId);
  if (!worktree) {
    const reason = worktreeError?.trim();
    if (reason) {
      return `Forked as ${name} (${id8}) — couldn't create a worktree (${reason}); it shares your checkout.`;
    }
    return `Forked as ${name} (${id8}) — shares your checkout.`;
  }
  const dirtyNote = worktree.dirty ? " — uncommitted changes not included" : "";
  // Plain text (no markdown) — this renders in a toast, which shows it verbatim.
  return `Forked as ${name} (${id8}) — in its own worktree ${worktree.branch}${dirtyNote}.`;
}
