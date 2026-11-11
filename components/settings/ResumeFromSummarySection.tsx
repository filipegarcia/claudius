"use client";

import { History } from "lucide-react";
import { useResumeFromSummaryEnabled } from "@/lib/client/useResumeFromSummary";
import {
  RESUME_SUMMARY_MIN_IDLE_MINUTES,
  RESUME_SUMMARY_MIN_TOKENS,
  formatSessionAge,
  formatTokenCount,
} from "@/lib/shared/resume-from-summary";

/**
 * Browser-only on/off for the chat's "Resume from summary" offer. The offer's
 * "Don't ask me again" button turns it off; this is where it comes back.
 * Lives alongside the other browser-local sections rather than settings.json.
 */
export function ResumeFromSummarySection() {
  const { enabled, setEnabled } = useResumeFromSummaryEnabled();

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div className="flex items-start gap-2">
        <History className="mt-px h-3.5 w-3.5 text-amber-400" />
        <div>
          <h2 className="text-sm font-medium">Resume from summary</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            When a conversation has been idle for{" "}
            {formatSessionAge(RESUME_SUMMARY_MIN_IDLE_MINUTES)} or more and holds at least{" "}
            {formatTokenCount(RESUME_SUMMARY_MIN_TOKENS)} tokens, the prompt cache has expired and
            the next message re-sends all of it. The chat offers to compact it into a summary first,
            the way Claude Code does. Stored per browser.
          </p>
        </div>
      </div>

      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="resume-summary-enabled-toggle"
          className="mt-0.5 h-3.5 w-3.5"
        />
        <div className="flex-1">
          <div className="text-xs font-medium">Offer to resume idle sessions from a summary</div>
          <div className="text-[11px] text-[var(--muted)]">
            On by default. &ldquo;Don&apos;t ask me again&rdquo; on the offer turns this off.
          </div>
        </div>
      </label>
    </section>
  );
}
