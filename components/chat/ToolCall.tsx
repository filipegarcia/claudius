"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Wrench, AlertCircle, CheckCircle2, ExternalLink, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { buildEditorUrl, pathFromToolInput, useEditor } from "@/lib/client/ide";
import { useFileLink } from "@/lib/client/file-link-context";
import { filesHref, toWorkspaceRelative } from "@/lib/client/file-paths";
import { useMediaPreferences } from "@/lib/client/useMediaPreferences";
import { getPreviewType } from "@/lib/shared/file-types";
import { Markdown } from "./Markdown";
import { FilePreview } from "./FilePreview";

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
  /**
   * Initial expand state, driven by the chat verbose level — `ultra-verbose`
   * passes `true` so cards render open. The user can still toggle manually;
   * if the level flips again the card re-applies this default (see the
   * render-time sync below).
   */
  defaultOpen?: boolean;
};

export function ToolCall({ name, input, result, liveAsk, onReopenAsk, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  // Re-apply the level-driven default when it changes (e.g. the user switches
  // to/from "extra verbose"), while leaving manual toggles in between intact.
  // The "store previous prop in render" pattern keeps this out of an effect.
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  if (prevDefaultOpen !== defaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    setOpen(defaultOpen);
  }
  const { editor } = useEditor();
  const { showPreviews } = useMediaPreferences();
  const status = !result ? "running" : result.isError ? "error" : "ok";
  const fileTarget = pathFromToolInput(input);
  // When the tool operates on a file inside the active workspace, link its
  // path to the in-app Files browser so the user can open it on our own file
  // structure (not just their external editor). Null when there's no workspace
  // context yet or the path lives outside the workspace root.
  const fileLink = useFileLink();
  const fileRel = fileTarget && fileLink ? toWorkspaceRelative(fileTarget.path, fileLink.cwd) : null;
  const filesUrl = fileRel && fileLink ? filesHref(fileLink.workspaceId, fileRel) : null;
  // Determine if an inline preview should be shown. Only shown when:
  //   1. The user has previews enabled.
  //   2. The tool completed without error.
  //   3. We have workspace context + a workspace-relative path.
  //   4. The file extension is a previewable type.
  const previewType =
    showPreviews && result && !result.isError && fileRel && fileTarget
      ? getPreviewType(fileTarget.path)
      : null;
  // ExitPlanMode carries the plan markdown in `input.plan`. Render it as
  // readable prose when expanded (instead of the escaped JSON dump) so the
  // user can review an already-accepted plan after the approval overlay is
  // gone. Falls back to the JSON view if the field is missing / not a string.
  const planText =
    name === "ExitPlanMode" && typeof input.plan === "string" ? (input.plan as string) : null;
  // Show the "Answer" pill on every AskUserQuestion row that has a click
  // handler wired — live asks pulse, historic ones don't. Resurrecting a
  // historic ask doesn't try to feed the SDK (which has already moved on);
  // the click sends the user's answer as a regular follow-up message, so
  // it's safe to expose even after `result.isError = true`.
  const showAnswerPill = name === "AskUserQuestion" && !!onReopenAsk;
  return (
    <div
      data-testid="tool-call"
      data-tool-name={name}
      data-open={open ? "1" : "0"}
      className="my-2 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40"
    >
      {/* The header row is a flex container — the toggle button covers the
          left/center, the Answer pill (if present) and status icon sit on the
          right. We deliberately don't nest another button inside the toggle
          button to keep the a11y tree clean. */}
      <div className={cn("flex w-full items-center gap-2 pr-3 text-xs", "hover:bg-[var(--panel-2)]")}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex items-center gap-2 py-1.5 pl-3 text-left",
            // When a file path follows, the button hugs its content so the
            // path link takes the remaining width; otherwise it fills the row
            // so clicking anywhere on the header toggles.
            fileTarget ? "min-w-0 shrink-0" : "min-w-0 flex-1",
          )}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Wrench className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="font-mono">{name}</span>
          {planText && <span className="text-[10px] text-[var(--muted)]">— Plan</span>}
        </button>
        {fileTarget &&
          (filesUrl ? (
            <Link
              href={filesUrl}
              title="Open in Files"
              // `draggable={false}` so click-and-drag on the path text starts a
              // text selection instead of the browser's built-in drag-the-link
              // behavior. Clicking still navigates to the Files browser.
              draggable={false}
              className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--muted)] hover:text-[var(--accent)] hover:underline"
            >
              {fileTarget.path}
            </Link>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--muted)]">
              {fileTarget.path}
            </span>
          ))}
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
      {/* Inline file preview — shown OUTSIDE the JSON expander so it's visible
          without the user having to open the detail panel. Images default
          expanded; HTML defaults collapsed. */}
      {previewType && fileRel && fileLink && (
        <FilePreview
          fileName={fileTarget!.path.split("/").pop() ?? fileTarget!.path}
          relPath={fileRel}
          workspaceId={fileLink.workspaceId}
          type={previewType}
        />
      )}
      {open && (
        <div className="border-t border-[var(--border)]">
          {planText ? (
            <div className="px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">plan</div>
              <div className="max-h-96 overflow-y-auto scroll-thin rounded bg-[var(--panel-2)] px-3 py-2 text-sm leading-7">
                <Markdown>{planText}</Markdown>
              </div>
            </div>
          ) : (
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
          )}
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
