"use client";

import { useCallback, useEffect, useState } from "react";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { hasMoreSessions, SESSION_PAGE_SIZE } from "@/lib/shared/session-pagination";

/**
 * The shape returned from `/api/sessions/all`: the SDK's session info
 * with one extra field. `claudiusTitle` is the title our SQLite index
 * holds — set by Claudius's own rename even when the SDK's JSONL-side
 * `renameSession` couldn't write the header (common for sessions
 * renamed before their first turn lands on disk). Display order should
 * be `claudiusTitle || customTitle || "(untitled)"`; `summary` and
 * `firstPrompt` are deliberately NOT title candidates.
 */
export type StoredSession = SDKSessionInfo & {
  claudiusTitle?: string;
  /**
   * Account profile the session is pinned to, resolved server-side from
   * `sessions.state.accountProfileId`. Absent means "unknown" (session
   * predates account pinning, or no profile was configured) — never
   * assume it's the currently-active account.
   */
  accountId?: string;
  accountLabel?: string;
};

/**
 * Load the sessions history. Pattern matches `useCost`
 * (refetchTrigger + AbortController + setState-in-callback).
 *
 * Pass `dir` to scope the fetch to a single workspace's project dir.
 * This matters: `/api/sessions/all` applies its `limit` (default 200)
 * by recency BEFORE any caller-side `cwd` filter runs. Fetching
 * unscoped means the 200-most-recent sessions *across every project*
 * are what the client gets — so a workspace with many sessions only
 * surfaces the handful that happen to win the global recency race, and
 * older ones vanish as unrelated projects get touched. Passing `dir`
 * makes the limit per-workspace, so every session in that workspace is
 * visible. Omit `dir` for a genuinely global listing.
 */
export function useSessionsHistory(opts: { dir?: string } = {}) {
  const { dir } = opts;
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  // Configured account-profile count, reported by the same endpoint. Below
  // 2 the UI hides account badges entirely — every row would read the same.
  const [accountsConfigured, setAccountsConfigured] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);
  // CC 2.1.243 (H9) — the requested page size, grown by `loadMore` so the list
  // can go past the default 200. Re-fetches a larger page (the route caps by
  // recency), simpler than cursor paging and matching the route's `limit`.
  const [limit, setLimit] = useState(SESSION_PAGE_SIZE);

  useEffect(() => {
    const controller = new AbortController();

    const params = new URLSearchParams();
    if (dir) params.set("dir", dir);
    params.set("limit", String(limit));
    const url = `/api/sessions/all?${params.toString()}`;
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as {
          sessions?: StoredSession[];
          accountsConfigured?: number;
          error?: string;
        };
      })
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setSessions(data.sessions ?? []);
        setAccountsConfigured(data.accountsConfigured ?? 0);
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
  }, [refetchTrigger, dir, limit]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  // CC 2.1.243 (H9) — bump the page size; the effect re-fetches a bigger page.
  const loadMore = useCallback(() => {
    setLoading(true);
    setLimit((l) => l + SESSION_PAGE_SIZE);
  }, []);
  // Reset the page size when the scope changes so switching workspaces doesn't
  // keep an inflated limit from a previous, larger listing.
  const [lastDir, setLastDir] = useState(dir);
  if (lastDir !== dir) {
    setLastDir(dir);
    setLimit(SESSION_PAGE_SIZE);
  }
  const hasMore = hasMoreSessions(sessions.length, limit);

  const rename = useCallback(
    async (sessionId: string, title: string, dir?: string) => {
      const res = await fetch("/api/sessions/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, title, dir }),
      });
      if (res.ok) refresh();
      return res.ok;
    },
    [refresh],
  );

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
      if (res.ok) refresh();
      return res.ok;
    },
    [refresh],
  );

  return { sessions, accountsConfigured, loading, error, refresh, rename, fork, remove, hasMore, loadMore };
}
