"use client";

import { ShieldAlert, X } from "lucide-react";

type Props = {
  /** Session the page load declined to reopen, or null to render nothing. */
  sessionId: string | null;
  onOpenAnyway: () => void;
  onDismiss: () => void;
};

/**
 * CC 2.1.301 ([VSCode] "Fixed a conversation that crashes or freezes the
 * panel being reopened on every reload"). Shown at the top of the fresh
 * session the page opened instead of one whose last load never finished —
 * so a conversation that crashes or freezes the page doesn't reopen on every
 * reload. "Open anyway" retries it deliberately; it is still in the session
 * list and tab strip.
 */
export function SkippedSessionNotice({ sessionId, onOpenAnyway, onDismiss }: Props) {
  if (!sessionId) return null;
  return (
    <div
      data-testid="skipped-session-notice"
      role="status"
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-200"
    >
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <strong>Started a new session.</strong> Session{" "}
        <span className="font-mono">{sessionId.slice(0, 8)}</span> didn&apos;t finish opening last time (the page
        crashed or froze), so it wasn&apos;t reopened automatically.
      </span>
      <button
        type="button"
        data-testid="skipped-session-open-anyway"
        onClick={onOpenAnyway}
        className="ml-auto shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] hover:bg-amber-500/20"
        title="Try to open that session again"
      >
        Open anyway
      </button>
      <button
        type="button"
        data-testid="skipped-session-dismiss"
        onClick={onDismiss}
        className="flex shrink-0 items-center rounded-md p-0.5 text-amber-400 hover:bg-amber-500/20"
        title="Dismiss"
        aria-label="Dismiss notice"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
