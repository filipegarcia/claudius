"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

/**
 * Pane-name overlay: walks `[data-pane-name]` nodes and draws a translucent
 * label on each. Used by the Customize feature so the user knows the
 * canonical pane names to refer to in chat (e.g. "modify the left-nav").
 *
 * Unlike modal overlays, this one is intentionally non-modal — the labels are
 * fixed at the bounding rects of the underlying panes and the rest of the UI
 * remains visible and clickable. Esc or the close pill dismisses it.
 */
type LabelRect = {
  name: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

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
      mo.disconnect();
      window.cancelAnimationFrame(raf);
    };
  }, [onClose]);

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {/* Dim layer — soft so users can still see the UI underneath. */}
      <div className="absolute inset-0 bg-black/30" />
      {rects.map((r, i) => (
        <div
          key={`${r.name}:${i}`}
          className="absolute border-2 border-[var(--accent)]/80 ring-1 ring-[var(--accent)]/20"
          style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
        >
          <div className="absolute left-1 top-1 rounded bg-[var(--accent)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shadow-md">
            {r.name}
          </div>
        </div>
      ))}
      <button
        onClick={onClose}
        className="pointer-events-auto fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white shadow-lg hover:opacity-90"
      >
        Close component labels <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
