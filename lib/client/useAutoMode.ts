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
  // CC 2.1.327 — a failed save/reset keeps its message (naming the file)
  // through the rollback refetch, which clears `error` on success. Same fix
  // as `usePermissions.saveError` (CC 2.1.326). Cleared by the next save or
  // reset that lands.
  const [saveError, setSaveError] = useState<string | null>(null);
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

  /** Record why a write didn't land (the server's message names the file). */
  const failed = useCallback(async (res: Response, verb: string) => {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    setSaveError(typeof body?.error === "string" && body.error ? body.error : `${verb} failed: ${res.status}`);
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
      }).catch(() => null);
      if (res?.ok) {
        setSaveError(null);
        return;
      }
      if (res) await failed(res, "save");
      else setSaveError("Not saved: couldn't reach Claudius to update ~/.claude/settings.json.");
      refresh();
    },
    [failed, refresh],
  );

  const reset = useCallback(async () => {
    // CC 2.1.212 — drop the whole autoMode key so the classifier reverts to
    // the engine defaults. Optimistically clear, then refetch to confirm.
    setConfig(EMPTY);
    const res = await fetch("/api/settings/auto-mode", { method: "DELETE" }).catch(() => null);
    if (res?.ok) setSaveError(null);
    else if (res) await failed(res, "reset");
    else setSaveError("Not reset: couldn't reach Claudius to update ~/.claude/settings.json.");
    refresh();
  }, [failed, refresh]);

  return { config, loading, error, saveError, refresh, updateConfig, reset };
}
