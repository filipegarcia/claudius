/**
 * Per-workspace "last opened file" persistence for the /files view.
 *
 * The key is namespaced by workspace id so switching workspaces surfaces
 * the right file. We store `{root, relPath}` (not the absolute path) so
 * the entry survives across machines where the workspace root may sit at
 * a different absolute location.
 *
 * localStorage is the right tier here:
 *   - Matches the existing `claudius.*` pattern (theme, git split-mode,
 *     panel widths, console height) — see app/[workspaceId]/git/page.tsx.
 *   - Survives reload and Electron app restart (Electron persists the
 *     renderer's localStorage to disk in the user data dir).
 *   - Per-browser/profile, which is what users expect for a UI hint
 *     (versus, say, a permission setting that should sync across
 *     devices via settings.json).
 */

export type LastOpenFile = {
  root: string; // `primary` or `extra:<n>`
  relPath: string;
};

const PREFIX = "claudius.files.lastOpen.";

function keyFor(workspaceId: string): string {
  return `${PREFIX}${workspaceId}`;
}

/**
 * Read the last opened file for a workspace. Returns `null` when nothing
 * is stored, the entry is malformed, or localStorage itself is
 * inaccessible (Safari private mode, sandboxed iframes). Always safe to
 * call from a render path — never throws.
 */
export function readLastOpenFile(workspaceId: string): LastOpenFile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastOpenFile>;
    if (
      typeof parsed?.root === "string" &&
      typeof parsed?.relPath === "string" &&
      parsed.relPath.length > 0
    ) {
      return { root: parsed.root, relPath: parsed.relPath };
    }
  } catch {
    // SecurityError (sandbox), QuotaExceededError on read (rare), or
    // SyntaxError from a hand-edited entry — all benign here.
  }
  return null;
}

/**
 * Save the last opened file for a workspace. Same defensive try/catch — a
 * single failed write must never break file navigation.
 */
export function writeLastOpenFile(workspaceId: string, entry: LastOpenFile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(workspaceId), JSON.stringify(entry));
  } catch {
    /* see readLastOpenFile */
  }
}

/**
 * Clear the entry — invoked after a delete/rename of the currently open
 * file so we don't autoload a stale path on next visit.
 */
export function clearLastOpenFile(workspaceId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyFor(workspaceId));
  } catch {
    /* see readLastOpenFile */
  }
}
