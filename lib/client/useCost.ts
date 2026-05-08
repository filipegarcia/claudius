"use client";

import { useCallback, useEffect, useState } from "react";
import type { CostReport } from "@/lib/server/cost-aggregate";

export function useCost(cwd: string | null) {
  const [data, setData] = useState<CostReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (cwd == null) return;
    setLoading(true);
    setError(null);
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/cost${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as CostReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll every 30s while mounted.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  return { data, loading, error, refresh };
}
