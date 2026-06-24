"use client";

import type { ContextSummary } from "@/lib/client/useContextWatcher";
import { cn } from "@/lib/utils/cn";

type Props = {
  /**
   * Context usage for the active session. Owned by the parent (the workspace
   * page already runs a single `useContextWatcher`) and passed down — ContextBar
   * is purely presentational. It used to run its OWN watcher, which meant two
   * pollers hit `/api/sessions/:id/context` for the same session; each call is a
   * 1–3s SDK round-trip, so the duplicate doubled the slow-request load and the
   * HTTP/1.1 connection-slot pressure. Null until the first poll lands.
   */
  summary: ContextSummary | null;
  /** Open the full context-window breakdown overlay. */
  onOpenContext?: () => void;
};

export function ContextBar({ summary, onOpenContext }: Props) {
  const ctx = summary;
  const pct = ctx?.percentage ?? 0;
  const total = ctx?.totalTokens ?? 0;
  const max = ctx?.maxTokens ?? 0;

  const bar =
    pct > 95
      ? "bg-red-500"
      : pct > 80
        ? "bg-amber-500"
        : pct > 50
          ? "bg-[var(--accent)]"
          : "bg-[var(--muted)]/60";

  const inner = (
    <>
      <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--muted)]">
        <span>Context</span>
        <span className="font-mono">{ctx ? `${pct.toFixed(0)}%` : "—"}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel)]">
        <div
          className={`h-full transition-all ${bar}`}
          style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
        />
      </div>
    </>
  );

  const sharedClass = cn(
    "mb-3 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1.5 text-left",
    onOpenContext && "cursor-pointer transition hover:bg-[var(--panel-2)]/80",
  );

  const title = ctx
    ? `${total.toLocaleString()} / ${max.toLocaleString()} tokens (${pct.toFixed(1)}%)`
    : "Context usage — measuring…";

  if (onOpenContext) {
    return (
      <button type="button" className={sharedClass} title={title} onClick={onOpenContext}>
        {inner}
      </button>
    );
  }

  return (
    <div className={sharedClass} title={title}>
      {inner}
    </div>
  );
}
