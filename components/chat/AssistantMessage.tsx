"use client";

import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCall } from "./ToolCall";
import { TaskBlock } from "./TaskBlock";
import type { DisplayMessage, TaskInfo } from "@/lib/client/types";
import { formatMessageTime } from "@/lib/client/format-message-time";

type Props = {
  message: DisplayMessage;
  tasks?: Record<string, TaskInfo>;
  subagentMessages?: Record<string, DisplayMessage[]>;
  /**
   * tool_use id of the live AskUserQuestion the user is being asked, or null
   * when none is in flight. When this matches one of this message's tool_use
   * blocks, the corresponding ToolCall pill renders in its "live" pulsing
   * variant — non-matching ask rows still get a (non-pulsing) Reopen pill so
   * historic/errored asks remain clickable. Threaded straight from
   * `useSession.pendingAsk`.
   */
  pendingAskToolUseId?: string | null;
  /**
   * Click handler for the "Answer" / "Reopen" pill. Receives the row's
   * tool_use id + raw input so the caller can either re-show the live modal
   * or resurrect a historic one from the captured `input.questions`.
   */
  onReopenAsk?: (args: { toolUseId: string; input: Record<string, unknown> }) => void;
};

export function AssistantMessage({
  message,
  tasks = {},
  subagentMessages = {},
  pendingAskToolUseId = null,
  onReopenAsk,
}: Props) {
  const taskByToolUseId = new Map<string, TaskInfo>();
  for (const t of Object.values(tasks)) {
    if (t.toolUseId) taskByToolUseId.set(t.toolUseId, t);
  }

  const stamp = formatMessageTime(message.createdAt);

  return (
    <div className="group">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
        <span className={`inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] ${message.streaming ? "animate-pulse" : ""}`} />
        Claude
        {message.streaming && <span className="text-[10px] opacity-60">streaming…</span>}
        {stamp && (
          <span
            className="ml-auto font-mono text-[10px] opacity-0 transition group-hover:opacity-100"
            title={stamp.full}
            aria-label={`Sent ${stamp.full}`}
          >
            {stamp.short}
          </span>
        )}
      </div>
      <div className="space-y-1 text-sm leading-7">
        {message.blocks.map((b, i) => {
          if (b.kind === "text")
            return (
              <div key={i} className="text-[var(--foreground)]">
                <Markdown>{b.text}</Markdown>
              </div>
            );
          if (b.kind === "thinking") {
            // Don't pollute completed turns with empty thinking blocks —
            // the placeholder is only useful while content is in flight.
            if (!b.text && !b.redacted && !message.streaming) return null;
            return (
              <ThinkingBlock
                key={i}
                text={b.text}
                variant={b.redacted ? "redacted" : "thinking"}
              />
            );
          }
          if (b.kind === "tool_use") {
            if (b.name === "Task") {
              const inner = subagentMessages[b.id] ?? [];
              return (
                <TaskBlock
                  key={i}
                  toolUseId={b.id}
                  input={b.input}
                  result={b.result}
                  task={taskByToolUseId.get(b.id)}
                  innerMessages={inner}
                />
              );
            }
            // Only AskUserQuestion rows get a click handler — the pill is
            // gated by `name === "AskUserQuestion"` inside ToolCall too, but
            // refusing to even hand the closure to non-ask rows keeps the
            // a11y tree clean (no dead button waiting to be activated).
            const askClick =
              b.name === "AskUserQuestion" && onReopenAsk
                ? () => onReopenAsk({ toolUseId: b.id, input: b.input })
                : undefined;
            return (
              <ToolCall
                key={i}
                name={b.name}
                input={b.input}
                result={b.result}
                liveAsk={b.name === "AskUserQuestion" && pendingAskToolUseId === b.id}
                onReopenAsk={askClick}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
