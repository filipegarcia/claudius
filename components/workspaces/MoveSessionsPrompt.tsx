"use client";

import { AlertTriangle, ArrowDown, FolderInput } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";

export type MoveSessionsPreview = {
  /** Sessions recorded under the current root; null when the preview failed. */
  count: number | null;
  /** Live sessions mid-turn / waiting on a prompt — these block the move. */
  busy: number;
  /** Names of other workspaces pointing at the same (old) root. */
  sharedWith: string[];
  from: string;
  to: string;
};

type Props = {
  preview: MoveSessionsPreview;
  onMove: () => void;
  onKeep: () => void;
  onCancel: () => void;
};

/**
 * Asked on Save when the workspace root changed and the old root has
 * sessions. Sessions are stored per folder (`~/.claude/projects/<root>/`),
 * so without moving them they stop showing up in this workspace.
 */
export function MoveSessionsPrompt({ preview, onMove, onKeep, onCancel }: Props) {
  const { count, busy, sharedWith, from, to } = preview;
  const noun = count === 1 ? "session" : "sessions";
  return (
    <Overlay title="Move sessions to the new root folder?" subtitle="Root folder changed" onClose={onCancel} width={520}>
      <div data-testid="move-sessions-prompt" className="space-y-3 px-4 py-4 text-xs">
        <p className="text-[var(--foreground)]">
          {count === null ? (
            <>This workspace&rsquo;s sessions are stored under its current root.</>
          ) : (
            <>
              This workspace has <span className="font-semibold">{count} {noun}</span> stored under
              its current root.
            </>
          )}{" "}
          If you don&rsquo;t move them, they won&rsquo;t appear here once the root changes.
        </p>

        <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 font-mono text-[11px]">
          <div className="truncate text-[var(--muted)]" title={from}>{from}</div>
          <ArrowDown className="my-1 h-3 w-3 text-[var(--muted)]" />
          <div className="truncate" title={to}>{to}</div>
        </div>

        <p className="text-[var(--muted)]">
          Moving takes the transcripts and their Claudius data with them: titles, tasks, usage
          and open tabs. Files in your project folders aren&rsquo;t touched.
        </p>

        {busy > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {busy} chat{busy === 1 ? " is" : "s are"} still working in this workspace. Sessions
              can only move once {busy === 1 ? "it finishes or is" : "they finish or are"} stopped.
            </span>
          </div>
        )}
        {sharedWith.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {sharedWith.join(", ")} {sharedWith.length === 1 ? "uses" : "use"} the same root
              folder. {sharedWith.length === 1 ? "Its" : "Their"} sessions are stored there too and
              would move as well.
            </span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="move-sessions-keep"
            onClick={onKeep}
            className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 hover:bg-[var(--panel-2)]"
          >
            Don&rsquo;t move
          </button>
          <button
            type="button"
            data-testid="move-sessions-confirm"
            onClick={onMove}
            autoFocus
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-white hover:opacity-90"
          >
            <FolderInput className="h-3 w-3" />
            {count === null ? "Move sessions" : `Move ${count} ${noun}`}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
