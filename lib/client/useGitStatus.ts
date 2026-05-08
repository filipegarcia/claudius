"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitFileChange } from "@/lib/server/git";

export type GitStatusPayload = {
  isRepo: boolean;
  repoRoot?: string;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  files: GitFileChange[];
};

/**
 * Polls /api/workspaces/[id]/git/status. Refresh is exposed so callers can
 * re-pull immediately after a stage/commit op without waiting for the timer.
 */
export function useGitStatus(workspaceId: string | null, intervalMs = 4000) {
  const [data, setData] = useState<GitStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setData(null);
      return;
    }
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/git/status`, { signal: ac.signal });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as GitStatusPayload;
      setData(payload);
      setError(null);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    void refresh();
    // Skip ticks while the tab is hidden — `git status` on a 200-file repo
    // is cheap but pointless to keep running for a backgrounded tab.
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void refresh();
      }
    }, intervalMs);
    // Pull once when the tab returns to foreground so the user doesn't see
    // stale state on the first paint after switching back.
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis);
    }
    return () => {
      clearInterval(id);
      inflight.current?.abort();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis);
      }
    };
  }, [workspaceId, intervalMs, refresh]);

  return { data, error, loading, refresh };
}
