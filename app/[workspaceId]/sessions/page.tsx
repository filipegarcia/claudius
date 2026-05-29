"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, FolderTree, Search, X } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useSessionsHistory } from "@/lib/client/useSessionsHistory";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { cn } from "@/lib/utils/cn";

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function fmtBytes(n?: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function SessionsPage() {
  const { sessions, loading, error, refresh, remove } = useSessionsHistory();
  const [filter, setFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState<string | null>(null);

  // Scope the list to the workspace in the URL. `useSessionsHistory` fetches
  // every session on disk regardless of workspace; matching `cwd` against the
  // route's workspace rootPath narrows it to "this workspace only" — the same
  // exact-match rule the server uses for `/api/sessions?workspaceId` and the
  // chat header's session picker. The URL param (not `useActiveCwd`'s
  // cookie-resolved id) is authoritative for the page we're actually on.
  const params = useParams<{ workspaceId: string }>();
  const { items: workspaces } = useWorkspaces();
  const workspace = workspaces.find((w) => w.id === params?.workspaceId) ?? null;
  const workspaceRoot = workspace?.rootPath ?? null;
  const scopedSessions = useMemo(
    () =>
      workspaceRoot == null ? sessions : sessions.filter((s) => s.cwd === workspaceRoot),
    [sessions, workspaceRoot],
  );

  const branches = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of scopedSessions) {
      const b = s.gitBranch?.trim();
      if (!b) continue;
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [scopedSessions]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return scopedSessions.filter((s) => {
      if (branchFilter && s.gitBranch !== branchFilter) return false;
      if (!q) return true;
      return (
        s.sessionId.toLowerCase().includes(q) ||
        (s.summary ?? "").toLowerCase().includes(q) ||
        (s.cwd ?? "").toLowerCase().includes(q) ||
        (s.firstPrompt ?? "").toLowerCase().includes(q) ||
        (s.gitBranch ?? "").toLowerCase().includes(q)
      );
    });
  }, [filter, branchFilter, scopedSessions]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="sessions-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <FolderTree className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Sessions</span>
          {workspace && (
            <span className="truncate text-[var(--muted)]" title={workspace.rootPath}>
              {workspace.name}
            </span>
          )}
          <span className="text-[var(--muted)]">({scopedSessions.length})</span>
          {loading && <span className="text-[var(--muted)]">loading…</span>}
          {error && <span className="text-red-400">{error}</span>}
          <button
            onClick={() => refresh()}
            className="ml-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            Refresh
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-4 py-2">
          <Search className="h-3.5 w-3.5 text-[var(--muted)]" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by id, prompt, cwd, branch…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {branches.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto border-b border-[var(--border)] bg-[var(--panel)]/30 px-4 py-1.5 scroll-thin">
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">branch</span>
            <button
              onClick={() => setBranchFilter(null)}
              className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] ${
                branchFilter === null
                  ? "border-[var(--accent)] bg-[var(--panel-2)]"
                  : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)]"
              }`}
            >
              all
            </button>
            {branches.map(([b, n]) => (
              <button
                key={b}
                onClick={() => setBranchFilter(b)}
                className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                  branchFilter === b
                    ? "border-[var(--accent)] bg-[var(--panel-2)]"
                    : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-2)]"
                }`}
              >
                {b} <span className="ml-1 text-[10px] text-[var(--muted)]">{n}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto scroll-thin">
          {filtered.length === 0 && !loading ? (
            <div className="px-6 py-16 text-center text-sm text-[var(--muted)]">No sessions match.</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {filtered.map((s) => (
                <li key={s.sessionId} className="group">
                  <div className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--panel)]/40">
                    <Link
                      href={`/sessions/${s.sessionId}${s.cwd ? `?dir=${encodeURIComponent(s.cwd)}` : ""}`}
                      className="min-w-0 flex-1"
                    >
                      <div className="flex items-baseline gap-2">
                        {/*
                          Title precedence:
                            1. `claudiusTitle` — our SQLite index, set on
                               every Claudius-side rename. Survives the
                               "JSONL not yet flushed" window where the
                               SDK's renameSession silently fails.
                            2. `customTitle` — SDK JSONL header, set by
                               TUI `/rename` or the SDK's aiTitle.
                          We never use `summary` / `firstPrompt` — both
                          collapse to prompt text when the user hasn't
                          renamed. The firstPrompt preview lives below
                          this row for context.
                        */}
                        <span className="truncate text-sm font-medium">
                          {s.claudiusTitle || s.customTitle || "(untitled)"}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--muted)]">{s.sessionId.slice(0, 8)}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
                        <span>{fmtRelative(s.lastModified)}</span>
                        <span className="opacity-50">·</span>
                        <span>{fmtBytes(s.fileSize)}</span>
                        {s.gitBranch && (
                          <>
                            <span className="opacity-50">·</span>
                            <span className="font-mono">{s.gitBranch}</span>
                          </>
                        )}
                        {s.cwd && (
                          <>
                            <span className="opacity-50">·</span>
                            <span className="truncate font-mono">{s.cwd}</span>
                          </>
                        )}
                      </div>
                      {s.firstPrompt && (
                        <div className="mt-1 line-clamp-2 text-xs text-[var(--muted)]">{s.firstPrompt}</div>
                      )}
                    </Link>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                      <Link
                        href={`/?session=${s.sessionId}`}
                        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] hover:bg-[var(--panel)]"
                      >
                        Resume
                      </Link>
                      <a
                        href={`/api/sessions/export/${s.sessionId}${s.cwd ? `?dir=${encodeURIComponent(s.cwd)}` : ""}`}
                        className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] hover:bg-[var(--panel)]"
                      >
                        Export
                      </a>
                      <button
                        onClick={() => {
                          if (confirm(`Delete session ${s.sessionId.slice(0, 8)}?`)) {
                            void remove(s.sessionId, s.cwd);
                          }
                        }}
                        className={cn(
                          "rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300",
                          "hover:bg-red-500/20",
                        )}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
