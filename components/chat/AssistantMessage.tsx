"use client";

import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCall } from "./ToolCall";
import { TaskBlock } from "./TaskBlock";
import { RateLimitHitPanel } from "./RateLimitHitPanel";
import type { DisplayMessage, TaskInfo } from "@/lib/client/types";
import { formatMessageTime } from "@/lib/client/format-message-time";
import { isSubagentToolName } from "@/lib/shared/subagent-tool";
import {
  DEFAULT_VERBOSE,
  filterAssistantBlocks,
  type VerboseLevel,
} from "@/lib/shared/verbose";

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
  /**
   * Chat verbosity level. Drops blocks the user has asked to hide before
   * rendering — see `lib/shared/verbose.ts`. `MessageList` already drops
   * messages whose blocks all filter out, so this component never renders
   * an empty bubble; it just trims content.
   */
  verbose?: VerboseLevel;
};

export function AssistantMessage({
  message,
  tasks = {},
  subagentMessages = {},
  pendingAskToolUseId = null,
  onReopenAsk,
  verbose = DEFAULT_VERBOSE,
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
      <div className="space-y-1 text-[length:var(--chat-text)] leading-7 2xl:leading-8">
        {filterAssistantBlocks(message.blocks, verbose).map((b, i) => {
          if (b.kind === "text")
            return (
              <div key={i} className="text-[var(--foreground)]">
                <Markdown>{b.text}</Markdown>
              </div>
            );
          if (b.kind === "thinking") {
            // Always render once the SDK has emitted a thinking
            // `content_block_start` — the block envelope itself is the
            // signal that the model entered thinking mode for this turn,
            // independent of whether deltas ever delivered readable body
            // text. The previous "hide empty post-stream" branch raced
            // against `message_stop`: if the user clicked to expand right
            // as streaming flipped off, the block would unmount mid-click
            // and look like the click had dismissed it. ThinkingBlock's
            // own body copy handles the empty-text case gracefully — and
            // gets the `streaming` flag so it can tell "deltas en route"
            // from "no trace was emitted for this turn".
            return (
              <ThinkingBlock
                key={i}
                text={b.text}
                variant={b.redacted ? "redacted" : "thinking"}
                streaming={message.streaming === true}
              />
            );
          }
          if (b.kind === "tool_use") {
            // Subagent invocations route to TaskBlock. The SDK emits this
            // tool under both "Task" (legacy / system:init) and "Agent"
            // (current `tool_use.name`, since Claude Code v2.1.63), so the
            // predicate must match either — see lib/shared/subagent-tool.ts.
            if (isSubagentToolName(b.name)) {
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
        {/* Hard rate-limit hit: render the actionable panel (countdown +
            upgrade links) right under the SDK's "You've hit your … limit"
            text, mirroring the Claude Code CLI's `/rate-limit-options` menu. */}
        {message.rateLimitHit && <RateLimitHitPanel hit={message.rateLimitHit} />}
      </div>
    </div>
  );
}
