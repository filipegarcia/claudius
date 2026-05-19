"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Calendar,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Save,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { CronEditor } from "@/components/schedule/CronEditor";
import { fmtElapsedSec } from "@/components/panels/widgets/format";
import { describeCron } from "@/lib/shared/cron";
import type { Job, Run, RunStatus } from "@/lib/server/scheduler-store";
import {
  isStaleWakeup,
  type SessionLoopListItem,
  type SessionLoopListResponse,
} from "@/lib/shared/session-loops";
import { cn } from "@/lib/utils/cn";

const STATUS_TONES: Record<RunStatus, string> = {
  running: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  error: "border-red-500/40 bg-red-500/10 text-red-200",
  cancelled: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  skipped: "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
};

function fmtRel(ms?: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function fmtUsd(n?: number): string {
  if (typeof n !== "number" || n === 0) return n === 0 ? "$0.00" : "—";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

export default function SchedulePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [jobsRefetchTrigger, setJobsRefetchTrigger] = useState(0);
  const [runsRefetchTrigger, setRunsRefetchTrigger] = useState(0);

  // Session-only loops fetched from /api/schedule/session-loops. These are
  // distinct from durable jobs: armed via the SDK's CronCreate/
  // ScheduleWakeup tools, scoped to a live agent session, and they die
  // when the owning session is evicted. We poll on a 5s cadence — fast
  // enough to feel live, slow enough not to thrash the server — because
  // there's no SSE channel for cross-session loop changes (each session
  // has its own stream).
  const [sessionLoops, setSessionLoops] = useState<SessionLoopListItem[]>([]);
  const [sessionLoopsError, setSessionLoopsError] = useState<string | null>(null);
  const [cancellingLoopIds, setCancellingLoopIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/schedule", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { jobs: Job[] };
      })
      .then((data) => {
        setJobs(data.jobs);
        // Only auto-select if nothing's selected yet. We read activeId
        // via the functional setter so the closure doesn't capture a
        // stale value on rapid back-to-back refreshes.
        setActiveId((current) => current ?? data.jobs[0]?.id ?? null);
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
  }, [jobsRefetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setJobsRefetchTrigger((n) => n + 1);
  }, []);

  // Clear runs when the user deselects a job. Render-phase reset so the
  // fetch effect below contains no sync setState in its body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastActiveId, setLastActiveId] = useState(activeId);
  if (lastActiveId !== activeId) {
    setLastActiveId(activeId);
    if (!activeId) setRuns([]);
  }

  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();

    fetch(`/api/schedule/${activeId}/runs?limit=50`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as { runs: Run[] };
      })
      .then((d) => {
        if (d) setRuns(d.runs);
      })
      .catch(() => {
        // ignore
      });

    return () => controller.abort();
  }, [activeId, runsRefetchTrigger]);

  const refreshRuns = useCallback(() => {
    setRunsRefetchTrigger((n) => n + 1);
  }, []);

  // Cheap auto-refresh: while any run for the active job is "running",
  // poll every 2 s so the badge flips to its final status without the user
  // clicking refresh.
  const hasLive = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => void refreshRuns(), 2000);
    return () => clearInterval(id);
  }, [hasLive, refreshRuns]);

  // Poll session loops every 5s while the tab is visible. We refetch
  // synchronously on cancel-click too (in `onCancelSessionLoop`) so the
  // chip updates faster than the next interval tick.
  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const res = await fetch("/api/schedule/session-loops");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SessionLoopListResponse;
        if (cancelled) return;
        setSessionLoops(data.loops);
        setSessionLoopsError(null);
        // Drop any "cancelling…" markers whose loop has actually flipped
        // to `cancelled: true` upstream (the agent ran CronDelete) OR
        // disappeared from the list entirely (session reaped).
        setCancellingLoopIds((prev) => {
          if (prev.size === 0) return prev;
          const alive = new Set(
            data.loops.filter((l) => !l.cancelled).map((l) => `${l.sessionId}:${l.id}`),
          );
          const next = new Set<string>();
          for (const key of prev) {
            if (alive.has(key)) next.add(key);
          }
          return next.size === prev.size ? prev : next;
        });
      } catch (err) {
        if (cancelled) return;
        setSessionLoopsError(err instanceof Error ? err.message : String(err));
      }
    }
    void pull();
    const id = setInterval(() => void pull(), 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onCancelSessionLoop = useCallback(async (loop: SessionLoopListItem) => {
    const key = `${loop.sessionId}:${loop.id}`;
    setCancellingLoopIds((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      const res = await fetch("/api/schedule/session-loops/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: loop.sessionId, loopId: loop.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Roll back the optimistic flip so the user can retry.
      setCancellingLoopIds((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const active = useMemo(() => jobs.find((j) => j.id === activeId) ?? null, [jobs, activeId]);

  const onCreate = async (input: Pick<Job, "name" | "cron" | "prompt" | "cwd"> & { model?: string }) => {
    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      setError(e.error ?? `HTTP ${res.status}`);
      return false;
    }
    const job = (await res.json()) as Job;
    await refresh();
    setActiveId(job.id);
    setCreating(false);
    return true;
  };

  const onPatch = async (id: string, patch: Partial<Job>) => {
    const res = await fetch(`/api/schedule/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) await refresh();
  };

  const onDelete = async (id: string) => {
    if (!confirm("Delete this job and its run history?")) return;
    const res = await fetch(`/api/schedule/${id}`, { method: "DELETE" });
    if (res.ok) {
      if (activeId === id) setActiveId(null);
      await refresh();
    }
  };

  const onRunNow = async (id: string) => {
    await fetch(`/api/schedule/${id}/run-now`, { method: "POST" });
    setTimeout(() => {
      void refresh();
      void refreshRuns();
    }, 1500);
  };

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="schedule-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Calendar className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Schedule</span>
          <span className="text-[var(--muted)]" title="Durable jobs · Active session loops">
            ({jobs.length}
            {sessionLoops.length > 0 ? ` · ${sessionLoops.filter((l) => !l.cancelled).length} live` : ""})
          </span>
          {loading && <span className="text-[var(--muted)]">loading…</span>}
          {error && <span className="text-red-400">{error}</span>}
          <button
            onClick={refresh}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          <button
            onClick={() => setCreating((c) => !c)}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-white hover:opacity-90"
          >
            {creating ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {creating ? "Cancel" : "New job"}
          </button>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="w-72 shrink-0 overflow-y-auto border-r border-[var(--border)] scroll-thin">
            <SessionLoopsGroup
              loops={sessionLoops}
              cancellingKeys={cancellingLoopIds}
              error={sessionLoopsError}
              onCancel={onCancelSessionLoop}
            />
            <div
              className="sticky top-0 z-10 flex items-center gap-1.5 border-y border-[var(--border)] bg-[var(--panel)]/95 px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)] backdrop-blur"
              title="Persisted cron jobs that spawn a fresh Claude session on each fire — survive server restarts."
            >
              <Calendar className="h-3 w-3" />
              Durable jobs
              <span className="ml-auto normal-case opacity-70">({jobs.length})</span>
            </div>
            {jobs.length === 0 && !creating ? (
              <div className="px-4 py-10 text-center text-xs text-[var(--muted)]">
                No durable jobs yet.
                <button
                  onClick={() => setCreating(true)}
                  className="mt-2 block w-full rounded-md bg-[var(--accent)] px-3 py-1.5 text-white hover:opacity-90"
                >
                  Create your first job
                </button>
              </div>
            ) : (
              <ul>
                {jobs.map((j) => (
                  <li key={j.id}>
                    <button
                      onClick={() => setActiveId(j.id)}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left text-xs",
                        activeId === j.id ? "bg-[var(--panel-2)]" : "hover:bg-[var(--panel-2)]/60",
                      )}
                    >
                      <div className="flex w-full items-baseline justify-between gap-2">
                        <span className="truncate font-medium">{j.name}</span>
                        <span
                          className={cn(
                            "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px]",
                            j.enabled
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                              : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]",
                          )}
                        >
                          {j.enabled ? "on" : "off"}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--muted)]">{j.cron}</span>
                      <span className="text-[10px] text-[var(--muted)]">
                        next {j.nextRunAt ? new Date(j.nextRunAt).toLocaleTimeString() : "—"} · last {fmtRel(j.lastRunAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="flex flex-1 overflow-hidden">
            {creating ? (
              <JobForm onSubmit={onCreate} onCancel={() => setCreating(false)} />
            ) : active ? (
              <JobDetail
                key={active.id}
                job={active}
                runs={runs}
                onPatch={(p) => onPatch(active.id, p)}
                onDelete={() => onDelete(active.id)}
                onRunNow={() => onRunNow(active.id)}
                onRefreshRuns={refreshRuns}
              />
            ) : (
              <div className="flex h-full flex-1 items-center justify-center text-sm text-[var(--muted)]">
                Pick a job to see runs.
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function JobForm({
  onSubmit,
  onCancel,
  initial,
}: {
  onSubmit: (input: Pick<Job, "name" | "cron" | "prompt" | "cwd"> & { model?: string }) => Promise<boolean>;
  onCancel: () => void;
  initial?: Job;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "*/5 * * * *");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = name.trim() && cron.trim() && prompt.trim() && !submitting;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        try {
          await onSubmit({ name: name.trim(), cron: cron.trim(), prompt, cwd, model: model || undefined });
        } finally {
          setSubmitting(false);
        }
      }}
      className="flex h-full w-full flex-col gap-4 overflow-y-auto p-6 scroll-thin"
    >
      <h2 className="text-sm font-medium">{initial ? "Edit job" : "New scheduled job"}</h2>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily build status"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm focus:outline-none"
        />
      </Field>
      <Field label="Cron expression">
        <CronEditor value={cron} onChange={setCron} />
      </Field>
      <Field label="Prompt (or /slash command)">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          placeholder="Summarize today's commits and post a 3-bullet update."
          className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none scroll-thin"
        />
      </Field>
      <Field label="Working directory">
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="(default: server cwd)"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
        />
      </Field>
      <Field label="Model (optional)">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="claude-sonnet-4-6"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs focus:outline-none"
        />
      </Field>
      <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
        >
          <Save className="h-3 w-3" /> {submitting ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function JobDetail({
  job,
  runs,
  onPatch,
  onDelete,
  onRunNow,
  onRefreshRuns,
}: {
  job: Job;
  runs: Run[];
  onPatch: (p: Partial<Job>) => Promise<void>;
  onDelete: () => Promise<void>;
  onRunNow: () => Promise<void>;
  onRefreshRuns: () => Promise<void> | void;
}) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeRun = useMemo(() => runs.find((r) => r.id === activeRunId) ?? null, [runs, activeRunId]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="border-b border-[var(--border)] bg-[var(--panel)]/40 px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">{job.name}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPatch({ enabled: !job.enabled })}
              className={cn(
                "flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
                job.enabled
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20",
              )}
            >
              {job.enabled ? <><Pause className="h-3 w-3" /> Disable</> : <><Play className="h-3 w-3" /> Enable</>}
            </button>
            <button
              onClick={onRunNow}
              className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white hover:opacity-90"
            >
              <Play className="h-3 w-3" /> Run now
            </button>
            <button
              onClick={onDelete}
              className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-[var(--muted)] sm:grid-cols-4">
          <Stat label="Cron" value={<code className="font-mono">{job.cron}</code>} />
          <Stat label="Schedule" value={describeCron(job.cron)} />
          <Stat label="Last" value={fmtRel(job.lastRunAt)} />
          <Stat label="Next" value={job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"} />
          <Stat label="cwd" value={<code className="font-mono break-all">{job.cwd}</code>} />
          {job.model && <Stat label="Model" value={<code className="font-mono">{job.model}</code>} />}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-80 shrink-0 overflow-y-auto border-r border-[var(--border)] scroll-thin">
          <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-1.5 text-[11px]">
            <span className="font-medium">Runs</span>
            <span className="text-[var(--muted)]">({runs.length})</span>
            <button
              onClick={onRefreshRuns}
              title="Refresh runs"
              className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)]"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          {runs.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-[var(--muted)]">No runs yet.</div>
          ) : (
            <ul>
              {runs.map((r) => {
                const dur = r.endedAt ? r.endedAt - r.startedAt : 0;
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => setActiveRunId(r.id)}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left text-[11px]",
                        activeRunId === r.id ? "bg-[var(--panel-2)]" : "hover:bg-[var(--panel-2)]/60",
                      )}
                    >
                      <div className="flex w-full items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                            STATUS_TONES[r.status],
                          )}
                        >
                          {r.status === "running" && (
                            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                          )}
                          {r.status === "running" ? "Live" : r.status}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--muted)]">{fmtRel(r.startedAt)}</span>
                      </div>
                      <span className="text-[10px] text-[var(--muted)]">
                        {dur ? `${Math.round(dur / 100) / 10}s` : "—"} · {fmtUsd(r.costUsd)}
                        {r.note && ` · ${r.note}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">
          {activeRun ? <RunTranscript run={activeRun} jobId={job.id} onRunFinished={onRefreshRuns} /> : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
              Pick a run.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunTranscript({
  run,
  jobId,
  onRunFinished,
}: {
  run: Run;
  jobId: string;
  onRunFinished: () => void | Promise<void>;
}) {
  // For a running run, attach to the live SSE stream; render those events
  // directly. For a finished run, render the persisted transcript.
  const [liveEvents, setLiveEvents] = useState<unknown[]>([]);
  const liveRef = useRef<EventSource | null>(null);

  // Reset the live-event buffer whenever the run identity or status
  // changes. Done during render via the "store previous props" pattern
  // so the SSE effect below contains no sync setState in its body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const runKey = `${run.id}:${run.status}`;
  const [lastRunKey, setLastRunKey] = useState(runKey);
  if (lastRunKey !== runKey) {
    setLastRunKey(runKey);
    setLiveEvents([]);
  }

  useEffect(() => {
    if (run.status !== "running") {
      // No live attach; cleanup any prior connection.
      liveRef.current?.close();
      liveRef.current = null;
      return;
    }
    const es = new EventSource(`/api/schedule/${jobId}/runs/${run.id}/stream`);
    liveRef.current = es;
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as { type?: string; sessionId?: string };
        // Synthetic "<runId>:done" from the server signals completion — refresh
        // the run list so the row flips to its final status.
        if (ev?.type === "ready" && ev?.sessionId === `${run.id}:done`) {
          es.close();
          liveRef.current = null;
          onRunFinished();
          return;
        }
        if (ev?.type === "error" && (ev as { message?: string }).message === "run_not_live") {
          es.close();
          liveRef.current = null;
          onRunFinished();
          return;
        }
        setLiveEvents((prev) => [...prev, ev]);
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      // Network blip — let the heartbeat reconnect; if not, the next
      // refresh-runs poll will catch up.
    };
    return () => {
      es.close();
      liveRef.current = null;
    };
    // run.id and run.status drive (re)attach
  }, [run.id, run.status, jobId, onRunFinished]);

  const transcript = run.status === "running" ? liveEvents : (run.transcript ?? []);
  return (
    <div className="space-y-2 px-4 py-4 text-xs">
      <div className="flex flex-wrap gap-3 border-b border-[var(--border)] pb-2">
        <Stat label="Started" value={new Date(run.startedAt).toLocaleString()} />
        {run.endedAt && <Stat label="Ended" value={new Date(run.endedAt).toLocaleString()} />}
        <Stat label="Status" value={run.status} />
        {run.costUsd != null && <Stat label="Cost" value={fmtUsd(run.costUsd)} />}
        {typeof run.inputTokens === "number" && (
          <Stat label="In tok" value={run.inputTokens.toLocaleString()} />
        )}
        {typeof run.outputTokens === "number" && (
          <Stat label="Out tok" value={run.outputTokens.toLocaleString()} />
        )}
      </div>
      {transcript.length === 0 ? (
        <div className="text-[var(--muted)]">No captured events.</div>
      ) : (
        <pre className="max-h-[60vh] overflow-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2 font-mono text-[11px] leading-4 scroll-thin">
          {transcript.map((e) => JSON.stringify(e)).join("\n")}
        </pre>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      {children}
    </label>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</span>{" "}
      <span className="font-mono text-[var(--foreground)]">{value}</span>
    </div>
  );
}

/**
 * Group of session-only loops shown above the durable jobs list. Pure
 * presentation — fetching, cancellation, and cancelling-state live in the
 * page component. Renders nothing when no loops AND no error (the empty
 * state is intentionally invisible so users who don't use `/loop` don't
 * see a permanently-empty section).
 */
function SessionLoopsGroup({
  loops,
  cancellingKeys,
  error,
  onCancel,
}: {
  loops: SessionLoopListItem[];
  cancellingKeys: Set<string>;
  error: string | null;
  onCancel: (loop: SessionLoopListItem) => Promise<void> | void;
}) {
  // 1Hz tick so wake-up countdowns update live without waiting for the
  // 5s polling cycle. Same pattern as the Activity-rail ScheduledLoops
  // chip — and now that the server reports the *original* `startedAt`
  // (the JSONL timestamp on replay) instead of "now," this counter
  // actually counts down toward the fire moment rather than restarting
  // at the original delay every refresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Filter out wake-ups that have fired and weren't chained — same rule
  // as the rail (see `isStaleWakeup` in `lib/shared/session-loops.ts`).
  // The server's `/api/schedule/session-loops` endpoint still returns
  // them (it has no notion of "stale" in storage), so we apply the same
  // filter both surfaces use, here at render time.
  const visibleLoops = loops.filter((l) => !isStaleWakeup(l, now));
  const liveCount = visibleLoops.filter((l) => !l.cancelled).length;
  return (
    <div className="border-b border-[var(--border)]">
      <div
        className="flex items-center gap-1.5 bg-[var(--panel-2)]/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]"
        title="Loops the agent armed via /loop or CronCreate. Live inside a Claude session — die when the session ends."
      >
        <Timer className="h-3 w-3" />
        Session loops
        <span className="ml-auto normal-case opacity-70">({liveCount})</span>
      </div>
      {error && (
        <div className="px-3 py-2 text-[10px] text-red-400">{error}</div>
      )}
      {visibleLoops.length === 0 ? (
        // Always-visible empty state. Hiding the section when empty was
        // confusing — users couldn't tell whether they had no loops, the
        // feature was broken, or the section didn't exist. A muted hint
        // line is enough to ground the surface; it disappears the moment
        // the first loop arms.
        <div className="px-3 py-2 text-[10px] leading-relaxed text-[var(--muted)]">
          None right now. Use <span className="font-mono">/loop</span> or{" "}
          <span className="font-mono">/schedule</span> in a chat to arm one.
        </div>
      ) : (
        <ul>
          {visibleLoops.map((loop) => {
            const key = `${loop.sessionId}:${loop.id}`;
            const cancelling = cancellingKeys.has(key);
            const muted = loop.cancelled || cancelling;
            const Icon = loop.kind === "wakeup" ? Timer : Repeat;
            // For wake-ups: compute remaining time from the original
            // arming moment (`startedAt`, now correctly carried from
            // the JSONL timestamp on replay) plus the delay. The chip
            // shows "fires in 8m 53s" / "due now" — matches the
            // Activity-rail rendering so the two surfaces agree. The
            // previous label said "every ~Ns" which both reset on
            // refresh (because startedAt was Date.now()) and wrongly
            // implied the wake-up was recurring.
            const cadence = (() => {
              if (loop.kind === "wakeup") {
                if (loop.delaySeconds == null) return "self-paced";
                const elapsedSec = Math.max(0, (now - loop.startedAt) / 1000);
                const remaining = loop.delaySeconds - elapsedSec;
                if (remaining <= 0) return "due now";
                return `fires in ${fmtElapsedSec(remaining)}`;
              }
              return loop.humanSchedule ?? loop.cron ?? "scheduled";
            })();
            return (
              <li
                key={key}
                className={cn(
                  "border-b border-[var(--border)]/60 px-3 py-2 text-xs",
                  muted && "opacity-60",
                )}
                title={loop.prompt}
              >
                <div className="flex items-center gap-1.5">
                  <Icon
                    className={cn(
                      "h-3 w-3 shrink-0",
                      loop.kind === "wakeup" ? "text-amber-300" : "text-violet-300",
                    )}
                  />
                  <span className="truncate font-medium">{cadence}</span>
                  {loop.kind === "cron" && loop.recurring && (
                    <span className="rounded bg-[var(--panel-2)] px-1 py-px text-[9px] uppercase tracking-wide opacity-70">
                      recurring
                    </span>
                  )}
                  {!muted && loop.kind === "cron" && (
                    <button
                      type="button"
                      onClick={() => void onCancel(loop)}
                      className="ml-auto rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
                      aria-label="Ask the agent to cancel this loop"
                      title="Ask the agent to cancel (sends a CronDelete request into the owning session)"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  {muted && (
                    <span className="ml-auto text-[9px] uppercase tracking-wide opacity-70">
                      {loop.cancelled ? "cancelled" : "cancelling…"}
                    </span>
                  )}
                </div>
                <div className="mt-1 line-clamp-2 text-[10px] text-[var(--muted)]">
                  {loop.prompt.trim().split("\n")[0]}
                </div>
                <div className="mt-1 flex gap-2 text-[9px] text-[var(--muted)]">
                  {loop.kind === "cron" && loop.cron && loop.humanSchedule && (
                    <span className="font-mono">{loop.cron}</span>
                  )}
                  <span className="truncate">
                    in {loop.sessionTitle ?? loop.sessionId.slice(0, 8) + "…"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
