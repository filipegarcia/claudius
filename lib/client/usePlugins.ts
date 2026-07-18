"use client";

import { useCallback, useEffect, useState } from "react";
import type { AvailablePlugin, PluginsByScope } from "@/lib/server/plugins";
import type { SettingsScope } from "@/lib/server/settings";

export type InstalledPlugin = {
  name: string;
  path: string;
  source?: string;
  /**
   * SDK 0.3.214 — plugin's version as declared in its `plugin.json`
   * manifest, forwarded verbatim by the SDK's `reload_plugins` response.
   * Plugin-author-controlled (not validated by the SDK) — display only,
   * never trust it for logic. Absent when the manifest declares no version
   * (or on older SDKs that don't emit the field).
   */
  version?: string;
};

export function usePlugins(cwd: string | null, sessionId: string | null) {
  const [scopes, setScopes] = useState<PluginsByScope[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [available, setAvailable] = useState<AvailablePlugin[]>([]);
  const [availableLoading, setAvailableLoading] = useState(true);
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
    // Standard data-fetch pattern; the setState calls inside refresh are
    // the data load itself, not an effect chain.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const refreshAvailable = useCallback(async () => {
    setAvailableLoading(true);
    try {
      const res = await fetch("/api/plugins/available");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { plugins: AvailablePlugin[] };
      setAvailable(d.plugins ?? []);
    } catch {
      // Best-effort — fall back to an empty list. Cached marketplaces may
      // simply not be hydrated yet on a fresh install.
      setAvailable([]);
    } finally {
      setAvailableLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAvailable();
  }, [refreshAvailable]);

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

  /**
   * Install a plugin by sending `/plugin install <ref>` to the live
   * session. The SDK's slash command handles marketplace resolution,
   * download, and registration — we just push the user's intent through
   * the same path the TUI uses. Progress and any prompts (permissions,
   * marketplace trust) surface in the chat surface.
   *
   * `ref` accepts the same shape the SDK does: `<plugin>@<marketplace>`
   * for marketplace plugins, or a git URL for direct sources.
   */
  const install = useCallback(
    async (ref: string) => {
      if (!sessionId) return { ok: false, error: "no live session — open the chat first" };
      const text = `/plugin install ${ref.trim()}`;
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, error: err?.error ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    },
    [sessionId],
  );

  return {
    scopes,
    installed,
    installedError,
    available,
    availableLoading,
    loading,
    error,
    refresh,
    refreshAvailable,
    toggle,
    setMarketplaces,
    reload,
    install,
  };
}
