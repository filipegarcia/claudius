"use client";

import { ScrollText } from "lucide-react";

type Props = {
  /** SDK-derived session title (custom rename, AI auto-summary, or first prompt). */
  title: string | null;
};

/**
 * Sticky banner above the message list showing what the session is about.
 * Sourced from the SDK's session metadata (`customTitle ?? summary`),
 * surfaced via `session_title` events. Hidden until a title exists — fresh
 * sessions stay clean until the SDK has enough activity to summarize.
 *
 * Despite the name, this no longer captures `/recap` output. The SDK
 * intercepts `/recap` as a local command and never produces an assistant
 * response; richer Goal/Done/Next recaps would require sending a structured
 * prompt to Claude on demand. That layer is deferred — this banner is the
 * always-on baseline.
 */
export function RecapBanner({ title }: Props) {
  if (!title) return null;
  return (
    <div
      data-testid="recap-banner"
      className="border-b border-amber-500/30 bg-amber-500/[0.06]"
    >
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-1.5 text-xs">
        <ScrollText className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        <span className="font-medium uppercase tracking-wide text-amber-300/90 text-[10px]">
          Session
        </span>
        <span
          className="truncate text-[var(--foreground)]/90"
          data-testid="recap-banner-title"
        >
          {title}
        </span>
      </div>
    </div>
  );
}
