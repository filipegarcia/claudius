"use client";

import { useState } from "react";
import { Check, ListChecks, Pencil, X } from "lucide-react";
import { Overlay } from "./Overlay";
import { Markdown } from "@/components/chat/Markdown";
import type { PendingPlan } from "@/lib/client/types";

type Props = {
  plan: PendingPlan;
  /**
   * Called when the user accepts the plan. If `editedPlan` is set, it
   * replaces the original plan text in the SDK's ExitPlanMode tool input —
   * see `PermissionResult.updatedInput` handling in session.ts. Pass
   * undefined to leave the original plan untouched.
   */
  onAccept: (editedPlan?: string) => void;
  onReject: () => void;
  onClose: () => void;
};

export function PlanOverlay({ plan, onAccept, onReject, onClose }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan.plan);

  const isDirty = editing && draft.trim() !== plan.plan.trim();

  return (
    <Overlay title="Plan ready for review" subtitle="ExitPlanMode" onClose={onClose} width={760}>
      <div className="border-b border-violet-500/30 bg-violet-500/10 px-4 py-2 text-[11px] text-violet-200">
        <ListChecks className="mr-1 inline h-3.5 w-3.5 align-middle" />
        Claude has produced a plan. Accepting will switch this session to <code className="font-mono">acceptEdits</code> so the agent can execute it.
        {editing && (
          <span className="ml-2 text-violet-100/80">
            · Editing — your changes ship to the SDK as the tool&apos;s effective input.
          </span>
        )}
      </div>

      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(plan.plan);
              setEditing(false);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onAccept(isDirty ? draft : undefined);
            }
          }}
          spellCheck={false}
          className="block max-h-[55vh] min-h-[40vh] w-full resize-y bg-[var(--panel)] px-4 py-4 font-mono text-xs leading-relaxed text-[var(--foreground)] outline-none focus:bg-[var(--panel-2)]"
        />
      ) : (
        <div className="max-h-[55vh] overflow-y-auto scroll-thin px-4 py-4 text-sm leading-7">
          <Markdown>{draft}</Markdown>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
        <button
          onClick={() => onAccept(isDirty ? draft : undefined)}
          className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90"
        >
          <Check className="h-3.5 w-3.5" /> {isDirty ? "Accept edited plan" : "Accept & execute"}
        </button>
        {!editing ? (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
            title="Edit the plan before accepting — your edits are sent to the SDK as the tool's input"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        ) : (
          <button
            onClick={() => {
              setDraft(plan.plan);
              setEditing(false);
            }}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
            title="Discard edits and return to the original markdown preview"
          >
            <X className="h-3.5 w-3.5" /> Discard edits
          </button>
        )}
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
