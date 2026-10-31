"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { DiffViewer } from "@/components/git/DiffViewer";
import type { GitFileChange } from "@/lib/server/git";
import {
  displayPath,
  modeFor,
  statusChar,
  statusLabel,
  type DiffOverlayMode,
} from "@/lib/shared/diff-overlay";
import { cn } from "@/lib/utils/cn";
import { createCoalescedRunner, type CoalescedRunner } from "@/lib/client/git-poll";

type Props = {
  /** Workspace id to fetch git status/diff for. `null` disables the fetch (e.g. a customization with no git-backed workspace). */
  workspaceId: string | null;
  onClose: () => void;
  /**
   * CC 2.1.260 (H5) — a value that changes whenever Claude's edits advance
   * (see `diffRefreshToken`). When it changes, the overlay re-fetches the
   * status and the open file's diff in place — the "live as Claude edits"
   * behavior — without resetting the user's current file selection.
   */
  refreshToken?: string | number;
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
 *
 * CC 2.1.260 (H5) — the overlay now refreshes live: the parent passes a
 * `refreshToken` derived from the session's edit stream (`diffRefreshToken`),
 * so the file list and the open diff re-fetch as Claude writes files, without
 * disturbing the user's current selection. (The Activity rail's `RecentEdits`
 * is the always-beside-chat live view of the same edit stream.)
 */
export function DiffOverlay({ workspaceId, onClose, refreshToken }: Props) {
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
  // CC 2.1.316 parity — "Improved /diff on large repositories: each refresh
  // usually runs one fewer full-repository git command, and refreshes are
  // spaced out when git is slow". Every `refreshToken` bump used to abort the
  // in-flight `git/status` and start another, so a burst of edits on a slow
  // repo kept restarting git and the list never landed. Each fetch now runs
  // through a coalescing runner (`lib/client/git-poll.ts`): a token change
  // while one is in flight queues a single follow-up, started once it
  // settles and spaced by how long it took. A workspace switch still aborts.
  //
  // Each runner also records the `refreshToken` it was created under: a fresh
  // runner fetches immediately, so that token is already covered and the
  // token effect below must not queue a redundant follow-up for it. Per
  // runner (not one shared ref) so a commit that swaps the diff runner AND
  // bumps the token still refreshes the status runner. `tokenNowRef` mirrors
  // the prop (updated in an effect declared before the runner effects, so it
  // is current when they run) without making the token a runner dependency.
  const tokenNowRef = useRef(refreshToken);
  useEffect(() => {
    tokenNowRef.current = refreshToken;
  }, [refreshToken]);
  const statusRunnerRef = useRef<CoalescedRunner | null>(null);
  const statusTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (!workspaceId) return;
    const runner = createCoalescedRunner((signal) =>
      fetch(`/api/workspaces/${workspaceId}/git/status`, { signal })
        .then(async (res) => {
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `HTTP ${res.status}`);
          }
          return (await res.json()) as StatusPayload;
        })
        .then((p) => {
          if (signal.aborted) return;
          setStatus(p);
          // Auto-select the first changed file so the overlay isn't empty on
          // open — mirrors opening the full Git page with changes present. Only
          // when nothing is selected yet, so a live refresh (CC 2.1.260 / H5)
          // never yanks the user off the file they're reading.
          if (p.files.length > 0) {
            setSelected((cur) => cur ?? { path: p.files[0].path, mode: modeFor(p.files[0]) });
          }
        })
        .catch((err: unknown) => {
          if (signal.aborted) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setStatusError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!signal.aborted) setLoadingStatus(false);
        }),
    );
    statusRunnerRef.current = runner;
    statusTokenRef.current = tokenNowRef.current;
    return () => {
      if (statusRunnerRef.current === runner) statusRunnerRef.current = null;
      runner.dispose();
    };
  }, [workspaceId]);

  const diffKey = workspaceId && selected ? `${workspaceId}|${selected.path}|${selected.mode}` : "";
  const [lastDiffKey, setLastDiffKey] = useState(diffKey);
  if (lastDiffKey !== diffKey) {
    setLastDiffKey(diffKey);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(Boolean(diffKey));
  }
  // Same coalescing for the open file's diff: a token change queues one
  // follow-up behind the running fetch; picking another file (new
  // `selected`) still aborts and starts over.
  const diffRunnerRef = useRef<CoalescedRunner | null>(null);
  const diffTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (!workspaceId || !selected) return;
    const runner = createCoalescedRunner((signal) =>
      fetch(
        `/api/workspaces/${workspaceId}/git/diff?path=${encodeURIComponent(selected.path)}&mode=${selected.mode}`,
        { signal },
      )
        .then(async (res) => {
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `HTTP ${res.status}`);
          }
          return (await res.json()) as DiffPayload;
        })
        .then((p) => {
          if (!signal.aborted) setDiff(p);
        })
        .catch((err: unknown) => {
          if (signal.aborted) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setDiffError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!signal.aborted) setDiffLoading(false);
        }),
    );
    diffRunnerRef.current = runner;
    diffTokenRef.current = tokenNowRef.current;
    return () => {
      if (diffRunnerRef.current === runner) diffRunnerRef.current = null;
      runner.dispose();
    };
  }, [workspaceId, selected]);

  // `refreshToken` (CC 2.1.260 / H5) re-pulls the file list and the open
  // diff as Claude edits — through the runners above, so it never aborts a
  // running git call. A runner whose recorded token already matches is
  // skipped: it was (re)created for this token and fetched on creation.
  useEffect(() => {
    if (statusTokenRef.current !== refreshToken) {
      statusTokenRef.current = refreshToken;
      statusRunnerRef.current?.request();
    }
    if (diffTokenRef.current !== refreshToken) {
      diffTokenRef.current = refreshToken;
      diffRunnerRef.current?.request();
    }
  }, [refreshToken]);

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
              const label = displayPath(f);
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    data-testid="diff-overlay-file"
                    onClick={() => setSelected({ path: f.path, mode })}
                    title={`${label} — ${statusLabel(code)}`}
                    data-status={code}
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
                    <span className="truncate">{label}</span>
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
