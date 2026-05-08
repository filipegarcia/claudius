"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  Undo2,
  AlertTriangle,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ChangesList, type DiffSelection, type GroupKey } from "@/components/git/ChangesList";
import { DiffViewer } from "@/components/git/DiffViewer";
import { CommitBox } from "@/components/git/CommitBox";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { useGitStatus } from "@/lib/client/useGitStatus";

type DiffPayload = { diff: string; binary: boolean };

export default function GitPage() {
  const { items, activeId } = useWorkspaces();
  const active = items.find((w) => w.id === activeId);
  const wsId = active?.id ?? null;

  const { data, error: statusError, loading: statusLoading, refresh } = useGitStatus(wsId);

  // IntelliJ-style: rows have checkboxes, not just radios. The selection set
  // is the "what will get committed" set; ChangesList drives this.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<DiffSelection | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<GroupKey, boolean>>({
    staged: false,
    unstaged: false,
    untracked: false,
  });

  // Keep `checked` in sync with the file list — drop stale entries when files
  // disappear (e.g. after a commit), but preserve user choices across a
  // routine status refresh.
  useEffect(() => {
    if (!data) return;
    const present = new Set(data.files.map((f) => f.path));
    setChecked((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (present.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
    // If selected file is no longer present, drop the diff view.
    setSelected((prev) => (prev && present.has(prev.path) ? prev : null));
  }, [data]);

  // Pull diff text whenever the selection changes.
  useEffect(() => {
    if (!wsId || !selected) {
      setDiff(null);
      return;
    }
    const ac = new AbortController();
    setDiffLoading(true);
    setDiffError(null);
    fetch(
      `/api/workspaces/${wsId}/git/diff?path=${encodeURIComponent(selected.path)}&mode=${selected.mode}`,
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
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setDiffLoading(false));
    return () => ac.abort();
  }, [wsId, selected]);

  const onToggleCheck = useCallback((path: string, next: boolean) => {
    setChecked((prev) => {
      const out = new Set(prev);
      if (next) out.add(path);
      else out.delete(path);
      return out;
    });
  }, []);

  const onToggleAll = useCallback(
    (next: boolean) => {
      if (!data) return;
      if (next) setChecked(new Set(data.files.map((f) => f.path)));
      else setChecked(new Set());
    },
    [data],
  );

  const onToggleGroup = useCallback((g: GroupKey) => {
    setCollapsedGroups((prev) => ({ ...prev, [g]: !prev[g] }));
  }, []);

  async function runStage(op: "stage" | "unstage" | "discard") {
    if (!wsId) return;
    const paths = Array.from(checked);
    if (paths.length === 0) {
      setOpError("Select at least one file first.");
      return;
    }
    if (op === "discard") {
      const msg = `Discard local changes in ${paths.length} file${paths.length === 1 ? "" : "s"}? This cannot be undone.`;
      if (!confirm(msg)) return;
    }
    setBusy(op);
    setOpError(null);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/git/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths, op }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onCommit(message: string) {
    if (!wsId) return { ok: false as const, error: "no workspace" };
    const paths = Array.from(checked);
    if (paths.length === 0) return { ok: false as const, error: "select at least one file" };
    setBusy("commit");
    try {
      const res = await fetch(`/api/workspaces/${wsId}/git/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, stagePaths: paths }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false as const, error: j.error ?? `HTTP ${res.status}` };
      }
      setChecked(new Set());
      setSelected(null);
      await refresh();
      return { ok: true as const };
    } finally {
      setBusy(null);
    }
  }

  const branchLabel = useMemo(() => {
    if (!data) return null;
    if (!data.isRepo) return null;
    if (data.branch) return data.branch;
    if (data.head) return `${data.head} (detached)`;
    return null;
  }, [data]);

  const aheadBehind = useMemo(() => {
    if (!data || !data.isRepo) return null;
    const a = data.ahead ?? 0;
    const b = data.behind ?? 0;
    if (!a && !b) return null;
    return `↑${a} ↓${b}`;
  }, [data]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <GitBranch className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Git</span>
          {active && <span className="font-mono text-[var(--muted)]">{active.rootPath}</span>}
          {branchLabel && (
            <>
              <span className="opacity-50">·</span>
              <span className="font-mono">{branchLabel}</span>
            </>
          )}
          {aheadBehind && (
            <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
              {aheadBehind}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void runStage("stage")}
              disabled={!wsId || busy != null || checked.size === 0}
              title="Stage selected"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
              <span className="text-[11px]">Stage</span>
            </button>
            <button
              type="button"
              onClick={() => void runStage("unstage")}
              disabled={!wsId || busy != null || checked.size === 0}
              title="Unstage selected"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <Minus className="h-3 w-3" />
              <span className="text-[11px]">Unstage</span>
            </button>
            <button
              type="button"
              onClick={() => void runStage("discard")}
              disabled={!wsId || busy != null || checked.size === 0}
              title="Discard local changes (rollback)"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-red-300 hover:bg-red-500/15 disabled:opacity-40"
            >
              <Undo2 className="h-3 w-3" />
              <span className="text-[11px]">Rollback</span>
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={!wsId || statusLoading}
              title="Refresh"
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <RefreshCw className={statusLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            </button>
          </div>
        </header>
        {(statusError || opError) && (
          <div className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">
            <AlertTriangle className="h-3 w-3" />
            <span>{statusError ?? opError}</span>
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
          <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--border)]">
            <div className="flex-1 overflow-y-auto scroll-thin">
              {!active ? (
                <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">No active workspace.</div>
              ) : !data ? (
                <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">Loading…</div>
              ) : !data.isRepo ? (
                <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">
                  This workspace isn&apos;t a git repository.
                </div>
              ) : (
                <ChangesList
                  files={data.files}
                  selected={selected}
                  onSelect={setSelected}
                  checked={checked}
                  onToggleCheck={onToggleCheck}
                  onToggleAll={onToggleAll}
                  collapsedGroups={collapsedGroups}
                  onToggleGroup={onToggleGroup}
                />
              )}
            </div>
            <CommitBox
              checkedCount={checked.size}
              busy={busy === "commit"}
              branchLabel={branchLabel}
              onCommit={onCommit}
            />
          </aside>
          <section className="flex flex-1 flex-col overflow-hidden">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
                Pick a changed file to see the diff.
              </div>
            ) : (
              <>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 text-xs">
                  <span className="truncate font-mono">{selected.path}</span>
                  <span className="rounded bg-[var(--panel)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                    {selected.mode === "staged"
                      ? "Staged · HEAD → index"
                      : selected.mode === "untracked"
                      ? "Untracked · /dev/null → working"
                      : "Unstaged · index → working"}
                  </span>
                </div>
                <DiffViewer
                  diff={diff?.diff ?? ""}
                  binary={diff?.binary ?? false}
                  loading={diffLoading}
                  error={diffError}
                />
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
