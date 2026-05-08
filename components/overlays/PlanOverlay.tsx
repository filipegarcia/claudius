"use client";

import { Check, ListChecks, X } from "lucide-react";
import { Overlay } from "./Overlay";
import { Markdown } from "@/components/chat/Markdown";
import type { PendingPlan } from "@/lib/client/types";

type Props = {
  plan: PendingPlan;
  onAccept: () => void;
  onReject: () => void;
  onClose: () => void;
};

export function PlanOverlay({ plan, onAccept, onReject, onClose }: Props) {
  return (
    <Overlay title="Plan ready for review" subtitle="ExitPlanMode" onClose={onClose} width={760}>
      <div className="border-b border-violet-500/30 bg-violet-500/10 px-4 py-2 text-[11px] text-violet-200">
        <ListChecks className="mr-1 inline h-3.5 w-3.5 align-middle" />
        Claude has produced a plan. Accepting will switch this session to <code className="font-mono">acceptEdits</code> so the agent can execute it.
      </div>
      <div className="max-h-[55vh] overflow-y-auto scroll-thin px-4 py-4 text-sm leading-7">
        <Markdown>{plan.plan}</Markdown>
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
        <button
          onClick={onAccept}
          className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90"
        >
          <Check className="h-3.5 w-3.5" /> Accept &amp; execute
        </button>
        <button
          onClick={onReject}
          className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
        >
          <X className="h-3.5 w-3.5" /> Reject &amp; iterate
        </button>
        <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">tool_use_id={plan.toolUseId}</span>
      </div>
    </Overlay>
  );
}
