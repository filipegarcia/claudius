// Pure helpers for the settings page's "Worktree" section. Kept in lib/shared
// so they're unit-testable without dragging the "use client" page into the
// test runtime — the page imports these and only owns the React wiring.

// Git worktree creation options (the --worktree flag / EnterWorktree).
// Mirrors the SDK's `Settings.worktree` shape.
export type WorktreeSettings = {
  sparsePaths?: string[];
  symlinkDirectories?: string[];
  baseRef?: "fresh" | "head";
  bgIsolation?: "worktree" | "none";
};

// Parse a comma-separated directory list from a text input into a clean string
// array: trim each entry and drop empties so "apps/web, , packages/ui," yields
// ["apps/web", "packages/ui"].
export function parseDirList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Merge a patch into the nested `worktree` object, preserving any sibling keys
// (baseRef/bgIsolation) a user set via Raw/Other. A patch value of `undefined`
// removes that key. When the result is empty we return `undefined` so callers
// never persist `"worktree": {}`.
export function nextWorktree(
  current: WorktreeSettings | undefined,
  patch: Partial<Pick<WorktreeSettings, "sparsePaths" | "symlinkDirectories">>,
): WorktreeSettings | undefined {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return Object.keys(next).length ? (next as WorktreeSettings) : undefined;
}
