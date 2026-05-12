"use client";

import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCall } from "./ToolCall";
import { TaskBlock } from "./TaskBlock";
import type { DisplayMessage, TaskInfo } from "@/lib/client/types";

type Props = {
  message: DisplayMessage;
  tasks?: Record<string, TaskInfo>;
  subagentMessages?: Record<string, DisplayMessage[]>;
  /**
   * tool_use id of the live AskUserQuestion the user is being asked, or null
   * when none is in flight. When this matches one of this message's tool_use
   * blocks, the corresponding ToolCall row exposes a small "Answer" pill that
   * brings the modal back. Threaded straight from `useSession.pendingAsk`.
   */
  pendingAskToolUseId?: string | null;
  /** Click handler for the "Answer" pill — should reopen the question modal. */
  onReopenAsk?: () => void;
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

  return (
    <div className="group">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
        <span className={`inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] ${message.streaming ? "animate-pulse" : ""}`} />
        Claude
        {message.streaming && <span className="text-[10px] opacity-60">streaming…</span>}
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
            return (
              <ToolCall
                key={i}
                name={b.name}
                input={b.input}
                result={b.result}
                isPendingAsk={
                  b.name === "AskUserQuestion" && pendingAskToolUseId === b.id
                }
                onReopenAsk={onReopenAsk}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
