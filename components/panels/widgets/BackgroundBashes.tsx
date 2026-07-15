"use client";

import { useEffect, useState } from "react";
import { CircleStop, Terminal } from "lucide-react";
import type { BackgroundBash } from "@/lib/client/types";
import { fmtElapsedSec } from "./format";

export function BackgroundBashes({
  items,
  onPick,
  getStopTaskId,
  onStop,
}: {
  items: BackgroundBash[];
  onPick?: (b: BackgroundBash) => void;
  /**
   * Resolve the SDK task id for a shell so it can be stopped. A background
   * shell is tracked by its launching Bash `tool_use_id`, which is also the
   * `tool_use_id` of its `local_bash` task — the caller joins on that to hand
   * back the `taskId` that `stopTask` needs. Returns undefined when no task is
   * known yet (the Stop control is then hidden rather than dead).
   */
  getStopTaskId?: (b: BackgroundBash) => string | undefined;
  /** Stop the shell (passed its resolved task id). */
  onStop?: (taskId: string, b: BackgroundBash) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!items.length) return null;
  return (
    <ul className="space-y-1">
      {items.map((b) => {
        const elapsed = Math.max(0, (now - b.startedAt) / 1000);
        const stopTaskId = onStop ? getStopTaskId?.(b) : undefined;
        const timedOut = !b.killed && b.timedOutAfterMs != null;
        const tone = b.killed
          ? "border-[var(--border)] bg-[var(--panel-2)]/40 text-[var(--muted)]"
          : timedOut
            ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
        return (
          <li key={b.toolUseId} className={`rounded-md border px-2 py-1.5 ${tone}`}>
            <div className="flex items-center gap-1.5 text-[11px]">
              <Terminal className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">local_bash</span>
              {timedOut && (
                <span
                  data-testid="bash-timeout-badge"
                  title={`Auto-backgrounded after hitting its ${Math.round(
                    (b.timedOutAfterMs ?? 0) / 1000,
                  )}s timeout`}
                  className="shrink-0 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-medium uppercase tracking-wide text-amber-300"
                >
                  timed out
                </span>
              )}
              <span className="ml-auto shrink-0 font-mono text-[10px]">
                {b.killed ? "killed" : fmtElapsedSec(elapsed)}
              </span>
              {stopTaskId && (
                <button
                  type="button"
                  onClick={() => onStop?.(stopTaskId, b)}
                  title="Stop this shell"
                  aria-label="Stop this shell"
                  className="shrink-0 rounded p-0.5 text-[var(--muted)] transition hover:bg-[var(--panel)] hover:text-red-400"
                >
                  <CircleStop className="h-3 w-3" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onPick?.(b)}
              disabled={!onPick}
              className={`mt-0.5 block w-full truncate text-left font-mono text-[10px] opacity-90 transition ${
                onPick ? "cursor-pointer hover:opacity-100" : "cursor-default"
              }`}
              title="Open output viewer"
            >
              {b.command}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
