"use client";

import { useEffect, useMemo, useState } from "react";
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
  const [filter, setFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState<string | null>(null);
  // Opt-in transcript search. By default the box searches titles only (cheap,
  // instant, no false positives from deep message text). Flip this on to also
  // scan the `.jsonl` message bodies for the query.
  const [searchTranscripts, setSearchTranscripts] = useState(false);

  // Scope the list to the workspace in the URL. The URL param (not
  // `useActiveCwd`'s cookie-resolved id) is authoritative for the page we're
  // actually on.
  const params = useParams<{ workspaceId: string }>();
  const { items: workspaces } = useWorkspaces();
  const workspace = workspaces.find((w) => w.id === params?.workspaceId) ?? null;
  const workspaceRoot = workspace?.rootPath ?? null;

  // Fetch scoped to this workspace's project dir. Without `dir`,
  // `/api/sessions/all` caps at the 200-most-recent sessions across ALL
  // projects, then we'd filter that down to this workspace — so a busy
  // workspace would only ever show the few sessions that survive the global
  // recency cap. Passing `dir` makes the cap per-workspace so every session in
  // it is listed. We still re-filter by `cwd` below as a belt-and-suspenders
  // (same exact-match rule the server uses for `/api/sessions?workspaceId`),
  // which also keeps the brief pre-resolution window (workspaceRoot == null →
  // unscoped fetch) correct.
  const { sessions, loading, error, refresh, remove } = useSessionsHistory({
    dir: workspaceRoot ?? undefined,
  });
  const scopedSessions = useMemo(
    () =>
      workspaceRoot == null ? sessions : sessions.filter((s) => s.cwd === workspaceRoot),
    [sessions, workspaceRoot],
  );

  // Search-inside-transcripts. The title filter below runs instantly
  // client-side. This is the opt-in "search the actual messages" capability:
  // a debounced server scan of the workspace's `.jsonl` transcripts that
  // returns sessionId → snippet for every session whose content contains the
  // query. Only runs while `searchTranscripts` is on. Mirrors the debounce +
  // abort pattern of the in-conversation TranscriptSearch.
  const [contentMatches, setContentMatches] = useState<Map<string, string>>(new Map());
  const [contentSearching, setContentSearching] = useState(false);
  useEffect(() => {
    const q = filter.trim();
    const controller = new AbortController();
    // All state writes live inside the debounce timer so the effect body
    // never calls setState synchronously (avoids cascading renders) and the
    // spinner doesn't flash for queries that resolve faster than the debounce.
    const t = setTimeout(() => {
      // Only reach to disk when the user opted into transcript search and the
      // query has enough signal to be worth a scan.
      if (!searchTranscripts || q.length < 2 || !workspaceRoot) {
        setContentMatches((prev) => (prev.size ? new Map() : prev));
        setContentSearching(false);
        return;
      }
      setContentSearching(true);
      const url = `/api/sessions/search?q=${encodeURIComponent(q)}&dir=${encodeURIComponent(workspaceRoot)}`;
      fetch(url, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as {
            matches?: Array<{ sessionId: string; snippet: string }>;
          };
        })
        .then((data) => {
          const map = new Map<string, string>();
          for (const m of data.matches ?? []) map.set(m.sessionId, m.snippet);
          setContentMatches(map);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setContentMatches(new Map());
        })
        .finally(() => {
          if (!controller.signal.aborted) setContentSearching(false);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
  }, [filter, workspaceRoot, searchTranscripts]);

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
      // Primary search: the session title. We match the same fields that feed
      // the displayed title (claudiusTitle / customTitle), plus the firstPrompt
      // since that's the effective title for sessions the user never renamed.
      if (
        (s.claudiusTitle ?? "").toLowerCase().includes(q) ||
        (s.customTitle ?? "").toLowerCase().includes(q) ||
        (s.firstPrompt ?? "").toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
      ) {
        return true;
      }
      // Opt-in: also surface sessions matched inside the transcript body
      // (server-side content search).
      return searchTranscripts && contentMatches.has(s.sessionId);
    });
  }, [filter, branchFilter, scopedSessions, contentMatches, searchTranscripts]);

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
          {searchTranscripts && contentSearching && (
            <span className="text-[var(--muted)]">searching transcripts…</span>
          )}
          {error && <span className="text-red-400">{error}</span>}
          <div className="flex flex-1 items-center justify-center gap-2 px-3">
            <div className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search titles…"
                aria-label="Search sessions"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] py-1 pl-8 pr-7 text-xs focus:outline-none"
              />
              {filter && (
                <button
                  onClick={() => setFilter("")}
                  title="Clear search"
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <label
              title="Also search inside message transcripts"
              className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              <input
                type="checkbox"
                checked={searchTranscripts}
                onChange={(e) => setSearchTranscripts(e.target.checked)}
                className="h-3 w-3 accent-[var(--accent)]"
              />
              Search in transcripts
            </label>
          </div>
          <button
            onClick={() => refresh()}
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            Refresh
          </button>
        </header>

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
            <div className="px-6 py-16 text-center text-sm text-[var(--muted)]">
              {searchTranscripts && contentSearching ? "Searching transcripts…" : "No sessions match."}
            </div>
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
                      {/*
                        Transcript hit preview. Shown only when this session
                        surfaced because the query was found INSIDE its
                        messages (server-side content search) — gives the user
                        the "why is this here" context the metadata fields
                        can't. The label distinguishes it from the firstPrompt
                        preview above.
                      */}
                      {searchTranscripts && contentMatches.get(s.sessionId) && (
                        <div className="mt-1 line-clamp-2 text-xs text-[var(--muted)]">
                          <span className="mr-1 rounded bg-[var(--panel-2)] px-1 py-0.5 text-[10px] uppercase tracking-wide text-[var(--accent)]">
                            in transcript
                          </span>
                          <span className="font-mono">{contentMatches.get(s.sessionId)}</span>
                        </div>
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
