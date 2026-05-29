"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X, XSquare } from "lucide-react";
import type { SessionInfo } from "@/lib/client/types";
import {
  formatBinding,
  isTypingTarget,
  matchBinding,
  useShortcut,
} from "@/lib/client/shortcuts";
import { useElectronAction } from "@/lib/client/useElectron";
import { cn } from "@/lib/utils/cn";

export type TabStatus = "running" | "idle" | "starting" | "error" | "background";

type Tab = {
  id: string;
  /** Optional human-readable label; falls back to short id. */
  label?: string;
  status: TabStatus;
  /**
   * Unread notification count for this session — when > 0 the tab renders
   * a small numeric badge after the label so the user can spot which
   * background session has a permission request / ask-user-question waiting
   * without expanding the notifications drawer.
   */
  unread?: number;
};

type Props = {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAll: () => void;
  onNew: () => void;
  /**
   * Optional handler for "reopen most recently closed tab" (Cmd+Shift+T).
   * When omitted (or it returns false), the chord is a no-op. Phase 3 of
   * docs/electron-conversion/PLAN.md.
   */
  onReopen?: () => void;
  /** Max width applied to every tab label (px). Falls back to 180. */
  labelMaxWidth?: number;
  /**
   * Called when the user finishes dragging a tab's right-edge handle.
   * Width is already clamped. Persist server-side.
   */
  onLabelWidthChange?: (width: number) => void;
  /**
   * Called when the user drag-reorders a tab. `fromIdx` and `toIdx` are
   * indices into the `tabs` array; `toIdx` follows Array#splice semantics
   * (insert position AFTER removal of the source). No-ops are filtered out
   * in the strip so the parent never sees `fromIdx === toIdx`.
   */
  onReorder?: (fromIdx: number, toIdx: number) => void;
};

const TAB_LABEL_MIN = 60;
const TAB_LABEL_MAX = 600;

/**
 * Resolve the iTerm-style shortcut number shown on a tab.
 *
 *   length ≤ 9 → tab N (1-indexed) gets shortcut N.
 *   length > 9 → tabs 1..8 keep 1..8, the LAST tab gets 9, everything in
 *               between is unreachable by number (cycle with ⌘⇧← / →).
 *
 * Returns `null` when the tab gets no number. The matching keyboard handler
 * uses the same rule so visual hint and binding never drift.
 */
/**
 * How far (in px) a non-dragged tab should be translated horizontally while
 * a reorder drag is in flight. The dragged tab stays in its DOM slot
 * (rendered invisible) so the strip's flex layout is stable; the other tabs
 * slide ±draggedWidth so the projected drop slot is visible under the
 * cursor.
 *
 * Pure / no DOM access — exported so unit tests can pin the geometry
 * without mounting the component.
 */
export function tabShiftForReorder(
  idx: number,
  fromIdx: number,
  overIdx: number,
  draggedWidth: number,
): number {
  if (idx === fromIdx) return 0;
  if (fromIdx < idx && overIdx >= idx) return -draggedWidth;
  if (fromIdx > idx && overIdx <= idx) return draggedWidth;
  return 0;
}

/**
 * Given the bounding rects of every tab (in tab-order; `null` for hidden
 * tabs we should skip) and the current pointer X, return the splice-insert
 * index for the dragged tab. The math compensates for the fact that
 * `Array#splice` operates on the post-remove array — caller passes
 * (fromIdx, toIdx) straight to splice.
 */
export function computeReorderOverIdx(
  rects: ReadonlyArray<{ left: number; width: number } | null>,
  fromIdx: number,
  clientX: number,
): number {
  for (let i = 0; i < rects.length; i++) {
    if (i === fromIdx) continue;
    const r = rects[i];
    if (!r) continue;
    const mid = r.left + r.width / 2;
    if (clientX < mid) {
      return fromIdx < i ? i - 1 : i;
    }
  }
  return rects.length - 1;
}

/**
 * Apply a single drag-reorder to an array: remove the item at `fromIdx`
 * then re-insert it at `toIdx`. Bounds-checked. No-ops (same index,
 * out-of-range indices) return the input by reference so React `useState`
 * setters bail out and downstream persistence effects don't fire.
 */
export function reorderArray<T>(arr: readonly T[], fromIdx: number, toIdx: number): T[] {
  if (fromIdx < 0 || fromIdx >= arr.length) return arr as T[];
  if (toIdx < 0 || toIdx >= arr.length) return arr as T[];
  if (fromIdx === toIdx) return arr as T[];
  const next = arr.slice();
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

export function shortcutForTabIndex(idx: number, length: number): number | null {
  if (idx < 0 || idx >= length) return null;
  if (length <= 9) return idx + 1;
  if (idx < 8) return idx + 1;
  if (idx === length - 1) return 9;
  return null;
}

export function SessionTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseAll,
  onNew,
  onReopen,
  labelMaxWidth,
  onLabelWidthChange,
  onReorder,
}: Props) {
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const effectiveWidth = liveWidth ?? labelMaxWidth ?? 180;

  // Shortcuts come from the user-overridable registry now (lib/client/shortcuts.ts).
  // The defaults still ship as ⌘⇧←/→ and ⌘⇧1..9 so existing muscle memory holds.
  const bindingNext = useShortcut("tab.next");
  const bindingPrev = useShortcut("tab.prev");
  const bindingByNumber = useShortcut("tab.selectByNumber");
  // Phase 3 of docs/electron-conversion/PLAN.md — chord-only equivalents of
  // the menu items. Read once so the keydown handler doesn't have to.
  const bindingNew = useShortcut("tab.new");
  const bindingClose = useShortcut("tab.close");
  const bindingReopen = useShortcut("tab.reopen");
  const bindingLast = useShortcut("tab.last");

  // ── Global keyboard shortcuts ───────────────────────────────────────────
  // Cycle (next/prev) and numeric tab selection. The numeric shortcut is a
  // modifier-only binding — `bindingByNumber.code` is null, and the handler
  // intercepts Digit1..9 itself so a single registry entry covers all nine
  // visual hints. Skipped while the user is typing in an input.
  //
  // The effect re-binds when tabs / activeId / onSelect / bindings change.
  // That's cheap (one add/removeEventListener pair) and keeps closure values
  // fresh without the ref-in-render dance the lint rules dislike.
  // ── Tab-action helpers ─────────────────────────────────────────────────
  // These are referenced by both the keydown listener (web parity) and the
  // useElectronAction subscriptions (OS menu in the packaged build). Keeping
  // them as stable callbacks lets the menu wiring re-subscribe only when the
  // identity actually changes.
  const goToTab = useCallback(
    (idx: number) => {
      const t = tabs[idx];
      if (!t) return;
      if (t.id !== activeId) onSelect(t.id);
    },
    [tabs, activeId, onSelect],
  );

  const goToLastTab = useCallback(() => {
    const t = tabs[tabs.length - 1];
    if (!t) return;
    if (t.id !== activeId) onSelect(t.id);
  }, [tabs, activeId, onSelect]);

  const closeActiveTab = useCallback(() => {
    if (!activeId) return;
    onClose(activeId);
  }, [activeId, onClose]);

  const reopenLastClosed = useCallback(() => {
    onReopen?.();
  }, [onReopen]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;

      // tab.new / tab.close / tab.reopen / tab.last fire even when the strip
      // is empty — Cmd+T must work from an empty workspace.
      if (matchBinding(bindingNew, e)) {
        e.preventDefault();
        onNew();
        return;
      }
      if (tabs.length > 0 && matchBinding(bindingClose, e)) {
        e.preventDefault();
        closeActiveTab();
        return;
      }
      if (matchBinding(bindingReopen, e)) {
        e.preventDefault();
        reopenLastClosed();
        return;
      }
      if (tabs.length > 0 && matchBinding(bindingLast, e)) {
        e.preventDefault();
        goToLastTab();
        return;
      }

      if (tabs.length === 0) return;

      // Numeric: matcher checks modifier shape; we own the Digit1..9 range.
      // ⌘⇧9 is special: with >9 tabs it selects the LAST one (iTerm rule),
      // so the tail of the strip stays reachable past 9 sessions.
      if (bindingByNumber && /^Digit[1-9]$/.test(e.code) && matchBinding(bindingByNumber, e)) {
        const n = Number(e.code.slice(5));
        let target: Tab | undefined;
        if (n === 9) {
          if (tabs.length >= 9) target = tabs[tabs.length - 1];
        } else if (n - 1 < tabs.length) {
          target = tabs[n - 1];
        }
        if (target) {
          e.preventDefault();
          if (target.id !== activeId) onSelect(target.id);
        }
        return;
      }

      // Cycle: next/prev. Always wraps. Default bindings (⌘⇧←/→) override
      // macOS "extend selection to line start/end" inside text fields, but
      // the `isTypingTarget` guard above already excludes input focus.
      const dir = matchBinding(bindingNext, e) ? 1 : matchBinding(bindingPrev, e) ? -1 : 0;
      if (dir !== 0) {
        e.preventDefault();
        const cur = tabs.findIndex((t) => t.id === activeId);
        // If nothing is active, jump to first/last depending on direction
        // so the shortcut still has a sensible effect.
        const baseline = cur === -1 ? (dir > 0 ? -1 : 0) : cur;
        const next = tabs[(baseline + dir + tabs.length) % tabs.length];
        if (next && next.id !== activeId) onSelect(next.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    tabs,
    activeId,
    onSelect,
    onNew,
    bindingNext,
    bindingPrev,
    bindingByNumber,
    bindingNew,
    bindingClose,
    bindingReopen,
    bindingLast,
    closeActiveTab,
    reopenLastClosed,
    goToLastTab,
  ]);

  // ── Electron menu wiring (Phase 3) ─────────────────────────────────────
  // The OS menu (electron/menu.ts) dispatches `menu:action <actionId>` for
  // these same ids. In the browser build these subscriptions are no-ops, so
  // the chord-only path above still drives them.
  useElectronAction("tab.new", onNew);
  useElectronAction("tab.close", closeActiveTab);
  useElectronAction("tab.reopen", reopenLastClosed);
  useElectronAction("tab.last", goToLastTab);
  useElectronAction("tab.go1", useCallback(() => goToTab(0), [goToTab]));
  useElectronAction("tab.go2", useCallback(() => goToTab(1), [goToTab]));
  useElectronAction("tab.go3", useCallback(() => goToTab(2), [goToTab]));
  useElectronAction("tab.go4", useCallback(() => goToTab(3), [goToTab]));
  useElectronAction("tab.go5", useCallback(() => goToTab(4), [goToTab]));
  useElectronAction("tab.go6", useCallback(() => goToTab(5), [goToTab]));
  useElectronAction("tab.go7", useCallback(() => goToTab(6), [goToTab]));
  useElectronAction("tab.go8", useCallback(() => goToTab(7), [goToTab]));
  useElectronAction(
    "tab.next",
    useCallback(() => {
      if (tabs.length === 0) return;
      const cur = tabs.findIndex((t) => t.id === activeId);
      const next = tabs[(cur + 1 + tabs.length) % tabs.length];
      if (next && next.id !== activeId) onSelect(next.id);
    }, [tabs, activeId, onSelect]),
  );
  useElectronAction(
    "tab.prev",
    useCallback(() => {
      if (tabs.length === 0) return;
      const cur = tabs.findIndex((t) => t.id === activeId);
      const baseline = cur === -1 ? 0 : cur;
      const prev = tabs[(baseline - 1 + tabs.length) % tabs.length];
      if (prev && prev.id !== activeId) onSelect(prev.id);
    }, [tabs, activeId, onSelect]),
  );

  // Tooltip / numeric-hint formatting. Pulls the digit modifier from the
  // resolved `tab.selectByNumber` binding so renaming the prefix in
  // Settings (e.g. ⌥⇧ instead of ⌘⇧) updates the visible hint, too.
  const modHint = bindingByNumber
    ? formatBinding({ ...bindingByNumber, code: null }).replace(/1[…-]9$/, "")
    : "";

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

  // ── Drag-to-reorder ────────────────────────────────────────────────────
  // The user can drag any tab to a new slot. While the drag is active we
  // render a fixed-position floating clone of the tab under the pointer and
  // shift the other tabs' transforms so the "gap" follows the projected drop
  // index. The actual array reorder is delegated to the parent via
  // `onReorder` and only fires on pointer-up — mid-drag we never mutate the
  // underlying state, just the visual offsets.
  //
  // Implementation notes:
  //   • Window-level pointermove/up listeners (not React handlers on the
  //     tab) so the drag survives the pointer leaving the strip — a tab
  //     element shrinking to 0 width when its slot becomes the "gap" would
  //     otherwise drop the capture.
  //   • A 4px movement threshold separates "click to select" from "drag to
  //     reorder". Below the threshold the onClick selection still fires.
  //   • `dragSuppressClickRef` blocks the click event the browser dispatches
  //     after pointerup so we don't accidentally select the dragged tab on
  //     drop.
  type DragState = {
    id: string;
    fromIdx: number;
    overIdx: number;
    width: number;
    height: number;
    /** Pointer offset within the tab when the drag started. */
    offsetX: number;
    offsetY: number;
    /** Current pointer position in viewport coordinates. */
    x: number;
    y: number;
  };
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragSuppressClickRef = useRef(false);
  // Refs so the long-lived pointermove/up closures see fresh values without
  // having to re-bind every render. We write them in an effect (not during
  // render) so the lint rule against ref-mutation-in-render stays happy;
  // the staleness window is one render which is fine because pointer
  // handlers always fire AFTER a render commits.
  const tabsRef = useRef(tabs);
  const onReorderRef = useRef(onReorder);
  useEffect(() => {
    tabsRef.current = tabs;
    onReorderRef.current = onReorder;
  }, [tabs, onReorder]);

  function startTabDrag(e: React.PointerEvent<HTMLDivElement>, idx: number) {
    if (e.button !== 0) return;
    // Anything tagged `data-no-drag` (close button, resize handle) bypasses
    // the drag so its own handler runs unimpaired.
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    const tabEl = e.currentTarget;
    const rect = tabEl.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const offsetX = startX - rect.left;
    const offsetY = startY - rect.top;
    const tab = tabsRef.current[idx];
    if (!tab) return;
    let moved = false;
    let lastOverIdx = idx;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved) {
        if (Math.hypot(dx, dy) < 4) return;
        moved = true;
        dragSuppressClickRef.current = true;
      }
      const overIdx = computeOverIdx(ev.clientX, idx);
      lastOverIdx = overIdx;
      setDrag({
        id: tab.id,
        fromIdx: idx,
        overIdx,
        width: rect.width,
        height: rect.height,
        offsetX,
        offsetY,
        x: ev.clientX,
        y: ev.clientY,
      });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (moved && lastOverIdx !== idx) {
        onReorderRef.current?.(idx, lastOverIdx);
      }
      setDrag(null);
      // Released-after-drag fires a synthetic click on the tab's button; let
      // it land then clear the suppression so future plain clicks select.
      setTimeout(() => {
        dragSuppressClickRef.current = false;
      }, 0);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // Adapter: collects the live rects for tabs (skipping hidden ones and the
  // dragged tab) and defers the index math to the pure `computeReorderOverIdx`
  // helper so the geometry is unit-testable.
  function computeOverIdx(clientX: number, fromIdx: number): number {
    const strip = stripRef.current;
    if (!strip) return fromIdx;
    const list = tabsRef.current;
    const rects: Array<{ left: number; width: number } | null> = list.map((t, i) => {
      if (i === fromIdx) return null;
      if (hiddenIds.has(t.id)) return null;
      const el = strip.querySelector<HTMLDivElement>(
        `[data-tab-id="${CSS.escape(t.id)}"]`,
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    return computeReorderOverIdx(rects, fromIdx, clientX);
  }

  // Closure over `drag` that picks the right argument bundle for the pure
  // helper. Keeps the JSX call site tidy.
  function shiftFor(idx: number): number {
    if (!drag) return 0;
    return tabShiftForReorder(idx, drag.fromIdx, drag.overIdx, drag.width);
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
      // Bail when there's nothing to measure. The reset to an empty Set
      // (when hiddenIds was non-empty) is a layout-sync write: it
      // depends on the just-rendered tab strip dimensions, which is
      // exactly what useLayoutEffect is for. The functional-update guard
      // returns `prev` unchanged when already empty, but ESLint's
      // `set-state-in-effect` rule can't read that guard — hence the
      // suppression. Hoisting this to "store previous props" would lose
      // the dependency on the DOM measurement and create flicker.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      {tabs.map((t, i) => {
        const active = t.id === activeId;
        const hidden = hiddenIds.has(t.id);
        const isBeingDragged = drag?.id === t.id;
        const shift = shiftFor(i);
        const shortcut = shortcutForTabIndex(i, tabs.length);
        // Only surface the chord hint when the numeric shortcut actually has
        // a binding — when the user disabled it the visual digit still
        // labels the tab, but advertising a keypress that does nothing
        // would mislead.
        const shortcutHint =
          shortcut != null && bindingByNumber ? `\nShortcut: ${modHint}${shortcut}` : "";
        return (
          <div
            key={t.id}
            ref={captureWidth(t.id)}
            data-testid="session-tab"
            data-tab-id={t.id}
            data-tab-active={active ? "true" : "false"}
            data-tab-hidden={hidden ? "true" : "false"}
            data-tab-dragging={isBeingDragged ? "true" : "false"}
            onPointerDown={(e) => startTabDrag(e, i)}
            // `display: none` keeps the element out of layout so trailing
            // tabs don't get partially clipped by overflow:hidden. The
            // measurement cache (widthsRef) preserved its natural width
            // from a prior render where it WAS visible.
            // While a drag is active, non-dragged tabs translate sideways to
            // reveal the projected drop slot; the dragged tab itself stays
            // in its DOM position but is rendered invisible so the floating
            // clone is the only visible representation.
            style={{
              ...(hidden ? { display: "none" } : null),
              transform: shift ? `translateX(${shift}px)` : undefined,
              transition: drag && !isBeingDragged ? "transform 140ms ease" : undefined,
              opacity: isBeingDragged ? 0 : undefined,
              cursor: drag ? "grabbing" : "grab",
            }}
            className={cn(
              "group relative flex shrink-0 items-center gap-1.5 border-r border-[var(--border)] px-2 text-[11px] select-none",
              active
                ? "bg-[var(--background)] text-[var(--foreground)]"
                : "bg-[var(--panel)]/40 text-[var(--muted)] hover:bg-[var(--panel-2)]/60",
            )}
          >
            <button
              type="button"
              onClick={() => {
                // After a drag, the browser still fires a click on the same
                // element — suppress that so dropping a tab doesn't also
                // re-select it (which would steal focus from whatever the
                // user actually wanted to look at).
                if (dragSuppressClickRef.current) return;
                onSelect(t.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(t.id); // middle-click closes
              }}
              className="flex min-w-0 items-center gap-1.5"
              title={`${t.label ?? t.id}\n${t.status}${shortcutHint}`}
            >
              <StatusDot status={t.status} />
              {shortcut != null && (
                // Sits OUTSIDE the truncated label so narrow tabs don't clip
                // the digit. Mirrors the iTerm hint in the tab itself.
                <span
                  data-testid="session-tab-shortcut"
                  aria-hidden
                  className={cn(
                    "shrink-0 font-mono text-[9px] leading-none tabular-nums",
                    active ? "text-[var(--muted)]" : "text-[var(--muted)]/60",
                  )}
                >
                  {shortcut}
                </span>
              )}
              <span
                data-testid="session-tab-label"
                style={{ maxWidth: `${effectiveWidth}px` }}
                className="truncate font-mono"
              >
                {t.label ?? t.id.slice(0, 8)}
              </span>
              {t.unread != null && t.unread > 0 && (
                <span
                  data-testid="session-tab-unread"
                  aria-label={`${t.unread} unread notification${t.unread === 1 ? "" : "s"}`}
                  title={`${t.unread} unread notification${t.unread === 1 ? "" : "s"}`}
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold leading-none tabular-nums",
                    "bg-[var(--accent)]/85 text-[var(--background)]",
                  )}
                >
                  {t.unread > 99 ? "99+" : t.unread}
                </span>
              )}
            </button>
            <button
              type="button"
              data-no-drag
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
              chosen value persisted via onLabelWidthChange. Marked
              `data-no-drag` so it does NOT engage the reorder drag.
            */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize tab labels"
              data-no-drag
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              className="absolute right-0 top-0 h-full w-1 cursor-ew-resize select-none opacity-0 hover:bg-[var(--accent)]/40 hover:opacity-100 group-hover:opacity-60"
            />
          </div>
        );
      })}
      {/*
        New-session button lives INSIDE the strip so it always sits flush
        to the right of the last visible tab — not pinned to the far right
        of the bar. The strip is `flex-1`, so empty space stretches between
        the "+" and the trailing chevron / close-all controls.
      */}
      <button
        type="button"
        onClick={onNew}
        title="New session tab"
        className="flex w-8 shrink-0 items-center justify-center text-[var(--muted)] hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
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
                  .map((t, i) => ({ t, shortcut: shortcutForTabIndex(i, tabs.length) }))
                  .filter(({ t }) => hiddenIds.has(t.id))
                  .map(({ t, shortcut }) => (
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
                        {t.unread != null && t.unread > 0 && (
                          <span
                            aria-label={`${t.unread} unread notification${t.unread === 1 ? "" : "s"}`}
                            className="shrink-0 rounded-full bg-[var(--accent)]/85 px-1.5 py-px text-[9px] font-semibold leading-none tabular-nums text-[var(--background)]"
                          >
                            {t.unread > 99 ? "99+" : t.unread}
                          </span>
                        )}
                        {shortcut != null && bindingByNumber && (
                          <span
                            aria-hidden
                            className="shrink-0 font-mono text-[9px] text-[var(--muted)]/70 tabular-nums"
                          >
                            {modHint}{shortcut}
                          </span>
                        )}
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
      {drag &&
        (() => {
          // Floating clone of the dragged tab. Rendered as a sibling of the
          // tab strip rather than inside it so transforms / overflow on the
          // strip don't clip the clone as the user drags past the edge.
          const t = tabs[drag.fromIdx];
          if (!t) return null;
          const dragShortcut = shortcutForTabIndex(drag.fromIdx, tabs.length);
          return (
            <div
              data-testid="session-tab-drag-clone"
              aria-hidden
              style={{
                position: "fixed",
                left: drag.x - drag.offsetX,
                top: drag.y - drag.offsetY,
                width: drag.width,
                height: drag.height,
                pointerEvents: "none",
                zIndex: 60,
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-sm border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)] shadow-xl",
              )}
            >
              <StatusDot status={t.status} />
              {dragShortcut != null && (
                <span
                  aria-hidden
                  className="shrink-0 font-mono text-[9px] leading-none text-[var(--muted)] tabular-nums"
                >
                  {dragShortcut}
                </span>
              )}
              <span
                style={{ maxWidth: `${effectiveWidth}px` }}
                className="truncate font-mono"
              >
                {t.label ?? t.id.slice(0, 8)}
              </span>
              {t.unread != null && t.unread > 0 && (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold leading-none tabular-nums",
                    "bg-[var(--accent)]/85 text-[var(--background)]",
                  )}
                >
                  {t.unread > 99 ? "99+" : t.unread}
                </span>
              )}
            </div>
          );
        })()}
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
  return (
    <span
      data-testid="session-tab-status-dot"
      data-status={status}
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)}
      aria-hidden
    />
  );
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
