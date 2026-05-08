"use client";

import { useCallback, useEffect, useState } from "react";
import type { Limits, LimitsAuditEvent, LimitsState } from "@/lib/server/limits-store";

export type { Limits, LimitsAuditEvent, LimitsState };

export function useLimits(cwd: string | null) {
  const [state, setState] = useState<LimitsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (cwd == null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/limits?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState((await res.json()) as LimitsState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (limits: Limits): Promise<boolean> => {
      if (cwd == null) return false;
      const res = await fetch(`/api/limits?cwd=${encodeURIComponent(cwd)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(limits),
      });
      if (!res.ok) return false;
      setState((await res.json()) as LimitsState);
      return true;
    },
    [cwd],
  );

  const setOverride = useCallback(
    async (sessionId: string, on: boolean): Promise<boolean> => {
      if (cwd == null) return false;
      const res = await fetch(`/api/limits?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "override", sessionId, on }),
      });
      if (!res.ok) return false;
      setState((await res.json()) as LimitsState);
      return true;
    },
    [cwd],
  );

  const audit = useCallback(
    async (event: LimitsAuditEvent): Promise<void> => {
      if (cwd == null) return;
      const res = await fetch(`/api/limits?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "audit", event }),
      });
      if (res.ok) setState((await res.json()) as LimitsState);
    },
    [cwd],
  );

  return { state, loading, error, refresh, save, setOverride, audit };
}
