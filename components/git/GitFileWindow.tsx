"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, GitBranch, RefreshCw } from "lucide-react";
import type { GitFileChange } from "@/lib/server/git";
import { defaultDiffMode, type DiffSelection } from "@/components/git/ChangesList";
import { GitFileView } from "@/components/git/GitFileView";
import { useGitStatus } from "@/lib/client/useGitStatus";
import { cn } from "@/lib/utils/cn";

/** Does `mode` still describe a real diff for this file's current status? */
function modeApplies(f: GitFileChange, mode: DiffSelection["mode"]): boolean {
  if (mode === "untracked") return f.untracked;
  if (f.untracked) return false;
  const slot = mode === "staged" ? f.index : f.worktree;
  return slot !== " " && slot !== "?";
}

/**
 * Body of the pop-out file window (`/<ws>/git/file?path=…&mode=…`). Polls
 * git status like the Git page does, so the diff stripes and the
 * staged/unstaged toggle follow changes made in the main window.
 */
export function GitFileWindow({
  wsId,
  path,
  initialMode,
}: {
  wsId: string;
  path: string;
  initialMode: DiffSelection["mode"] | null;
}) {
  const { data, error, loading, refresh } = useGitStatus(path ? wsId : null);
  const rootPath = data?.repoRoot;

  // The user's pick (from the URL, then the partial-stage toggle). The mode
  // actually shown is derived: if the file's status moved on (e.g. it was
  // unstaged in the main window) we fall back to its natural group instead
  // of rendering an empty diff.
  const [preferredMode, setPreferredMode] = useState(initialMode);
  const file = data?.files.find((f) => f.path === path);
  const mode: DiffSelection["mode"] | null = file
    ? preferredMode && modeApplies(file, preferredMode)
      ? preferredMode
      : defaultDiffMode(file)
    : null;

  const branch = data?.isRepo ? (data.branch ?? (data.head ? `${data.head} (detached)` : null)) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        <span className="font-medium">Git</span>
        {branch && <span className="shrink-0 font-mono">{branch}</span>}
        {rootPath && (
          <span className="truncate font-mono text-[var(--muted)]" title={rootPath}>
            {rootPath}
          </span>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh — re-run git status"
          aria-label="Refresh"
          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </header>
      {error && (
        <div className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono">{error.split("\n")[0]}</span>
        </div>
      )}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!path ? (
          <Notice>No file specified.</Notice>
        ) : !data ? (
          <Notice>Loading…</Notice>
        ) : !data.isRepo ? (
          <Notice>This workspace isn&apos;t a git repository.</Notice>
        ) : !file || !mode ? (
          <Notice>
            <span className="font-mono">{path}</span> has no pending changes — it was committed,
            reverted, or moved.
          </Notice>
        ) : (
          <GitFileView
            wsId={wsId}
            selected={{ path, mode }}
            file={file}
            onModeChange={setPreferredMode}
            onSaved={() => void refresh()}
          />
        )}
      </section>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--muted)]">
      <div>{children}</div>
    </div>
  );
}
