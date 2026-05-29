"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  CornerDownLeft,
  Loader2,
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
  /**
   * Optional handler for ad-hoc git commands typed into the console prompt
   * (e.g. `git merge feature-branch`, `git stash`). Returns when the command
   * has completed and its output has been pushed into `entries`. The page
   * is responsible for the POST + status refresh; the console only owns
   * the input UI + history.
   *
   * Omit to hide the prompt entirely (useful when no workspace is selected
   * or the workspace isn't a git repo).
   */
  onRunCommand?: (command: string) => Promise<void>;
  /** Disable the prompt without removing it — e.g. while another op runs. */
  promptDisabled?: boolean;
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
  onRunCommand,
  promptDisabled = false,
}: Props) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Prompt state. `history` is the in-session log of commands the user has
  // submitted; `historyIndex` tracks where Up/Down has moved within it
  // (-1 = "currently editing fresh input", 0..n-1 = recalled entry). `draft`
  // is the value before any history navigation began, so Down all the way
  // restores whatever the user was typing.
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);

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

  // Transient "✓" affordance on the copy button so the user knows the
  // clipboard write landed. Mirrors the pattern in `CodeBlock.tsx`.
  const [copiedErrors, setCopiedErrors] = useState(false);

  /**
   * Submit the typed prompt: run via the page-supplied handler, push the
   * command into history (dedup against the immediately-previous entry so
   * Up/Down doesn't see runs of duplicates), and reset the input.
   *
   * We deliberately do *not* clear `history` on `onClear` — clearing the
   * console wipes the rendered output but the user's typed-command history
   * is a separate, more durable affordance.
   */
  async function submitCommand() {
    if (!onRunCommand) return;
    const command = input.trim();
    if (!command || running || promptDisabled) return;
    setRunning(true);
    try {
      await onRunCommand(command);
      setHistory((prev) => (prev[prev.length - 1] === command ? prev : [...prev, command]));
      setInput("");
      setDraft("");
      setHistoryIndex(-1);
    } finally {
      setRunning(false);
      // Re-focus so the user can keep typing without grabbing the mouse.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  /**
   * Up/Down arrow recall. Mirrors bash/zsh: Up walks backwards through the
   * history (most-recent first), Down walks forward and eventually restores
   * the draft the user was typing before they pressed Up.
   */
  function onPromptKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitCommand();
      return;
    }
    if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      // First Up from a fresh input snapshots the in-progress text so the
      // Down arrow can restore it. After that, we're navigating history.
      if (historyIndex === -1) setDraft(input);
      const next = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next] ?? "");
      return;
    }
    if (e.key === "ArrowDown") {
      if (historyIndex === -1) return;
      e.preventDefault();
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(-1);
        setInput(draft);
      } else {
        setHistoryIndex(next);
        setInput(history[next] ?? "");
      }
      return;
    }
  }

  /**
   * Build a paste-friendly transcript of every error entry — what you'd want
   * to drop into a bug report or chat thread. Format mirrors the rendered
   * row (time, cwd, command, output) so the clipboard text looks like the
   * console you copied from.
   */
  async function copyErrors() {
    const errors = entries.filter((e) => e.status === "error");
    if (errors.length === 0) return;
    const text = errors
      .map((e) => {
        const header = `${formatTime(e.timestamp)} ${e.cwd ? `[${e.cwd}] ` : ""}${e.command}`;
        return e.output ? `${header}\n${e.output.trimEnd()}` : header;
      })
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Non-secure context or permission denied — silently no-op.
      return;
    }
    setCopiedErrors(true);
    window.setTimeout(() => setCopiedErrors(false), 1200);
  }

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
            onClick={copyErrors}
            disabled={errorCount === 0}
            title={
              errorCount === 0
                ? "Copy all errors (none yet)"
                : `Copy all ${errorCount} error${errorCount === 1 ? "" : "s"} to clipboard`
            }
            aria-label="Copy all errors to clipboard"
            data-testid="git-console-copy-errors"
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40",
              copiedErrors && "text-emerald-300",
            )}
          >
            {copiedErrors ? (
              <Check className="h-3 w-3" />
            ) : (
              <ClipboardCopy className="h-3 w-3" />
            )}
          </button>
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
        className="min-h-0 flex-1 overflow-auto scroll-thin font-mono text-[11px] leading-snug"
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
      {/*
        Shell prompt. Whatever the user types is handed to `bash -c` in the
        workspace root, so pipes / redirects / chaining / env expansion all
        work the way they do in any other terminal. Only renders when the
        page has wired up `onRunCommand`; without a handler the input
        would be a no-op tease.
      */}
      {onRunCommand && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitCommand();
          }}
          data-testid="git-console-prompt"
          className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-1.5 font-mono text-[11px]"
        >
          <span
            aria-hidden
            className="select-none text-[var(--muted)]"
            title="Runs in the workspace root via bash -c. Pipes, redirects, and chaining all work."
          >
            $
          </span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Any typed edit drops out of history-recall mode so the
              // next Up starts from the bottom again.
              if (historyIndex !== -1) setHistoryIndex(-1);
            }}
            onKeyDown={onPromptKeyDown}
            disabled={running || promptDisabled}
            placeholder={
              running
                ? "running…"
                : "git status -sb   /   bun run lint   /   ls -la | head"
            }
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            data-testid="git-console-prompt-input"
            className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]/60 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={running || promptDisabled || !input.trim()}
            aria-label="Run command"
            title="Run (Enter) — ↑/↓ recall history"
            data-testid="git-console-prompt-submit"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CornerDownLeft className="h-3 w-3" />
            )}
          </button>
        </form>
      )}
    </div>
  );
}
