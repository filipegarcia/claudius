import type { GitFileChange, GitStatusCode } from "@/lib/server/git";

/**
 * Pure data-mapping helpers for `DiffOverlay` (CC 2.1.260 `/diff` parity),
 * split out of the component so they're unit-testable without mounting
 * React. Mirrors the worktree-first status convention the rest of
 * Claudius's git UI (`ChangesList.tsx`, the full Git page) already uses.
 */

export type DiffOverlayMode = "staged" | "worktree" | "untracked";

/**
 * Which diff to fetch for a changed file. Untracked files have no index
 * entry (`/dev/null` → worktree); tracked files with any unstaged change
 * show the unstaged (worktree) diff first, since `/diff`'s purpose — a
 * quick glance at "what's changed right now, as Claude edits" — cares
 * about live edits more than what's already staged. A tracked file with
 * only staged changes (no unstaged delta) falls back to the staged diff so
 * it isn't silently hidden.
 */
export function modeFor(f: GitFileChange): DiffOverlayMode {
  if (f.untracked) return "untracked";
  if (f.worktree !== " ") return "worktree";
  return "staged";
}

/** The single status character to badge a row with, following the same worktree-first preference as `modeFor`. */
export function statusChar(f: GitFileChange): GitStatusCode {
  if (f.untracked) return "?";
  return f.worktree !== " " ? f.worktree : f.index;
}

/** Human-readable label for a porcelain status code, for row tooltips. */
export function statusLabel(code: GitStatusCode): string {
  switch (code) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "U":
      return "Unmerged";
    case "?":
      return "Untracked";
    case "T":
      return "Type changed";
    default:
      return "Changed";
  }
}
