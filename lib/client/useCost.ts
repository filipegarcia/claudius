"use client";

import { useCallback, useEffect, useState } from "react";
import type { CostReport } from "@/lib/server/cost-aggregate";

/**
 * Fetch this project's cost report, with a manual `refresh()` and a 30s
 * background poll.
 *
 * Internals: the fetch lives inside `useEffect` (keyed by `cwd` and a
 * `refetchTrigger` counter). Calling `refresh()` bumps the counter, which
 * re-runs the effect. All `setState` calls happen inside Promise callbacks
 * (`.then`/`.catch`/`.finally`) — never synchronously in the effect body —
 * which is what the `react-hooks/set-state-in-effect` rule wants. An
 * AbortController cancels the in-flight request if `cwd` switches before the
 * response lands, preventing a stale write to `data`.
 */
export function useCost(cwd: string | null) {
  const [data, setData] = useState<CostReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();

    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/cost${qs}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as CostReport;
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [cwd, refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  // Poll every 30s while mounted. The interval callback runs asynchronously,
  // so the `setState` inside `refresh` isn't "sync in an effect body".
  useEffect(() => {
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  return { data, loading, error, refresh };
}
