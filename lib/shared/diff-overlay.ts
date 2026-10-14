import type { GitFileChange, GitStatusCode } from "@/lib/server/git";

/**
 * Pure data-mapping helpers for `DiffOverlay` (CC 2.1.260 `/diff` parity),
 * split out of the component so they're unit-testable without mounting
 * React. Mostly worktree-first, like the rest of Claudius's git UI
 * (`ChangesList.tsx`, the full Git page) — except that a staged rename/copy
 * keeps its index badge while the fetched diff stays the worktree delta.
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

/**
 * The single status character to badge a row with. Worktree-first like
 * `modeFor` (which picks the diff to fetch) — except for a staged rename/copy
 * that was then edited (porcelain `RM` / `CM` / `RT`). There the worktree
 * slot only says "the content changed again", and preferring it badged a
 * rename as "Modified" (CC 2.1.300: "Fixed the diff view … showing deleted
 * and renamed files as modified"). A worktree deletion (`RD`) still wins:
 * the file is gone, which matters more than how it got its name.
 */
export function statusChar(f: GitFileChange): GitStatusCode {
  if (f.untracked) return "?";
  if ((f.index === "R" || f.index === "C") && (f.worktree === "M" || f.worktree === "T")) {
    return f.index;
  }
  return f.worktree !== " " ? f.worktree : f.index;
}

/**
 * Row label: `old → new` for a rename or copy (same format as the Git page's
 * `ChangesList`), the plain path otherwise.
 */
export function displayPath(f: GitFileChange): string {
  if (!f.untracked && f.oldPath && (f.index === "R" || f.index === "C" || f.worktree === "R" || f.worktree === "C")) {
    return `${f.oldPath} → ${f.path}`;
  }
  return f.path;
}

/**
 * CC 2.1.260 (H5) — a cheap token that changes whenever Claude's edits
 * advance, so the `/diff` overlay can re-fetch "live as Claude edits" without
 * polling. It changes when a new edit starts (total count) and when one lands
 * (done count), so both the appearance and the completion of an edit trigger a
 * refresh. Pure so it's unit-testable.
 */
export function diffRefreshToken(edits: ReadonlyArray<{ done?: boolean }>): string {
  let done = 0;
  for (const e of edits) if (e.done) done++;
  return `${edits.length}:${done}`;
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
