"use client";

import { useCallback, useEffect, useState } from "react";
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
 * Polls `/api/workspaces/[id]/git/status`. `refresh()` re-pulls immediately
 * (callers use it after a stage/commit op so the user doesn't wait for the
 * timer). Background ticks are skipped while the tab is hidden — `git
 * status` on a 200-file repo is cheap but pointless to keep running for a
 * backgrounded tab.
 *
 * Pattern matches `useCost` (refetchTrigger + AbortController +
 * setState-in-callback) with two effects: one owns the fetch, the other
 * owns the polling/visibility wiring. Returned `data` is derived to be
 * null whenever the loaded payload doesn't match the current
 * `workspaceId` — preventing a stale-data flash during workspace switches.
 */
export function useGitStatus(workspaceId: string | null, intervalMs = 4000) {
  const [stored, setStored] = useState<{ wsId: string; payload: GitStatusPayload } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  // Fetch effect. Re-runs on workspace switch and on every refresh()
  // (which bumps refetchTrigger). AbortController makes a workspace switch
  // mid-flight discard the response so we never write workspace-A data
  // into workspace-B's render.
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();

    fetch(`/api/workspaces/${workspaceId}/git/status`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as GitStatusPayload;
      })
      .then((payload) => {
        setStored({ wsId: workspaceId, payload });
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
  }, [workspaceId, refetchTrigger]);

  // Polling + visibility effect. Bumps the trigger from inside callbacks
  // (interval, event listener) so the setState isn't sync-in-effect-body.
  useEffect(() => {
    if (!workspaceId) return;
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        setRefetchTrigger((n) => n + 1);
      }
    };
    const id = setInterval(tick, intervalMs);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", tick);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", tick);
      }
    };
  }, [workspaceId, intervalMs]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  // Surface null until the loaded payload matches the current workspaceId —
  // otherwise consumers briefly render workspace-A's files under
  // workspace-B's header during a switch.
  const data = stored && stored.wsId === workspaceId ? stored.payload : null;

  return { data, error, loading, refresh };
}
