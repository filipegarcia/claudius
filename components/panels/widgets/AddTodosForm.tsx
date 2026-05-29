"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Props = {
  onSubmit: (texts: string[]) => Promise<void> | void;
  onCancel: () => void;
};

/**
 * Inline form for the "+ add to-do" affordance in the Activity rail.
 *
 * Each row is one task. Enter on the last row appends a new row; Enter on
 * any earlier row jumps focus to the next. ⌘/Ctrl+Enter submits the whole
 * list. Empty rows are dropped on submit.
 */
export function AddTodosForm({ onSubmit, onCancel }: Props) {
  const [rows, setRows] = useState<string[]>([""]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  // Focus the first input on mount.
  useEffect(() => {
    inputsRef.current[0]?.focus();
  }, []);

  function setRow(i: number, value: string) {
    setRows((cur) => cur.map((r, idx) => (idx === i ? value : r)));
  }

  function addRow(focusIdx?: number) {
    setRows((cur) => [...cur, ""]);
    // Focus the new input after React commits.
    setTimeout(() => {
      const idx = focusIdx ?? rows.length; // length is pre-update (i.e. new row's index)
      inputsRef.current[idx]?.focus();
    }, 0);
  }

  function removeRow(i: number) {
    setRows((cur) => {
      if (cur.length <= 1) return [""]; // never go below one empty row
      const next = cur.filter((_, idx) => idx !== i);
      return next;
    });
  }

  async function submit() {
    const texts = rows.map((r) => r.trim()).filter(Boolean);
    if (texts.length === 0) {
      setError("Add at least one task");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(texts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>, idx: number) {
    // ⌘/Ctrl+Enter submits regardless of the active row.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Last row + non-empty → append a new row and focus it.
      if (idx === rows.length - 1 && rows[idx].trim()) {
        addRow(idx + 1);
      } else if (idx < rows.length - 1) {
        // Move focus forward one row.
        inputsRef.current[idx + 1]?.focus();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
    if (e.key === "Backspace" && rows[idx] === "" && rows.length > 1) {
      e.preventDefault();
      removeRow(idx);
      // Focus the previous row.
      setTimeout(() => inputsRef.current[Math.max(0, idx - 1)]?.focus(), 0);
    }
  }

  return (
    <div
      data-testid="add-todos-form"
      className="mb-1 flex flex-col gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/50 p-2"
    >
      <ul className="space-y-1">
        {rows.map((value, i) => (
          <li key={i} className="flex items-center gap-1">
            <span className="text-[10px] text-[var(--muted)]">{i + 1}.</span>
            <input
              ref={(el) => {
                inputsRef.current[i] = el;
              }}
              data-testid={`add-todo-input-${i}`}
              value={value}
              onChange={(e) => setRow(i, e.target.value)}
              onKeyDown={(e) => onKey(e, i)}
              disabled={submitting}
              placeholder="What should the agent track?"
              className={cn(
                "min-w-0 flex-1 rounded border border-transparent bg-[var(--panel)] px-2 py-1 text-[11px]",
                "outline-none focus:border-[var(--accent)]/60",
                "disabled:opacity-50",
              )}
              maxLength={200}
            />
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={submitting}
                aria-label="Remove task"
                className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-red-400"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => addRow()}
        disabled={submitting}
        data-testid="add-todo-another"
        className="mt-1 flex items-center gap-1 self-start rounded px-1 text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]"
      >
        <Plus className="h-3 w-3" />
        Add another
      </button>
      {error && (
        <div className="text-[10px] text-red-300" data-testid="add-todos-error">
          {error}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1 border-t border-[var(--border)]/40 pt-2">
        <span className="text-[9px] text-[var(--muted)]/80">⌘/Ctrl+Enter to send</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded px-2 py-0.5 text-[10px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
            data-testid="add-todos-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || rows.every((r) => !r.trim())}
            className={cn(
              "rounded bg-[var(--accent)] px-2 py-0.5 text-[10px] font-medium text-white",
              "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
            )}
            data-testid="add-todos-submit"
          >
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
