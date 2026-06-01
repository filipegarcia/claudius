"use client";

import { Loader2, ScrollText, X } from "lucide-react";
import type { ChatState } from "@/lib/client/types";

/**
 * "Where were we?" recap banner — Claudius's port of the Claude Code TUI's
 * away-summary line. Renders above the composer when:
 *
 *   1. The user has just returned to a tab after a long blur (≥5min), so the
 *      `useAwayRecap` hook fired `requestRecap("away")` and the server
 *      broadcast a `session_recap` event back over SSE.
 *   2. The user explicitly invoked a manual `/recap`.
 *
 * Live-only on the SSE wire — the server doesn't replay the underlying
 * event on reconnect, so this banner only ever shows the most recent recap
 * for the current session lifetime in this tab. The next user prompt clears
 * it (see `setSessionRecap` in `use-session.ts`'s `send` callback).
 *
 * Distinct from the misnamed `RecapBanner.tsx` next door, which is the
 * persistent session-title strip — kept named that way for testid stability.
 */
export function SessionRecapBanner({
  recap,
  onDismiss,
}: {
  recap: ChatState["sessionRecap"];
  onDismiss: () => void;
}) {
  // `idle` is the resting state — no banner. We render for `loading` (spinner
  // while the server generates), `ready` (the recap text), and `error` (a
  // one-liner with a retry hint). On `error` the auto-trigger paths have
  // intentionally been mapped to idle server-side, so this only shows for
  // genuine generation failures.
  if (recap.status === "idle") return null;

  return (
    <div
      data-pane-name="session-recap"
      data-testid="session-recap-banner"
      className="border-y border-[var(--border)] bg-[var(--panel-2)]/60 px-4 py-1.5 text-xs"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-start gap-2">
        {recap.status === "loading" ? (
          <Loader2
            className="mt-[2px] h-3.5 w-3.5 shrink-0 animate-spin text-[var(--muted)]"
            aria-hidden
          />
        ) : (
          <ScrollText
            className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1 leading-snug">
          {recap.status === "loading" ? (
            <span className="italic text-[var(--muted)]">
              Generating recap…
            </span>
          ) : recap.status === "error" ? (
            // The TUI's failure copy is "Couldn't generate a recap. Run with
            // --debug for details." — we mirror the first sentence and drop
            // the debug hint (no equivalent in the browser).
            <span className="italic text-[var(--muted)]">
              Couldn&apos;t generate a recap.
              {recap.errorReason ? ` (${recap.errorReason})` : null}
            </span>
          ) : (
            <>
              <span className="font-medium text-[var(--foreground)]">
                recap:
              </span>{" "}
              <span
                className="italic text-[var(--foreground)]/85"
                data-testid="session-recap-text"
              >
                {recap.text}
              </span>{" "}
              <span className="ml-1 whitespace-nowrap text-[var(--muted)]">
                (disable recaps in /settings)
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss recap"
          data-testid="session-recap-dismiss"
          className="shrink-0 rounded p-0.5 text-[var(--muted)] transition hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
