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
} from "lucide-react";
import type { GitFileChange } from "@/lib/server/git";
import { cn } from "@/lib/utils/cn";

export type DiffSelection = {
  path: string;
  /** Which diff to show: HEAD→index, index→worktree, or /dev/null→worktree. */
  mode: "staged" | "worktree" | "untracked";
};

type Props = {
  files: GitFileChange[];
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
   * Delete a single file via the existing `discard` op. For untracked files
   * that means `rm`; for tracked files it restores the HEAD blob (i.e. drops
   * the change from the list). Callers are expected to confirm beforehand.
   */
  onDelete?: (path: string) => void;
  /** Path currently being deleted — disables that row's trash button. */
  deletingPath?: string | null;
};

export type GroupKey = "staged" | "unstaged" | "untracked";

type Grouped = {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
};

function groupFiles(files: GitFileChange[]): Grouped {
  const out: Grouped = { staged: [], unstaged: [], untracked: [] };
  for (const f of files) {
    if (f.untracked) {
      out.untracked.push(f);
      continue;
    }
    // A file can be in BOTH staged and unstaged at once (partial stage). We
    // surface it in both groups so the user can pick which diff to view.
    if (f.index !== " " && f.index !== "?") out.staged.push(f);
    if (f.worktree !== " " && f.worktree !== "?") out.unstaged.push(f);
  }
  return out;
}

export function ChangesList({
  files,
  selected,
  onSelect,
  checked,
  onToggleCheck,
  onToggleAll,
  collapsedGroups,
  onToggleGroup,
  onRefresh,
  refreshing,
  onDelete,
  deletingPath,
}: Props) {
  const groups = useMemo(() => groupFiles(files), [files]);
  const totalCheckable = files.length;
  const allChecked = totalCheckable > 0 && files.every((f) => checked.has(f.path));
  const someChecked = !allChecked && files.some((f) => checked.has(f.path));

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
        disabled={files.length === 0}
        checked={allChecked}
        ref={(el) => {
          if (el) el.indeterminate = someChecked;
        }}
        onChange={(e) => onToggleAll(e.target.checked)}
      />
      <span>Changes</span>
      <span className="ml-auto normal-case text-[var(--muted)]">
        {files.length} file{files.length === 1 ? "" : "s"}
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

  if (files.length === 0) {
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
        onDelete={onDelete}
        deletingPath={deletingPath}
        onCopyPath={copyPath}
        copiedPath={copiedPath}
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
        onDelete={onDelete}
        deletingPath={deletingPath}
        onCopyPath={copyPath}
        copiedPath={copiedPath}
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
        onDelete={onDelete}
        deletingPath={deletingPath}
        onCopyPath={copyPath}
        copiedPath={copiedPath}
      />
    </div>
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
  onDelete,
  deletingPath,
  onCopyPath,
  copiedPath,
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
  onDelete?: (path: string) => void;
  deletingPath?: string | null;
  /** Cmd/Ctrl+C handler on a focused row. */
  onCopyPath: (path: string) => void;
  /** Path of the row currently flashing "Copied!". */
  copiedPath: string | null;
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
            // restore-to-HEAD. The tooltip distinguishes so the user knows
            // what they're about to do.
            const deleteTitle =
              mode === "untracked"
                ? "Delete file from disk"
                : "Discard change (restore to HEAD)";
            return (
              <li key={`${mode}:${f.path}`}>
                <div
                  className={cn(
                    "group/row flex items-center gap-1.5 px-3 py-0.5",
                    "hover:bg-[var(--panel-2)]",
                    isSel && "bg-[var(--panel-2)]",
                  )}
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
                    title={f.path}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <StatusIcon code={statusCharForGroup(f, mode)} />
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
                  {onDelete && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(f.path);
                      }}
                      disabled={isDeleting}
                      title={deleteTitle}
                      aria-label={deleteTitle}
                      data-testid={`changes-delete-${f.path}`}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--muted)]",
                        "opacity-0 hover:bg-red-500/15 hover:text-red-300 group-hover/row:opacity-100 focus-visible:opacity-100",
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
