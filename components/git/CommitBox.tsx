"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUpFromLine, GitCommit, Sparkles } from "lucide-react";
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
   * Push the current branch. When provided, surfaces a combined
   * "Generate, Commit & Push" button. Implementations should NOT show their
   * own confirmation — the combo button asks once before the chain starts.
   */
  onPush?: () => Promise<{ ok: true } | { ok: false; error: string }>;
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
  onPush,
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
  // `comboStep` tells the user which leg of generate→commit→push is in
  // flight so the button label reflects real progress on a slow turn.
  const [comboStep, setComboStep] = useState<null | "generate" | "commit" | "push">(null);
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

  // Drag-handle on the top edge of the commit box: dragging up grows the
  // textarea (eats into the changes list above). Height persists in
  // localStorage so the user's preferred size sticks across reloads.
  const HEIGHT_STORAGE_KEY = "claudius.git.commitBoxHeight";
  const MIN_HEIGHT = 60;
  const MAX_HEIGHT = 600;
  const [boxHeight, setBoxHeight] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n));
  });
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  function onDragStart(e: React.PointerEvent<HTMLDivElement>) {
    const ta = taRef.current;
    if (!ta) return;
    e.preventDefault();
    dragRef.current = {
      startY: e.clientY,
      startH: boxHeight ?? ta.getBoundingClientRect().height,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onDragMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = drag.startY - e.clientY; // up = grow
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, drag.startH + delta));
    setBoxHeight(next);
  }
  function onDragEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (boxHeight != null && typeof window !== "undefined") {
      window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(boxHeight));
    }
  }

  const idle = !busy && !generating && comboStep == null;
  const canCommit = idle && checkedCount > 0 && message.trim().length > 0;
  const canGenerate = !!onGenerate && idle && checkedCount > 0;
  // Combo button needs SOME way to obtain a message: either the user typed
  // one already, or we have `onGenerate` to ask Claude for one. Without
  // either there's no path forward, so disable it.
  const canCombo =
    !!onPush &&
    idle &&
    checkedCount > 0 &&
    (message.trim().length > 0 || !!onGenerate);

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

  /**
   * The 3-in-1 chain: optionally generate → commit → push. Important details:
   *
   *  - We pass the *generated* message directly to `onCommit` rather than
   *    relying on `setMessage(...)` to land before the commit call, because
   *    React state updates are async.
   *  - Generate failure short-circuits — committing on an empty message
   *    would either fail or, worse, produce a bogus commit.
   *  - Commit-then-push is not atomic. If push fails after a successful
   *    commit, we keep the commit and surface a "Committed locally; push
   *    failed: …" error so the user can retry push without re-doing the
   *    work or accidentally committing twice.
   */
  async function generateCommitAndPush() {
    if (!canCombo || !onPush) return;
    const n = checkedCount;
    const target = branchLabel ?? "current branch";
    if (typeof window !== "undefined") {
      const ok = window.confirm(`Commit ${n} file${n === 1 ? "" : "s"} and push to ${target}?`);
      if (!ok) return;
    }
    setError(null);

    // Step 1: generate if the box is empty.
    let messageToCommit = message;
    if (messageToCommit.trim().length === 0) {
      if (!onGenerate) {
        setError("commit message required");
        return;
      }
      setComboStep("generate");
      const g = await onGenerate();
      if (!g.ok) {
        setComboStep(null);
        setError(g.error);
        return;
      }
      messageToCommit = g.message;
      setMessage(g.message);
      if (onPersistDraft) {
        try {
          await onPersistDraft(g.message);
        } catch {
          // non-fatal
        }
      }
    }

    // Step 2: commit. On failure we stop and leave the textarea populated so
    // the user can fix things up and retry.
    setComboStep("commit");
    const c = await onCommit(messageToCommit);
    if (!c.ok) {
      setComboStep(null);
      setError(c.error);
      return;
    }
    setMessage("");
    if (onClearDraft) {
      try {
        await onClearDraft();
      } catch {
        // non-fatal
      }
    }

    // Step 3: push. Keep the commit even on push failure — recovery (pull,
    // amend, force-push, etc.) is the user's call.
    setComboStep("push");
    const p = await onPush();
    setComboStep(null);
    if (!p.ok) {
      setError(`Committed locally; push failed: ${p.error}`);
    }
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-[var(--border)] bg-[var(--panel)]">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize commit box"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="group flex h-1.5 cursor-ns-resize items-center justify-center select-none hover:bg-[var(--accent)]/30"
      >
        <span className="h-px w-8 bg-[var(--border)] group-hover:bg-[var(--accent)]" />
      </div>
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
        style={boxHeight != null ? { height: `${boxHeight}px` } : undefined}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter — commit (mirrors IntelliJ).
          // Cmd/Ctrl+Shift+Enter — generate + commit + push.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) void generateCommitAndPush();
            else void submit();
          }
        }}
        className="resize-none border-y border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs leading-5 focus:outline-none scroll-thin disabled:opacity-60"
      />
      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">{error}</div>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span
          className="truncate text-[10px] text-[var(--muted)]"
          title={
            onPush
              ? "⌘/Ctrl + Enter to commit · add ⇧ to also push"
              : "⌘/Ctrl + Enter to commit"
          }
        >
          ⌘/Ctrl + ⏎{onPush ? " · ⇧⏎ for + push" : ""}
        </span>
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
        {onPush && (
          <button
            type="button"
            onClick={() => void generateCommitAndPush()}
            disabled={!canCombo}
            data-testid="commit-and-push-button"
            title={
              checkedCount === 0
                ? "Check files to commit first"
                : message.trim().length === 0
                  ? "Generate a commit message, commit, then push (⌘/Ctrl + ⇧ + Enter)"
                  : "Commit, then push (⌘/Ctrl + ⇧ + Enter)"
            }
            // Single-line label + whitespace-nowrap so this never wraps and
            // ends up looking visually heavier than its neighbours. The
            // Sparkles icon carries the "generate" semantics (animated while
            // that leg is running) — spelling it out tripled the button's
            // width and pushed it onto two lines on the default panel size.
            className={cn(
              "flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white",
              "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <Sparkles
              className={cn("h-3 w-3", comboStep === "generate" && "animate-pulse")}
            />
            <ArrowUpFromLine className="h-3 w-3" />
            <span>
              {comboStep === "generate"
                ? "Generating…"
                : comboStep === "commit"
                  ? "Committing…"
                  : comboStep === "push"
                    ? "Pushing…"
                    : "Commit & Push"}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
