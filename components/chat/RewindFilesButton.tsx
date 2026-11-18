"use client";

import { useEffect, useState } from "react";
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
  /**
   * SDK 0.3.216 — count of tracked files the rewind safety guards refused to
   * restore or delete (symlink / hard link / other non-regular file at the
   * tracked path, a parent directory that no longer resolves where it did at
   * checkpoint time, a file behind a link in a folder sandboxed commands can
   * write — SDK 0.3.326, macOS/Linux/WSL with the sandbox on — or a backup
   * that couldn't be safely read). Only ever
   * populated on a real (non-dryRun) rewind — a dry-run preview never sets
   * it, even when the real rewind would later skip files.
   */
  skippedLinks?: number;
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
      // CC 2.1.327 — a real rewind where every differing file fails to
      // restore comes back as `canRewind: false` with `error` (see the SDK's
      // RewindFilesResult). Say it failed rather than "Files restored".
      if (!result.canRewind) {
        setPhase({ kind: "error", message: result.error ?? "None of the files could be restored." });
        return;
      }
      setPhase({ kind: "done", result });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const close = () => setPhase({ kind: "idle" });

  // CC 2.1.326 — Esc cancels the dialog (preview, result or error).
  const dialogOpen = phase.kind === "preview" || phase.kind === "error" || phase.kind === "done";
  useEffect(() => {
    if (!dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPhase({ kind: "idle" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen]);

  return (
    <>
      <button
        data-testid="restore-files-button"
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

      {dialogOpen && (
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
  // CC 2.1.326 — "a turn whose changes weren't tracked now reads 'Code changes
  // unknown'" instead of "No code changes". Only Claude's own file edits are
  // checkpointed, so an empty preview doesn't mean nothing changed: Bash
  // commands (and edits outside Claude) may have changed files that can't be
  // restored from here. Say so, and don't offer a restore that does nothing.
  if ((result.filesChanged ?? []).length === 0) {
    return (
      <div data-testid="restore-files-unknown">
        <h2 className="mb-1 text-sm font-semibold">Code changes unknown</h2>
        <p className="mb-3 text-xs text-[var(--muted)]">
          The files Claude edited already match this message, so there&apos;s nothing to restore here. Changes made
          by Bash commands or outside Claude aren&apos;t tracked and can&apos;t be restored this way.
        </p>
        <div className="flex justify-end">
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
          >
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <h2 className="mb-1 text-sm font-semibold">Restore files to this message?</h2>
      {/* CC 2.1.311 parity — "Fixed the /rewind warning that wrongly said
          manual and Bash edits are never affected by a code restore". The
          old copy ("Unsaved later edits … will be lost") implied saved edits
          were safe. The SDK's `rewindFiles` writes each checkpointed file
          back whatever changed it since, so later manual and Bash edits to
          these files are overwritten too, and files Claude created since are
          removed (`rewindFiles` restores or deletes tracked files). Files that
          only Bash or the user touched aren't checkpointed, so they're left as
          they are. */}
      <p data-testid="restore-files-preview-note" className="mb-3 text-xs text-[var(--muted)]">
        Restores the files Claude edited to their state at this message, removing any it created
        since. Later changes to them are overwritten, including your own edits and Bash&apos;s; files
        changed only by you or by Bash commands are left as they are.
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
  const skipped = result.skippedLinks ?? 0;
  return (
    <>
      <h2 className="mb-1 text-sm font-semibold">{n > 0 ? "Files restored" : "Nothing restored"}</h2>
      {/* With skipped files the warning below says what happened instead. */}
      {(n > 0 || skipped === 0) && (
        <p className="mb-3 text-xs text-[var(--muted)]">
          {n > 0
            ? `Restored ${n} file${n === 1 ? "" : "s"} to this message's state.`
            : "The files Claude edited already matched this message."}
        </p>
      )}
      {skipped > 0 && (
        <p
          data-testid="rewind-skipped-links-warning"
          className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300"
        >
          Skipped {skipped} file{skipped === 1 ? "" : "s"} the safety guard refused to restore — a symlink, hard
          link, or other non-regular file was tracked at that path, or the file sits behind a link in a folder
          sandboxed commands can write. Restore {skipped === 1 ? "it" : "them"} by hand if needed.
        </p>
      )}
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
