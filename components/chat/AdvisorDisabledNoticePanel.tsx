"use client";

import { useEffect } from "react";
import { BrainCircuit, X } from "lucide-react";
import { badgeAdvisorLabel } from "@/lib/shared/advisor";

/**
 * Transient toast shown when the server cleared the advisor because the user
 * switched models (broad precaution — some model combos produce a 400 API
 * error if left in place). Provides a one-click "Re-enable" button so the
 * user can immediately restore the advisor if the new model is compatible.
 *
 * Auto-dismisses after 20 s — longer than info-only toasts since the action
 * button gives the user something to act on. Also dismissible manually via ×.
 */
export type AdvisorDisabledNotice = {
  /** Stable across re-renders of the same notice; bumped per model change. */
  uuid: string;
  /** The advisor model id that was cleared (e.g. "claude-opus-4-8"). */
  previousAdvisor: string;
  /** The new main-thread model that triggered the disable (undefined = default). */
  newModel: string | undefined;
};

export function AdvisorDisabledNoticePanel({
  notice,
  onDismiss,
  onReEnable,
}: {
  notice: AdvisorDisabledNotice | null;
  onDismiss: () => void;
  onReEnable: (advisorModel: string) => void;
}) {
  // Auto-dismiss after a longer window than info-only toasts — the user
  // may want to re-enable, so give them time to read before it fades.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDismiss, 20_000);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);

  if (!notice) return null;

  const advisorLabel = badgeAdvisorLabel(notice.previousAdvisor) ?? notice.previousAdvisor;

  return (
    <div
      data-pane-name="advisor-disabled-notice"
      data-advisor-disabled-notice="model-change"
      className="border-y border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">
          Advisor ({advisorLabel}) cleared on model change
        </span>
        <span className="hidden text-[var(--muted)] sm:inline">Re-enable if needed.</span>
        <button
          type="button"
          onClick={() => onReEnable(notice.previousAdvisor)}
          className="ml-auto shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-amber-200 hover:bg-amber-500/20"
        >
          Re-enable
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
