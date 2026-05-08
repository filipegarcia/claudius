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
  tools?: { name: string; description?: string; annotations?: unknown }[];
};

export function useMcp(cwd: string | null, sessionId: string | null) {
  const [configured, setConfigured] = useState<ConfiguredServer[]>([]);
  const [status, setStatus] = useState<LiveStatus[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      if (sessionId) params.set("sessionId", sessionId);
      const res = await fetch(`/api/mcp?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as {
        configured: ConfiguredServer[];
        status: LiveStatus[] | null;
        statusError: string | null;
      };
      setConfigured(d.configured);
      setStatus(d.status ?? []);
      setStatusError(d.statusError);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsert = useCallback(
    async (scope: McpScope, name: string, config: McpServerConfig) => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, name, config }),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [cwd, refresh],
  );

  const remove = useCallback(
    async (scope: McpScope, name: string) => {
      const params = new URLSearchParams({ scope });
      if (cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/mcp/${encodeURIComponent(name)}?${params}`, { method: "DELETE" });
      if (res.ok) await refresh();
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
      if (res.ok) setTimeout(() => void refresh(), 800);
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
      if (res.ok) setTimeout(() => void refresh(), 500);
      return res.ok;
    },
    [refresh, sessionId],
  );

  return { configured, status, statusError, loading, error, refresh, upsert, remove, reconnect, toggle };
}
