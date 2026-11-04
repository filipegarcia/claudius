"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { GitFileChange } from "@/lib/server/git";
import { isPartialStage, type DiffSelection } from "@/components/git/ChangesList";
import { DiffViewer } from "@/components/git/DiffViewer";
import { FileEditor } from "@/components/git/FileEditor";
import { cn } from "@/lib/utils/cn";

type DiffPayload = { diff: string; binary: boolean };

/**
 * Right-pane layout preference: false = unified editor (IntelliJ "Current
 * version" style — the editor IS the diff view), true = side-by-side (old
 * left, current right). Shared by the Git page and the pop-out file window
 * so both open in whichever layout the user last picked.
 */
const SPLIT_MODE_KEY = "claudius.git.splitMode";

function readSplitMode(): boolean {
  // SSR fall-through and first-time visitors get the default (split).
  // Existing entries are respected so users who explicitly toggled to
  // unified ("0") aren't surprised by a flip on the next reload.
  if (typeof window === "undefined") return true;
  const stored = window.localStorage.getItem(SPLIT_MODE_KEY);
  if (stored == null) return true;
  return stored === "1";
}

type Props = {
  wsId: string;
  selected: DiffSelection;
  /**
   * The porcelain entry for `selected.path`, or undefined when it's no
   * longer in `git status` (committed / reverted elsewhere). Drives the
   * partial-stage toggle and whether the file can be loaded into the editor.
   */
  file: GitFileChange | undefined;
  /** Flip the diff base for a partial-stage file (Staged ↔ Unstaged). */
  onModeChange: (mode: DiffSelection["mode"]) => void;
  /** Re-pull git status after the editor saves (the diff will have changed). */
  onSaved?: () => void;
  /** Extra controls rendered at the right edge of the header bar. */
  headerActions?: ReactNode;
};

/**
 * Header (path + diff-mode + layout toggles) and body (editable FileEditor,
 * or the read-only DiffViewer when the file is gone from disk) for one
 * changed file. Owns the diff fetch so the Git page and the pop-out window
 * stay in lockstep.
 */
export function GitFileView({
  wsId,
  selected,
  file,
  onModeChange,
  onSaved,
  headerActions,
}: Props) {
  const [splitMode, setSplitMode] = useState<boolean>(readSplitMode);
  useEffect(() => {
    window.localStorage.setItem(SPLIT_MODE_KEY, splitMode ? "1" : "0");
  }, [splitMode]);

  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Pull diff text whenever the selection changes. The synchronous setup
  // (reset the previous diff/error, flip loading on) runs render-phase via
  // the "store previous props" pattern so we don't fire setState
  // synchronously inside the effect body. The effect itself only kicks off
  // the async fetch, and all of *its* setStates run inside `.then` /
  // `.catch` / `.finally` callbacks. The `AbortController` cleanup is what
  // guarantees race-safety when the user rapidly moves between files.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const diffKey = `${wsId}|${selected.path}|${selected.mode}`;
  const [lastDiffKey, setLastDiffKey] = useState<string | null>(null);
  if (lastDiffKey !== diffKey) {
    setLastDiffKey(diffKey);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(true);
  }
  const { path, mode } = selected;
  useEffect(() => {
    const ac = new AbortController();
    fetch(
      `/api/workspaces/${wsId}/git/diff?path=${encodeURIComponent(path)}&mode=${mode}`,
      { signal: ac.signal },
    )
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as DiffPayload;
      })
      .then((p) => setDiff(p))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ac.signal.aborted) setDiffLoading(false);
      });
    return () => ac.abort();
  }, [wsId, path, mode]);

  // Partial-stage (`AM` / `MM` / `MD` / …) files need a Staged ↔ Unstaged
  // toggle — groupFiles routes each file to exactly one group, so without
  // it the user couldn't reach the other side. `AD` is hidden from the list
  // but kept here defensively in case something routes selection to it.
  const needsModeToggle =
    mode !== "untracked" &&
    file != null &&
    (isPartialStage(file) || (file.index === "A" && file.worktree === "D"));

  // A `D` worktree status means there's nothing on disk for the editor to
  // load (`AD` is already filtered by groupFiles) — fall back to the
  // read-only diff. Same when the file has dropped out of `git status`.
  const canEdit = file != null && file.worktree !== "D";

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 text-xs">
        <span className="truncate font-mono" title={path}>
          {path}
        </span>
        {/* The toggle still applies in editor mode — switching it re-fetches
            the diff against a different base, which changes which lines are
            highlighted as additions. */}
        {needsModeToggle ? (
          <div
            role="tablist"
            aria-label="Diff view"
            data-testid="diff-mode-toggle"
            className="flex shrink-0 overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)] text-[10px]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "staged"}
              onClick={() => onModeChange("staged")}
              className={cn(
                "px-2 py-0.5",
                mode === "staged"
                  ? "bg-[var(--accent)]/20 text-[var(--foreground)]"
                  : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
              )}
            >
              Staged · HEAD → index
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "worktree"}
              onClick={() => onModeChange("worktree")}
              className={cn(
                "border-l border-[var(--border)] px-2 py-0.5",
                mode === "worktree"
                  ? "bg-[var(--accent)]/20 text-[var(--foreground)]"
                  : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
              )}
            >
              Unstaged · index → working
            </button>
          </div>
        ) : (
          <span className="shrink-0 rounded bg-[var(--panel)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
            {mode === "staged"
              ? "Staged · HEAD → index"
              : mode === "untracked"
                ? "Untracked · /dev/null → working"
                : "Unstaged · index → working"}
          </span>
        )}
        {/* Unified / Side-by-side layout toggle. Mirrors IntelliJ's "viewer"
            picker. Split is disabled for untracked files (no old version to
            put on the left pane); pushed right so the path stays anchored. */}
        <div
          role="tablist"
          aria-label="Right-pane layout"
          data-testid="diff-layout-toggle"
          className="ml-auto flex shrink-0 overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)] text-[10px]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={!splitMode}
            onClick={() => setSplitMode(false)}
            title="Unified — single editable panel with diff highlights"
            className={cn(
              "px-2 py-0.5",
              !splitMode
                ? "bg-[var(--accent)]/20 text-[var(--foreground)]"
                : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
            )}
          >
            Unified
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={splitMode}
            onClick={() => setSplitMode(true)}
            disabled={mode === "untracked"}
            title={
              mode === "untracked"
                ? "Untracked files have no old version to compare"
                : "Side-by-side — old left, current right"
            }
            className={cn(
              "border-l border-[var(--border)] px-2 py-0.5",
              splitMode
                ? "bg-[var(--accent)]/20 text-[var(--foreground)]"
                : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
              "disabled:opacity-40 disabled:hover:bg-transparent",
            )}
          >
            Split
          </button>
        </div>
        {headerActions}
      </div>
      {/* IntelliJ-style merged view: the editor IS the diff. Added lines get
          a green stripe in the editable buffer. */}
      {canEdit ? (
        <FileEditor
          wsId={wsId}
          relPath={path}
          diff={diff?.diff ?? ""}
          // Untracked files have no "old" version for the left side; the
          // header toggle reflects that and this keeps FileEditor unaware.
          split={splitMode && mode !== "untracked"}
          mode={mode}
          onSaved={onSaved}
        />
      ) : (
        <DiffViewer
          diff={diff?.diff ?? ""}
          binary={diff?.binary ?? false}
          loading={diffLoading}
          error={diffError}
        />
      )}
    </>
  );
}
