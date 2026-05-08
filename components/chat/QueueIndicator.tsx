"use client";

import { ArrowDown, ArrowUp, Hourglass, Pencil, X } from "lucide-react";
import type { QueuedMessage } from "@/lib/client/types";

type Props = {
  queue: QueuedMessage[];
  onCancel: (id: string) => void;
  onEdit?: (id: string) => void;
  onReorder?: (id: string, dir: -1 | 1) => void;
};

export function QueueIndicator({ queue, onCancel, onEdit, onReorder }: Props) {
  if (queue.length === 0) return null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-4 pb-2">
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
                className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-30"
                title="Move up"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <button
                onClick={() => onReorder(q.id, 1)}
                disabled={i === queue.length - 1}
                className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-30"
                title="Move down"
              >
                <ArrowDown className="h-3 w-3" />
              </button>
            </>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(q.id)}
              className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
              title="Edit"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={() => onCancel(q.id)}
            className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            title="Remove from queue"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
