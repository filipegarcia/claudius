"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Hammer, CheckCircle2, AlertTriangle } from "lucide-react";

type BuildStatus = "building" | "done" | "error";

type BuildState = {
  customizationId: string;
  status: BuildStatus;
  startedAt: number;
  finishedAt: number | null;
  artifactPath: string | null;
  errorMessage?: string;
  logs: string[];
};

type Availability = { available: boolean; reason?: string };

type GetResponse = { availability: Availability; state: BuildState | null };

/**
 * "Build installable app" — bakes this customization's overlay into a fresh
 * Claudius.app via `scripts/build-app-local.mjs` (a few-minute build). Polls
 * for progress and surfaces the resulting bundle path. Hidden/disabled when
 * the runtime has no source checkout to build from.
 */
export function BuildAppPanel({ customizationId }: { customizationId: string }) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [state, setState] = useState<BuildState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch(`/api/customizations/${customizationId}/build-app`, { signal });
      if (!r.ok) return;
      const d = (await r.json()) as GetResponse;
      setAvailability(d.availability);
      setState(d.state);
    } catch {
      // best-effort
    }
  }, [customizationId]);

  useEffect(() => {
    const controller = new AbortController();
    // Defer the initial fetch to a timer callback so the setState inside `load`
    // fires from an external-system update, not synchronously in the effect
    // body (satisfies react-hooks/set-state-in-effect — same idiom as the
    // other customize panels).
    const t = setTimeout(() => void load(controller.signal), 0);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [load]);

  // Poll while a build is running.
  useEffect(() => {
    const building = state?.status === "building";
    if (building && !pollRef.current) {
      pollRef.current = setInterval(() => void load(), 3000);
    }
    if (!building && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [state?.status, load]);

  const onBuild = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/customizations/${customizationId}/build-app`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setError((d as { error?: string }).error ?? "build failed to start");
      } else {
        setState(d as BuildState);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "build failed to start");
    } finally {
      setBusy(false);
    }
  }, [customizationId]);

  if (availability && !availability.available) {
    return (
      <p className="text-xs text-[var(--muted)]">
        {availability.reason ??
          "Local build isn't available in this runtime."}
      </p>
    );
  }

  const building = state?.status === "building";
  const tail = state?.logs.slice(-8) ?? [];

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void onBuild()}
          disabled={busy || building}
          className="flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy || building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hammer className="h-4 w-4" />}
          {building ? "Building…" : "Build installable app"}
        </button>
        <span className="text-xs text-[var(--muted)]">
          Bakes your changes into a new Claudius.app (a few minutes). Doesn&apos;t touch the running app.
        </span>
      </div>

      {state?.status === "done" && state.artifactPath && (
        <div className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <div className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" /> Build complete
          </div>
          <div className="mt-1 break-all font-mono text-[11px] text-[var(--foreground)]">
            {state.artifactPath}
          </div>
          <div className="mt-1 text-[var(--muted)]">
            Open it with{" "}
            <code className="rounded bg-black/40 px-1">open &quot;{state.artifactPath}&quot;</code>{" "}
            (unsigned — right-click → Open the first time).
          </div>
        </div>
      )}

      {state?.status === "error" && (
        <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" /> Build failed
          </div>
          {state.errorMessage && <div className="mt-1">{state.errorMessage}</div>}
        </div>
      )}

      {(building || tail.length > 0) && (
        <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-[var(--border)] bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--muted)]">
          {tail.join("\n") || "starting…"}
        </pre>
      )}
    </div>
  );
}
