"use client";

import { useContextWatcher } from "@/lib/client/useContextWatcher";
import { cn } from "@/lib/utils/cn";

type Props = {
  sessionId: string | null;
  pending: boolean;
  /** Open the full context-window breakdown overlay. */
  onOpenContext?: () => void;
};

export function ContextBar({ sessionId, pending, onOpenContext }: Props) {
  const ctx = useContextWatcher(sessionId, pending);
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
