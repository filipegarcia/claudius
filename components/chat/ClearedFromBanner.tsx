"use client";

import { RotateCcw, X } from "lucide-react";

type Props = {
  /** The session ID that was cleared from, or null if not applicable. */
  clearedFromSessionId: string | null;
  /** Called when the user clicks the Rewind button or the banner itself. */
  onRewind: () => void;
  /** Called when the user dismisses the banner without rewinding. */
  onDismiss: () => void;
};

/**
 * Shown at the top of a freshly-cleared session.
 *
 * When the user runs /clear (or clicks the Clear button in the header),
 * Claudius spins up a new empty session. This banner lets them immediately
 * rewind back to the previous session — the same affordance CC 2.1.191
 * ships as "/rewind after /clear". Clicking "Rewind" or running /rewind
 * while the banner is visible navigates to the cleared-from session;
 * clicking × dismisses without navigating.
 *
 * The banner is tab-scoped (sessionStorage) so it survives a page refresh
 * but not a new tab.
 */
export function ClearedFromBanner({ clearedFromSessionId, onRewind, onDismiss }: Props) {
  if (!clearedFromSessionId) return null;
  return (
    <div
      data-testid="cleared-from-banner"
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-200"
    >
      <RotateCcw className="h-3.5 w-3.5 shrink-0" />
      <span>
        <strong>Session cleared.</strong> The previous conversation is preserved — rewind to return.
      </span>
      <button
        data-testid="cleared-from-banner-rewind"
        onClick={onRewind}
        className="ml-auto flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] hover:bg-amber-500/20"
        title="Return to the session before /clear"
      >
        <RotateCcw className="h-3 w-3" /> Rewind
      </button>
      <button
        data-testid="cleared-from-banner-dismiss"
        onClick={onDismiss}
        className="flex items-center rounded-md p-0.5 text-amber-400 hover:bg-amber-500/20"
        title="Dismiss"
        aria-label="Dismiss cleared-from banner"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
