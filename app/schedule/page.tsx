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
  Save,
  Trash2,
  X,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { CronEditor } from "@/components/schedule/CronEditor";
import { describeCron } from "@/lib/shared/cron";
import type { Job, Run, RunStatus } from "@/lib/server/scheduler-store";
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/schedule");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs: Job[] };
      setJobs(data.jobs);
      if (!activeId && data.jobs.length > 0) setActiveId(data.jobs[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshRuns = useCallback(async () => {
    if (!activeId) {
      setRuns([]);
      return;
    }
    try {
      const res = await fetch(`/api/schedule/${activeId}/runs?limit=50`);
      if (!res.ok) return;
      const d = (await res.json()) as { runs: Run[] };
      setRuns(d.runs);
    } catch {
      // ignore
    }
  }, [activeId]);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  // Cheap auto-refresh: while any run for the active job is "running",
  // poll every 2 s so the badge flips to its final status without the user
  // clicking refresh.
  const hasLive = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => void refreshRuns(), 2000);
    return () => clearInterval(id);
  }, [hasLive, refreshRuns]);

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
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Calendar className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Schedule</span>
          <span className="text-[var(--muted)]">({jobs.length})</span>
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
            {jobs.length === 0 && !creating ? (
              <div className="px-4 py-10 text-center text-xs text-[var(--muted)]">
                No jobs yet.
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
  onRefreshRuns: () => Promise<void>;
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

  useEffect(() => {
    if (run.status !== "running") {
      // No live attach; cleanup any prior connection.
      liveRef.current?.close();
      liveRef.current = null;
      setLiveEvents([]);
      return;
    }
    const es = new EventSource(`/api/schedule/${jobId}/runs/${run.id}/stream`);
    liveRef.current = es;
    setLiveEvents([]);
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
