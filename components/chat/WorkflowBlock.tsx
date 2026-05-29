"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { TaskInfo } from "@/lib/client/types";
import { parseWorkflowMeta } from "@/lib/shared/workflow-meta";

type Props = {
  toolUseId: string;
  input: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  /**
   * The matching `local_workflow` task, joined by tool_use_id upstream. A
   * workflow surfaces to embedders as ONE aggregate task (status + rolling
   * summary + summed tokens/tools/duration) — the SDK does not expose the
   * per-agent breakdown, so this is the live progress signal we have.
   */
  task?: TaskInfo;
  /**
   * Initial expand state. Defaults to "expanded while the run has no terminal
   * result" — the in-app dispatch relies on that default. Overridable so the
   * fixture/marketing gallery can pin specific cards open or collapsed.
   */
  defaultOpen?: boolean;
};

const STATUS_CHIP: Record<string, string> = {
  pending: "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
  running: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  completed: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  failed: "border-red-400/30 bg-red-400/10 text-red-300",
  killed: "border-red-400/30 bg-red-400/10 text-red-300",
  stopped: "border-amber-400/30 bg-amber-400/10 text-amber-300",
};

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Parse the Workflow tool's WorkflowOutput JSON result; null if not an object. */
function safeJsonObject(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const o: unknown = JSON.parse(content);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function WorkflowBlock({ toolUseId, input, result, task, defaultOpen }: Props) {
  // Expanded by default while no terminal result is in — a running workflow is
  // the thing the user most wants to watch. Collapses to a one-liner otherwise.
  // `ultra-verbose` passes defaultOpen=true; flipping the level re-applies it.
  const initialOpen = defaultOpen ?? !result;
  const [open, setOpen] = useState(initialOpen);
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  if (prevDefaultOpen !== defaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    if (defaultOpen !== undefined) setOpen(defaultOpen);
  }

  const script = str(input.script);
  const partial = str(input.__partial);
  // `meta` streams first, so even the partial wire form usually yields a name.
  const meta = useMemo(() => parseWorkflowMeta(script ?? partial), [script, partial]);

  const name = meta.name ?? str(input.name) ?? "Workflow";
  // No script yet AND no result yet → we're still receiving the tool input.
  const streaming = !script && !!partial && !result;

  const status =
    task?.status ?? (streaming ? "pending" : result ? (result.isError ? "failed" : "completed") : "running");
  const terminal = status === "completed" || status === "failed" || status === "killed" || status === "stopped";

  // Aggregate metrics live on the single workflow task (summed across agents).
  const stats: string[] = [];
  if (task?.totalTokens != null) stats.push(`${task.totalTokens.toLocaleString()} tok`);
  if (task?.toolUses != null && task.toolUses > 0) stats.push(`${task.toolUses} tools`);
  if (task?.durationMs != null) stats.push(fmtDuration(task.durationMs));

  // The Workflow tool returns WorkflowOutput JSON; surface the readable bits.
  const resultData = useMemo(() => safeJsonObject(result?.content), [result?.content]);

  const resultSummary = str(resultData?.summary) ?? task?.summary;
  const transcriptDir = str(resultData?.transcriptDir);
  const runId = str(resultData?.runId);
  const errorText =
    str(resultData?.error) ?? task?.error ?? (result?.isError ? result.content : undefined);

  const args = input.args && typeof input.args === "object" ? (input.args as object) : undefined;
  const description = meta.description ?? task?.description;
  // While running, the task's rolling AI summary is the live "what's happening".
  const liveSummary = status === "running" ? task?.summary : undefined;

  return (
    <div
      data-testid="workflow-block"
      data-workflow-status={status}
      data-open={open ? "1" : "0"}
      className="my-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--panel-2)]/40"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        )}
        <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <span className="shrink-0 text-[var(--muted)]">Workflow</span>
        <span className="min-w-0 shrink truncate whitespace-nowrap rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--accent)]">
          {name}
        </span>
        {meta.phases.length > 0 && (
          <span className="hidden shrink-0 text-[10px] text-[var(--muted)] sm:inline">
            {meta.phases.length} {meta.phases.length === 1 ? "phase" : "phases"}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize",
              STATUS_CHIP[status] ?? STATUS_CHIP.pending,
            )}
          >
            {status === "running" && (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            )}
            {status === "completed" && <CheckCircle2 className="h-3 w-3" />}
            {(status === "failed" || status === "killed") && <AlertCircle className="h-3 w-3" />}
            {streaming ? "preparing" : status}
          </span>
          {stats.length > 0 && (
            <span className="hidden tabular-nums text-[10px] text-[var(--muted)] sm:inline">
              {stats.join(" · ")}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--accent)]/20 px-3 py-2">
          {description && <p className="text-[11px] text-[var(--muted)]">{description}</p>}

          {liveSummary && (
            <div className="flex items-start gap-1.5 rounded-md bg-[var(--panel-2)]/60 px-2 py-1 text-[11px]">
              <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" />
              <span className="text-[var(--foreground)]/80">{liveSummary}</span>
            </div>
          )}

          {streaming && !description && (
            <p className="text-[11px] italic text-[var(--muted)]">Preparing workflow…</p>
          )}

          {meta.phases.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Phases
              </div>
              <ol className="space-y-1">
                {meta.phases.map((p, i) => (
                  <li key={i} className="flex gap-2 text-[11px]">
                    <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel-2)] text-[9px] font-mono text-[var(--muted)]">
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-[var(--foreground)]/90">{p.title}</span>
                      {p.detail && <span className="text-[var(--muted)]"> — {p.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-1 text-[9px] text-[var(--muted)]/70">
                Declared phases. Per-agent progress runs out-of-band — watch the rolling status above.
              </p>
            </div>
          )}

          {errorText && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
              {errorText}
            </div>
          )}

          {resultSummary && !errorText && terminal && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Result
              </div>
              <div className="whitespace-pre-wrap rounded bg-[var(--panel-2)] px-2 py-1.5 text-[11px] leading-5">
                {resultSummary}
              </div>
            </div>
          )}

          {(runId || transcriptDir) && (
            <div className="space-y-0.5 text-[10px] text-[var(--muted)]">
              {runId && (
                <div className="truncate font-mono" title={runId}>
                  run: {runId}
                </div>
              )}
              {transcriptDir && (
                <div className="truncate font-mono" title={transcriptDir}>
                  transcripts: {transcriptDir}
                </div>
              )}
            </div>
          )}

          {args && (
            <details>
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Args
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-[11px] whitespace-pre-wrap scroll-thin">
                {JSON.stringify(args, null, 2)}
              </pre>
            </details>
          )}
          {/* toolUseId is the join key to the live task; kept in props (and the
              data-* attributes above) for tests rather than rendered as noise. */}
          <span hidden data-tool-use-id={toolUseId} />

          {script && (
            <details>
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Show script
              </summary>
              <pre className="mt-1 max-h-72 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-[11px] whitespace-pre scroll-thin">
                {script}
              </pre>
            </details>
          )}

        </div>
      )}
    </div>
  );
}
