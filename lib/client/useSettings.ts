"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClaudeSettings, SettingsScope } from "@/lib/server/settings";

export type ScopedSettings = { scope: SettingsScope; path: string; settings: ClaudeSettings };

/**
 * Fetch the per-scope settings tree for a workspace, with a manual
 * `refresh()` and a `save(scope, settings)` mutator. See `useCost` for the
 * pattern (refetchTrigger + AbortController + setState-in-callback).
 */
export function useSettings(cwd: string | null) {
  const [scopes, setScopes] = useState<ScopedSettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();

    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/settings/full${qs}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { scopes: ScopedSettings[] };
      })
      .then((d) => {
        setScopes(d.scopes);
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
    async (scope: SettingsScope, settings: ClaudeSettings) => {
      const res = await fetch("/api/settings/full", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, settings }),
      });
      // Trigger a background refresh; we no longer await the GET response
      // before returning. Callers that rely on `save` completing the round
      // trip now resolve on the PUT, with the new data arriving on the next
      // render via the refetch effect.
      if (res.ok) refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  return { scopes, loading, error, refresh, save };
}
