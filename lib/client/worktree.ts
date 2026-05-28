/**
 * Helpers for the StatusLine "worktree" badge.
 *
 * Claude Code now spins up a git worktree to isolate some work, which moves
 * the agent's effective cwd away from the session root — so the user's
 * "current changed files" don't reflect what the agent touched. The badge
 * makes that visible; this module computes its short label. Pure +
 * framework-free so it can be unit-tested in isolation.
 */

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Decide whether the agent has wandered out of the session root and, if so,
 * produce the short badge label. Returns `null` when there's no worktree to
 * show — either path is missing, or they're the same directory once trailing
 * slashes are normalized away.
 *
 * Crucially, the "should we show a badge?" decision and the label are computed
 * from the *same* normalized paths, so they can't disagree: a `new_cwd` that
 * differs from the root only by a trailing slash (`/proj/` vs `/proj`) — which
 * the SDK or a case-/symlink-normalizing filesystem can produce — collapses to
 * equal here and yields no badge, rather than a spurious one reading "proj".
 */
export function worktreeBadge(
  agentCwd: string | null | undefined,
  sessionRoot: string | null | undefined,
): string | null {
  if (!agentCwd || !sessionRoot) return null;
  const root = stripTrailingSlash(sessionRoot);
  const dir = stripTrailingSlash(agentCwd);
  if (!dir || dir === root) return null;
  return worktreeBadgeLabel(dir, root);
}

/**
 * Short, human-friendly label for the worktree badge. Prefers a path relative
 * to the session root (e.g. `.worktrees/feature-x`) when the worktree lives
 * underneath it; otherwise falls back to the trailing path segment so the
 * badge stays compact even for sibling/temp worktrees (`/tmp/...`). The full
 * absolute path is surfaced separately via the badge's `title` on hover.
 *
 * Both arguments are expected pre-normalized (no trailing slash); callers that
 * take raw SDK paths should go through `worktreeBadge`.
 */
export function worktreeBadgeLabel(agentCwd: string, sessionRoot: string): string {
  const root = stripTrailingSlash(sessionRoot);
  const dir = stripTrailingSlash(agentCwd);
  if (root && dir.startsWith(root + "/")) {
    return dir.slice(root.length + 1);
  }
  const base = dir.split("/").filter(Boolean).pop();
  return base || dir;
}
