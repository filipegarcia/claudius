"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pencil, Settings as SettingsIcon, Trash2, Type } from "lucide-react";
import type { Workspace } from "@/lib/server/workspaces-store";
import { cn } from "@/lib/utils/cn";

/**
 * 8-color palette — mirrors the swatches in WorkspaceForm.tsx and
 * app/workspace/page.tsx so the quick "change color" action stays
 * visually consistent with the full settings page.
 */
const PRESET_COLORS = [
  "#d97757",
  "#5588dd",
  "#9d6cdd",
  "#2e9d8f",
  "#dd8e44",
  "#cc5577",
  "#33aabb",
  "#7d8a4c",
];

/** Estimated menu size used for the initial clamp before measurement. */
const EST_WIDTH = 240;
const EST_HEIGHT = 220;

type Props = {
  workspace: Workspace;
  /** Viewport coordinates of the click — fed straight into `position: fixed`. */
  x: number;
  y: number;
  /** Whether this tile is the currently-active workspace. Influences delete UX. */
  isActive: boolean;
  /** Close the menu (no side effects). */
  onClose: () => void;
  /** Rename: prompts inline, updates name only. */
  onRename: (id: string, name: string) => Promise<void>;
  /** Apply a new letter-icon color. Replaces the icon kind if it was an image. */
  onChangeColor: (id: string, color: string) => Promise<void>;
  /** Flip an image-icon workspace back to a letter-icon. */
  onSwitchToLetter: (id: string) => Promise<void>;
  /** Open the full settings page for this workspace. */
  onOpenSettings: (id: string) => void;
  /** Delete the workspace. Confirmation lives in the caller. */
  onDelete: (id: string) => Promise<void>;
};

/**
 * Right-click context menu for a workspace tile in the left rail.
 *
 * The trigger logic lives in `WorkspaceSwitcher` — this component is just the
 * popover surface, positioned with `position: fixed` at the click point and
 * clamped to the viewport so it never spills off-screen. Close-on-outside-click
 * and Escape-to-close mirror the SessionNotifyMenu pattern, the only existing
 * popover in the codebase.
 */
export function WorkspaceContextMenu({
  workspace,
  x,
  y,
  isActive,
  onClose,
  onRename,
  onChangeColor,
  onSwitchToLetter,
  onOpenSettings,
  onDelete,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Start with an estimated-size clamp so the menu doesn't flash off-screen on
  // the right or bottom edges. Measured pass runs in useLayoutEffect once the
  // panel is in the DOM.
  const [pos, setPos] = useState(() => clamp(x, y, EST_WIDTH, EST_HEIGHT));

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clamp(x, y, rect.width, rect.height));
  }, [x, y]);

  // Outside click / Escape close. `mousedown` (rather than `click`) makes the
  // dismiss feel snappier and matches SessionNotifyMenu. We don't intercept
  // the click that opens the menu itself — the trigger ran on `contextmenu`,
  // which has already finished bubbling by the time this effect mounts.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onContext(e: MouseEvent) {
      // A second right-click while open should reposition / close, not
      // surface the native menu underneath our panel.
      e.preventDefault();
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("contextmenu", onContext);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("contextmenu", onContext);
    };
  }, [onClose]);

  // Narrow on the discriminant directly so the type guard reaches `.color`.
  // Aliasing to a const (`isLetter`) loses the narrow because the compiler
  // can't tell the underlying field hasn't been mutated between checks.
  const isLetter = workspace.icon.kind === "letter";
  const currentColor = workspace.icon.kind === "letter" ? workspace.icon.color : null;

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={`${workspace.name} options`}
      data-testid={`workspace-context-menu-${workspace.id}`}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
      className="w-60 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-xs shadow-lg"
    >
      <div className="border-b border-[var(--border)] px-3 pb-2 pt-1.5">
        <div className="truncate text-[12px] font-medium text-[var(--foreground)]">
          {workspace.name}
        </div>
        <div className="truncate font-mono text-[10px] text-[var(--muted)]">
          {workspace.rootPath}
        </div>
      </div>

      <MenuButton
        icon={<Pencil className="h-3 w-3" />}
        label="Rename…"
        onClick={() => {
          const next = window.prompt("Rename workspace", workspace.name);
          if (next == null) return;
          const trimmed = next.trim();
          if (!trimmed || trimmed === workspace.name) {
            onClose();
            return;
          }
          void onRename(workspace.id, trimmed).finally(onClose);
        }}
      />

      <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        Color
      </div>
      <div className="flex gap-1.5 px-3 pb-2">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="menuitem"
            aria-label={`Use color ${c}`}
            title={c}
            onClick={() => {
              void onChangeColor(workspace.id, c).finally(onClose);
            }}
            className={cn(
              "h-5 w-5 rounded-full border border-[var(--border)] transition",
              c === currentColor
                ? "ring-2 ring-[var(--foreground)] ring-offset-2 ring-offset-[var(--panel)]"
                : "hover:scale-110",
            )}
            style={{ background: c }}
          />
        ))}
      </div>

      {!isLetter && (
        <MenuButton
          icon={<Type className="h-3 w-3" />}
          label="Use letter icon"
          onClick={() => {
            void onSwitchToLetter(workspace.id).finally(onClose);
          }}
        />
      )}

      <MenuButton
        icon={<SettingsIcon className="h-3 w-3" />}
        label="Open settings…"
        sublabel={isLetter ? "Edit name, root, image icon…" : "Edit name, root, icon…"}
        onClick={() => {
          onOpenSettings(workspace.id);
          onClose();
        }}
      />

      <div className="my-1 h-px bg-[var(--border)]" />

      <MenuButton
        icon={<Trash2 className="h-3 w-3" />}
        label="Delete workspace"
        sublabel={
          isActive
            ? "Active — Claudius will switch to another workspace"
            : "Sessions and files on disk are untouched"
        }
        danger
        onClick={() => {
          if (
            !window.confirm(
              `Delete workspace "${workspace.name}"? Sessions and files on disk are unaffected.`,
            )
          ) {
            onClose();
            return;
          }
          void onDelete(workspace.id).finally(onClose);
        }}
      />
    </div>
  );
}

function MenuButton({
  icon,
  label,
  sublabel,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--panel-2)]",
        danger && "text-rose-300 hover:bg-rose-500/10",
      )}
    >
      <span className={cn("mt-0.5 shrink-0", danger ? "text-rose-300" : "text-[var(--muted)]")}>
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[var(--foreground)]" style={danger ? { color: "inherit" } : undefined}>
          {label}
        </span>
        {sublabel && (
          <span className="truncate text-[10px] text-[var(--muted)]">{sublabel}</span>
        )}
      </span>
    </button>
  );
}

/**
 * Push the menu inside the viewport given a click point and the menu's known
 * (or estimated) size. 8px gutter keeps it from touching the edge.
 */
function clamp(x: number, y: number, width: number, height: number) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.max(8, Math.min(x, vw - width - 8));
  const top = Math.max(8, Math.min(y, vh - height - 8));
  // Lock to integer pixels so the panel doesn't blur during the post-mount
  // re-clamp.
  return { left: Math.round(left), top: Math.round(top) };
}

/** Build a letter-icon from a workspace whose current icon may be an image. */
export function letterFallback(workspace: Workspace): { letter: string } {
  if (workspace.icon.kind === "letter") return { letter: workspace.icon.letter };
  return {
    letter: (workspace.name.match(/\S/)?.[0] ?? "?").toUpperCase(),
  };
}
