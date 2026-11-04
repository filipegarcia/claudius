"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import {
  Archive,
  ChevronRight,
  ClipboardCopy,
  Copy,
  ExternalLink,
  FileDiff,
  FileDown,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  History,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import type { GitFileChange } from "@/lib/server/git";
import type { DiffSelection } from "@/components/git/ChangesList";
import { revealLabel } from "@/components/files/FilePathContextMenu";
import { cn } from "@/lib/utils/cn";

/** The row that was right-clicked, plus where (viewport coords). */
export type ChangeMenuTarget = {
  file: GitFileChange;
  mode: DiffSelection["mode"];
  x: number;
  y: number;
};

/**
 * Page-owned operations the menu dispatches to. Everything that only needs
 * the workspace id + path (patches, copy path, reveal) is handled in here.
 */
export type ChangeMenuActions = {
  /** Check only this file and focus the commit message. */
  commitFile: (path: string) => void;
  /** Restore HEAD (asks first). Tracked files only. */
  rollback: (path: string) => void;
  /** Select the row so its diff shows on the right. */
  showDiff: (sel: DiffSelection) => void;
  openInWindow: (sel: DiffSelection) => void;
  /** Open the file in the Files editor. */
  jumpToSource: (path: string) => void;
  /** `git rm` / unlink (asks first). */
  remove: (path: string) => void;
  stage: (path: string) => void;
  unstage: (path: string) => void;
  /** `git stash push -- <path>` (asks first). */
  shelve: (file: GitFileChange) => void;
  /** `git log --follow` for the file, into the console. */
  showHistory: (path: string) => void;
  refresh: () => void;
  /** Surface a failure (patch fetch, clipboard, reveal) in the page banner. */
  onError: (message: string) => void;
  /** Log a quiet success line to the console (e.g. "patch copied"). */
  onInfo: (command: string, output: string) => void;
};

type MenuItem =
  | {
      kind: "item";
      label: string;
      icon?: ComponentType<{ className?: string }>;
      shortcut?: string;
      disabled?: boolean;
      title?: string;
      testId?: string;
      run: () => void;
    }
  | { kind: "separator" }
  | {
      kind: "submenu";
      label: string;
      icon?: ComponentType<{ className?: string }>;
      testId?: string;
      items: MenuItem[];
    };

const EST_WIDTH = 288;
const EST_HEIGHT = 440;

function isMac(): boolean {
  if (typeof window === "undefined") return true;
  const plat = window.claudius?.platform;
  if (plat) return plat === "darwin";
  return /Mac|iPhone|iPad/.test(typeof navigator !== "undefined" ? navigator.platform : "");
}

/**
 * IntelliJ-style right-click menu for a row in the Git changes list.
 *
 * Mirrors the Commit tool window's menu where Claudius has the matching
 * capability; IntelliJ-only concepts (changelists, UML, Local History) are
 * left out rather than shown dead. Shortcut hints are only printed for
 * chords the Git page actually handles (⌥⌘Z, F4, ⌫, ⌘C).
 *
 * Keyboard: focus lands on the first item; ↑/↓ move, → / ← open and close
 * the Git submenu, Enter activates, Esc closes and hands focus back to the
 * row. The changes list ignores arrow keys inside `role="menu"`, so they
 * don't move the file selection underneath.
 */
export function ChangeContextMenu({
  wsId,
  target,
  actions,
  onClose,
}: {
  wsId: string;
  target: ChangeMenuTarget;
  actions: ChangeMenuActions;
  onClose: () => void;
}) {
  const { file, mode } = target;
  const path = file.path;
  const sel: DiffSelection = { path, mode };
  const untracked = mode === "untracked";
  const hasStaged = !file.untracked && file.index !== " " && file.index !== "?";
  const hasUnstaged = file.untracked || (file.worktree !== " " && file.worktree !== "?");
  const onDisk = file.worktree !== "D";
  const mac = isMac();

  async function fetchPatch(): Promise<string | null> {
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/git/diff?path=${encodeURIComponent(path)}&mode=${mode}`,
      );
      const j = (await res.json().catch(() => ({}))) as {
        diff?: string;
        binary?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.binary) throw new Error(`${path} is binary — no text patch to export`);
      if (!j.diff) throw new Error(`No ${modeLabel(mode)} changes in ${path}`);
      return j.diff.endsWith("\n") ? j.diff : `${j.diff}\n`;
    } catch (err) {
      actions.onError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function createPatch() {
    const patch = await fetchPatch();
    if (patch == null) return;
    const leaf = path.replace(/\/+$/, "").split("/").pop() || "changes";
    const url = URL.createObjectURL(new Blob([patch], { type: "text/x-diff" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${leaf}.patch`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the download a tick to pick the blob up before revoking.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    actions.onInfo("create patch", `Saved ${leaf}.patch (${modeLabel(mode)} changes in ${path})`);
  }

  async function copyPatch() {
    const patch = await fetchPatch();
    if (patch == null) return;
    try {
      await navigator.clipboard.writeText(patch);
      actions.onInfo("copy patch", `Copied ${modeLabel(mode)} changes in ${path} as a patch`);
    } catch (err) {
      actions.onError(`Clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(path);
    } catch (err) {
      actions.onError(`Clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function reveal() {
    try {
      const res = await fetch(`/api/workspaces/${wsId}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relPath: path }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        actions.onError(j.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      actions.onError(err instanceof Error ? err.message : String(err));
    }
  }

  const items: MenuItem[] = [
    {
      kind: "item",
      label: "Commit File…",
      icon: GitCommitHorizontal,
      testId: "change-menu-commit",
      run: () => actions.commitFile(path),
    },
    {
      kind: "item",
      label: "Rollback…",
      icon: Undo2,
      shortcut: mac ? "⌥⌘Z" : "Ctrl+Alt+Z",
      disabled: untracked,
      title: untracked ? "Unversioned files have no HEAD version — use Delete" : undefined,
      testId: "change-menu-rollback",
      run: () => actions.rollback(path),
    },
    {
      kind: "item",
      label: "Show Diff",
      icon: FileDiff,
      testId: "change-menu-show-diff",
      run: () => actions.showDiff(sel),
    },
    {
      kind: "item",
      label: "Show Diff in New Window",
      icon: ExternalLink,
      testId: "change-menu-new-window",
      run: () => actions.openInWindow(sel),
    },
    {
      kind: "item",
      label: "Jump to Source",
      icon: Pencil,
      shortcut: "F4",
      disabled: !onDisk,
      title: onDisk ? undefined : "Deleted from disk",
      testId: "change-menu-jump",
      run: () => actions.jumpToSource(path),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Delete…",
      icon: Trash2,
      shortcut: mac ? "⌫" : "Del",
      testId: "change-menu-delete",
      run: () => actions.remove(path),
    },
    {
      kind: "item",
      label: "Add to VCS",
      icon: Plus,
      disabled: !untracked,
      title: untracked ? "git add" : "Already under version control",
      testId: "change-menu-add",
      run: () => actions.stage(path),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Create Patch from Local Changes…",
      icon: FileDown,
      testId: "change-menu-create-patch",
      run: () => void createPatch(),
    },
    {
      kind: "item",
      label: "Copy as Patch to Clipboard",
      icon: ClipboardCopy,
      testId: "change-menu-copy-patch",
      run: () => void copyPatch(),
    },
    {
      kind: "item",
      label: "Shelve Changes…",
      icon: Archive,
      title: "git stash push -- <file>",
      testId: "change-menu-shelve",
      run: () => actions.shelve(file),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Copy Path",
      icon: Copy,
      shortcut: mac ? "⌘C" : "Ctrl+C",
      testId: "change-menu-copy-path",
      run: () => void copyPath(),
    },
    {
      kind: "item",
      label: revealLabel(),
      icon: FolderOpen,
      testId: "change-menu-reveal",
      run: () => void reveal(),
    },
    {
      kind: "item",
      label: "Refresh",
      icon: RefreshCw,
      testId: "change-menu-refresh",
      run: () => actions.refresh(),
    },
    { kind: "separator" },
    {
      kind: "submenu",
      label: "Git",
      icon: GitBranch,
      testId: "change-menu-git",
      items: [
        {
          kind: "item",
          label: "Add",
          icon: Plus,
          disabled: !hasUnstaged,
          title: hasUnstaged ? "git add — stage this file" : "Nothing unstaged",
          testId: "change-menu-git-add",
          run: () => actions.stage(path),
        },
        {
          kind: "item",
          label: "Unstage",
          icon: Minus,
          disabled: !hasStaged,
          title: hasStaged ? "git restore --staged" : "Nothing staged",
          testId: "change-menu-git-unstage",
          run: () => actions.unstage(path),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "Show History",
          icon: History,
          disabled: untracked,
          title: untracked ? "Unversioned — no history yet" : "git log --follow, in the console",
          testId: "change-menu-git-history",
          run: () => actions.showHistory(path),
        },
      ],
    },
  ];

  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => clamp(target.x, target.y, EST_WIDTH, EST_HEIGHT));
  // Remember where focus was (the row) so Esc can hand it back.
  const [returnFocus] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clamp(target.x, target.y, rect.width, rect.height));
    focusableItems(el)[0]?.focus();
  }, [target.x, target.y]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
      if (returnFocus?.isConnected) returnFocus.focus();
    }
    function onBlurWindow() {
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlurWindow);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlurWindow);
    };
  }, [onClose, returnFocus]);

  function activate(item: Extract<MenuItem, { kind: "item" }>) {
    if (item.disabled) return;
    onClose();
    item.run();
  }

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={`Actions for ${path}`}
      data-testid="change-context-menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
    >
      <MenuPanel items={items} onActivate={activate} />
    </div>
  );
}

/** Enabled menu items directly inside `panel` (not inside a nested submenu). */
function focusableItems(panel: HTMLElement): HTMLButtonElement[] {
  const ownPanel = panel.matches("[data-menu-panel]")
    ? panel
    : panel.querySelector<HTMLElement>("[data-menu-panel]");
  if (!ownPanel) return [];
  return Array.from(
    ownPanel.querySelectorAll<HTMLButtonElement>("[data-menu-item]:not(:disabled)"),
  ).filter((b) => b.closest("[data-menu-panel]") === ownPanel);
}

function MenuPanel({
  items,
  onActivate,
  onCloseSubmenu,
}: {
  items: MenuItem[];
  onActivate: (item: Extract<MenuItem, { kind: "item" }>) => void;
  /** Set on a submenu: ← closes it and refocuses the parent item. */
  onCloseSubmenu?: () => void;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [focusSubOnOpen, setFocusSubOnOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const subTriggerRefs = useRef(new Map<number, HTMLButtonElement>());

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Only handle keys aimed at this panel's own items — a nested submenu
    // handles its own and stops propagation.
    const panel = panelRef.current;
    if (!panel) return;
    const list = focusableItems(panel);
    const idx = list.findIndex((b) => b === document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (list.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = idx === -1 ? (step === 1 ? 0 : list.length - 1) : (idx + step + list.length) % list.length;
      list[next].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      (e.key === "Home" ? list[0] : list[list.length - 1])?.focus();
    } else if (e.key === "ArrowLeft" && onCloseSubmenu) {
      e.preventDefault();
      e.stopPropagation();
      onCloseSubmenu();
    }
  }

  return (
    <div
      ref={panelRef}
      data-menu-panel
      onKeyDown={onKeyDown}
      className="w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-xs shadow-lg"
    >
      {items.map((item, i) => {
        if (item.kind === "separator") {
          return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-[var(--border)]" />;
        }
        const Icon = item.icon;
        if (item.kind === "submenu") {
          const open = openSub === i;
          return (
            <div
              key={item.label}
              className="relative"
              onMouseEnter={() => {
                setFocusSubOnOpen(false);
                setOpenSub(i);
              }}
              onMouseLeave={() => setOpenSub((cur) => (cur === i ? null : cur))}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                data-menu-item
                data-testid={item.testId}
                ref={(el) => {
                  if (el) subTriggerRefs.current.set(i, el);
                  else subTriggerRefs.current.delete(i);
                }}
                onMouseEnter={(e) => e.currentTarget.focus()}
                onClick={() => {
                  setFocusSubOnOpen(true);
                  setOpenSub(i);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    setFocusSubOnOpen(true);
                    setOpenSub(i);
                  }
                }}
                className={rowClass(open)}
              >
                <span className="flex w-4 shrink-0 justify-center">
                  {Icon && <Icon className="h-3.5 w-3.5 text-[var(--muted)]" />}
                </span>
                <span className="flex-1 truncate">{item.label}</span>
                <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted)]" />
              </button>
              {open && (
                <Submenu
                  items={item.items}
                  autoFocus={focusSubOnOpen}
                  onActivate={onActivate}
                  onClose={() => {
                    setOpenSub(null);
                    subTriggerRefs.current.get(i)?.focus();
                  }}
                />
              )}
            </div>
          );
        }
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            data-menu-item
            data-testid={item.testId}
            disabled={item.disabled}
            title={item.title}
            onMouseEnter={(e) => {
              setOpenSub(null);
              if (!item.disabled) e.currentTarget.focus();
            }}
            onClick={() => onActivate(item)}
            className={rowClass(false)}
          >
            <span className="flex w-4 shrink-0 justify-center">
              {Icon && <Icon className="h-3.5 w-3.5 text-[var(--muted)]" />}
            </span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span className="shrink-0 pl-4 font-mono text-[10px] text-[var(--muted)]">
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Nested panel, flipped to the left when it would run off the viewport. */
function Submenu({
  items,
  autoFocus,
  onActivate,
  onClose,
}: {
  items: MenuItem[];
  autoFocus: boolean;
  onActivate: (item: Extract<MenuItem, { kind: "item" }>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ flip: boolean; shiftUp: number }>({
    flip: false,
    shiftUp: 0,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const flip = rect.right > window.innerWidth - 8;
    const shiftUp = Math.max(0, rect.bottom - (window.innerHeight - 8));
    setPlacement({ flip, shiftUp });
    if (autoFocus) focusableItems(el)[0]?.focus();
  }, [autoFocus]);
  return (
    <div
      ref={ref}
      role="menu"
      // Flush against the parent panel — any gap would fire the trigger
      // row's mouseleave on the way across and close the submenu.
      className={cn("absolute z-10 -mt-1", placement.flip ? "right-full" : "left-full")}
      style={{ top: -placement.shiftUp }}
    >
      <MenuPanel items={items} onActivate={onActivate} onCloseSubmenu={onClose} />
    </div>
  );
}

function rowClass(active: boolean): string {
  return cn(
    "flex w-full items-center gap-2 px-2 py-1 text-left text-[var(--foreground)] outline-none",
    "focus:bg-[var(--accent)]/20 disabled:cursor-default disabled:opacity-40",
    active && "bg-[var(--accent)]/20",
  );
}

function modeLabel(mode: DiffSelection["mode"]): string {
  return mode === "staged" ? "staged" : mode === "untracked" ? "new-file" : "unstaged";
}

function clamp(x: number, y: number, width: number, height: number) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.max(8, Math.min(x, vw - width - 8));
  const top = Math.max(8, Math.min(y, vh - height - 8));
  return { left: Math.round(left), top: Math.round(top) };
}
