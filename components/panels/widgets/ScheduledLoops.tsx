"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Repeat, Timer, X } from "lucide-react";
import type { ScheduledLoop } from "@/lib/client/types";
import { fmtElapsedSec } from "./format";

/**
 * Render the loops/wake-ups the agent has armed in this session via the
 * harness-provided `CronCreate` / `ScheduleWakeup` tools. Without this
 * widget the only persistent record is the inline assistant message that
 * announced the schedule — easy to scroll past and easy to lose track of.
 *
 * We can't call `CronDelete` from the browser directly (the tool only
 * exists inside the agent runtime), so `onCancel` composes a user-side
 * prompt that asks the agent to cancel. The button stays clickable while
 * the request is in flight; we mark the loop `cancelled` optimistically so
 * the user gets immediate visual feedback even before the agent runs.
 */
export function ScheduledLoops({
  items,
  onCancel,
}: {
  items: ScheduledLoop[];
  onCancel?: (loop: ScheduledLoop) => Promise<void> | void;
}) {
  // Tick once a second so the elapsed / countdown labels update live —
  // the same pattern BackgroundBashes uses for its uptime counter.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Optimistic "cancelling…" state. `onCancel` sends a prompt to the agent
  // asking it to run CronDelete — that round-trip might be seconds (or
  // longer if a turn is already in flight and the request queues). Until
  // the agent actually fires CronDelete (which flips `cancelled` upstream
  // via the use-session reducer), we render the chip in the same muted
  // tone and disable the X to make the click feel instant.
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());

  if (!items.length) return null;

  return (
    <ul className="space-y-1">
      {items.map((loop) => {
        const elapsed = Math.max(0, (now - loop.startedAt) / 1000);
        const Icon = loop.kind === "wakeup" ? Timer : Repeat;
        const cancelling = cancellingIds.has(loop.id);
        const muted = loop.cancelled || cancelling;
        const tone = muted
          ? "border-[var(--border)] bg-[var(--panel-2)]/40 text-[var(--muted)]"
          : loop.kind === "wakeup"
            ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
            : "border-violet-500/30 bg-violet-500/10 text-violet-100";

        // Wake-ups show a "fires in <delay>" countdown; crons show their
        // human-readable cadence (set by CronCreate's tool_result, e.g.
        // "Every minute"). Until the result lands `humanSchedule` is null
        // and we fall back to the raw cron expression.
        const cadence = (() => {
          if (loop.kind === "wakeup") {
            if (loop.delaySeconds == null) return "scheduled";
            const remaining = loop.delaySeconds - elapsed;
            if (remaining <= 0) return "due now";
            return `fires in ${fmtElapsedSec(remaining)}`;
          }
          return loop.humanSchedule ?? loop.cron ?? "scheduled";
        })();

        const promptPreview = loop.prompt.trim().split("\n")[0] ?? "";

        return (
          <li
            key={loop.id}
            className={`rounded-md border px-2 py-1.5 ${tone}`}
            title={loop.prompt}
          >
            <div className="flex items-center gap-1.5 text-[11px]">
              <Icon className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{cadence}</span>
              {loop.kind === "cron" && loop.recurring && (
                <span className="ml-1 rounded bg-[var(--panel)]/60 px-1 py-px text-[9px] uppercase tracking-wide opacity-70">
                  recurring
                </span>
              )}
              {loop.durable && (
                <span className="ml-1 rounded bg-[var(--panel)]/60 px-1 py-px text-[9px] uppercase tracking-wide opacity-70">
                  durable
                </span>
              )}
              {onCancel && !loop.cancelled && !cancelling && loop.kind === "cron" && (
                <button
                  type="button"
                  onClick={async () => {
                    // Flip to "cancelling…" immediately so the click feels
                    // instant — the upstream `cancelled` flag lands once
                    // the agent actually runs CronDelete (its tool_use
                    // event will arrive through the same reducer that set
                    // up this loop in the first place).
                    setCancellingIds((prev) => {
                      const next = new Set(prev);
                      next.add(loop.id);
                      return next;
                    });
                    try {
                      await onCancel(loop);
                    } catch {
                      // Roll back the optimistic flip if the prompt didn't
                      // get sent — the user can retry.
                      setCancellingIds((prev) => {
                        const next = new Set(prev);
                        next.delete(loop.id);
                        return next;
                      });
                    }
                  }}
                  className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)]/60 hover:text-[var(--foreground)]"
                  aria-label="Ask the agent to cancel this loop"
                  title="Ask the agent to cancel (sends a CronDelete request)"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {(loop.cancelled || cancelling) && (
                <span className="ml-auto text-[9px] uppercase tracking-wide opacity-60">
                  {loop.cancelled ? "cancelled" : "cancelling…"}
                </span>
              )}
            </div>
            {promptPreview && (
              <div className="mt-0.5 line-clamp-2 text-[10px] opacity-80">
                {promptPreview}
              </div>
            )}
            <div className="mt-0.5 flex gap-2 text-[9px] opacity-60">
              <span>armed {fmtElapsedSec(elapsed)} ago</span>
              {loop.kind === "cron" && loop.cron && loop.humanSchedule && (
                <span className="font-mono">{loop.cron}</span>
              )}
              {loop.reason && <span className="truncate italic">· {loop.reason}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Icon re-export so the panel header can reuse the same glyph. */
export const ScheduledLoopsIcon = CalendarClock;
