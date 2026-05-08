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

export function useClaudeMd(cwd: string | null) {
  const [scopes, setScopes] = useState<ScopeFile[]>([]);
  const [resolved, setResolved] = useState<ResolvedHierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const qs = `?cwd=${encodeURIComponent(cwd)}`;
      const [aRes, rRes] = await Promise.all([
        fetch(`/api/claudemd${qs}`),
        fetch(`/api/claudemd${qs}&resolved=1`),
      ]);
      if (!aRes.ok) throw new Error(`HTTP ${aRes.status}`);
      const a = (await aRes.json()) as { scopes: ScopeFile[] };
      setScopes(a.scopes);
      if (rRes.ok) setResolved((await rRes.json()) as ResolvedHierarchy);
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
    async (scope: Scope, content: string) => {
      if (!cwd) return false;
      const res = await fetch("/api/claudemd", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, content }),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  return { scopes, resolved, loading, error, refresh, save };
}
