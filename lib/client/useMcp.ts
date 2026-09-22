"use client";

import { useCallback, useEffect, useState } from "react";
import type { McpScope, McpServerConfig } from "@/lib/server/mcp";

export type ConfiguredServer = { scope: McpScope; name: string; config: McpServerConfig };

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

/**
 * Load configured MCP servers and (optionally) their live connection status
 * for `sessionId`. Pattern matches `useCost` (refetchTrigger +
 * AbortController + setState-in-callback).
 */
export function useMcp(cwd: string | null, sessionId: string | null) {
  const [configured, setConfigured] = useState<ConfiguredServer[]>([]);
  const [status, setStatus] = useState<LiveStatus[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

  const upsert = useCallback(
    async (scope: McpScope, name: string, config: McpServerConfig) => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, name, config }),
      });
      if (res.ok) refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  const remove = useCallback(
    async (scope: McpScope, name: string) => {
      const params = new URLSearchParams({ scope });
      if (cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/mcp/${encodeURIComponent(name)}?${params}`, { method: "DELETE" });
      if (res.ok) refresh();
      return res.ok;
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

  return { configured, status, statusError, loading, error, refresh, upsert, remove, reconnect, toggle };
}
