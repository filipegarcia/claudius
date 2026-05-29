"use client";

import { useCallback, useEffect, useState } from "react";

export type Scope = "user" | "project" | "project-claude" | "local";

export type ScopeFile = {
  scope: Scope;
  path: string;
  exists: boolean;
  content: string;
};

export type ResolvedSegment = {
  scope: Scope | "import";
  source: string;
  content: string;
  depth: number;
};

export type ResolvedHierarchy = {
  cwd: string;
  scopes: Array<{ scope: Scope; path: string; exists: boolean; segments: ResolvedSegment[] }>;
  totalChars: number;
};

/**
 * Load the resolved CLAUDE.md hierarchy for `cwd`. Pattern matches `useCost`
 * (refetchTrigger + AbortController + setState-in-callback).
 */
export function useClaudeMd(cwd: string | null) {
  const [scopes, setScopes] = useState<ScopeFile[]>([]);
  const [resolved, setResolved] = useState<ResolvedHierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    if (!cwd) return;
    const controller = new AbortController();
    const qs = `?cwd=${encodeURIComponent(cwd)}`;

    Promise.all([
      fetch(`/api/claudemd${qs}`, { signal: controller.signal }),
      fetch(`/api/claudemd${qs}&resolved=1`, { signal: controller.signal }),
    ])
      .then(async ([aRes, rRes]) => {
        if (!aRes.ok) throw new Error(`HTTP ${aRes.status}`);
        const a = (await aRes.json()) as { scopes: ScopeFile[] };
        const r = rRes.ok ? ((await rRes.json()) as ResolvedHierarchy) : null;
        return { a, r };
      })
      .then(({ a, r }) => {
        setScopes(a.scopes);
        if (r) setResolved(r);
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
    async (scope: Scope, content: string) => {
      if (!cwd) return false;
      const res = await fetch("/api/claudemd", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, content }),
      });
      if (res.ok) refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  return { scopes, resolved, loading, error, refresh, save };
}
