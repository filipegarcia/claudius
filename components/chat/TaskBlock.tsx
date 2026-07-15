"use client";

import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { DisplayBlock, DisplayMessage, TaskInfo } from "@/lib/client/types";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCall } from "./ToolCall";

type Props = {
  toolUseId: string;
  input: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  task?: TaskInfo;
  /** Subagent messages routed to this Task. */
  innerMessages: DisplayMessage[];
  /**
   * Initial expand state, driven by the chat verbose level — `ultra-verbose`
   * passes `true` so the subagent transcript is visible inline. Re-applied
   * when the level flips; manual toggles in between are preserved.
   */
  defaultOpen?: boolean;
};

// Tinted chip styles per status — icon + label live in a single pill so the
// state reads as one unit, distinct from the numeric metrics beside it.
const STATUS_CHIP: Record<string, string> = {
  pending: "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
  running: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  completed: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  failed: "border-red-400/30 bg-red-400/10 text-red-300",
  killed: "border-red-400/30 bg-red-400/10 text-red-300",
  stopped: "border-amber-400/30 bg-amber-400/10 text-amber-300",
};

/** "1m 23s" / "45s" / "1h 2m" — compact elapsed-time label for the header. */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return `${totalMin}m ${sec}s`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hours}h ${min}m`;
}

export function TaskBlock({ toolUseId, input, result, task, innerMessages, defaultOpen = false }: Props) {
  // Collapsed by default — multiple parallel Task blocks otherwise flood the
  // transcript. Click the header to expand the subagent's inner messages.
  // `ultra-verbose` passes defaultOpen so they start expanded.
  const [open, setOpen] = useState(defaultOpen);
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  if (prevDefaultOpen !== defaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    setOpen(defaultOpen);
  }
  const subagentName = (input as { subagent_type?: string; agent?: string }).subagent_type ?? (input as { agent?: string }).agent ?? "Task";
  // Title is the spawn *intent* (the Task tool's static `description` — the
  // "why"), with live progress shown as a trailing detail only when it diverges.
  // Previously live progress overwrote the intent, so parallel agents all read
  // "Reading <file>" and were indistinguishable by purpose. Fall back to live
  // progress when no static intent was supplied (older/recovered rows).
  const intent = (input as { description?: string }).description ?? "";
  const liveActivity = task?.description ?? "";
  const title = intent || liveActivity;
  const activity = intent && liveActivity && liveActivity !== intent ? liveActivity : "";
  const prompt = (input as { prompt?: string }).prompt ?? "";
  const status = task?.status ?? (result ? (result.isError ? "failed" : "completed") : "running");

  // The numeric metrics render as a single "·"-joined run with tabular figures
  // so the digits don't jitter as they tick up during streaming. Each part is
  // omitted until the data exists.
  const stats: string[] = [];
  if (task?.totalTokens != null) stats.push(`${task.totalTokens.toLocaleString()} tok`);
  if (task?.toolUses != null && task.toolUses > 0) stats.push(`${task.toolUses} tools`);
  if (task?.durationMs != null) stats.push(formatDuration(task.durationMs));

  return (
    <div
      data-testid="task-block"
      data-task-status={status}
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
        <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        {/* The agent-type pill is the title — the Bot icon already signals
            "subagent", so a separate "Task" label would be redundant noise. */}
        <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--accent)]">
          {subagentName}
        </span>
        {title && (
          <span className="min-w-0 flex-1 truncate text-[var(--muted)]">
            — {title}
            {activity && <span className="text-[var(--muted)]/60"> · {activity}</span>}
          </span>
        )}
        {/* Trailing cluster never wraps: status chip + numeric metrics stay on
            one line; the description above truncates to yield space instead. */}
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
            {status}
          </span>
          {stats.length > 0 && (
            <span className="hidden tabular-nums text-[10px] text-[var(--muted)] sm:inline">
              {stats.join(" · ")}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--accent)]/20 px-3 py-2">
          {prompt && (
            <details className="mb-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Spawn prompt
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-[11px] whitespace-pre-wrap scroll-thin">
                {prompt}
              </pre>
            </details>
          )}
          {task?.error && (
            <div className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
              {task.error}
            </div>
          )}
          {innerMessages.length === 0 ? (
            <div className="text-[11px] italic text-[var(--muted)]">
              {status === "running" ? "Subagent working…" : "No subagent messages captured."}
            </div>
          ) : (
            <div className="space-y-2">
              {innerMessages.map((m) => (
                <SubMessage key={m.uuid} message={m} />
              ))}
            </div>
          )}
          {result && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--muted)]">
                Returned to parent
              </summary>
              <pre
                className={cn(
                  "mt-1 max-h-72 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-[11px] whitespace-pre-wrap scroll-thin",
                  result.isError && "text-red-300",
                )}
              >
                {result.content}
              </pre>
            </details>
          )}
          {process.env.NODE_ENV === "development" && (
            <div className="mt-1 text-[10px] font-mono text-[var(--muted)]/60">tool_use_id={toolUseId}</div>
          )}
        </div>
      )}
    </div>
  );
}

function SubMessage({ message }: { message: DisplayMessage }) {
  if (message.role === "user") {
    const text = message.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
    return (
      <div className="rounded-md bg-[var(--panel-2)]/60 px-2 py-1 text-[11px]">
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">→ subagent</div>
        <div className="whitespace-pre-wrap font-mono">{text}</div>
      </div>
    );
  }
  return (
    <div className="rounded-md bg-[var(--panel)]/40 px-2 py-1 text-[11px]">
      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
        <span className="inline-block h-1 w-1 rounded-full bg-[var(--accent)]" />
        Subagent
      </div>
      <div className="space-y-1.5">
        {message.blocks.map((b: DisplayBlock, i) => {
          if (b.kind === "text")
            return (
              <div key={i} className="text-xs leading-5">
                <Markdown>{b.text}</Markdown>
              </div>
            );
          if (b.kind === "thinking") {
            // See AssistantMessage.tsx for the rationale — the empty-body
            // post-stream hide previously raced `message_stop` and made
            // the block disappear out from under a click. Always render
            // once the SDK has emitted a thinking content block.
            return (
              <ThinkingBlock
                key={i}
                text={b.text}
                variant={b.redacted ? "redacted" : "thinking"}
              />
            );
          }
          if (b.kind === "tool_use")
            return (
              <ToolCall key={i} name={b.name} input={b.input} result={b.result} startedAt={b.startedAt} />
            );
          return null;
        })}
      </div>
    </div>
  );
}
