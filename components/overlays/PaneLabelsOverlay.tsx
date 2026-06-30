"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * Pane-name overlay: walks `[data-pane-name]` nodes and draws a translucent
 * label on each. Used by the Customize feature so the user knows the
 * canonical pane names to refer to in chat (e.g. "modify the left-nav").
 *
 * Unlike modal overlays, this one is intentionally non-modal — the boxes are
 * fixed at the bounding rects of the underlying panes and the rest of the UI
 * remains visible and clickable. Esc or the close pill dismisses it.
 *
 * Regions nest (a card inside the right rail inside the page), so labels
 * stack at the same top-left corner and become unreadable. To fix that the
 * overlay is hover-aware: moving the pointer over a region resolves the
 * INNERMOST labeled region under it (via elementFromPoint, which sees through
 * the pointer-events-none overlay), dims every other label, and renders the
 * hovered region's label **pinned to the top of the viewport** so it stays
 * readable even when the region's own top has scrolled off-screen.
 */
type LabelRect = {
  name: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

type Hover = { name: string; top: number; left: number };

// Approx label height (px) used to clamp the pinned label inside the viewport.
const LABEL_H = 22;

function measure(): LabelRect[] {
  if (typeof document === "undefined") return [];
  const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-name]"));
  return nodes.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      name: el.dataset.paneName ?? "",
      top: r.top,
      left: r.left,
      width: r.width,
      height: r.height,
    };
  });
}

export function PaneLabelsOverlay({ onClose }: { onClose: () => void }) {
  const [rects, setRects] = useState<LabelRect[]>(() => measure());
  const [hover, setHover] = useState<Hover | null>(null);
  // Latest hover kept in a ref so the mousemove handler can de-dupe setState
  // without re-subscribing the listener on every hover change.
  const hoverRef = useRef<Hover | null>(null);

  useEffect(() => {
    function update() {
      setRects(measure());
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);

    // Hover resolution. The overlay layer is pointer-events-none, so
    // elementFromPoint returns the real UI element under the cursor; its
    // closest `[data-pane-name]` ancestor is the innermost labeled region.
    function onMove(e: MouseEvent) {
      const el = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>("[data-pane-name]");
      const next: Hover | null = el
        ? (() => {
            const r = el.getBoundingClientRect();
            return { name: el.dataset.paneName ?? "", top: r.top, left: r.left };
          })()
        : null;
      const prev = hoverRef.current;
      if (
        prev?.name === next?.name &&
        Math.round(prev?.top ?? -1) === Math.round(next?.top ?? -1) &&
        Math.round(prev?.left ?? -1) === Math.round(next?.left ?? -1)
      ) {
        return;
      }
      hoverRef.current = next;
      setHover(next);
    }
    window.addEventListener("mousemove", onMove, true);

    // Re-measure as DOM mutates (e.g., overlays appearing, banners showing).
    const mo = new MutationObserver(update);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    // Cheap RAF poll in case layout shifts due to font load / async content.
    let raf = 0;
    let lastTick = 0;
    function tick(ts: number) {
      if (ts - lastTick > 250) {
        update();
        lastTick = ts;
      }
      raf = window.requestAnimationFrame(tick);
    }
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove, true);
      mo.disconnect();
      window.cancelAnimationFrame(raf);
    };
  }, [onClose]);

  const isHovered = (r: LabelRect): boolean =>
    !!hover &&
    hover.name === r.name &&
    Math.round(hover.top) === Math.round(r.top) &&
    Math.round(hover.left) === Math.round(r.left);

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {/* Dim layer — soft so users can still see the UI underneath. */}
      <div className="absolute inset-0 bg-black/30" />
      {rects.map((r, i) => {
        const hovered = isHovered(r);
        const dimmed = hover !== null && !hovered;
        return (
          <div
            key={`${r.name}:${i}`}
            className={
              hovered
                ? "absolute border-2 border-[var(--accent)] ring-2 ring-[var(--accent)]/40"
                : "absolute border-2 border-[var(--accent)]/80 ring-1 ring-[var(--accent)]/20"
            }
            style={{ top: r.top, left: r.left, width: r.width, height: r.height, zIndex: hovered ? 3 : 1 }}
          >
            {/* Base label at the region's own corner. Dimmed while another
                region is hovered so the stack of nested tags declutters. */}
            <div
              className={`absolute left-1 top-1 rounded bg-[var(--accent)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shadow-md transition-opacity ${
                dimmed ? "opacity-20" : hovered ? "opacity-0" : "opacity-100"
              }`}
            >
              {r.name}
            </div>
          </div>
        );
      })}
      {/* Pinned label for the hovered region: clamped to stay inside the
          viewport (sticky to the top) so it's readable even when the region's
          top has scrolled above the fold. Rendered above every box. */}
      {hover && (
        <div
          className="absolute z-[45] rounded bg-[var(--accent)] px-2 py-1 font-mono text-[11px] font-semibold text-white shadow-lg ring-1 ring-black/30"
          style={{
            top: Math.min(
              Math.max(hover.top + 4, 4),
              (typeof window !== "undefined" ? window.innerHeight : 800) - LABEL_H,
            ),
            left: Math.max(hover.left + 4, 4),
          }}
        >
          {hover.name}
        </div>
      )}
      <button
        onClick={onClose}
        className="pointer-events-auto fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white shadow-lg hover:opacity-90"
      >
        Close component labels <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
