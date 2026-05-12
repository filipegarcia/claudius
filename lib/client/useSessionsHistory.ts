"use client";

import { useCallback, useEffect, useState } from "react";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * The shape returned from `/api/sessions/all`: the SDK's session info
 * with one extra field. `claudiusTitle` is the title our SQLite index
 * holds — set by Claudius's own rename even when the SDK's JSONL-side
 * `renameSession` couldn't write the header (common for sessions
 * renamed before their first turn lands on disk). Display order should
 * be `claudiusTitle || customTitle || "(untitled)"`; `summary` and
 * `firstPrompt` are deliberately NOT title candidates.
 */
export type StoredSession = SDKSessionInfo & { claudiusTitle?: string };

export function useSessionsHistory() {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions/all");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions?: StoredSession[]; error?: string };
      if (data.error) throw new Error(data.error);
      setSessions(data.sessions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rename = useCallback(async (sessionId: string, title: string, dir?: string) => {
    const res = await fetch("/api/sessions/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, title, dir }),
    });
    if (res.ok) await refresh();
    return res.ok;
  }, [refresh]);

  const fork = useCallback(
    async (
      sessionId: string,
      opts: { upToMessageId?: string; title?: string; dir?: string } = {},
    ): Promise<string | null> => {
      const res = await fetch("/api/sessions/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...opts }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { sessionId?: string };
      return data.sessionId ?? null;
    },
    [],
  );

  const remove = useCallback(
    async (sessionId: string, dir?: string) => {
      const url = `/api/sessions/file/${sessionId}${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`;
      const res = await fetch(url, { method: "DELETE" });
      if (res.ok) await refresh();
      return res.ok;
    },
    [refresh],
  );

  return { sessions, loading, error, refresh, rename, fork, remove };
}
