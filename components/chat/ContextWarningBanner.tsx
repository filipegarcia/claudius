"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Shrink } from "lucide-react";

type Props = {
  /** Context-window usage as a 0–100 percentage. */
  percentage: number;
  /** True while a /compact triggered from this banner is in flight. */
  compacting: boolean;
  /** True while any turn is running — compacting would queue, so we disable. */
  pending: boolean;
  onCompact: () => void;
};

// Cells in the animated indeterminate bar, and the width of the moving
// filled-block window that slides across them.
const SEGMENTS = 30;
const WINDOW = 6;

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Live warning shown above the composer when the active session's context
 * window crosses the user-configured threshold (see `useContextWarning`).
 *
 * Mirrors the visual language of the account rate-limit warning
 * (`RateLimitPill` in SystemPill.tsx) — a rounded, tinted bordered box with
 * an `AlertTriangle` and dense 11px copy — but is a *live polled* condition
 * rather than a discrete SDK event, so it lives in the banner region of the
 * chat page instead of inline in the message list.
 *
 * The Compact button fires the same `/compact` path as the StatusLine
 * control. While compaction runs we show an **honest** indicator: a running
 * elapsed timer plus an animated indeterminate bar. The SDK exposes no
 * compaction-progress fraction (only a `compacting` status and a final
 * success/fail), so a real percentage is impossible — we don't fake one. The
 * indicator clears when the SDK emits the `compact_boundary`, at which point
 * freed context drops below the threshold and this banner unmounts.
 */
export function ContextWarningBanner({ percentage, compacting, pending, onCompact }: Props) {
  const pct = Math.round(percentage);
  // Match RateLimitPill's tone scheme: amber while approaching, red once the
  // window is nearly exhausted.
  const tone =
    pct >= 95
      ? "border-red-500/30 bg-red-500/10 text-red-200"
      : "border-amber-500/30 bg-amber-500/10 text-amber-200";

  // Disable when a turn is in flight (send() would silently queue the
  // /compact behind the running turn) unless this banner itself started the
  // compaction — in which case the button is already showing its busy state.
  const blocked = pending && !compacting;

  // Elapsed milliseconds since compaction started, advanced by one interval.
  // The interval closure captures its own `start`, so render only ever reads
  // the `elapsed` state — no ref reads and no `Date.now()` during render (both
  // of which the react-hooks lint rules flag). The cleanup resets to 0 so a
  // second compaction in the same mounted banner opens cleanly at "0:00".
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!compacting) return;
    const start = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - start), 150);
    return () => {
      window.clearInterval(id);
      setElapsed(0);
    };
  }, [compacting]);

  const elapsedSec = Math.floor(elapsed / 1000);
  const headPos = Math.floor(elapsed / 150) % SEGMENTS;
  const marquee = Array.from({ length: SEGMENTS }, (_, i) =>
    (i - headPos + SEGMENTS) % SEGMENTS < WINDOW ? "▰" : "▱",
  ).join("");

  return (
    <div className="mx-auto w-full max-w-[var(--chat-col)] px-4 pb-2">
      <div className={`rounded-md border px-3 py-2 text-[11px] leading-5 ${tone}`}>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 font-medium">
            {compacting ? (
              <>
                Compacting conversation…
                <span className="ml-1.5 font-mono font-normal tabular-nums opacity-80">
                  {formatElapsed(elapsedSec)}
                </span>
              </>
            ) : (
              <>
                {`Context window is ${pct}% full`}
                <span className="ml-1 font-normal opacity-80">
                  — compact to free up space before auto-compaction kicks in.
                </span>
              </>
            )}
          </span>
          <button
            type="button"
            onClick={onCompact}
            disabled={compacting || blocked}
            title={
              blocked
                ? "Wait for the current turn to finish"
                : "Summarize earlier turns to free up context"
            }
            className="flex shrink-0 items-center gap-1 rounded-md border border-current/40 bg-current/10 px-2 py-0.5 text-[11px] font-medium hover:bg-current/20 disabled:opacity-50"
          >
            {compacting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Shrink className="h-3 w-3" />
            )}
            <span>{compacting ? "Compacting…" : "Compact"}</span>
          </button>
        </div>

        {compacting && (
          <div
            role="progressbar"
            aria-label="Compacting conversation"
            aria-busy
            className="mt-2 font-mono text-[11px] leading-none"
          >
            <span className="whitespace-pre tracking-[0.08em]" aria-hidden="true">
              {marquee}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
