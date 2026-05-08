"use client";

import { useEffect, useState } from "react";
import { GitBranch, Lock, RefreshCw, AlertTriangle, Folder, Plus } from "lucide-react";
import { Overlay } from "./Overlay";
import { cn } from "@/lib/utils/cn";

type Worktree = {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  locked?: boolean;
  prunable?: boolean;
};

type Props = {
  cwd: string | null;
  onClose: () => void;
  onOpen: (path: string) => void;
};

export function WorktreesOverlay({ cwd, onClose, onOpen }: Props) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cwd });
      const res = await fetch(`/api/worktrees?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { worktrees: Worktree[] };
      setWorktrees(d.worktrees);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  return (
    <Overlay
      title="Git worktrees"
      subtitle={cwd ? `Repo: ${cwd}` : "No active session cwd"}
      onClose={onClose}
      width={640}
    >
      <div className="border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-4 py-2 text-[11px] text-[var(--muted)]">
        Pick a worktree to open a fresh chat session in that path. Useful for parallel branches:
        each worktree has its own checkout, so Claude won&apos;t fight your other workflows.
        <button
          onClick={refresh}
          className="ml-2 inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-1.5 py-0.5 hover:bg-[var(--panel-2)]"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>
      <div className="px-2 py-2">
        {loading && <div className="px-3 py-3 text-xs text-[var(--muted)]">Loading…</div>}
        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        {!loading && worktrees.length === 0 && !error && (
          <div className="px-3 py-6 text-center text-xs text-[var(--muted)]">
            No worktrees found. Create one with <code className="font-mono">git worktree add ../path branch</code>.
          </div>
        )}
        <ul className="space-y-1.5">
          {worktrees.map((w) => (
            <li
              key={w.path}
              className={cn(
                "rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-3 py-2 transition",
                w.path === cwd && "border-[var(--accent)] bg-[var(--panel-2)]/60",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs">
                  <Folder className="h-3 w-3 text-[var(--accent)]" />
                  <code className="font-mono">{w.path}</code>
                  {w.path === cwd && (
                    <span className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                      current
                    </span>
                  )}
                </div>
                <button
                  onClick={() => onOpen(w.path)}
                  disabled={w.path === cwd}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" /> Open session
                </button>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
                {w.branch && (
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="h-3 w-3" />
                    <code className="font-mono">{w.branch}</code>
                  </span>
                )}
                {w.detached && <span className="text-amber-300">detached</span>}
                {w.bare && <span className="text-[var(--muted)]">bare</span>}
                {w.head && <span className="font-mono opacity-70">{w.head.slice(0, 8)}</span>}
                {w.locked && (
                  <span className="inline-flex items-center gap-1 text-red-300">
                    <Lock className="h-3 w-3" /> locked
                  </span>
                )}
                {w.prunable && (
                  <span className="inline-flex items-center gap-1 text-amber-300">
                    <AlertTriangle className="h-3 w-3" /> prunable
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Overlay>
  );
}
