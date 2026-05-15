"use client";

import { useCallback, useEffect, useState } from "react";

export type RuleKind = "allow" | "ask" | "deny";
export type Scope = "user" | "project" | "local";

export type ScopedRules = Record<Scope, { allow: string[]; ask: string[]; deny: string[] }>;

const EMPTY: ScopedRules = {
  user: { allow: [], ask: [], deny: [] },
  project: { allow: [], ask: [], deny: [] },
  local: { allow: [], ask: [], deny: [] },
};

/**
 * Load the per-scope permission rules. Pattern matches `useCost`
 * (refetchTrigger + AbortController + setState-in-callback).
 */
export function usePermissions() {
  const [rules, setRules] = useState<ScopedRules>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/settings/permissions", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Record<Scope, { allow?: string[]; ask?: string[]; deny?: string[] }>;
      })
      .then((data) => {
        const normalized: ScopedRules = {
          user: { allow: data.user?.allow ?? [], ask: data.user?.ask ?? [], deny: data.user?.deny ?? [] },
          project: {
            allow: data.project?.allow ?? [],
            ask: data.project?.ask ?? [],
            deny: data.project?.deny ?? [],
          },
          local: { allow: data.local?.allow ?? [], ask: data.local?.ask ?? [], deny: data.local?.deny ?? [] },
        };
        setRules(normalized);
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
  }, [refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  const updateRules = useCallback(
    async (scope: Scope, kind: RuleKind, next: string[]) => {
      // Optimistic local update. We patch onto the latest `rules` via the
      // functional setter so the closure doesn't capture a stale snapshot
      // when called twice in rapid succession.
      setRules((prev) => ({ ...prev, [scope]: { ...prev[scope], [kind]: next } }));
      const res = await fetch("/api/settings/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, patch: { [kind]: next } }),
      });
      if (!res.ok) {
        setError(`save failed: ${res.status}`);
        refresh();
      }
    },
    [refresh],
  );

  return { rules, loading, error, refresh, updateRules };
}
