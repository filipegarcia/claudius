"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X, XSquare } from "lucide-react";
import type { SessionInfo } from "@/lib/client/types";
import { cn } from "@/lib/utils/cn";

export type TabStatus = "running" | "idle" | "starting" | "error" | "background";

type Tab = {
  id: string;
  /** Optional human-readable label; falls back to short id. */
  label?: string;
  status: TabStatus;
};

type Props = {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAll: () => void;
  onNew: () => void;
  /** Max width applied to every tab label (px). Falls back to 180. */
  labelMaxWidth?: number;
  /**
   * Called when the user finishes dragging a tab's right-edge handle.
   * Width is already clamped. Persist server-side.
   */
  onLabelWidthChange?: (width: number) => void;
};

const TAB_LABEL_MIN = 60;
const TAB_LABEL_MAX = 600;

export function SessionTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseAll,
  onNew,
  labelMaxWidth,
  onLabelWidthChange,
}: Props) {
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const effectiveWidth = liveWidth ?? labelMaxWidth ?? 180;

  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startW: effectiveWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(
      TAB_LABEL_MAX,
      Math.max(TAB_LABEL_MIN, drag.startW + (e.clientX - drag.startX)),
    );
    setLiveWidth(next);
  }
  function onResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (liveWidth != null) {
      onLabelWidthChange?.(liveWidth);
      setLiveWidth(null);
    }
  }

  // ── Overflow handling ──────────────────────────────────────────────────
  // The tab strip must never overflow horizontally — when too many tabs are
  // open, the ones that don't fit are hidden and surfaced behind a chevron
  // popover. This is the IntelliJ pattern; horizontal scroll-bars in
  // chrome are noisy and interact badly with sibling layouts.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const widthsRef = useRef<Map<string, number>>(new Map());
  const [stripWidth, setStripWidth] = useState(0);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Measure each tab once it lands in the DOM. Skip while the tab is hidden
  // (offsetWidth would be 0) so we keep the cached natural width.
  const captureWidth = useCallback((id: string) => {
    return (el: HTMLDivElement | null) => {
      if (!el) return;
      const w = el.offsetWidth;
      if (w > 0) widthsRef.current.set(id, w);
    };
  }, []);

  // Track strip width via ResizeObserver so layout shifts (window resize,
  // right rail toggling, workspace switch) re-trigger the fit calculation.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    setStripWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(([entry]) => {
      setStripWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Compute which tabs fit. Reserved trailer = chevron (~52px) + plus (~32px)
  // + close-all (~32px) + breathing room.
  const TRAILER_PX = 120;
  useLayoutEffect(() => {
    if (stripWidth === 0 || tabs.length === 0) {
      setHiddenIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const available = Math.max(0, stripWidth - TRAILER_PX);
    const visible: string[] = [];
    let used = 0;
    for (const t of tabs) {
      const w = widthsRef.current.get(t.id) ?? 100;
      if (used + w <= available) {
        visible.push(t.id);
        used += w;
      } else {
        break;
      }
    }
    // Keep the active tab visible. If the greedy left-to-right pass didn't
    // include it, pop tail entries until it fits.
    if (activeId && !visible.includes(activeId)) {
      const activeW = widthsRef.current.get(activeId) ?? 100;
      while (visible.length > 0 && used + activeW > available) {
        const popped = visible.pop()!;
        used -= widthsRef.current.get(popped) ?? 100;
      }
      visible.push(activeId);
    }
    const visibleSet = new Set(visible);
    const hidden = new Set(tabs.filter((t) => !visibleSet.has(t.id)).map((t) => t.id));
    setHiddenIds((prev) => {
      if (prev.size !== hidden.size) return hidden;
      for (const id of prev) if (!hidden.has(id)) return hidden;
      return prev;
    });
  }, [tabs, activeId, stripWidth, effectiveWidth]);

  // Close the hidden-tabs menu on outside click / Esc.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-[var(--border)] bg-[var(--panel)]">
      <div
        ref={stripRef}
        className="flex min-w-0 flex-1 items-stretch gap-px overflow-hidden"
      >
      {tabs.map((t) => {
        const active = t.id === activeId;
        const hidden = hiddenIds.has(t.id);
        return (
          <div
            key={t.id}
            ref={captureWidth(t.id)}
            data-testid="session-tab"
            data-tab-id={t.id}
            data-tab-active={active ? "true" : "false"}
            data-tab-hidden={hidden ? "true" : "false"}
            // `display: none` keeps the element out of layout so trailing
            // tabs don't get partially clipped by overflow:hidden. The
            // measurement cache (widthsRef) preserved its natural width
            // from a prior render where it WAS visible.
            style={hidden ? { display: "none" } : undefined}
            className={cn(
              "group relative flex shrink-0 items-center gap-1.5 border-r border-[var(--border)] px-2 text-[11px]",
              active
                ? "bg-[var(--background)] text-[var(--foreground)]"
                : "bg-[var(--panel)]/40 text-[var(--muted)] hover:bg-[var(--panel-2)]/60",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(t.id); // middle-click closes
              }}
              className="flex min-w-0 items-center gap-1.5"
              title={`${t.label ?? t.id}\n${t.status}`}
            >
              <StatusDot status={t.status} />
              <span
                data-testid="session-tab-label"
                style={{ maxWidth: `${effectiveWidth}px` }}
                className="truncate font-mono"
              >
                {t.label ?? t.id.slice(0, 8)}
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              title="Close tab"
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
                !active && "opacity-0 group-hover:opacity-100",
              )}
            >
              <X className="h-3 w-3" />
            </button>
            {/*
              Drag handle on the right edge of every tab. Widths are global —
              dragging any tab's handle resizes them all in lockstep, with the
              chosen value persisted via onLabelWidthChange.
            */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize tab labels"
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              className="absolute right-0 top-0 h-full w-1 cursor-ew-resize select-none opacity-0 hover:bg-[var(--accent)]/40 hover:opacity-100 group-hover:opacity-60"
            />
          </div>
        );
      })}
      </div>
      {hiddenIds.size > 0 && (
        <div ref={menuRef} className="relative flex shrink-0 items-stretch border-l border-[var(--border)]">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title={`${hiddenIds.size} hidden tab${hiddenIds.size === 1 ? "" : "s"}`}
            data-testid="session-tabs-overflow"
            className={cn(
              "flex shrink-0 items-center gap-1 px-2 text-[11px] text-[var(--muted)] hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]",
              menuOpen && "bg-[var(--panel-2)]/60 text-[var(--foreground)]",
            )}
          >
            <ChevronDown className="h-3 w-3" />
            <span className="font-mono">{hiddenIds.size}</span>
          </button>
          {menuOpen && (
            <div
              data-testid="session-tabs-overflow-menu"
              className="absolute right-0 top-full z-30 mt-px w-72 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
            >
              <div className="border-b border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Hidden tabs ({hiddenIds.size})
              </div>
              <ul className="max-h-72 overflow-y-auto scroll-thin">
                {tabs
                  .filter((t) => hiddenIds.has(t.id))
                  .map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          if (t.id !== activeId) onSelect(t.id);
                        }}
                        data-testid="session-tabs-overflow-item"
                        data-tab-id={t.id}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-[var(--panel-2)]"
                      >
                        <StatusDot status={t.status} />
                        <span className="min-w-0 flex-1 truncate font-mono">
                          {t.label ?? t.id.slice(0, 8)}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onClose(t.id);
                          }}
                          title="Close tab"
                          className="flex h-4 w-4 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onNew}
        title="New session tab"
        className="flex w-8 shrink-0 items-center justify-center text-[var(--muted)] hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {tabs.length > 0 && (
        <button
          type="button"
          onClick={onCloseAll}
          title="Close all tabs"
          className="flex w-8 shrink-0 items-center justify-center border-l border-[var(--border)] text-[var(--muted)] hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]"
        >
          <XSquare className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: TabStatus }) {
  const tone =
    status === "running"
      ? "bg-[var(--accent)] animate-pulse"
      : status === "starting"
        ? "bg-amber-400"
        : status === "error"
          ? "bg-red-500"
          : status === "idle"
            ? "bg-emerald-400"
            : "bg-[var(--muted)]/60"; // background
  return <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)} aria-hidden />;
}

/** Helper: derive the right TabStatus for the *active* tab from useSession state. */
export function activeTabStatus(opts: {
  ready: boolean;
  pending: boolean;
  hasError: boolean;
}): TabStatus {
  if (opts.hasError) return "error";
  if (!opts.ready) return "starting";
  if (opts.pending) return "running";
  return "idle";
}

/**
 * Helper: pick a label for a session.
 *
 * Resolution order:
 *   1. `titleOverride` — used by the active tab where `useSession` has the
 *      freshest title in state (mirrors the SSE `session_title` event so
 *      the tab updates the moment a rename succeeds).
 *   2. The session's persisted `title` from the `/api/sessions` list — this
 *      is what makes *non-active* tabs show their custom names.
 *   3. The first 8 characters of the session id as the fallback.
 */
export function tabLabelFor(id: string, sessions: SessionInfo[], titleOverride?: string | null): string {
  if (titleOverride && titleOverride.trim()) return titleOverride.trim();
  const known = sessions.find((s) => s.id === id);
  if (known?.title && known.title.trim()) return known.title.trim();
  return id.slice(0, 8);
}
