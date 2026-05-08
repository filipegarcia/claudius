"use client";

import { useCallback, useEffect, useState } from "react";
import type { HookEvent, HookGroup } from "@/lib/shared/hook-events";
import type { SettingsScope } from "@/lib/server/settings";
import type { ScopedHooks } from "@/lib/server/hooks";

export function useHooks(cwd: string | null) {
  const [scopes, setScopes] = useState<ScopedHooks[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (cwd == null) return;
    setLoading(true);
    setError(null);
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/hooks${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { scopes: ScopedHooks[] };
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

  const add = useCallback(
    async (scope: SettingsScope, event: HookEvent, group: HookGroup) => {
      const res = await fetch("/api/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, event, group }),
      });
      if (res.ok) await refresh();
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
      if (res.ok) await refresh();
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
      if (res.ok) await refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  return { scopes, loading, error, refresh, add, remove, setDisabled };
}
