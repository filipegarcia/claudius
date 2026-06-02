"use client";

import { Circle, CheckCircle2, Loader2, X } from "lucide-react";
import type { AgentTodo } from "@/lib/client/types";

const ICON: Record<string, typeof Circle> = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
};

const TONE: Record<string, string> = {
  pending: "text-[var(--muted)]",
  in_progress: "text-sky-300",
  completed: "text-emerald-300",
};

type Props = {
  todos: AgentTodo[];
  /**
   * Optional per-item mutation callback. Wired to
   * `useSession.updateTodoItem`, which POSTs to
   * `/api/sessions/:id/todos/:itemId` and persists a manual override so
   * the user's click survives a server restart. When provided, each row's
   * status icon becomes a button (toggles complete ↔ pending) and a
   * hover-revealed × appears on the right for delete. Omit to render the
   * list read-only.
   */
  onUpdateItem?: (
    itemId: string,
    action: "complete" | "reopen" | "in_progress" | "delete",
  ) => void;
};

/**
 * Compact to-do list rendered inside the Activity rail's "To-dos" section.
 * Mirrors the chat-level `TodosBanner` expanded list shape so the user
 * gets the same per-item controls (clickable status, hover × delete)
 * regardless of which surface they happen to be looking at.
 *
 * Distinct from the banner only in density and the column boundary —
 * the rail is narrower, so the row layout drops the active-form preview
 * the banner shows. Status + content text + delete affordance, that's it.
 */
export function TodoList({ todos, onUpdateItem }: Props) {
  if (!todos.length) return null;
  return (
    <ul className="space-y-1">
      {todos.map((t) => {
        const Icon = ICON[t.status] ?? Circle;
        const tone = TONE[t.status] ?? TONE.pending;
        const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        const handleToggle = () => {
          if (!onUpdateItem) return;
          onUpdateItem(t.id, t.status === "completed" ? "reopen" : "complete");
        };
        const handleDelete = () => {
          if (!onUpdateItem) return;
          onUpdateItem(t.id, "delete");
        };
        return (
          <li
            key={t.id}
            className="group flex items-start gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1.5 text-[11px]"
            data-testid={`rail-todo-${t.status}`}
          >
            {onUpdateItem ? (
              <button
                type="button"
                onClick={handleToggle}
                title={t.status === "completed" ? "Reopen — mark not done" : "Mark done"}
                aria-label={t.status === "completed" ? "Reopen item" : "Mark item done"}
                data-testid={`rail-todo-toggle-${t.id}`}
                className="shrink-0 rounded-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                <Icon
                  className={`h-3 w-3 ${tone} ${
                    t.status === "in_progress" ? "animate-spin" : ""
                  } ${t.status === "pending" ? "hover:text-[var(--foreground)]" : ""}`}
                />
              </button>
            ) : (
              <Icon
                className={`h-3 w-3 shrink-0 ${tone} ${
                  t.status === "in_progress" ? "animate-spin" : ""
                }`}
              />
            )}
            <span
              className={`min-w-0 flex-1 leading-tight ${
                t.status === "completed" ? "line-through opacity-60" : ""
              }`}
            >
              {text}
            </span>
            {onUpdateItem && (
              <button
                type="button"
                onClick={handleDelete}
                title="Delete this item from the list"
                aria-label="Delete item"
                data-testid={`rail-todo-delete-${t.id}`}
                className="mt-px hidden shrink-0 rounded-sm p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] group-hover:inline-flex"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
