"use client";

import { useCallback, useEffect, useState } from "react";
import type { PluginsByScope } from "@/lib/server/plugins";
import type { SettingsScope } from "@/lib/server/settings";

export type InstalledPlugin = { name: string; path: string; source?: string };

export function usePlugins(cwd: string | null, sessionId: string | null) {
  const [scopes, setScopes] = useState<PluginsByScope[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (cwd == null) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      if (sessionId) params.set("sessionId", sessionId);
      const res = await fetch(`/api/plugins?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as {
        scopes: PluginsByScope[];
        installed: InstalledPlugin[];
        installedError: string | null;
      };
      setScopes(d.scopes);
      setInstalled(d.installed ?? []);
      setInstalledError(d.installedError);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (scope: SettingsScope, pluginId: string, enabled: boolean) => {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "toggle", scope, cwd, pluginId, enabled }),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  const setMarketplaces = useCallback(
    async (
      scope: SettingsScope,
      patch: {
        extraKnownMarketplaces?: string[];
        strictKnownMarketplaces?: boolean;
        blockedMarketplaces?: string[];
      },
    ) => {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "marketplaces", scope, cwd, ...patch }),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  const reload = useCallback(async () => {
    if (!sessionId) return false;
    const res = await fetch(`/api/plugins/reload?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
    });
    if (res.ok) await refresh();
    return res.ok;
  }, [refresh, sessionId]);

  return { scopes, installed, installedError, loading, error, refresh, toggle, setMarketplaces, reload };
}
