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
  | { kind: "applying"; startedAt: number; strategy: "ff-only" | "cc-merge" }
  | { kind: "restarting"; startedAt: number };

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
  setMode: (mode: UpdaterMode) => Promise<void>;
  busy: boolean;
};

export function useUpdater(pollMs = 8_000): UseUpdater {
  const [data, setData] = useState<UpdaterStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      try {
        await fetch("/api/updater/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ allowCcMerge: opts?.allowCcMerge === true }),
        });
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

  return { data, loading, error, refresh, check, apply, setMode, busy };
}
