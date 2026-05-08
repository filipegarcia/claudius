"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw, ScrollText, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { SessionRecap } from "@/lib/client/types";
import { Markdown } from "./Markdown";

const STORAGE_KEY = "claudius.recap-banner.expanded";

type Props = {
  recap: SessionRecap | null;
  /** True while a /recap turn is in flight — surfaces a spinner. */
  refreshing?: boolean;
  onRegenerate?: () => void;
  onDismiss?: () => void;
};

/**
 * Sticky banner that pins the latest /recap response above the message list,
 * mirroring the "what's this session about" line Claude Code's CLI shows.
 * Hidden until the user runs /recap at least once. The collapsed state
 * persists across reloads.
 */
export function RecapBanner({ recap, refreshing, onRegenerate, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v != null) setExpanded(v === "1");
    } catch {
      // ignore
    }
  }, []);

  if (!recap) return null;

  function toggle() {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

  const headline = firstLine(recap.text);

  return (
    <div
      data-testid="recap-banner"
      className="border-b border-amber-500/30 bg-amber-500/[0.06]"
    >
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2 px-4 py-1.5 text-xs">
        <ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
        <button
          onClick={toggle}
          className="flex flex-1 items-center gap-2 truncate text-left"
          title={expanded ? "Collapse recap" : "Expand recap"}
          data-testid="recap-banner-toggle"
        >
          <span className="font-medium uppercase tracking-wide text-amber-300/90 text-[10px]">
            Recap
          </span>
          {!expanded && (
            <span className="truncate text-[var(--muted)]" data-testid="recap-banner-headline">
              {headline}
            </span>
          )}
          <span
            className="ml-auto shrink-0 text-[10px] text-[var(--muted)]"
            title={recap.ts}
            data-testid="recap-banner-age"
          >
            {formatAge(recap.ts)}
          </span>
          {refreshing && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-200/80" />
          )}
        </button>
        <button
          onClick={toggle}
          aria-label={expanded ? "Collapse recap" : "Expand recap"}
          className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {onRegenerate && (
          <button
            onClick={onRegenerate}
            disabled={refreshing}
            aria-label="Regenerate recap"
            title="Regenerate recap (runs /recap)"
            className={cn(
              "rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]",
              refreshing && "cursor-not-allowed opacity-50",
            )}
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          </button>
        )}
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss recap"
            title="Hide the recap until /recap runs again"
            className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {expanded && (
        <div
          className="mx-auto w-full max-w-3xl px-4 pb-2 text-[12px] leading-snug text-[var(--foreground)]/90"
          data-testid="recap-banner-body"
        >
          <Markdown>{recap.text}</Markdown>
        </div>
      )}
    </div>
  );
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const nl = trimmed.indexOf("\n");
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
