"use client";

import { LayoutPanelLeft, PanelLeft, PanelRight, PanelTop } from "lucide-react";
import { useTabPlacement, type TabPlacement } from "@/lib/client/useTabPlacement";
import { useActivityPanelCollapsed } from "@/lib/client/useActivityPanelCollapsed";
import { cn } from "@/lib/utils/cn";

const PLACEMENTS: ReadonlyArray<{
  value: TabPlacement;
  label: string;
  description: string;
  Icon: typeof PanelTop;
}> = [
  {
    value: "top",
    label: "Top",
    description: "Horizontal strip above the chat. Scroll it sideways when it overflows.",
    Icon: PanelTop,
  },
  {
    value: "left",
    label: "Left",
    description: "Vertical column between the side nav and the chat.",
    Icon: PanelLeft,
  },
  {
    value: "right",
    label: "Right",
    description: "Vertical column on the right, next to the activity panel.",
    Icon: PanelRight,
  },
];

/**
 * Browser-local chat layout knobs:
 *   • Tab placement — where the session tab strip docks (IntelliJ's
 *     Top / Left / Right). Also switchable by right-clicking the strip.
 *   • Activity panel — whether the right-hand Activity panel is expanded or
 *     collapsed to its slim stripe. Also toggled from the panel's own header.
 * Lives alongside the other browser-local sections rather than inside
 * settings.json.
 */
export function LayoutSection() {
  const { placement, setPlacement } = useTabPlacement();
  const { collapsed, setCollapsed } = useActivityPanelCollapsed();

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div className="flex items-start gap-2">
        <LayoutPanelLeft className="mt-px h-3.5 w-3.5 text-[var(--accent)]" />
        <div>
          <h2 className="text-sm font-medium">Layout</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            How the chat screen is arranged. Stored per browser.
          </p>
        </div>
      </div>

      <div className="mt-3 text-xs font-medium">Tab placement</div>
      <p className="mt-0.5 text-[11px] text-[var(--muted)]">
        Where the session tabs dock around the chat. You can also switch it by
        right-clicking the tab strip.
      </p>
      <div role="radiogroup" aria-label="Tab placement" className="mt-2 grid gap-2 sm:grid-cols-3">
        {PLACEMENTS.map(({ value, label, description, Icon }) => {
          const selected = placement === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid="tab-placement-option"
              data-placement={value}
              onClick={() => setPlacement(value)}
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border p-2 text-left",
                selected
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border)] bg-[var(--panel-2)]/40 hover:bg-[var(--panel-2)]",
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
              <span className="text-[10px] text-[var(--muted)]">{description}</span>
            </button>
          );
        })}
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2">
        <input
          type="checkbox"
          checked={!collapsed}
          onChange={(e) => setCollapsed(!e.target.checked)}
          data-testid="activity-panel-show-toggle"
          className="mt-0.5 h-3.5 w-3.5"
        />
        <div className="flex-1">
          <div className="text-xs font-medium">Show the Activity panel</div>
          <div className="text-[11px] text-[var(--muted)]">
            The right-hand panel with the session card, context, to-dos and
            tools. Turned off, it collapses to a slim stripe that still shows
            when Claude is working and your unread notifications — click it to
            expand. Same as the collapse button in the panel&rsquo;s header.
          </div>
        </div>
      </label>
    </section>
  );
}
