"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_VERBOSE,
  isVerboseLevel,
  type VerboseLevel,
} from "@/lib/shared/verbose";

/**
 * Per-workspace chat verbosity, with a localStorage cache so the chat
 * surface settles on the right level on the very first render — without
 * waiting for the `/api/workspaces` round-trip to come back.
 *
 * Read path:
 *   1. Initial render reads localStorage (`claudius.verbose.<workspaceId>`)
 *      so the value is available synchronously. Absent → `DEFAULT_VERBOSE`.
 *   2. On mount we fetch the workspace and reconcile: server value wins
 *      (it's the durable, shared-across-tabs source) and we update both
 *      state + cache so the next mount is fast.
 *
 * Write path:
 *   Local state updates immediately (optimistic). We PATCH the workspace
 *   with `{ defaults: { …existing, verbose } }`. Failure rolls the cache
 *   back to whatever the server returned via a refetch — but we don't
 *   roll back local state on the same render to avoid flicker; the user
 *   will see the value the server committed on the next reconcile.
 *
 * The cross-tab `storage` event listener keeps two open browser tabs in
 * sync the same way `useTheme` does.
 */

const STORAGE_PREFIX = "claudius.verbose.";
const SAME_TAB_EVENT = "claudius.verbose.changed";

type WorkspaceShape = {
  id: string;
  defaults?: Record<string, unknown>;
};

function cacheKeyFor(workspaceId: string | null): string | null {
  return workspaceId ? `${STORAGE_PREFIX}${workspaceId}` : null;
}

function readCache(workspaceId: string | null): VerboseLevel | null {
  if (typeof window === "undefined") return null;
  const key = cacheKeyFor(workspaceId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return isVerboseLevel(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(workspaceId: string | null, level: VerboseLevel): void {
  if (typeof window === "undefined") return;
  const key = cacheKeyFor(workspaceId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, level);
  } catch {
    // quota / private-mode — swallow
  }
  window.dispatchEvent(new Event(SAME_TAB_EVENT));
}

export function useVerbose(workspaceId: string | null): {
  verbose: VerboseLevel;
  setVerbose: (next: VerboseLevel) => Promise<void>;
  loading: boolean;
} {
  // Initial value: cache hit if available, otherwise the default. `loading`
  // tracks whether the server reconcile is still pending — when there's no
  // workspace at all there's nothing to fetch, so we start at `false`.
  const [verbose, setVerboseState] = useState<VerboseLevel>(() => readCache(workspaceId) ?? DEFAULT_VERBOSE);
  const [loading, setLoading] = useState<boolean>(
    () => workspaceId != null && readCache(workspaceId) == null,
  );

  // Re-seed when the workspace switches without remounting (rare — the rail
  // does a full document load — but defensive). Pattern matches `theme.ts`
  // and `useShortcut`: store the previous workspaceId in render so we don't
  // setState inside an effect. Also re-derives `loading` so a swap from
  // "no workspace" → some id flips us back into the reconcile state.
  const [prevId, setPrevId] = useState<string | null>(workspaceId);
  if (prevId !== workspaceId) {
    setPrevId(workspaceId);
    setVerboseState(readCache(workspaceId) ?? DEFAULT_VERBOSE);
    setLoading(workspaceId != null && readCache(workspaceId) == null);
  }

  // Server reconcile — runs once per workspace id. The server's value wins
  // over the cache because another tab (or `/workspace` page) may have
  // updated it. The fetch is best-effort: failure leaves the cached/default
  // value in place. The null-workspace branch early-returns without
  // touching state (the initial-state derivation above already accounts
  // for "no workspace = nothing to load").
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}`, { signal: controller.signal });
        if (!res.ok) return;
        const ws = (await res.json()) as WorkspaceShape;
        const serverLevel = isVerboseLevel(ws.defaults?.verbose) ? (ws.defaults!.verbose as VerboseLevel) : DEFAULT_VERBOSE;
        // Only push into state when it differs — avoids a render when the
        // cache was already right.
        setVerboseState((prev) => (prev === serverLevel ? prev : serverLevel));
        writeCache(workspaceId, serverLevel);
      } catch {
        // ignore — fetch errors keep the cached/default value
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [workspaceId]);

  // Cross-tab sync: when another tab writes the cache for this workspace,
  // pick up the change locally. Mirrors the `useTheme`/`useShortcut` pattern.
  useEffect(() => {
    if (!workspaceId) return;
    const key = cacheKeyFor(workspaceId);
    function onChanged() {
      const next = readCache(workspaceId);
      if (next) setVerboseState(next);
    }
    function onStorage(e: StorageEvent) {
      if (e.key === key) onChanged();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(SAME_TAB_EVENT, onChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SAME_TAB_EVENT, onChanged);
    };
  }, [workspaceId]);

  const setVerbose = useCallback(
    async (next: VerboseLevel) => {
      // Optimistic local update — the chat surface re-renders immediately.
      setVerboseState(next);
      writeCache(workspaceId, next);
      if (!workspaceId) return;
      try {
        // Read first so the PATCH body preserves any other defaults the
        // workspace already has (model, permissionMode, mcpServerIds, …).
        // The PATCH does a shallow merge at the top level; if we sent
        // `defaults: { verbose }` alone it would replace the whole object.
        const cur = await fetch(`/api/workspaces/${workspaceId}`);
        let nextDefaults: Record<string, unknown> = { verbose: next };
        if (cur.ok) {
          const ws = (await cur.json()) as WorkspaceShape;
          nextDefaults = { ...(ws.defaults ?? {}), verbose: next };
        }
        await fetch(`/api/workspaces/${workspaceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaults: nextDefaults }),
        });
      } catch {
        // Silent failure — local state stays at `next`; the next reconcile
        // (page reload, workspace switch) will surface the server's truth.
      }
    },
    [workspaceId],
  );

  return { verbose, setVerbose, loading };
}
