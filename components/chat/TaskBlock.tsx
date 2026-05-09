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
};

const STATUS_TONES: Record<string, string> = {
  pending: "text-[var(--muted)]",
  running: "text-sky-300",
  completed: "text-emerald-300",
  failed: "text-red-300",
  killed: "text-red-300",
  stopped: "text-amber-300",
};

export function TaskBlock({ toolUseId, input, result, task, innerMessages }: Props) {
  const [open, setOpen] = useState(true);
  const subagentName = (input as { subagent_type?: string; agent?: string }).subagent_type ?? (input as { agent?: string }).agent ?? "Task";
  const description = task?.description ?? (input as { description?: string }).description ?? "";
  const prompt = (input as { prompt?: string }).prompt ?? "";
  const status = task?.status ?? (result ? (result.isError ? "failed" : "completed") : "running");
  const tone = STATUS_TONES[status] ?? "text-[var(--muted)]";

  return (
    <div className="my-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--panel-2)]/40"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Bot className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="font-mono">Task</span>
        <span className="rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
          {subagentName}
        </span>
        {description && <span className="truncate text-[var(--muted)]">— {description}</span>}
        <span className="ml-auto inline-flex items-center gap-1 text-[10px]">
          {status === "running" && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" />
          )}
          {(status === "completed") && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
          {(status === "failed" || status === "killed") && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
          <span className={tone}>{status}</span>
          {task?.totalTokens != null && (
            <span className="text-[var(--muted)]">· {task.totalTokens.toLocaleString()} tok</span>
          )}
          {task?.toolUses != null && task.toolUses > 0 && (
            <span className="text-[var(--muted)]">· {task.toolUses} tools</span>
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
          <div className="mt-1 text-[10px] font-mono text-[var(--muted)]/60">tool_use_id={toolUseId}</div>
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
            if (!b.text && !b.redacted && !message.streaming) return null;
            return (
              <ThinkingBlock
                key={i}
                text={b.text}
                variant={b.redacted ? "redacted" : "thinking"}
              />
            );
          }
          if (b.kind === "tool_use")
            return <ToolCall key={i} name={b.name} input={b.input} result={b.result} />;
          return null;
        })}
      </div>
    </div>
  );
}
