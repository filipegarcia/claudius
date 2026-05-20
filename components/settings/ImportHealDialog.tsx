"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, X } from "lucide-react";

import { Overlay } from "@/components/overlays/Overlay";
import { DirectoryPicker } from "@/components/workspaces/DirectoryPicker";
import { cn } from "@/lib/utils/cn";
import type { ImportDecision, ImportProgress } from "@/lib/shared/settings-bundle";

type Props = {
  progress: ImportProgress;
  busy: boolean;
  /**
   * Posts the decision to `/api/settings/import/:id/resolve`. The parent owns
   * the fetch + state-update so this component stays presentation-only and can
   * be exercised without a network mock in the unit suite.
   */
  onResolve: (input: { wsIndex: number; decision: ImportDecision }) => void;
  /**
   * `DELETE /api/settings/import/:id`. Doesn't roll back already-committed
   * workspaces — the user is told as much in the cancel button's tooltip.
   */
  onCancel: () => void;
  onClose: () => void;
};

/**
 * Drives the pause / resume / done states of the import flow. The parent
 * (BackupSection) owns the fetch loop and re-renders us with the new
 * `progress` after every `/resolve`.
 */
export function ImportHealDialog({ progress, busy, onResolve, onCancel, onClose }: Props) {
  if (progress.state === "done") {
    return <DoneView progress={progress} onClose={onClose} />;
  }
  if (progress.state === "error") {
    return <ErrorView progress={progress} onClose={onClose} />;
  }
  return (
    <PausedView
      progress={progress}
      busy={busy}
      onResolve={onResolve}
      onCancel={onCancel}
      onClose={onClose}
    />
  );
}

// ── Paused (the heart of the flow) ───────────────────────────────────────

function PausedView({
  progress,
  busy,
  onResolve,
  onCancel,
  onClose,
}: {
  progress: Extract<ImportProgress, { state: "paused" }>;
  busy: boolean;
  onResolve: (input: { wsIndex: number; decision: ImportDecision }) => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const { pause, processed, total } = progress;

  return (
    <Overlay
      title="Import paused — needs your input"
      subtitle={`Imported ${processed} of ${total} workspaces`}
      onClose={onClose}
      width={680}
    >
      <div className="space-y-4 px-5 py-5">
        {pause.kind === "missing_root" && (
          <MissingRootPanel
            workspaceName={pause.workspace.name}
            originalRootPath={pause.workspace.rootPath}
            busy={busy}
            onHeal={(p) =>
              onResolve({ wsIndex: pause.wsIndex, decision: { kind: "heal", newRootPath: p } })
            }
            onSkip={() => onResolve({ wsIndex: pause.wsIndex, decision: { kind: "skip" } })}
          />
        )}

        {pause.kind === "not_a_directory" && (
          <MissingRootPanel
            workspaceName={pause.workspace.name}
            originalRootPath={pause.rootPath}
            note={
              <>
                The path <code className="rounded bg-[var(--panel-2)] px-1">{pause.rootPath}</code>{" "}
                exists but isn&rsquo;t a directory. Pick a different folder.
              </>
            }
            busy={busy}
            onHeal={(p) =>
              onResolve({ wsIndex: pause.wsIndex, decision: { kind: "heal", newRootPath: p } })
            }
            onSkip={() => onResolve({ wsIndex: pause.wsIndex, decision: { kind: "skip" } })}
          />
        )}

        {pause.kind === "id_collision" && (
          <CollisionPanel
            kind="id"
            incoming={pause.incoming}
            existing={pause.existing}
            busy={busy}
            onDecide={(decision) => onResolve({ wsIndex: pause.wsIndex, decision })}
          />
        )}

        {pause.kind === "path_collision" && (
          <CollisionPanel
            kind="path"
            incoming={pause.incoming}
            existing={pause.existing}
            busy={busy}
            onDecide={(decision) => onResolve({ wsIndex: pause.wsIndex, decision })}
          />
        )}

        {progress.log.length > 0 && <LogList log={progress.log} />}

        <div className="flex justify-end border-t border-[var(--border)] pt-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            title="Cancels the remaining steps. Workspaces already imported stay."
            data-testid="import-cancel"
            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-40"
          >
            Cancel import
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Sub-panels ───────────────────────────────────────────────────────────

function MissingRootPanel({
  workspaceName,
  originalRootPath,
  note,
  busy,
  onHeal,
  onSkip,
}: {
  workspaceName: string;
  originalRootPath: string;
  note?: React.ReactNode;
  busy: boolean;
  onHeal: (rootPath: string) => void;
  onSkip: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <header className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Workspace &ldquo;{workspaceName}&rdquo; needs a new path</h3>
          <p className="mt-1 text-[12px] text-[var(--muted)]">
            {note ?? (
              <>
                The bundle expected this workspace at{" "}
                <code className="rounded bg-[var(--panel-2)] px-1">{originalRootPath}</code>, but
                that directory doesn&rsquo;t exist on this machine. Point it at the right folder
                or skip it.
              </>
            )}
          </p>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setShowPicker(true)}
          disabled={busy}
          data-testid="import-heal-pick"
          className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
        >
          <FolderOpen className="h-3.5 w-3.5" /> Pick new folder…
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          data-testid="import-heal-skip"
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)] disabled:opacity-40"
        >
          Skip this workspace
        </button>
      </div>

      {showPicker && (
        <DirectoryPicker
          initialPath={originalRootPath}
          onCancel={() => setShowPicker(false)}
          onPick={(p) => {
            setShowPicker(false);
            onHeal(p);
          }}
        />
      )}
    </section>
  );
}

function CollisionPanel({
  kind,
  incoming,
  existing,
  busy,
  onDecide,
}: {
  kind: "id" | "path";
  incoming: { id: string; name: string; rootPath: string };
  existing: { id: string; name: string; rootPath: string };
  busy: boolean;
  onDecide: (decision: ImportDecision) => void;
}) {
  const [renameTo, setRenameTo] = useState("");

  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <header className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {kind === "id"
              ? "A workspace with the same id already exists"
              : "A workspace already points at this folder"}
          </h3>
          <p className="mt-1 text-[12px] text-[var(--muted)]">
            {kind === "id"
              ? "Pick how to merge the incoming row with the local one."
              : "Two workspaces can't share the same rootPath. Pick how to resolve."}
          </p>
        </div>
      </header>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <WorkspaceSummary label="Incoming (from bundle)" workspace={incoming} />
        <WorkspaceSummary label="Existing (this machine)" workspace={existing} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onDecide({ kind: "overwrite" })}
          disabled={busy}
          data-testid="import-collision-overwrite"
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
        >
          Overwrite local
        </button>
        <button
          type="button"
          onClick={() => onDecide({ kind: "skip" })}
          disabled={busy}
          data-testid="import-collision-skip"
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)] disabled:opacity-40"
        >
          Skip
        </button>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            placeholder="Rename incoming…"
            disabled={busy}
            data-testid="import-collision-rename-input"
            className="w-44 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs focus:outline-none disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => onDecide({ kind: "rename", newName: renameTo.trim() })}
            disabled={busy || !renameTo.trim()}
            data-testid="import-collision-rename"
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)] disabled:opacity-40"
          >
            Rename
          </button>
        </div>
      </div>
    </section>
  );
}

function WorkspaceSummary({
  label,
  workspace,
}: {
  label: string;
  workspace: { id: string; name: string; rootPath: string };
}) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/50 p-3 text-[11px]">
      <div className="uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-sm font-medium">{workspace.name}</div>
      <div className="mt-1 font-mono text-[10px] text-[var(--muted)]">id: {workspace.id}</div>
      <div className="mt-0.5 break-all font-mono text-[10px] text-[var(--muted)]">
        {workspace.rootPath}
      </div>
    </div>
  );
}

// ── Done / error / log ───────────────────────────────────────────────────

function DoneView({
  progress,
  onClose,
}: {
  progress: Extract<ImportProgress, { state: "done" }>;
  onClose: () => void;
}) {
  const counts = countActions(progress.log);
  return (
    <Overlay
      title="Import complete"
      subtitle={`${progress.processed} of ${progress.total} workspaces`}
      onClose={onClose}
      width={620}
    >
      <div className="space-y-4 px-5 py-5">
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          <div className="text-[12px]">
            <div className="font-medium text-emerald-200">Settings restored.</div>
            <div className="mt-0.5 text-[var(--muted)]">
              {counts.created} created · {counts.updated} updated · {counts.healed} healed ·{" "}
              {counts.renamed} renamed · {counts.skipped} skipped
            </div>
          </div>
        </div>
        <LogList log={progress.log} />
        <div className="flex justify-end border-t border-[var(--border)] pt-4">
          <button
            type="button"
            onClick={onClose}
            data-testid="import-close"
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90"
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function ErrorView({
  progress,
  onClose,
}: {
  progress: Extract<ImportProgress, { state: "error" }>;
  onClose: () => void;
}) {
  return (
    <Overlay title="Import failed" onClose={onClose} width={560}>
      <div className="space-y-4 px-5 py-5">
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3">
          <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <div className="text-[12px]">
            <div className="font-medium text-red-200">{progress.error}</div>
            <div className="mt-0.5 text-[var(--muted)]">
              Any successful steps before the failure are still applied.
            </div>
          </div>
        </div>
        {progress.log.length > 0 && <LogList log={progress.log} />}
        <div className="flex justify-end border-t border-[var(--border)] pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function LogList({ log }: { log: ImportProgress["log"] }) {
  if (log.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">Audit trail</div>
      <ul className="mt-1 space-y-1 font-mono text-[11px]">
        {log.map((e, i) => (
          <li
            key={i}
            className="flex items-start gap-2 rounded border border-[var(--border)] bg-[var(--panel-2)]/50 px-2 py-1"
          >
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                e.action === "skipped"
                  ? "bg-[var(--panel)] text-[var(--muted)]"
                  : "bg-emerald-500/15 text-emerald-300",
              )}
            >
              {e.action}
            </span>
            <span className="break-all">
              {e.workspaceId}
              {e.note ? ` — ${e.note}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function countActions(log: ImportProgress["log"]): Record<string, number> {
  const out = { created: 0, updated: 0, healed: 0, renamed: 0, skipped: 0 };
  for (const e of log) {
    if (e.action in out) (out as Record<string, number>)[e.action]++;
  }
  return out;
}
