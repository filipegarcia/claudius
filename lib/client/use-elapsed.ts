"use client";

import { useEffect, useState } from "react";

/**
 * Live elapsed time since `startedAt` (epoch ms), ticking once per second
 * while `active` is true. Returns `null` when `active` is false or
 * `startedAt` is missing — callers render nothing (or a static fallback)
 * in that case rather than a frozen "0s".
 *
 * CC 2.1.210 parity: "Added a live elapsed-time counter to the collapsed
 * tool summary line so long-running tool calls visibly tick instead of
 * looking stuck." Mirrors the existing `useCountdownSeconds` pattern
 * (`lib/client/use-countdown.ts`) — wall-clock held in state and advanced
 * by a 1-second interval, never read via `Date.now()` during render, so the
 * component stays referentially pure between ticks.
 */
export function useElapsedSeconds(startedAt: number | undefined, active: boolean): number | null {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!active || !startedAt) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);

  if (!active || !startedAt) return null;
  return Math.max(0, Math.floor((nowMs - startedAt) / 1000));
}

/** "1m 23s" / "45s" / "1h 2m" — compact elapsed-time label. */
export function formatElapsed(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return `${totalMin}m ${sec}s`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hours}h ${min}m`;
}
