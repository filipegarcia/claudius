"use client";

import { History, Shrink } from "lucide-react";
import {
  formatSessionAge,
  formatTokenCount,
  type ResumeSummaryOffer,
} from "@/lib/shared/resume-from-summary";

/**
 * The "Resume from summary" offer shown above the composer when the active
 * session has been idle long enough for the prompt cache to have expired and
 * is big enough that re-sending it all is expensive. Copy and choices follow
 * the Claude Code TUI's stale-resume dialog; see
 * `lib/shared/resume-from-summary.ts` for when it appears.
 *
 * An inline panel rather than a modal: the user can ignore it and type, and
 * sending a message makes the session fresh, which hides it.
 */
export function ResumeFromSummaryPanel({
  offer,
  onSummarize,
  onContinue,
  onNever,
}: {
  offer: ResumeSummaryOffer;
  /** Runs /compact. */
  onSummarize: () => void;
  /** Keep the full history; hides the offer until the session goes stale again. */
  onContinue: () => void;
  /** Turns the offer off in this browser (re-enable in Settings). */
  onNever: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[var(--chat-col)] px-4 pb-2">
      <div
        data-testid="resume-summary-offer"
        role="region"
        aria-label="Resume from summary"
        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-200"
      >
        <div className="flex items-start gap-2">
          <History className="mt-[3px] h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium" data-testid="resume-summary-title">
              {`This session is ${formatSessionAge(offer.idleMinutes)} old and ${formatTokenCount(offer.tokens)} tokens.`}
            </div>
            <div className="opacity-80">
              Resuming the full session will use a substantial portion of your usage limits. We
              recommend resuming from a summary.
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onSummarize}
                data-testid="resume-summary-compact"
                title="Run /compact: summarize the conversation so the next turn sends far fewer tokens"
                className="flex items-center gap-1 rounded-md border border-current/40 bg-current/15 px-2 py-0.5 font-medium hover:bg-current/25"
              >
                <Shrink className="h-3 w-3" />
                Resume from summary (recommended)
              </button>
              <button
                type="button"
                onClick={onContinue}
                data-testid="resume-summary-continue"
                title="Keep the full history; the next turn re-sends all of it"
                className="rounded-md border border-current/25 px-2 py-0.5 hover:bg-current/10"
              >
                Resume full session as-is
              </button>
              <button
                type="button"
                onClick={onNever}
                data-testid="resume-summary-never"
                title="Turn this off in this browser. Turn it back on in Settings."
                className="ml-auto rounded px-1 py-0.5 opacity-70 hover:underline hover:opacity-100"
              >
                Don&apos;t ask me again
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
