"use client";

import { useState } from "react";
import { GitCommit } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Props = {
  /** How many files are checked for inclusion. */
  checkedCount: number;
  /** Disable while a commit/stage call is in flight. */
  busy: boolean;
  /** Branch name (or short SHA when detached) for context. */
  branchLabel: string | null;
  onCommit: (message: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export function CommitBox({ checkedCount, busy, branchLabel, onCommit }: Props) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canCommit = !busy && checkedCount > 0 && message.trim().length > 0;

  async function submit() {
    if (!canCommit) return;
    setError(null);
    const r = await onCommit(message);
    if (r.ok) {
      setMessage("");
    } else {
      setError(r.error);
    }
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-[var(--border)] bg-[var(--panel)]">
      <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-[var(--muted)]">
        <GitCommit className="h-3 w-3" />
        <span>
          Commit <strong className="text-[var(--foreground)]">{checkedCount}</strong> file{checkedCount === 1 ? "" : "s"}
          {branchLabel ? (
            <>
              {" "}to <span className="font-mono text-[var(--foreground)]">{branchLabel}</span>
            </>
          ) : null}
        </span>
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message"
        rows={3}
        spellCheck
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter — submit shortcut, mirrors IntelliJ.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        className="resize-none border-y border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs leading-5 focus:outline-none scroll-thin"
      />
      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">{error}</div>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10px] text-[var(--muted)]">⌘/Ctrl + Enter to commit</span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canCommit}
          className={cn(
            "ml-auto flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-white",
            "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <GitCommit className="h-3 w-3" />
          {busy ? "Committing…" : "Commit"}
        </button>
      </div>
    </div>
  );
}
