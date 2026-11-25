"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  PanelLeft,
  PanelRight,
  PanelTop,
  Pin,
  Plus,
  X,
  XSquare,
} from "lucide-react";
import type { SessionInfo } from "@/lib/client/types";
import type { TabPlacement } from "@/lib/client/useTabPlacement";
import {
  formatBinding,
  isTypingTarget,
  matchBinding,
  useBindingPlatform,
  useShortcut,
} from "@/lib/client/shortcuts";
import { useKeydownBinding } from "@/lib/client/useKeydownBinding";
import { useElectronAction, useIsElectron } from "@/lib/client/useElectron";
import { cn } from "@/lib/utils/cn";

export type TabStatus = "running" | "idle" | "starting" | "error" | "background" | "needs_input";

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
  /**
   * Whether this tab is pinned. Pinned tabs sort to the front of the strip,
   * render a persistent pin affordance, and survive "Close all tabs". The
   * parent owns the pinned set and keeps `tabs` normalized (pinned first), so
   * this component just reflects the flag — see `normalizePinnedOrder`.
   */
  pinned?: boolean;
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
  /**
   * Toggle the pinned state of a tab. When omitted the pin affordance is not
   * rendered (web parity for hosts that don't persist pins).
   */
  onTogglePin?: (id: string) => void;
  /**
   * Where the strip docks. "top" (default) is the horizontal bar above the
   * chat; "left" / "right" render a vertical column. The parent decides where
   * to MOUNT the strip — this prop only switches the strip's own layout.
   */
  placement?: TabPlacement;
  /**
   * Change the placement from the strip's right-click menu. When omitted the
   * "Tab placement" section of that menu is not rendered.
   */
  onPlacementChange?: (placement: TabPlacement) => void;
};

const TAB_LABEL_MIN = 60;
const TAB_LABEL_MAX = 600;
/**
 * Vertical placement sizes the whole column off the shared label width:
 * column = label + this much room for padding, status dot, shortcut digit,
 * pin and close buttons. So the persisted width means the same thing in
 * either orientation (how much of the session name you get to read).
 */
const VERTICAL_CHROME_PX = 72;
/** Width of the gradient that fades tabs out at a scrolled edge. */
const EDGE_FADE_PX = 20;

const PLACEMENT_OPTIONS: ReadonlyArray<{
  value: TabPlacement;
  label: string;
  Icon: typeof PanelTop;
}> = [
  { value: "top", label: "Top", Icon: PanelTop },
  { value: "left", label: "Left", Icon: PanelLeft },
  { value: "right", label: "Right", Icon: PanelRight },
];

/**
 * Resolve the iTerm-style shortcut number shown on a tab.
 *
 *   length ≤ 9 → tab N (1-indexed) gets shortcut N.
 *   length > 9 → tabs 1..8 keep 1..8, the LAST tab gets 9, everything in
 *               between is unreachable by number (cycle with ⌘⌥← / →).
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

/**
 * Reorder a tab-id list so every pinned id sorts to the front while the
 * relative order *within* the pinned group and *within* the unpinned group is
 * preserved. Returns the input by reference when it's already normalized so a
 * `useState` setter (and the downstream persistence effect) bails on a no-op.
 *
 * Pure / no DOM — exported for unit tests and reused by the chat page to keep
 * `openTabs` canonical (pinned-first) regardless of which producer mutated it.
 */
export function normalizePinnedOrder(
  tabs: readonly string[],
  pinned: ReadonlySet<string>,
): string[] {
  const pin: string[] = [];
  const rest: string[] = [];
  for (const id of tabs) (pinned.has(id) ? pin : rest).push(id);
  const next = pin.concat(rest);
  // Referential-stability guard: if nothing moved, hand back the original.
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i] !== next[i]) return next;
  }
  return tabs as string[];
}

/**
 * Clamp a drag-reorder target index so a tab can only move *within* its own
 * group (pinned tabs occupy `[0, pinnedCount)`, unpinned `[pinnedCount, len)`).
 * Assumes the list is already pinned-first normalized, so `pinnedCount` is the
 * count of leading pinned tabs. Returns `fromIdx` (a no-op for the caller's
 * `fromIdx === toIdx` guard) when the group has no room to move.
 */
export function clampReorderTarget(
  fromIdx: number,
  toIdx: number,
  pinnedCount: number,
  length: number,
): number {
  const fromPinned = fromIdx < pinnedCount;
  const lo = fromPinned ? 0 : pinnedCount;
  const hi = fromPinned ? pinnedCount - 1 : length - 1;
  if (hi < lo) return fromIdx;
  return Math.min(Math.max(toIdx, lo), hi);
}

/**
 * Scroll offset (along the strip's axis) that brings the item spanning
 * `[start, start + size)` fully into a viewport of `viewSize` px currently
 * scrolled to `scrollPos`. "Nearest" semantics, like
 * `scrollIntoView({ inline: "nearest" })`: returns `scrollPos` unchanged when
 * the item is already fully visible. `margin` keeps the item clear of the
 * edge fades. An item that fits but not with both margins is centred (so it
 * is still fully visible in a narrow strip); one bigger than the viewport
 * aligns its start. The result is clamped to `[0, maxScroll]`.
 *
 * Pure — exported for unit tests.
 */
export function scrollPosToReveal(
  start: number,
  size: number,
  scrollPos: number,
  viewSize: number,
  maxScroll: number,
  margin = 0,
): number {
  const fullyVisible = start >= scrollPos - 0.5 && start + size <= scrollPos + viewSize + 0.5;
  let next = scrollPos;
  if (size >= viewSize) {
    next = start;
  } else if (size + 2 * margin > viewSize) {
    if (!fullyVisible) next = start - (viewSize - size) / 2;
  } else if (start - margin < scrollPos) {
    next = start - margin;
  } else if (start + size + margin > scrollPos + viewSize) {
    next = start + size + margin - viewSize;
  }
  return Math.min(Math.max(next, 0), Math.max(0, maxScroll));
}

/**
 * Ids of the items that are NOT fully inside the viewport
 * `[scrollPos, scrollPos + viewSize]`. A 1px tolerance absorbs sub-pixel
 * rounding so a tab sitting flush against the edge still counts as visible.
 * These are the tabs the overflow chevron lists.
 *
 * Pure — exported for unit tests.
 */
export function outOfViewIds(
  items: ReadonlyArray<{ id: string; start: number; size: number }>,
  scrollPos: number,
  viewSize: number,
): string[] {
  const lo = scrollPos - 1;
  const hi = scrollPos + viewSize + 1;
  return items.filter((it) => it.start < lo || it.start + it.size > hi).map((it) => it.id);
}

/**
 * IntelliJ-style wheel handling for the horizontal strip: a vertical wheel
 * (mouse wheel, vertical two-finger trackpad swipe) scrolls the tabs
 * sideways. Returns the horizontal delta in px, or `null` when the event
 * should be left to the browser — horizontal-dominant gestures (trackpad
 * side-swipes, shift+wheel) already scroll the strip natively, and ctrl+wheel
 * is pinch-zoom.
 *
 * Pure — exported for unit tests.
 */
export function wheelToHorizontalDelta(
  e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean },
  pageSize: number,
): number | null {
  if (e.ctrlKey) return null;
  if (e.deltaY === 0 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return null;
  // deltaMode: 0 = pixels, 1 = lines, 2 = pages.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageSize : 1;
  return e.deltaY * unit;
}

/**
 * Per-frame auto-scroll step while a tab is dragged near (or past) either end
 * of the strip, so a tab can be dropped onto a slot that's currently scrolled
 * out of view. Speed ramps up the deeper the pointer sits in the `zone`, capped
 * at `max` px/frame. 0 when the pointer is comfortably inside.
 *
 * Pure — exported for unit tests.
 */
export function edgeAutoScrollStep(
  pointer: number,
  viewStart: number,
  viewEnd: number,
  zone = 32,
  max = 18,
): number {
  if (pointer < viewStart + zone) {
    return -Math.min(max, Math.ceil((viewStart + zone - pointer) / 3));
  }
  if (pointer > viewEnd - zone) {
    return Math.min(max, Math.ceil((pointer - (viewEnd - zone)) / 3));
  }
  return 0;
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
  onTogglePin,
  placement = "top",
  onPlacementChange,
}: Props) {
  const vertical = placement !== "top";
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  // `sign` flips the drag direction for the right-docked column, whose
  // resize handle sits on its LEFT edge (dragging left = wider).
  const dragRef = useRef<{ startX: number; startW: number; sign: 1 | -1 } | null>(null);
  const effectiveWidth = liveWidth ?? labelMaxWidth ?? 180;

  // Shortcuts come from the user-overridable registry now (lib/client/shortcuts.ts).
  // Defaults: ⌘⌥←/→ for cycle (avoids ⌘⇧← text-selection collision) and
  // ⌘⇧1..9 for numeric selection.
  //
  // KEYDOWN matching uses `useKeydownBinding`: in the Electron build these
  // chords are owned by the native menu (electron/menu.ts), which fires the
  // action even while the composer holds focus. `useKeydownBinding` returns
  // null for those ids in Electron so this in-page listener stays inert and
  // the menu doesn't double-fire. In the browser build it returns the real
  // binding (web parity).
  const bindingNext = useKeydownBinding("tab.next");
  const bindingPrev = useKeydownBinding("tab.prev");
  const bindingByNumberMatch = useKeydownBinding("tab.selectByNumber");
  // DISPLAY of the numeric hint always uses the real resolved binding — the
  // ⌘1–9 chord works in Electron (via the menu), so the hint must still show.
  const bindingByNumber = useShortcut("tab.selectByNumber");
  // Phase 3 of docs/electron-conversion/PLAN.md — chord-only equivalents of
  // the menu items. Read once so the keydown handler doesn't have to.
  const bindingNew = useKeydownBinding("tab.new");
  const bindingClose = useKeydownBinding("tab.close");
  const bindingReopen = useKeydownBinding("tab.reopen");
  const bindingLast = useKeydownBinding("tab.last");
  // Tab-cycle chords need a special in-composer path in Electron. The
  // OS menu owns the cycle, but a focused composer can swallow chords
  // before the menu fires — historically that was ⌘⇧←/→ ("extend
  // selection to line start/end"), and it can still happen if the user
  // rebinds to any text-edit chord. The default is now ⌘⌥←/→ which
  // does not collide, but we keep this defensive path so custom
  // bindings still cycle while typing. Electron-only so the browser
  // build keeps native text-selection behaviour.
  const isElectron = useIsElectron();
  const bindingNextReal = useShortcut("tab.next");
  const bindingPrevReal = useShortcut("tab.prev");

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
      const typing = isTypingTarget(e.target);

      // Electron + composer focused: if the user's cycle chord is one a
      // text input claims first (e.g. they rebound to ⌘⇧←/→ for "extend
      // selection to line start/end"), the native menu never sees it.
      // Cycle from the renderer and cancel the would-be text selection.
      // The default ⌘⌥←/→ doesn't collide, but this path is cheap and
      // makes custom bindings work. When NOT typing the menu drives
      // next/prev (`bindingNext`/`bindingPrev` are null in Electron, so
      // the not-typing branch below doesn't double-fire with it).
      // Disjoint focus states ⇒ exactly one cycle either way.
      if (isElectron && typing) {
        const dir = matchBinding(bindingNextReal, e)
          ? 1
          : matchBinding(bindingPrevReal, e)
            ? -1
            : 0;
        if (dir !== 0 && tabs.length > 0) {
          e.preventDefault();
          const cur = tabs.findIndex((t) => t.id === activeId);
          const baseline = cur === -1 ? (dir > 0 ? -1 : 0) : cur;
          const target = tabs[(baseline + dir + tabs.length) % tabs.length];
          if (target && target.id !== activeId) onSelect(target.id);
        }
      }

      if (typing) return;

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
      if (bindingByNumberMatch && /^Digit[1-9]$/.test(e.code) && matchBinding(bindingByNumberMatch, e)) {
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

      // Cycle: next/prev. Always wraps. Default bindings are ⌘⌥←/→, which
      // don't collide with the macOS Shift+Arrow text-selection chord —
      // and we already excluded input focus via the `isTypingTarget`
      // guard above.
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
    isElectron,
    bindingNextReal,
    bindingPrevReal,
    bindingNext,
    bindingPrev,
    bindingByNumberMatch,
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
  const bindingPlatform = useBindingPlatform();
  const modHint = bindingByNumber
    ? formatBinding({ ...bindingByNumber, code: null }, { platform: bindingPlatform })
        .replace(/1[…-]9$/, "")
    : "";

  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      startX: e.clientX,
      startW: effectiveWidth,
      sign: placement === "right" ? -1 : 1,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(
      TAB_LABEL_MAX,
      Math.max(TAB_LABEL_MIN, drag.startW + drag.sign * (e.clientX - drag.startX)),
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
  // Whether the strip should keep the active tab scrolled into view — see
  // "Follow the active tab" in the overflow section below.
  const followActiveRef = useRef(true);
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
    let lastX = startX;
    let lastY = startY;
    let raf = 0;

    const update = () => {
      const overIdx = computeOverIdx(vertical ? lastY : lastX, idx);
      lastOverIdx = overIdx;
      setDrag({
        id: tab.id,
        fromIdx: idx,
        overIdx,
        width: rect.width,
        height: rect.height,
        offsetX,
        offsetY,
        x: lastX,
        y: lastY,
      });
    };

    // Edge auto-scroll: while the pointer hovers near/past either end of the
    // scroller, keep nudging it each frame and re-project the drop slot (the
    // tabs move under a stationary pointer). Stops once the pointer leaves
    // the zone or the scroller hits its limit; the next pointermove re-arms.
    const tick = () => {
      raf = 0;
      const strip = stripRef.current;
      if (!strip) return;
      const r = strip.getBoundingClientRect();
      const step = vertical
        ? edgeAutoScrollStep(lastY, r.top, r.bottom)
        : edgeAutoScrollStep(lastX, r.left, r.right);
      if (step === 0) return;
      const before = vertical ? strip.scrollTop : strip.scrollLeft;
      if (vertical) strip.scrollTop = before + step;
      else strip.scrollLeft = before + step;
      const after = vertical ? strip.scrollTop : strip.scrollLeft;
      if (after === before) return;
      // The user is steering the scroll position now — don't snap back to
      // the active tab on the reorder commit.
      followActiveRef.current = false;
      update();
      raf = requestAnimationFrame(tick);
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved) {
        if (Math.hypot(dx, dy) < 4) return;
        moved = true;
        dragSuppressClickRef.current = true;
      }
      lastX = ev.clientX;
      lastY = ev.clientY;
      update();
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf) cancelAnimationFrame(raf);
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

  // Adapter: collects the live rects for tabs (skipping the dragged tab) and
  // defers the index math to the pure `computeReorderOverIdx` helper so the
  // geometry is unit-testable. The helper is axis-agnostic: in the vertical
  // column we feed it (top, height) and the pointer's Y. Tabs scrolled out of
  // view are still laid out, so their rects stay valid.
  function computeOverIdx(pointer: number, fromIdx: number): number {
    const strip = stripRef.current;
    if (!strip) return fromIdx;
    const list = tabsRef.current;
    const rects: Array<{ left: number; width: number } | null> = list.map((t, i) => {
      if (i === fromIdx) return null;
      const el = strip.querySelector<HTMLDivElement>(
        `[data-tab-id="${CSS.escape(t.id)}"]`,
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return vertical ? { left: r.top, width: r.height } : { left: r.left, width: r.width };
    });
    return computeReorderOverIdx(rects, fromIdx, pointer);
  }

  // Closure over `drag` that picks the right argument bundle for the pure
  // helper. Keeps the JSX call site tidy.
  function shiftFor(idx: number): number {
    if (!drag) return 0;
    return tabShiftForReorder(
      idx,
      drag.fromIdx,
      drag.overIdx,
      vertical ? drag.height : drag.width,
    );
  }

  // ── Overflow: scroll (IntelliJ "scroll tabs" mode) ─────────────────────
  // When more tabs are open than fit, the strip scrolls along its axis
  // rather than hiding the extras: every tab stays laid out, so you can
  // scroll through them and watch them go by. A vertical wheel / trackpad
  // swipe over the horizontal strip scrolls it sideways (see
  // `wheelToHorizontalDelta`); the native scrollbar is hidden (it would eat
  // the 36px bar) and edge fades signal "more this way" instead. The chevron
  // still lists every tab that isn't fully in view, as a jump list.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [edges, setEdges] = useState({ before: false, after: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Recompute which tabs are out of view + whether each edge has more to
  // scroll to. Positions come from offsetLeft/offsetTop (the scroller is
  // `relative`, so it is the tabs' offsetParent): those ignore the drag
  // transforms and are measured from the content origin, independent of the
  // current scroll offset.
  const measureOverflow = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const pos = vertical ? el.scrollTop : el.scrollLeft;
    const view = vertical ? el.clientHeight : el.clientWidth;
    const total = vertical ? el.scrollHeight : el.scrollWidth;
    const items = Array.from(el.querySelectorAll<HTMLElement>(":scope > [data-tab-id]")).map(
      (c) => ({
        id: c.dataset.tabId ?? "",
        start: vertical ? c.offsetTop : c.offsetLeft,
        size: vertical ? c.offsetHeight : c.offsetWidth,
      }),
    );
    const hidden = outOfViewIds(items, pos, view);
    setHiddenIds((prev) => {
      if (prev.size === hidden.length && hidden.every((id) => prev.has(id))) return prev;
      return new Set(hidden);
    });
    const before = pos > 1;
    const after = pos + view < total - 1;
    setEdges((prev) =>
      prev.before === before && prev.after === after ? prev : { before, after },
    );
  }, [vertical]);

  // Scroll a tab fully into view ("nearest", clear of the edge fades).
  // Returns false when the tab isn't in the DOM (yet).
  const scrollTabIntoView = useCallback(
    (id: string, smooth: boolean): boolean => {
      const el = stripRef.current;
      if (!el) return false;
      const tabEl = el.querySelector<HTMLElement>(`:scope > [data-tab-id="${CSS.escape(id)}"]`);
      if (!tabEl) return false;
      const pos = vertical ? el.scrollTop : el.scrollLeft;
      const view = vertical ? el.clientHeight : el.clientWidth;
      const max = (vertical ? el.scrollHeight : el.scrollWidth) - view;
      const next = scrollPosToReveal(
        vertical ? tabEl.offsetTop : tabEl.offsetLeft,
        vertical ? tabEl.offsetHeight : tabEl.offsetWidth,
        pos,
        view,
        max,
        EDGE_FADE_PX,
      );
      if (Math.abs(next - pos) < 1) return true;
      const reduce =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollTo({
        [vertical ? "top" : "left"]: next,
        behavior: smooth && !reduce ? "smooth" : "auto",
      });
      return true;
    },
    [vertical],
  );

  // "Follow the active tab". While on, every layout change (tabs added /
  // removed / reordered, labels resolving from an id prefix to a title and
  // widening the tabs before the active one, label width dragged, the strip
  // resized) re-reveals the active tab. Scrolling the strip yourself turns
  // it off, so background status / title updates never yank the strip back
  // while you're looking elsewhere; selecting a tab (click, ⌘-N, cycling, a
  // new session, the chevron menu) turns it back on.
  // (`followActiveRef` itself is declared up with the drag refs — the drag
  // edge auto-scroll clears it.)
  const prevActiveRef = useRef<string | null>(null);
  // The very first reveal after mount jumps; later ones animate.
  const revealedOnceRef = useRef(false);

  // Runs after every commit that can move tabs around. Reads post-layout DOM
  // geometry, which is exactly what useLayoutEffect is for; measureOverflow's
  // setters bail when nothing changed, so it can't loop.
  useLayoutEffect(() => {
    if (prevActiveRef.current !== activeId) {
      prevActiveRef.current = activeId;
      followActiveRef.current = true;
    }
    if (activeId && followActiveRef.current) {
      if (scrollTabIntoView(activeId, revealedOnceRef.current)) revealedOnceRef.current = true;
    }
    measureOverflow();
  }, [tabs, activeId, effectiveWidth, measureOverflow, scrollTabIntoView]);

  // …and on scroll (rAF-throttled), and whenever the strip itself resizes
  // (window resize, side panels toggling, workspace switch) — which can also
  // push a followed active tab out of view.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    let raf = 0;
    const scheduleMeasure = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measureOverflow();
      });
    };
    const onResize = () => {
      if (activeId && followActiveRef.current) scrollTabIntoView(activeId, false);
      scheduleMeasure();
    };
    el.addEventListener("scroll", scheduleMeasure, { passive: true });
    const obs = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    obs?.observe(el);
    return () => {
      el.removeEventListener("scroll", scheduleMeasure);
      obs?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [activeId, measureOverflow, scrollTabIntoView]);

  // Wheel handling. Any user wheel / touch scroll on an overflowing strip
  // stops following the active tab. On the top strip, a vertical wheel also
  // scrolls sideways — that needs a non-passive native listener: React's
  // onWheel is passive, so it can't preventDefault the page scroll.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const overflowing = () =>
      vertical ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth;
    const onWheel = (e: WheelEvent) => {
      if (!overflowing()) return;
      followActiveRef.current = false;
      if (vertical) return; // native vertical scrolling
      const dx = wheelToHorizontalDelta(e, el.clientWidth);
      if (dx == null) return; // horizontal gesture — native
      e.preventDefault();
      el.scrollLeft += dx;
    };
    const onTouchMove = () => {
      if (overflowing()) followActiveRef.current = false;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [vertical]);

  // Bring a tab into view on an explicit request (clicking the already-active
  // tab, or picking it from the chevron). Selection alone wouldn't change
  // activeId in that case, so the layout effect wouldn't re-reveal it.
  const revealActive = useCallback(
    (id: string) => {
      followActiveRef.current = true;
      scrollTabIntoView(id, true);
    },
    [scrollTabIntoView],
  );

  // Chevron-menu pick: select the tab, or just reveal it if it's already the
  // active one (scrolled out of view).
  const selectAndReveal = useCallback(
    (id: string) => {
      if (id === activeId) revealActive(id);
      else onSelect(id);
    },
    [activeId, onSelect, revealActive],
  );

  // ── Right-click menu ───────────────────────────────────────────────────
  // IntelliJ-style: right-click a tab (or the empty strip) for tab actions
  // and the "Tab placement" switch. Opening it calls preventDefault on the
  // DOM contextmenu event, which also keeps Electron's native menu away.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string | null } | null>(
    null,
  );
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const hasCtxMenu = !!onPlacementChange || !!onTogglePin;
  function onStripContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    if (!hasCtxMenu) return;
    const tabEl = (e.target as HTMLElement).closest<HTMLElement>("[data-tab-id]");
    // Only tabs inside the strip count — overflow-menu rows also carry
    // data-tab-id but live in their own popover.
    const tabId =
      tabEl && stripRef.current?.contains(tabEl) ? (tabEl.dataset.tabId ?? null) : null;
    // Nothing to offer (no placement switch, not on a tab) → native menu.
    if (!onPlacementChange && !tabId) return;
    e.preventDefault();
    setMenuOpen(false);
    // Keep the menu on-screen — the right-docked column sits flush against
    // the window edge. 192 = w-48; 180 ≈ the tallest menu (tab actions +
    // separator + placement header + 3 options).
    setCtxMenu({
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - 192 - 4)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - 180 - 4)),
      tabId,
    });
  }
  useEffect(() => {
    if (!ctxMenu) return;
    function onDown(e: MouseEvent) {
      if (!ctxMenuRef.current?.contains(e.target as Node)) setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCtxMenu(null);
    }
    function onBlur() {
      setCtxMenu(null);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [ctxMenu]);

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

  // The tab the right-click landed on (null for the empty strip).
  const ctxTab = ctxMenu?.tabId ? (tabs.find((t) => t.id === ctxMenu.tabId) ?? null) : null;

  // Active-tab accent bar sits on the strip's OUTER edge: top for the
  // horizontal bar, the far side for the vertical column.
  const activeEdge =
    placement === "left"
      ? "before:inset-y-0 before:left-0 before:w-[2px]"
      : placement === "right"
        ? "before:inset-y-0 before:right-0 before:w-[2px]"
        : "before:inset-x-0 before:top-0 before:h-[2px]";

  // New-session button lives right AFTER the scroller, so it sits flush
  // against the last tab while everything fits, and sticks to the strip's end
  // (instead of scrolling away) once the tabs overflow.
  const plusButton = (
    <button
      type="button"
      onClick={onNew}
      title="New session tab"
      className={cn(
        "flex shrink-0 items-center text-[var(--muted)] hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]",
        vertical ? "h-8 w-full gap-1.5 px-2 text-[11px]" : "w-8 justify-center",
      )}
    >
      <Plus className="h-3.5 w-3.5" />
      {vertical && <span>New session</span>}
    </button>
  );

  const overflowControl = hiddenIds.size > 0 && (
    <div
      ref={menuRef}
      className={cn(
        "relative flex shrink-0 items-stretch",
        !vertical && "border-l border-[var(--border)]",
      )}
    >
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        title={`${hiddenIds.size} tab${hiddenIds.size === 1 ? "" : "s"} out of view`}
        data-testid="session-tabs-overflow"
        className={cn(
          "flex shrink-0 items-center gap-1 px-2 text-[11px] text-[var(--muted)] hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]",
          menuOpen && "bg-[var(--panel-2)]/60 text-[var(--foreground)]",
        )}
      >
        {/* The column's menu opens upward from its footer. */}
        <ChevronDown className={cn("h-3 w-3", vertical && "rotate-180")} />
        <span className="font-mono">{hiddenIds.size}</span>
      </button>
      {menuOpen && (
        <div
          data-testid="session-tabs-overflow-menu"
          className={cn(
            "absolute z-30 w-72 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] shadow-2xl",
            vertical
              ? cn("bottom-full mb-px", placement === "right" ? "right-0" : "left-0")
              : "right-0 top-full mt-px",
          )}
        >
          <div className="border-b border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            Tabs out of view ({hiddenIds.size})
          </div>
          <ul className="max-h-72 overflow-y-auto scroll-thin">
            {tabs
              .map((t, i) => ({ t, shortcut: shortcutForTabIndex(i, tabs.length) }))
              .filter(({ t }) => hiddenIds.has(t.id))
              .map(({ t, shortcut }) => (
                <li
                  key={t.id}
                  className="flex items-center gap-1 pr-2 text-[11px] hover:bg-[var(--panel-2)]"
                >
                  {/* Row = select button + sibling pin / close buttons (not
                      nested — a <button> inside a <button> is invalid HTML). */}
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      selectAndReveal(t.id);
                    }}
                    data-testid="session-tabs-overflow-item"
                    data-tab-id={t.id}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
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
                  </button>
                  {onTogglePin && (
                    <button
                      type="button"
                      data-testid="session-tabs-overflow-pin"
                      data-tab-pinned={t.pinned ? "true" : "false"}
                      onClick={() => onTogglePin(t.id)}
                      title={t.pinned ? "Unpin tab" : "Pin tab"}
                      aria-label={t.pinned ? "Unpin tab" : "Pin tab"}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--panel)]",
                        t.pinned
                          ? "text-[var(--accent)]"
                          : "text-[var(--muted)] hover:text-[var(--foreground)]",
                      )}
                    >
                      <Pin className={cn("h-3 w-3", t.pinned && "fill-current")} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onClose(t.id)}
                    title="Close tab"
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );

  const closeAllButton = tabs.length > 0 && (
    <button
      type="button"
      onClick={onCloseAll}
      title="Close all tabs"
      className={cn(
        "flex w-8 shrink-0 items-center justify-center text-[var(--muted)] hover:bg-[var(--panel-2)]/60 hover:text-[var(--foreground)]",
        vertical ? "ml-auto" : "border-l border-[var(--border)]",
      )}
    >
      <XSquare className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <div
      data-pane-name="session-tabs"
      data-testid="session-tabs"
      data-tab-placement={placement}
      onContextMenu={onStripContextMenu}
      style={vertical ? { width: effectiveWidth + VERTICAL_CHROME_PX } : undefined}
      className={cn(
        "flex shrink-0 bg-[var(--panel)]",
        vertical
          ? cn(
              "relative h-full flex-col border-[var(--border)]",
              placement === "left" ? "border-r" : "border-l",
            )
          : "h-9 items-stretch border-b border-[var(--border)]",
      )}
    >
      <div className={cn("flex flex-1", vertical ? "min-h-0 flex-col" : "min-w-0 items-stretch")}>
        {/*
          Viewport wrapper: content-sized while everything fits, shrinks to
          the available space once it doesn't (min-w-0 / min-h-0) — at which
          point the inner scroller takes over. Also anchors the edge fades,
          which must sit OUTSIDE the scroller or they'd scroll with the tabs.
        */}
        <div className={cn("relative flex", vertical ? "min-h-0 flex-col" : "min-w-0 items-stretch")}>
          <div
            ref={stripRef}
            data-testid="session-tabs-scroller"
            className={cn(
              "scroll-none relative flex",
              vertical
                ? "min-h-0 flex-col overflow-y-auto overflow-x-hidden overscroll-y-contain"
                : "min-w-0 items-stretch gap-px overflow-x-auto overflow-y-hidden overscroll-x-contain",
            )}
          >
            {tabs.map((t, i) => {
              const active = t.id === activeId;
              // Pinned-but-inactive tabs render compact (Chrome-style) in the
              // horizontal strip: a small pin glyph only, no label, so they
              // occupy minimal width. They expand to show the name the moment
              // they become active. Unpinning a compact tab is a two-step
              // (select → unpin button appears) — same as Chrome's pinned tabs
              // hiding their close affordance. The vertical column has a fixed
              // width, so compacting would save nothing there: pinned tabs
              // keep their label and just show the pin.
              const compact = !!t.pinned && !active && !vertical;
              // "Hidden" = not fully inside the scroll viewport. The tab is
              // still rendered; it's listed in the chevron jump menu.
              const hidden = hiddenIds.has(t.id);
              const isBeingDragged = drag?.id === t.id;
              const shift = shiftFor(i);
              const shortcut = shortcutForTabIndex(i, tabs.length);
              // Only surface the chord hint when the numeric shortcut actually
              // has a binding — when the user disabled it the visual digit
              // still labels the tab, but advertising a keypress that does
              // nothing would mislead.
              const shortcutHint =
                shortcut != null && bindingByNumber ? `\nShortcut: ${modHint}${shortcut}` : "";
              return (
                <div
                  key={t.id}
                  data-testid="session-tab"
                  data-tab-id={t.id}
                  data-tab-active={active ? "true" : "false"}
                  data-tab-hidden={hidden ? "true" : "false"}
                  data-tab-dragging={isBeingDragged ? "true" : "false"}
                  onPointerDown={(e) => startTabDrag(e, i)}
                  // While a drag is active, non-dragged tabs translate along the
                  // strip's axis to reveal the projected drop slot; the dragged
                  // tab itself stays in its DOM position but is rendered
                  // invisible so the floating clone is the only visible
                  // representation.
                  style={{
                    transform: shift
                      ? vertical
                        ? `translateY(${shift}px)`
                        : `translateX(${shift}px)`
                      : undefined,
                    transition: drag && !isBeingDragged ? "transform 140ms ease" : undefined,
                    opacity: isBeingDragged ? 0 : undefined,
                    cursor: drag ? "grabbing" : "grab",
                  }}
                  className={cn(
                    "group relative flex shrink-0 items-center gap-1.5 text-[11px] select-none",
                    vertical
                      ? "h-8 w-full border-b border-[var(--border)] px-2"
                      : cn("border-r border-[var(--border)]", compact ? "px-1.5" : "px-2"),
                    // Active tab signalling (works across all 7 themes):
                    //   1. Lighter background (--panel-2) so the tab reads as
                    //      "raised" off the strip (--panel).
                    //   2. A 2px accent line on the strip's outer edge (theme
                    //      accent color) — the only signal that survives every
                    //      palette unchanged.
                    //   3. font-medium on the label (applied below) for a third
                    //      perceptual channel.
                    active
                      ? cn(
                          "bg-[var(--panel-2)] text-[var(--foreground)] before:absolute before:bg-[var(--accent)] before:content-['']",
                          activeEdge,
                        )
                      : "bg-[var(--panel)]/40 text-[var(--muted)] hover:bg-[var(--panel-2)]/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      // After a drag, the browser still fires a click on the
                      // same element — suppress that so dropping a tab doesn't
                      // also re-select it (which would steal focus from
                      // whatever the user actually wanted to look at).
                      if (dragSuppressClickRef.current) return;
                      onSelect(t.id);
                      // Clicking the already-active tab doesn't change
                      // activeId, so the layout effect won't re-reveal it —
                      // scroll a partially-visible active tab into view here.
                      if (active) revealActive(t.id);
                    }}
                    onAuxClick={(e) => {
                      if (e.button === 1) onClose(t.id); // middle-click closes
                    }}
                    className={cn("flex min-w-0 items-center gap-1.5", vertical && "flex-1")}
                    title={`${t.label ?? t.id}\n${t.status}${shortcutHint}`}
                  >
                    {compact ? (
                      // Compact pinned tab: a small pin glyph plus the numeric
                      // shortcut hint stand in for the whole tab. The number
                      // keeps the tab jumpable (⌘-N) and easy to target by eye
                      // even without its label. Clicking selects the session,
                      // which makes it active and expands it to reveal the
                      // name + unpin control.
                      <>
                        <Pin
                          data-testid="session-tab-pin-indicator"
                          className="h-2.5 w-2.5 shrink-0 fill-current text-[var(--accent)]"
                          aria-hidden
                        />
                        {shortcut != null && (
                          <span
                            data-testid="session-tab-shortcut"
                            aria-hidden
                            className="shrink-0 font-mono text-[9px] leading-none tabular-nums text-[var(--muted)]/60"
                          >
                            {shortcut}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <StatusDot status={t.status} />
                        {shortcut != null && (
                          // Sits OUTSIDE the truncated label so narrow tabs
                          // don't clip the digit. Mirrors the iTerm hint in the
                          // tab itself.
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
                          // The vertical column truncates against its own
                          // width (sized from effectiveWidth on the root).
                          style={vertical ? undefined : { maxWidth: `${effectiveWidth}px` }}
                          className={cn("min-w-0 truncate font-mono", active && "font-medium")}
                        >
                          {t.label ?? t.id.slice(0, 8)}
                        </span>
                      </>
                    )}
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
                  {onTogglePin && !compact && (
                    <button
                      type="button"
                      data-no-drag
                      data-testid="session-tab-pin"
                      data-tab-pinned={t.pinned ? "true" : "false"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin(t.id);
                      }}
                      title={t.pinned ? "Unpin tab" : "Pin tab"}
                      aria-label={t.pinned ? "Unpin tab" : "Pin tab"}
                      aria-pressed={t.pinned ? true : false}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--panel-2)]",
                        t.pinned
                          ? "text-[var(--accent)]"
                          : "text-[var(--muted)] opacity-0 hover:text-[var(--foreground)] group-hover:opacity-100",
                      )}
                    >
                      <Pin className={cn("h-3 w-3", t.pinned && "fill-current")} />
                    </button>
                  )}
                  {!compact && (
                    <button
                      type="button"
                      data-no-drag
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(t.id);
                      }}
                      title="Close tab"
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
                        !active && "opacity-0 group-hover:opacity-100",
                      )}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  {/*
                    Drag handle on the right edge of every horizontal tab.
                    Widths are global — dragging any tab's handle resizes them
                    all in lockstep, with the chosen value persisted via
                    onLabelWidthChange. Marked `data-no-drag` so it does NOT
                    engage the reorder drag. Hidden on compact pinned tabs
                    (no label to resize) and in the vertical column, which has
                    one handle on its inner edge instead.
                  */}
                  {!compact && !vertical && (
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
                  )}
                </div>
              );
            })}
          </div>
          {edges.before && (
            <div
              aria-hidden
              data-testid="session-tabs-fade-start"
              style={vertical ? { height: EDGE_FADE_PX } : { width: EDGE_FADE_PX }}
              className={cn(
                "pointer-events-none absolute from-[var(--panel)] to-transparent",
                vertical ? "inset-x-0 top-0 bg-gradient-to-b" : "inset-y-0 left-0 bg-gradient-to-r",
              )}
            />
          )}
          {edges.after && (
            <div
              aria-hidden
              data-testid="session-tabs-fade-end"
              style={vertical ? { height: EDGE_FADE_PX } : { width: EDGE_FADE_PX }}
              className={cn(
                "pointer-events-none absolute from-[var(--panel)] to-transparent",
                vertical ? "inset-x-0 bottom-0 bg-gradient-to-t" : "inset-y-0 right-0 bg-gradient-to-l",
              )}
            />
          )}
        </div>
        {plusButton}
      </div>
      {vertical ? (
        (overflowControl || closeAllButton) && (
          <div className="flex h-8 shrink-0 items-stretch border-t border-[var(--border)]">
            {overflowControl}
            {closeAllButton}
          </div>
        )
      ) : (
        <>
          {overflowControl}
          {closeAllButton}
        </>
      )}
      {vertical && (
        // One resize handle for the whole column, on its inner edge (the side
        // facing the chat). Drives the same persisted label width as the
        // per-tab handles in the horizontal strip.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize tab column"
          data-no-drag
          data-testid="session-tabs-column-resize"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          className={cn(
            "absolute top-0 z-10 h-full w-1 cursor-ew-resize select-none hover:bg-[var(--accent)]/40",
            placement === "left" ? "-right-0.5" : "-left-0.5",
          )}
        />
      )}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          role="menu"
          data-testid="session-tabs-context-menu"
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 70 }}
          className="w-48 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-[11px] text-[var(--foreground)] shadow-2xl"
        >
          {ctxTab && (
            <>
              {onTogglePin && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="session-tabs-context-pin"
                  onClick={() => {
                    setCtxMenu(null);
                    onTogglePin(ctxTab.id);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[var(--panel-2)]"
                >
                  <Pin className="h-3.5 w-3.5 text-[var(--muted)]" />
                  {ctxTab.pinned ? "Unpin tab" : "Pin tab"}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                data-testid="session-tabs-context-close"
                onClick={() => {
                  setCtxMenu(null);
                  onClose(ctxTab.id);
                }}
                className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[var(--panel-2)]"
              >
                <X className="h-3.5 w-3.5 text-[var(--muted)]" />
                Close tab
              </button>
              {onPlacementChange && <div className="my-1 border-t border-[var(--border)]" />}
            </>
          )}
          {onPlacementChange && (
            <>
              <div className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Tab placement
              </div>
              {PLACEMENT_OPTIONS.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={placement === value}
                  data-testid="session-tabs-placement-option"
                  data-placement={value}
                  onClick={() => {
                    setCtxMenu(null);
                    if (value !== placement) onPlacementChange(value);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[var(--panel-2)]"
                >
                  <Icon className="h-3.5 w-3.5 text-[var(--muted)]" />
                  <span className="flex-1">{label}</span>
                  {placement === value && <Check className="h-3 w-3 text-[var(--accent)]" />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {drag &&
        (() => {
          // Floating clone of the dragged tab. Rendered as a sibling of the
          // tab strip rather than inside it so transforms / overflow on the
          // strip don't clip the clone as the user drags past the edge.
          const t = tabs[drag.fromIdx];
          if (!t) return null;
          const dragShortcut = shortcutForTabIndex(drag.fromIdx, tabs.length);
          // Mirror the compact-pinned rendering so the floating clone matches
          // the (narrow) source slot it was lifted from.
          const dragCompact = !!t.pinned && t.id !== activeId && !vertical;
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
              {dragCompact ? (
                <Pin className="h-2.5 w-2.5 shrink-0 fill-current text-[var(--accent)]" aria-hidden />
              ) : (
                <>
                  <StatusDot status={t.status} />
                  {t.pinned && (
                    <Pin className="h-3 w-3 shrink-0 fill-current text-[var(--accent)]" aria-hidden />
                  )}
                  {dragShortcut != null && (
                    <span
                      aria-hidden
                      className="shrink-0 font-mono text-[9px] leading-none text-[var(--muted)] tabular-nums"
                    >
                      {dragShortcut}
                    </span>
                  )}
                  <span
                    style={vertical ? undefined : { maxWidth: `${effectiveWidth}px` }}
                    className="min-w-0 truncate font-mono"
                  >
                    {t.label ?? t.id.slice(0, 8)}
                  </span>
                </>
              )}
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
      : // CC 2.1.212 — a session blocked on a prompt needs the user; pulsing
        // amber draws the eye (distinct from the static amber of "starting").
        status === "needs_input"
        ? "bg-amber-400 animate-pulse"
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
      title={status === "needs_input" ? "Needs input" : undefined}
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)}
      aria-hidden={status === "needs_input" ? undefined : true}
    />
  );
}

/** Helper: derive the right TabStatus for the *active* tab from useSession state. */
export function activeTabStatus(opts: {
  ready: boolean;
  pending: boolean;
  hasError: boolean;
  /** CC 2.1.212 — the active session is blocked on a user prompt. */
  needsInput?: boolean;
}): TabStatus {
  if (opts.hasError) return "error";
  if (!opts.ready) return "starting";
  if (opts.needsInput) return "needs_input";
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
 *   3. A readable date label derived from the session's `createdAt` timestamp,
 *      e.g. "Jun 30 at 2:15 PM". Computed at display
 *      time only — NOT persisted to the DB — so it never clobbers the SDK's
 *      aiTitle (CC 2.1.196 parity: readable default names for sessions at start).
 *   4. The first 8 characters of the session id as the last-resort fallback.
 */

/**
 * Format a session creation timestamp into a human-readable label.
 * Produces locale-aware output: "Jun 30 at 2:15 PM" (current year) or
 * "Jun 30, 2024 at 2:15 PM" (older). The label is computed in the user's browser
 * locale — display-only, not stored anywhere.
 *
 * Exported for unit testing.
 */
export function readableSessionLabel(createdAt: number): string {
  const d = new Date(createdAt);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // Always an absolute date — never "Today": a relative label goes stale
  // when a tab stays open past midnight (nothing re-renders on day change)
  // and is ambiguous when you come back to a session later.
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(
    [],
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
  return `${date} at ${time}`;
}

export function tabLabelFor(id: string, sessions: SessionInfo[], titleOverride?: string | null): string {
  if (titleOverride && titleOverride.trim()) return titleOverride.trim();
  const known = sessions.find((s) => s.id === id);
  if (known?.title && known.title.trim()) return known.title.trim();
  if (known?.createdAt) return readableSessionLabel(known.createdAt);
  return id.slice(0, 8);
}
