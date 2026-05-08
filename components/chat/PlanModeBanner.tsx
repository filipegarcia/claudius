"use client";

import { ListChecks, X } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

type Props = {
  mode: PermissionMode;
  onExit: () => void;
};

export function PlanModeBanner({ mode, onExit }: Props) {
  if (mode !== "plan") return null;
  return (
    <div className="flex items-center gap-2 border-b border-violet-500/30 bg-violet-500/10 px-4 py-1.5 text-[11px] text-violet-200">
      <ListChecks className="h-3.5 w-3.5" />
      <span>
        <strong>Plan mode</strong> — Claude will produce a plan and propose it before any tool side
        effects. Use the plan overlay to accept (switches to acceptEdits) or stay in plan mode to
        iterate.
      </span>
      <button
        onClick={onExit}
        className="ml-auto flex items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] hover:bg-violet-500/20"
        title="Exit plan mode"
      >
        <X className="h-3 w-3" /> Exit
      </button>
    </div>
  );
}
