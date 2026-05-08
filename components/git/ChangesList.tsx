"use client";

import { useMemo } from "react";
import { ChevronDown, ChevronRight, FileDiff, FilePlus, FileX, FileQuestion, ArrowRightLeft } from "lucide-react";
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
}: Props) {
  const groups = useMemo(() => groupFiles(files), [files]);
  const totalCheckable = files.length;
  const allChecked = totalCheckable > 0 && files.every((f) => checked.has(f.path));
  const someChecked = !allChecked && files.some((f) => checked.has(f.path));

  if (files.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">
        No changes — working tree is clean.
      </div>
    );
  }

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-[11px] uppercase tracking-wide text-[var(--muted)]">
        <input
          type="checkbox"
          aria-label="Select all changes"
          className="h-3 w-3 cursor-pointer accent-[var(--accent)]"
          checked={allChecked}
          ref={(el) => {
            if (el) el.indeterminate = someChecked;
          }}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
        <span>Changes</span>
        <span className="ml-auto normal-case text-[var(--muted)]">{files.length} file{files.length === 1 ? "" : "s"}</span>
      </div>
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
            return (
              <li key={`${mode}:${f.path}`}>
                <div
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-0.5",
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
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <StatusIcon code={statusCharForGroup(f, mode)} />
                    <span className="truncate font-mono">{displayPath(f, mode)}</span>
                  </button>
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
