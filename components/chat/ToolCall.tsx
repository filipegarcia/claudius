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
   * When this tool_use is the one currently waiting on the user (AskUserQuestion
   * with a matching `pendingAsk.toolUseId`), render a small "Answer" pill next
   * to the title so the user can bring the question modal back if it was
   * minimized, dismissed, or hidden by a route change. Gated strictly on a live
   * pending ask — once the SDK has the answer, the pill is gone.
   */
  isPendingAsk?: boolean;
  /** Called when the user clicks the "Answer" pill. Should re-show the modal. */
  onReopenAsk?: () => void;
};

export function ToolCall({ name, input, result, isPendingAsk, onReopenAsk }: Props) {
  const [open, setOpen] = useState(false);
  const { editor } = useEditor();
  const status = !result ? "running" : result.isError ? "error" : "ok";
  const fileTarget = pathFromToolInput(input);
  // Only surface the "Answer" pill while the question is genuinely pending —
  // both flags AND no tool_result yet. A resolved AskUserQuestion (answered,
  // declined, or aborted) is just a normal history row; resurrecting a modal
  // for it would be a phantom action since the SDK has already moved on.
  const showAnswerPill = isPendingAsk && !result && !!onReopenAsk;
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
            onClick={() => onReopenAsk?.()}
            className="inline-flex animate-pulse items-center gap-1 rounded-md border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/25"
            title="Open the question modal"
          >
            <MessageCircleQuestion className="h-3 w-3" />
            Answer
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
