"use client";

import { useCallback, useEffect, useState } from "react";
import type { McpScope, McpServerConfig } from "@/lib/server/mcp";

export type ConfiguredServer = {
  scope: McpScope;
  name: string;
  config: McpServerConfig;
  warnings?: string[];
  /** Project server listed in `disabledMcpjsonServers` (CC 2.1.327). */
  rejected?: true;
};

export type LiveStatus = {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: unknown;
  scope?: string;
  tools?: {
    name: string;
    description?: string;
    annotations?: unknown;
    /**
     * SDK 0.3.280 — MCP Apps (SEP-1865) metadata a tool's `_meta` carries,
     * under the keys the server used: `ui` (an object with a `resourceUri`
     * of scheme `ui://`, plus `visibility` and any other server-sent
     * member) or the deprecated flat `ui/resourceUri`. We only surface
     * *presence* of a `ui://` resource as a badge — reading the resource
     * itself (`readMcpResource()`) is alpha, requires the
     * `mcp_read_resource_v1` capability, and returns untrusted third-party
     * HTML that needs sandboxed rendering design; out of scope for now.
     */
    _meta?: Record<string, unknown>;
  }[];
  /**
   * SDK 0.3.274 — where the server definition came from: "sdk" (an
   * in-process server this host registered), "plugin", or the config scope
   * (user/project/local/dynamic/managed/enterprise/claudeai/agent). Absent
   * on CLIs that predate the field.
   */
  source?: string;
};

/** CC 2.1.330 — labels for servers that don't come from a file Claudius edits. */
export const MCP_OTHER_SCOPE_LABELS: Record<string, string> = {
  claudeai: "claude.ai",
  dynamic: "Dynamic",
  managed: "Managed",
  enterprise: "Enterprise",
  sdk: "SDK",
  agent: "Agent",
};

/**
 * CC 2.1.330 — "Fixed `claude mcp remove` giving no way forward for a
 * claude.ai connector: it now says to turn it off in /mcp or remove it on
 * claude.ai". Claudius can only remove a server from a file it edits (one in
 * `configured`); for any other row, say where it's managed instead of
 * offering a Remove that silently does nothing. The claude.ai text adapts the
 * engine's own `claude mcp remove` message ("…are claude.ai connectors, which
 * Claude Code can't remove. To stop using one here, turn it off in /mcp. To
 * remove it from your account, go to …"), with "turn it off in /mcp" read as
 * this row's Disable button.
 */
export function mcpRemoveHint(name: string, scope: string): { label: string; title: string; href?: string } {
  if (scope === "claudeai" || name.startsWith("claude.ai ")) {
    return {
      label: "Remove on claude.ai",
      title:
        "A claude.ai connector, which Claude Code can't remove. To stop using it here, Disable it. To remove it from your account, go to claude.ai/customize/connectors.",
      href: "https://claude.ai/customize/connectors",
    };
  }
  if (name.startsWith("plugin:")) {
    const plugin = name.split(":")[1] || "a plugin";
    return {
      label: "Manage in Plugins",
      title: `From the plugin ${plugin} — disable or uninstall the plugin to remove it.`,
      href: "/plugins",
    };
  }
  if (scope === "user" || scope === "project" || scope === "local") {
    // e.g. a `claude mcp add` server kept in ~/.claude.json, which
    // `listConfigured` doesn't read.
    return {
      label: "Not removable here",
      title: `Not in a config file Claudius edits. Remove it from a terminal with: claude mcp remove "${name}" -s ${scope}`,
    };
  }
  return {
    label: "Not removable here",
    title: `Comes from ${MCP_OTHER_SCOPE_LABELS[scope] ?? scope} configuration, not a file Claudius edits.`,
  };
}

/**
 * Load configured MCP servers and (optionally) their live connection status
 * for `sessionId`. Pattern matches `useCost` (refetchTrigger +
 * AbortController + setState-in-callback).
 */
export function useMcp(cwd: string | null, sessionId: string | null) {
  const [configured, setConfigured] = useState<ConfiguredServer[]>([]);
  const [status, setStatus] = useState<LiveStatus[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  // CC 2.1.327 — which session `status` was actually read from. `sessionId`
  // can change without `loading` going back to true, and a session that
  // isn't in memory returns `status: null`; the page only says "not loaded
  // in this session" once this matches the current session.
  const [statusSessionId, setStatusSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (sessionId) params.set("sessionId", sessionId);

    fetch(`/api/mcp?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          throw new Error(typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}`);
        }
        return (await res.json()) as {
          configured: ConfiguredServer[];
          status: LiveStatus[] | null;
          statusError: string | null;
        };
      })
      .then((d) => {
        setConfigured(d.configured);
        setStatus(d.status ?? []);
        setStatusError(d.statusError);
        setStatusSessionId(sessionId && d.status != null ? sessionId : null);
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
  }, [cwd, sessionId, refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  /** Resolves to `null` on success, or the error text to show (CC 2.1.327:
   * e.g. the route's 409 when `.mcp.json` lists servers at the top level). */
  const upsert = useCallback(
    async (scope: McpScope, name: string, config: McpServerConfig): Promise<string | null> => {
      try {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, cwd, name, config }),
        });
        if (res.ok) {
          refresh();
          return null;
        }
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        return typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [cwd, refresh],
  );

  /** Resolves to `null` on success, or the error text to show (CC 2.1.330:
   * a Remove that didn't happen used to fail silently). */
  const remove = useCallback(
    async (scope: McpScope, name: string): Promise<string | null> => {
      try {
        const params = new URLSearchParams({ scope });
        if (cwd) params.set("cwd", cwd);
        const res = await fetch(`/api/mcp/${encodeURIComponent(name)}?${params}`, { method: "DELETE" });
        if (res.ok) {
          refresh();
          return null;
        }
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        return typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [cwd, refresh],
  );

  const reconnect = useCallback(
    async (name: string) => {
      if (!sessionId) return false;
      const res = await fetch(
        `/api/mcp/${encodeURIComponent(name)}/reconnect?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "POST" },
      );
      if (res.ok) setTimeout(refresh, 800);
      return res.ok;
    },
    [refresh, sessionId],
  );

  /**
   * Claude Code 2.1.284 — `/mcp reconnect all` retries every server that
   * failed to connect or needs authentication in one shot, instead of
   * clicking "Reconnect" on each row individually. Reuses the existing
   * single-server endpoint per server rather than adding a bulk server
   * route — there are only ever a handful of configured servers, and this
   * keeps the debounce/refresh handling in one place (see `reconnect`
   * above). Returns the count of servers it attempted to reconnect so the
   * caller can toast something meaningful; servers already `connected`,
   * `pending`, or `disabled` are left alone.
   */
  const reconnectAll = useCallback(async (): Promise<number> => {
    if (!sessionId) return 0;
    const targets = status.filter((s) => s.status === "failed" || s.status === "needs-auth");
    if (targets.length === 0) return 0;
    await Promise.all(
      targets.map((s) =>
        fetch(`/api/mcp/${encodeURIComponent(s.name)}/reconnect?sessionId=${encodeURIComponent(sessionId)}`, {
          method: "POST",
        }).catch(() => null),
      ),
    );
    setTimeout(refresh, 800);
    return targets.length;
  }, [refresh, sessionId, status]);

  const toggle = useCallback(
    async (name: string, enabled: boolean) => {
      if (!sessionId) return false;
      const res = await fetch(`/api/mcp/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, enabled }),
      });
      if (res.ok) setTimeout(refresh, 500);
      return res.ok;
    },
    [refresh, sessionId],
  );

  /** True once `status` holds the live list for the current `sessionId`. */
  const statusLoaded = sessionId != null && statusSessionId === sessionId;

  return {
    configured,
    status,
    statusError,
    statusLoaded,
    loading,
    error,
    refresh,
    upsert,
    remove,
    reconnect,
    reconnectAll,
    toggle,
  };
}
