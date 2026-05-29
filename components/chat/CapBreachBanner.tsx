"use client";

import { AlertTriangle } from "lucide-react";

type Props = {
  capUsd: number;
  spentUsd: number;
  onOverride: () => void | Promise<void>;
};

export function CapBreachBanner({ capUsd, spentUsd, onOverride }: Props) {
  return (
    <div className="border-y border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-200">
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          Session spending cap reached:{" "}
          <span className="font-mono">${spentUsd.toFixed(3)}</span> of{" "}
          <span className="font-mono">${capUsd.toFixed(2)}</span>. Send is paused.
        </span>
        <button
          type="button"
          onClick={() => void onOverride()}
          className="shrink-0 rounded-md border border-red-500/40 bg-red-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-red-500/30"
          title="Lift the cap for the rest of today only"
        >
          Continue (override)
        </button>
      </div>
    </div>
  );
}
