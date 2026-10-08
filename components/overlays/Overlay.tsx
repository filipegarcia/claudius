"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, X } from "lucide-react";

type Props = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  /**
   * When false, clicking the backdrop and pressing Escape no longer close the
   * overlay — only explicit controls (the X, or the consumer's own buttons)
   * dismiss it. Defaults to true. Use for overlays where an accidental
   * backdrop click would drop unrecoverable state (e.g. a pending plan).
   */
  dismissOnBackdrop?: boolean;
  /**
   * When provided, a minimize button appears in the header. The consumer owns
   * the minimized state and what to render in its place (e.g. a restore pill).
   */
  onMinimize?: () => void;
  /** Max height of the overlay as a viewport-height percentage. Defaults to 80. */
  maxHeightVh?: number;
  /**
   * When false, no dimmed/blurred backdrop is drawn and the overlay becomes
   * non-modal: clicks outside the panel reach the app underneath (so
   * `dismissOnBackdrop` only governs Escape). Defaults to true.
   */
  backdrop?: boolean;
  /**
   * When true, the panel can be moved by dragging its header. The position is
   * clamped to the viewport (below the desktop title bar) and kept there on
   * window resize. Pair with `backdrop={false}` for a floating window the user
   * can park out of the way.
   */
  draggable?: boolean;
};

type Offset = { x: number; y: number };
/** The panel's un-dragged layout slot plus its size, in viewport px. */
type PanelBox = { left: number; top: number; width: number; height: number };

/** Keep the dragged panel fully on screen and clear of the desktop title bar. */
function clampOffset(x: number, y: number, box: PanelBox): Offset {
  const minTop =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--titlebar-height")) || 0;
  const maxLeft = Math.max(0, window.innerWidth - box.width);
  const maxTop = Math.max(minTop, window.innerHeight - box.height);
  return {
    x: Math.min(maxLeft, Math.max(0, box.left + x)) - box.left,
    y: Math.min(maxTop, Math.max(minTop, box.top + y)) - box.top,
  };
}

export function Overlay({
  title,
  subtitle,
  onClose,
  children,
  width = 640,
  dismissOnBackdrop = true,
  onMinimize,
  maxHeightVh = 80,
  backdrop = true,
  draggable = false,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerX: number; pointerY: number; start: Offset; box: PanelBox } | null>(null);

  // A window resize moves the panel's centered layout slot, which can push a
  // dragged panel off screen — pull it back inside.
  useEffect(() => {
    if (!draggable) return;
    function onResize() {
      setOffset((prev) => {
        const el = panelRef.current;
        if (!el || (prev.x === 0 && prev.y === 0)) return prev;
        const r = el.getBoundingClientRect();
        return clampOffset(prev.x, prev.y, {
          left: r.left - prev.x,
          top: r.top - prev.y,
          width: r.width,
          height: r.height,
        });
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draggable]);

  function onDragStart(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const el = panelRef.current;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    dragRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      start: offset,
      box: { left: r.left - offset.x, top: r.top - offset.y, width: r.width, height: r.height },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onDragMove(e: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset(
      clampOffset(
        drag.start.x + e.clientX - drag.pointerX,
        drag.start.y + e.clientY - drag.pointerY,
        drag.box,
      ),
    );
  }
  function onDragEnd(e: React.PointerEvent<HTMLElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  useEffect(() => {
    if (!dismissOnBackdrop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dismissOnBackdrop]);

  return (
    <div
      className={
        "fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh] " +
        // Without a backdrop the full-screen layer must not swallow clicks
        // meant for the app underneath; the panel opts back in below.
        (backdrop ? "bg-black/60 backdrop-blur-sm" : "pointer-events-none")
      }
      onClick={backdrop && dismissOnBackdrop ? onClose : undefined}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: `min(${width}px, 92vw)`,
          maxHeight: `${maxHeightVh}vh`,
          transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
        }}
        className="pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <header
          className={
            "flex items-start gap-3 border-b border-[var(--border)] px-4 py-3" +
            (draggable ? " cursor-move touch-none select-none" : "")
          }
          {...(draggable && {
            onPointerDown: onDragStart,
            onPointerMove: onDragMove,
            onPointerUp: onDragEnd,
            onPointerCancel: onDragEnd,
          })}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{subtitle ?? "Claudius"}</div>
            <div className="mt-0.5 text-sm font-medium">{title}</div>
          </div>
          {onMinimize && (
            <button
              onClick={onMinimize}
              className="rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              aria-label="Minimize"
              title="Minimize"
            >
              <Minus className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto scroll-thin">{children}</div>
      </div>
    </div>
  );
}
