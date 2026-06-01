"use client";

import { useEffect } from "react";
import { Cpu, X } from "lucide-react";

/**
 * Transient toast-style banner for a rejected `/model` switch — surfaces an
 * SDK rejection that `lib/server/session.ts` previously swallowed with a
 * silent `.catch(() => {})`.
 *
 * Scope note (PARTIAL feature):
 *   The Claude Code TUI's analogous string is "Remote session couldn't
 *   switch to <model>", surfaced when a remote/teleport host rejects the
 *   switch. Claudius has no remote/teleport concept — every session runs
 *   against the local SDK — so this toast carries the generic "Couldn't
 *   switch to <model>" copy and the SDK's error text underneath, rather
 *   than the remote-specific framing. The toast fires only on a non-ok
 *   POST /api/sessions/<id>/model response (HTTP 409); transient network
 *   blips intentionally don't toast (see the matching comment in
 *   `setModel` in `lib/client/use-session.ts`).
 *
 * The notice auto-fades and the picker's optimistic state is reverted to
 * the server-authoritative model in `setModel` before this renders, so the
 * SessionCard pill matches what's actually running.
 */
export type ModelSwitchNotice = {
  /** Stable across re-renders of the same notice; bumped per rejection. */
  uuid: string;
  /** Model the user attempted to switch to. Null only when the picker
   *  passed an empty string ("inherit machine default"). */
  attempted: string | null;
  /** SDK error text. Shown beneath the headline for context; may be empty. */
  error: string;
};

const AUTO_DISMISS_MS = 8_000;

export function ModelSwitchNoticePanel({
  notice,
  onDismiss,
}: {
  notice: ModelSwitchNotice | null;
  onDismiss: () => void;
}) {
  // Auto-fade — keyed on the notice uuid so a back-to-back rejection
  // (rare but possible: two picker clicks in quick succession against an
  // unavailable model) resets the timer rather than inheriting the prior one.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);

  if (!notice) return null;

  const target = notice.attempted && notice.attempted.length > 0 ? notice.attempted : "default";
  const headline = `Couldn't switch to ${target}`;

  return (
    <div
      data-pane-name="model-switch-notice"
      data-model-switch-notice="rejected"
      className="border-y border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">{headline}</span>
        {notice.error && (
          <span className="hidden truncate text-[var(--muted)] sm:inline">{notice.error}</span>
        )}
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
