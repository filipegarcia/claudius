"use client";

import { useLayoutEffect, useRef } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  Terminal,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type GitConsoleStatus = "ok" | "error" | "info";

export type GitConsoleEntry = {
  /** Stable id; UI uses it as React key. */
  id: string;
  /** Epoch ms — formatted as HH:mm:ss.SSS in the row header. */
  timestamp: number;
  /** Workspace root (or null when no active workspace). */
  cwd: string | null;
  /** Short human label, e.g. "git push" or "git commit". */
  command: string;
  /** Drives row color: red for error, green for ok, default for info. */
  status: GitConsoleStatus;
  /** Pre-formatted output. Empty string renders no body. */
  output: string;
};

type Props = {
  entries: GitConsoleEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  height: number;
  onHeightChange: (h: number) => void;
  onClear: () => void;
};

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 600;

function pad(n: number, l = 2): string {
  return String(n).padStart(l, "0");
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * IntelliJ-style bottom console for git operations. Two visual states:
 *   - Collapsed: 28px strip with a click-to-expand toggle + per-status counts.
 *   - Expanded: resizable panel (top drag handle) with the entries list.
 *
 * Auto-scrolls to the bottom whenever `entries.length` changes, so new
 * output is always visible without the user having to chase the scrollbar.
 */
export function GitConsole({
  entries,
  open,
  onOpenChange,
  height,
  onHeightChange,
  onClear,
}: Props) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new entries. Only effects when expanded — when collapsed
  // there's no body element to scroll.
  useLayoutEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, open]);

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  function onDragStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: height };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onDragMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = drag.startY - e.clientY; // dragging up grows the panel
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, drag.startH + delta));
    onHeightChange(next);
  }
  function onDragEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const errorCount = entries.reduce(
    (acc, e) => (e.status === "error" ? acc + 1 : acc),
    0,
  );

  if (!open) {
    return (
      <div
        data-testid="git-console"
        data-open="false"
        className="flex h-7 shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--panel)] px-3 text-[11px] text-[var(--muted)]"
      >
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          data-testid="git-console-toggle"
          className="flex items-center gap-1.5 hover:text-[var(--foreground)]"
        >
          <ChevronUp className="h-3 w-3" />
          <Terminal className="h-3 w-3" />
          <span>Console</span>
          {entries.length > 0 && (
            <span className="rounded bg-[var(--panel-2)] px-1 font-mono text-[10px]">
              {entries.length}
            </span>
          )}
          {errorCount > 0 && (
            <span
              data-testid="git-console-error-count"
              className="rounded bg-red-500/20 px-1 font-mono text-[10px] text-red-300"
            >
              {errorCount} err
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="git-console"
      data-open="true"
      className="flex shrink-0 flex-col border-t border-[var(--border)] bg-[var(--panel)]"
      style={{ height: `${height}px` }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize console"
        data-testid="git-console-resizer"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="group flex h-1.5 cursor-ns-resize items-center justify-center select-none hover:bg-[var(--accent)]/30"
      >
        <span className="h-px w-8 bg-[var(--border)] group-hover:bg-[var(--accent)]" />
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[11px] text-[var(--muted)]">
        <Terminal className="h-3 w-3" />
        <span className="font-medium text-[var(--foreground)]">Console</span>
        {entries.length > 0 && (
          <span className="rounded bg-[var(--panel-2)] px-1 font-mono text-[10px]">
            {entries.length}
          </span>
        )}
        {errorCount > 0 && (
          <span className="rounded bg-red-500/20 px-1 font-mono text-[10px] text-red-300">
            {errorCount} err
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const el = bodyRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            title="Scroll to bottom"
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          >
            <ArrowDownToLine className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={entries.length === 0}
            title="Clear console"
            data-testid="git-console-clear"
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title="Hide console"
            data-testid="git-console-hide"
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div
        ref={bodyRef}
        data-testid="git-console-body"
        className="flex-1 min-h-0 overflow-auto scroll-thin font-mono text-[11px] leading-snug"
      >
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--muted)]">
            No git output yet.
          </div>
        ) : (
          <div className="space-y-2 px-3 py-2">
            {entries.map((entry) => (
              <div key={entry.id} data-testid="git-console-entry" data-status={entry.status}>
                <div className="flex flex-wrap items-baseline gap-x-2 text-[10px] text-[var(--muted)]">
                  <span>{formatTime(entry.timestamp)}:</span>
                  {entry.cwd && <span>[{entry.cwd}]</span>}
                  <span
                    className={cn(
                      "font-medium",
                      entry.status === "error"
                        ? "text-red-300"
                        : entry.status === "ok"
                          ? "text-emerald-300"
                          : "text-[var(--foreground)]",
                    )}
                  >
                    {entry.command}
                  </span>
                </div>
                {entry.output && (
                  <pre
                    className={cn(
                      "mt-0.5 whitespace-pre-wrap break-words text-[11px]",
                      entry.status === "error"
                        ? "text-red-300"
                        : "text-[var(--foreground)]",
                    )}
                  >
                    {entry.output}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
