"use client";

import { useCallback, useEffect, useState } from "react";

export type RuleKind = "allow" | "ask" | "deny";
export type Scope = "user" | "project" | "local";

export type ScopedRules = Record<
  Scope,
  {
    allow: string[];
    ask: string[];
    deny: string[];
    blockReadsOutsideWorkingDirectories: boolean;
    blockWritesOutsideWorkingDirectories: boolean;
    /** CC 2.1.319 — only meaningful (and only offered) on the `user` scope. */
    denyInsteadOfPrompting: boolean;
  }
>;

const EMPTY: ScopedRules = {
  user: { allow: [], ask: [], deny: [], blockReadsOutsideWorkingDirectories: false, blockWritesOutsideWorkingDirectories: false, denyInsteadOfPrompting: false },
  project: { allow: [], ask: [], deny: [], blockReadsOutsideWorkingDirectories: false, blockWritesOutsideWorkingDirectories: false, denyInsteadOfPrompting: false },
  local: { allow: [], ask: [], deny: [], blockReadsOutsideWorkingDirectories: false, blockWritesOutsideWorkingDirectories: false, denyInsteadOfPrompting: false },
};

/**
 * Load the per-scope permission rules. Pattern matches `useCost`
 * (refetchTrigger + AbortController + setState-in-callback).
 */
export function usePermissions() {
  const [rules, setRules] = useState<ScopedRules>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // CC 2.1.326 — a failed save keeps its message through the rollback
  // refetch (which clears `error` on success); only a later successful save
  // clears it. Without this the rule vanished and so did the warning.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/settings/permissions", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Record<
          Scope,
          {
            allow?: string[];
            ask?: string[];
            deny?: string[];
            blockReadsOutsideWorkingDirectories?: boolean;
            blockWritesOutsideWorkingDirectories?: boolean;
            denyInsteadOfPrompting?: boolean;
          }
        >;
      })
      .then((data) => {
        const normalized: ScopedRules = {
          user: {
            allow: data.user?.allow ?? [],
            ask: data.user?.ask ?? [],
            deny: data.user?.deny ?? [],
            blockReadsOutsideWorkingDirectories: data.user?.blockReadsOutsideWorkingDirectories ?? false,
            blockWritesOutsideWorkingDirectories: data.user?.blockWritesOutsideWorkingDirectories ?? false,
            denyInsteadOfPrompting: data.user?.denyInsteadOfPrompting === true,
          },
          project: {
            allow: data.project?.allow ?? [],
            ask: data.project?.ask ?? [],
            deny: data.project?.deny ?? [],
            blockReadsOutsideWorkingDirectories: data.project?.blockReadsOutsideWorkingDirectories ?? false,
            blockWritesOutsideWorkingDirectories: data.project?.blockWritesOutsideWorkingDirectories ?? false,
            denyInsteadOfPrompting: data.project?.denyInsteadOfPrompting === true,
          },
          local: {
            allow: data.local?.allow ?? [],
            ask: data.local?.ask ?? [],
            deny: data.local?.deny ?? [],
            blockReadsOutsideWorkingDirectories: data.local?.blockReadsOutsideWorkingDirectories ?? false,
            blockWritesOutsideWorkingDirectories: data.local?.blockWritesOutsideWorkingDirectories ?? false,
            denyInsteadOfPrompting: data.local?.denyInsteadOfPrompting === true,
          },
        };
        setRules(normalized);
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
  }, [refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  /**
   * CC 2.1.326 — after a POST: on failure show the server's message (it names
   * the settings file that couldn't be written) and roll back with a refetch.
   * Returns whether the save landed.
   */
  const settle = useCallback(
    async (res: Response): Promise<boolean> => {
      if (res.ok) {
        setSaveError(null);
        return true;
      }
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      setSaveError(typeof body?.error === "string" && body.error ? body.error : `save failed: ${res.status}`);
      refresh();
      return false;
    },
    [refresh],
  );

  /**
   * CC 2.1.323 — pass `delta` (the rules added / removed) and only that is
   * sent; the server applies it to a fresh read of the file, so a rule
   * hand-added since the page loaded isn't dropped. Without it, the whole
   * `next` list replaces the file's.
   */
  const updateRules = useCallback(
    async (scope: Scope, kind: RuleKind, next: string[], delta?: { add?: string[]; remove?: string[] }) => {
      // Optimistic local update. We patch onto the latest `rules` via the
      // functional setter so the closure doesn't capture a stale snapshot
      // when called twice in rapid succession.
      setRules((prev) => ({ ...prev, [scope]: { ...prev[scope], [kind]: next } }));
      const res = await fetch("/api/settings/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delta ? { scope, ruleDelta: { kind, ...delta } } : { scope, patch: { [kind]: next } }),
      });
      if (!(await settle(res))) return;
      if (!delta) return;
      // The server merged the delta into a fresh read: show that list, which
      // also holds any rule added to the file since the page loaded.
      const body = (await res.json().catch(() => null)) as {
        settings?: { permissions?: Partial<Record<RuleKind, unknown>> };
      } | null;
      const merged = body?.settings?.permissions?.[kind];
      if (Array.isArray(merged) && merged.every((r) => typeof r === "string")) {
        setRules((prev) => ({ ...prev, [scope]: { ...prev[scope], [kind]: merged } }));
      }
    },
    [settle],
  );

  // CC 2.1.257 parity — same optimistic-update / rollback-on-failure shape
  // as `updateRules`, but for the single `blockReadsOutsideWorkingDirectories`
  // boolean rather than a rule-kind array.
  const updateBlockReadsOutsideWorkingDirectories = useCallback(
    async (scope: Scope, next: boolean) => {
      setRules((prev) => ({ ...prev, [scope]: { ...prev[scope], blockReadsOutsideWorkingDirectories: next } }));
      const res = await fetch("/api/settings/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, patch: { blockReadsOutsideWorkingDirectories: next } }),
      });
      await settle(res);
    },
    [settle],
  );

  // SDK 0.3.314 — write-side twin of the reads toggle above.
  const updateBlockWritesOutsideWorkingDirectories = useCallback(
    async (scope: Scope, next: boolean) => {
      setRules((prev) => ({ ...prev, [scope]: { ...prev[scope], blockWritesOutsideWorkingDirectories: next } }));
      const res = await fetch("/api/settings/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, patch: { blockWritesOutsideWorkingDirectories: next } }),
      });
      await settle(res);
    },
    [settle],
  );

  // CC 2.1.319 — `permissions.denyInsteadOfPrompting`. Scope hardcoded to
  // "user": the engine ignores it in project / local settings (same reason
  // `updateAutoMode` is user-only).
  const updateDenyInsteadOfPrompting = useCallback(
    async (next: boolean) => {
      setRules((prev) => ({ ...prev, user: { ...prev.user, denyInsteadOfPrompting: next } }));
      const res = await fetch("/api/settings/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "user", patch: { denyInsteadOfPrompting: next } }),
      });
      await settle(res);
    },
    [settle],
  );

  return {
    rules,
    loading,
    error,
    saveError,
    refresh,
    updateRules,
    updateBlockReadsOutsideWorkingDirectories,
    updateBlockWritesOutsideWorkingDirectories,
    updateDenyInsteadOfPrompting,
  };
}
