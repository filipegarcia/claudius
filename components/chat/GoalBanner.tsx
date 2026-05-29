"use client";

import { useState } from "react";
import { Check, Pencil, Sparkles, Target, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { PromptInput } from "./PromptInput";
import type { AttachedImage, GoalState } from "@/lib/client/types";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Composer wiring threaded from the page so the goal input can reuse the chat
 * composer (`PromptInput`) for image paste/drop and @-file mentions.
 */
type GoalComposer = {
  ready: boolean;
  pending: boolean;
  cwd: string | null;
  onInterrupt: () => void;
};

type Props = {
  /** Current goal, or null when none is set. */
  goal: GoalState | null;
  /** Clear the goal entirely. */
  onClear: () => Promise<ActionResult>;
  /**
   * Submit the goal: record it as the tracked objective AND start Claude with
   * the same text (+ images) as the opening prompt — "start working" like the
   * CLI rather than sitting passively. Wired to `handleGoalSubmit` in the page.
   */
  onSubmitGoal: (text: string, images?: AttachedImage[]) => void | Promise<void>;
  /**
   * Bumped by the parent (e.g. `/goal` with no args) to open the inline
   * editor even when no goal is set yet.
   */
  openEditNonce?: number;
  /**
   * When true, render as a row inside a shared session-header panel (below the
   * RecapBanner title) rather than a standalone banner — swaps its bottom
   * border for a top divider and lets the parent panel own the outer framing.
   */
  embedded?: boolean;
  /** Composer wiring for the rich goal input (images + @-mentions). */
  composer?: GoalComposer;
  /**
   * When true, suppress the empty "Set a session goal" prompt (the user
   * dismissed it). Only hides the empty state — an active/achieved goal is
   * still shown, and `/goal` still opens the editor (so the feature stays
   * reachable). Restored via the title-row affordance or Settings.
   */
  hidden?: boolean;
  /** Dismiss the empty-state prompt (the × button). Persists `hidden`. */
  onHide?: () => void;
};

/**
 * Surfaces the session goal in the chat header (see `/goal`). States:
 *
 *   1. No goal + not editing → a subtle "Set a session goal" button.
 *   2. Editing → the reused chat composer (`PromptInput`): images, @-file
 *      mentions, paste/drop. Submitting both sets the goal AND starts Claude.
 *   3. Goal set → the objective, with edit + clear affordances.
 *   4. Achieved → a celebratory emerald strip with the agent's summary.
 *
 * Rendered as a row inside the shared session-header panel (below the title)
 * when `embedded`; otherwise a standalone banner.
 *
 * Achievement is driven by the agent calling the in-process
 * `report_goal_achieved` SDK tool, surfaced via the `goal_changed` SSE event;
 * the banner just reflects `goal.achieved`.
 */
export function GoalBanner({
  goal,
  onClear,
  onSubmitGoal,
  openEditNonce,
  embedded,
  composer,
  hidden,
  onHide,
}: Props) {
  const [editing, setEditing] = useState(false);

  // Parent-driven "open the editor" signal (the `/goal` command with no args).
  // Handled with React's "adjust state when a prop changes" pattern — compare
  // the nonce against the last value we acted on and open during render rather
  // than in an effect (avoids a cascading-render round trip).
  const [seenNonce, setSeenNonce] = useState(openEditNonce ?? 0);
  if (typeof openEditNonce === "number" && openEditNonce !== seenNonce) {
    setSeenNonce(openEditNonce);
    if (openEditNonce > 0) setEditing(true);
  }

  const handleSubmit = (text: string, images?: AttachedImage[]) => {
    void onSubmitGoal(text, images);
    setEditing(false);
  };

  // ── Editing → the rich composer (images + @-mentions, no slash) ───────────
  // Submitting sends the text as the opening prompt and tracks it as the goal.
  if (editing) {
    return (
      <div
        data-testid="goal-banner-editor"
        className={cn(!embedded && "border-b border-[var(--border)] bg-[var(--panel-2)]/30")}
        onKeyDown={(e) => {
          // Esc cancels editing. Bubble phase (not capture) so an open
          // @-mention picker inside the composer gets first crack at Escape
          // to close itself; it stops propagation when it consumes the key.
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.stopPropagation();
            setEditing(false);
          }
        }}
      >
        <div className={cn("mx-auto w-full max-w-[var(--chat-col)] px-2", embedded ? "pt-0.5 pb-1" : "py-1.5")}>
          <div className="mb-1 flex items-center justify-between px-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            <span className="flex items-center gap-1.5">
              <Target className="h-3 w-3 text-[var(--accent)]" aria-hidden />
              Session goal — Claude starts working on submit
            </span>
            <button
              type="button"
              onClick={() => setEditing(false)}
              data-testid="goal-banner-cancel"
              title="Cancel (Esc)"
              className="rounded p-0.5 text-[var(--muted)] transition hover:text-[var(--foreground)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <PromptInput
            ready={composer?.ready ?? true}
            pending={composer?.pending ?? false}
            slashCommands={[]}
            skills={[]}
            cwd={composer?.cwd ?? null}
            sessionId={null}
            onSend={handleSubmit}
            onInterrupt={composer?.onInterrupt ?? (() => {})}
            disableSlash
            placeholder="What should this session accomplish? Press Enter to start Claude."
            testIdPrefix="goal-prompt"
            // Constant token: the composer remounts on each edit-open, so this
            // prefills with the current goal text once per open (and never
            // clobbers in-progress typing while the editor stays mounted).
            draftInjection={{ token: 1, text: goal?.text ?? "" }}
          />
        </div>
      </div>
    );
  }

  // ── No goal → a subtle affordance to set one (button path) ────────────────
  // When the user has dismissed the prompt, render nothing — the feature is
  // still reachable via `/goal` (which opens the editor through
  // `openEditNonce`, handled above), the title-row affordance, and Settings.
  if (!goal) {
    if (hidden) return null;
    return (
      <div
        data-testid="goal-banner-empty"
        className={cn(!embedded && "border-b border-[var(--border)] bg-[var(--panel-2)]/30")}
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-[var(--chat-col)] items-center px-4 text-xs",
            embedded ? "pt-0.5 pb-2" : "py-1.5",
          )}
        >
          <button
            type="button"
            onClick={() => setEditing(true)}
            data-testid="goal-banner-set"
            title="Set a goal for this session"
            className="group flex items-center gap-1.5 rounded text-[var(--muted)] transition hover:text-[var(--foreground)]"
          >
            <Target className="h-3.5 w-3.5 group-hover:text-[var(--accent)]" aria-hidden />
            <span>Set a session goal</span>
          </button>
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              data-testid="goal-banner-hide"
              aria-label="Hide the session goal prompt"
              title="Hide this — restore by hovering the title or from Settings"
              className="ml-auto rounded p-1 text-[var(--muted)] opacity-60 transition hover:bg-[var(--panel)] hover:text-[var(--foreground)] hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Goal set / achieved → display with edit + clear ───────────────────────
  const achieved = Boolean(goal.achieved);

  return (
    <div
      data-testid="goal-banner"
      data-achieved={achieved ? "1" : "0"}
      className={cn(
        !embedded &&
          (achieved
            ? "border-b border-emerald-500/30 bg-emerald-500/10"
            : "border-b border-[var(--border)] bg-[var(--accent)]/10"),
      )}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-[var(--chat-col)] items-start gap-2 px-4 text-xs",
          embedded ? "pt-0.5 pb-2" : "py-2",
        )}
      >
        {achieved ? (
          <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
        ) : (
          <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              data-testid="goal-banner-text"
              className={cn(
                "min-w-0 truncate text-[var(--foreground)]/90",
                achieved && "line-through decoration-emerald-400/40",
              )}
            >
              {goal.text}
            </span>
            {achieved && (
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                <Sparkles className="h-3 w-3" aria-hidden />
                Goal achieved
              </span>
            )}
          </div>
          {achieved && goal.summary && (
            <span
              data-testid="goal-banner-summary"
              className="text-[11px] italic text-[var(--muted)]"
            >
              {goal.summary}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={achieved ? "Set a new goal" : "Edit goal"}
            title={achieved ? "Set a new goal" : "Edit goal"}
            data-testid="goal-banner-edit"
            className="rounded p-1 text-[var(--muted)] transition hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => void onClear()}
            aria-label="Clear goal"
            title="Clear goal"
            data-testid="goal-banner-clear"
            className="rounded p-1 text-[var(--muted)] transition hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
