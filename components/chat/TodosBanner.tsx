"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, Loader2, ListChecks, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { AgentTodo } from "@/lib/client/types";

const STORAGE_KEY = "claudius.todos-banner.expanded";

type Props = {
  todos: AgentTodo[];
  /** Optional: hide the banner entirely (e.g. user dismissed it for this session). */
  hidden?: boolean;
  /**
   * Optional dismiss callback. Wired to the durable server-side clear (see
   * `useSession.clearTodos`) so the cleared state survives reload and
   * server restart — not just a client-side banner hide. Rendered as the
   * "Clear" affordance on the right of the banner.
   */
  onDismiss?: () => void;
  /**
   * Optional per-item mutation callback. Wired to
   * `useSession.updateTodoItem`, which POSTs to
   * `/api/sessions/:id/todos/:itemId` and persists a manual override so
   * the user's click survives a server restart. When provided, the status
   * icon on each list item becomes a button (toggles complete ↔ pending)
   * and a small × appears on hover for delete. Omit to render the list
   * read-only (the dev preview at `/dev/chat-todos` uses this).
   */
  onUpdateItem?: (
    itemId: string,
    action: "complete" | "reopen" | "in_progress" | "delete",
  ) => void;
};

/**
 * Pinned banner that surfaces the agent's current TodoWrite output between
 * the StatusLine and the messages list. Auto-hides when there's nothing to
 * show. Collapsed by default once the user has expanded once and collapsed
 * back — preference persists across reloads via localStorage.
 *
 * The right Activity rail also renders these (see widgets/TodoList.tsx); the
 * banner is the in-flow, glanceable counterpart so the user doesn't have to
 * scan the rail to know what the agent's working on.
 *
 * Per-item user control (`onUpdateItem`): clickable status icons + a hover
 * × for delete. Routes through `useSession.updateTodoItem`, which talks to
 * the server and persists a manual override so the click survives reload.
 * Exists for the very common failure mode where the model creates a 16-item
 * plan, executes the work, and never marks anything done — the user takes
 * over without waiting for the model to acknowledge.
 */
export function TodosBanner({ todos, hidden, onDismiss, onUpdateItem }: Props) {
  // Boot from localStorage via a lazy initializer; default to expanded
  // the first time so the user discovers the feature. SSR returns the
  // expanded default so the first paint matches the most common state.
  // The preference is per-tab — no cross-tab sync needed — so a plain
  // `useState` is enough; no `useSyncExternalStore` required.
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      return v == null ? true : v === "1";
    } catch {
      return true;
    }
  });

  if (hidden || todos.length === 0) return null;

  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress") ?? null;
  const activeText = active ? active.activeForm ?? active.content : null;

  function toggle() {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

  return (
    <div
      data-testid="todos-banner"
      className="border-b border-[var(--border)] bg-[var(--panel-2)]/40"
    >
      <div className="mx-auto flex w-full max-w-[var(--chat-col)] items-center gap-2 px-4 py-1.5 text-xs">
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <button
          onClick={toggle}
          className="flex flex-1 items-center gap-2 truncate text-left"
          title={expanded ? "Collapse todos" : "Expand todos"}
          data-testid="todos-banner-toggle"
        >
          <span className="font-medium" data-testid="todos-banner-progress">
            {done}/{total}
          </span>
          {active && activeText && (
            <span className="flex items-center gap-1 truncate text-[var(--muted)]" data-testid="todos-banner-active">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-300" />
              <span className="truncate">{activeText}</span>
            </span>
          )}
          {!active && (
            <span className="text-[var(--muted)]">
              {done === total ? "All done" : `${total - done} remaining`}
            </span>
          )}
        </button>
        <button
          onClick={toggle}
          aria-label={expanded ? "Collapse todos" : "Expand todos"}
          className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Clear todos for this session"
            title="Clear this list — the agent will start fresh next time it tracks todos"
            data-testid="todos-banner-clear"
            className="rounded px-1 text-[10px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
          >
            Clear
          </button>
        )}
      </div>
      {expanded && (
        <div className="mx-auto w-full max-w-[var(--chat-col)] px-4 pb-2" data-testid="todos-banner-list">
          <ul className="space-y-0.5">
            {todos.map((t) => {
              const Icon =
                t.status === "in_progress"
                  ? Loader2
                  : t.status === "completed"
                  ? CheckCircle2
                  : Circle;
              const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
              // When `onUpdateItem` is wired, the status icon becomes a
              // toggle button: completed ↔ pending (in_progress is the
              // model's signal; users toggle between done/not-done). The
              // × delete button appears on hover, sliding the row right
              // — no layout shift since both buttons share a fixed-width
              // affordance column.
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
                  className="group flex items-start gap-1.5 text-[11px] leading-snug"
                  data-testid={`todos-banner-item-${t.status}`}
                >
                  {onUpdateItem ? (
                    <button
                      type="button"
                      onClick={handleToggle}
                      title={t.status === "completed" ? "Reopen — mark not done" : "Mark done"}
                      aria-label={t.status === "completed" ? "Reopen item" : "Mark item done"}
                      data-testid={`todos-banner-toggle-${t.id}`}
                      className="mt-0.5 shrink-0 rounded-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    >
                      <Icon
                        className={cn(
                          "h-3 w-3",
                          t.status === "completed"
                            ? "text-emerald-300"
                            : t.status === "in_progress"
                            ? "animate-spin text-sky-300"
                            : "text-[var(--muted)] hover:text-[var(--foreground)]",
                        )}
                      />
                    </button>
                  ) : (
                    <Icon
                      className={cn(
                        "mt-0.5 h-3 w-3 shrink-0",
                        t.status === "completed"
                          ? "text-emerald-300"
                          : t.status === "in_progress"
                          ? "animate-spin text-sky-300"
                          : "text-[var(--muted)]",
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      t.status === "completed" && "line-through opacity-60",
                    )}
                  >
                    {text}
                  </span>
                  {onUpdateItem && (
                    <button
                      type="button"
                      onClick={handleDelete}
                      title="Delete this item from the list"
                      aria-label="Delete item"
                      data-testid={`todos-banner-delete-${t.id}`}
                      className="mt-0.5 hidden shrink-0 rounded-sm p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] group-hover:inline-flex"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
