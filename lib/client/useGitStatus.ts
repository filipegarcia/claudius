"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitFileChange } from "@/lib/server/git";
import { nextGitPollDelayMs } from "@/lib/client/git-poll";

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
 * CC 2.1.316 parity — "Improved /diff on large repositories: each refresh
 * usually runs one fewer full-repository git command, and refreshes are
 * spaced out when git is slow". This used to be a fixed 4s `setInterval`
 * whose every tick aborted the in-flight request — on a repo where `git
 * status` takes longer than 4s the Changes list never updated and the
 * server's git children overlapped until their timeout. Now the poll
 * schedules itself: a background tick (or the tab becoming visible again)
 * never aborts or stacks on a running request, and the next tick is armed
 * only once the current one settles, `nextGitPollDelayMs(intervalMs,
 * duration)` later — so a slow git is polled proportionally less often.
 * An explicit `refresh()` still fires at once (superseding a stale poll),
 * and a workspace switch / unmount still aborts. Returned `data` is
 * derived to be null whenever the loaded payload doesn't match the current
 * `workspaceId` — preventing a stale-data flash during workspace switches.
 */
export function useGitStatus(workspaceId: string | null, intervalMs = 4000) {
  const [stored, setStored] = useState<{ wsId: string; payload: GitStatusPayload } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The live poller's "fetch now" entry point, owned by the effect below so
  // `refresh()` can reach it without re-running the effect.
  const runRef = useRef<((force: boolean) => void) | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let disposed = false;
    // The in-flight request, if any. Each request checks it is still the
    // current one before touching state or arming the next tick, so a
    // superseded (aborted) request's late `finally` can't start a second
    // polling chain or clear the in-flight marker of its replacement.
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isVisible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";

    const run = (force: boolean) => {
      if (disposed) return;
      if (controller) {
        // A background tick never aborts a poll that's still running —
        // that was the slow-repo starvation. Only an explicit refresh
        // supersedes it (its answer may predate the stage/commit).
        if (!force) return;
        controller.abort();
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const ac = new AbortController();
      controller = ac;
      const startedAt = Date.now();
      fetch(`/api/workspaces/${workspaceId}/git/status`, { signal: ac.signal })
        .then(async (res) => {
          if (!res.ok) {
            const e = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(e.error ?? `HTTP ${res.status}`);
          }
          return (await res.json()) as GitStatusPayload;
        })
        .then((payload) => {
          if (controller !== ac) return;
          setStored({ wsId: workspaceId, payload });
          setError(null);
        })
        .catch((err: unknown) => {
          if (controller !== ac) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (controller !== ac) return;
          controller = null;
          setLoading(false);
          // Armed after errors too, so one failed status doesn't stop
          // polling for good.
          timer = setTimeout(tick, nextGitPollDelayMs(intervalMs, Date.now() - startedAt));
        });
    };
    // A tick that lands while the tab is hidden lets the chain lapse; the
    // `visibilitychange` listener restarts it when the tab comes back.
    const tick = () => {
      timer = null;
      if (isVisible()) run(false);
    };
    const onVisibility = () => {
      if (isVisible()) run(false);
    };

    runRef.current = run;
    run(false);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      disposed = true;
      if (runRef.current === run) runRef.current = null;
      if (timer !== null) clearTimeout(timer);
      // Workspace switch / unmount mid-flight: discard the response so we
      // never write workspace-A data into workspace-B's render.
      controller?.abort();
      controller = null;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [workspaceId, intervalMs]);

  const refresh = useCallback(() => {
    setLoading(true);
    runRef.current?.(true);
  }, []);

  // Surface null until the loaded payload matches the current workspaceId —
  // otherwise consumers briefly render workspace-A's files under
  // workspace-B's header during a switch.
  const data = stored && stored.wsId === workspaceId ? stored.payload : null;

  return { data, error, loading, refresh };
}
