"use client";

import { AlertTriangle, X } from "lucide-react";
import type { OpusOverloadNudgeEvent } from "@/lib/shared/events";

/**
 * Default Sonnet target the "Switch to Sonnet" button hands to `setModel`.
 * The SDK resolves short ids server-side, so a user whose org is pinned to
 * an alias still lands on the same family. Exported so unit tests can pin
 * against a single source of truth.
 *
 * SDK 0.3.197 bumped the SDK's own "current Sonnet" doc examples from
 * `claude-sonnet-4-6` to `claude-sonnet-5` (`Options.model`, prompt/agent
 * hook docs in `sdk.d.ts`) — this nudge target tracks that, same as
 * `lib/shared/advisor.ts`'s `ADVISOR_SONNET_VALUE`. Illustrative examples
 * elsewhere (the slash-command catalog, workspace docs copy) still show
 * `claude-sonnet-4-6` as a still-valid, just-not-newest id — they aren't
 * "current Sonnet" assertions, so they weren't bumped.
 */
export const OPUS_OVERLOAD_NUDGE_SONNET_TARGET = "claude-sonnet-5";

/**
 * Manual-switch nudge banner mirroring the Claude Code TUI line "Opus is
 * experiencing high load, please use /model to switch to Sonnet". Fires after
 * a streak of 529 "Overloaded" errors on Opus (see
 * `lib/server/opus-overload-detector.ts` + `Session.noteOverloadObservation`).
 * Distinct from the SDK's automatic `fallbackModel` path, which swaps
 * silently — this is the manual nudge for users without a configured fallback
 * (or whose fallback also overloaded).
 *
 * Live-only on the wire (skipped in the SSE replay buffer), so a stale event
 * never re-pops on reload. Dismiss is client-state: it clears the banner for
 * the current session view; the server fire-once guard prevents re-emission
 * inside one session lifetime.
 */
export function OpusOverloadNudgePanel({
  nudge,
  onSwitchToSonnet,
  onDismiss,
}: {
  nudge: OpusOverloadNudgeEvent | null;
  onSwitchToSonnet: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  if (!nudge) return null;
  return (
    <div
      data-pane-name="opus-overload-nudge"
      className="border-y border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1">
          Opus is experiencing high load — use{" "}
          <code className="rounded bg-amber-500/15 px-1 font-mono text-[11px]">/model</code>{" "}
          to switch to Sonnet.
        </span>
        <button
          type="button"
          onClick={() => void onSwitchToSonnet()}
          className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-500/30"
          title={`Switch this session to ${OPUS_OVERLOAD_NUDGE_SONNET_TARGET}`}
        >
          Switch to Sonnet
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-amber-500/20 hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
