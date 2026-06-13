"use client";

import { useCallback, useEffect, useState } from "react";

export type UpdaterMode = "cc-merge" | "ff-only" | "notify-only" | "disabled";

export type UpdaterPending = {
  remoteSha: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  branch: string;
  upstreamBranch: string;
  recentCommits?: string[];
};

export type UpdaterStatusKind =
  | { kind: "idle" }
  | { kind: "checking"; startedAt: number }
  | { kind: "applying"; startedAt: number; strategy: "ff-only" | "stash-ff" | "cc-merge" }
  | { kind: "restarting"; startedAt: number };

export type UpdaterConflicts = {
  fromSha: string;
  toSha: string;
  detectedAt: number;
  origin: "stash-ff" | "cc-merge";
  detail: string;
};

export type UpdaterRecovery = {
  phase: "install" | "build";
  fromSha: string;
  toSha: string;
  detectedAt: number;
  detail: string;
};

export type UpdaterStatusResponse = {
  settings: {
    mode: UpdaterMode;
    remote: string;
    branch: string;
    intervalHours: number;
  };
  state: {
    lastCheckAt?: number;
    lastUpdateAt?: number;
    lastUpdateSha?: string;
    lastError?: string;
    pending?: UpdaterPending;
    conflicts?: UpdaterConflicts;
    recovery?: UpdaterRecovery;
    status: UpdaterStatusKind;
  };
  install: {
    root: string;
    isGitCheckout: boolean;
    currentSha?: string;
    currentBranch: string | null;
    runtimeMode: "daemon" | "dev" | "unknown";
  };
};

export type UseUpdater = {
  data: UpdaterStatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  check: () => Promise<void>;
  apply: (opts?: { allowCcMerge?: boolean }) => Promise<void>;
  /**
   * Set when the most recent `apply()` call returned a non-fatal outcome
   * the user should know about (e.g. "skipped: resolve conflicts first").
   * Cleared automatically at the start of each new `apply()` call.
   */
  applyError: string | null;
  /**
   * Stages a Claude Code chat for resolving the merge conflicts. Switches
   * the active workspace to one rooted at the install dir (creating it if
   * needed) and returns the prompt text to seed into the composer. The
   * caller is responsible for stashing the prompt into sessionStorage and
   * navigating to `/<workspaceId>?new=1&prefill=1` — the chat page picks
   * the prompt up via the existing `?prefill=1` mechanism. Returns null on
   * failure.
   */
  resolveWithClaude: () => Promise<{ workspaceId: string; prompt: string } | null>;
  setMode: (mode: UpdaterMode) => Promise<void>;
  busy: boolean;
};

export function useUpdater(pollMs = 8_000): UseUpdater {
  const [data, setData] = useState<UpdaterStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/updater/status", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData((await r.json()) as UpdaterStatusResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer the first call out of the effect body so the lint rule about
    // synchronous setState in effects stays quiet (same pattern as useDocker).
    const initial = setTimeout(() => void refresh(), 0);
    const tick = pollMs ? setInterval(() => void refresh(), pollMs) : null;
    return () => {
      clearTimeout(initial);
      if (tick) clearInterval(tick);
    };
  }, [refresh, pollMs]);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/updater/check", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const apply = useCallback(
    async (opts?: { allowCcMerge?: boolean }) => {
      setBusy(true);
      setApplyError(null);
      try {
        const res = await fetch("/api/updater/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ allowCcMerge: opts?.allowCcMerge === true }),
        });
        if (res.ok) {
          const body = (await res.json()) as {
            kind?: string;
            reason?: string;
            message?: string;
            phase?: string;
          };
          if (body.kind === "skipped") {
            setApplyError(`Skipped: ${body.reason ?? "unknown reason"}`);
          } else if (body.kind === "error") {
            const where = body.phase ? ` (${body.phase})` : "";
            setApplyError(`Failed${where}: ${body.message ?? "unknown error"}`);
          }
        }
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const setMode = useCallback(
    async (mode: UpdaterMode) => {
      setBusy(true);
      try {
        await fetch("/api/updater/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const resolveWithClaude = useCallback(async (): Promise<
    { workspaceId: string; prompt: string } | null
  > => {
    setBusy(true);
    try {
      const res = await fetch("/api/updater/resolve-with-claude", { method: "POST" });
      if (!res.ok) return null;
      const body = (await res.json()) as { workspaceId?: string; prompt?: string };
      if (!body.workspaceId || !body.prompt) return null;
      return { workspaceId: body.workspaceId, prompt: body.prompt };
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { data, loading, error, refresh, check, apply, applyError, resolveWithClaude, setMode, busy };
}
