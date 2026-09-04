"use client";

import { useEffect, useMemo, useState } from "react";
import { Overlay } from "./Overlay";
import { DiffViewer } from "@/components/git/DiffViewer";
import type { GitFileChange } from "@/lib/server/git";
import { modeFor, statusChar, statusLabel, type DiffOverlayMode } from "@/lib/shared/diff-overlay";
import { cn } from "@/lib/utils/cn";

type Props = {
  /** Workspace id to fetch git status/diff for. `null` disables the fetch (e.g. a customization with no git-backed workspace). */
  workspaceId: string | null;
  onClose: () => void;
};

type Selection = { path: string; mode: DiffOverlayMode };

type StatusPayload = { isRepo: boolean; files: GitFileChange[]; error?: string };
type DiffPayload = { diff: string; binary: boolean; error?: string };

/**
 * `/diff` — CC 2.1.260 parity. Claude Code opens a panel beside the
 * conversation showing uncommitted changes live as Claude edits. Claudius
 * has no beside-chat split-pane layout (every slash-command panel is either
 * a full overlay or a separate route — see the rejected-alternative note in
 * `.claudius/cc-parity/run-notes/2.1.260.md`), so this reuses the
 * `CostOverlay`/`ContextOverlay` full-screen-overlay pattern instead: a
 * compact file list on the left, the selected file's unified diff on the
 * right, both built from the same `git/status` + `git/diff` endpoints the
 * full Git page (`app/[workspaceId]/git/`) already uses.
 *
 * Deliberately read-only — no stage/commit/discard actions. Those live on
 * the full Git page; this is a quick "what's changed right now" glance
 * without leaving the conversation.
 */
export function DiffOverlay({ workspaceId, onClose }: Props) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Render-phase reset on workspaceId change (not inside the effect below) —
  // same "store previous props" pattern the full Git page uses for its diff
  // fetch, so a null workspaceId never needs a synchronous setState from
  // inside a `useEffect` body.
  const [lastWorkspaceId, setLastWorkspaceId] = useState(workspaceId);
  if (lastWorkspaceId !== workspaceId) {
    setLastWorkspaceId(workspaceId);
    setStatus(null);
    setStatusError(null);
    setLoadingStatus(Boolean(workspaceId));
  }
  useEffect(() => {
    if (!workspaceId) return;
    const ac = new AbortController();
    fetch(`/api/workspaces/${workspaceId}/git/status`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as StatusPayload;
      })
      .then((p) => {
        setStatus(p);
        // Auto-select the first changed file so the overlay isn't empty on
        // open — mirrors opening the full Git page with changes present.
        if (p.files.length > 0) {
          setSelected({ path: p.files[0].path, mode: modeFor(p.files[0]) });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStatusError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoadingStatus(false);
      });
    return () => ac.abort();
  }, [workspaceId]);

  const diffKey = workspaceId && selected ? `${workspaceId}|${selected.path}|${selected.mode}` : "";
  const [lastDiffKey, setLastDiffKey] = useState(diffKey);
  if (lastDiffKey !== diffKey) {
    setLastDiffKey(diffKey);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(Boolean(diffKey));
  }
  useEffect(() => {
    if (!workspaceId || !selected) return;
    const ac = new AbortController();
    fetch(
      `/api/workspaces/${workspaceId}/git/diff?path=${encodeURIComponent(selected.path)}&mode=${selected.mode}`,
      { signal: ac.signal },
    )
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as DiffPayload;
      })
      .then((p) => setDiff(p))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ac.signal.aborted) setDiffLoading(false);
      });
    return () => ac.abort();
  }, [workspaceId, selected]);

  const files = useMemo(() => status?.files ?? [], [status]);

  return (
    <Overlay title="Uncommitted changes" subtitle="/diff" onClose={onClose} width={880} maxHeightVh={82}>
      {!workspaceId ? (
        <div className="p-6 text-sm text-[var(--muted)]">
          Diff isn&apos;t available in this context.
        </div>
      ) : loadingStatus ? (
        <div className="p-6 text-sm text-[var(--muted)]">Loading changes…</div>
      ) : statusError ? (
        <div className="p-6 text-sm text-red-400">{statusError}</div>
      ) : status && !status.isRepo ? (
        <div className="p-6 text-sm text-[var(--muted)]">This workspace isn&apos;t a git repository.</div>
      ) : files.length === 0 ? (
        <div className="p-6 text-sm text-[var(--muted)]" data-testid="diff-overlay-empty">
          No uncommitted changes.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1" data-testid="diff-overlay-body">
          <ul
            className="w-56 shrink-0 overflow-y-auto border-r border-[var(--border)] py-1"
            data-testid="diff-overlay-file-list"
          >
            {files.map((f) => {
              const mode = modeFor(f);
              const isSel = selected?.path === f.path && selected.mode === mode;
              const code = statusChar(f);
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    data-testid="diff-overlay-file"
                    onClick={() => setSelected({ path: f.path, mode })}
                    title={`${f.path} — ${statusLabel(code)}`}
                    className={cn(
                      "flex w-full items-center gap-2 truncate px-3 py-1.5 text-left text-[12px] transition",
                      isSel
                        ? "bg-[var(--accent)]/10 text-[var(--foreground)]"
                        : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
                    )}
                  >
                    <span
                      className="w-3 shrink-0 text-center font-mono text-[10px] text-[var(--accent)]"
                      aria-hidden
                    >
                      {code === " " ? "" : code}
                    </span>
                    <span className="truncate">{f.path}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="min-w-0 flex-1 overflow-y-auto">
            {diffLoading ? (
              <div className="p-6 text-sm text-[var(--muted)]">Loading diff…</div>
            ) : diffError ? (
              <div className="p-6 text-sm text-red-400">{diffError}</div>
            ) : (
              <DiffViewer diff={diff?.diff ?? ""} binary={diff?.binary ?? false} />
            )}
          </div>
        </div>
      )}
    </Overlay>
  );
}
