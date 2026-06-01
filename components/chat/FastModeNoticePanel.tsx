"use client";

import { useEffect } from "react";
import { Zap, X } from "lucide-react";

/**
 * Transient toast-style banner that marks the *transition moment* when fast
 * mode flips off (cooldown) or back on (recovered). Mirrors the Claude Code
 * TUI toasts "Fast mode … is temporarily unavailable" and "Fast limit reset /
 * now using fast mode".
 *
 * Scope note (PARTIAL feature):
 *   The CLI also distinguishes "overloaded" vs "limit reached" and ticks a
 *   live "resets in <time>" countdown. The SDK exposes neither a fast-mode
 *   reason nor a fast-mode reset timestamp (FastModeState is the bare
 *   'off'|'cooldown'|'on'), so this surface stays neutral — the persistent
 *   `⚡ cooldown` chip on the StatusLine already carries the ongoing state.
 *   Borrowing SDKRateLimitInfo.resetsAt here would fake a signal: that
 *   timestamp is the overall subscription limit, not the fast-mode capacity
 *   cooldown.
 *
 * The notice auto-fades; transitions are derived in `use-session.ts` from a
 * prior-state ref so we mark only the edges, not every result event that
 * happens to re-assert the same state.
 */
export type FastModeNoticeKind = "cooldown" | "recovered";

export type FastModeNotice = {
  /** Stable across re-renders of the same notice; bumped per transition. */
  uuid: string;
  kind: FastModeNoticeKind;
};

const AUTO_DISMISS_MS = 8_000;

export function FastModeNoticePanel({
  notice,
  onDismiss,
}: {
  notice: FastModeNotice | null;
  onDismiss: () => void;
}) {
  // Auto-fade — keyed on the notice uuid so a back-to-back transition (rare
  // but possible: cooldown → on → cooldown inside one render) resets the
  // timer rather than inheriting the prior one.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);

  if (!notice) return null;

  const isCooldown = notice.kind === "cooldown";
  const tone = isCooldown
    ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-100";
  const iconTone = isCooldown ? "text-amber-400" : "text-emerald-400";
  const headline = isCooldown
    ? "Fast mode temporarily unavailable"
    : "Fast mode reset — back to fast";
  const detail = isCooldown
    ? "Falling back to normal mode until capacity recovers."
    : "Now using fast mode again.";

  return (
    <div
      data-pane-name="fast-mode-notice"
      data-fast-mode-notice={notice.kind}
      className={`border-y ${tone} px-4 py-1.5 text-xs`}
    >
      <div className="mx-auto flex max-w-[var(--chat-col)] items-center gap-2">
        <Zap className={`h-3.5 w-3.5 shrink-0 ${iconTone}`} />
        <span className="font-medium">{headline}</span>
        <span className="hidden text-[var(--muted)] sm:inline">{detail}</span>
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
