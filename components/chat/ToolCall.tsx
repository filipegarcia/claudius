"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench, AlertCircle, CheckCircle2, ExternalLink, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { buildEditorUrl, pathFromToolInput, useEditor } from "@/lib/client/ide";

type Props = {
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  /**
   * For AskUserQuestion rows: when true, render the "Answer" pill in its
   * pulsing "live" variant to flag that the SDK is actively waiting on this
   * very tool_use. When false (or omitted), a non-pulsing pill still shows
   * as long as `onReopenAsk` is provided — the user can reopen the question
   * modal even for historic / errored asks (the permission stream commonly
   * aborts on reconnects, leaving an `isError` result behind, and the user
   * still wants to see what was asked).
   *
   * AssistantMessage is the gate that decides whether the parent considers
   * this row an ask at all; ToolCall additionally checks `name` to refuse
   * showing a phantom pill if a caller bypasses that gate.
   */
  liveAsk?: boolean;
  /** Called when the user clicks the "Answer" pill. Should re-show the modal. */
  onReopenAsk?: () => void;
};

export function ToolCall({ name, input, result, liveAsk, onReopenAsk }: Props) {
  const [open, setOpen] = useState(false);
  const { editor } = useEditor();
  const status = !result ? "running" : result.isError ? "error" : "ok";
  const fileTarget = pathFromToolInput(input);
  // Show the "Answer" pill on every AskUserQuestion row that has a click
  // handler wired — live asks pulse, historic ones don't. Resurrecting a
  // historic ask doesn't try to feed the SDK (which has already moved on);
  // the click sends the user's answer as a regular follow-up message, so
  // it's safe to expose even after `result.isError = true`.
  const showAnswerPill = name === "AskUserQuestion" && !!onReopenAsk;
  return (
    <div className="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
      {/* The header row is a flex container — the toggle button covers the
          left/center, the Answer pill (if present) and status icon sit on the
          right. We deliberately don't nest another button inside the toggle
          button to keep the a11y tree clean. */}
      <div className={cn("flex w-full items-center gap-2 pr-3 text-xs", "hover:bg-[var(--panel-2)]")}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Wrench className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="font-mono">{name}</span>
          {fileTarget && (
            <span className="truncate font-mono text-[10px] text-[var(--muted)]">{fileTarget.path}</span>
          )}
        </button>
        {showAnswerPill && (
          <button
            type="button"
            data-testid="tool-call-answer-pill"
            data-live-ask={liveAsk ? "true" : "false"}
            onClick={() => onReopenAsk?.()}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium",
              liveAsk
                ? "animate-pulse border-[var(--accent)]/50 bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25"
                : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]",
            )}
            title={liveAsk ? "Open the question modal" : "Reopen this question — your answer will be sent as a follow-up message"}
          >
            <MessageCircleQuestion className="h-3 w-3" />
            {liveAsk ? "Answer" : "Reopen"}
          </button>
        )}
        <span className="inline-flex items-center gap-1 text-[var(--muted)]">
          {status === "running" && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
          )}
          {status === "ok" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
          {status === "error" && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
        </span>
      </div>
      {open && (
        <div className="border-t border-[var(--border)]">
          <div className="px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
              <span>input</span>
              {fileTarget && (
                <a
                  href={buildEditorUrl(fileTarget.path, fileTarget.line, editor)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-[var(--foreground)] hover:bg-[var(--panel)]"
                  title={`Open in editor (${editor})`}
                >
                  <ExternalLink className="h-3 w-3" /> Open
                </a>
              )}
            </div>
            <pre className="max-h-60 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-xs scroll-thin">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div className="px-3 pb-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {result.isError ? "error" : "result"}
              </div>
              <pre
                className={cn(
                  "max-h-80 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-xs scroll-thin",
                  result.isError && "text-red-400",
                )}
              >
                {result.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
