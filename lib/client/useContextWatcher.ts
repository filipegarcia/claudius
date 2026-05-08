"use client";

import { useEffect, useState } from "react";

export type ContextSummary = {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
};

/**
 * Lightweight poll of the active session's context usage. Polls every 30s while
 * the session is idle (so we don't tax the SDK while it's working). Returns null
 * before the first read.
 */
export function useContextWatcher(sessionId: string | null, pending: boolean): ContextSummary | null {
  const [summary, setSummary] = useState<ContextSummary | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/context`);
        if (!res.ok) return;
        const d = (await res.json()) as ContextSummary & Record<string, unknown>;
        if (!cancelled) {
          setSummary({
            totalTokens: d.totalTokens ?? 0,
            maxTokens: d.maxTokens ?? 0,
            percentage: d.percentage ?? 0,
          });
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          // Slow when idle, faster when context might be growing.
          const delay = pending ? 8_000 : 30_000;
          timer = setTimeout(poll, delay);
        }
      }
    }

    // Wait a short moment after a session change before the first poll.
    timer = setTimeout(poll, 1_500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, pending]);

  return summary;
}
