"use client";

import { useCallback, useEffect, useState } from "react";
import type { AvailablePlugin, PluginsByScope } from "@/lib/server/plugins";
import type { SettingsScope } from "@/lib/server/settings";
import type { PluginLoadError } from "@/lib/shared/parse-init";
import type { PluginConfigOption, PluginOptionValue } from "@/lib/shared/plugin-config";

/**
 * CC 2.1.268 (G7) — delays (ms) at which the plugin list auto-refreshes after
 * an install is dispatched, covering a slow marketplace fetch without
 * hammering. Bounded and increasing. Exported for unit testing.
 */
export const INSTALL_REFRESH_DELAYS_MS = [2000, 5000, 10000] as const;

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
  /** CC 2.1.265 (G2) — from the SDK object, else the plugin's own plugin.json. */
  description?: string;
  displayName?: string;
  /** CC 2.1.285 (G3) — the plugin's `userConfig` option schema, when declared. */
  userConfig?: PluginConfigOption[];
};

export function usePlugins(cwd: string | null, sessionId: string | null) {
  const [scopes, setScopes] = useState<PluginsByScope[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [pluginErrors, setPluginErrors] = useState<PluginLoadError[]>([]);
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
        pluginErrors?: PluginLoadError[];
      };
      setScopes(d.scopes);
      setInstalled(d.installed ?? []);
      setInstalledError(d.installedError);
      setPluginErrors(d.pluginErrors ?? []);
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

  // CC 2.1.295 parity — returns the server's error (e.g. the 422 "<path>
  // doesn't load … The file was not changed.") so a refused enable/disable is
  // surfaced instead of the checkbox silently snapping back.
  const toggle = useCallback(
    async (
      scope: SettingsScope,
      pluginId: string,
      enabled: boolean,
    ): Promise<{ ok: boolean; error?: string }> => {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "toggle", scope, cwd, pluginId, enabled }),
      });
      if (res.ok) {
        await refresh();
        return { ok: true };
      }
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: err?.error ?? `HTTP ${res.status}` };
    },
    [cwd, refresh],
  );

  // G1 — structural marketplace ops. Each POSTs one change; the server applies
  // it to the raw settings.json value, so untouched (and unmodeled) entries are
  // preserved. Returns the server error string (if any) so the UI can surface
  // a validation failure (e.g. a wildcard repo in `extra`).
  const marketplaceOp = useCallback(
    async (body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "marketplaces", cwd, ...body }),
      });
      if (res.ok) {
        await refresh();
        return { ok: true };
      }
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: err?.error ?? `HTTP ${res.status}` };
    },
    [cwd, refresh],
  );

  const addExtraMarketplace = useCallback(
    (scope: SettingsScope, name: string, source: Record<string, unknown>) =>
      marketplaceOp({ scope, op: "add-extra", name, source }),
    [marketplaceOp],
  );
  const removeExtraMarketplace = useCallback(
    (scope: SettingsScope, name: string) => marketplaceOp({ scope, op: "remove-extra", name }),
    [marketplaceOp],
  );
  const removePolicyMarketplace = useCallback(
    (scope: SettingsScope, list: "strict" | "blocked", index: number) =>
      marketplaceOp({ scope, op: "remove-policy", list, index }),
    [marketplaceOp],
  );

  // G3 — set (or clear, when `value` is undefined) one plugin option value.
  const setPluginOption = useCallback(
    async (
      scope: SettingsScope,
      pluginId: string,
      name: string,
      value: PluginOptionValue | undefined,
    ): Promise<boolean> => {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "plugin-config", scope, cwd, pluginId, name, value }),
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
      // CC 2.1.268 (G7) — the SDK registers the plugin asynchronously during the
      // chat turn this command kicks off, so an immediate refresh wouldn't see
      // it yet. Poll the list a few times (bounded, increasing) so the newly
      // installed plugin appears on its own — no manual Refresh needed.
      for (const delay of INSTALL_REFRESH_DELAYS_MS) {
        setTimeout(() => {
          void refresh();
        }, delay);
      }
      return { ok: true };
    },
    [sessionId, refresh],
  );

  return {
    scopes,
    installed,
    installedError,
    pluginErrors,
    available,
    availableLoading,
    loading,
    error,
    refresh,
    refreshAvailable,
    toggle,
    addExtraMarketplace,
    removeExtraMarketplace,
    removePolicyMarketplace,
    setPluginOption,
    reload,
    install,
  };
}
