import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Hover tooltip for the icon-only rails (workspace switcher + left nav).
 *
 * The rails used to rely on the native `title` attribute, which only shows
 * after the OS hover delay (~1s) and is easy to miss entirely — users kept
 * asking what the gear / avatar / plug icons were. This renders an
 * immediate, styled label to the right of the tile instead.
 *
 * Usage: the hosting tile must carry `group` + `relative`; the tooltip is
 * absolutely positioned off the tile's right edge and fades in on
 * `group-hover` / `group-focus-visible`. Hosts keep their `title` /
 * `aria-label` for the accessible name (and the e2e `title` selectors);
 * this is purely the visible, immediate affordance.
 *
 * `text` may contain "\n": the first line is the primary label, remaining
 * lines render muted below it (e.g. "Drag to reorder"). `shortcut` renders
 * as a <kbd> chip next to the primary label.
 */
export function RailTooltip({
  text,
  shortcut,
  side = "right",
  className,
}: {
  text: string;
  shortcut?: string | null;
  /** Which side of the tile to hang off. Rails sit on the left edge, so "right" is the default. */
  side?: "right" | "left";
  className?: string;
}) {
  const [primary, ...rest] = text.split("\n").filter((l) => l.trim().length > 0);
  if (!primary) return null;
  const extra: ReactNode[] = rest.map((line, i) => (
    <span key={i} className="block text-[10px] text-[var(--muted)]">
      {line}
    </span>
  ));
  return (
    <span
      role="tooltip"
      data-testid="rail-tooltip"
      className={cn(
        // `pointer-events-none` so the tooltip never steals the hover it
        // depends on; `z-50` so it paints over the neighbouring rail /
        // page content it overhangs. Small transition delay avoids a
        // flicker storm when the pointer sweeps down the rail.
        // Styling mirrors the workspace tiles' `workspace-hover-label-*`
        // span so the whole rail reads as one system.
        "pointer-events-none absolute top-1/2 z-50 -translate-y-1/2 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-left text-xs text-[var(--foreground)] opacity-0 shadow-lg transition-opacity duration-100",
        "group-hover:opacity-100 group-focus-visible:opacity-100",
        side === "right" ? "left-full ml-3" : "right-full mr-3",
        className,
      )}
    >
      <span className="flex items-center gap-2">
        <span className="font-medium">{primary}</span>
        {shortcut && (
          <kbd className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--muted)]">
            {shortcut}
          </kbd>
        )}
      </span>
      {extra}
    </span>
  );
}
