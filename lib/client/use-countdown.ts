"use client";

import { useEffect, useState } from "react";

/**
 * Live countdown to an epoch-**seconds** timestamp. Returns `"Available now"`
 * once the reset has passed, or `null` when `resetsAtSec` is missing.
 *
 * The SDK reports rate-limit `resetsAt` in seconds, not ms (the Claude Code
 * CLI computes `resetsAt - Date.now()/1000`). We tick once per second and
 * clean up on unmount or when the target changes.
 *
 * The current wall-clock is held in state (not read with `Date.now()` during
 * render) so the component stays referentially pure between ticks —
 * react-hooks/purity flags otherwise-equivalent code that reads `Date.now()`
 * directly in render. The initializer reads `Date.now()` once at mount so the
 * first paint is correct; the interval keeps it advancing.
 */
export function useCountdownSeconds(resetsAtSec: number | undefined): string | null {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!resetsAtSec) return;
    // 1-Hz tick — the smallest unit we render is "Xs", so sub-second precision
    // would be wasted re-renders.
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [resetsAtSec]);

  if (!resetsAtSec) return null;
  const remaining = Math.floor(resetsAtSec - nowMs / 1000);
  if (remaining <= 0) return "Available now";
  return formatRemaining(remaining);
}

function formatRemaining(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    // For long windows (weekly resets) show "Dd HHh MMm" — otherwise the hour
    // count balloons past 24 and reads as nonsense.
    if (h >= 24) {
      const d = Math.floor(h / 24);
      const hh = h % 24;
      return `${d}d ${hh}h ${m.toString().padStart(2, "0")}m`;
    }
    return `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
  }
  return `${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
}

/** Wall-clock label for an epoch-seconds reset, e.g. "8:10 PM". */
export function formatResetClock(resetsAtSec: number): string {
  const d = new Date(resetsAtSec * 1000);
  // `numeric` minute looks like "6:3pm" — force 2-digit minute via `2-digit`.
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
