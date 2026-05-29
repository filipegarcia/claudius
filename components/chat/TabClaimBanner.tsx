"use client";

import { Eye } from "lucide-react";

type Props = {
  onTakeOver: () => void;
  onOpenNew: () => void;
};

export function TabClaimBanner({ onTakeOver, onOpenNew }: Props) {
  return (
    <div className="border-y border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <Eye className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          Active in another tab — this view is read-only.
        </span>
        <button
          type="button"
          onClick={onTakeOver}
          className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-500/30"
          title="Disable input in the other tab and resume here"
        >
          Take over
        </button>
        <button
          type="button"
          onClick={onOpenNew}
          className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] font-medium hover:bg-[var(--panel)]"
          title="Start a fresh session in this tab"
        >
          Open as new session
        </button>
      </div>
    </div>
  );
}
