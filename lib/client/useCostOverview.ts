"use client";

import { useEffect, useState } from "react";
import type { CostOverview } from "@/lib/shared/cost-overview";

/**
 * Fetch the cross-project, cross-account spend overview
 * (`GET /api/cost/overview`). Re-fetches whenever `refreshKey` changes (the
 * Account page's Refresh button). No background poll: the first scan on a
 * machine reads every transcript, and later ones still stat every file.
 *
 * `setState` only runs in Promise callbacks (the
 * `react-hooks/set-state-in-effect` rule); an AbortController drops a
 * response that lands after unmount or a newer refresh.
 */
export function useCostOverview(refreshKey: number) {
  const [data, setData] = useState<CostOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => {
        if (!controller.signal.aborted) setLoading(true);
        return fetch("/api/cost/overview", { signal: controller.signal });
      })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as CostOverview;
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
  }, [refreshKey]);

  return { data, loading, error };
}
