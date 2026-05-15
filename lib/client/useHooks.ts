"use client";

import { useCallback, useEffect, useState } from "react";
import type { HookEvent, HookGroup } from "@/lib/shared/hook-events";
import type { SettingsScope } from "@/lib/server/settings";
import type { ScopedHooks } from "@/lib/server/hooks";

/**
 * Fetch the per-scope `claude-code` hooks tree for a workspace, with a
 * manual `refresh()` and CRUD helpers. See `useCost` for the pattern
 * (refetchTrigger + AbortController + setState-in-callback).
 */
export function useHooks(cwd: string | null) {
  const [scopes, setScopes] = useState<ScopedHooks[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();

    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/hooks${qs}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { scopes: ScopedHooks[] };
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

  const add = useCallback(
    async (scope: SettingsScope, event: HookEvent, group: HookGroup) => {
      const res = await fetch("/api/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, event, group }),
      });
      if (res.ok) refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  const remove = useCallback(
    async (scope: SettingsScope, event: HookEvent, index: number) => {
      const res = await fetch("/api/hooks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, event, index }),
      });
      if (res.ok) refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  const setDisabled = useCallback(
    async (scope: SettingsScope, disabled: boolean) => {
      const res = await fetch("/api/hooks/disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, disabled }),
      });
      if (res.ok) refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  return { scopes, loading, error, refresh, add, remove, setDisabled };
}
