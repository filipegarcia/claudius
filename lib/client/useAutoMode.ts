"use client";

import { useCallback, useEffect, useState } from "react";
import type { AutoModeConfig } from "@/lib/server/settings";

export type { AutoModeConfig };

const EMPTY: AutoModeConfig = {};

/**
 * CC 2.1.246 parity — "Added an Auto mode tab to /permissions for viewing
 * and editing auto mode classifier rules". Pattern matches `usePermissions`
 * (refetchTrigger + AbortController + optimistic patch), but scoped to the
 * single "user"-scope `autoMode` block — there's no per-scope triple here,
 * upstream never reads `autoMode` from project/local settings.
 */
export function useAutoMode() {
  const [config, setConfig] = useState<AutoModeConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/settings/auto-mode", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { autoMode?: AutoModeConfig };
      })
      .then((data) => {
        setConfig(data.autoMode ?? {});
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

  const updateConfig = useCallback(
    async (patch: Partial<AutoModeConfig>) => {
      // Optimistic local update via the functional setter, same rationale
      // as `usePermissions.updateRules` — avoids a stale-closure clobber on
      // two rapid calls.
      setConfig((prev) => ({ ...prev, ...patch }));
      const res = await fetch("/api/settings/auto-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      if (!res.ok) {
        setError(`save failed: ${res.status}`);
        refresh();
      }
    },
    [refresh],
  );

  return { config, loading, error, refresh, updateConfig };
}
