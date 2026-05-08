"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench, AlertCircle, CheckCircle2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { buildEditorUrl, pathFromToolInput, useEditor } from "@/lib/client/ide";

type Props = {
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
};

export function ToolCall({ name, input, result }: Props) {
  const [open, setOpen] = useState(false);
  const { editor } = useEditor();
  const status = !result ? "running" : result.isError ? "error" : "ok";
  const fileTarget = pathFromToolInput(input);
  return (
    <div className="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-xs",
          "hover:bg-[var(--panel-2)]",
        )}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Wrench className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="font-mono">{name}</span>
        {fileTarget && (
          <span className="truncate font-mono text-[10px] text-[var(--muted)]">{fileTarget.path}</span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-[var(--muted)]">
          {status === "running" && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
          )}
          {status === "ok" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
          {status === "error" && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
        </span>
      </button>
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
