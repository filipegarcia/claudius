"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, Loader2, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { AgentTodo } from "@/lib/client/types";

const STORAGE_KEY = "claudius.todos-banner.expanded";

type Props = {
  todos: AgentTodo[];
  /** Optional: hide the banner entirely (e.g. user dismissed it for this session). */
  hidden?: boolean;
  onDismiss?: () => void;
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
 */
export function TodosBanner({ todos, hidden, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Boot from localStorage; default to expanded the first time so the user
  // discovers the feature.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      setExpanded(v == null ? true : v === "1");
    } catch {
      setExpanded(true);
    }
  }, []);

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
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-1.5 text-xs">
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
            aria-label="Dismiss todos for this session"
            title="Hide until the agent updates the list"
            className="rounded px-1 text-[10px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
          >
            Hide
          </button>
        )}
      </div>
      {expanded && (
        <div className="mx-auto w-full max-w-3xl px-4 pb-2" data-testid="todos-banner-list">
          <ul className="space-y-0.5">
            {todos.map((t) => {
              const Icon =
                t.status === "in_progress"
                  ? Loader2
                  : t.status === "completed"
                  ? CheckCircle2
                  : Circle;
              const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
              return (
                <li
                  key={t.id}
                  className="flex items-start gap-1.5 text-[11px] leading-snug"
                  data-testid={`todos-banner-item-${t.status}`}
                >
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
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      t.status === "completed" && "line-through opacity-60",
                    )}
                  >
                    {text}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
