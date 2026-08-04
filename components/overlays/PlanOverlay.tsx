"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, ListChecks, Maximize2, Pencil, X } from "lucide-react";
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
  const [minimized, setMinimized] = useState(false);

  const isDirty = editing && draft.trim() !== plan.plan.trim();

  // Minimized: collapse to a restorable pill so the user can read the agent's
  // reasoning behind the overlay without losing the pending plan (and without
  // an accidental backdrop click dismissing it).
  //
  // Rendered through a portal to <body> so it escapes the deep chat DOM: an
  // inline `fixed` pill lands on top of the composer bar, where the composer's
  // stacking context swallows the click. The portal + `z-[70]` (above the
  // composer's z-[60] and the overlay's z-50) guarantees it's clickable, and
  // `bottom-24` lifts it clear of the input bar.
  if (minimized) {
    if (typeof document === "undefined") return null;
    return createPortal(
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-24 right-6 z-[70] flex items-center gap-2 rounded-full border border-violet-500/40 bg-[var(--panel)] px-4 py-2 text-sm shadow-2xl hover:bg-[var(--panel-2)]"
        title="Restore the plan for review"
      >
        <ListChecks className="h-4 w-4 text-violet-300" />
        <span className="font-medium">Plan ready for review</span>
        <Maximize2 className="h-3.5 w-3.5 text-[var(--muted)]" />
      </button>,
      document.body,
    );
  }

  return (
    <Overlay
      title="Plan ready for review"
      subtitle="ExitPlanMode"
      onClose={onClose}
      width={1024}
      maxHeightVh={88}
      dismissOnBackdrop={false}
      onMinimize={() => setMinimized(true)}
    >
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
          className="block max-h-[70vh] min-h-[55vh] w-full resize-y bg-[var(--panel)] px-4 py-4 font-mono text-xs leading-relaxed text-[var(--foreground)] outline-none focus:bg-[var(--panel-2)]"
        />
      ) : (
        <div className="max-h-[70vh] overflow-y-auto scroll-thin px-4 py-4 text-sm leading-7">
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
