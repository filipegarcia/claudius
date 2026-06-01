"use client";

import { AlertTriangle, X } from "lucide-react";
import type { LongContextCreditsNudgeEvent } from "@/lib/shared/events";

/**
 * Where the "/usage-credits" route on the CLI points users — the same place
 * the Claude Code TUI links to in its long-context credits-required hint.
 * Externalized so the panel and any future caller share one canonical URL.
 */
export const USAGE_CREDITS_URL = "https://claude.ai/settings/usage";

/**
 * One-shot banner mirroring the Claude Code TUI line "Extra usage is required
 * for long context · run /usage-credits to turn them on, or /model to switch
 * to standard context". Fired by the server when a session running with the
 * 1M-context beta hits the SDK's structured `billing_error` (see
 * `lib/server/long-context-credits-detector.ts` + the
 * `noteLongContextCreditsObservation` gate in `Session`).
 *
 * Two-route remediation matches the CLI: the billing-side fix
 * (`/usage-credits` -> claude.ai/settings/usage) and the same-session fallback
 * (`/model` -> open the model picker). Live-only on the wire (skipped in the
 * SSE replay loop) so a stale banner never re-pops on reload; dismiss is
 * client-state, the server's fire-once guard prevents re-emission inside one
 * session lifetime.
 */
export function LongContextCreditsPanel({
  nudge,
  onOpenModelPicker,
  onDismiss,
}: {
  nudge: LongContextCreditsNudgeEvent | null;
  onOpenModelPicker: () => void;
  onDismiss: () => void;
}) {
  if (!nudge) return null;
  return (
    <div
      data-pane-name="long-context-credits"
      className="border-y border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1">
          Extra usage is required for long context. Turn on{" "}
          <a
            href={USAGE_CREDITS_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:opacity-80"
          >
            usage credits
          </a>{" "}
          to keep the 1M window, or switch to a standard-context model.
        </span>
        <button
          type="button"
          onClick={onOpenModelPicker}
          className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-500/30"
          title="Open the model picker to switch to standard context"
        >
          Switch model
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
