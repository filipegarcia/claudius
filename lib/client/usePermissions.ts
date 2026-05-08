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

export function usePermissions() {
  const [rules, setRules] = useState<ScopedRules>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/permissions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<Scope, { allow?: string[]; ask?: string[]; deny?: string[] }>;
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateRules = useCallback(
    async (scope: Scope, kind: RuleKind, next: string[]) => {
      const optimistic = { ...rules, [scope]: { ...rules[scope], [kind]: next } };
      setRules(optimistic);
      const res = await fetch("/api/settings/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, patch: { [kind]: next } }),
      });
      if (!res.ok) {
        setError(`save failed: ${res.status}`);
        await refresh();
      }
    },
    [rules, refresh],
  );

  return { rules, loading, error, refresh, updateRules };
}
