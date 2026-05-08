"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { GitCommit, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Props = {
  /** How many files are checked for inclusion. */
  checkedCount: number;
  /** Disable while a commit/stage call is in flight. */
  busy: boolean;
  /** Branch name (or short SHA when detached) for context. */
  branchLabel: string | null;
  onCommit: (message: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** When provided, shows a "Generate" button that asks Claude for a message. */
  onGenerate?: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
  /**
   * Persisted draft (server-backed). When set, prefills the textarea on
   * mount so a generated message survives navigation away and back. The
   * value should change when the workspace identity changes — passing a
   * fresh value remounts the textarea state via the `draftKey` below.
   */
  initialMessage?: string;
  /**
   * Stable key identifying the draft scope (typically the workspace id).
   * Changing it resets the textarea — use when switching workspaces so a
   * stale draft from another workspace doesn't leak in.
   */
  draftKey?: string;
  /**
   * Called after a successful generate (and after commit clears it). Use
   * to mirror the generated message into a persistent store.
   */
  onPersistDraft?: (message: string) => Promise<void> | void;
  /** Called after a successful commit so the persisted draft is cleared. */
  onClearDraft?: () => Promise<void> | void;
  /**
   * Branch-derived prefix (e.g. "feat #4715 - "). When the textarea is
   * empty and no persisted draft exists, this is used as the initial value
   * with the cursor placed at the end so the user types straight into
   * their message body.
   */
  prefix?: string | null;
};

export function CommitBox({
  checkedCount,
  busy,
  branchLabel,
  onCommit,
  onGenerate,
  initialMessage,
  draftKey,
  onPersistDraft,
  onClearDraft,
  prefix,
}: Props) {
  const initial = initialMessage && initialMessage.length > 0 ? initialMessage : prefix ?? "";
  const [message, setMessage] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Bumped on every programmatic reset so the post-render layout effect
  // moves the cursor to the end. Tracks the *event*, not the message.
  const [resetTick, setResetTick] = useState(0);

  // Workspace switch / draft-load: replace whatever's in the box. We use the
  // "set state during render" pattern (React 19) so the reset is observable
  // on the very next paint.
  const [lastReset, setLastReset] = useState<{ draftKey: string | undefined; initialMessage: string | undefined }>(
    { draftKey, initialMessage },
  );
  if (lastReset.draftKey !== draftKey || lastReset.initialMessage !== initialMessage) {
    setLastReset({ draftKey, initialMessage });
    const next = initialMessage && initialMessage.length > 0 ? initialMessage : prefix ?? "";
    setMessage(next);
    if (next) setResetTick((t) => t + 1);
  }

  // Late-arriving prefix (branch resolved after first paint, or branch
  // changes while the box is empty). Skip if the user has typed.
  const [lastPrefix, setLastPrefix] = useState(prefix);
  if (lastPrefix !== prefix) {
    setLastPrefix(prefix);
    if (prefix && message.length === 0) {
      setMessage(prefix);
      setResetTick((t) => t + 1);
    }
  }

  // Place the caret at the end after a programmatic reset so the user types
  // straight into the body after the prefix. No setState here, so this
  // doesn't conflict with `react-hooks/set-state-in-effect`.
  useLayoutEffect(() => {
    if (resetTick === 0) return;
    const ta = taRef.current;
    if (!ta) return;
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }, [resetTick]);
  const canCommit = !busy && !generating && checkedCount > 0 && message.trim().length > 0;
  const canGenerate = !!onGenerate && !busy && !generating && checkedCount > 0;

  async function submit() {
    if (!canCommit) return;
    setError(null);
    const r = await onCommit(message);
    if (r.ok) {
      setMessage("");
      // Drop the persisted draft so reopening the page is empty again.
      if (onClearDraft) {
        try {
          await onClearDraft();
        } catch {
          // non-fatal — the textarea is already cleared locally
        }
      }
    } else {
      setError(r.error);
    }
  }

  async function generate() {
    if (!canGenerate || !onGenerate) return;
    setError(null);
    setGenerating(true);
    try {
      const r = await onGenerate();
      if (r.ok) {
        setMessage(r.message);
        if (onPersistDraft) {
          try {
            await onPersistDraft(r.message);
          } catch {
            // non-fatal — the user still sees the message in the textarea
          }
        }
      } else {
        setError(r.error);
      }
    } finally {
      setGenerating(false);
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
        ref={taRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={generating ? "Generating commit message…" : "Commit message"}
        rows={3}
        spellCheck
        disabled={generating}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter — submit shortcut, mirrors IntelliJ.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        className="resize-none border-y border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs leading-5 focus:outline-none scroll-thin disabled:opacity-60"
      />
      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">{error}</div>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10px] text-[var(--muted)]">⌘/Ctrl + Enter to commit</span>
        {onGenerate && (
          <button
            type="button"
            onClick={() => void generate()}
            disabled={!canGenerate}
            title={
              checkedCount === 0
                ? "Check files to commit first"
                : "Ask Claude to draft a commit message from the diff"
            }
            className={cn(
              "ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--foreground)]",
              "hover:bg-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <Sparkles className={cn("h-3 w-3", generating && "animate-pulse")} />
            {generating ? "Generating…" : "Generate"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canCommit}
          className={cn(
            "flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-white",
            "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
            !onGenerate && "ml-auto",
          )}
        >
          <GitCommit className="h-3 w-3" />
          {busy ? "Committing…" : "Commit"}
        </button>
      </div>
    </div>
  );
}
