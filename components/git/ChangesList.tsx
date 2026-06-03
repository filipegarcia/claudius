"use client";

import { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  FileDiff,
  FilePlus,
  FileQuestion,
  FileX,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import type { GitFileChange } from "@/lib/server/git";
import { cn } from "@/lib/utils/cn";
import { FilePathContextMenu } from "@/components/files/FilePathContextMenu";

export type DiffSelection = {
  path: string;
  /** Which diff to show: HEAD→index, index→worktree, or /dev/null→worktree. */
  mode: "staged" | "worktree" | "untracked";
};

/**
 * True when a file has both staged AND unstaged changes (porcelain "XY" with
 * both slots non-blank, non-`?`). These render as a single row in the Staged
 * group with a partial-stage marker; the diff view exposes a toggle so the
 * user can flip between the HEAD→index and index→worktree views.
 *
 * Excludes the special `AD` case (staged-add + worktree-delete) — those
 * entries are dropped from the visible list entirely by `groupFiles`.
 */
export function isPartialStage(f: GitFileChange): boolean {
  if (f.untracked) return false;
  if (f.index === "A" && f.worktree === "D") return false; // hidden by groupFiles
  const hasIndex = f.index !== " " && f.index !== "?";
  const hasWorktree = f.worktree !== " " && f.worktree !== "?";
  return hasIndex && hasWorktree;
}

type Props = {
  files: GitFileChange[];
  /**
   * Workspace id — needed so the right-click "Reveal in Finder" popover
   * can `POST /api/workspaces/<id>/reveal`. Optional: when omitted the
   * context menu is suppressed (the list still renders + behaves
   * normally). Keeps the component callable from contexts that don't
   * have a workspace handle.
   */
  workspaceId?: string | null;
  selected: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
  /** IntelliJ-style commit checkboxes — selected paths will be staged-then-committed. */
  checked: Set<string>;
  onToggleCheck: (path: string, next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  collapsedGroups: Record<GroupKey, boolean>;
  onToggleGroup: (g: GroupKey) => void;
  /** Re-run `git status` against the filesystem so the list mirrors current state. */
  onRefresh?: () => void;
  /** True while a status refresh is in flight — disables the button and spins the icon. */
  refreshing?: boolean;
  /**
   * Revert a single tracked file — drops local changes, restores HEAD. Only
   * surfaced on tracked rows (Staged / Changed groups); untracked rows have
   * no HEAD blob to revert to, so the button is hidden for them.
   */
  onRevert?: (path: string) => void;
  /**
   * Delete a single file. For tracked files this is `git rm -f` (staged
   * deletion); for untracked it's a plain `fs.unlink`. Available on every
   * row. The page handler shows a confirm prompt — the list assumes the
   * action will be destructive when invoked.
   */
  onRemove?: (path: string) => void;
  /** Path currently being acted on — disables that row's action buttons. */
  deletingPath?: string | null;
};

export type GroupKey = "staged" | "unstaged" | "untracked";

type Grouped = {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
};

/**
 * Filter / group git porcelain entries for display.
 *
 * Two deliberate departures from raw porcelain output:
 *
 *   1. `AD` (staged-add + worktree-delete) entries are dropped entirely.
 *      They typically come from generated tmp files that were force-added
 *      then cleaned up off-disk, and double-listing them as "added" in
 *      Staged plus "deleted" in Changed was the bug that prompted this
 *      grouping rewrite. Hiding matches IntelliJ behaviour. Caveat: a
 *      subsequent `git commit` will still include them via the index —
 *      run `git reset HEAD <path>` (or stage + discard) to clean up.
 *
 *   2. Files with both index AND worktree changes (partial stage like
 *      `AM` / `MM` / `MD`) appear in Staged exactly once, marked partial,
 *      instead of being double-listed in Staged and Changed. The diff
 *      pane exposes a mode toggle so the user can still flip between
 *      HEAD→index and index→worktree.
 */
function groupFiles(files: GitFileChange[]): Grouped {
  const out: Grouped = { staged: [], unstaged: [], untracked: [] };
  for (const f of files) {
    if (f.untracked) {
      out.untracked.push(f);
      continue;
    }
    if (f.index === "A" && f.worktree === "D") continue; // hidden, see (1) above
    const hasIndex = f.index !== " " && f.index !== "?";
    const hasWorktree = f.worktree !== " " && f.worktree !== "?";
    if (hasIndex) out.staged.push(f);
    else if (hasWorktree) out.unstaged.push(f);
    // else: " " + " " — fully clean. Porcelain shouldn't emit these.
  }
  return out;
}

export function ChangesList({
  files,
  workspaceId,
  selected,
  onSelect,
  checked,
  onToggleCheck,
  onToggleAll,
  collapsedGroups,
  onToggleGroup,
  onRefresh,
  refreshing,
  onRevert,
  onRemove,
  deletingPath,
}: Props) {
  const groups = useMemo(() => groupFiles(files), [files]);
  /**
   * Single source of truth for "what's visible". Anything dropped by
   * `groupFiles` (today: AD entries) must not appear in the header count or
   * be reachable via Select-all, otherwise the user can commit files they
   * can't see in the list.
   */
  const visibleFiles = useMemo(
    () => [...groups.staged, ...groups.unstaged, ...groups.untracked],
    [groups],
  );
  const totalCheckable = visibleFiles.length;
  const allChecked =
    totalCheckable > 0 && visibleFiles.every((f) => checked.has(f.path));
  const someChecked = !allChecked && visibleFiles.some((f) => checked.has(f.path));

  // Right-click "Reveal in Finder" menu state. `path` is the row's
  // workspace-relative path; (x, y) are viewport coordinates fed into
  // position: fixed. Hidden when `workspaceId` isn't supplied.
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  // Transient "Copied!" affordance: which path was last copied to clipboard,
  // cleared after a short timeout so the indicator fades out automatically.
  // Lifted up to the list so only one row can be "just copied" at a time
  // even when the user rapidly tabs through rows pressing Cmd+C.
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  async function copyPath(path: string) {
    // Browser-native text selection wins: if the user dragged-selected part of
    // the path, Cmd+C should copy *that* (a substring), not the whole path.
    const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (sel && sel.toString().trim().length > 0) return;
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // Non-secure context or permission denied — silently no-op. There's no
      // graceful fallback we can offer from a keyboard handler.
      return;
    }
    setCopiedPath(path);
    window.setTimeout(() => {
      setCopiedPath((current) => (current === path ? null : current));
    }, 1200);
  }

  const header = (
    <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-[11px] uppercase tracking-wide text-[var(--muted)]">
      <input
        type="checkbox"
        aria-label="Select all changes"
        className="h-3 w-3 cursor-pointer accent-[var(--accent)]"
        disabled={visibleFiles.length === 0}
        checked={allChecked}
        ref={(el) => {
          if (el) el.indeterminate = someChecked;
        }}
        onChange={(e) => onToggleAll(e.target.checked)}
      />
      <span>Changes</span>
      <span className="ml-auto normal-case text-[var(--muted)]">
        {visibleFiles.length} file{visibleFiles.length === 1 ? "" : "s"}
      </span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh changes"
          title="Refresh — re-run git status"
          data-testid="changes-refresh"
          className="-mr-1 flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
        </button>
      )}
    </div>
  );

  if (visibleFiles.length === 0) {
    return (
      <div className="text-xs">
        {header}
        <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">
          No changes — working tree is clean.
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="text-xs">
      {header}
      <Group
        title="Staged"
        items={groups.staged}
        mode="staged"
        collapsed={collapsedGroups.staged}
        onToggle={() => onToggleGroup("staged")}
        selected={selected}
        onSelect={onSelect}
        checked={checked}
        onToggleCheck={onToggleCheck}
        onRevert={onRevert}
        onRemove={onRemove}
        deletingPath={deletingPath}
        onCopyPath={copyPath}
        copiedPath={copiedPath}
        onContextOpen={
          workspaceId
            ? (rel, x, y) => setMenu({ path: rel, x, y })
            : undefined
        }
      />
      <Group
        title="Changed"
        items={groups.unstaged}
        mode="worktree"
        collapsed={collapsedGroups.unstaged}
        onToggle={() => onToggleGroup("unstaged")}
        selected={selected}
        onSelect={onSelect}
        checked={checked}
        onToggleCheck={onToggleCheck}
        onRevert={onRevert}
        onRemove={onRemove}
        deletingPath={deletingPath}
        onCopyPath={copyPath}
        copiedPath={copiedPath}
        onContextOpen={
          workspaceId
            ? (rel, x, y) => setMenu({ path: rel, x, y })
            : undefined
        }
      />
      <Group
        title="Unversioned"
        items={groups.untracked}
        mode="untracked"
        collapsed={collapsedGroups.untracked}
        onToggle={() => onToggleGroup("untracked")}
        selected={selected}
        onSelect={onSelect}
        checked={checked}
        onToggleCheck={onToggleCheck}
        onRevert={onRevert}
        onRemove={onRemove}
        deletingPath={deletingPath}
        onCopyPath={copyPath}
        copiedPath={copiedPath}
        onContextOpen={
          workspaceId
            ? (rel, x, y) => setMenu({ path: rel, x, y })
            : undefined
        }
      />
    </div>
    {workspaceId && menu && (
      <FilePathContextMenu
        workspaceId={workspaceId}
        relPath={menu.path}
        x={menu.x}
        y={menu.y}
        onClose={() => setMenu(null)}
      />
    )}
    </>
  );
}

function Group({
  title,
  items,
  mode,
  collapsed,
  onToggle,
  selected,
  onSelect,
  checked,
  onToggleCheck,
  onRevert,
  onRemove,
  deletingPath,
  onCopyPath,
  copiedPath,
  onContextOpen,
}: {
  title: string;
  items: GitFileChange[];
  mode: DiffSelection["mode"];
  collapsed: boolean;
  onToggle: () => void;
  selected: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
  checked: Set<string>;
  onToggleCheck: (path: string, next: boolean) => void;
  /** Revert (Undo2). Only shown on tracked rows; untracked have no HEAD blob. */
  onRevert?: (path: string) => void;
  /** Delete (Trash2). Shown on every row. */
  onRemove?: (path: string) => void;
  deletingPath?: string | null;
  /** Cmd/Ctrl+C handler on a focused row. */
  onCopyPath: (path: string) => void;
  /** Path of the row currently flashing "Copied!". */
  copiedPath: string | null;
  /**
   * Right-click handler — opens the "Reveal in Finder" popover at
   * (clientX, clientY) for the given row path. Omitted when there's no
   * `workspaceId` available at the call site (e.g. a hypothetical
   * preview render); rows skip the `onContextMenu` wiring in that case
   * so the browser's native menu still works.
   */
  onContextOpen?: (relPath: string, x: number, y: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="border-b border-[var(--border)]/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-3 py-1 text-[11px] font-medium text-[var(--foreground)]/80 hover:bg-[var(--panel-2)]"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 text-[var(--muted)]" />
        ) : (
          <ChevronDown className="h-3 w-3 text-[var(--muted)]" />
        )}
        <span>{title}</span>
        <span className="ml-1 text-[var(--muted)]">{items.length}</span>
      </button>
      {!collapsed && (
        <ul>
          {items.map((f) => {
            const isSel = selected?.path === f.path && selected.mode === mode;
            const isDeleting = deletingPath === f.path;
            // Untracked rows are a real `rm` from disk — tracked rows are a
            // restore-to-HEAD ("revert"). We split the visual: trash icon +
            // red hover for the destructive untracked case, undo icon +
            // amber hover for the recoverable tracked-revert case. Reading
            // "trash" as "delete the file" was the source of confusion
            // before this split.
            // Per-row action buttons. Tracked rows get both Revert (undo
            // local changes back to HEAD, amber) and Delete (git rm,
            // red). Untracked rows get Delete only — they have no HEAD
            // blob to revert to. Reading the trash icon as "delete the
            // file" matches user intuition and is why both icons exist
            // side-by-side rather than one mode-dependent button.
            const isUntrackedRow = mode === "untracked";
            const showRevert = !isUntrackedRow && onRevert != null;
            const showRemove = onRemove != null;
            return (
              <li key={`${mode}:${f.path}`}>
                <div
                  className={cn(
                    "group/row flex items-center gap-1.5 px-3 py-0.5",
                    "hover:bg-[var(--panel-2)]",
                    isSel && "bg-[var(--panel-2)]",
                  )}
                  onContextMenu={
                    onContextOpen
                      ? (ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          // For renames we always pass `f.path` (the new
                          // name on disk) — `f.oldPath` no longer exists,
                          // so revealing it would 404 server-side.
                          onContextOpen(f.path, ev.clientX, ev.clientY);
                        }
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    aria-label={`Include ${f.path} in commit`}
                    className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--accent)]"
                    checked={checked.has(f.path)}
                    onChange={(e) => onToggleCheck(f.path, e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    type="button"
                    onClick={() => onSelect({ path: f.path, mode })}
                    onKeyDown={(e) => {
                      // Cmd/Ctrl+C on the focused row copies the file path —
                      // mirrors IntelliJ/VS Code's "select a file row, press
                      // copy". `copyPath` itself bails out if the user has a
                      // native text selection so we don't trample on it.
                      if (
                        (e.metaKey || e.ctrlKey) &&
                        !e.shiftKey &&
                        !e.altKey &&
                        e.key.toLowerCase() === "c"
                      ) {
                        onCopyPath(f.path);
                      }
                    }}
                    title={rowTitle(f, mode)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <StatusIcon code={statusCharForGroup(f, mode)} />
                    {/* Partial-stage marker: tiny porcelain code (e.g.
                        "+M") next to the icon, signalling that this row
                        also has work on the other side. Clicking still
                        opens the staged diff by default; the diff header's
                        mode toggle is how the user reaches the unstaged
                        view. */}
                    {isPartialStage(f) && (
                      <span
                        className="shrink-0 rounded bg-amber-500/15 px-1 font-mono text-[9px] uppercase tracking-wide text-amber-300"
                        title={`Also has unstaged ${worktreeChangeLabel(f.worktree)} (${f.index}${f.worktree})`}
                      >
                        +{f.worktree}
                      </span>
                    )}
                    {/* `select-text` re-enables drag-select inside the
                        button (Safari defaults to user-select:none on
                        button content), so the path is also copyable via
                        the native gesture. */}
                    <span className="truncate font-mono select-text">
                      {displayPath(f, mode)}
                    </span>
                    {copiedPath === f.path && (
                      <span
                        aria-live="polite"
                        className="ml-1 shrink-0 rounded bg-emerald-500/15 px-1 py-px text-[10px] uppercase tracking-wide text-emerald-300"
                      >
                        Copied
                      </span>
                    )}
                  </button>
                  {showRevert && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRevert?.(f.path);
                      }}
                      disabled={isDeleting}
                      title="Revert change (restore to HEAD)"
                      aria-label="Revert change (restore to HEAD)"
                      data-testid={`changes-revert-${f.path}`}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--muted)]",
                        // Amber — revert is recoverable from reflog, so
                        // it's "warning" tier, not "destructive."
                        "hover:bg-amber-500/15 hover:text-amber-300",
                        "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
                        "disabled:opacity-40",
                        isSel && "opacity-100",
                      )}
                    >
                      <Undo2 className="h-3 w-3" />
                    </button>
                  )}
                  {showRemove && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove?.(f.path);
                      }}
                      disabled={isDeleting}
                      title={
                        isUntrackedRow
                          ? "Delete file from disk"
                          : "Delete file (git rm — stages deletion)"
                      }
                      aria-label={
                        isUntrackedRow
                          ? "Delete file from disk"
                          : "Delete file (git rm)"
                      }
                      data-testid={`changes-delete-${f.path}`}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--muted)]",
                        // Red — the file is going away. Friction by design.
                        "hover:bg-red-500/15 hover:text-red-300",
                        "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
                        "disabled:opacity-40",
                        isSel && "opacity-100",
                      )}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function statusCharForGroup(f: GitFileChange, mode: DiffSelection["mode"]): string {
  if (mode === "untracked") return "?";
  return mode === "staged" ? f.index : f.worktree;
}

/**
 * Tooltip shown when hovering a row. For partial-stage entries we surface
 * the full porcelain code (e.g. "AM") so the user can see both sides without
 * relying on the marker badge alone.
 */
function rowTitle(f: GitFileChange, mode: DiffSelection["mode"]): string {
  if (mode === "untracked") return `${f.path} (untracked)`;
  if (isPartialStage(f)) {
    return `${f.path} — staged (${f.index}) + unstaged (${f.worktree})`;
  }
  return f.path;
}

/** Human label for a worktree status code. Used in partial-stage tooltips. */
function worktreeChangeLabel(code: GitFileChange["worktree"]): string {
  switch (code) {
    case "M":
      return "modification";
    case "D":
      return "deletion";
    case "T":
      return "type change";
    case "R":
      return "rename";
    case "C":
      return "copy";
    default:
      return "change";
  }
}

function displayPath(f: GitFileChange, mode: DiffSelection["mode"]): string {
  if (mode !== "untracked" && f.oldPath && (f.index === "R" || f.worktree === "R")) {
    return `${f.oldPath} → ${f.path}`;
  }
  return f.path;
}

function StatusIcon({ code }: { code: string }) {
  const cls = "h-3 w-3 shrink-0";
  switch (code) {
    case "A":
      return <FilePlus className={cn(cls, "text-emerald-400")} />;
    case "M":
    case "T":
      return <FileDiff className={cn(cls, "text-amber-400")} />;
    case "D":
      return <FileX className={cn(cls, "text-red-400")} />;
    case "R":
    case "C":
      return <ArrowRightLeft className={cn(cls, "text-sky-400")} />;
    case "?":
      return <FileQuestion className={cn(cls, "text-[var(--muted)]")} />;
    default:
      return <FileDiff className={cn(cls, "text-[var(--muted)]")} />;
  }
}
