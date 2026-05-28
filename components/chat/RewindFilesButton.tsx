"use client";

import { useState } from "react";
import { History, Loader2 } from "lucide-react";

/**
 * "Restore files to here" affordance on a user message (B1.1, option a).
 *
 * Distinct from the sibling "Rewind here" button, which forks the
 * *conversation* (`/api/sessions/fork`) without touching the working tree.
 * This one restores the *files* to their checkpointed state at this user
 * message via the SDK's file checkpointing (POST /api/sessions/[id]/rewind,
 * backed by Query.rewindFiles).
 *
 * Flow: click → dry-run (preview which files would change) → user confirms →
 * real rewind. The dry run means the user always sees the blast radius before
 * anything is written. Self-contained (own fetch + state) so it adds only a
 * single prop to UserMessage rather than threading a handler through the chat
 * tree.
 */

type RewindResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
};

type Phase =
  | { kind: "idle" }
  | { kind: "loading" } // dry-run or apply in flight
  | { kind: "preview"; result: RewindResult }
  | { kind: "error"; message: string }
  | { kind: "done"; result: RewindResult };

async function callRewind(
  sessionId: string,
  userMessageId: string,
  dryRun: boolean,
): Promise<RewindResult> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/rewind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userMessageId, dryRun }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: RewindResult; error?: string };
  if (!res.ok) throw new Error(body.error ?? `rewind failed: ${res.status}`);
  if (!body.result) throw new Error("malformed rewind response");
  return body.result;
}

export function RewindFilesButton({
  sessionId,
  messageUuid,
}: {
  sessionId: string;
  messageUuid: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const startPreview = async () => {
    setPhase({ kind: "loading" });
    try {
      const result = await callRewind(sessionId, messageUuid, true);
      if (!result.canRewind) {
        setPhase({ kind: "error", message: result.error ?? "Nothing to restore to this message." });
        return;
      }
      setPhase({ kind: "preview", result });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const confirm = async () => {
    setPhase({ kind: "loading" });
    try {
      const result = await callRewind(sessionId, messageUuid, false);
      setPhase({ kind: "done", result });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const close = () => setPhase({ kind: "idle" });

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void startPreview();
        }}
        disabled={phase.kind === "loading"}
        className="flex items-center gap-1 text-[10px] text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--foreground)] disabled:opacity-40"
        title="Restore files to their state at this message"
      >
        {phase.kind === "loading" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <History className="h-3 w-3" />
        )}
        Restore files
      </button>

      {(phase.kind === "preview" || phase.kind === "error" || phase.kind === "done") && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-left shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {phase.kind === "preview" && (
              <RewindPreview result={phase.result} onConfirm={() => void confirm()} onCancel={close} />
            )}
            {phase.kind === "done" && <RewindDone result={phase.result} onClose={close} />}
            {phase.kind === "error" && <RewindError message={phase.message} onClose={close} />}
          </div>
        </div>
      )}
    </>
  );
}

function FileStat({ result }: { result: RewindResult }) {
  const files = result.filesChanged ?? [];
  return (
    <>
      <div className="mb-2 flex gap-3 font-mono text-xs">
        <span>{files.length} file{files.length === 1 ? "" : "s"}</span>
        {typeof result.insertions === "number" && (
          <span className="text-[var(--accent)]">+{result.insertions}</span>
        )}
        {typeof result.deletions === "number" && (
          <span className="text-red-400">-{result.deletions}</span>
        )}
      </div>
      {files.length > 0 && (
        <ul className="mb-3 max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 font-mono text-[11px] text-[var(--muted)]">
          {files.map((f) => (
            <li key={f} className="truncate" title={f}>
              {f}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RewindPreview({
  result,
  onConfirm,
  onCancel,
}: {
  result: RewindResult;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <h2 className="mb-1 text-sm font-semibold">Restore files to this message?</h2>
      <p className="mb-3 text-xs text-[var(--muted)]">
        This rewinds the working tree to its checkpointed state at this point. Unsaved later edits to
        these files will be lost.
      </p>
      <FileStat result={result} />
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          Restore files
        </button>
      </div>
    </>
  );
}

function RewindDone({ result, onClose }: { result: RewindResult; onClose: () => void }) {
  const n = result.filesChanged?.length ?? 0;
  return (
    <>
      <h2 className="mb-1 text-sm font-semibold">Files restored</h2>
      <p className="mb-3 text-xs text-[var(--muted)]">
        {n > 0 ? `Restored ${n} file${n === 1 ? "" : "s"} to this message's state.` : "Working tree restored."}
      </p>
      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          Done
        </button>
      </div>
    </>
  );
}

function RewindError({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <>
      <h2 className="mb-1 text-sm font-semibold text-red-400">Couldn’t restore files</h2>
      <p className="mb-3 break-words text-xs text-[var(--muted)]">{message}</p>
      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
        >
          Close
        </button>
      </div>
    </>
  );
}
