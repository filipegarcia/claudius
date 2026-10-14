"use client";

import { useEffect } from "react";
import { ShieldAlert, X } from "lucide-react";
import { autoModeOffNoticeText } from "@/lib/shared/permission-modes";

/**
 * CC 2.1.299 parity — "Fixed SDK and headless sessions staying in auto mode
 * after the host switched to a model that doesn't support auto mode".
 *
 * Claudius is the host, so it leaves auto itself when a model switch lands
 * on a model whose catalog row says `supportsAutoMode: false` (see
 * `Session.leaveAutoIfModelUnsupported`). The mode pill flips via the usual
 * `mode_changed`; this transient banner says *why* the mode moved without
 * the user touching it. Fired from the `model_changed` handler in
 * `use-session.ts` on `autoModeOffFor`.
 */
export type AutoModeOffNotice = {
  /** Stable across re-renders of the same notice; bumped per kick-out. */
  uuid: string;
  /** Display name of the model that doesn't support auto mode. */
  model: string;
};

const AUTO_DISMISS_MS = 8_000;

export function AutoModeOffNoticePanel({
  notice,
  onDismiss,
}: {
  notice: AutoModeOffNotice | null;
  onDismiss: () => void;
}) {
  // Auto-fade — keyed on the notice so a back-to-back kick-out resets the
  // timer rather than inheriting the prior one.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);

  if (!notice) return null;

  return (
    <div
      data-pane-name="auto-mode-off-notice"
      data-testid="auto-mode-off-notice"
      role="status"
      className="border-y border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">{autoModeOffNoticeText(notice.model)}</span>
        <span className="hidden text-[var(--muted)] sm:inline">Switched to default permissions.</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="ml-auto shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
