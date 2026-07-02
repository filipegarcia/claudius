"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Lightbulb, X } from "lucide-react";
import { DEFAULT_TIPS, nextTipIndexWithDismissals, type Tip } from "@/lib/shared/tips";
import { useTipDismissals } from "@/lib/client/useTipDismissals";
import {
  ANTHROPIC_STATUS_URL,
  describeApiRetry,
  type ApiRetryState,
} from "@/lib/client/api-retry";

type Props = {
  /**
   * Run a slash command (with leading slash) — wired to the chat page's
   * `handleSend`. When omitted, a tip's command renders as plain text instead
   * of a clickable affordance.
   */
  onRunCommand?: (command: string) => void;
  /**
   * Tips to rotate through — normally the server-driven catalog (the `tips`
   * SSE event). Falls back to {@link DEFAULT_TIPS} while empty/undefined so the
   * spinner is never blank before the server list arrives.
   */
  tips?: Tip[];
  /** Rotation cadence in ms. */
  intervalMs?: number;
  /**
   * Live retry state from `session.apiRetry`. When present, replaces the
   * rotating tip with the attempt/reason line (and, specifically for an
   * overload, a status-page link) — the browser analog of the Claude Code
   * CLI's 2.1.198 "improved API retry UX". See `describeApiRetry`.
   */
  apiRetry?: ApiRetryState | null;
};

/**
 * The browser-side analog of the Claude Code CLI spinner tip — a single
 * rotating "did you know" line under the "Claude is working…" row. Surfaces
 * Claudius features the user may not have found yet; each tip can carry a
 * clickable slash command.
 *
 * Each tip also carries a × dismiss control: pressing it records the tip id
 * in {@link useTipDismissals} so the same tip shows ~20% as often from then
 * on (see `DISMISSED_TIP_SHOW_PROBABILITY`). It still occasionally surfaces —
 * "show less" is intentionally not "show never", since today's nuisance is
 * tomorrow's feature reminder.
 *
 * Kept to one fixed-height line on purpose: MessageList's near-bottom
 * autoscroll watches scroll height, and a tip that wrapped or grew/shrank
 * would fight it.
 */
export function SpinnerTip({ onRunCommand, tips, intervalMs = 9000, apiRetry }: Props) {
  // Prefer the server-driven catalog; fall back to the built-in defaults while
  // it's empty (initial state before the `tips` event lands).
  const list = tips && tips.length > 0 ? tips : DEFAULT_TIPS;
  const { dismissed, dismiss } = useTipDismissals();

  // Pick a random starting tip once (lazy initializer — never re-rolls on
  // re-render). Rotation from there is deterministic via `nextTipIndex`.
  // Cosmetic — Math.random is correct. Don't "harden" with crypto: it trips
  // js/biased-cryptographic-random and taints nextTipIndex's modulo. See CLAUDE.md.
  const [index, setIndex] = useState(() =>
    list.length > 0 ? Math.floor(Math.random() * list.length) : 0,
  );

  useEffect(() => {
    if (list.length <= 1) return;
    const t = setInterval(() => {
      setIndex((i) => nextTipIndexWithDismissals(i, list, dismissed));
    }, intervalMs);
    return () => clearInterval(t);
  }, [list, dismissed, intervalMs]);

  // A retry in flight preempts the ordinary tip rotation — the CLI's
  // "improved API retry UX" replaces the spinner tip with the retry's
  // attempt/reason (and, for an overload specifically, a status-page link)
  // rather than rotating an unrelated feature nudge while the user is
  // waiting on a retry.
  if (apiRetry) {
    const { message, showStatusLink } = describeApiRetry(apiRetry);
    return (
      <div
        data-testid="spinner-tip"
        className="flex min-w-0 items-center gap-1.5 pl-[1.375rem] text-[11px] text-amber-400"
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">{message}</span>
        {showStatusLink && (
          <a
            href={ANTHROPIC_STATUS_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="spinner-tip-status-link"
            className="shrink-0 underline underline-offset-2 hover:opacity-80"
          >
            status.anthropic.com
          </a>
        )}
      </div>
    );
  }

  if (list.length === 0) return null;
  const tip = list[index % list.length];

  const handleDismiss = () => {
    // Compute the next index against the about-to-be-updated dismissed set so
    // the spinner advances immediately instead of staying on the just-dismissed
    // tip for up to one full interval. Use index-1 as the rotation "current" so
    // the helper's +1 lands on the current tip first — usually skipped now that
    // it's dismissed.
    const nextDismissed = new Set(dismissed);
    nextDismissed.add(tip.id);
    setIndex((i) => nextTipIndexWithDismissals(i, list, nextDismissed));
    dismiss(tip.id);
  };

  return (
    <div
      data-testid="spinner-tip"
      className="flex min-w-0 items-center gap-1.5 pl-[1.375rem] text-[11px] text-[var(--muted)]"
    >
      <Lightbulb className="h-3 w-3 shrink-0 opacity-70" />
      {/* Text truncates; the command stays pinned and fully visible so the
          affordance never gets clipped by a long tip. */}
      <span className="min-w-0 truncate">
        <span className="font-medium opacity-80">Tip:</span> {tip.text}
      </span>
      {tip.command && onRunCommand && (
        <button
          type="button"
          data-testid="spinner-tip-command"
          onClick={() => onRunCommand(`/${tip.command}`)}
          className="shrink-0 font-mono text-[var(--accent)] hover:underline"
        >
          /{tip.command}
        </button>
      )}
      <button
        type="button"
        data-testid="spinner-tip-dismiss"
        onClick={handleDismiss}
        aria-label="Show this tip less often"
        title="Show this tip less often"
        className="shrink-0 rounded p-0.5 opacity-50 transition hover:bg-[var(--panel)] hover:text-[var(--foreground)] hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
