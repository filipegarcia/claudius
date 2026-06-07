"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * Estimated menu size used for the initial clamp before measurement —
 * same pattern as WorkspaceContextMenu so the popover doesn't flash off
 * the right / bottom edge on the first paint.
 */
const EST_WIDTH = 200;
const EST_HEIGHT = 56;

type Props = {
  workspaceId: string;
  /**
   * Root selector — `primary` for the workspace cwd, or `extra:<n>` for
   * additionalDirectories. Optional; missing defaults to `primary` to keep
   * older callers working.
   */
  root?: string;
  /** Path relative to the chosen root of the row that was right-clicked. */
  relPath: string;
  /** Viewport coordinates of the click — fed straight into `position: fixed`. */
  x: number;
  y: number;
  /** Close the menu (no side effects). */
  onClose: () => void;
  /** Called with an error message string when the reveal API fails. Optional. */
  onError?: (message: string) => void;
};

/**
 * Right-click popover for a file/folder row in the Files tree or Git
 * changes list. Single action: "Reveal in Finder" (label adapts per OS).
 *
 * Why a server endpoint — Claudius is local-first; the embedded Next
 * server runs on the user's machine in both `bun run dev` (browser tab)
 * and packaged Electron, so a `POST /api/workspaces/[id]/reveal` reaches
 * the same Finder either way. No Electron-only bridge needed.
 *
 * Positioning + dismissal mirror WorkspaceContextMenu (the only existing
 * popover surface in the codebase): position: fixed at the click point,
 * clamped to the viewport, closes on outside click / Escape / a second
 * right-click.
 */
export function FilePathContextMenu({
  workspaceId,
  root,
  relPath,
  x,
  y,
  onClose,
  onError,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => clamp(x, y, EST_WIDTH, EST_HEIGHT));
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clamp(x, y, rect.width, rect.height));
  }, [x, y]);

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
      // surface the native menu under our panel.
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

  async function reveal() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relPath, ...(root ? { root } : {}) }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        onError?.(j.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      onClose();
    }
  }

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={`Actions for ${relPath}`}
      data-testid="file-path-context-menu"
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
      className="w-56 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-xs shadow-lg"
    >
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => void reveal()}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left",
          "hover:bg-[var(--panel-2)] disabled:opacity-50",
        )}
      >
        <FolderOpen className="h-3 w-3 shrink-0 text-[var(--muted)]" />
        <span className="text-[var(--foreground)]">{revealLabel()}</span>
      </button>
    </div>
  );
}

/**
 * Platform-aware label. Reads `window.claudius.platform` when the Electron
 * bridge is present (most accurate — that's the OS the spawn will run on),
 * else sniffs `navigator.platform` to keep the browser dev build honest.
 * The fallback is the macOS label since Claudius is mac-first.
 */
function revealLabel(): string {
  if (typeof window === "undefined") return "Reveal in Finder";
  const plat = window.claudius?.platform;
  if (plat === "win32") return "Show in Explorer";
  if (plat === "linux") return "Open Containing Folder";
  if (plat === "darwin") return "Reveal in Finder";
  // Browser build — sniff. Anything non-mac falls through to the generic
  // label rather than guessing between Explorer and Nautilus.
  const ua = typeof navigator !== "undefined" ? navigator.platform : "";
  if (/Mac|iPhone|iPad/.test(ua)) return "Reveal in Finder";
  if (/Win/.test(ua)) return "Show in Explorer";
  return "Open Containing Folder";
}

/**
 * Push the menu inside the viewport given a click point and the menu's
 * known (or estimated) size. 8px gutter keeps it from touching the edge.
 */
function clamp(x: number, y: number, width: number, height: number) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.max(8, Math.min(x, vw - width - 8));
  const top = Math.max(8, Math.min(y, vh - height - 8));
  return { left: Math.round(left), top: Math.round(top) };
}
