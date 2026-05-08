"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClaudeSettings, SettingsScope } from "@/lib/server/settings";

export type ScopedSettings = { scope: SettingsScope; path: string; settings: ClaudeSettings };

export function useSettings(cwd: string | null) {
  const [scopes, setScopes] = useState<ScopedSettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (cwd == null) return;
    setLoading(true);
    setError(null);
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/settings/full${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { scopes: ScopedSettings[] };
      setScopes(data.scopes);
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
    async (scope: SettingsScope, settings: ClaudeSettings) => {
      const res = await fetch("/api/settings/full", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, settings }),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  return { scopes, loading, error, refresh, save };
}
