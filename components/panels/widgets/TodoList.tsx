"use client";

import { Circle, CheckCircle2, Loader2 } from "lucide-react";
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

export function TodoList({ todos }: { todos: AgentTodo[] }) {
  if (!todos.length) return null;
  return (
    <ul className="space-y-1">
      {todos.map((t) => {
        const Icon = ICON[t.status] ?? Circle;
        const tone = TONE[t.status] ?? TONE.pending;
        const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        return (
          <li
            key={t.id}
            className="flex items-start gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-2 py-1.5 text-[11px]"
          >
            <Icon className={`h-3 w-3 shrink-0 ${tone} ${t.status === "in_progress" ? "animate-spin" : ""}`} />
            <span
              className={`min-w-0 flex-1 leading-tight ${
                t.status === "completed" ? "line-through opacity-60" : ""
              }`}
            >
              {text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
