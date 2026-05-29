"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Sparkles, Target, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { GoalState } from "@/lib/client/types";

type ActionResult = { ok: true } | { ok: false; error: string };

type Props = {
  /** Current goal, or null when none is set. */
  goal: GoalState | null;
  /** Set or replace the goal. */
  onSet: (text: string) => Promise<ActionResult>;
  /** Clear the goal entirely. */
  onClear: () => Promise<ActionResult>;
  /**
   * Bumped by the parent (e.g. `/goal` with no args) to open the inline
   * editor even when no goal is set yet. Any change to a positive value
   * focuses the input.
   */
  openEditNonce?: number;
  /**
   * When true, render as a row inside a shared session-header panel (below the
   * RecapBanner title) rather than a standalone banner — swaps its bottom
   * border for a top divider and lets the parent panel own the outer framing.
   */
  embedded?: boolean;
};

const MAX_LEN = 280;

/**
 * Surfaces the session goal in the chat header (see `/goal`). Three states:
 *
 *   1. No goal + not editing → a subtle "Set a session goal" button.
 *   2. Goal set → the objective, with edit + clear affordances.
 *   3. Achieved → a celebratory emerald strip with the agent's summary.
 *
 * Rendered as a row inside the shared session-header panel (below the title)
 * when `embedded`; otherwise a standalone banner.
 *
 * Achievement is driven by the agent calling the in-process
 * `report_goal_achieved` SDK tool, surfaced via the `goal_changed` SSE event;
 * the banner just reflects `goal.achieved`. Editing/clearing round-trips
 * through `onSet`/`onClear` (which POST to `/api/sessions/[id]/goal`).
 */
export function GoalBanner({ goal, onSet, onClear, openEditNonce, embedded }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parent-driven "open the editor" signal (the `/goal` command with no args).
  // Handled with React's "adjust state when a prop changes" pattern — compare
  // the nonce against the last value we acted on and open during render rather
  // than in an effect (avoids a cascading-render round trip). We intentionally
  // react only to the nonce; re-opening when `goal` changes would fight the
  // user mid-edit.
  const [seenNonce, setSeenNonce] = useState(openEditNonce ?? 0);
  if (typeof openEditNonce === "number" && openEditNonce !== seenNonce) {
    setSeenNonce(openEditNonce);
    if (openEditNonce > 0) {
      setDraft(goal?.text ?? "");
      setSaveErr(null);
      setEditing(true);
    }
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // No goal and not editing → a subtle, always-available affordance to set
  // one (the `/goal` command is the keyboard path; this is the button path).
  // Once a goal exists this whole component becomes the prominent banner.
  if (!goal && !editing) {
    return (
      <div
        data-testid="goal-banner-empty"
        className={cn(
          embedded
            ? "border-t border-[var(--border)]/50"
            : "border-b border-[var(--border)] bg-[var(--panel-2)]/30",
        )}
      >
        <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-1.5 text-xs">
          <button
            type="button"
            onClick={startEdit}
            data-testid="goal-banner-set"
            title="Set a goal for this session"
            className="group flex items-center gap-1.5 rounded text-[var(--muted)] transition hover:text-[var(--foreground)]"
          >
            <Target className="h-3.5 w-3.5 group-hover:text-[var(--accent)]" aria-hidden />
            <span>Set a session goal</span>
          </button>
        </div>
      </div>
    );
  }

  function startEdit() {
    setDraft(goal?.text ?? "");
    setSaveErr(null);
    setEditing(true);
  }

  async function commit() {
    const value = draft.trim();
    if (!value) {
      // Empty submit is a no-op cancel — clearing is an explicit action.
      setEditing(false);
      setSaveErr(null);
      return;
    }
    if (value === goal?.text) {
      setEditing(false);
      setSaveErr(null);
      return;
    }
    setBusy(true);
    const r = await onSet(value);
    setBusy(false);
    if (!r.ok) {
      setSaveErr(r.error);
      return;
    }
    setEditing(false);
    setSaveErr(null);
  }

  async function clear() {
    setBusy(true);
    await onClear();
    setBusy(false);
    setEditing(false);
    setSaveErr(null);
  }

  const achieved = Boolean(goal?.achieved);

  return (
    <div
      data-testid="goal-banner"
      data-achieved={achieved ? "1" : "0"}
      className={cn(
        embedded ? "border-t" : "border-b",
        achieved
          ? embedded
            ? "border-emerald-500/20 bg-emerald-500/10"
            : "border-emerald-500/30 bg-emerald-500/10"
          : embedded
            ? "border-[var(--border)]/50 bg-[var(--accent)]/[0.07]"
            : "border-[var(--border)] bg-[var(--accent)]/10",
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2 px-4 py-2 text-xs">
        {achieved ? (
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300">
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        ) : (
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
        )}

        {editing ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                  setSaveErr(null);
                }
              }}
              onBlur={() => void commit()}
              placeholder="What should this session accomplish?"
              maxLength={MAX_LEN}
              aria-label="Session goal"
              data-testid="goal-banner-input"
              disabled={busy}
              className={cn(
                "min-w-0 flex-1 rounded-md border bg-[var(--panel)] px-2 py-1 text-xs outline-none",
                saveErr
                  ? "border-red-500/60 focus:border-red-500"
                  : "border-[var(--accent)]/60 focus:border-[var(--accent)]",
              )}
            />
            {saveErr && (
              <span className="text-[10px] text-red-300" data-testid="goal-banner-error">
                {saveErr}
              </span>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase tracking-wide",
                  achieved ? "text-emerald-300" : "text-[var(--accent)]",
                )}
              >
                {achieved ? "Goal achieved" : "Goal"}
              </span>
              {achieved && (
                <Sparkles className="h-3 w-3 text-emerald-300" aria-hidden />
              )}
            </div>
            <span
              data-testid="goal-banner-text"
              className={cn(
                "min-w-0 text-[var(--foreground)]/90",
                achieved && "line-through decoration-emerald-400/40",
              )}
            >
              {goal?.text}
            </span>
            {achieved && goal?.summary && (
              <span
                data-testid="goal-banner-summary"
                className="mt-0.5 text-[11px] italic text-[var(--muted)]"
              >
                {goal.summary}
              </span>
            )}
          </div>
        )}

        {!editing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={startEdit}
              aria-label={achieved ? "Set a new goal" : "Edit goal"}
              title={achieved ? "Set a new goal" : "Edit goal"}
              data-testid="goal-banner-edit"
              className="rounded p-1 text-[var(--muted)] transition hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => void clear()}
              disabled={busy}
              aria-label="Clear goal"
              title="Clear goal"
              data-testid="goal-banner-clear"
              className="rounded p-1 text-[var(--muted)] transition hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
