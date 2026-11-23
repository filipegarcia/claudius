"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  FileDiff,
  FilePlus,
  FileQuestion,
  FileX,
  Folder,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import type { GitFileChange } from "@/lib/server/git";
import { cn } from "@/lib/utils/cn";
import { FilePathContextMenu } from "@/components/files/FilePathContextMenu";
import type { ChangeMenuTarget } from "@/components/git/ChangeContextMenu";
import { isLetterKey } from "@/lib/client/key-match";

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

/**
 * The group (and therefore default diff mode) a file lands in — mirrors
 * `groupFiles`. Exported so the pop-out file window can fall back to a
 * sensible mode when the one in its URL no longer applies (e.g. the file
 * was unstaged in the main window after the pop-out opened).
 */
export function defaultDiffMode(f: GitFileChange): DiffSelection["mode"] {
  if (f.untracked) return "untracked";
  return f.index !== " " && f.index !== "?" ? "staged" : "worktree";
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
  /**
   * IntelliJ "Group By → Directory": nest each group's rows under
   * collapsible folder nodes (single-child chains compacted, e.g.
   * `api/src/Migrations`). Off = the flat full-path list. The toggle lives
   * in the header's View Options (eye) menu; omit the change handler to
   * hide that menu.
   */
  groupByDirectory?: boolean;
  onGroupByDirectoryChange?: (next: boolean) => void;
  /**
   * Open a file in its own window. Wired to row double-click and a hover
   * button; omitted = neither is offered.
   */
  onOpenInWindow?: (sel: DiffSelection) => void;
  /**
   * Right-click on a file row. When set, the row is selected and the caller
   * renders its own menu (the Git page's IntelliJ-style ChangeContextMenu);
   * when omitted, right-click falls back to the bare "Reveal in Finder"
   * popover (needs `workspaceId`).
   */
  onRowContextMenu?: (target: ChangeMenuTarget) => void;
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

/** Render order of the groups, with each group's diff mode and title. */
const GROUPS: ReadonlyArray<{ key: GroupKey; mode: DiffSelection["mode"]; title: string }> = [
  { key: "staged", mode: "staged", title: "Staged" },
  { key: "unstaged", mode: "worktree", title: "Changed" },
  { key: "untracked", mode: "untracked", title: "Unversioned" },
];

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

/** One folder node of the Group-By-Directory tree. */
export type DirNode = {
  /** Display label — may span several segments after compaction (`a/b/c`). */
  name: string;
  /** Full repo-relative directory path ("" for a group's root). */
  path: string;
  dirs: DirNode[];
  files: GitFileChange[];
  /** Every file path at or below this node — drives the tri-state checkbox. */
  filePaths: string[];
};

type MutableDir = {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: GitFileChange[];
};

/**
 * Split a repo-relative path into its directory segments and leaf name.
 * Tolerates a trailing slash (porcelain reports an untracked nested repo
 * as `dir/` even with `-uall`) by keeping the slash on the leaf label.
 */
function splitPath(p: string): { dirs: string[]; leaf: string } {
  const trailing = p.endsWith("/");
  const segs = p.replace(/\/+$/, "").split("/");
  const leaf = segs.pop() ?? p;
  return { dirs: segs, leaf: trailing ? `${leaf}/` : leaf };
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Build IntelliJ's Group-By-Directory tree for one group's files. Folders
 * sort before files at every level (both alphabetical), and single-child
 * folder chains with no files of their own collapse into one node
 * (`api` → `src` → `Migrations` becomes `api/src/Migrations`) so deep
 * paths don't cost a click per segment.
 */
export function buildDirTree(items: GitFileChange[]): DirNode {
  const root: MutableDir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of items) {
    let node = root;
    for (const seg of splitPath(f.path).dirs) {
      let child = node.dirs.get(seg);
      if (!child) {
        child = {
          name: seg,
          path: node.path ? `${node.path}/${seg}` : seg,
          dirs: new Map(),
          files: [],
        };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return finalizeDir(root);
}

function finalizeDir(m: MutableDir): DirNode {
  const dirs = [...m.dirs.values()]
    .map((d) => compactDir(finalizeDir(d)))
    .sort((a, b) => byName.compare(a.name, b.name));
  const files = [...m.files].sort((a, b) =>
    byName.compare(splitPath(a.path).leaf, splitPath(b.path).leaf),
  );
  return {
    name: m.name,
    path: m.path,
    dirs,
    files,
    filePaths: [...dirs.flatMap((d) => d.filePaths), ...files.map((f) => f.path)],
  };
}

/** Merge a file-less folder into its only subfolder. Children are already compact. */
function compactDir(n: DirNode): DirNode {
  if (n.files.length > 0 || n.dirs.length !== 1) return n;
  const only = n.dirs[0];
  return { ...only, name: `${n.name}/${only.name}` };
}

/** Stable key for a folder's collapsed state — folders repeat across groups. */
function dirKey(mode: DiffSelection["mode"], path: string): string {
  return `${mode}:${path}`;
}

/** Key carried on each file row's `data-change-row` — used to move focus. */
function rowKey(sel: DiffSelection): string {
  return `${sel.mode}:${sel.path}`;
}

/**
 * Should ↑/↓ be left alone for this keydown target? True for text fields
 * (commit message, console prompt, the editor textarea) and for widgets
 * that own their arrow keys (menus, listboxes, dialogs).
 */
function arrowKeysBelongToTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT" && (target as HTMLInputElement).type !== "checkbox") return true;
  return (
    target.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="combobox"]') != null
  );
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
  groupByDirectory = false,
  onGroupByDirectoryChange,
  onOpenInWindow,
  onRowContextMenu,
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

  const trees = useMemo(
    () =>
      groupByDirectory
        ? {
            staged: buildDirTree(groups.staged),
            unstaged: buildDirTree(groups.unstaged),
            untracked: buildDirTree(groups.untracked),
          }
        : null,
    [groups, groupByDirectory],
  );

  // Collapsed folder nodes, keyed by `dirKey`. Folders default to expanded;
  // the set only remembers the ones the user closed. Kept local — it's view
  // state that doesn't need to outlive the page.
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const toggleDir = (key: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /**
   * File rows in on-screen order, skipping collapsed groups/folders — what
   * ↑/↓ steps through. Mirrors the render walk below (folders before files).
   */
  const navOrder = useMemo(() => {
    const out: DiffSelection[] = [];
    const walk = (node: DirNode, mode: DiffSelection["mode"]) => {
      for (const d of node.dirs) {
        if (!collapsedDirs.has(dirKey(mode, d.path))) walk(d, mode);
      }
      for (const f of node.files) out.push({ path: f.path, mode });
    };
    for (const g of GROUPS) {
      if (collapsedGroups[g.key]) continue;
      if (trees) walk(trees[g.key], g.mode);
      else for (const f of groups[g.key]) out.push({ path: f.path, mode: g.mode });
    }
    return out;
  }, [groups, trees, collapsedGroups, collapsedDirs]);

  const listRef = useRef<HTMLDivElement>(null);

  // ↑/↓ moves the selection between files (and so the diff on the right),
  // IntelliJ-style. Listens on window so it keeps working after a status
  // refresh or a click on the diff header steals focus, but only engages
  // when focus is in the list or — with a file already selected — anywhere
  // that doesn't use arrow keys itself (see arrowKeysBelongToTarget).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (arrowKeysBelongToTarget(e.target)) return;
      const inList = e.target instanceof Node && listRef.current?.contains(e.target);
      if (!inList && !selected) return;
      if (navOrder.length === 0) return;
      e.preventDefault();
      const idx = selected
        ? navOrder.findIndex((s) => s.path === selected.path && s.mode === selected.mode)
        : -1;
      const down = e.key === "ArrowDown";
      // Selection not visible (nothing picked yet, or its folder is
      // collapsed) → jump to the first / last visible row.
      const nextIdx =
        idx === -1
          ? down
            ? 0
            : navOrder.length - 1
          : Math.min(navOrder.length - 1, Math.max(0, idx + (down ? 1 : -1)));
      const next = navOrder[nextIdx];
      if (idx !== nextIdx) onSelect(next);
      // Move focus with the selection so Cmd+C (copy path) and the
      // Delete shortcut act on the row the user is looking at.
      const key = rowKey(next);
      const rowEl = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>("[data-change-row]") ?? [],
      ).find((el) => el.dataset.changeRow === key);
      if (rowEl) {
        rowEl.focus({ preventScroll: true });
        rowEl.scrollIntoView({ block: "nearest" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOrder, selected, onSelect]);

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

  const ctx: RowCtx = {
    selected,
    onSelect,
    checked,
    onToggleCheck,
    onRevert,
    onRemove,
    deletingPath,
    onCopyPath: copyPath,
    copiedPath,
    onContextOpen: onRowContextMenu
      ? (file, mode, x, y) => {
          onSelect({ path: file.path, mode });
          onRowContextMenu({ file, mode, x, y });
        }
      : workspaceId
        ? (file, _mode, x, y) => setMenu({ path: file.path, x, y })
        : undefined,
    onOpenInWindow,
    collapsedDirs,
    onToggleDir: toggleDir,
  };

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
      {onGroupByDirectoryChange && (
        <ViewOptionsMenu
          groupByDirectory={groupByDirectory}
          onGroupByDirectoryChange={onGroupByDirectoryChange}
        />
      )}
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
    <div ref={listRef} className="text-xs" data-testid="changes-list">
      {header}
      {GROUPS.map((g) => (
        <Group
          key={g.key}
          title={g.title}
          items={groups[g.key]}
          tree={trees?.[g.key] ?? null}
          mode={g.mode}
          collapsed={collapsedGroups[g.key]}
          onToggle={() => onToggleGroup(g.key)}
          ctx={ctx}
        />
      ))}
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

/**
 * IntelliJ's View Options (eye) popover. Only "Group By → Directory" today;
 * the section header leaves room for more groupings later.
 */
function ViewOptionsMenu({
  groupByDirectory,
  onGroupByDirectoryChange,
}: {
  groupByDirectory: boolean;
  onGroupByDirectoryChange: (next: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (e.target instanceof Node && wrapRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative normal-case tracking-normal">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="View options"
        data-testid="changes-view-options"
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
          open && "bg-[var(--panel-2)] text-[var(--foreground)]",
        )}
      >
        <Eye className="h-3 w-3" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="View options"
          className="absolute right-0 top-full z-30 mt-1 min-w-40 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 text-xs shadow-lg"
        >
          <div className="px-2 pb-1 pt-0.5 text-[11px] text-[var(--muted)]">Group By</div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={groupByDirectory}
            data-testid="changes-group-by-directory"
            onClick={() => {
              onGroupByDirectoryChange(!groupByDirectory);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[var(--foreground)] hover:bg-[var(--panel-2)]"
          >
            <Check
              className={cn("h-3 w-3 shrink-0", !groupByDirectory && "invisible")}
              aria-hidden
            />
            Directory
          </button>
        </div>
      )}
    </div>
  );
}

/** Everything a row needs from the list, bundled to keep the tree props sane. */
type RowCtx = {
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
   * Right-click handler — opens a menu at (clientX, clientY) for the row.
   * Omitted when there's neither a caller menu nor a `workspaceId`; rows
   * skip the `onContextMenu` wiring then so the native menu still works.
   */
  onContextOpen?: (
    file: GitFileChange,
    mode: DiffSelection["mode"],
    x: number,
    y: number,
  ) => void;
  onOpenInWindow?: (sel: DiffSelection) => void;
  collapsedDirs: Set<string>;
  onToggleDir: (key: string) => void;
};

// Tree indentation: rows start at the group header's 12px inset; each level
// adds the width of a folder chevron + gap so a file's checkbox lines up
// under its parent folder's checkbox.
const ROW_INSET_PX = 12;
const INDENT_STEP_PX = 18;

function Group({
  title,
  items,
  tree,
  mode,
  collapsed,
  onToggle,
  ctx,
}: {
  title: string;
  items: GitFileChange[];
  /** Folder tree when grouping by directory; null = flat list. */
  tree: DirNode | null;
  mode: DiffSelection["mode"];
  collapsed: boolean;
  onToggle: () => void;
  ctx: RowCtx;
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
          {tree ? (
            <DirChildren node={tree} mode={mode} depth={0} ctx={ctx} />
          ) : (
            items.map((f) => (
              <FileRow key={`${mode}:${f.path}`} f={f} mode={mode} depth={0} grouped={false} ctx={ctx} />
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** A folder's contents: subfolders first, then its own files. */
function DirChildren({
  node,
  mode,
  depth,
  ctx,
}: {
  node: DirNode;
  mode: DiffSelection["mode"];
  depth: number;
  ctx: RowCtx;
}) {
  return (
    <>
      {node.dirs.map((d) => (
        <DirRow key={`${mode}:dir:${d.path}`} node={d} mode={mode} depth={depth} ctx={ctx} />
      ))}
      {node.files.map((f) => (
        <FileRow key={`${mode}:${f.path}`} f={f} mode={mode} depth={depth} grouped ctx={ctx} />
      ))}
    </>
  );
}

function DirRow({
  node,
  mode,
  depth,
  ctx,
}: {
  node: DirNode;
  mode: DiffSelection["mode"];
  depth: number;
  ctx: RowCtx;
}) {
  const key = dirKey(mode, node.path);
  const collapsed = ctx.collapsedDirs.has(key);
  const nChecked = node.filePaths.filter((p) => ctx.checked.has(p)).length;
  const allChecked = nChecked === node.filePaths.length;
  const toggle = () => ctx.onToggleDir(key);
  return (
    <li>
      <div
        className="flex items-center gap-1.5 py-0.5 pr-3 hover:bg-[var(--panel-2)]"
        style={{ paddingLeft: ROW_INSET_PX + depth * INDENT_STEP_PX }}
      >
        <button
          type="button"
          onClick={toggle}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.path}`}
          aria-expanded={!collapsed}
          className="flex h-3 w-3 shrink-0 items-center justify-center text-[var(--muted)]"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        <input
          type="checkbox"
          aria-label={`Include all files in ${node.path} in commit`}
          className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--accent)]"
          checked={allChecked}
          ref={(el) => {
            if (el) el.indeterminate = nChecked > 0 && !allChecked;
          }}
          // Each call is a functional setState upstream, so React batches
          // the whole folder into one render.
          onChange={(e) => {
            for (const p of node.filePaths) ctx.onToggleCheck(p, e.target.checked);
          }}
        />
        <button
          type="button"
          onClick={toggle}
          title={node.path}
          data-testid={`changes-dir-${mode}-${node.path}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <Folder className="h-3 w-3 shrink-0 text-[var(--muted)]" />
          <span className="truncate font-mono">{node.name}</span>
          <span className="shrink-0 text-[var(--muted)]">{node.filePaths.length}</span>
        </button>
      </div>
      {!collapsed && (
        <ul>
          <DirChildren node={node} mode={mode} depth={depth + 1} ctx={ctx} />
        </ul>
      )}
    </li>
  );
}

function FileRow({
  f,
  mode,
  depth,
  grouped,
  ctx,
}: {
  f: GitFileChange;
  mode: DiffSelection["mode"];
  depth: number;
  /** Inside a folder node → show the file name only; flat → full path. */
  grouped: boolean;
  ctx: RowCtx;
}) {
  const {
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
    onOpenInWindow,
  } = ctx;
  const isSel = selected?.path === f.path && selected.mode === mode;
  const isDeleting = deletingPath === f.path;
  // Per-row action buttons. Tracked rows get both Revert (undo local
  // changes back to HEAD, amber) and Delete (git rm, red). Untracked rows
  // get Delete only — they have no HEAD blob to revert to. Reading the
  // trash icon as "delete the file" matches user intuition and is why both
  // icons exist side-by-side rather than one mode-dependent button.
  const isUntrackedRow = mode === "untracked";
  const showRevert = !isUntrackedRow && onRevert != null;
  const showRemove = onRemove != null;
  const hoverAction = cn(
    "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--muted)]",
    "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
    "disabled:opacity-40",
    isSel && "opacity-100",
  );
  return (
    <li>
      <div
        className={cn(
          "group/row flex items-center gap-1.5 py-0.5 pr-3",
          "hover:bg-[var(--panel-2)]",
          isSel && "bg-[var(--panel-2)]",
        )}
        style={{ paddingLeft: ROW_INSET_PX + depth * INDENT_STEP_PX }}
        onContextMenu={
          onContextOpen
            ? (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                // For renames the menu acts on `f.path` (the new name on
                // disk) — `f.oldPath` no longer exists, so revealing it
                // would 404 server-side.
                onContextOpen(f, mode, ev.clientX, ev.clientY);
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
          data-change-row={rowKey({ path: f.path, mode })}
          onClick={() => onSelect({ path: f.path, mode })}
          // IntelliJ: single click previews, double click opens the file
          // in its own window.
          onDoubleClick={onOpenInWindow ? () => onOpenInWindow({ path: f.path, mode }) : undefined}
          onKeyDown={(e) => {
            // Cmd/Ctrl+C on the focused row copies the file path — mirrors
            // IntelliJ/VS Code's "select a file row, press copy".
            // `copyPath` itself bails out if the user has a native text
            // selection so we don't trample on it.
            if (
              (e.metaKey || e.ctrlKey) &&
              !e.shiftKey &&
              !e.altKey &&
              isLetterKey(e, "c")
            ) {
              onCopyPath(f.path);
            }
          }}
          title={rowTitle(f, mode, onOpenInWindow != null)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <StatusIcon code={statusCharForGroup(f, mode)} />
          {/* Partial-stage marker: tiny porcelain code (e.g. "+M") next to
              the icon, signalling that this row also has work on the other
              side. Clicking still opens the staged diff by default; the diff
              header's mode toggle is how the user reaches the unstaged view. */}
          {isPartialStage(f) && (
            <span
              className="shrink-0 rounded bg-amber-500/15 px-1 font-mono text-[9px] uppercase tracking-wide text-amber-300"
              title={`Also has unstaged ${worktreeChangeLabel(f.worktree)} (${f.index}${f.worktree})`}
            >
              +{f.worktree}
            </span>
          )}
          {/* `select-text` re-enables drag-select inside the button (Safari
              defaults to user-select:none on button content), so the path is
              also copyable via the native gesture. */}
          <span className="truncate font-mono select-text">
            {displayPath(f, mode, grouped)}
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
        {onOpenInWindow && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenInWindow({ path: f.path, mode });
            }}
            title="Open in new window"
            aria-label={`Open ${f.path} in new window`}
            data-testid={`changes-open-window-${f.path}`}
            className={cn(hoverAction, "hover:bg-[var(--panel)] hover:text-[var(--foreground)]")}
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
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
            // Amber — revert is recoverable from reflog, so it's "warning"
            // tier, not "destructive."
            className={cn(hoverAction, "hover:bg-amber-500/15 hover:text-amber-300")}
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
            aria-label={isUntrackedRow ? "Delete file from disk" : "Delete file (git rm)"}
            data-testid={`changes-delete-${f.path}`}
            // Red — the file is going away. Friction by design.
            className={cn(hoverAction, "hover:bg-red-500/15 hover:text-red-300")}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </li>
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
function rowTitle(f: GitFileChange, mode: DiffSelection["mode"], canOpen: boolean): string {
  let title = f.path;
  if (mode === "untracked") title = `${f.path} (untracked)`;
  else if (isPartialStage(f)) {
    title = `${f.path} — staged (${f.index}) + unstaged (${f.worktree})`;
  }
  return canOpen ? `${title}\nDouble-click to open in a new window` : title;
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

/**
 * Row label. Flat list → the full path; inside a folder node → just the
 * file name (the folder row already shows the directory). Renames show
 * `old → new`, keeping the old path's directory only when it moved.
 */
function displayPath(f: GitFileChange, mode: DiffSelection["mode"], grouped: boolean): string {
  const isRename =
    mode !== "untracked" &&
    f.oldPath &&
    (f.index === "R" || f.index === "C" || f.worktree === "R" || f.worktree === "C");
  if (!grouped) return isRename ? `${f.oldPath} → ${f.path}` : f.path;
  const cur = splitPath(f.path);
  if (!isRename || !f.oldPath) return cur.leaf;
  const old = splitPath(f.oldPath);
  const sameDir = old.dirs.join("/") === cur.dirs.join("/");
  return `${sameDir ? old.leaf : f.oldPath} → ${cur.leaf}`;
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
