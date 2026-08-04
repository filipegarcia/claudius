"use client";

import { useEffect } from "react";
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
};

export function Overlay({
  title,
  subtitle,
  onClose,
  children,
  width = 640,
  dismissOnBackdrop = true,
  onMinimize,
  maxHeightVh = 80,
}: Props) {
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[8vh] backdrop-blur-sm"
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: `min(${width}px, 92vw)`, maxHeight: `${maxHeightVh}vh` }}
        className="flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-3">
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
