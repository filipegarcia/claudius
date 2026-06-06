"use client";

import { ArrowDown, ArrowUp, Hourglass, Pencil, Send, X } from "lucide-react";
import type { QueuedMessage } from "@/lib/client/types";

type Props = {
  queue: QueuedMessage[];
  // Callbacks are async (server round-trips); declare them so TS accepts
  // both `(id) => void` and `async (id) => …` signatures.
  onCancel: (id: string) => void | Promise<void>;
  onEdit?: (id: string) => void | Promise<void>;
  onReorder?: (id: string, dir: -1 | 1) => void | Promise<void>;
  /**
   * Per-message override for the workspace's `queueDispatchMode` setting:
   * pop this specific message and push it to the agent NOW, even mid-turn
   * (jumps ahead of the other queued items). The server treats it like
   * an asap-mode send for one item — the SDK runs it as the very next
   * turn. See `Session.sendQueuedNow`.
   */
  onSendNow?: (id: string) => void | Promise<void>;
};

export function QueueIndicator({
  queue,
  onCancel,
  onEdit,
  onReorder,
  onSendNow,
}: Props) {
  if (queue.length === 0) return null;
  return (
    <div className="mx-auto flex w-full max-w-[var(--chat-col)] flex-col gap-1 px-4 pb-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        <Hourglass className="h-3 w-3" />
        Queued · sends after current response
      </div>
      {queue.map((q, i) => (
        <div
          key={q.id}
          className="flex items-center gap-1 rounded-md border border-dashed border-[var(--border)] bg-[var(--panel)]/40 px-2 py-1 text-xs"
        >
          <button
            onClick={() => onEdit?.(q.id)}
            disabled={!onEdit}
            className="line-clamp-1 flex-1 cursor-text text-left text-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-default"
            title="Edit (move text back into the prompt)"
          >
            {q.text}
          </button>
          {onReorder && (
            <>
              <button
                onClick={() => onReorder(q.id, -1)}
                disabled={i === 0}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-30"
                title="Move up in the queue"
              >
                <ArrowUp className="h-3 w-3" />
                <span>Up</span>
              </button>
              <button
                onClick={() => onReorder(q.id, 1)}
                disabled={i === queue.length - 1}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-30"
                title="Move down in the queue"
              >
                <ArrowDown className="h-3 w-3" />
                <span>Down</span>
              </button>
            </>
          )}
          {onSendNow && (
            <button
              onClick={() => onSendNow(q.id)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              title="Send now — skip the queue and run as the very next turn"
            >
              <Send className="h-3 w-3" />
              <span>Send now</span>
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(q.id)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              title="Edit — pull the text back into the composer"
            >
              <Pencil className="h-3 w-3" />
              <span>Edit</span>
            </button>
          )}
          <button
            onClick={() => onCancel(q.id)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            title="Remove from the queue"
          >
            <X className="h-3.5 w-3.5" />
            <span>Remove</span>
          </button>
        </div>
      ))}
    </div>
  );
}
