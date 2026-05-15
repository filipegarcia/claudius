"use client";

import { useCallback, useEffect, useState } from "react";
import type { Limits, LimitsAuditEvent, LimitsState } from "@/lib/server/limits-store";

export type { Limits, LimitsAuditEvent, LimitsState };

/**
 * Fetch the cost-limits state, with a manual `refresh()` and mutating
 * helpers (`save`, `setOverride`, `audit`).
 *
 * Internals: the fetch lives inside `useEffect`, keyed by `cwd` and a
 * `refetchTrigger` counter. `refresh()` bumps the counter; mutators update
 * `state` from their own response and also bump the trigger so any other
 * surface that depends on this hook stays in sync. setState happens inside
 * Promise callbacks (not sync in the effect body) — what
 * `react-hooks/set-state-in-effect` wants.
 */
export function useLimits(cwd: string | null) {
  const [state, setState] = useState<LimitsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();

    fetch(`/api/limits?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as LimitsState;
      })
      .then((d) => {
        setState(d);
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
