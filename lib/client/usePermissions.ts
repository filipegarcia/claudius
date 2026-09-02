"use client";

import { useCallback, useEffect, useState } from "react";

export type RuleKind = "allow" | "ask" | "deny";
export type Scope = "user" | "project" | "local";

export type ScopedRules = Record<
  Scope,
  { allow: string[]; ask: string[]; deny: string[]; blockReadsOutsideWorkingDirectories: boolean }
>;

const EMPTY: ScopedRules = {
  user: { allow: [], ask: [], deny: [], blockReadsOutsideWorkingDirectories: false },
  project: { allow: [], ask: [], deny: [], blockReadsOutsideWorkingDirectories: false },
  local: { allow: [], ask: [], deny: [], blockReadsOutsideWorkingDirectories: false },
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
        return (await res.json()) as Record<
          Scope,
          { allow?: string[]; ask?: string[]; deny?: string[]; blockReadsOutsideWorkingDirectories?: boolean }
        >;
      })
      .then((data) => {
        const normalized: ScopedRules = {
          user: {
            allow: data.user?.allow ?? [],
            ask: data.user?.ask ?? [],
            deny: data.user?.deny ?? [],
            blockReadsOutsideWorkingDirectories: data.user?.blockReadsOutsideWorkingDirectories ?? false,
          },
          project: {
            allow: data.project?.allow ?? [],
            ask: data.project?.ask ?? [],
            deny: data.project?.deny ?? [],
            blockReadsOutsideWorkingDirectories: data.project?.blockReadsOutsideWorkingDirectories ?? false,
          },
          local: {
            allow: data.local?.allow ?? [],
            ask: data.local?.ask ?? [],
            deny: data.local?.deny ?? [],
            blockReadsOutsideWorkingDirectories: data.local?.blockReadsOutsideWorkingDirectories ?? false,
          },
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

  // CC 2.1.257 parity — same optimistic-update / rollback-on-failure shape
  // as `updateRules`, but for the single `blockReadsOutsideWorkingDirectories`
  // boolean rather than a rule-kind array.
  const updateBlockReadsOutsideWorkingDirectories = useCallback(
    async (scope: Scope, next: boolean) => {
      setRules((prev) => ({ ...prev, [scope]: { ...prev[scope], blockReadsOutsideWorkingDirectories: next } }));
      const res = await fetch("/api/settings/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, patch: { blockReadsOutsideWorkingDirectories: next } }),
      });
      if (!res.ok) {
        setError(`save failed: ${res.status}`);
        refresh();
      }
    },
    [refresh],
  );

  return { rules, loading, error, refresh, updateRules, updateBlockReadsOutsideWorkingDirectories };
}
